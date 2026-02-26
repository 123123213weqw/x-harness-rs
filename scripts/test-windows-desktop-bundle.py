#!/usr/bin/env python3
"""Validate the Windows Tauri sidecar and platform configuration contract."""

from __future__ import annotations

import json
import importlib.util
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
CI_WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml"
RELEASE_WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "desktop-release.yml"
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

    def test_ci_builds_an_installable_windows_client(self) -> None:
        workflow = CI_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("--bundles nsis", workflow)
        self.assertIn("name: XHarness-windows-x64", workflow)
        self.assertIn("--name xharness-windows-sandbox-runner", workflow)

    def test_tagged_release_includes_pinned_windows_sidecars(self) -> None:
        workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        spec = importlib.util.spec_from_file_location("release_build", REPOSITORY_ROOT / "scripts/desktop-release-build.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        self.assertIn("fromJSON(needs.plan.outputs.matrix)", workflow)
        for scope in ("all", "windows-linux"):
            matrix = build.platform_matrix({"release_scope": scope})["include"]
            windows = [entry for entry in matrix if entry["platform"] == "windows-x86_64"]
            self.assertEqual(windows, [{"platform": "windows-x86_64", "runner": "windows-2025",
                                       "target": TARGET, "bundles": "nsis"}])
        self.assertIn("--name xharness-windows-sandbox-runner", workflow)
        self.assertIn(
            "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
            workflow,
        )

    def test_windows_native_commands_fail_immediately(self) -> None:
        workflow = CI_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("- run: python -B scripts/test-windows-desktop-bundle.py", workflow)
        start = workflow.index("      - name: Stage Windows Tauri sidecars")
        end = workflow.index("      - name: Build installable Windows application", start)
        lines = workflow[start:end].splitlines()
        for index, line in enumerate(lines):
            if line.strip().startswith(("cargo ", "python ", "node ")):
                self.assertIn("if ($LASTEXITCODE)", lines[index + 1], line)


if __name__ == "__main__":
    unittest.main()
