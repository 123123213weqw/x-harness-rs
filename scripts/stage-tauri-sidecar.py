#!/usr/bin/env python3
"""Stage a target-specific xharness-host binary for Tauri v2 packaging."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shutil


TARGET_PATTERN = re.compile(r"^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_.-]+$")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path, help="compiled xharness-host binary")
    parser.add_argument("target", help="Rust target triple used by the Tauri build")
    parser.add_argument(
        "--name",
        default="xharness-host",
        help="external binary base name (default: xharness-host)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("apps/desktop/src-tauri/binaries"),
    )
    args = parser.parse_args()

    source = args.binary.resolve()
    if not source.is_file():
        parser.error(f"sidecar binary does not exist: {source}")
    if not TARGET_PATTERN.fullmatch(args.target):
        parser.error(f"invalid Rust target triple: {args.target!r}")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.name):
        parser.error(f"invalid external binary name: {args.name!r}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if "windows" in args.target else ""
    destination = args.output_dir / f"{args.name}-{args.target}{suffix}"
    shutil.copy2(source, destination)
    if suffix == "":
        destination.chmod(destination.stat().st_mode | 0o111)
    print(destination)


if __name__ == "__main__":
    main()
