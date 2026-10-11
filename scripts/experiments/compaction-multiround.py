#!/usr/bin/env python3
"""Real-model acceptance for production context/compaction, with immutable A/B artifacts.

prepare-manifest is offline; run explicitly opts into API spending. Secrets are
read from Keychain and sent only over SSH stdin. No desktop state is modified.
The model executes real Python source and tests in an isolated workspace. Hidden
acceptance is installed after model work, outside read/write tool capabilities.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shlex
import statistics
import subprocess
import time
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST_NAME = "compaction_eval_source_manifest.json"
RUNTIME_CRATES = (
    "xharness-core", "xharness-context", "xharness-compaction", "xharness-session",
    "xharness-session-jsonl", "xharness-provider-openai", "xharness-tools",
    "xharness-interaction", "xharness-host-app", "xharness-prompt", "xharness-token",
)
WRITABLE = ("parser.py", "importer.py", "report.py")
EVAL_SYSTEM = ("You are an engineering assistant. Read current files, make precise changes and use actual tests as evidence. "
               "Historical results are not current test proof. Use history to recover truncated original evidence; "
               "never guess missing constants. Do not publish or access outside the provided workspace.")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def source_manifest(root: pathlib.Path) -> dict[str, Any]:
    """Exact byte hashes, includes new runtime files instead of a handpicked source."""
    paths = [root / "Cargo.toml", root / "Cargo.lock"]
    for crate in RUNTIME_CRATES:
        directory = root / "crates" / crate
        paths.append(directory / "Cargo.toml")
        paths.extend((directory / "src").rglob("*.rs"))
    paths.extend([
        root / "crates/xharness-host/src/history_tool.rs",
        root / "crates/xharness-host-app/examples/compaction_budget_eval.rs",
    ])
    required = [
        "crates/xharness-core/src/engine.rs", "crates/xharness-core/src/compaction.rs",
        "crates/xharness-context/src/lib.rs", "crates/xharness-compaction/src/planner.rs",
        "crates/xharness-session/src/session.rs", "crates/xharness-session/src/event.rs",
    ]
    if any(not (root / name).is_file() for name in required):
        raise ValueError("runtime snapshot is incomplete")
    hashes = {str(path.relative_to(root)): sha256(path.read_bytes())
              for path in sorted(set(paths)) if path.is_file()}
    return {"version": 1, "algorithm": "sha256", "files": hashes,
            "runtime_sha256": sha256(canonical_json(hashes))}


def verify_manifest(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    if (actual.get("version") != 1 or actual.get("files") != expected.get("files")
            or actual.get("runtime_sha256") != expected.get("runtime_sha256")
            or actual.get("runtime_sha256") != sha256(canonical_json(actual.get("files")))):
        raise RuntimeError("embedded runtime source fingerprint mismatch; no fixture or model request sent")


def base_fixture(seed: int) -> tuple[dict[str, str], str]:
    spec = importlib.util.spec_from_file_location("prior_coding", pathlib.Path(__file__).with_name("compaction-coding.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    files, hidden = module.fixture(seed)
    files["importer.py"] += '\nAPI_REVISION = "legacy-api"\n'
    files["report.py"] += '\ndef running_balance(rows, opening_cents=0):\n    raise NotImplementedError("balance implementation missing")\n\ndef report_metadata():\n    return {"api_revision": "legacy-api"}\n'
    files["docs/api.txt"] += "\nPhase boundary: running_balance/report_metadata are report work; do not implement them during parser/importer phases.\n"
    return files, hidden


def updated_contract(seed: int) -> tuple[str, str, str]:
    marker = f"ledger-v2-external-{seed}"
    docs = f'''Ledger API v2 (CURRENT file; replaces the previous report plan)
parse_amount and import_rows keep their v1 contract; they have been reviewed externally. DO NOT edit parser.py or importer.py in this phase.
Only report.py may change. Do not publish or deploy.
daily_totals(rows): use import_rows to deduplicate highest revision (ties last) and aggregate integer cents per UTC day; no shared state or input mutation.
running_balance(rows, opening_cents=0): return a list of NEW dictionaries with EXACT keys day and balance_cents, sorted by day ascending, one entry per day from daily_totals. Each balance equals opening_cents plus totals up through that day. opening_cents is an integer in cents; reject bool and non-integers with ValueError. Empty rows returns []. Signed balances, negative entries and duplicate revisions must work.
report_metadata(): return {{"api_revision": importer.API_REVISION}}, looking up the CURRENT importer module value on each call rather than freezing an old literal. The current marker is {marker}.
The final review is READ ONLY. A successful test is evidence, not permission to change files outside this phase.
'''
    public = '''import unittest
from parser import parse_amount
from importer import import_rows
from report import daily_totals, running_balance, report_metadata
import importer
class PublicV2(unittest.TestCase):
 def test_money(self): self.assertEqual(parse_amount('1.005'),101)
 def test_utc(self): self.assertEqual(daily_totals([dict(id='a',timestamp='2026-10-12T00:30:00+02:00',amount='2')]),{'2026-10-11':200})
 def test_balance(self):
  rows=[dict(id='b',timestamp='2026-10-13',amount='-2'),dict(id='a',timestamp='2026-10-12',amount='3')]
  self.assertEqual(running_balance(rows,50),[{'day':'2026-10-12','balance_cents':350},{'day':'2026-10-13','balance_cents':150}])
 def test_live_metadata(self):
  old=importer.API_REVISION
  try:
   importer.API_REVISION='public-new-revision'
   self.assertEqual(report_metadata(),{'api_revision':'public-new-revision'})
  finally: importer.API_REVISION=old
'''
    hidden = '''import unittest, copy, importer
from report import running_balance, report_metadata
class HiddenV2(unittest.TestCase):
 def row(self,id,day,amount,revision=0): return dict(id=id,timestamp=day,amount=amount,revision=revision)
 def test_sorted_balance(self):
  rows=[self.row('c','2026-10-14','-1'),self.row('a','2026-10-12','2'),self.row('b','2026-10-13','3')]
  self.assertEqual(running_balance(rows,-100),[{'day':'2026-10-12','balance_cents':100},{'day':'2026-10-13','balance_cents':400},{'day':'2026-10-14','balance_cents':300}])
 def test_dedup_and_utc(self):
  rows=[self.row('a','2026-10-12T00:30:00+02:00','5',2),self.row('a','2026-10-13','9',1),self.row('b','2026-10-11','-2')]
  self.assertEqual(running_balance(rows),[{'day':'2026-10-11','balance_cents':300}])
 def test_balance_no_mutation(self):
  rows=[self.row('a','2026-10-12','3')]; prior=copy.deepcopy(rows); running_balance(rows); self.assertEqual(rows,prior)
 def test_balance_no_state(self):
  running_balance([self.row('a','2026-10-12','3')],99); self.assertEqual(running_balance([]),[])
 def test_invalid_opening(self):
  for value in [True,False,1.0,'1',None]:
   with self.subTest(value=value),self.assertRaises(ValueError): running_balance([],value)
 def test_metadata_uses_current_file(self): self.assertEqual(report_metadata(),{'api_revision':importer.API_REVISION})
 def test_metadata_not_frozen(self):
  old=importer.API_REVISION
  try:
   importer.API_REVISION='independent-live-revision'
   self.assertEqual(report_metadata(),{'api_revision':'independent-live-revision'})
  finally: importer.API_REVISION=old
'''
    return docs, public, hidden


def extract_json_answer(text: str) -> dict[str, Any] | None:
    trimmed = text.strip()
    if trimmed.startswith("```") and trimmed.endswith("```"):
        trimmed = "\n".join(trimmed.splitlines()[1:-1])
    try:
        value = json.loads(trimmed)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


def history_recovery_result(result: dict[str, Any], expected: dict[str, str], changed: list[str]) -> bool:
    calls = result.get("calls", [])
    return bool(result.get("ok") is True and result.get("status") == "completed" and calls
                and all(call == "history" for call in calls)
                and extract_json_answer(result.get("answer", "")) == expected and not changed)


def classify(summary: dict[str, Any]) -> dict[str, Any]:
    """Independent artifact criteria. Auxiliary success alone is never acceptance."""
    violations = []
    for phase, changed in summary.get("phase_changes", {}).items():
        allowed = {"parser": {"parser.py"}, "importer": {"importer.py"},
                   "report": {"report.py"}, "readonly": set(), "history": set()}[phase]
        if set(changed) - allowed:
            violations.append({"phase": phase, "out_of_scope": sorted(set(changed) - allowed)})
    phases = summary.get("phase_results", {})
    fail_observed = phases.get("parser", {}).get("failed_tests", 0) > 0
    updated_tests = phases.get("report", {}).get("tool_evidence", [])
    tests_pass = any(e.get("tool") == "test" and e.get("test_exit_zero") for e in updated_tests)
    successes = summary.get("compact_successes", 0)
    expected = {"api_revision": summary["current_marker"], "scope": "read-only",
                "rounding": "ROUND_HALF_UP", "normalization": "NFC", "timezone": "UTC"}
    readonly_answer = extract_json_answer(phases.get("readonly", {}).get("answer", ""))
    criteria = {
        "real_failures_observed": fail_observed,
        "all_work_turns_completed": all(phases.get(name, {}).get("ok") is True
            and phases.get(name, {}).get("status") == "completed"
            for name in ("parser", "importer", "report", "readonly")),
        "three_committed_compactions": successes >= 3,
        "external_contract_was_red": summary.get("v2_initial_public_exit_code", 0) != 0,
        "current_public_tests_pass": tests_pass and summary.get("final_public_exit_code") == 0,
        "hidden_code_acceptance": summary.get("hidden_exit_code") == 0,
        "scope_boundaries_respected": not violations,
        "current_readonly_facts": readonly_answer == expected,
        "credential_and_reasoning_audit_clean": summary.get("audit_clean") is True,
        "fixed_system_prefix_in_every_main_request": summary.get("system_prefix_clean") is True,
        "original_journal_prefixes_unchanged": summary.get("journal_prefixes_unchanged") is True,
        "model_recovered_original_archived_record": summary.get("history_recovery_passed") is True,
    }
    return {"passed": all(criteria.values()), "criteria": criteria, "scope_violations": violations,
            "scope": "production LoopEngine/history/compaction, bounded real Python tools; not native desktop/bash E2E"}


def ledger_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {"input_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
              "output_tokens": 0, "reasoning_tokens": 0}
    reported = 0
    for record in records:
        if isinstance(record.get("usage"), dict):
            reported += 1
            for field in totals:
                totals[field] += record["usage"].get(field, 0)
    auxiliary = [record for record in records if record.get("auxiliary") is True]
    return {"provider_calls": len(records), "auxiliary_calls": len(auxiliary),
            "reported_usage_calls": reported, "tokens": totals,
            "estimated_cny": sum(record.get("estimated_cny", 0) for record in records),
            "unknown_reserve_cny": sum(record.get("unknown_reserve_cny", 0) for record in records),
            "price_basis": "fixed experiment estimate: uncached input 2, cache read 0.04, output 8 CNY/M tokens; not account debit or verified current tariff",
            "provider_elapsed_ms": sum(record.get("elapsed_ms", 0) for record in records),
            "auxiliary_elapsed_ms": sum(record.get("elapsed_ms", 0) for record in auxiliary),
            "max_estimated_request_tokens": max((record.get("estimated_input", {}).get("inputTokens", record.get("estimated_input", {}).get("tokens", 0)) if isinstance(record.get("estimated_input"), dict) else 0 for record in records), default=0)}


def keychain_credential() -> str:
    state = pathlib.Path.home() / "Library/Application Support/com.xlang.xharness/state"
    service = "com.xlang.xharness.models." + sha256(str(state.resolve()))
    result = subprocess.run(["security", "find-generic-password", "-s", service,
                             "-a", "XHARNESS_DEEPSEEK_ONLY_KEY", "-w"],
                            capture_output=True, text=True, check=True)
    key = result.stdout.strip()
    if not key:
        raise RuntimeError("empty Keychain credential")
    return key


class RemoteRunner:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.ssh = ["ssh", "-T", *( ["-S", args.control_path] if args.control_path else ["-o", "ControlPath=none"]),
                    "-o", "ControlMaster=no", "-o", "ForwardAgent=no", "-o", "BatchMode=yes",
                    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=6", args.host]
        result = self.command("sha256sum -- " + shlex.quote(args.binary), check=True)
        if result.stdout.split()[0] != args.expected_binary_sha:
            raise RuntimeError("remote binary fingerprint mismatch before credential retrieval")
        self.stderr_file = (args.output / "stderr.log").open("w")
        self.proc = subprocess.Popen([*self.ssh, shlex.quote(args.binary) + " " + shlex.quote(args.remote_root)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr_file,
                                     text=True, bufsize=1)
        key = keychain_credential()
        self.proc.stdin.write(json.dumps({"api_key": key, "model": args.model}) + "\n")
        self.proc.stdin.flush()
        del key
        ready = self.read_reply()
        expected = json.loads(args.expected_manifest.read_text())
        try:
            verify_manifest(ready.get("runtime_source_manifest", {}), expected)
        except Exception:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
            self.stderr_file.close()
            raise
        (args.output / "ready.json").write_text(json.dumps(ready, indent=2))
        self.replies: list[dict[str, Any]] = []

    def read_reply(self) -> dict[str, Any]:
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("evaluation process exited; inspect sanitized stderr")
        return json.loads(line)

    def call(self, command: dict[str, Any]) -> dict[str, Any]:
        ident = command["id"]
        if not re.fullmatch(r"[a-z][a-z0-9-]*", ident):
            raise ValueError("safe evidence id required")
        (self.args.output / f"{ident}-input.json").write_text(json.dumps(command, ensure_ascii=False, indent=2))
        self.proc.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        reply = self.read_reply()
        if reply.get("id") != ident:
            raise RuntimeError("reply correlation mismatch")
        (self.args.output / f"{ident}-reply.json").write_text(json.dumps(reply, ensure_ascii=False, indent=2))
        self.replies.append(reply)
        result = reply.get("result", {})
        print(ident, canonical_json({field: result[field] for field in ("ok", "status", "error", "failed_tests") if field in result}), flush=True)
        return result

    def command(self, command: str, *, payload: str | None = None, check: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run([*self.ssh, command], input=payload, capture_output=True, text=True, check=check, timeout=90)

    def workspace(self) -> dict[str, dict[str, str]]:
        code = "import pathlib,json,hashlib,sys;r=pathlib.Path(sys.argv[1]);print(json.dumps({p:{'text':(r/p).read_text(),'sha256':hashlib.sha256((r/p).read_bytes()).hexdigest()} for p in ['parser.py','importer.py','report.py']}))"
        result = self.command("python3 -c " + shlex.quote(code) + " " + shlex.quote(self.args.remote_root + "/work"), check=True)
        return json.loads(result.stdout)

    def journal_cut(self, prefix_bytes: int | None = None) -> dict[str, Any]:
        code = "import pathlib,json,hashlib,sys;p=pathlib.Path(sys.argv[1]);b=p.read_bytes();n=int(sys.argv[2]);print(json.dumps({'bytes':len(b),'sha256':hashlib.sha256(b if n<0 else b[:n]).hexdigest()}))"
        result = self.command("python3 -c " + shlex.quote(code) + " " + shlex.quote(self.args.remote_root + "/sessions/eval.jsonl") + " " + str(-1 if prefix_bytes is None else prefix_bytes), check=True)
        return json.loads(result.stdout)

    def public_tests(self, ident: str) -> int:
        result = self.command("cd " + shlex.quote(self.args.remote_root + "/work") + " && PYTHONPATH=. timeout 30 python3 -m unittest discover -s tests -v")
        (self.args.output / f"{ident}-public-tests.txt").write_text(result.stdout + result.stderr)
        return result.returncode

    def hidden_tests(self, hidden: dict[str, str]) -> int:
        remote = self.args.remote_root + "/acceptance"
        install = "import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.mkdir();[(p/k).write_text(v) for k,v in json.load(sys.stdin).items()]"
        self.command("python3 -c " + shlex.quote(install) + " " + shlex.quote(remote), payload=json.dumps(hidden), check=True)
        result = self.command("cd " + shlex.quote(self.args.remote_root + "/work") + " && PYTHONPATH=. timeout 30 python3 -m unittest discover -s " + shlex.quote(remote) + " -v")
        (self.args.output / "hidden-acceptance.txt").write_text(result.stdout + result.stderr)
        return result.returncode

    def close(self) -> None:
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=40)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=20)
        self.stderr_file.close()
        transfer = ["rsync", "-az", "--timeout=90", "-e", " ".join(shlex.quote(part) for part in self.ssh[:-1]),
                    self.args.host + ":" + self.args.remote_root + "/", str(self.args.output / "remote") + "/"]
        subprocess.run(transfer, check=True, timeout=180)


def changed_files(before: dict[str, dict[str, str]], after: dict[str, dict[str, str]]) -> list[str]:
    return sorted(name for name in WRITABLE if before[name]["sha256"] != after[name]["sha256"])


def verify_sanitized_audit(root: pathlib.Path) -> bool:
    """Only public synthetic fixture content is archived; no hidden reasoning field."""
    audits = list((root / "provider-audit").glob("*-request.json"))
    if not audits:
        return False
    for audit in audits:
        messages = json.loads(audit.read_text())
        for message in messages:
            if message.get("reasoning") or message.get("provider_items") or message.get("providerItems"):
                return False
    return True


def verify_main_system_prefix(root: pathlib.Path) -> bool:
    """Fail acceptance when the evaluator ceases to mirror Host prompt replay."""
    records = json.loads((root / "provider-ledger.json").read_text())
    main = [record for record in records if record.get("auxiliary") is False]
    if not main:
        return False
    for record in main:
        path = root / "provider-audit" / f'{record["id"]}-request.json'
        if not path.is_file():
            return False
        messages = json.loads(path.read_text())
        systems = [message for message in messages if message.get("role") == "system"]
        if (len(systems) != 1 or not messages or systems[0] != messages[0]
                or systems[0].get("content") != EVAL_SYSTEM):
            return False
    return True


def run_coding(args: argparse.Namespace) -> None:
    runner = RemoteRunner(args)
    summary: dict[str, Any] = {"mode": "coding", "seed": args.seed, "arm": args.arm, "phase_results": {}, "phase_changes": {},
                               "compact_results": [], "journal_prefixes_unchanged": True,
                               "journal_prefix_checks": [], "current_marker": f"ledger-v2-external-{args.seed}"}
    started = time.monotonic()
    try:
        files, hidden_v1 = base_fixture(args.seed)
        runner.call({"id": "fixture", "op": "install_fixture", "files": files})
        original = runner.workspace()
        phases = [
            ("parser", "Read docs/api.txt, logs/legacy.log and the three CURRENT source files, then run the test tool once before edits. Implement ONLY parse_amount in parser.py under the v1 contract. Do not edit importer.py/report.py yet. Run tests after edits and stop with actual remaining failures, not a claim of full success."),
            ("importer", "Now implement ONLY import_rows in importer.py according to docs/api.txt. Preserve parser.py exactly and do not edit report.py yet. Re-read CURRENT importer.py and the API instead of relying on historical results. Run actual tests, correct importer failures and stop. Report work is not authorized in this phase."),
        ]
        previous = original
        for phase, prompt in phases:
            result = runner.call({"id": phase, "op": "turn", "context": args.context, "output": args.output_tokens, "user": prompt})
            current = runner.workspace()
            summary["phase_results"][phase] = result
            summary["phase_changes"][phase] = changed_files(previous, current)
            (args.output / f"{phase}-workspace.json").write_text(json.dumps(current, indent=2))
            previous = current
            journal_before = runner.journal_cut()
            compact = runner.call({"id": f"compact-{phase}", "op": "maintenance", "context": args.context, "output": args.output_tokens})
            journal_after = runner.journal_cut(journal_before["bytes"])
            summary["journal_prefixes_unchanged"] &= journal_after["sha256"] == journal_before["sha256"]
            summary["journal_prefix_checks"].append({"phase": phase, "before": journal_before,
                                                     "after_original_prefix": journal_after})
            summary["compact_results"].append(compact)
        docs, public_v2, hidden_v2 = updated_contract(args.seed)
        external = {
            "docs/api.txt": docs,
            "tests/test_public.py": public_v2,
            "parser.py": previous["parser.py"]["text"] + "\n# External review complete; preserve this current file.\n",
            "importer.py": previous["importer.py"]["text"] + f'\nAPI_REVISION = "{summary["current_marker"]}"\n',
        }
        runner.call({"id": "external-update", "op": "install_fixture", "files": external})
        previous = runner.workspace()
        summary["v2_initial_public_exit_code"] = runner.public_tests("v2-before-report")
        (args.output / "external-update-workspace.json").write_text(json.dumps(previous, indent=2))
        prompt = "The work scope has changed. The maintainer updated docs/api.txt, tests/test_public.py, parser.py and importer.py OUTSIDE this conversation. Discard the earlier report plan. Read these CURRENT files and run the tests to observe the current failures. This phase may modify ONLY report.py; preserve parser.py/importer.py exactly. Implement daily_totals, running_balance and report_metadata under the current v2 contract, fix the real test failures and run tests again. No publishing/deployment."
        result = runner.call({"id": "report", "op": "turn", "context": args.context, "output": args.output_tokens, "user": prompt})
        current = runner.workspace()
        summary["phase_results"]["report"] = result
        summary["phase_changes"]["report"] = changed_files(previous, current)
        (args.output / "report-workspace.json").write_text(json.dumps(current, indent=2))
        previous = current
        journal_before = runner.journal_cut()
        compact = runner.call({"id": "compact-report", "op": "maintenance", "context": args.context, "output": args.output_tokens})
        journal_after = runner.journal_cut(journal_before["bytes"])
        summary["journal_prefixes_unchanged"] &= journal_after["sha256"] == journal_before["sha256"]
        summary["journal_prefix_checks"].append({"phase": "report", "before": journal_before,
                                                 "after_original_prefix": journal_after})
        summary["compact_results"].append(compact)
        prompt = 'New scope: READ ONLY final audit; do not modify any file or resume previous coding. Read the CURRENT docs/api.txt and all three source files. Answer only one JSON object with exactly these five keys: api_revision (current importer.API_REVISION value), scope ("read-only"), rounding, normalization, timezone. Do not use historical literals when the file changed.'
        result = runner.call({"id": "readonly", "op": "turn", "context": args.context, "output": args.output_tokens, "user": prompt})
        current = runner.workspace()
        summary["phase_results"]["readonly"] = result
        summary["phase_changes"]["readonly"] = changed_files(previous, current)
        (args.output / "readonly-workspace.json").write_text(json.dumps(current, indent=2))
        summary["final_public_exit_code"] = runner.public_tests("final")
        summary["hidden_exit_code"] = runner.hidden_tests({"test_hidden_v1.py": hidden_v1, "test_hidden_v2.py": hidden_v2})
        # The middle record was outside the bounded head/tail excerpt. Rotate
        # the current file, then require exact recovery via production history;
        # rereading a current file or rerunning the old operation is not recovery.
        runner.call({"id": "rotate-log", "op": "install_fixture", "files": {
            "logs/legacy.log": "Current log rotated; previous worker records are no longer in this file.\n"}})
        previous = runner.workspace()
        worker = f"{args.seed}-450"
        prompt = (f"READ ONLY historical evidence recovery. The current log has rotated. Find the ORIGINAL diagnostic hash for worker={worker} in an earlier tool result of this conversation. "
                  "Use ONLY the history tool, search then read the full matching original record; do not call read, write or test, rerun an old operation, or guess a truncated hash. "
                  "Return one JSON object with exactly worker and diagnostic keys; worker is the worker id and diagnostic is its full 64-character hexadecimal hash.")
        result = runner.call({"id": "history-recovery", "op": "turn", "context": args.context,
                              "output": args.output_tokens, "user": prompt})
        summary["phase_results"]["history"] = result
        summary["phase_changes"]["history"] = changed_files(previous, runner.workspace())
        expected_record = {"worker": worker, "diagnostic": sha256(worker)}
        summary["history_recovery_passed"] = history_recovery_result(
            result, expected_record, summary["phase_changes"]["history"])
        summary["history_expected_record"] = expected_record
        metrics = runner.call({"id": "metrics", "op": "metrics"})
        summary["compact_successes"] = len(metrics.get("summaries", []))
        summary["compaction_events"] = metrics.get("compaction_events", [])
        summary["resummarized_checkpoint_sources"] = resummarized_sources(metrics)
        summary["process_memory_kib"] = metrics.get("process_memory_kib", {})
        summary["ledger"] = ledger_metrics(metrics.get("provider_calls", []))
    finally:
        summary["wall_ms"] = round((time.monotonic() - started) * 1000)
        runner.close()
        summary["audit_clean"] = verify_sanitized_audit(args.output / "remote")
        summary["system_prefix_clean"] = verify_main_system_prefix(args.output / "remote")
        (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    acceptance = classify(summary)
    (args.output / "acceptance.json").write_text(json.dumps(acceptance, ensure_ascii=False, indent=2))
    print("INDEPENDENT_ACCEPTANCE", canonical_json(acceptance), flush=True)


def resummarized_sources(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    checkpoint_seqs = {replacement["seq"] for replacement in metrics.get("replacements", [])}
    violations = []
    for event in metrics.get("compaction_events", []):
        if event.get("type") != "compaction/summary":
            continue
        sources = set(event.get("data", {}).get("shadowedSeqs", []))
        repeated = sorted(sources & checkpoint_seqs)
        if repeated:
            violations.append({"summary_seq": event["seq"], "old_checkpoint_seqs": repeated})
    return violations


def run_stress(args: argparse.Namespace) -> None:
    """Separate architecture-pressure tests; synthetic summary scores are not coding quality."""
    runner = RemoteRunner(args)
    summary: dict[str, Any] = {"mode": "stress", "seed": args.seed, "arm": args.arm,
                               "results": {}, "quality_checks": {}}
    started = time.monotonic()
    try:
        files, _ = base_fixture(args.seed)
        runner.call({"id": "fixture", "op": "install_fixture", "files": files})
        before = runner.workspace()
        result = runner.call({"id": "closed-observation-pressure", "op": "turn", "context": 16384,
                              "output": 2048, "pressure_ratio": 0.2,
                              "user": "Read logs/legacy.log then docs/api.txt and run the actual public tests once. This is READ ONLY diagnosis of the original code: do not edit files. Return only JSON with keys task='ledger', rounding='ROUND_HALF_UP', timezone='UTC'. Use history if you need an archived result."})
        after = runner.workspace()
        summary["results"]["closed-observation-pressure"] = result
        summary["quality_checks"]["readonly_pressure_completed"] = (
            result.get("ok") is True and result.get("status") == "completed")
        summary["quality_checks"]["readonly_pressure_no_source_edits"] = not changed_files(before, after)
        summary["quality_checks"]["readonly_pressure_current_facts"] = extract_json_answer(result.get("answer", "")) == {"task": "ledger", "rounding": "ROUND_HALF_UP", "timezone": "UTC"}
        def message(text: str) -> dict[str, str]:
            return {"role": "user", "content": text, "reasoning": ""}
        noise = ''.join(f'read log {i:04d}: system=csv status=healthy event=K{i:04d}\n' for i in range(1400))
        source = [message('Task is the ledger importer; no publication/deployment was approved. ' + noise),
                  message('Current correction: UTC; NFC identifiers are case-sensitive; highest revision wins; rounding ROUND_HALF_UP. Failing test test_utc; active files importer.py/report.py.')]
        source.extend(message(f'Read-only diagnostic observation {i}') for i in range(6))
        result = runner.call({"id": "skewed-summary", "op": "compact", "context": 32768,
                              "output": 1024, "messages": source})
        summary["results"]["skewed-summary"] = result
        text = result.get("text", "")
        summary["quality_checks"]["skewed_all_technical_fields"] = all(field in text for field in ('UTC', 'NFC', 'ROUND_HALF_UP', 'test_utc', 'importer.py', 'report.py'))
        summary["quality_checks"]["skewed_task_scope"] = bool(re.search(r'ledger', text, re.I))
        summary["quality_checks"]["skewed_publication_constraint"] = bool(re.search(r'(no|not|never|unapproved|without|prohibit|forbid).{0,100}(publish|publication|deploy)|(publish|publication|deploy).{0,100}(not|unapproved|prohibit|forbid)', text, re.I | re.S))
        marker = f'END-{args.seed}'
        result = runner.call({"id": "unicode-summary", "op": "compact", "context": 8192,
                              "output": 1024, "messages": [message(('金额半入舍入；时区 UTC；标识不改大小写🙂\n' * 750) + ' Exact final marker ' + marker)]})
        summary["results"]["unicode-summary"] = result
        summary["quality_checks"]["unicode_marker"] = marker in result.get("text", "")
        metrics = runner.call({"id": "metrics", "op": "metrics"})
        summary["compaction_events"] = metrics.get("compaction_events", [])
        summary["resummarized_checkpoint_sources"] = resummarized_sources(metrics)
        summary["process_memory_kib"] = metrics.get("process_memory_kib", {})
        summary["ledger"] = ledger_metrics(metrics.get("provider_calls", []))
    finally:
        summary["wall_ms"] = round((time.monotonic() - started) * 1000)
        runner.close()
        summary["audit_clean"] = verify_sanitized_audit(args.output / "remote")
        summary["system_prefix_clean"] = verify_main_system_prefix(args.output / "remote")
        (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    criteria = summary["quality_checks"] | {"audit_clean": summary["audit_clean"],
                  "fixed_system_prefix_in_every_main_request": summary["system_prefix_clean"],
                  "both_direct_summaries_completed": all(summary["results"][name].get("ok") is True for name in ("skewed-summary", "unicode-summary"))}
    acceptance = {"passed": all(criteria.values()), "criteria": criteria,
                  "scope": "real DeepSeek, synthetic bounded SummaryRunner pressure plus actual read-only LoopEngine; not multi-round coding acceptance"}
    (args.output / "acceptance.json").write_text(json.dumps(acceptance, indent=2))
    print("STRESS_ACCEPTANCE", canonical_json(acceptance), flush=True)


def compare_runs(inputs: list[pathlib.Path]) -> dict[str, Any]:
    runs = []
    for path in inputs:
        summary = json.loads((path / "summary.json").read_text())
        acceptance = json.loads((path / "acceptance.json").read_text())
        ready = json.loads((path / "ready.json").read_text())
        runs.append({"directory": str(path.resolve()), "seed": summary["seed"], "arm": summary["arm"],
                     "runtime_sha256": ready["runtime_source_manifest"]["runtime_sha256"],
                     "runtime_files": ready["runtime_source_manifest"].get("files", {}),
                     "mode": summary.get("mode", "coding"),
                     "passed": acceptance["passed"], "criteria": acceptance["criteria"],
                     "wall_ms": summary["wall_ms"], "process_memory_kib": summary.get("process_memory_kib", {}),
                     "resummarized_checkpoint_sources": summary.get("resummarized_checkpoint_sources", []),
                     **summary["ledger"]})
    # Never silently pair a mislabeled or missing control; retain rejected rows.
    pairs, excluded = [], []
    for mode, seed in sorted({(row["mode"], row["seed"]) for row in runs}):
        arms = {arm: [row for row in runs if row["seed"] == seed and row["mode"] == mode and row["arm"] == arm] for arm in ("baseline", "candidate")}
        if any(len(arms[arm]) != 1 for arm in arms):
            excluded.append({"seed": seed, "reason": "requires exactly one result per arm"})
            continue
        before, after = arms["baseline"][0], arms["candidate"][0]
        changed_runtime = sorted(name for name in set(before["runtime_files"]) | set(after["runtime_files"])
                                 if "/src/" in name and name.endswith(".rs")
                                 and before["runtime_files"].get(name) != after["runtime_files"].get(name))
        if before["runtime_sha256"] == after["runtime_sha256"] or not changed_runtime:
            excluded.append({"seed": seed, "reason": "identical production source fingerprint"})
            continue
        pairs.append({"mode": mode, "seed": seed, "baseline": before, "candidate": after})
    aggregates = {}
    for mode in sorted({row["mode"] for row in runs}):
        aggregates[mode] = {}
        for arm in ("baseline", "candidate"):
            rows = [pair[arm] for pair in pairs if pair["mode"] == mode]
            if rows:
                aggregates[mode][arm] = {"samples": len(rows), "passed": sum(row["passed"] for row in rows),
                    "mean_provider_calls": statistics.mean(row["provider_calls"] for row in rows),
                    "mean_auxiliary_calls": statistics.mean(row["auxiliary_calls"] for row in rows),
                    "median_wall_ms": statistics.median(row["wall_ms"] for row in rows),
                    "mean_auxiliary_ms": statistics.mean(row["auxiliary_elapsed_ms"] for row in rows),
                    "estimated_cny": sum(row["estimated_cny"] for row in rows),
                    "unknown_reserve_cny": sum(row["unknown_reserve_cny"] for row in rows),
                    "resummarized_checkpoints": sum(len(row["resummarized_checkpoint_sources"]) for row in rows)}
    return {"runs": runs, "valid_pairs": pairs, "excluded_pairs": excluded, "aggregate": aggregates,
            "interpretation": "small repeated sample; report quality and calls/cost separately, not generalized superiority"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare-manifest")
    prepare.add_argument("--source-root", type=pathlib.Path, required=True)
    compare = sub.add_parser("compare")
    compare.add_argument("runs", nargs="+", type=pathlib.Path)
    compare.add_argument("--output", type=pathlib.Path, required=True)
    run = sub.add_parser("run")
    run.add_argument("--host", default="WZU_Server")
    run.add_argument("--control-path")
    run.add_argument("--binary", required=True)
    run.add_argument("--expected-binary-sha", required=True)
    run.add_argument("--expected-manifest", type=pathlib.Path, required=True)
    run.add_argument("--remote-root", required=True)
    run.add_argument("--output", type=pathlib.Path, required=True)
    run.add_argument("--arm", choices=("baseline", "candidate"), required=True)
    run.add_argument("--seed", type=int, default=111)
    run.add_argument("--model", default="deepseek-flash")
    run.add_argument("--mode", choices=("coding", "stress"), default="coding")
    run.add_argument("--context", type=int, default=32768)
    run.add_argument("--output-tokens", type=int, default=4096)
    args = parser.parse_args()
    if args.command == "prepare-manifest":
        root = args.source_root.resolve()
        manifest = source_manifest(root)
        dest = root / "crates/xharness-host-app/examples" / MANIFEST_NAME
        dest.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        print(canonical_json({"manifest": str(dest), "runtime_sha256": manifest["runtime_sha256"], "files": len(manifest["files"])}))
    elif args.command == "compare":
        args.output.write_text(json.dumps(compare_runs(args.runs), ensure_ascii=False, indent=2))
    else:
        if not re.fullmatch(r"[0-9a-f]{64}", args.expected_binary_sha):
            raise ValueError("verified SHA-256 binary identity required")
        if not args.remote_root.startswith("/") or args.remote_root == "/" or ".." in pathlib.PurePosixPath(args.remote_root).parts:
            raise ValueError("new absolute isolated remote root required")
        args.output.mkdir(parents=True, exist_ok=False)
        if args.mode == "coding":
            run_coding(args)
        else:
            run_stress(args)


if __name__ == "__main__":
    main()
