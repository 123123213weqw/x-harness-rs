#!/usr/bin/env python3
"""Build stable machine- and human-readable summaries for a regression run."""

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", required=True, type=Path)
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--json", required=True, type=Path)
    parser.add_argument("--markdown", required=True, type=Path)
    args = parser.parse_args()

    environment = json.loads(args.environment.read_text())
    results = [json.loads(line) for line in args.results.read_text().splitlines() if line]
    counts = {
        status: sum(item["status"] == status for item in results)
        for status in ("passed", "failed", "skipped")
    }
    summary = {
        "environment": environment,
        "counts": counts,
        "passed": counts["failed"] == 0,
        "results": results,
    }
    args.json.write_text(json.dumps(summary, indent=2) + "\n")

    lines = [
        "# XHarness regression report",
        "",
        f"- Run: `{environment['run_id']}`",
        f"- Revision: `{environment['revision']}`",
        f"- Dirty source: `{environment['dirty']}`",
        f"- Suite: `{environment['suite']}`",
        f"- Host: `{environment['hostname']}` / `{environment['platform']}`",
        f"- Result: **{'PASS' if summary['passed'] else 'FAIL'}**",
        f"- Cases: {counts['passed']} passed, {counts['failed']} failed, {counts['skipped']} skipped",
        "",
        "| Case | Result | Seconds | Evidence |",
        "|---|---:|---:|---|",
    ]
    for item in results:
        lines.append(
            f"| `{item['name']}` | {item['status']} | {item['duration_seconds']} | "
            f"[`{item['log']}`]({item['log']}) |"
        )
    failed = [item for item in results if item["status"] == "failed"]
    if failed:
        lines += ["", "## Failures", ""]
        lines += [f"- `{item['name']}`: inspect `{item['log']}`" for item in failed]
    lines += [
        "",
        "## Triage rule",
        "",
        "Reproduce a product failure with the named case before changing code. "
        "Infrastructure and credential failures must not be converted into product fixes.",
    ]
    args.markdown.write_text("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
