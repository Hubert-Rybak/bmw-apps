#include "source.h"
#include "util.h"

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <libavformat/avio.h>
#include <libavutil/error.h>

/* a seek this far ahead reads on through the connection instead of asking for a new one */
#define SKIP_AHEAD (512 * 1024)
/* how long a read waits for the app to bring a connection, and then for bytes on it */
#define WAIT_S 30.0
#define MAX_RETRIES 5

void source_init(struct source *s, const char *name, int64_t size, source_need_fn need, void *ctx)
{
    memset(s, 0, sizeof *s);
    pthread_mutex_init(&s->mu, NULL);
    pthread_condattr_t ca;
    pthread_condattr_init(&ca);
    pthread_condattr_setclock(&ca, CLOCK_MONOTONIC);
    pthread_cond_init(&s->cv, &ca);
    pthread_condattr_destroy(&ca);
    snprintf(s->name, sizeof s->name, "%s", name);
    s->fd = -1;
    s->size = size;
    s->need = need;
    s->ctx = ctx;
}

void source_free(struct source *s)
{
    if (s->fd >= 0) close(s->fd);
    s->fd = -1;
    pthread_mutex_destroy(&s->mu);
    pthread_cond_destroy(&s->cv);
}

void source_abort(struct source *s)
{
    pthread_mutex_lock(&s->mu);
    s->abort = 1;
    /* a reader blocked in poll() on the connection sees it shut */
    if (s->fd >= 0) shutdown(s->fd, SHUT_RDWR);
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
}

/* With the lock held: ask the app for the file from pos on. */
static void ask(struct source *s)
{
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    s->req++;
    s->asked = 1;
    uint32_t req = s->req;
    int64_t off = s->pos;
    /* the callback writes to the control connection: not under our lock */
    pthread_mutex_unlock(&s->mu);
    s->need(s->ctx, s->name, off, req);
    pthread_mutex_lock(&s->mu);
}

void source_attach(struct source *s, int fd, uint32_t req, int64_t off, int64_t size)
{
    pthread_mutex_lock(&s->mu);
    if (s->abort || req != s->req || off != s->pos || s->fd >= 0) {
        /* an answer to a request a later seek replaced */
        pthread_mutex_unlock(&s->mu);
        close(fd);
        return;
    }
    s->fd = fd;
    s->asked = 0;
    if (size > 0) s->size = size;
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
}

int source_read(void *opaque, uint8_t *buf, int n)
{
    struct source *s = opaque;
    if (n <= 0) return 0;
    pthread_mutex_lock(&s->mu);
    for (;;) {
        if (s->abort) { pthread_mutex_unlock(&s->mu); return AVERROR_EXIT; }
        if (s->size >= 0 && s->pos >= s->size) { pthread_mutex_unlock(&s->mu); return AVERROR_EOF; }
        if (s->fd < 0) {
            if (!s->asked) ask(s);
            if (s->abort) continue;
            if (s->fd < 0) {
                struct timespec ts;
                clock_gettime(CLOCK_MONOTONIC, &ts);
                ts.tv_sec += (time_t)WAIT_S;
                if (pthread_cond_timedwait(&s->cv, &s->mu, &ts) == ETIMEDOUT && s->fd < 0 && !s->abort) {
                    pthread_mutex_unlock(&s->mu);
                    log_warn("%s: no data connection from the app in %.0f s", s->name, WAIT_S);
                    return AVERROR(ETIMEDOUT);
                }
                continue;
            }
        }
        int fd = s->fd;
        uint32_t req = s->req;
        pthread_mutex_unlock(&s->mu);

        /* wait for bytes without the lock, so that a seek or a stop can take the connection away */
        ssize_t r = -1;
        double t0 = now_s();
        for (;;) {
            struct pollfd p = { fd, POLLIN, 0 };
            int pr = poll(&p, 1, 200);
            pthread_mutex_lock(&s->mu);
            int gone = s->abort || s->fd != fd || s->req != req;
            pthread_mutex_unlock(&s->mu);
            if (gone) { r = -2; break; }
            if (pr > 0) { r = recv(fd, buf, (size_t)n, 0); if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue; break; }
            if (pr < 0 && errno != EINTR) { r = -1; break; }
            if (now_s() - t0 > WAIT_S) { r = -3; break; }
        }

        pthread_mutex_lock(&s->mu);
        if (r == -2) continue;                      /* replaced meanwhile: look again */
        if (s->fd != fd || s->req != req) continue;
        if (r > 0) {
            s->pos += r;
            s->retries = 0;
            pthread_mutex_unlock(&s->mu);
            return (int)r;
        }
        /* the connection ended (or went silent): the file's end, or the app lost its download */
        close(s->fd);
        s->fd = -1;
        if (s->size < 0 && r == 0 && s->retries == 0 && s->pos > 0) {
            /* a file of unknown size ends where its connection does */
            s->size = s->pos;
            continue;
        }
        if (s->size >= 0 && s->pos >= s->size) continue;
        if (++s->retries > MAX_RETRIES) {
            pthread_mutex_unlock(&s->mu);
            log_warn("%s: the download ended early %d times at byte %lld", s->name, MAX_RETRIES, (long long)s->pos);
            return AVERROR(EIO);
        }
        /* asks again from pos at the top of the loop */
    }
}

int64_t source_seek(void *opaque, int64_t off, int whence)
{
    struct source *s = opaque;
    pthread_mutex_lock(&s->mu);
    if (whence == AVSEEK_SIZE) {
        int64_t sz = s->size;
        pthread_mutex_unlock(&s->mu);
        return sz >= 0 ? sz : AVERROR(ENOSYS);
    }
    whence &= ~AVSEEK_FORCE;
    int64_t to;
    if (whence == SEEK_SET) to = off;
    else if (whence == SEEK_CUR) to = s->pos + off;
    else if (whence == SEEK_END && s->size >= 0) to = s->size + off;
    else { pthread_mutex_unlock(&s->mu); return AVERROR(EINVAL); }
    if (to < 0) { pthread_mutex_unlock(&s->mu); return AVERROR(EINVAL); }
    if (to == s->pos) { pthread_mutex_unlock(&s->mu); return to; }
    int64_t ahead = to - s->pos;
    if (s->fd >= 0 && ahead > 0 && ahead <= SKIP_AHEAD) {
        /* a short hop forward: cheaper to read through than to start a new download */
        pthread_mutex_unlock(&s->mu);
        uint8_t skip[16384];
        while (ahead > 0) {
            int r = source_read(s, skip, ahead > (int64_t)sizeof skip ? (int)sizeof skip : (int)ahead);
            if (r <= 0) return r < 0 ? r : AVERROR_EOF;
            ahead -= r;
        }
        return to;
    }
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    s->pos = to;
    s->asked = 0;
    s->retries = 0;
    /* the request goes out with the next read: a demuxer often seeks twice before it reads */
    s->req++;
    pthread_mutex_unlock(&s->mu);
    return to;
}
