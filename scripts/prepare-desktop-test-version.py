#!/usr/bin/env python3
"""仅供隔离的桌面更新演练 CI：统一修改 Cargo、Lock、Tauri 版本。"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare(version, public_key=None):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("test version must be a plain major.minor.patch version")
    desktop = ROOT / "apps/desktop/src-tauri"
    path = desktop / "tauri.conf.json"
    config = json.loads(path.read_text())
    config["version"] = version
    if public_key is not None:
        if not public_key.strip():
            raise ValueError("missing updater public key")
        config["plugins"]["updater"]["pubkey"] = public_key.strip()
    path.write_text(json.dumps(config, indent=2) + "\n")
    path = desktop / "Cargo.toml"
    source, count = re.subn(r'(?m)^version = "[^"]+"$', f'version = "{version}"', path.read_text(), count=1)
    assert count == 1
    path.write_text(source)
    path = desktop / "Cargo.lock"
    source, count = re.subn(r'(name = "xharness-desktop"\nversion = ")[^"]+(")', lambda m: m[1] + version + m[2], path.read_text())
    assert count == 1
    path.write_text(source)


if __name__ == "__main__":
    prepare(sys.argv[1], os.environ["XHARNESS_UPDATER_PUBKEY"])
