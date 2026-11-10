/* Small helpers shared by the player's files: time, logging, flat JSON. */
#ifndef YTPLAY_UTIL_H
#define YTPLAY_UTIL_H

#include <stddef.h>
#include <stdint.h>

#define YTPLAY_VERSION "0.1.0"
#define YTPLAY_PROTO 1

/* Monotonic seconds. */
double now_s(void);
void sleep_s(double s);

void logf_(const char *level, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
#define log_info(...) logf_("info", __VA_ARGS__)
#define log_warn(...) logf_("warn", __VA_ARGS__)
#define log_err(...) logf_("error", __VA_ARGS__)

/*
 * One flat JSON object per line: {"key": "text" | number | true | false | null, ...}.
 * Nested values are skipped. Keys are compared whole, at the top level only.
 */
int json_str(const char *line, const char *key, char *out, size_t n);       /* 1 found (a string), 0 not */
int json_num(const char *line, const char *key, double *out);               /* 1 found (a number or bool) */
int64_t json_i64(const char *line, const char *key, int64_t fallback);
/* s as a JSON string (with its quotes) into out; returns out. Bytes over 0x7f pass through (UTF-8). */
char *json_quote(const char *s, char *out, size_t n);

#endif
