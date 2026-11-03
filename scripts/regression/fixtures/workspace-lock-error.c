#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>
static int interrupted;
static int targeted(int fd) {
    char reference[64], path[4096];
    int n = snprintf(reference, sizeof(reference), "/proc/self/fd/%d", fd);
    if (n < 0 || (size_t)n >= sizeof(reference)) return 0;
    ssize_t count = readlink(reference, path, sizeof(path)-1);
    if (count < 0) return 0;
    path[count] = '\0';
    return strstr(path, "/xh-lock-fault-") != NULL;
}
int flock(int fd, int operation) {
    const char *mode = getenv("XHARNESS_LOCK_FAULT");
    if (mode && targeted(fd)) {
        int code = 0;
        if (!strcmp(mode, "busy")) code = EWOULDBLOCK;
        if (!strcmp(mode, "io")) code = EIO;
        if (!strcmp(mode, "unknown")) code = 300;
        if (!strcmp(mode, "interrupt")) code = EINTR;
        if (!strcmp(mode, "interrupt-once") && __sync_bool_compare_and_swap(&interrupted, 0, 1)) code = EINTR;
        if (code) { errno = code; return -1; }
    }
    int (*real_flock)(int, int) = dlsym(RTLD_NEXT, "flock");
    if (!real_flock) { errno = ENOSYS; return -1; }
    return real_flock(fd, operation);
}
