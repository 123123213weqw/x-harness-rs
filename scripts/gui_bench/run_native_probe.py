"""Run an already-compiled disposable Tauri DOM probe, never a model/Host.

Linux uses its own Xvfb/DBus session. Other platforms use the CI desktop; the
probe itself selects a fresh application identifier. No credentials/ambient
provider configuration are forwarded. Outputs identify this as DOM, not OS input.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def command(binary: Path, platform: str) -> list[str]:
    if platform == "linux":
        return ["xvfb-run", "-a", "-s", "-screen 0 1360x900x24", "dbus-run-session", "--", str(binary)]
    return [str(binary)]


def environment(root: Path) -> dict[str, str]:
    allowed = {"path", "home", "lang", "lc_all", "systemroot", "windir", "comspec", "userprofile", "appdata", "localappdata", "temp", "tmp"}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    for name, suffix in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")]:
        path = root / suffix
        path.mkdir(mode=0o700)
        env[name] = str(path)
    env["LIBGL_ALWAYS_SOFTWARE"] = "1"
    return env


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with binary.open("rb") as file:
        for chunk in iter(lambda: file.read(65536), b""):
            digest.update(chunk)
    receipt = {"kind": "native_tauri_dom_contract", "platform": sys.platform,
               "model_calls": 0, "os_input": False,
               "binary_sha256": digest.hexdigest()}
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="xh-native-dom-") as directory:
        with (args.evidence_dir / "native-probe.log").open("wb") as log:
            try:
                result = subprocess.run(command(binary, sys.platform), env=environment(Path(directory)),
                                        stdout=log, stderr=subprocess.STDOUT, timeout=90, check=False)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = 124
            except OSError:
                code = 127
    receipt.update(exit_code=code, seconds=round(time.monotonic() - start, 3), passed=code == 0)
    (args.evidence_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0 if code == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
