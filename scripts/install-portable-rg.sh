#!/usr/bin/env bash
# CI only: no local Rust compilation. No PCRE2/dynamic Homebrew dependency.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'Build ripgrep on remote/CI only' >&2; exit 1; }
python3 "$(cd "$(dirname "$0")" && pwd)/portable-rg-cache.py"
