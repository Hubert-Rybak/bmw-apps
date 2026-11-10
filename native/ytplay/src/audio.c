#include "audio.h"
#include "util.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The few libasound calls used, by their documented prototypes (alsa-lib's asoundlib.h); snd_pcm_t is opaque. */
typedef long sframes;
static struct {
    void *lib;
    int tried;
    int (*pcm_open)(void **pcm, const char *name, int stream, int mode);
    int (*pcm_close)(void *pcm);
    int (*pcm_set_params)(void *pcm, int format, int access, unsigned channels, unsigned rate, int soft_resample, unsigned latency_us);
    int (*pcm_get_params)(void *pcm, unsigned long *buffer_size, unsigned long *period_size);
    sframes (*pcm_writei)(void *pcm, const void *buf, unsigned long frames);
    int (*pcm_wait)(void *pcm, int timeout_ms);
    int (*pcm_delay)(void *pcm, sframes *delay);
    int (*pcm_recover)(void *pcm, int err, int silent);
    int (*pcm_drop)(void *pcm);
    int (*pcm_prepare)(void *pcm);
    int (*device_name_hint)(int card, const char *iface, void ***hints);
    char *(*device_name_get_hint)(const void *hint, const char *id);
    int (*device_name_free_hint)(void **hints);
    const char *(*strerror)(int err);
} A;
static pthread_mutex_t load_mu = PTHREAD_MUTEX_INITIALIZER;

#define PCM_STREAM_PLAYBACK 0
#define PCM_NONBLOCK 1
#define PCM_FORMAT_S16_LE 2
#define PCM_ACCESS_RW_INTERLEAVED 3

static int load(void)
{
    pthread_mutex_lock(&load_mu);
    if (!A.tried) {
        A.tried = 1;
        void *l = dlopen("libasound.so.2", RTLD_NOW | RTLD_GLOBAL);
        if (l) {
#define SYM(field, name) (*(void **)&A.field = dlsym(l, name))
            SYM(pcm_open, "snd_pcm_open");
            SYM(pcm_close, "snd_pcm_close");
            SYM(pcm_set_params, "snd_pcm_set_params");
            SYM(pcm_get_params, "snd_pcm_get_params");
            SYM(pcm_writei, "snd_pcm_writei");
            SYM(pcm_wait, "snd_pcm_wait");
            SYM(pcm_delay, "snd_pcm_delay");
            SYM(pcm_recover, "snd_pcm_recover");
            SYM(pcm_drop, "snd_pcm_drop");
            SYM(pcm_prepare, "snd_pcm_prepare");
            SYM(device_name_hint, "snd_device_name_hint");
            SYM(device_name_get_hint, "snd_device_name_get_hint");
            SYM(device_name_free_hint, "snd_device_name_free_hint");
            SYM(strerror, "snd_strerror");
#undef SYM
            if (A.pcm_open && A.pcm_close && A.pcm_set_params && A.pcm_writei && A.pcm_wait && A.pcm_delay && A.pcm_recover
                && A.pcm_drop && A.pcm_prepare && A.strerror) A.lib = l;
            else dlclose(l);
        }
    }
    pthread_mutex_unlock(&load_mu);
    return A.lib ? 0 : -1;
}

int audio_available(void) { return load(); }

int audio_open(struct audio *a, const char *dev, unsigned rate)
{
    memset(a, 0, sizeof *a);
    snprintf(a->dev, sizeof a->dev, "%s", dev);
    a->rate = rate;
    if (load() < 0) { snprintf(a->err, sizeof a->err, "no ALSA library on this unit"); return -1; }
    void *pcm = NULL;
    /* non-blocking: a device nothing reads must not hold the player (audio_write waits with a limit) */
    int r = A.pcm_open(&pcm, dev, PCM_STREAM_PLAYBACK, PCM_NONBLOCK);
    if (r < 0) { snprintf(a->err, sizeof a->err, "%s: %s", dev, A.strerror(r)); return -1; }
    /* the device's own format first (the unit's devices refuse a converter); 100 ms of buffer */
    r = A.pcm_set_params(pcm, PCM_FORMAT_S16_LE, PCM_ACCESS_RW_INTERLEAVED, 2, rate, 0, 100000);
    if (r < 0) r = A.pcm_set_params(pcm, PCM_FORMAT_S16_LE, PCM_ACCESS_RW_INTERLEAVED, 2, rate, 1, 100000);
    if (r < 0) {
        snprintf(a->err, sizeof a->err, "%s: no 16-bit stereo at %u Hz: %s", dev, rate, A.strerror(r));
        A.pcm_close(pcm);
        return -1;
    }
    unsigned long buffer = 0, period = 0;
    if (A.pcm_get_params && A.pcm_get_params(pcm, &buffer, &period) == 0) a->buffer = buffer;
    a->pcm = pcm;
    log_info("sound: %s open, %u Hz stereo, buffer %lu frames, period %lu", dev, rate, buffer, period);
    return 0;
}

int audio_write(struct audio *a, const int16_t *pcm, int frames, int wait_ms)
{
    if (!a->pcm) return -1;
    int done = 0;
    double t0 = now_s();
    while (done < frames) {
        sframes r = A.pcm_writei(a->pcm, pcm + (size_t)done * 2, (unsigned long)(frames - done));
        if (r > 0) { done += (int)r; a->written += (uint64_t)r; a->stalled = 0; continue; }
        if (r == -EAGAIN || r == 0) {
            int left = wait_ms - (int)((now_s() - t0) * 1000);
            if (left <= 0) break;
            int w = A.pcm_wait(a->pcm, left < 100 ? left : 100);
            if (w < 0 && w != -EINTR && A.pcm_recover(a->pcm, w, 1) < 0) {
                snprintf(a->err, sizeof a->err, "%s: %s", a->dev, A.strerror(w));
                return -1;
            }
            continue;
        }
        /* an underrun (-EPIPE) or a suspend: start again */
        int e = A.pcm_recover(a->pcm, (int)r, 1);
        if (e < 0) { snprintf(a->err, sizeof a->err, "%s: %s", a->dev, A.strerror((int)r)); return -1; }
    }
    if (!done) a->stalled += now_s() - t0;
    return done;
}

double audio_delay(struct audio *a)
{
    sframes d = 0;
    if (!a->pcm || A.pcm_delay(a->pcm, &d) < 0 || d < 0) return 0;
    return (double)d / (double)a->rate;
}

void audio_drop(struct audio *a)
{
    if (!a->pcm) return;
    A.pcm_drop(a->pcm);
    A.pcm_prepare(a->pcm);
}

void audio_close(struct audio *a)
{
    if (a->pcm) {
        A.pcm_drop(a->pcm);
        A.pcm_close(a->pcm);
    }
    a->pcm = NULL;
}

static size_t add_name(char *out, size_t n, size_t k, const char *name, int *count)
{
    char q[200];
    if (k + strlen(name) + 8 >= n) return k;
    k += (size_t)snprintf(out + k, n - k, "%s%s", *count ? "," : "", json_quote(name, q, sizeof q));
    (*count)++;
    return k;
}

void audio_list(char *out, size_t n)
{
    size_t k = 0;
    int count = 0;
    if (n < 3) { if (n) out[0] = 0; return; }
    out[k++] = '[';
    out[k] = 0;
    if (load() == 0 && A.device_name_hint && A.device_name_get_hint && A.device_name_free_hint) {
        void **hints = NULL;
        if (A.device_name_hint(-1, "pcm", &hints) == 0 && hints) {
            for (void **h = hints; *h; h++) {
                char *name = A.device_name_get_hint(*h, "NAME");
                char *io = A.device_name_get_hint(*h, "IOID");
                /* outputs only (no IOID: both ways) */
                if (name && (!io || !strcmp(io, "Output")) && strcmp(name, "null")) k = add_name(out, n, k, name, &count);
                free(name);
                free(io);
            }
            A.device_name_free_hint(hints);
        }
    }
    /*
     * The head unit's stream devices are served by a plugin whose devices are not in the hints: each leaves a
     * lock file /run/smartx/<device>_p.lock once it has been opened by anyone (the car's own programs).
     */
    DIR *d = opendir("/run/smartx");
    if (d) {
        struct dirent *e;
        while ((e = readdir(d))) {
            size_t l = strlen(e->d_name);
            static const char suffix[] = "_p.lock";
            char name[160];
            if (l <= sizeof suffix - 1 || strcmp(e->d_name + l - (sizeof suffix - 1), suffix)) continue;
            snprintf(name, sizeof name, "smartx:%.*s", (int)(l - (sizeof suffix - 1)), e->d_name);
            k = add_name(out, n, k, name, &count);
        }
        closedir(d);
    }
    if (k + 2 < n) { out[k++] = ']'; out[k] = 0; }
}
