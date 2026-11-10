/*
 * Sound out through the unit's own ALSA library, loaded at run time (dlopen): the head unit's sound devices are
 * plugins of its libasound, and a machine without the library still plays the picture.
 * 16-bit stereo, interleaved.
 */
#ifndef YTPLAY_AUDIO_H
#define YTPLAY_AUDIO_H

#include <stddef.h>
#include <stdint.h>

struct audio {
    void *pcm;
    unsigned rate;
    char dev[128];
    char err[200];              /* why the last call failed */
    double stalled;             /* seconds the device has taken nothing */
    uint64_t written;           /* frames taken since open */
    unsigned long buffer;       /* device buffer, frames */
};

/* 0 when the ALSA library is there. */
int audio_available(void);
/* Open dev for 16-bit stereo at rate. 0, or -1 with a->err. */
int audio_open(struct audio *a, const char *dev, unsigned rate);
/*
 * Write frames; waits up to wait_ms for room. Returns the frames taken (0: none within the wait), or -1 when the
 * device failed for good (a->err).
 */
int audio_write(struct audio *a, const int16_t *pcm, int frames, int wait_ms);
/* Seconds of sound the device still holds (written, not yet played). */
double audio_delay(struct audio *a);
/* Drop what is queued (pause, seek); the next write starts again. */
void audio_drop(struct audio *a);
void audio_close(struct audio *a);
/* The device names the library offers, as a JSON array of strings, into out. */
void audio_list(char *out, size_t n);

#endif
