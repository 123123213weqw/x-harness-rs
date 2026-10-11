"""Format recorded terminal drafts. No collector, VM or tool-executor connection.

All new evidence goes to an exclusive output directory. Earlier raw attempts
and scores are never replaced. This does not rerun or certify GUI interaction.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

from structured_report import LocalChatTransport, StructuredReporter, output_schema

spec = importlib.util.spec_from_file_location("oracle", Path(__file__).with_name("grade-expanded.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


def read_bounded(path, limit=2097152):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"oversized evidence: {path.name}")
    return data.decode("utf-8")


def run(manifest_path, out, send=None):
    manifest_path = manifest_path.resolve()
    manifest = json.loads(read_bounded(manifest_path))
    entries = manifest["cases"]
    if not 1 <= len(entries) <= 4 or len({e["case"] for e in entries}) != len(entries):
        raise ValueError("require one to four distinct lab cases")
    prepared = []
    for entry in entries:
        case = entry["case"]
        output_schema(case)
        draft = read_bounded(manifest_path.parent / entry["draft"])
        event_text = read_bounded(manifest_path.parent / entry["events"])
        summary_text = read_bounded(manifest_path.parent / entry["summary"])
        events = [json.loads(line) for line in event_text.splitlines() if line.strip()]
        summary = json.loads(summary_text)
        if summary.get("case") != case or "error" not in summary:
            raise ValueError("source summary must identify case and original operation error")
        hashes = {key: hashlib.sha256(text.encode()).hexdigest()
                  for key, text in (("draft", draft), ("events", event_text), ("summary", summary_text))}
        prepared.append((case, draft, events, summary, hashes))
    # Validate the endpoint even when tests inject a fake sender.
    transport = LocalChatTransport(manifest["base_url"])
    reporter = StructuredReporter(send or transport, manifest["model"])
    out.mkdir(parents=True, exist_ok=False)
    reports = []
    for case, draft, events, summary, hashes in prepared:
        directory = out / case
        directory.mkdir()
        (directory / "original.txt").write_text(draft)
        (directory / "source-hashes.json").write_text(json.dumps(hashes, indent=2) + "\n")
        before = oracle.grade_separate(case, draft, events, summary["error"])
        if not before["operation_pass"]:
            result = {"status": "operation_gate_failed", "value": None, "attempts": [],
                      "native_actions_replayed": False, "draft_preserved": True}
        else:
            result = reporter.generate(case, draft)
        wire = json.dumps(result["value"], ensure_ascii=False, allow_nan=False) if result["value"] is not None else ""
        if wire:
            (directory / "structured.json").write_text(wire + "\n")
        after = oracle.grade_separate(case, wire, events, summary["error"])
        (directory / "generation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        report = {"case": case, "source_sha": summary.get("source_sha"),
                  "before": before, "after": after, "formatting_status": result["status"],
                  "formatting_requests": len(result["attempts"]),
                  "gui_rerun": False, "original_scores_preserved": True}
        reports.append(report)
        (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (out / "capability-probe.json").write_text(json.dumps(reporter.capability, ensure_ascii=False, indent=2) + "\n")
    aggregate = {"cases": reports, "operation_passed": sum(x["after"]["operation_pass"] for x in reports),
                 "facts_passed": sum(x["after"]["facts_pass"] is True for x in reports),
                 "format_passed": sum(x["after"]["format_pass"] for x in reports),
                 "overall_passed": sum(x["after"]["overall_pass"] for x in reports),
                 "total": len(reports), "gui_rerun": False,
                 "reporting_requests": sum(x["formatting_requests"] for x in reports),
                 "capability_probe_requests": int(reporter.capability is not None)}
    (out / "result.json").write_text(json.dumps(aggregate, ensure_ascii=False, indent=2) + "\n")
    return aggregate


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.manifest, args.out)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["overall_passed"] == result["total"] else 1)
