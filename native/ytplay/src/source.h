/*
 * A media file's bytes, handed over by the app: the player has no network of its own. It says which byte it
 * needs next ("need", through the callback), the app opens a data connection that carries the file from there
 * on, and a seek elsewhere asks again and drops the old connection.
 */
#ifndef YTPLAY_SOURCE_H
#define YTPLAY_SOURCE_H

#include <pthread.h>
#include <stdint.h>

typedef void (*source_need_fn)(void *ctx, const char *stream, int64_t off, uint32_t req);

struct source {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    char name[8];               /* "video" or "audio" */
    int fd;                     /* the data connection, -1 while there is none */
    int64_t pos;                /* the next byte read() gives */
    int64_t size;               /* the whole file, -1 unknown */
    uint32_t req;               /* the request the connection must answer */
    int asked;                  /* a request is out and no connection came yet */
    int abort;
    int retries;                /* connections in a row that ended early without a byte */
    source_need_fn need;
    void *ctx;
};

void source_init(struct source *s, const char *name, int64_t size, source_need_fn need, void *ctx);
/* A data connection for request req, starting at off (size: the file's, when the app knows it). Takes fd. */
void source_attach(struct source *s, int fd, uint32_t req, int64_t off, int64_t size);
/* Wake every waiter and fail every later read. */
void source_abort(struct source *s);
void source_free(struct source *s);

/* AVIO callbacks (opaque = the source). */
int source_read(void *opaque, uint8_t *buf, int n);
int64_t source_seek(void *opaque, int64_t off, int whence);

#endif
