#include "thumb.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>

static enum AVCodecID sniff(const uint8_t *d, size_t n)
{
    if (n >= 3 && d[0] == 0xff && d[1] == 0xd8 && d[2] == 0xff) return AV_CODEC_ID_MJPEG;
    if (n >= 12 && !memcmp(d, "RIFF", 4) && !memcmp(d + 8, "WEBP", 4)) return AV_CODEC_ID_WEBP;
    if (n >= 8 && !memcmp(d, "\x89PNG\r\n\x1a\n", 8)) return AV_CODEC_ID_PNG;
    return AV_CODEC_ID_NONE;
}

uint8_t *thumb_decode(const uint8_t *data, size_t len, int out_w, int out_h, char *err, size_t errn)
{
    uint8_t *out = NULL;
    AVCodecContext *ctx = NULL;
    AVPacket *pkt = NULL;
    AVFrame *fr = NULL;
    struct SwsContext *sws = NULL;
    uint8_t *padded = NULL;
    const char *why = "not a JPEG, WebP or PNG picture";

    if (out_w < 1 || out_h < 1 || out_w > 1024 || out_h > 1024) { why = "size out of range"; goto done; }
    enum AVCodecID id = sniff(data, len);
    if (id == AV_CODEC_ID_NONE) goto done;
    const AVCodec *codec = avcodec_find_decoder(id);
    why = "no decoder for this picture";
    if (!codec) goto done;
    why = "out of memory";
    ctx = avcodec_alloc_context3(codec);
    pkt = av_packet_alloc();
    fr = av_frame_alloc();
    /* decoders read past the end in whole words: the input needs zeroed padding */
    padded = av_mallocz(len + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!ctx || !pkt || !fr || !padded) goto done;
    memcpy(padded, data, len);
    ctx->thread_count = 1;
    why = "decoder would not start";
    if (avcodec_open2(ctx, codec, NULL) < 0) goto done;
    pkt->data = padded;
    pkt->size = (int)len;
    why = "picture is damaged";
    if (avcodec_send_packet(ctx, pkt) < 0) goto done;
    int r = avcodec_receive_frame(ctx, fr);
    if (r == AVERROR(EAGAIN)) {
        avcodec_send_packet(ctx, NULL);
        r = avcodec_receive_frame(ctx, fr);
    }
    if (r < 0 || fr->width < 1 || fr->height < 1) goto done;

    /* cover: the largest centred part of the picture with the target's shape */
    int sw = fr->width, sh = fr->height;
    int cw = sw, ch = (int)((int64_t)sw * out_h / out_w);
    if (ch > sh) { ch = sh; cw = (int)((int64_t)sh * out_w / out_h); }
    if (cw < 1) cw = 1;
    if (ch < 1) ch = 1;
    int cx = ((sw - cw) / 2) & ~1, cy = ((sh - ch) / 2) & ~1;

    const AVPixFmtDescriptor *desc = av_pix_fmt_desc_get((enum AVPixelFormat)fr->format);
    why = "unsupported picture format";
    if (!desc) goto done;
    const uint8_t *src[4];
    int stride[4];
    for (int i = 0; i < 4; i++) {
        stride[i] = fr->linesize[i];
        src[i] = fr->data[i];
        if (!src[i]) continue;
        /* the crop's top-left corner in each plane (chroma planes are subsampled; a palette is not a plane) */
        if ((desc->flags & AV_PIX_FMT_FLAG_PAL) && i == 1) continue;
        int is_chroma = (i == 1 || i == 2) && desc->nb_components >= 3 && !(desc->flags & AV_PIX_FMT_FLAG_RGB);
        int px = is_chroma ? cx >> desc->log2_chroma_w : cx;
        int py = is_chroma ? cy >> desc->log2_chroma_h : cy;
        int step = av_get_padded_bits_per_pixel(desc) / 8;
        if (desc->flags & AV_PIX_FMT_FLAG_PLANAR) step = (desc->comp[0].depth + 7) / 8;
        src[i] += (ptrdiff_t)py * stride[i] + (ptrdiff_t)px * step;
    }
    why = "out of memory";
    sws = sws_getContext(cw, ch, (enum AVPixelFormat)fr->format, out_w, out_h, AV_PIX_FMT_RGBA, SWS_BILINEAR, NULL, NULL, NULL);
    out = malloc((size_t)out_w * (size_t)out_h * 4);
    if (!sws || !out) { free(out); out = NULL; goto done; }
    uint8_t *dst[4] = { out, NULL, NULL, NULL };
    int dstride[4] = { out_w * 4, 0, 0, 0 };
    sws_scale(sws, src, stride, 0, ch, dst, dstride);
    /* premultiplied, as the renderer's pictures are (thumbnails are opaque: nothing changes for them) */
    for (size_t i = 0, n = (size_t)out_w * (size_t)out_h; i < n; i++) {
        uint8_t *p = out + i * 4;
        unsigned a = p[3];
        if (a == 255) continue;
        p[0] = (uint8_t)(p[0] * a / 255); p[1] = (uint8_t)(p[1] * a / 255); p[2] = (uint8_t)(p[2] * a / 255);
    }
    why = NULL;
done:
    if (why && err) snprintf(err, errn, "%s", why);
    if (sws) sws_freeContext(sws);
    av_frame_free(&fr);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
    av_free(padded);
    return out;
}
