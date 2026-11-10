/*
 * hrybak-ytplay: the YouTube app's player. It decodes what the app downloads and writes the pictures to the
 * renderer's frame file; it has no network of its own. One app at a time talks to it over a Unix socket:
 * a control connection of JSON lines, and one more connection per media file the app is sending
 * (native/ytplay/README.md has the protocol).
 *
 * Started as root by its unit: root makes the socket and the frame file (the renderer takes a frame file
 * from root). It then gives root up before it reads a byte from anyone.
 */
#include "audio.h"
#include "frames.h"
#include "player.h"
#include "thumb.h"
#include "util.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <libavutil/log.h>

#define LINE_MAX_LEN 4096
#define PICTURE_MAX (4 << 20)       /* a thumbnail file, bytes */
#define DROP_AFTER_S 120.0

static struct {
    const char *socket_path;
    const char *frames_path;
    const char *group;
    unsigned uid, gid;
    int threads;
} cfg = { "/run/hrybak-ytplay/ctl.sock", "/dev/shm/mgu-video-hrybak-ytplay", "tm_oap_app", 3931, 3931, 0 };

static struct frames frames;
static struct session *ses;
static int ctl_fd = -1;
static int ctl_dead;
static pthread_mutex_t ctl_mu = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t quit;
static int dropped_root;

static void on_signal(int sig) { (void)sig; quit = 1; }

/* ---- the control connection's output ------------------------------------------------ */

static int write_all(int fd, const void *buf, size_t n)
{
    const uint8_t *p = buf;
    while (n) {
        ssize_t r = send(fd, p, n, MSG_NOSIGNAL);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

/* One line (and, for a picture, its bytes after it) to the app. */
static void emit_bin(const char *json, const void *bin, size_t len)
{
    pthread_mutex_lock(&ctl_mu);
    if (ctl_fd >= 0 && !ctl_dead) {
        if (write_all(ctl_fd, json, strlen(json)) < 0 || write_all(ctl_fd, "\n", 1) < 0 || (bin && write_all(ctl_fd, bin, len) < 0)) ctl_dead = 1;
    }
    pthread_mutex_unlock(&ctl_mu);
}

static void emit(void *ctx, const char *json) { (void)ctx; emit_bin(json, NULL, 0); }

/* ---- root, given up ------------------------------------------------------------------ */

static void add_gid(gid_t *list, int *n, int max, gid_t g)
{
    if (!g || *n >= max) return;
    for (int i = 0; i < *n; i++) if (list[i] == g) return;
    list[(*n)++] = g;
}

static void add_dir_gids(gid_t *list, int *n, int max, const char *dir, const char *prefix)
{
    struct stat st;
    if (!prefix && stat(dir, &st) == 0) add_gid(list, n, max, st.st_gid);
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        char p[512];
        if (e->d_name[0] == '.' || (prefix && strncmp(e->d_name, prefix, strlen(prefix)))) continue;
        snprintf(p, sizeof p, "%s/%s", dir, e->d_name);
        if (lstat(p, &st) == 0) add_gid(list, n, max, st.st_gid);
    }
    closedir(d);
}

/*
 * From root to an unprivileged uid with no account. It keeps the groups that own the unit's sound devices and
 * the sound plugin's files, so that sound can be tried (off unless the owner turns it on).
 */
static void drop_root(void)
{
    if (dropped_root) return;
    dropped_root = 1;
    if (geteuid() != 0 || !cfg.uid) return;
    gid_t groups[32];
    int n = 0;
    static const char *const names[] = { "audio", "ias_audio" };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        struct group *g = getgrnam(names[i]);
        if (g) add_gid(groups, &n, 32, g->gr_gid);
    }
    add_dir_gids(groups, &n, 32, "/dev/snd", NULL);
    add_dir_gids(groups, &n, 32, "/run/smartx", NULL);
    add_dir_gids(groups, &n, 32, "/dev/shm", "smartx");
    if (setgroups((size_t)n, groups) < 0 || setgid(cfg.gid) < 0 || setuid(cfg.uid) < 0 || getuid() == 0 || geteuid() == 0) {
        log_err("cannot give up root: %s", strerror(errno));
        exit(1);
    }
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    log_info("running as uid %u, %d sound groups kept", cfg.uid, n);
}

/* ---- commands ---------------------------------------------------------------------------- */

static void close_session(void)
{
    if (ses) session_close(ses);
    ses = NULL;
}

struct tone { char dev[128]; double db; int ms; };

static void *tone_main(void *arg)
{
    struct tone *t = arg;
    struct audio a;
    char line[512], q1[200], q2[260];
    unsigned long frames = 0;
    const unsigned rate = 48000;
    int ok = audio_open(&a, t->dev, rate) == 0;
    if (ok) {
        double gain = pow(10.0, (t->db > 0 ? 0 : t->db < -60 ? -60 : t->db) / 20.0);
        int total = (int)((double)rate * t->ms / 1000.0), done = 0;
        int16_t buf[960 * 2];
        double t0 = now_s();
        while (done < total && !quit) {
            int n = total - done > 960 ? 960 : total - done;
            for (int i = 0; i < n; i++) {
                /* 440 Hz, faded in and out over 50 ms */
                double k = (double)(done + i), edge = fmin(1.0, fmin(k, (double)total - k) / (rate * 0.05));
                int16_t v = (int16_t)(sin(k * 2.0 * M_PI * 440.0 / rate) * 32000.0 * gain * edge);
                buf[i * 2] = buf[i * 2 + 1] = v;
            }
            /* in real time: a device that takes everything at once would end the tone before it is heard */
            double lead = (double)done / rate - (now_s() - t0);
            if (lead > 0.2) { sleep_s(0.02); continue; }
            int r = audio_write(&a, buf, n, 200);
            if (r < 0) { ok = 0; break; }
            if (r == 0 && a.stalled > 2.0) { snprintf(a.err, sizeof a.err, "%.100s: nothing in the car reads it (it took no sound for 2 s)", t->dev); ok = 0; break; }
            done += r;
        }
        frames = (unsigned long)a.written;
        /* let the device play out what it holds */
        double d = audio_delay(&a);
        sleep_s(d > 0.5 ? 0.5 : d);
        audio_close(&a);
    }
    snprintf(line, sizeof line, "{\"ev\":\"tone\",\"device\":%s,\"ok\":%s,\"frames\":%lu,\"buffer\":%lu,\"err\":%s}",
        json_quote(t->dev, q1, sizeof q1), ok ? "true" : "false", frames, a.buffer, json_quote(ok ? "" : a.err, q2, sizeof q2));
    emit(NULL, line);
    free(t);
    return NULL;
}

static void handle_line(const char *line)
{
    char op[32], out[4096];
    double d;
    if (!json_str(line, "op", op, sizeof op)) return;
    if (!strcmp(op, "open")) {
        struct open_args a;
        memset(&a, 0, sizeof a);
        a.sid = (int)json_i64(line, "sid", 0);
        a.muxed = (int)json_i64(line, "muxed", 0);
        a.has_audio = (int)json_i64(line, "audio", 0);
        a.vsize = json_i64(line, "vsize", -1);
        a.asize = json_i64(line, "asize", -1);
        a.start = json_num(line, "start", &d) ? d : 0;
        a.gain_db = json_num(line, "gain", &d) ? d : -30;
        json_str(line, "device", a.audio_dev, sizeof a.audio_dev);
        close_session();
        struct player_cfg pc = { &frames, emit, NULL, cfg.threads };
        ses = session_open(&pc, &a);
        if (!ses) {
            snprintf(out, sizeof out, "{\"ev\":\"state\",\"sid\":%d,\"state\":\"error\",\"err\":\"out of memory\"}", a.sid);
            emit(NULL, out);
        }
    } else if (!strcmp(op, "close")) {
        if (ses && session_id(ses) == (int)json_i64(line, "sid", session_id(ses))) close_session();
    } else if (!strcmp(op, "pause")) {
        if (ses) session_pause(ses, (int)json_i64(line, "paused", 1));
    } else if (!strcmp(op, "seek")) {
        if (ses && json_num(line, "t", &d)) session_seek(ses, d);
    } else if (!strcmp(op, "gain")) {
        if (ses && json_num(line, "db", &d)) session_gain(ses, d);
    } else if (!strcmp(op, "status")) {
        if (ses && session_status(ses, out, sizeof out, 1)) emit(NULL, out);
        else if (!ses) emit(NULL, "{\"ev\":\"state\",\"sid\":0,\"state\":\"idle\"}");
    } else if (!strcmp(op, "devices")) {
        char list[3000];
        audio_list(list, sizeof list);
        snprintf(out, sizeof out, "{\"ev\":\"devices\",\"alsa\":%s,\"list\":%s}", audio_available() == 0 ? "true" : "false", list);
        emit(NULL, out);
    } else if (!strcmp(op, "tone")) {
        struct tone *t = calloc(1, sizeof *t);
        pthread_t th;
        pthread_attr_t at;
        if (!t) return;
        if (!json_str(line, "device", t->dev, sizeof t->dev) || !t->dev[0]) { free(t); return; }
        t->db = json_num(line, "db", &d) ? d : -30;
        t->ms = (int)json_i64(line, "ms", 3000);
        if (t->ms < 100) t->ms = 100;
        if (t->ms > 10000) t->ms = 10000;
        pthread_attr_init(&at);
        pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
        if (pthread_create(&th, &at, tone_main, t) != 0) free(t);
        pthread_attr_destroy(&at);
    }
}

/* A picture's bytes are all here: decode, answer with the pixels. */
static void handle_picture(const char *head, const uint8_t *data, size_t len)
{
    char out[400], err[120] = "", q[160];
    long id = (long)json_i64(head, "id", 0);
    int w = (int)json_i64(head, "w", 0), h = (int)json_i64(head, "h", 0);
    uint8_t *px = thumb_decode(data, len, w, h, err, sizeof err);
    if (px) {
        snprintf(out, sizeof out, "{\"ev\":\"picture\",\"id\":%ld,\"ok\":true,\"w\":%d,\"h\":%d,\"len\":%zu}", id, w, h, (size_t)w * (size_t)h * 4);
        emit_bin(out, px, (size_t)w * (size_t)h * 4);
        free(px);
    } else {
        snprintf(out, sizeof out, "{\"ev\":\"picture\",\"id\":%ld,\"ok\":false,\"err\":%s}", id, json_quote(err, q, sizeof q));
        emit(NULL, out);
    }
}

/* ---- connections ------------------------------------------------------------------------- */

/* The first line of a new connection, read a byte at a time so nothing after it is taken. */
static int read_first_line(int fd, char *line, size_t n)
{
    size_t k = 0;
    double t0 = now_s();
    while (k + 1 < n) {
        struct pollfd p = { fd, POLLIN, 0 };
        if (now_s() - t0 > 2.0) return -1;
        if (poll(&p, 1, 200) <= 0) continue;
        char c;
        ssize_t r = recv(fd, &c, 1, 0);
        if (r <= 0) return -1;
        if (c == '\n') { line[k] = 0; return 0; }
        line[k++] = c;
    }
    return -1;
}

static char inbuf[LINE_MAX_LEN];
static size_t inlen;
static char pic_head[LINE_MAX_LEN];
static uint8_t *pic;
static size_t pic_want, pic_have;

static void ctl_close(void)
{
    pthread_mutex_lock(&ctl_mu);
    if (ctl_fd >= 0) close(ctl_fd);
    ctl_fd = -1;
    ctl_dead = 0;
    pthread_mutex_unlock(&ctl_mu);
    close_session();
    free(pic);
    pic = NULL;
    pic_want = pic_have = inlen = 0;
}

static void ctl_bytes(const uint8_t *p, size_t n)
{
    while (n) {
        if (pic_want) {
            size_t k = pic_want - pic_have < n ? pic_want - pic_have : n;
            memcpy(pic + pic_have, p, k);
            pic_have += k; p += k; n -= k;
            if (pic_have == pic_want) {
                handle_picture(pic_head, pic, pic_want);
                free(pic);
                pic = NULL;
                pic_want = pic_have = 0;
            }
            continue;
        }
        char c = (char)*p++;
        n--;
        if (c != '\n') {
            if (inlen + 1 < sizeof inbuf) inbuf[inlen++] = c;
            else { log_warn("a line over %d bytes from the app: connection closed", LINE_MAX_LEN); ctl_dead = 1; return; }
            continue;
        }
        inbuf[inlen] = 0;
        inlen = 0;
        char op[32];
        if (json_str(inbuf, "op", op, sizeof op) && !strcmp(op, "decode")) {
            int64_t len = json_i64(inbuf, "len", 0);
            if (len < 1 || len > PICTURE_MAX || !(pic = malloc((size_t)len))) { log_warn("picture of %lld bytes refused", (long long)len); ctl_dead = 1; return; }
            memcpy(pic_head, inbuf, sizeof pic_head);
            pic_want = (size_t)len;
            pic_have = 0;
        } else handle_line(inbuf);
    }
}

static void accept_one(int lfd)
{
    int fd = accept4(lfd, NULL, NULL, SOCK_CLOEXEC);
    if (fd < 0) return;
    /* from here on bytes from others are read: never as root */
    drop_root();
    char line[512], op[32], out[512], q[200];
    if (read_first_line(fd, line, sizeof line) < 0 || !json_str(line, "op", op, sizeof op)) { close(fd); return; }
    if (!strcmp(op, "data")) {
        char stream[16] = "";
        json_str(line, "stream", stream, sizeof stream);
        if (!ses || session_id(ses) != (int)json_i64(line, "sid", -1)) { close(fd); return; }
        session_attach(ses, stream, fd, (uint32_t)json_i64(line, "req", 0), json_i64(line, "off", 0), json_i64(line, "size", -1));
        return;
    }
    if (strcmp(op, "hello")) { close(fd); return; }
    /* a new app connection takes the place of the one before */
    ctl_close();
    struct timeval tv = { 3, 0 };
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    pthread_mutex_lock(&ctl_mu);
    ctl_fd = fd;
    ctl_dead = 0;
    pthread_mutex_unlock(&ctl_mu);
    snprintf(out, sizeof out, "{\"ev\":\"hello\",\"proto\":%d,\"version\":\"%s\",\"video\":%s,\"alsa\":%s}", YTPLAY_PROTO, YTPLAY_VERSION,
        json_quote(cfg.frames_path, q, sizeof q), audio_available() == 0 ? "true" : "false");
    emit(NULL, out);
}

static int listen_socket(void)
{
    struct sockaddr_un sa;
    char dir[200];
    if (strlen(cfg.socket_path) >= sizeof sa.sun_path) { log_err("socket path too long"); return -1; }
    snprintf(dir, sizeof dir, "%s", cfg.socket_path);
    char *slash = strrchr(dir, '/');
    if (slash && slash != dir) {
        *slash = 0;
        if (mkdir(dir, 0755) < 0 && errno != EEXIST) { log_err("%s: %s", dir, strerror(errno)); return -1; }
    }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", cfg.socket_path);
    unlink(cfg.socket_path);
    if (bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, 8) < 0) {
        log_err("%s: %s", cfg.socket_path, strerror(errno));
        close(fd);
        return -1;
    }
    /* the apps' group may connect, nobody else */
    struct group *g = getgrnam(cfg.group);
    if (geteuid() == 0 && g && chown(cfg.socket_path, 0, g->gr_gid) == 0) chmod(cfg.socket_path, 0660);
    else {
        if (geteuid() == 0) log_warn("no group %s here: the socket is open to every local user", cfg.group);
        chmod(cfg.socket_path, 0666);
    }
    return fd;
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(a, "--socket") && v) { cfg.socket_path = v; i++; }
        else if (!strcmp(a, "--frames") && v) { cfg.frames_path = v; i++; }
        else if (!strcmp(a, "--group") && v) { cfg.group = v; i++; }
        else if (!strcmp(a, "--uid") && v) { cfg.uid = cfg.gid = (unsigned)strtoul(v, NULL, 10); i++; }
        else if (!strcmp(a, "--threads") && v) { cfg.threads = atoi(v); i++; }
        else if (!strcmp(a, "--version")) { printf("hrybak-ytplay %s (protocol %d)\n", YTPLAY_VERSION, YTPLAY_PROTO); return 0; }
        else {
            fprintf(stderr, "usage: hrybak-ytplay [--socket PATH] [--frames /dev/shm/mgu-video-NAME] [--group NAME] [--uid N] [--threads N]\n");
            return 2;
        }
    }
    /* the decoders' own chatter stays out of the journal */
    av_log_set_level(AV_LOG_ERROR);
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    /* no core dump goes to the head unit's crash handler (a limit of 1 byte: the kernel pipes none) */
    struct rlimit rl = { 1, 1 };
    setrlimit(RLIMIT_CORE, &rl);

    int lfd = listen_socket();
    if (lfd < 0) return 1;
    if (frames_init(&frames, cfg.frames_path) < 0) { log_err("%s: %s", cfg.frames_path, strerror(errno)); return 1; }
    log_info("hrybak-ytplay %s: socket %s, frames %s", YTPLAY_VERSION, cfg.socket_path, cfg.frames_path);

    double started = now_s();
    while (!quit) {
        struct pollfd p[2] = { { lfd, POLLIN, 0 }, { ctl_fd, POLLIN, 0 } };
        int n = poll(p, ctl_fd >= 0 ? 2 : 1, 250);
        if (n < 0 && errno != EINTR) break;
        if (!dropped_root && now_s() - started > DROP_AFTER_S) drop_root();
        if (n > 0 && (p[0].revents & POLLIN)) accept_one(lfd);
        if (n > 0 && ctl_fd >= 0 && p[1].fd == ctl_fd && (p[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            uint8_t buf[65536];
            ssize_t r = recv(ctl_fd, buf, sizeof buf, MSG_DONTWAIT);
            if (r > 0) ctl_bytes(buf, (size_t)r);
            else if (r == 0 || (errno != EAGAIN && errno != EINTR)) ctl_dead = 1;
        }
        if (ctl_dead) { log_info("the app's connection ended"); ctl_close(); }
        if (ses) {
            char st[1024];
            if (session_status(ses, st, sizeof st, 0)) emit(NULL, st);
        }
    }
    ctl_close();
    frames_close(&frames, 1);
    close(lfd);
    unlink(cfg.socket_path);
    return 0;
}
