#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
brand_dir="$repo_root/assets/brand"
tauri_icons="$repo_root/apps/desktop/src-tauri/icons"
work_dir="${TMPDIR:-/tmp}/xharness-brand-iconset"
master_png="$brand_dir/xharness-app-icon.png"
favicon_png="$repo_root/ui/overrides/favicon.png"
manifest_png="$repo_root/ui/overrides/app-icon-512.png"

command -v sips >/dev/null
command -v iconutil >/dev/null
mkdir -p "$brand_dir" "$tauri_icons" "$work_dir/XHarness.iconset"
[[ -f "$master_png" ]] || { echo "missing icon master: $master_png" >&2; exit 1; }

resize() {
  local pixels="$1"
  local output="$2"
  sips -z "$pixels" "$pixels" "$master_png" --out "$output" >/dev/null
}

resize 16 "$work_dir/XHarness.iconset/icon_16x16.png"
resize 32 "$work_dir/XHarness.iconset/icon_16x16@2x.png"
resize 32 "$work_dir/XHarness.iconset/icon_32x32.png"
resize 64 "$work_dir/XHarness.iconset/icon_32x32@2x.png"
resize 128 "$work_dir/XHarness.iconset/icon_128x128.png"
resize 256 "$work_dir/XHarness.iconset/icon_128x128@2x.png"
resize 256 "$work_dir/XHarness.iconset/icon_256x256.png"
resize 512 "$work_dir/XHarness.iconset/icon_256x256@2x.png"
resize 512 "$work_dir/XHarness.iconset/icon_512x512.png"
resize 1024 "$work_dir/XHarness.iconset/icon_512x512@2x.png"

resize 32 "$tauri_icons/32x32.png"
resize 128 "$tauri_icons/128x128.png"
resize 256 "$tauri_icons/128x128@2x.png"
resize 64 "$favicon_png"
resize 512 "$manifest_png"
iconutil -c icns "$work_dir/XHarness.iconset" -o "$tauri_icons/icon.icns"

python3 - "$master_png" "$tauri_icons/icon.ico" <<'PY'
from pathlib import Path
import sys

from PIL import Image

source, output = map(Path, sys.argv[1:])
with Image.open(source) as image:
    image.save(output, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
PY

if [[ -f "$repo_root/ui/dist/index.html" ]]; then
  node "$repo_root/scripts/patch-favicon.mjs" "$repo_root/ui/dist"
fi

echo "Generated XHarness brand exports from $master_png"
