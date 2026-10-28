#!/usr/bin/env python3
"""Real Clippy/compiler mutations in a disposable Linux clone, never on the Mac.

Guard presence is not evidence of enforcement. Each crate is mutated separately
so an upstream error cannot prevent dependent crates from being checked.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile

CASES = {
    "unwrap": ("clippy::unwrap_used", "fn error_gate_probe(value: Option<u8>) -> u8 { value.unwrap() }"),
    "expect": ("clippy::expect_used", 'fn error_gate_probe(value: Option<u8>) -> u8 { value.expect("missing") }'),
    "discard_result": ("clippy::let_underscore_must_use", "fn error_gate_probe(value: Result<(), std::io::Error>) { let _ = value; }"),
    "unused_result": ("unused_must_use", "fn error_gate_probe(value: Result<(), std::io::Error>) { value; }"),
    "const_unwrap": ("clippy::unwrap_used", "#[allow(clippy::unnecessary_literal_unwrap)] const ERROR_GATE_PROBE: u8 = Some(1u8).unwrap();"),
    "const_expect": ("clippy::expect_used", '#[allow(clippy::unnecessary_literal_unwrap)] const ERROR_GATE_PROBE: u8 = Some(1u8).expect("constant");'),
    "local_allow": ("E0453", "#[allow(clippy::unwrap_used)] fn error_gate_probe(value: Option<u8>) -> u8 { value.unwrap() }"),
}


def diagnostics(output: str, code: str, paths: list[str]) -> list[str]:
    rejected = set()
    for line in output.splitlines():
        try:
            message = json.loads(line).get("message", {})
        except (ValueError, AttributeError):
            continue
        if message.get("level") != "error" or (message.get("code") or {}).get("code") != code:
            continue
        for span in message.get("spans", []):
            if not span.get("is_primary"):
                continue
            file = span["file_name"].replace("\\", "/")
            rejected.update(path for path in paths if file == path or file.endswith("/" + path))
    return sorted(rejected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or not (os.environ.get("XHARNESS_REMOTE_RUST") == "1" or os.environ.get("GITHUB_ACTIONS") == "true"):
        parser.error("Rust compilation is remote-only: run through SSH on WZU_Server or Linux CI")
    root = args.root.resolve()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = args.evidence_dir.resolve()
    checker = runpy.run_path(str(root / "scripts/regression/check-architecture.py"))
    policy = json.loads((root / "config/architecture-host-modules.json").read_text())
    paths = sorted(checker["business_error_sources"](policy))
    groups = {}
    for path in paths:
        groups.setdefault(Path(path).parts[1], []).append(path)
    target = Path(os.environ.get("CARGO_TARGET_DIR", root / "target")).resolve()
    env = dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO_TERM_COLOR="never")
    rows = []
    receipt = {"scope":"actual_clippy_compiler_mutation", "protected_files":paths, "cases":rows, "passed":False}
    # Copy source once, outside the original tree. Never mutate a user's checkout.
    with tempfile.TemporaryDirectory(prefix="error-guard-", dir=root.parent) as temporary:
        clone = Path(temporary)
        shutil.copytree(root, clone, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".git", "target", "node_modules", ".regression-artifacts", "dist", ".env", ".env.*", "*.key", "*.pem", "__pycache__"))
        originals = {path:(clone / path).read_bytes() for path in paths}
        try:
            for package, sources in sorted(groups.items()):
                for name, (code, addition) in CASES.items():
                    try:
                        for path in sources:
                            (clone / path).write_bytes(originals[path] + ("\n#[allow(dead_code)]\n" + addition + "\n").encode())
                        command = ["cargo", "clippy", "--locked", "--offline", "-j4", "-p", package, "--lib", "--message-format=json", "--", "-D", "warnings"]
                        result = subprocess.run(command, cwd=clone, env=env, capture_output=True, text=True, timeout=600)
                        output = result.stdout + result.stderr
                        (evidence / f"{package}-{name}.jsonl").write_text(output)
                        rejected = diagnostics(result.stdout, code, sources)
                        passed = result.returncode != 0 and rejected == sorted(sources)
                        row = dict(package=package, case=name, expected_lint=code, passed=passed,
                                   exit_code=result.returncode, rejected_files=rejected, expected_files=sources)
                        rows.append(row)
                        print(json.dumps(row), flush=True)
                        if not passed:
                            raise RuntimeError(f"{package}/{name}: not every protected file failed for the expected lint")
                    finally:
                        for path in sources:
                            (clone / path).write_bytes(originals[path])
        finally:
            receipt["original_source_bytes_restored"] = all((clone / p).read_bytes() == raw for p,raw in originals.items())
            (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        command = ["cargo", "clippy", "--locked", "--offline", "-j4", *[arg for package in sorted(groups) for arg in ["-p",package]], "--all-targets", "--", "-D", "warnings"]
        positive = subprocess.run(command, cwd=clone, env=env, capture_output=True, text=True, timeout=900)
        (evidence / "positive-restored.log").write_text(positive.stdout + positive.stderr)
        receipt.update(positive_exit_code=positive.returncode,
                       passed=positive.returncode == 0 and receipt["original_source_bytes_restored"] and all(row["passed"] for row in rows))
    (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
