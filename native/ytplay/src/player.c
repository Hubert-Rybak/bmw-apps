#include "player.h"
#include "audio.h"
#include "frames.h"
#include "source.h"
#include "util.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

#define AUDIO_RATE 48000
/* packets a track holds ahead of its decoder */
#define VIDEO_Q_BYTES (12 << 20)
#define VIDEO_Q_COUNT 600
#define AUDIO_Q_BYTES (1 << 20)
#define AUDIO_Q_COUNT 400
/* a picture this late is not shown (one is shown at least every STALE_S all the same) */
#define LATE_S 0.08
#define STALE_S 0.5
/* packets the picture's queue holds before play goes on after it ran dry */
#define REFILL_COUNT 12

enum { ST_OPENING, ST_BUFFERING, ST_PLAYING, ST_PAUSED, ST_ENDED, ST_ERROR };
static const char *const STATE_NAME[] = { "opening", "buffering", "playing", "paused", "ended", "error" };

/* ---- packet queue ---------------------------------------------------------- */

struct node {
    AVPacket *pkt;              /* NULL: a marker */
    int serial;
    int flush, eof;
    struct node *next;
};

struct pq {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    struct node *head, *tail;
    int count;
    int64_t bytes, max_bytes;
    int max_count;
    int abort;
    int interrupt;              /* a seek is waiting: put() gives up */
};

static void pq_init(struct pq *q, int64_t max_bytes, int max_count)
{
    memset(q, 0, sizeof *q);
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->cv, NULL);
    q->max_bytes = max_bytes;
    q->max_count = max_count;
}

static void pq_drop_all(struct pq *q)
{
    struct node *n = q->head;
    while (n) {
        struct node *next = n->next;
        if (n->pkt) av_packet_free(&n->pkt);
        free(n);
        n = next;
    }
    q->head = q->tail = NULL;
    q->count = 0;
    q->bytes = 0;
}

static void pq_flush(struct pq *q)
{
    pthread_mutex_lock(&q->mu);
    pq_drop_all(q);
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mu);
}

static void pq_free(struct pq *q)
{
    pq_drop_all(q);
    pthread_mutex_destroy(&q->mu);
    pthread_cond_destroy(&q->cv);
}

static void pq_signal(struct pq *q, int abort, int interrupt)
{
    pthread_mutex_lock(&q->mu);
    if (abort) q->abort = 1;
    q->interrupt = interrupt;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mu);
}

/* Takes pkt (NULL for a marker). 0, or -1 when aborted or interrupted (pkt freed). Markers never wait. */
static int pq_put(struct pq *q, AVPacket *pkt, int serial, int flush, int eof)
{
    struct node *n = calloc(1, sizeof *n);
    if (!n) { if (pkt) av_packet_free(&pkt); return -1; }
    n->pkt = pkt; n->serial = serial; n->flush = flush; n->eof = eof;
    pthread_mutex_lock(&q->mu);
    while (pkt && !q->abort && !q->interrupt && (q->bytes > q->max_bytes || q->count > q->max_count))
        pthread_cond_wait(&q->cv, &q->mu);
    if (q->abort || (pkt && q->interrupt)) {
        pthread_mutex_unlock(&q->mu);
        if (pkt) av_packet_free(&pkt);
        free(n);
        return -1;
    }
    if (q->tail) q->tail->next = n; else q->head = n;
    q->tail = n;
    q->count++;
    if (pkt) q->bytes += pkt->size;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mu);
    return 0;
}

/* The next node (the caller frees it and its packet), waiting up to wait_s. NULL: none in time, or aborted. */
static struct node *pq_get(struct pq *q, double wait_s)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += (time_t)wait_s;
    ts.tv_nsec += (long)((wait_s - floor(wait_s)) * 1e9);
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
    pthread_mutex_lock(&q->mu);
    while (!q->head && !q->abort) {
        if (pthread_cond_timedwait(&q->cv, &q->mu, &ts) == ETIMEDOUT) break;
    }
    struct node *n = q->abort ? NULL : q->head;
    if (n) {
        q->head = n->next;
        if (!q->head) q->tail = NULL;
        q->count--;
        if (n->pkt) q->bytes -= n->pkt->size;
        pthread_cond_broadcast(&q->cv);
    }
    pthread_mutex_unlock(&q->mu);
    return n;
}

static int pq_count(struct pq *q)
{
    pthread_mutex_lock(&q->mu);
    int c = q->count;
    pthread_mutex_unlock(&q->mu);
    return c;
}

/* ---- session ------------------------------------------------------------------ */

struct session;

struct track {
    struct session *s;
    int kind;                   /* AVMEDIA_TYPE_VIDEO / AUDIO */
    int used;
    int index;                  /* stream index in its input */
    AVRational tb;
    AVCodecContext *dec;
    struct pq q;
    pthread_t th;
    int started;
    int done;                   /* decoded to the end of the current serial */
    int feed_eof;               /* its input reached the end */
};

struct input {
    struct session *s;
    struct source src;
    AVFormatContext *fmt;
    AVIOContext *avio;
    pthread_t th;
    int started;
    int serial_seen;
    struct track *tracks[2];
    int ntracks;
};

struct session {
    struct player_cfg cfg;
    struct open_args a;
    pthread_mutex_t mu;
    pthread_cond_t cv;          /* CLOCK_MONOTONIC */
    int stop;
    int paused;
    int buffering;
    int serial;                 /* counts seeks; packets and the clock carry the one they belong to */
    double seek_target;
    int failed;
    char err[200];

    struct input in[2];
    int nin;
    struct track video, audio;

    /* the clock everything is shown by: pts at time t, running unless held */
    double clk_pts, clk_t;
    int clk_serial, clk_valid, clk_held;

    struct audio au;
    int audio_on;               /* a sound device is open and takes sound */
    char audio_note[220];       /* why there is no sound */
    double gain;
    SwrContext *swr;
    int swr_rate, swr_fmt, swr_ch;

    double duration;
    double pos;
    int w, h;
    double fps;
    unsigned shown, dropped;
    int inputs_ready;
    char last_status[512];
    double last_status_t;
};

static void fail(struct session *s, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void fail(struct session *s, const char *fmt, ...)
{
    char buf[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    pthread_mutex_lock(&s->mu);
    if (!s->failed && !s->stop) {
        s->failed = 1;
        snprintf(s->err, sizeof s->err, "%s", buf);
        log_warn("session %d: %s", s->a.sid, buf);
    }
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
}

static const char *averr(int e, char *buf, size_t n)
{
    av_strerror(e, buf, n);
    return buf;
}

/* with s->mu held */
static double clock_get(struct session *s)
{
    if (!s->clk_valid) return NAN;
    return s->clk_held ? s->clk_pts : s->clk_pts + (now_s() - s->clk_t);
}

static void clock_set(struct session *s, double pts, int serial)
{
    s->clk_pts = pts;
    s->clk_t = now_s();
    s->clk_serial = serial;
    s->clk_valid = 1;
}

/* with s->mu held: the clock stands while paused or buffering */
static void clock_hold(struct session *s)
{
    int hold = s->paused || s->buffering;
    if (hold == s->clk_held) return;
    if (hold) { if (s->clk_valid) s->clk_pts = clock_get(s); s->clk_held = 1; }
    else { s->clk_t = now_s(); s->clk_held = 0; }
}

/* Wait on s->cv (held) for at most sec. */
static void wait_s(struct session *s, double sec)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    ts.tv_sec += (time_t)sec;
    ts.tv_nsec += (long)((sec - floor(sec)) * 1e9);
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(&s->cv, &s->mu, &ts);
}

static void need_cb(void *ctx, const char *stream, int64_t off, uint32_t req)
{
    struct session *s = ctx;
    char line[200];
    snprintf(line, sizeof line, "{\"ev\":\"need\",\"sid\":%d,\"stream\":\"%s\",\"off\":%lld,\"req\":%u}", s->a.sid, stream,
        (long long)off, req);
    s->cfg.emit(s->cfg.ctx, line);
}

/* ---- picture ------------------------------------------------------------------- */

static void show_frame(struct session *s, struct track *tr, AVFrame *fr, int serial, int *first)
{
    double pts = fr->best_effort_timestamp == AV_NOPTS_VALUE ? NAN : (double)fr->best_effort_timestamp * av_q2d(tr->tb);
    pthread_mutex_lock(&s->mu);
    if (isnan(pts)) pts = s->pos;
    /* a seek lands on the key frame before its target: the pictures up to the target are decoded, not shown */
    if (pts < s->seek_target - 0.02 && serial == s->serial) { pthread_mutex_unlock(&s->mu); return; }
    double waited = 0;
    for (;;) {
        if (s->stop || s->failed || serial != s->serial) { pthread_mutex_unlock(&s->mu); return; }
        if (*first) {
            /* the first picture after a start or a seek shows at once, also while paused; with sound, the
               sound's clock is waited for a moment so both start together */
            if (s->audio_on && s->audio.used && !s->audio.done && !(s->clk_valid && s->clk_serial == serial) && waited < 1.5 && !s->paused) {
                wait_s(s, 0.02);
                waited += 0.02;
                continue;
            }
            if (!(s->clk_valid && s->clk_serial == serial)) clock_set(s, pts, serial);
            break;
        }
        if (s->paused || s->buffering) { wait_s(s, 0.2); continue; }
        double d = pts - clock_get(s);
        if (d > 0.002) { wait_s(s, d > 0.05 ? 0.05 : d); continue; }
        if (d < -LATE_S && now_s() - s->last_status_t < 1e9) {
            static __thread double last_shown;
            double t = now_s();
            if (t - last_shown < STALE_S) {
                s->dropped++;
                /* far behind: the decoder leaves out pictures nothing depends on until it has caught up */
                if (d < -0.25) tr->dec->skip_frame = AVDISCARD_NONREF;
                pthread_mutex_unlock(&s->mu);
                return;
            }
            last_shown = t;
        } else if (d > -0.03) tr->dec->skip_frame = AVDISCARD_DEFAULT;
        break;
    }
    *first = 0;
    s->pos = pts;
    s->w = fr->width;
    s->h = fr->height;
    s->shown++;
    pthread_mutex_unlock(&s->mu);
    if (frames_write(s->cfg.frames, fr) < 0) fail(s, "picture %dx%d cannot be shown", fr->width, fr->height);
}

static void *video_main(void *arg)
{
    struct track *tr = arg;
    struct session *s = tr->s;
    AVFrame *fr = av_frame_alloc();
    int serial = -1, first = 1;
    if (!fr) { fail(s, "out of memory"); return NULL; }
    for (;;) {
        pthread_mutex_lock(&s->mu);
        int stop = s->stop || s->failed;
        pthread_mutex_unlock(&s->mu);
        if (stop) break;

        /* ran dry before the end: hold the clock until some packets are there again */
        if (!first && serial >= 0 && !tr->feed_eof && pq_count(&tr->q) == 0) {
            pthread_mutex_lock(&s->mu);
            if (serial == s->serial && !s->paused) {
                s->buffering = 1;
                clock_hold(s);
                while (!s->stop && !s->failed && serial == s->serial && !tr->feed_eof) {
                    pthread_mutex_unlock(&s->mu);
                    int c = pq_count(&tr->q);
                    pthread_mutex_lock(&s->mu);
                    if (c >= REFILL_COUNT) break;
                    wait_s(s, 0.05);
                }
                s->buffering = 0;
                clock_hold(s);
                pthread_cond_broadcast(&s->cv);
            }
            pthread_mutex_unlock(&s->mu);
        }

        struct node *n = pq_get(&tr->q, 0.2);
        if (!n) continue;
        if (n->flush) {
            avcodec_flush_buffers(tr->dec);
            tr->dec->skip_frame = AVDISCARD_DEFAULT;
            serial = n->serial;
            first = 1;
            pthread_mutex_lock(&s->mu);
            tr->done = 0;
            pthread_mutex_unlock(&s->mu);
            free(n);
            continue;
        }
        if (n->serial != serial) { if (n->pkt) av_packet_free(&n->pkt); free(n); continue; }
        int r = avcodec_send_packet(tr->dec, n->eof ? NULL : n->pkt);
        int was_eof = n->eof;
        if (n->pkt) av_packet_free(&n->pkt);
        free(n);
        if (r < 0 && r != AVERROR(EAGAIN) && r != AVERROR_EOF && r != AVERROR_INVALIDDATA) {
            char e[100];
            fail(s, "picture decoder: %s", averr(r, e, sizeof e));
            break;
        }
        while (avcodec_receive_frame(tr->dec, fr) == 0) {
            show_frame(s, tr, fr, serial, &first);
            av_frame_unref(fr);
        }
        if (was_eof) {
            pthread_mutex_lock(&s->mu);
            if (serial == s->serial) tr->done = 1;
            pthread_cond_broadcast(&s->cv);
            pthread_mutex_unlock(&s->mu);
        }
    }
    av_frame_free(&fr);
    return NULL;
}

/* ---- sound ----------------------------------------------------------------------- */

/* with s->mu held: no sound from here on, the picture goes on by the clock */
static void audio_off(struct session *s, const char *why)
{
    if (!s->audio_on) return;
    s->audio_on = 0;
    snprintf(s->audio_note, sizeof s->audio_note, "%s", why);
    log_warn("session %d: sound off: %s", s->a.sid, why);
    pthread_cond_broadcast(&s->cv);
}

static void play_samples(struct session *s, struct track *tr, AVFrame *fr, int serial, int *first, double *fed_from, double *fed_t)
{
    double pts = fr->best_effort_timestamp == AV_NOPTS_VALUE ? NAN : (double)fr->best_effort_timestamp * av_q2d(tr->tb);
    double dur = fr->sample_rate > 0 ? (double)fr->nb_samples / fr->sample_rate : 0;
    pthread_mutex_lock(&s->mu);
    int on = s->audio_on;
    double floor_pts = s->seek_target;
    double gain = s->gain;
    pthread_mutex_unlock(&s->mu);
    if (!on || isnan(pts) || pts + dur < floor_pts) return;

    if (!s->swr || s->swr_rate != fr->sample_rate || s->swr_fmt != fr->format || s->swr_ch != fr->ch_layout.nb_channels) {
        AVChannelLayout out = AV_CHANNEL_LAYOUT_STEREO;
        swr_free(&s->swr);
        if (swr_alloc_set_opts2(&s->swr, &out, AV_SAMPLE_FMT_S16, AUDIO_RATE, &fr->ch_layout, (enum AVSampleFormat)fr->format,
                fr->sample_rate, 0, NULL) < 0 || swr_init(s->swr) < 0) {
            swr_free(&s->swr);
            pthread_mutex_lock(&s->mu);
            audio_off(s, "this sound format cannot be converted");
            pthread_mutex_unlock(&s->mu);
            return;
        }
        s->swr_rate = fr->sample_rate; s->swr_fmt = fr->format; s->swr_ch = fr->ch_layout.nb_channels;
    }
    int cap = (int)av_rescale_rnd(swr_get_delay(s->swr, fr->sample_rate) + fr->nb_samples, AUDIO_RATE, fr->sample_rate, AV_ROUND_UP) + 64;
    int16_t *buf = malloc((size_t)cap * 2 * sizeof *buf);
    if (!buf) return;
    uint8_t *outp[1] = { (uint8_t *)buf };
    int n = swr_convert(s->swr, outp, cap, (const uint8_t **)fr->extended_data, fr->nb_samples);
    if (n <= 0) { free(buf); return; }
    if (gain < 0.999) {
        int g = (int)(gain * 32768.0);
        for (int i = 0; i < n * 2; i++) buf[i] = (int16_t)(((int)buf[i] * g) >> 15);
    }

    int done = 0;
    while (done < n) {
        pthread_mutex_lock(&s->mu);
        if (s->stop || s->failed || serial != s->serial || !s->audio_on) { pthread_mutex_unlock(&s->mu); break; }
        if (s->paused || s->buffering) {
            /* what the device still holds is dropped, so sound stops with the picture */
            pthread_mutex_unlock(&s->mu);
            audio_drop(&s->au);
            pthread_mutex_lock(&s->mu);
            while ((s->paused || s->buffering) && !s->stop && !s->failed && serial == s->serial) wait_s(s, 0.2);
            *first = 1;
            pthread_mutex_unlock(&s->mu);
            continue;
        }
        pthread_mutex_unlock(&s->mu);
        double at = pts + (double)done / AUDIO_RATE;
        if (*first) { *fed_from = at; *fed_t = now_s(); }
        /* a device that takes sound faster than it plays (a file, a null device) is fed in real time */
        double lead = (at - *fed_from) - (now_s() - *fed_t);
        if (lead > 0.3) { sleep_s(lead - 0.3 > 0.05 ? 0.05 : lead - 0.3); continue; }
        int r = audio_write(&s->au, buf + (size_t)done * 2, n - done, 200);
        pthread_mutex_lock(&s->mu);
        if (r < 0) audio_off(s, s->au.err);
        else if (r == 0 && s->au.stalled > 3.0) {
            char why[200];
            snprintf(why, sizeof why, "%.100s: nothing in the car reads it (it took no sound for 3 s)", s->au.dev);
            audio_off(s, why);
        } else if (r > 0) {
            done += r;
            *first = 0;
            if (serial == s->serial && !s->paused && !s->buffering)
                clock_set(s, pts + (double)done / AUDIO_RATE - audio_delay(&s->au), serial);
            pthread_cond_broadcast(&s->cv);
        }
        pthread_mutex_unlock(&s->mu);
    }
    free(buf);
}

static void *audio_main(void *arg)
{
    struct track *tr = arg;
    struct session *s = tr->s;
    AVFrame *fr = av_frame_alloc();
    int serial = -1, first = 1;
    double fed_from = 0, fed_t = 0;
    if (!fr) { fail(s, "out of memory"); return NULL; }
    for (;;) {
        pthread_mutex_lock(&s->mu);
        int stop = s->stop || s->failed;
        pthread_mutex_unlock(&s->mu);
        if (stop) break;
        struct node *n = pq_get(&tr->q, 0.2);
        if (!n) continue;
        if (n->flush) {
            avcodec_flush_buffers(tr->dec);
            if (s->swr) { swr_free(&s->swr); }
            audio_drop(&s->au);
            serial = n->serial;
            first = 1;
            pthread_mutex_lock(&s->mu);
            tr->done = 0;
            pthread_mutex_unlock(&s->mu);
            free(n);
            continue;
        }
        if (n->serial != serial) { if (n->pkt) av_packet_free(&n->pkt); free(n); continue; }
        int r = avcodec_send_packet(tr->dec, n->eof ? NULL : n->pkt);
        int was_eof = n->eof;
        if (n->pkt) av_packet_free(&n->pkt);
        free(n);
        if (r < 0 && r != AVERROR(EAGAIN) && r != AVERROR_EOF && r != AVERROR_INVALIDDATA) {
            pthread_mutex_lock(&s->mu);
            audio_off(s, "the sound decoder failed");
            pthread_mutex_unlock(&s->mu);
        }
        while (avcodec_receive_frame(tr->dec, fr) == 0) {
            play_samples(s, tr, fr, serial, &first, &fed_from, &fed_t);
            av_frame_unref(fr);
        }
        if (was_eof) {
            pthread_mutex_lock(&s->mu);
            if (serial == s->serial) tr->done = 1;
            pthread_cond_broadcast(&s->cv);
            pthread_mutex_unlock(&s->mu);
        }
    }
    av_frame_free(&fr);
    return NULL;
}

/* ---- input ------------------------------------------------------------------------ */

static int open_track(struct session *s, struct input *in, struct track *tr, enum AVMediaType type)
{
    char e[100];
    int idx = av_find_best_stream(in->fmt, type, -1, -1, NULL, 0);
    const char *what = type == AVMEDIA_TYPE_VIDEO ? "picture" : "sound";
    if (idx < 0) {
        if (type == AVMEDIA_TYPE_AUDIO) {
            pthread_mutex_lock(&s->mu);
            audio_off(s, "this video has no sound stream the player can read");
            pthread_mutex_unlock(&s->mu);
            return 0;
        }
        fail(s, "no %s stream in the file", what);
        return -1;
    }
    AVStream *st = in->fmt->streams[idx];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) {
        if (type == AVMEDIA_TYPE_AUDIO) {
            pthread_mutex_lock(&s->mu);
            audio_off(s, "no decoder for this video's sound");
            pthread_mutex_unlock(&s->mu);
            return 0;
        }
        fail(s, "no decoder for this video's %s (%s)", what, avcodec_get_name(st->codecpar->codec_id));
        return -1;
    }
    tr->dec = avcodec_alloc_context3(codec);
    if (!tr->dec || avcodec_parameters_to_context(tr->dec, st->codecpar) < 0) { fail(s, "out of memory"); return -1; }
    tr->dec->pkt_timebase = st->time_base;
    if (type == AVMEDIA_TYPE_VIDEO) {
        if (st->codecpar->width > FRAMES_MAX || st->codecpar->height > FRAMES_MAX) {
            fail(s, "picture %dx%d is larger than the renderer shows", st->codecpar->width, st->codecpar->height);
            return -1;
        }
        int ncpu = (int)sysconf(_SC_NPROCESSORS_ONLN);
        int th = s->cfg.threads > 0 ? s->cfg.threads : (ncpu > 4 ? 4 : ncpu < 1 ? 1 : ncpu);
        tr->dec->thread_count = th;
        tr->dec->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    }
    int r = avcodec_open2(tr->dec, codec, NULL);
    if (r < 0) { fail(s, "%s decoder would not start: %s", what, averr(r, e, sizeof e)); return -1; }
    tr->s = s;
    tr->kind = type;
    tr->index = idx;
    tr->tb = st->time_base;
    tr->used = 1;
    st->discard = AVDISCARD_DEFAULT;
    in->tracks[in->ntracks++] = tr;
    if (type == AVMEDIA_TYPE_VIDEO) {
        AVRational fr = av_guess_frame_rate(in->fmt, st, NULL);
        pthread_mutex_lock(&s->mu);
        s->w = st->codecpar->width;
        s->h = st->codecpar->height;
        s->fps = fr.num > 0 && fr.den > 0 ? av_q2d(fr) : 0;
        pthread_mutex_unlock(&s->mu);
    }
    if (pthread_create(&tr->th, NULL, type == AVMEDIA_TYPE_VIDEO ? video_main : audio_main, tr) != 0) { fail(s, "no thread"); return -1; }
    tr->started = 1;
    return 0;
}

static void *demux_main(void *arg)
{
    struct input *in = arg;
    struct session *s = in->s;
    char e[100];
    int is_video_input = in == &s->in[0];

    unsigned char *iobuf = av_malloc(65536);
    if (!iobuf) { fail(s, "out of memory"); return NULL; }
    in->avio = avio_alloc_context(iobuf, 65536, 0, &in->src, source_read, NULL, source_seek);
    in->fmt = avformat_alloc_context();
    if (!in->avio || !in->fmt) { if (!in->avio) av_free(iobuf); fail(s, "out of memory"); return NULL; }
    in->fmt->pb = in->avio;
    in->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
    in->fmt->max_analyze_duration = 2 * AV_TIME_BASE;
    int r = avformat_open_input(&in->fmt, NULL, NULL, NULL);
    if (r < 0) {
        /* (open_input frees the context on failure) */
        if (r != AVERROR_EXIT) fail(s, "the %s file cannot be read: %s", in->src.name, averr(r, e, sizeof e));
        return NULL;
    }
    r = avformat_find_stream_info(in->fmt, NULL);
    if (r < 0) { if (r != AVERROR_EXIT) fail(s, "the %s file has no readable streams: %s", in->src.name, averr(r, e, sizeof e)); return NULL; }
    for (unsigned i = 0; i < in->fmt->nb_streams; i++) in->fmt->streams[i]->discard = AVDISCARD_ALL;

    pthread_mutex_lock(&s->mu);
    int want_audio = s->audio_on;
    pthread_mutex_unlock(&s->mu);
    if (is_video_input && open_track(s, in, &s->video, AVMEDIA_TYPE_VIDEO) < 0) return NULL;
    if (want_audio && ((s->a.muxed && is_video_input) || (!s->a.muxed && !is_video_input))) {
        if (open_track(s, in, &s->audio, AVMEDIA_TYPE_AUDIO) < 0) return NULL;
    }
    pthread_mutex_lock(&s->mu);
    if (in->fmt->duration > 0) {
        double d = (double)in->fmt->duration / AV_TIME_BASE;
        if (d > s->duration) s->duration = d;
    }
    s->inputs_ready++;
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);

    AVPacket *pkt = NULL;
    int at_eof = 0;
    for (;;) {
        pthread_mutex_lock(&s->mu);
        while (at_eof && !s->stop && !s->failed && in->serial_seen == s->serial) wait_s(s, 0.5);
        int stop = s->stop || s->failed;
        int serial = s->serial;
        double target = s->seek_target;
        pthread_mutex_unlock(&s->mu);
        if (stop) break;

        if (serial != in->serial_seen) {
            /* a start position or a seek: every track of this input starts again from there */
            if (target > 0 || in->serial_seen > 0) {
                int64_t ts = (int64_t)(target * AV_TIME_BASE);
                r = avformat_seek_file(in->fmt, -1, INT64_MIN, ts, ts, 0);
                if (r < 0) log_warn("session %d: %s: seek to %.1f s: %s", s->a.sid, in->src.name, target, averr(r, e, sizeof e));
            }
            in->serial_seen = serial;
            at_eof = 0;
            for (int i = 0; i < in->ntracks; i++) {
                struct track *tr = in->tracks[i];
                pq_flush(&tr->q);
                pq_signal(&tr->q, 0, 0);
                tr->feed_eof = 0;
                pq_put(&tr->q, NULL, serial, 1, 0);
            }
            continue;
        }

        if (!pkt) pkt = av_packet_alloc();
        if (!pkt) { fail(s, "out of memory"); break; }
        r = av_read_frame(in->fmt, pkt);
        if (r < 0) {
            if (r == AVERROR_EXIT) break;
            if (r != AVERROR_EOF) {
                /* a read that failed for good (the download kept ending): the error shows, the rest plays out */
                if (in->avio->error) { fail(s, "the %s download failed: %s", in->src.name, averr(in->avio->error, e, sizeof e)); break; }
                log_warn("session %d: %s: %s", s->a.sid, in->src.name, averr(r, e, sizeof e));
            }
            for (int i = 0; i < in->ntracks; i++) {
                in->tracks[i]->feed_eof = 1;
                pq_put(&in->tracks[i]->q, NULL, in->serial_seen, 0, 1);
            }
            at_eof = 1;
            continue;
        }
        struct track *to = NULL;
        for (int i = 0; i < in->ntracks; i++) if (in->tracks[i]->index == pkt->stream_index) to = in->tracks[i];
        if (!to) { av_packet_unref(pkt); continue; }
        /* (put takes the packet; when a seek interrupts it, the packet is dropped and the seek runs next) */
        pq_put(&to->q, pkt, in->serial_seen, 0, 0);
        pkt = NULL;
    }
    if (pkt) av_packet_free(&pkt);
    return NULL;
}

/* ---- the session's own calls --------------------------------------------------------- */

struct session *session_open(const struct player_cfg *cfg, const struct open_args *a)
{
    struct session *s = calloc(1, sizeof *s);
    if (!s) return NULL;
    s->cfg = *cfg;
    s->a = *a;
    pthread_mutex_init(&s->mu, NULL);
    pthread_condattr_t ca;
    pthread_condattr_init(&ca);
    pthread_condattr_setclock(&ca, CLOCK_MONOTONIC);
    pthread_cond_init(&s->cv, &ca);
    pthread_condattr_destroy(&ca);
    s->serial = 1;
    s->seek_target = a->start > 0 ? a->start : 0;
    s->pos = s->seek_target;
    s->gain = pow(10.0, (a->gain_db > 0 ? 0 : a->gain_db < -60 ? -60 : a->gain_db) / 20.0);
    pq_init(&s->video.q, VIDEO_Q_BYTES, VIDEO_Q_COUNT);
    pq_init(&s->audio.q, AUDIO_Q_BYTES, AUDIO_Q_COUNT);

    if (a->audio_dev[0] && a->has_audio) {
        if (audio_open(&s->au, a->audio_dev, AUDIO_RATE) == 0) s->audio_on = 1;
        else snprintf(s->audio_note, sizeof s->audio_note, "%s", s->au.err);
    } else snprintf(s->audio_note, sizeof s->audio_note, "%s", a->has_audio ? "off" : "this video has no sound stream");

    s->nin = (!a->muxed && s->audio_on) ? 2 : 1;
    source_init(&s->in[0].src, "video", a->vsize, need_cb, s);
    if (s->nin == 2) source_init(&s->in[1].src, "audio", a->asize, need_cb, s);
    for (int i = 0; i < s->nin; i++) {
        s->in[i].s = s;
        if (pthread_create(&s->in[i].th, NULL, demux_main, &s->in[i]) != 0) { fail(s, "no thread"); break; }
        s->in[i].started = 1;
    }
    log_info("session %d: open (%s, sound %s, from %.1f s)", a->sid, a->muxed ? "one file" : "picture and sound apart",
        s->audio_on ? s->au.dev : s->audio_note, s->seek_target);
    return s;
}

int session_id(const struct session *s) { return s->a.sid; }

void session_attach(struct session *s, const char *stream, int fd, uint32_t req, int64_t off, int64_t size)
{
    struct input *in = !strcmp(stream, "video") ? &s->in[0] : (!strcmp(stream, "audio") && s->nin == 2) ? &s->in[1] : NULL;
    if (!in) { close(fd); return; }
    source_attach(&in->src, fd, req, off, size);
}

void session_pause(struct session *s, int paused)
{
    pthread_mutex_lock(&s->mu);
    s->paused = !!paused;
    clock_hold(s);
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
}

void session_seek(struct session *s, double t)
{
    pthread_mutex_lock(&s->mu);
    if (t < 0) t = 0;
    if (s->duration > 1 && t > s->duration - 0.5) t = s->duration - 0.5;
    s->seek_target = t;
    s->pos = t;
    s->serial++;
    s->clk_valid = 0;
    s->buffering = 0;
    s->video.done = s->audio.done = 0;
    clock_hold(s);
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
    /* demuxers waiting to queue a packet give up and run the seek */
    if (s->video.used) pq_signal(&s->video.q, 0, 1);
    if (s->audio.used) pq_signal(&s->audio.q, 0, 1);
}

void session_gain(struct session *s, double db)
{
    pthread_mutex_lock(&s->mu);
    s->gain = pow(10.0, (db > 0 ? 0 : db < -60 ? -60 : db) / 20.0);
    pthread_mutex_unlock(&s->mu);
}

int session_status(struct session *s, char *out, size_t n, int force)
{
    char q1[260], q2[260], body[480];
    pthread_mutex_lock(&s->mu);
    int video_done = s->video.used && s->video.done;
    int audio_done = !s->audio.used || !s->audio_on || s->audio.done;
    int state = s->failed ? ST_ERROR
        : !s->video.used || !s->shown ? (s->inputs_ready < s->nin ? ST_OPENING : ST_BUFFERING)
        : (video_done && audio_done) ? ST_ENDED
        : s->paused ? ST_PAUSED
        : s->buffering || !s->clk_valid ? ST_BUFFERING : ST_PLAYING;
    double pos = state == ST_ENDED && s->duration > 0 ? s->duration : s->clk_valid && s->shown ? clock_get(s) : s->pos;
    if (pos < 0) pos = 0;
    if (s->duration > 0 && pos > s->duration) pos = s->duration;
    /* the part that says whether anything changed (the position alone moves all the time) */
    snprintf(body, sizeof body, "\"state\":\"%s\",\"dur\":%.2f,\"w\":%d,\"h\":%d,\"fps\":%.2f,\"audio\":%s,\"err\":%s",
        STATE_NAME[state], s->duration, s->w, s->h, s->fps,
        json_quote(s->audio_on ? s->au.dev : "", q1, sizeof q1),
        json_quote(s->failed ? s->err : s->audio_on ? "" : s->audio_note, q2, sizeof q2));
    int changed = force || strcmp(body, s->last_status) != 0 || now_s() - s->last_status_t >= 0.5;
    if (changed) {
        snprintf(s->last_status, sizeof s->last_status, "%s", body);
        s->last_status_t = now_s();
        snprintf(out, n, "{\"ev\":\"state\",\"sid\":%d,%s,\"pos\":%.2f,\"shown\":%u,\"dropped\":%u}", s->a.sid, body, pos,
            s->shown, s->dropped);
    }
    pthread_mutex_unlock(&s->mu);
    return changed;
}

void session_close(struct session *s)
{
    pthread_mutex_lock(&s->mu);
    s->stop = 1;
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
    for (int i = 0; i < s->nin; i++) source_abort(&s->in[i].src);
    pq_signal(&s->video.q, 1, 0);
    pq_signal(&s->audio.q, 1, 0);
    for (int i = 0; i < s->nin; i++) if (s->in[i].started) pthread_join(s->in[i].th, NULL);
    if (s->video.started) pthread_join(s->video.th, NULL);
    if (s->audio.started) pthread_join(s->audio.th, NULL);
    for (int i = 0; i < s->nin; i++) {
        struct input *in = &s->in[i];
        if (in->fmt) avformat_close_input(&in->fmt);
        if (in->avio) { av_freep(&in->avio->buffer); avio_context_free(&in->avio); }
        source_free(&in->src);
    }
    avcodec_free_context(&s->video.dec);
    avcodec_free_context(&s->audio.dec);
    swr_free(&s->swr);
    audio_close(&s->au);
    pq_free(&s->video.q);
    pq_free(&s->audio.q);
    frames_clear(s->cfg.frames);
    log_info("session %d: closed (%u pictures shown, %u left out)", s->a.sid, s->shown, s->dropped);
    pthread_mutex_destroy(&s->mu);
    pthread_cond_destroy(&s->cv);
    free(s);
}
