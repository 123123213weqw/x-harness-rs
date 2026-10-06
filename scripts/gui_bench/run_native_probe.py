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
import zlib

if __package__ in (None, ""):
    # The CI also invokes this file directly, without `python -m`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


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


def cleanup(root: Path) -> bool:
    # WebKit/cache writers can outlive the app by a short interval. Bound the
    # retry and report cleanup failure; do not lose the probe receipt on ENOTEMPTY.
    for attempt in range(10):
        try:
            shutil.rmtree(root)
            return True
        except FileNotFoundError:
            return True
        except OSError as error:
            if attempt == 9:
                print(f"Probe cleanup failed: {error}", file=sys.stderr)
            time.sleep(0.1 * (attempt + 1))
    return False


def cleanup_profile(root: Path) -> bool:
    # A killed, test-owned document portal can leave a disconnected FUSE mount.
    # Retrying rmtree cannot remove a mount. Never detach a user's profile or a
    # different filesystem: only portal mounts and the exact GVFS runtime mount
    # beneath our generated temp root. GNOME's portal also starts gvfsd-fuse.
    if (not root.is_absolute() or root.is_symlink()
            or not root.name.startswith(("xh-native-dom-", "xh-webview-profile-"))
            or root.parent.resolve() != Path(tempfile.gettempdir()).resolve()):
        return False
    mounts = Path("/proc/self/mountinfo")
    if mounts.exists():
        try:
            owned = []
            for line in mounts.read_text().splitlines():
                fields = line.split()
                target = fields[4]
                for escaped, literal in [("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")]:
                    target = target.replace(escaped, literal)
                target = Path(target)
                if root in target.parents:
                    filesystem = fields[fields.index("-") + 1]
                    if (filesystem != "fuse.portal"
                            and not (filesystem == "fuse.gvfsd-fuse" and target == root / "runtime/gvfs")):
                        print(f"Probe cleanup refused an unowned runtime mount: {target}", file=sys.stderr)
                        return False
                    owned.append(target)
            for target in sorted(owned, key=lambda path: len(path.parts), reverse=True):
                result = subprocess.run(["fusermount3", "-uz", str(target)],
                                        capture_output=True, timeout=5)
                if result.returncode:
                    print(f"Probe runtime unmount failed: {target}", file=sys.stderr)
                    return False
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired) as error:
            print(f"Probe portal cleanup failed: {error}", file=sys.stderr)
            return False
    return cleanup(root)


def run_probe(binary: Path, env: dict[str, str], log) -> int:
    process = subprocess.Popen(command(binary, sys.platform), env=env, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=os.name == "posix")
    try:
        return process.wait(timeout=150)
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


def hard_capabilities(log_text: str) -> dict:
    lines = [line[len("HARD_CAPABILITY_EVIDENCE "):] for line in log_text.splitlines()
             if line.startswith("HARD_CAPABILITY_EVIDENCE ")]
    if len(lines) != 1:
        return {"status": "unverified", "reason": "missing or duplicate native capability evidence"}
    try:
        result = json.loads(lines[0])
    except (ValueError, TypeError):
        return {"status": "unverified", "reason": "malformed native capability evidence"}
    required = {"trusted_input", "cross_origin_frames", "screenshot", "recording", "hidden_tab_actions"}
    if not isinstance(result, dict) or not required.issubset(result):
        return {"status": "unverified", "reason": "incomplete native capability evidence"}
    return result


def native_api_evidence(log_text: str, evidence_dir: Path) -> dict:
    from scripts.gui_bench.native_png import pixel
    prefix = "NATIVE_API_EVIDENCE "
    lines = [line[len(prefix):] for line in log_text.splitlines() if line.startswith(prefix)]
    if len(lines) != 1:
        return {"status": "unverified", "reason": "missing or duplicate API probe evidence"}
    try:
        result = json.loads(lines[0])
        if (not isinstance(result, dict) or result.get("test_only") is not True
                or result.get("production_enabled") is not False):
            raise ValueError("invalid prototype scope")
        screenshots = result["screenshots"]
        if not isinstance(screenshots, list) or len(screenshots) != 3:
            raise ValueError("incomplete native frame sequence")
        scale = result["observed"]["dpr"]
        if type(scale) not in (float, int) or not 0 < scale <= 4:
            raise ValueError("invalid native DPR")
        expected = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
        for index, item in enumerate(screenshots):
            if not isinstance(item, dict) or item.get("index") != index:
                raise ValueError("invalid native frame index")
            item["pixels_verified"] = False
            if item.get("status") != "captured":
                continue
            try:
                data = (evidence_dir / "native-api" / f"snapshot-{index}.png").read_bytes()
                rgb, size = pixel(data, round(60*scale), round(160*scale))
                item["pixels_verified"] = (size == (item["width"], item["height"])
                    and all(abs(a-b) <= 5 for a, b in zip(rgb, expected[index])))
                item["marker_rgb"] = rgb
            except (OSError, ValueError, zlib.error) as error:
                item["validation_error"] = type(error).__name__
        result["snapshot_sequence_verified"] = all(item["pixels_verified"] for item in screenshots)
        if "hidden_background" in result:
            hidden = result["hidden_background"]["snapshot"]
            hidden["live_pixels_verified"] = False
            if hidden.get("status") == "captured":
                try:
                    data = (evidence_dir / "native-api" / "snapshot-hidden.png").read_bytes()
                    rgb, size = pixel(data, round(60*scale), round(160*scale))
                    hidden["live_pixels_verified"] = (size == (hidden["width"], hidden["height"])
                        and all(abs(a-b) <= 5 for a, b in zip(rgb, (255, 255, 0))))
                    hidden["marker_rgb"] = rgb
                except (OSError, ValueError, zlib.error) as error:
                    hidden["validation_error"] = type(error).__name__
        result["status"] = "tested"
        return result
    except (ValueError, KeyError, TypeError):
        return {"status": "unverified", "reason": "malformed API probe evidence"}


def core_native_apis_passed(api: dict) -> bool:
    # A "tested" callback alone is not a capability gate. Require fixture
    # state/trusted input and independently decoded changed-color native pixels.
    return (api.get('status') == 'tested'
            and all(isinstance(api.get(name), dict) and api[name].get('passed') is True
                    for name in ('native_mouse', 'native_keyboard', 'cross_origin_pointer'))
            and api.get('snapshot_sequence_verified') is True)


def contract_completed(log_text: str) -> bool:
    # AppHandle.exit() can stop a native event loop without changing main's
    # process exit status. Require positive terminal evidence, not rc=0 alone.
    return ("Native Tauri DOM probe passed:" in log_text
            and "Native lifecycle probe passed:" in log_text
            and "Native observation probe failed:" not in log_text
            and hard_capabilities(log_text).get("status") != "unverified")


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
    directory = Path(tempfile.mkdtemp(prefix="xh-native-dom-"))
    code = 127
    try:
        with (args.evidence_dir / "native-probe.log").open("wb") as log:
            try:
                env = environment(directory)
                env['XHARNESS_NATIVE_API_EVIDENCE'] = str(args.evidence_dir.resolve() / 'native-api')
                code = run_probe(binary, env, log)
            except OSError:
                code = 127
    finally:
        cleaned = cleanup_profile(directory)
    log_text = (args.evidence_dir / "native-probe.log").read_text(encoding="utf-8", errors="replace")
    capabilities = hard_capabilities(log_text)
    completed = contract_completed(log_text)
    api = native_api_evidence(log_text, args.evidence_dir)
    (args.evidence_dir / 'native-api-evidence.json').write_text(json.dumps(api,indent=2)+'\n')
    receipt['native_api_prototype_tested'] = api.get('status') == 'tested'
    receipt['native_api_core_passed'] = core_native_apis_passed(api)
    completed = completed and receipt['native_api_core_passed']
    (args.evidence_dir / "hard-capabilities.json").write_text(json.dumps(capabilities, indent=2) + "\n", encoding="utf-8")
    # Passing the bounded DOM/lifecycle contract is NOT full Browser Use parity.
    receipt["browser_parity_passed"] = False
    receipt["hard_capability_status"] = capabilities.get("parity_gate", capabilities.get("status", "unverified"))
    receipt["cleanup_passed"] = cleaned
    receipt.update(exit_code=code, seconds=round(time.monotonic() - start, 3), passed=code == 0 and cleaned and completed, contract_completed=completed)
    (args.evidence_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0 if code == 0 and cleaned and completed else 1


if __name__ == "__main__":
    raise SystemExit(main())
