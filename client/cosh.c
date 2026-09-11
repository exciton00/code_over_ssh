/* cosh — Code Over SSH client
 *
 * Sends a file path to a Code Over SSH extension host registered under
 * $HOME/.code_over_ssh (override with $COSH_STATE_DIR) and makes that
 * user's VS Code window open the file.
 *
 * The state dir, token and sockets are owned by the current Unix user
 * (created 0700/0600 by the extension), so on a shared server each user
 * only ever reaches their own VS Code windows.
 *
 * Usage:
 *   cosh <path>              open in the freshest (most recently active) window
 *   cosh --all <path>        open in every registered window
 *   cosh --host <hostid> ... target one specific host
 *   cosh --list              list registered hosts and exit
 *   cosh --timeout <sec> ... socket timeout (default 3)
 *   cosh --state-dir <dir>   override state directory
 *
 * Exit codes: 0 = opened (at least one host succeeded)
 *             1 = all attempts failed (protocol/file errors)
 *             2 = no host registered / usage error
 */
#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_HOSTS   64
#define PATH_LIMIT  4096
#define TOKEN_LIMIT 128
#define DEFAULT_TIMEOUT_SEC 3
#define BIG 4352

typedef struct {
    long pid;
    long heartbeat;
    char hostid[128];
    char socket[300];
    char label[256];
} Host;

static void die(const char *msg, int code)
{
    fprintf(stderr, "cosh: %s\n", msg);
    exit(code);
}

static char *read_whole_file(const char *path, size_t *len_out)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char *buf = NULL;
    size_t cap = 0, len = 0;
    int c;
    while ((c = fgetc(f)) != EOF) {
        if (len + 2 >= cap) {
            cap = cap ? cap * 2 : 4096;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); fclose(f); return NULL; }
            buf = nb;
        }
        buf[len++] = (char)c;
    }
    fclose(f);
    if (len_out) *len_out = len;
    return buf;
}

/* Extract a string field from the (small, flat, self-generated) registry
 * JSON. Only unescapes the sequences JSON.stringify can emit for our data. */
static void json_str(const char *json, const char *key, char *out, size_t outsz)
{
    if (outsz) out[0] = '\0';
    char needle[64];
    snprintf(needle, sizeof needle, "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return;
    p = strchr(p + strlen(needle), ':');
    if (!p) return;
    p = strchr(p, '"');
    if (!p) return;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < outsz) {
        if (*p == '\\' && p[1]) {
            p++;
            switch (*p) {
            case 'n':  out[i++] = '\n'; break;
            case 't':  out[i++] = '\t'; break;
            case 'r':  out[i++] = '\r'; break;
            case '"':  out[i++] = '"';  break;
            case '\\': out[i++] = '\\'; break;
            case '/':  out[i++] = '/';  break;
            case 'b':  out[i++] = '\b'; break;
            case 'f':  out[i++] = '\f'; break;
            default:   out[i++] = *p;
            }
            p++; /* advance past the escaped character */
        } else {
            out[i++] = *p++;
        }
    }
    out[i] = '\0';
}

static long json_long(const char *json, const char *key, long dflt)
{
    char needle[64];
    snprintf(needle, sizeof needle, "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return dflt;
    p = strchr(p + strlen(needle), ':');
    if (!p) return dflt;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    return strtol(p, NULL, 10);
}

static void b64encode(const unsigned char *in, size_t len, char *out)
{
    static const char T[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t i, o = 0;
    for (i = 0; i + 2 < len; i += 3) {
        out[o++] = T[in[i] >> 2];
        out[o++] = T[((in[i] & 3) << 4) | (in[i + 1] >> 4)];
        out[o++] = T[((in[i + 1] & 15) << 2) | (in[i + 2] >> 6)];
        out[o++] = T[in[i + 2] & 63];
    }
    if (i < len) {
        out[o++] = T[in[i] >> 2];
        if (i + 1 < len) {
            out[o++] = T[((in[i] & 3) << 4) | (in[i + 1] >> 4)];
            out[o++] = T[(in[i + 1] & 15) << 2];
            out[o++] = '=';
        } else {
            out[o++] = T[(in[i] & 3) << 4];
            out[o++] = '=';
            out[o++] = '=';
        }
    }
    out[o] = '\0';
}

static int load_hosts(const char *state_dir, Host *hosts, int *n_out)
{
    char dir[BIG];
    int n = 0;
    int rl = snprintf(dir, sizeof dir, "%s/hosts", state_dir);
    if (rl < 0 || (size_t)rl >= sizeof dir) { *n_out = 0; return 0; }
    DIR *d = opendir(dir);
    if (!d) { *n_out = 0; return 0; }
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n < MAX_HOSTS) {
        size_t len = strlen(e->d_name);
        if (len < 6 || strcmp(e->d_name + len - 5, ".json") != 0) continue;
        char path[BIG];
        rl = snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
        if (rl < 0 || (size_t)rl >= sizeof path) continue;
        char *buf = read_whole_file(path, NULL);
        if (!buf) continue;
        Host *h = &hosts[n];
        memset(h, 0, sizeof *h);
        h->pid = json_long(buf, "pid", 0);
        h->heartbeat = json_long(buf, "heartbeat", 0);
        json_str(buf, "hostId", h->hostid, sizeof h->hostid);
        json_str(buf, "socket", h->socket, sizeof h->socket);
        json_str(buf, "label", h->label, sizeof h->label);
        if (h->socket[0]) n++;
        free(buf);
    }
    closedir(d);
    /* sort freshest first */
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (hosts[j].heartbeat > hosts[i].heartbeat) {
                Host tmp = hosts[i]; hosts[i] = hosts[j]; hosts[j] = tmp;
            }
    *n_out = n;
    return 1;
}

/* Read one line (terminated by '\n') from fd. Returns 1 on success,
 * 0 on EOF / timeout / error. */
static int read_line(int fd, const char *hostid, char *out, size_t outsz)
{
    size_t n = 0;
    for (;;) {
        char c;
        ssize_t r = recv(fd, &c, 1, 0);
        if (r == 0) return 0;
        if (r < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
            fprintf(stderr, "cosh: host %s: recv: %s\n", hostid, strerror(errno));
            return 0;
        }
        if (c == '\n') break;
        if (n + 1 < outsz) out[n++] = c;
    }
    out[n] = '\0';
    return 1;
}

static int send_all(int fd, const char *hostid, const char *buf)
{
    size_t off = 0, len = strlen(buf);
    while (off < len) {
        ssize_t w = send(fd, buf + off, len - off, 0);
        if (w < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "cosh: host %s: send: %s\n", hostid, strerror(errno));
            return 0;
        }
        off += (size_t)w;
    }
    return 1;
}

/*
 * Try to open `path` on one host.
 * Returns:  1 success
 *           0 transport failure (connect/timeout) — caller may try next host
 *          -1 protocol/file error (message printed) — caller may still try next
 */
static int try_host(const Host *h, const char *token, const char *path,
                    int timeout_sec)
{
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    if (strlen(h->socket) >= sizeof addr.sun_path) {
        fprintf(stderr, "cosh: host %s: socket path too long\n", h->hostid);
        return 0;
    }
    addr.sun_family = AF_UNIX; /* Linux requires the family to be set explicitly */
    strcpy(addr.sun_path, h->socket);

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        fprintf(stderr, "cosh: socket: %s\n", strerror(errno));
        return 0;
    }
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        fprintf(stderr, "cosh: host %s: connect %s: %s\n",
                h->hostid, h->socket, strerror(errno));
        close(fd);
        return 0;
    }

    struct timeval tv;
    tv.tv_sec = timeout_sec;
    tv.tv_usec = 0;
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv) != 0) {
        fprintf(stderr, "cosh: setsockopt: %s\n", strerror(errno));
        close(fd);
        return 0;
    }

    char line[65536];

    char hello[TOKEN_LIMIT + 32];
    snprintf(hello, sizeof hello, "COSH/1 %s\n", token);
    if (!send_all(fd, h->hostid, hello)) { close(fd); return 0; }

    if (!read_line(fd, h->hostid, line, sizeof line) || strcmp(line, "OK") != 0) {
        fprintf(stderr, "cosh: host %s: %s\n", h->hostid, line[0] ? line : "no reply");
        close(fd);
        return -1;
    }

    char b64[PATH_LIMIT * 4 / 3 + 8];
    b64encode((const unsigned char *)path, strlen(path), b64);
    char req[sizeof("OPEN ") + PATH_LIMIT * 4 / 3 + 16];
    snprintf(req, sizeof req, "OPEN %s\n", b64);
    if (!send_all(fd, h->hostid, req)) { close(fd); return 0; }

    if (!read_line(fd, h->hostid, line, sizeof line)) {
        fprintf(stderr, "cosh: host %s: no reply (timeout?)\n", h->hostid);
        close(fd);
        return 0;
    }
    if (strncmp(line, "OK ", 3) == 0) {
        printf("host %s: opened %s (%s)\n", h->hostid, path, h->label);
        close(fd);
        return 1;
    }
    fprintf(stderr, "cosh: host %s: %s\n", h->hostid, line);
    close(fd);
    return -1;
}

#ifndef COSH_UNIT_TEST
int main(int argc, char **argv)
{
    int timeout_sec = DEFAULT_TIMEOUT_SEC;
    int do_list = 0;
    int do_all = 0;
    const char *want_host = NULL;
    const char *state_dir = NULL;
    const char *path = NULL;

    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--list") == 0) do_list = 1;
        else if (strcmp(a, "--all") == 0) do_all = 1;
        else if (strcmp(a, "--host") == 0) {
            if (++i >= argc) die("--host needs a value", 2);
            want_host = argv[i];
        } else if (strcmp(a, "--timeout") == 0) {
            if (++i >= argc) die("--timeout needs a value", 2);
            timeout_sec = atoi(argv[i]);
            if (timeout_sec < 1) timeout_sec = 1;
        } else if (strcmp(a, "--state-dir") == 0) {
            if (++i >= argc) die("--state-dir needs a value", 2);
            state_dir = argv[i];
        } else if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0) {
            fprintf(stderr,
                "usage: cosh [--list] [--all] [--host HOSTID] [--timeout SEC]\n"
                "             [--state-dir DIR] <path>\n");
            return 2;
        } else if (a[0] == '-' && a[1]) {
            die("unknown option", 2);
        } else {
            if (path) die("only one path argument", 2);
            path = a;
        }
    }

    static char def_dir[BIG];
    if (!state_dir) {
        state_dir = getenv("COSH_STATE_DIR");
        if (!state_dir || !*state_dir) {
            const char *home = getenv("HOME");
            if (!home || !*home) die("no $HOME and no --state-dir", 2);
            int rl = snprintf(def_dir, sizeof def_dir, "%s/.code_over_ssh", home);
            if (rl < 0 || (size_t)rl >= sizeof def_dir) die("path too long", 2);
            state_dir = def_dir;
        }
    }

    char token_file[BIG];
    {
        int rl = snprintf(token_file, sizeof token_file, "%s/token", state_dir);
        if (rl < 0 || (size_t)rl >= sizeof token_file) die("path too long", 2);
    }
    char *tokbuf = read_whole_file(token_file, NULL);
    if (!tokbuf) {
        fprintf(stderr,
            "cosh: no Code Over SSH state dir at %s\n"
            "Is a VS Code window connected to this machine via SSH as user %s?\n",
            state_dir, getenv("USER") ? getenv("USER") : "(unknown)");
        return 2;
    }
    char token[TOKEN_LIMIT];
    {
        size_t i = 0;
        for (; tokbuf[i] && tokbuf[i] != '\n' && tokbuf[i] != ' ' && i + 1 < sizeof token; i++)
            token[i] = tokbuf[i];
        token[i] = '\0';
        free(tokbuf);
    }

    Host hosts[MAX_HOSTS];
    int n = 0;
    load_hosts(state_dir, hosts, &n);

    if (do_list) {
        if (n == 0) {
            printf("no registered hosts under %s\n", state_dir);
            return 2;
        }
        printf("%-24s %-8s %12s  %s\n", "HOSTID", "PID", "HEARTBEAT", "LABEL");
        for (int i = 0; i < n; i++)
            printf("%-24s %-8ld %12ld  %s\n",
                   hosts[i].hostid, hosts[i].pid, hosts[i].heartbeat, hosts[i].label);
        return 0;
    }

    if (!path) {
        fprintf(stderr, "usage: cosh [--list] [--all] [--host HOSTID] <path>\n");
        return 2;
    }
    if (strlen(path) > PATH_LIMIT) die("path too long", 2);

    if (n == 0) {
        fprintf(stderr,
            "cosh: no registered hosts under %s\n"
            "Is a VS Code window connected to this machine via SSH as this user?\n",
            state_dir);
        return 2;
    }

    int succeeded = 0;
    int failed = 0;
    for (int i = 0; i < n; i++) {
        if (want_host && strcmp(hosts[i].hostid, want_host) != 0) continue;
        int r = try_host(&hosts[i], token, path, timeout_sec);
        if (r == 1) {
            succeeded++;
            if (!do_all) break;
        } else if (r == -1) {
            failed++;
        }
        if (want_host && r != 1) {
            /* explicit host was specified: do not fall through to others */
            break;
        }
    }
    if (succeeded) return 0;
    if (failed) return 1;
    fprintf(stderr, "cosh: could not reach any registered host\n");
    return 1;
}
#endif /* COSH_UNIT_TEST */
