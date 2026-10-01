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
import shutil
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def command(binary: Path, platform: str) -> list[str]:
    if platform == "linux":
        return ["xvfb-run", "-a", "-s", "-screen 0 1360x900x24", "dbus-run-session", "--", str(binary)]
    return [str(binary)]


def environment(root: Path, runtime_dirs: list[Path] | None = None) -> dict[str, str]:
    allowed = {"path", "home", "lang", "lc_all", "systemroot", "windir", "comspec", "userprofile", "appdata", "localappdata", "temp", "tmp"}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    # Direct execution does not get Cargo's target/deps DLL search paths. Only
    # explicitly supplied build directories are prepended; never forward the
    # rest of Cargo's/provider environment or scan arbitrary user directories.
    if runtime_dirs:
        key = next((key for key in env if key.lower() == "path"), "PATH")
        env[key] = os.pathsep.join([*(str(path.resolve(strict=True)) for path in runtime_dirs), env.get(key, "")])
    for name, suffix in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")]:
        path = root / suffix
        path.mkdir(mode=0o700)
        env[name] = str(path)
    env["LIBGL_ALWAYS_SOFTWARE"] = "1"
    return env


def cleanup(root: Path) -> bool:
    # WebKit/cache writers can outlive the app by a short interval. Bound the
    # retry and report cleanup failure; do not lose the probe receipt on ENOTEMPTY.
    for attempt in range(10):
        try:
            shutil.rmtree(root)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(0.1 * (attempt + 1))
    return False


def run_probe(binary: Path, env: dict[str, str], log) -> int:
    process = subprocess.Popen(command(binary, sys.platform), env=env, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=os.name == "posix")
    try:
        return process.wait(timeout=90)
    except subprocess.TimeoutExpired:
        return 124
    finally:
        if os.name == "posix":
            # Only our new session/group, never the user's display or apps.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--runtime-dir", type=Path, action="append", default=[])
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
    directory = Path(tempfile.mkdtemp(prefix="xh-native-dom-"))
    code = 127
    try:
        with (args.evidence_dir / "native-probe.log").open("wb") as log:
            try:
                code = run_probe(binary, environment(directory, args.runtime_dir), log)
            except OSError:
                code = 127
    finally:
        cleaned = cleanup(directory)
    receipt["cleanup_passed"] = cleaned
    receipt.update(exit_code=code, seconds=round(time.monotonic() - start, 3), passed=code == 0 and cleaned)
    (args.evidence_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0 if code == 0 and cleaned else 1


if __name__ == "__main__":
    raise SystemExit(main())
