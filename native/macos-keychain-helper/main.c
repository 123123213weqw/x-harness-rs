// Immutable, opt-in local Keychain caller. Build/install separately from the app.
// No socket, shell, password arguments, plaintext storage, or arbitrary queries.
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/resource.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }

#define MAX_SECRET 65536
#define HELPER_ID "com.xlang.xharness.keychain-helper"

static int valid_service(const char *s) {
    const char *p = NULL;
    const char models[] = "com.xlang.xharness.models.";
    const char channels[] = "com.xlang.xharness.channels.";
    if (!strncmp(s, models, sizeof(models)-1)) p = s + sizeof(models)-1;
    else if (!strncmp(s, channels, sizeof(channels)-1)) p = s + sizeof(channels)-1;
    if (!p || strlen(p) != 64) return 0;
    for (; *p; ++p) if (!(*p >= '0' && *p <= '9') && !(*p >= 'a' && *p <= 'f')) return 0;
    return 1;
}
static int valid_reference(const char *s) {
    size_t n = strlen(s);
    if (!n || n > 128 || !((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || *s == '_')) return 0;
    for (; *s; ++s) if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') || *s == '_')) return 0;
    return 1;
}
// Dynamic validation checks the actual direct parent, not a user-provided PID
// or an on-disk executable path. Pin the caller to THIS helper's signing cert.
static int trusted_parent(void) {
    int ok = 0; SecCodeRef self = NULL, parent = NULL; SecRequirementRef req = NULL;
    CFDictionaryRef info = NULL; CFDataRef der = NULL; CFStringRef text = NULL;
    CFDictionaryRef attrs = NULL; CFNumberRef pid_value = NULL;
    pid_t pid = getppid();
    if (pid <= 1 || SecCodeCopySelf(kSecCSDefaultFlags, &self)) goto out;
    if (SecCodeCopySigningInformation(self, kSecCSSigningInformation, &info)) goto out;
    CFStringRef ident = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
    if (!ident || !CFEqual(ident, CFSTR(HELPER_ID))) goto out;
    CFArrayRef certs = CFDictionaryGetValue(info, kSecCodeInfoCertificates);
    if (!certs || CFArrayGetCount(certs) < 1) goto out; // never accept ad-hoc helper
    der = SecCertificateCopyData((SecCertificateRef)CFArrayGetValueAtIndex(certs, 0));
    if (!der) goto out;
    unsigned char hash[CC_SHA1_DIGEST_LENGTH]; char hex[41];
    CC_SHA1(CFDataGetBytePtr(der), (CC_LONG)CFDataGetLength(der), hash);
    for (size_t i = 0; i < sizeof(hash); ++i) snprintf(hex + 2*i, 3, "%02x", hash[i]);
    text = CFStringCreateWithFormat(NULL, NULL,
        CFSTR("(identifier \"xharness-host\" or identifier \"com.xlang.xharness.host\") and certificate leaf = H\"%s\""), hex);
    if (!text || SecRequirementCreateWithString(text, kSecCSDefaultFlags, &req)) goto out;
    pid_value = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    const void *keys[] = { kSecGuestAttributePid }; const void *values[] = { pid_value };
    attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!attrs || SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &parent)) goto out;
    if (SecCodeCheckValidity(parent, kSecCSDefaultFlags, req)) goto out;
    ok = getppid() == pid; // don't grant after the requesting Host has disappeared
out:
    if (attrs) CFRelease(attrs); if (pid_value) CFRelease(pid_value);
    if (text) CFRelease(text); if (req) CFRelease(req); if (der) CFRelease(der);
    if (info) CFRelease(info); if (parent) CFRelease(parent); if (self) CFRelease(self);
    return ok;
}
static int run(const char *action, const char *service, const char *reference) {
    SecKeychainRef kc = NULL; SecKeychainItemRef item = NULL;
    UInt32 old_len = 0; void *old_data = NULL; OSStatus rc;
    if (SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &kc)) return 1;
    rc = SecKeychainFindGenericPassword(kc, (UInt32)strlen(service), service,
        (UInt32)strlen(reference), reference, &old_len, &old_data, &item);
    if (!strcmp(action, "get")) {
        if (rc == errSecSuccess && old_len <= MAX_SECRET) {
            if (old_len && fwrite(old_data, 1, old_len, stdout) != old_len) rc = errSecIO;
        } else if (rc == errSecSuccess) rc = errSecDecode;
    } else if (!strcmp(action, "set")) {
        unsigned char buf[MAX_SECRET + 1]; size_t len = fread(buf, 1, sizeof(buf), stdin);
        if (ferror(stdin) || len == 0 || len > MAX_SECRET) rc = errSecParam;
        else if (rc == errSecSuccess) rc = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)len, buf);
        else if (rc == errSecItemNotFound) rc = SecKeychainAddGenericPassword(kc,
            (UInt32)strlen(service), service, (UInt32)strlen(reference), reference, (UInt32)len, buf, NULL);
        wipe(buf, sizeof(buf));
    } else if (!strcmp(action, "delete") && rc == errSecSuccess) rc = SecKeychainItemDelete(item);
    if (old_data) { wipe(old_data, old_len); SecKeychainItemFreeContent(NULL, old_data); }
    if (item) CFRelease(item); CFRelease(kc);
    if (fflush(stdout)) return 1;
    return rc == errSecSuccess ? 0 : rc == errSecItemNotFound ? 3 : 1;
}
int main(int argc, char **argv) {
    struct rlimit core = {0, 0}; setrlimit(RLIMIT_CORE, &core);
    if (argc != 4 || (strcmp(argv[1], "get") && strcmp(argv[1], "set") && strcmp(argv[1], "delete")) ||
        !valid_service(argv[2]) || !valid_reference(argv[3])) return 2;
    if (!trusted_parent()) return 4;
    return run(argv[1], argv[2], argv[3]);
}
