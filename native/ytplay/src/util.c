#include "util.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

double now_s(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

void sleep_s(double s)
{
    if (s <= 0) return;
    struct timespec ts = { (time_t)s, (long)((s - (double)(time_t)s) * 1e9) };
    while (nanosleep(&ts, &ts) < 0 && errno == EINTR) { }
}

void logf_(const char *level, const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    /* stderr: the journal under systemd */
    fprintf(stderr, "ytplay %s: %s\n", level, buf);
    fflush(stderr);
}

/* ---- JSON ---------------------------------------------------------------- */

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/* p at the opening quote: the string's text into out (when out != NULL); returns the char after the closing quote, NULL when malformed. */
static const char *read_string(const char *p, char *out, size_t n)
{
    size_t k = 0;
    if (*p != '"') return NULL;
    p++;
    while (*p && *p != '"') {
        unsigned c = (unsigned char)*p++;
        if (c == '\\') {
            char e = *p++;
            switch (e) {
            case 'n': c = '\n'; break;
            case 't': c = '\t'; break;
            case 'r': c = '\r'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'u': {
                unsigned v = 0;
                for (int i = 0; i < 4; i++) {
                    char h = *p;
                    if (!isxdigit((unsigned char)h)) return NULL;
                    v = v * 16 + (unsigned)(isdigit((unsigned char)h) ? h - '0' : (tolower((unsigned char)h) - 'a' + 10));
                    p++;
                }
                /* (no surrogate pairs: the protocol's strings are paths, device names and words) */
                if (v < 0x80) c = v;
                else if (v < 0x800) {
                    if (out && k + 1 < n) out[k] = (char)(0xc0 | (v >> 6));
                    k++;
                    c = 0x80 | (v & 0x3f);
                } else {
                    if (out && k + 1 < n) out[k] = (char)(0xe0 | (v >> 12));
                    k++;
                    if (out && k + 1 < n) out[k] = (char)(0x80 | ((v >> 6) & 0x3f));
                    k++;
                    c = 0x80 | (v & 0x3f);
                }
                break;
            }
            case 0: return NULL;
            default: c = (unsigned char)e; break;      /* \" \\ \/ */
            }
        }
        if (out && k + 1 < n) out[k] = (char)c;
        k++;
    }
    if (*p != '"') return NULL;
    if (out && n) out[k < n ? k : n - 1] = 0;
    return p + 1;
}

/* p at a value: the char after it, NULL when malformed. */
static const char *skip_value(const char *p)
{
    p = skip_ws(p);
    if (*p == '"') return read_string(p, NULL, 0);
    if (*p == '{' || *p == '[') {
        int depth = 0;
        while (*p) {
            if (*p == '"') {
                p = read_string(p, NULL, 0);
                if (!p) return NULL;
                continue;
            }
            if (*p == '{' || *p == '[') depth++;
            else if (*p == '}' || *p == ']') {
                if (--depth == 0) return p + 1;
            }
            p++;
        }
        return NULL;
    }
    while (*p && *p != ',' && *p != '}' && *p != ']' && !isspace((unsigned char)*p)) p++;
    return p;
}

/* The value of key in the top-level object: a pointer to its first char, NULL when absent. */
static const char *find_value(const char *line, const char *key)
{
    const char *p = skip_ws(line);
    char name[64];
    if (*p != '{') return NULL;
    p++;
    for (;;) {
        p = skip_ws(p);
        if (*p == '}' || !*p) return NULL;
        p = read_string(p, name, sizeof name);
        if (!p) return NULL;
        p = skip_ws(p);
        if (*p != ':') return NULL;
        p = skip_ws(p + 1);
        if (!strcmp(name, key)) return p;
        p = skip_value(p);
        if (!p) return NULL;
        p = skip_ws(p);
        if (*p == ',') p++;
    }
}

int json_str(const char *line, const char *key, char *out, size_t n)
{
    const char *v = find_value(line, key);
    if (!v || *v != '"') return 0;
    return read_string(v, out, n) != NULL;
}

int json_num(const char *line, const char *key, double *out)
{
    const char *v = find_value(line, key);
    char *end;
    if (!v) return 0;
    if (!strncmp(v, "true", 4)) { *out = 1; return 1; }
    if (!strncmp(v, "false", 5)) { *out = 0; return 1; }
    if (*v != '-' && !isdigit((unsigned char)*v)) return 0;
    *out = strtod(v, &end);
    return end != v;
}

int64_t json_i64(const char *line, const char *key, int64_t fallback)
{
    double d;
    return json_num(line, key, &d) ? (int64_t)d : fallback;
}

char *json_quote(const char *s, char *out, size_t n)
{
    size_t k = 0;
    if (n < 3) { if (n) out[0] = 0; return out; }
    out[k++] = '"';
    for (; *s && k + 8 < n; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { out[k++] = '\\'; out[k++] = (char)c; }
        else if (c == '\n') { out[k++] = '\\'; out[k++] = 'n'; }
        else if (c < 0x20) k += (size_t)snprintf(out + k, n - k, "\\u%04x", c);
        else out[k++] = (char)c;
    }
    out[k++] = '"';
    out[k] = 0;
    return out;
}
