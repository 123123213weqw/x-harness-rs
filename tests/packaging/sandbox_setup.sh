#!/usr/bin/env bash
set -euo pipefail

HELPER="${1:-packaging/deb/xharness-sandbox-setup}"
HELPER="$(cd "$(dirname "$HELPER")" && pwd)/$(basename "$HELPER")"
sh -n "$HELPER"

command -v bwrap >/dev/null
base="$(mktemp -d)"
trap 'rm -rf "$base"' EXIT
state="$base/state"
source_profile="$base/source-profile"
target_profile="$base/target-profile"
fake_parser="$base/apparmor_parser"

cat > "$fake_parser" <<'PARSER'
#!/bin/sh
exit 0
PARSER
chmod 0755 "$fake_parser"
printf '%s\n' 'profile-v1' > "$source_profile"

run_helper() {
  XHARNESS_SETUP_TEST_ROOT=1 \
  XHARNESS_FORCE_APPARMOR_ENABLED=true \
  XHARNESS_FORCE_PROFILE_LOADED=true \
  XHARNESS_SETUP_STATE_DIR="$state" \
  XHARNESS_PROFILE_SOURCE="$source_profile" \
  XHARNESS_PROFILE_TARGET="$target_profile" \
  XHARNESS_APPARMOR_PARSER="$fake_parser" \
  "$HELPER" "$@"
}

"$HELPER" detect >/dev/null
XHARNESS_SETUP_STATE_DIR="$state" "$HELPER" verify

grep -q '"workspaceWrite": true' "$state/sandbox-state.json"
grep -q '"outsideWriteDenied": true' "$state/sandbox-state.json"
grep -q '"networkNamespaceIsolated": true' "$state/sandbox-state.json"
grep -q '"pidDescendantCleaned": true' "$state/sandbox-state.json"

rm -rf "$state"
run_helper install
cmp -s "$source_profile" "$target_profile"
first_hash="$(sha256sum "$target_profile" | awk '{print $1}')"
test "$(cat "$state/bwrap-profile.owned")" = "$first_hash"
grep -q "\"profileSha256\": \"$first_hash\"" "$state/sandbox-state.json"
grep -q '"profileManagedByXHarness": true' "$state/sandbox-state.json"

printf '%s\n' 'profile-v2' > "$source_profile"
run_helper install
cmp -s "$source_profile" "$target_profile"
second_hash="$(sha256sum "$target_profile" | awk '{print $1}')"
test "$second_hash" != "$first_hash"
test "$(cat "$state/bwrap-profile.owned")" = "$second_hash"

run_helper remove
test ! -e "$target_profile"
test ! -e "$state"

mkdir -p "$state"
printf '%s\n' 'administrator-profile' > "$target_profile"
printf '%s\n' 'package-profile' > "$source_profile"
admin_hash="$(sha256sum "$target_profile" | awk '{print $1}')"
run_helper install
test "$(sha256sum "$target_profile" | awk '{print $1}')" = "$admin_hash"
test ! -e "$state/bwrap-profile.owned"
grep -q '"profileManagedByXHarness": false' "$state/sandbox-state.json"
run_helper remove
test -e "$target_profile"

echo 'sandbox setup packaging tests passed'
