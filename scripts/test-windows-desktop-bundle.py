#!/usr/bin/env python3
"""Validate the Windows Tauri sidecar and platform configuration contract."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
STAGER = REPOSITORY_ROOT / "scripts" / "stage-tauri-sidecar.py"
TAURI_ROOT = REPOSITORY_ROOT / "apps" / "desktop" / "src-tauri"
WINDOWS_CONFIG = TAURI_ROOT / "tauri.windows.conf.json"
CAPABILITY = TAURI_ROOT / "capabilities" / "desktop-main.json"
TARGET = "x86_64-pc-windows-msvc"
EXTERNAL_BINARIES = [
    "binaries/xharness-host",
    "binaries/rg",
    "binaries/xharness-windows-sandbox-runner",
]


class WindowsDesktopBundleTests(unittest.TestCase):
    def test_stager_emits_target_suffixed_windows_executables(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "binaries"
            for name in (
                "xharness-host",
                "rg",
                "xharness-windows-sandbox-runner",
            ):
                source = root / f"{name}.exe"
                source.write_bytes(f"{name}\n".encode())
                subprocess.run(
                    [
                        sys.executable,
                        str(STAGER),
                        str(source),
                        TARGET,
                        "--name",
                        name,
                        "--output-dir",
                        str(output),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                staged = output / f"{name}-{TARGET}.exe"
                self.assertEqual(staged.read_bytes(), source.read_bytes())

    def test_windows_overlay_bundles_the_acl_runner(self) -> None:
        document = json.loads(WINDOWS_CONFIG.read_text(encoding="utf-8"))
        self.assertEqual(document["bundle"]["externalBin"], EXTERNAL_BINARIES)

    def test_desktop_bridge_is_enabled_on_windows(self) -> None:
        document = json.loads(CAPABILITY.read_text(encoding="utf-8"))
        self.assertIn("windows", document["platforms"])


if __name__ == "__main__":
    unittest.main()
