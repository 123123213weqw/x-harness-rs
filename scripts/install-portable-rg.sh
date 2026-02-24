#!/usr/bin/env bash
# CI only: no local Rust compilation. No PCRE2/dynamic Homebrew dependency.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'Build ripgrep on remote/CI only' >&2; exit 1; }
root="${RUNNER_TEMP:?}/xharness-portable-rg"
if [[ ! -x "$root/bin/rg" ]]; then
  cargo install ripgrep --version 15.2.0 --locked --no-default-features --root "$root"
fi
"$root/bin/rg" --version
printf '%s\n' "$root/bin" >> "${GITHUB_PATH:?}"
