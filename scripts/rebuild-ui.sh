#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="${1:-${UPSTREAM_HARNESS_DIR:-}}"

if [[ -z "$upstream" ]]; then
  echo "usage: $0 /path/to/upstream-harness" >&2
  exit 2
fi

upstream="$(cd "$upstream" && pwd)"
required=(
  apps/web/index.html
  apps/web/public/manifest.webmanifest
  apps/web/public/favicon.svg
  packages/client/ui-primitives/src/BrandWordmark.tsx
  packages/client/ui-primitives/src/FishLogo.tsx
)

for file in "${required[@]}"; do
  if [[ ! -f "$upstream/$file" ]]; then
    echo "missing upstream UI file: $upstream/$file" >&2
    exit 1
  fi
done

backup="$(mktemp -d)"
restore() {
  for file in "${required[@]}"; do
    cp "$backup/$file" "$upstream/$file"
  done
  rm -rf "$backup"
}
trap restore EXIT

for file in "${required[@]}"; do
  mkdir -p "$backup/$(dirname "$file")"
  cp "$upstream/$file" "$backup/$file"
done

cp "$repo_root/ui/overrides/BrandWordmark.tsx" \
  "$upstream/packages/client/ui-primitives/src/BrandWordmark.tsx"
cp "$repo_root/ui/overrides/FishLogo.tsx" \
  "$upstream/packages/client/ui-primitives/src/FishLogo.tsx"
cp "$repo_root/ui/overrides/favicon.svg" "$upstream/apps/web/public/favicon.svg"

python3 - "$upstream" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
index = root / "apps/web/index.html"
source = index.read_text()
for old_title in ("DeepSeek Harness", "DSH Local Build"):
    source = source.replace(f"<title>{old_title}</title>", "<title>XHarness</title>")
index.write_text(source)

manifest = root / "apps/web/public/manifest.webmanifest"
manifest.write_text(
    manifest.read_text()
    .replace('"name": "DeepSeek Harness"', '"name": "XHarness"')
    .replace('"short_name": "DSH"', '"short_name": "XH"')
)
PY

# The current upstream ships visible branding through a dynamic client plugin.
# Rebuild the complete Client face, rather than only Vite's Web shell, so the
# checked-in FishLogo/BrandWordmark overrides and the official brand slot
# provider are compiled together.  Selecting the official profile activates
# the slot provider; the title remains our own product title.
(cd "$upstream" && \
  DSH_CLIENT_BUILD_PROFILE=official \
  DSH_CLIENT_TITLE=XHarness \
  pnpm run build)
mkdir -p "$repo_root/ui/dist"
rsync -a --delete "$upstream/apps/web/dist/" "$repo_root/ui/dist/"
node "$repo_root/scripts/assemble-static-ui.mjs" "$upstream" "$repo_root/ui/dist"

# Preserve the dynamic brand bundle beside the shell for consumers that want a
# package-level artifact in addition to the complete static graph in dist/.
brand_plugin="$upstream/packages/client/ui-brand-official/lib/client.js"
brand_map="$brand_plugin.map"
brand_dist="$repo_root/ui/plugins/@deepseek-ai/dsh-client-ui-brand-official"
mkdir -p "$brand_dist"
cp "$brand_plugin" "$brand_dist/client.js"
if [[ -f "$brand_map" ]]; then
  cp "$brand_map" "$brand_dist/client.js.map"
fi

echo "rebuilt XHarness UI at $repo_root/ui/dist"
