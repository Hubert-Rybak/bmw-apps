/*
 * The renderer's video frame file (mgu-render PROTOCOL.md, "Video"): a 64-byte header, then nslot frames of
 * w*h*3/2 bytes, I420. The renderer reads the newest slot each time it draws the app.
 */
#ifndef YTPLAY_FRAMES_H
#define YTPLAY_FRAMES_H

#include <stdint.h>
#include <stddef.h>

struct AVFrame;

struct frames {
    int fd;
    char path[128];
    uint8_t *map;
    size_t map_len;
    int w, h;
    uint32_t seq, slot;
    struct SwsContext *sws;         /* for pictures that are not 8-bit 4:2:0 */
    int sws_w, sws_h, sws_fmt;
    uint8_t *tmp[3];
    int tmp_stride[3];
};

#define FRAMES_NSLOT 3
#define FRAMES_MIN 16
#define FRAMES_MAX 2048

/* Create (or take over) the file; run while still root so that root owns it. 0, or -1 with errno. */
int frames_init(struct frames *f, const char *path);
/* Write one decoded picture as the newest frame. 0, or -1 when it cannot be shown (size, format, memory). */
int frames_write(struct frames *f, const struct AVFrame *fr);
/* Empty the file's picture: a header with seq 0, so the renderer draws nothing for it. */
void frames_clear(struct frames *f);
void frames_close(struct frames *f, int unlink_file);

#endif
