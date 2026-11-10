#include "frames.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>

#define MAGIC 0x4656474du       /* "MGVF" */
#define HEADER 64

static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }

int frames_init(struct frames *f, const char *path)
{
    memset(f, 0, sizeof *f);
    f->fd = -1;
    snprintf(f->path, sizeof f->path, "%s", path);
    /* never through a link: /dev/shm is writable by everyone */
    int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (fd < 0) return -1;
    struct stat st;
    if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != geteuid()) {
        close(fd);
        /* somebody else's file under our name: replace it */
        if (unlink(path) < 0) return -1;
        fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (fd < 0) return -1;
    }
    if (fchmod(fd, 0644) < 0 || ftruncate(fd, HEADER) < 0) { close(fd); return -1; }
    f->fd = fd;
    frames_clear(f);
    return 0;
}

static void unmap(struct frames *f)
{
    if (f->map) munmap(f->map, f->map_len);
    f->map = NULL;
    f->map_len = 0;
}

void frames_clear(struct frames *f)
{
    uint8_t head[HEADER];
    if (f->fd < 0) return;
    unmap(f);
    memset(head, 0, sizeof head);
    /* no magic: a file the renderer does not take for a frame file draws nothing */
    if (pwrite(f->fd, head, sizeof head, 0) < 0) { /* the next frame writes it again */ }
    if (ftruncate(f->fd, HEADER) < 0) { }
    f->w = f->h = 0;
    f->seq = f->slot = 0;
}

void frames_close(struct frames *f, int unlink_file)
{
    unmap(f);
    if (f->sws) sws_freeContext(f->sws);
    f->sws = NULL;
    av_freep(&f->tmp[0]);
    if (f->fd >= 0) close(f->fd);
    f->fd = -1;
    if (unlink_file && f->path[0]) unlink(f->path);
}

/* The file for w x h pictures: sized, mapped, header written with no frame yet. */
static int resize(struct frames *f, int w, int h, int matrix, int range)
{
    size_t frame = (size_t)w * (size_t)h * 3 / 2;
    size_t len = HEADER + frame * FRAMES_NSLOT;
    unmap(f);
    /* seq 0 first: a reader in between sees no frame, never one of the old size in a file of the new */
    uint8_t zero[HEADER];
    memset(zero, 0, sizeof zero);
    if (pwrite(f->fd, zero, sizeof zero, 0) != (ssize_t)sizeof zero) return -1;
    if (ftruncate(f->fd, (off_t)len) < 0) return -1;
    uint8_t *m = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, f->fd, 0);
    if (m == MAP_FAILED) return -1;
    f->map = m;
    f->map_len = len;
    f->w = w;
    f->h = h;
    f->seq = 0;
    f->slot = FRAMES_NSLOT - 1;
    put32(m + 4, 1);
    put32(m + 8, (uint32_t)w);
    put32(m + 12, (uint32_t)h);
    put32(m + 16, 0);
    put32(m + 20, f->slot);
    put32(m + 24, FRAMES_NSLOT);
    put32(m + 28, (uint32_t)matrix);
    put32(m + 32, (uint32_t)range);
    put32(m + 0, MAGIC);
    return 0;
}

static void copy_plane(uint8_t *dst, const uint8_t *src, int stride, int w, int h)
{
    if (stride == w) { memcpy(dst, src, (size_t)w * (size_t)h); return; }
    for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * (size_t)w, src + (ptrdiff_t)y * stride, (size_t)w);
}

int frames_write(struct frames *f, const AVFrame *fr)
{
    if (f->fd < 0 || !fr || !fr->data[0]) return -1;
    int w = fr->width & ~1, h = fr->height & ~1;
    if (w < FRAMES_MIN || h < FRAMES_MIN || w > FRAMES_MAX || h > FRAMES_MAX) return -1;
    /* BT.709 for HD unless the stream says otherwise, as players do */
    int matrix = fr->colorspace == AVCOL_SPC_BT709 ? 1
        : (fr->colorspace == AVCOL_SPC_BT470BG || fr->colorspace == AVCOL_SPC_SMPTE170M) ? 0
        : (h >= 720 ? 1 : 0);
    int range = fr->color_range == AVCOL_RANGE_JPEG || fr->format == AV_PIX_FMT_YUVJ420P ? 1 : 0;
    const uint8_t *const *planes = (const uint8_t *const *)fr->data;
    const int *strides = fr->linesize;

    if (fr->format != AV_PIX_FMT_YUV420P && fr->format != AV_PIX_FMT_YUVJ420P) {
        /* 10-bit, 4:2:2, 4:4:4 ...: converted to 8-bit 4:2:0 at the same size */
        if (!f->sws || f->sws_w != fr->width || f->sws_h != fr->height || f->sws_fmt != fr->format) {
            if (f->sws) sws_freeContext(f->sws);
            av_freep(&f->tmp[0]);
            f->sws = sws_getContext(fr->width, fr->height, (enum AVPixelFormat)fr->format, w, h, AV_PIX_FMT_YUV420P,
                SWS_BILINEAR, NULL, NULL, NULL);
            uint8_t *data[4];
            int ls[4];
            if (!f->sws || av_image_alloc(data, ls, w, h, AV_PIX_FMT_YUV420P, 32) < 0) {
                if (f->sws) sws_freeContext(f->sws);
                f->sws = NULL;
                return -1;
            }
            for (int i = 0; i < 3; i++) { f->tmp[i] = data[i]; f->tmp_stride[i] = ls[i]; }
            f->sws_w = fr->width; f->sws_h = fr->height; f->sws_fmt = fr->format;
        }
        sws_scale(f->sws, planes, strides, 0, fr->height, f->tmp, f->tmp_stride);
        planes = (const uint8_t *const *)f->tmp;
        strides = f->tmp_stride;
    }

    if (!f->map || f->w != w || f->h != h) {
        if (resize(f, w, h, matrix, range) < 0) { log_warn("frame file %dx%d: %s", w, h, strerror(errno)); return -1; }
    }
    uint32_t slot = (f->slot + 1) % FRAMES_NSLOT;
    size_t frame = (size_t)w * (size_t)h * 3 / 2;
    uint8_t *dst = f->map + HEADER + frame * slot;
    copy_plane(dst, planes[0], strides[0], w, h);
    copy_plane(dst + (size_t)w * (size_t)h, planes[1], strides[1], w / 2, h / 2);
    copy_plane(dst + (size_t)w * (size_t)h * 5 / 4, planes[2], strides[2], w / 2, h / 2);
    /* the slot, then the count: the renderer reads the header, then that slot */
    f->slot = slot;
    f->seq++;
    put32(f->map + 28, (uint32_t)matrix);
    put32(f->map + 32, (uint32_t)range);
    put32(f->map + 20, slot);
    put32(f->map + 16, f->seq);
    return 0;
}
