"""Repeatable four-run live pilot; read {api_key, model} on stdin, never persist it.

Compile history_live_eval against BOTH revisions before invoking this script.
Use --output NEW_DIRECTORY and explicitly selected --baseline / --candidate binaries.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--baseline-revision", required=True)
    parser.add_argument("--candidate-revision", required=True)
    args = parser.parse_args()
    binaries = {key: getattr(args, key).resolve(strict=True) for key in ("baseline", "candidate")}
    root = args.output.resolve()
    if root.exists():
        parser.error("output directory must not already exist")
    config = json.load(sys.stdin)
    if not isinstance(config.get("api_key"), str) or not isinstance(config.get("model"), str):
        parser.error("stdin must contain api_key and model strings")
    credential_input = json.dumps({"api_key": config["api_key"], "model": config["model"]})
    root.mkdir(mode=0o700, parents=True)
    metadata = {"model": config["model"], "revisions": {
        "baseline": args.baseline_revision, "candidate": args.candidate_revision},
        "binary_sha256": {key: sha256(path) for key, path in binaries.items()},
        "context_policy": "IdentityContextPolicy; compaction disabled", "output_limit_per_request": None,
        "max_turn_output_tokens": 131072, "event_capacity": 2048,
        "time_limit_seconds": 300, "step_cancel_threshold": 16,
        "order": [["candidate", "ordinary"], ["baseline", "ordinary"], ["baseline", "recovery"], ["candidate", "recovery"]]}
    (root / "protocol.json").write_text(json.dumps(metadata, indent=2))
    spec = importlib.util.spec_from_file_location("acceptance_report", Path(__file__).with_name("history-eval-report.py"))
    reporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reporter)
    rows = []
    for version, case in metadata["order"]:
        output = root / f"{version}-{case}"
        try:
            run = subprocess.run([str(binaries[version]), str(output), case],
                                 input=credential_input, text=True, capture_output=True,
                                 timeout=315, check=True, env={})
            del run  # The durable session and checked.json contain non-secret evidence.
            row = reporter.evaluate(output)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            row = {"run": output.name, "infrastructure_error": type(error).__name__}
        rows.append(row)
        (root / "report.json").write_text(json.dumps(rows, indent=2))
        print(json.dumps({k: v for k, v in row.items() if k != "answer"}), flush=True)


if __name__ == "__main__":
    main()
