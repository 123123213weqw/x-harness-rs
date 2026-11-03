#!/usr/bin/env python3
"""Actual directory FFI fault injection. Linux remote/CI only; never a live Host."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or not (os.environ.get("XHARNESS_REMOTE_RUST") == "1" or os.environ.get("GITHUB_ACTIONS") == "true"):
        parser.error("Rust compilation is remote-only: run on WZU_Server or Linux CI")
    root = Path(__file__).resolve().parents[2]
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    build = subprocess.run(["cargo", "test", "--locked", "--offline", "-j4", "-p", "xharness-fs", "--test", "inventory", "--no-run", "--message-format=json"], cwd=root, capture_output=True, text=True, timeout=600)
    (evidence / "build.jsonl").write_text(build.stdout + build.stderr)
    if build.returncode:
        raise RuntimeError("inventory acceptance executable build failed; see evidence")
    executables = []
    for line in build.stdout.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("reason") == "compiler-artifact" and row.get("target", {}).get("name") == "inventory" and row.get("executable"):
            executables.append(row["executable"])
    if len(executables) != 1:
        raise RuntimeError("expected one exact native inventory test executable")
    shim = evidence / "inventory-error.so"
    compiled = subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared", str(root / "scripts/regression/fixtures/inventory-error.c"), "-ldl", "-o", str(shim)], capture_output=True, text=True, timeout=60)
    (evidence / "shim-build.log").write_text(compiled.stdout + compiled.stderr)
    if compiled.returncode:
        raise RuntimeError("native fault shim compilation failed")
    rows = []
    for mode in ["positive", "open", "read", "permission", "unknown", "close", "read-close"]:
        env = dict(os.environ)
        env.pop("XHARNESS_DIR_FAULT", None)
        env.pop("LD_PRELOAD", None)
        env["XHARNESS_INVENTORY_ISOLATED_PROBE"] = "1"
        if mode != "positive":
            env.update(LD_PRELOAD=str(shim), XHARNESS_DIR_FAULT=mode)
        result = subprocess.run([executables[0], "unix::directory_fault_probe_never_accepts_injected_io_errors", "--exact", "--test-threads=1", "--nocapture"], cwd=root, env=env, capture_output=True, text=True, timeout=60)
        output = result.stdout + result.stderr
        (evidence / f"{mode}.log").write_text(output)
        passed = result.returncode == 0 and "1 passed; 0 failed; 0 ignored" in output
        rows.append(dict(mode=mode, passed=passed, exit_code=result.returncode))
        print(json.dumps(rows[-1]), flush=True)
    receipt = dict(scope="isolated_actual_posix_directory_faults", cases=rows, passed=all(row["passed"] for row in rows), live_host_touched=False)
    (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
