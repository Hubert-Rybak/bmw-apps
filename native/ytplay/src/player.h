/*
 * One playback: the media's bytes come from the app (source.h), the picture goes to the renderer's frame file
 * (frames.h) in step with the sound (audio.h), or with the clock when there is no sound device.
 */
#ifndef YTPLAY_PLAYER_H
#define YTPLAY_PLAYER_H

#include <stddef.h>
#include <stdint.h>

struct frames;
struct session;

struct player_cfg {
    struct frames *frames;
    /* a line for the app (thread-safe) */
    void (*emit)(void *ctx, const char *json);
    void *ctx;
    int threads;                /* decoder threads, 0 = as many as the CPU has (at most 4) */
};

struct open_args {
    int sid;
    int muxed;                  /* one file holds picture and sound (stream "video") */
    int has_audio;              /* a sound stream is offered (in the muxed file, or as stream "audio") */
    int64_t vsize, asize;       /* file sizes, -1 unknown */
    double start;               /* seconds to begin at */
    char audio_dev[128];        /* ALSA device, "" = no sound */
    double gain_db;
};

struct session *session_open(const struct player_cfg *cfg, const struct open_args *a);
int session_id(const struct session *s);
/* A data connection the app opened for stream ("video" or "audio"); takes fd. */
void session_attach(struct session *s, const char *stream, int fd, uint32_t req, int64_t off, int64_t size);
void session_pause(struct session *s, int paused);
void session_seek(struct session *s, double t);
void session_gain(struct session *s, double db);
/* The state as one JSON line into out; returns 1 when it differs from the line given before (or force). */
int session_status(struct session *s, char *out, size_t n, int force);
void session_close(struct session *s);

#endif
