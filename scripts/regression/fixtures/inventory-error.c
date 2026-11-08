#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Fault injection only into the isolated inventory acceptance executable. */
static int read_fired;
static int open_fired;
static int close_fired;

static int targeted(int fd) {
    char reference[64], path[4096];
    int length = snprintf(reference, sizeof(reference), "/proc/self/fd/%d", fd);
    if (length < 0 || (size_t)length >= sizeof(reference)) return 0;
    ssize_t count = readlink(reference, path, sizeof(path) - 1);
    if (count < 0) return 0;
    path[count] = '\0';
    return strstr(path, "/xh-inventory-fault") != NULL;
}
static int reading_fault(DIR *directory) {
    const char *mode = getenv("XHARNESS_DIR_FAULT");
    if (!mode || !targeted(dirfd(directory))) return 0;
    int code = 0;
    if (!strcmp(mode, "read") || !strcmp(mode, "read-close")) code = EIO;
    if (!strcmp(mode, "permission")) code = EACCES;
    if (!strcmp(mode, "unknown")) code = 300;
    if (code && __sync_bool_compare_and_swap(&read_fired, 0, 1)) {
        errno = code;
        return 1;
    }
    return 0;
}
DIR *fdopendir(int fd) {
    const char *mode = getenv("XHARNESS_DIR_FAULT");
    if (mode && !strcmp(mode, "open") && targeted(fd)
        && __sync_bool_compare_and_swap(&open_fired, 0, 1)) {
        errno = ENOMEM;
        return NULL;
    }
    DIR *(*real_open)(int) = dlsym(RTLD_NEXT, "fdopendir");
    if (!real_open) { errno = ENOSYS; return NULL; }
    return real_open(fd);
}
struct dirent *readdir(DIR *directory) {
    if (reading_fault(directory)) return NULL;
    struct dirent *(*real_read)(DIR *) = dlsym(RTLD_NEXT, "readdir");
    if (!real_read) { errno = ENOSYS; return NULL; }
    return real_read(directory);
}
struct dirent64 *readdir64(DIR *directory) {
    if (reading_fault(directory)) return NULL;
    struct dirent64 *(*real_read)(DIR *) = dlsym(RTLD_NEXT, "readdir64");
    if (!real_read) { errno = ENOSYS; return NULL; }
    return real_read(directory);
}
int closedir(DIR *directory) {
    const char *mode = getenv("XHARNESS_DIR_FAULT");
    int inject = mode && (!strcmp(mode, "close") || !strcmp(mode, "read-close"))
        && targeted(dirfd(directory)) && __sync_bool_compare_and_swap(&close_fired, 0, 1);
    int (*real_close)(DIR *) = dlsym(RTLD_NEXT, "closedir");
    if (!real_close) { errno = ENOSYS; return -1; }
    int result = real_close(directory);
    /* Simulate an ambiguous cleanup failure AFTER actually releasing the fd.
       The adapter must report failure and must never retry closing a reused fd. */
    if (inject) { errno = EIO; return -1; }
    return result;
}
