#!/usr/bin/env python3
"""Offline evaluator regressions; these are not real-model acceptance."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

PATH = pathlib.Path(__file__).with_name("compaction-multiround.py")
SPEC = importlib.util.spec_from_file_location("multiround", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValidationContract(unittest.TestCase):
    def test_changed_source_manifest_rejected(self):
        actual = {"version": 1, "files": {"engine.rs": "old"},
                  "runtime_sha256": MODULE.sha256(MODULE.canonical_json({"engine.rs": "old"}))}
        expected = copy.deepcopy(actual)
        MODULE.verify_manifest(actual, expected)
        actual["files"]["engine.rs"] = "new"
        with self.assertRaisesRegex(RuntimeError, "no fixture or model request sent"):
            MODULE.verify_manifest(actual, expected)

    def test_new_runtime_file_changes_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = ["Cargo.toml", "Cargo.lock", "crates/xharness-core/src/engine.rs", "crates/xharness-core/src/compaction.rs", "crates/xharness-context/src/lib.rs", "crates/xharness-compaction/src/planner.rs", "crates/xharness-session/src/session.rs", "crates/xharness-session/src/event.rs"]
            for name in paths:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("initial\n")
            before = MODULE.source_manifest(root)
            (root / "crates/xharness-context/src/workset.rs").write_text("new module\n")
            after = MODULE.source_manifest(root)
            self.assertNotEqual(before["runtime_sha256"], after["runtime_sha256"])
            self.assertIn("crates/xharness-context/src/workset.rs", after["files"])

    def test_fixture_original_fails_real_hidden_suite(self):
        files, hidden = MODULE.base_fixture(111)
        _, _, hidden_v2 = MODULE.updated_contract(111)
        with tempfile.TemporaryDirectory() as directory:
            work = pathlib.Path(directory) / "work"
            tests = pathlib.Path(directory) / "independent"
            work.mkdir()
            tests.mkdir()
            for name, text in files.items():
                target = work / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            (tests / "test_v1.py").write_text(hidden)
            (tests / "test_v2.py").write_text(hidden_v2)
            result = subprocess.run(["python3", "-m", "unittest", "discover", "-s", str(tests), "-v"], cwd=work, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Ran 23 tests", result.stderr)
            self.assertNotIn("test_v1.py", files)
            self.assertNotIn("test_v2.py", files)

    def green_summary(self):
        return {
            "current_marker": "ledger-v2-external-111", "phase_changes": {},
            "phase_results": {
                "parser": {"ok": True, "failed_tests": 1},
                "importer": {"ok": True},
                "report": {"ok": True, "tool_evidence": [{"tool": "test", "test_exit_zero": True}]},
                "readonly": {"ok": True, "answer": json.dumps({"api_revision": "ledger-v2-external-111", "scope": "read-only", "rounding": "ROUND_HALF_UP", "normalization": "NFC", "timezone": "UTC"})},
            }, "compact_successes": 3, "hidden_exit_code": 0, "audit_clean": True,
            "final_public_exit_code": 0, "v2_initial_public_exit_code": 1,
            "journal_prefixes_unchanged": True,
            "history_recovery_passed": True,
            "system_prefix_clean": True,
        }

    def test_model_claim_does_not_replace_hidden_acceptance(self):
        summary = self.green_summary()
        for result in summary["phase_results"].values():
            result["status"] = "completed"
        self.assertTrue(MODULE.classify(summary)["passed"])
        summary["hidden_exit_code"] = 1
        summary["phase_results"]["report"]["answer"] = "All tests passed!"
        self.assertFalse(MODULE.classify(summary)["passed"])

    def test_readonly_and_scope_violation_fail(self):
        summary = self.green_summary()
        summary["phase_changes"] = {"report": ["parser.py"], "readonly": ["report.py"]}
        result = MODULE.classify(summary)
        self.assertFalse(result["passed"])
        self.assertEqual(len(result["scope_violations"]), 2)

    def test_exact_archived_record_requires_actual_history_calls_without_edits(self):
        expected = {"worker": "111-450", "diagnostic": MODULE.sha256("111-450")}
        result = {"ok": True, "status": "completed", "calls": ["history", "history"], "answer": json.dumps(expected)}
        self.assertTrue(MODULE.history_recovery_result(result, expected, []))
        for calls in [[], ["read"], ["history", "read"], ["history", "write"]]:
            self.assertFalse(MODULE.history_recovery_result({**result, "calls": calls}, expected, []))
        self.assertFalse(MODULE.history_recovery_result(result, expected, ["report.py"]))
        self.assertFalse(MODULE.history_recovery_result({**result, "answer": json.dumps({**expected, "diagnostic": expected["diagnostic"][:32]})}, expected, []))

    def test_no_transport_error_is_not_completed_when_step_limit_is_reached(self):
        summary = self.green_summary()
        for result in summary["phase_results"].values():
            result["status"] = "completed"
        self.assertTrue(MODULE.classify(summary)["criteria"]["all_work_turns_completed"])
        summary["phase_results"]["report"]["status"] = "limit_reached"
        self.assertFalse(MODULE.classify(summary)["criteria"]["all_work_turns_completed"])

    def test_archive_retention_alone_is_not_model_retrieval_acceptance(self):
        summary = self.green_summary()
        summary["history_recovery_passed"] = False
        result = MODULE.classify(summary)
        self.assertFalse(result["passed"])
        self.assertFalse(result["criteria"]["model_recovered_original_archived_record"])

    def test_external_update_detects_stale_metadata(self):
        docs, public, _ = MODULE.updated_contract(111)
        self.assertIn("CURRENT", docs)
        self.assertIn("public-new-revision", public)
        summary = self.green_summary()
        summary["phase_results"]["readonly"]["answer"] = summary["phase_results"]["readonly"]["answer"].replace("ledger-v2-external-111", "legacy-api")
        self.assertFalse(MODULE.classify(summary)["criteria"]["current_readonly_facts"])

    def test_usage_and_unknown_reserve_separate(self):
        records = [{"auxiliary": True, "estimated_cny": 0.1, "unknown_reserve_cny": 0, "usage": {"input_tokens": 20, "cache_read_tokens": 80, "output_tokens": 3}, "elapsed_ms": 200}, {"auxiliary": False, "unknown_reserve_cny": 0.2, "elapsed_ms": 300}]
        metrics = MODULE.ledger_metrics(records)
        self.assertEqual(metrics["reported_usage_calls"], 1)
        self.assertEqual(metrics["estimated_cny"], 0.1)
        self.assertEqual(metrics["unknown_reserve_cny"], 0.2)
        self.assertEqual(metrics["tokens"]["cache_read_tokens"], 80)
        self.assertEqual(metrics["auxiliary_elapsed_ms"], 200)
        self.assertIn("not account debit", metrics["price_basis"])

    def test_reasoning_audit_rejects_nonempty_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            audits = root / "provider-audit"
            audits.mkdir()
            file = audits / "0-request.json"
            file.write_text(json.dumps([{"role": "user", "content": "public fixture", "reasoning": "", "provider_items": []}]))
            self.assertTrue(MODULE.verify_sanitized_audit(root))
            file.write_text(json.dumps([{"reasoning": "not permitted"}]))
            self.assertFalse(MODULE.verify_sanitized_audit(root))

    def test_system_prefix_is_required_after_replay_and_not_only_first_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            audits = root / "provider-audit"
            audits.mkdir()
            records = [{"id": 0, "auxiliary": False}, {"id": 1, "auxiliary": True},
                       {"id": 2, "auxiliary": False}]
            (root / "provider-ledger.json").write_text(json.dumps(records))
            prefix = [{"role": "system", "content": MODULE.EVAL_SYSTEM}]
            for index in (0, 2):
                (audits / f"{index}-request.json").write_text(json.dumps(prefix + [{"role": "user", "content": "public task"}]))
            self.assertTrue(MODULE.verify_main_system_prefix(root))
            for invalid in ([{"role": "user", "content": "resumed task"}],
                            prefix * 2, [{"role": "system", "content": "changed prefix"}],
                            [{"role": "user", "content": "out of order"}] + prefix):
                (audits / "2-request.json").write_text(json.dumps(invalid))
                self.assertFalse(MODULE.verify_main_system_prefix(root))
        summary = self.green_summary()
        summary["system_prefix_clean"] = False
        self.assertFalse(MODULE.classify(summary)["criteria"]["fixed_system_prefix_in_every_main_request"])

    def test_identical_ab_runtime_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for arm in ("baseline", "candidate"):
                path = pathlib.Path(directory) / arm
                path.mkdir()
                summary = self.green_summary() | {"arm": arm, "seed": 111, "wall_ms": 100, "ledger": MODULE.ledger_metrics([])}
                (path / "summary.json").write_text(json.dumps(summary))
                (path / "acceptance.json").write_text(json.dumps(MODULE.classify(summary)))
                (path / "ready.json").write_text(json.dumps({"runtime_source_manifest": {"runtime_sha256": "same"}}))
                paths.append(path)
            comparison = MODULE.compare_runs(paths)
            self.assertEqual(comparison["valid_pairs"], [])
            self.assertEqual(comparison["excluded_pairs"][0]["reason"], "identical production source fingerprint")

    def test_old_checkpoint_reuse_is_visible_not_inferred_from_text(self):
        metrics = {"replacements": [{"seq": 10}, {"seq": 20}], "compaction_events": [
            {"seq": 9, "type": "compaction/summary", "data": {"shadowedSeqs": [1, 2]}},
            {"seq": 19, "type": "compaction/summary", "data": {"shadowedSeqs": [10, 12]}},
        ]}
        self.assertEqual(MODULE.resummarized_sources(metrics), [{"summary_seq": 19, "old_checkpoint_seqs": [10]}])

    def test_harness_only_fingerprint_difference_is_not_valid_ab(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for arm in ("baseline", "candidate"):
                path = pathlib.Path(directory) / arm
                path.mkdir()
                summary = self.green_summary() | {"arm": arm, "seed": 111, "wall_ms": 100, "ledger": MODULE.ledger_metrics([])}
                (path / "summary.json").write_text(json.dumps(summary))
                (path / "acceptance.json").write_text(json.dumps(MODULE.classify(summary)))
                (path / "ready.json").write_text(json.dumps({"runtime_source_manifest": {"runtime_sha256": arm, "files": {"crates/xharness-core/src/engine.rs": "same-production", "crates/xharness-host-app/examples/compaction_budget_eval.rs": arm}}}))
                paths.append(path)
            self.assertFalse(MODULE.compare_runs(paths)["valid_pairs"])

    def test_no_key_in_arguments_environment_or_reports(self):
        source = PATH.read_text()
        self.assertIn('self.proc.stdin.write(json.dumps({"api_key": key', source)
        self.assertNotIn("--api-key", source)
        self.assertNotIn("os.environ", source)
        self.assertNotIn("env=", source)
        self.assertLess(source.index("remote binary fingerprint mismatch"), source.index("key = keychain_credential()"))
        bridge = PATH.parents[2] / "crates/xharness-host-app/examples/compaction_budget_eval.rs"
        text = bridge.read_text()
        self.assertIn('include_str!("compaction_eval_source_manifest.json")', text)
        self.assertIn('remove("summary")', text)


if __name__ == "__main__":
    unittest.main()
