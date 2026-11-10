/* A still picture (JPEG, WebP, PNG) decoded and scaled to fill w x h, as premultiplied RGBA for the renderer. */
#ifndef YTPLAY_THUMB_H
#define YTPLAY_THUMB_H

#include <stddef.h>
#include <stdint.h>

/*
 * Decode data and scale it to cover out_w x out_h (centre crop, aspect kept). Returns a malloc'd buffer of
 * out_w * out_h * 4 bytes, or NULL with err filled.
 */
uint8_t *thumb_decode(const uint8_t *data, size_t len, int out_w, int out_h, char *err, size_t errn);

#endif
