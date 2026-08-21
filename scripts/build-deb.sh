#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != Linux ]]; then
  echo "build-deb.sh must run on the remote Linux builder; local Rust compilation is forbidden" >&2
  exit 2
fi

VERSION="${XHARNESS_VERSION:-$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)}"
if [[ -z "$VERSION" ]]; then
  echo "could not determine workspace version" >&2
  exit 2
fi

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported Debian architecture: $(uname -m)" >&2; exit 2 ;;
esac

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BINARY="$TARGET_DIR/release/xharness-host"
DIST_DIR="${XHARNESS_DIST_DIR:-$ROOT/dist}"
PACKAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT

if [[ ! -x "$BINARY" ]]; then
  cargo build --locked --release -p xharness-host-app --bin xharness-host
fi

install -d \
  "$PACKAGE_ROOT/DEBIAN" \
  "$PACKAGE_ROOT/usr/bin" \
  "$PACKAGE_ROOT/usr/lib/xharness" \
  "$PACKAGE_ROOT/usr/share/doc/xharness"
install -m 0755 "$BINARY" "$PACKAGE_ROOT/usr/bin/xharness-host"
install -m 0755 packaging/deb/xharness-sandbox-setup \
  "$PACKAGE_ROOT/usr/lib/xharness/xharness-sandbox-setup"
ln -s ../lib/xharness/xharness-sandbox-setup \
  "$PACKAGE_ROOT/usr/bin/xharness-sandbox-setup"
install -m 0644 README.md docs/operations.md \
  "$PACKAGE_ROOT/usr/share/doc/xharness/"
install -m 0644 LICENSE "$PACKAGE_ROOT/usr/share/doc/xharness/copyright"

sed -e "s/@VERSION@/$VERSION/g" -e "s/@ARCH@/$ARCH/g" \
  packaging/deb/control.in > "$PACKAGE_ROOT/DEBIAN/control"
install -m 0755 packaging/deb/postinst "$PACKAGE_ROOT/DEBIAN/postinst"
install -m 0755 packaging/deb/prerm "$PACKAGE_ROOT/DEBIAN/prerm"
install -m 0755 packaging/deb/postrm "$PACKAGE_ROOT/DEBIAN/postrm"

installed_size=$(du -sk "$PACKAGE_ROOT" | awk '{print $1}')
printf 'Installed-Size: %s\n' "$installed_size" >> "$PACKAGE_ROOT/DEBIAN/control"

mkdir -p "$DIST_DIR"
OUTPUT="$DIST_DIR/xharness_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$PACKAGE_ROOT" "$OUTPUT"
dpkg-deb --info "$OUTPUT"
dpkg-deb --contents "$OUTPUT"
printf '%s\n' "$OUTPUT"
