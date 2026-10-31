#!/usr/bin/env python3
"""Offline gates for opt-in tool-result experiments; no SSH, keys or model calls."""
from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
PROJECTION = ROOT / "experiments/tool-result-ablation"
CODING = ROOT / "experiments/tool-result-coding-ablation"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load offline experiment: {path.name}")
    module = importlib.util.module_from_spec(spec)
    previous = list(sys.path)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = previous
    return module


class OfflineExperimentTests(unittest.TestCase):
    def run_offline(self, script: Path, output: Path, *args: str):
        result = subprocess.run(
            [sys.executable, "-B", str(script), "--output", str(output), *args],
            cwd=ROOT, text=True, capture_output=True, timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_all_python_sources_parse_without_running_live_entrypoints(self):
        for directory in (PROJECTION, CODING):
            for path in directory.glob("*.py"):
                with self.subTest(path=path.name):
                    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    def test_projection_scorer_positive_negative_and_type_controls(self):
        runner = load(PROJECTION / "run.py", "projection_ablation_offline")
        cases = runner.cases([0, 1, 2, 3, 4, 5])
        self.assertEqual(len(cases), 48)
        self.assertEqual(len({c["id"] for c in cases}), 48)
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertFalse(runner.grade(case, "not-json")['success'])
                self.assertFalse(runner.grade(case, "{}")['success'])
                if case["family"] == "code_patch":
                    rule = json.loads(case["results"][0]["content"])["text"]
                    fee = int(re.search(r"plus (\d+) ONLY", rule)[1])
                    cutoff = int(re.search(r"n>(\d+)", rule)[1])
                    expression = ("0 if n <= 0 else (n+batch-1)//batch + "
                                  f"({fee} if n>{cutoff} else 0)")
                    self.assertTrue(runner.grade(case, runner.dump({
                        "expression": expression,
                    }))['success'])
                    self.assertFalse(runner.grade(case, runner.dump({
                        "expression": "n//batch",
                    }))['success'])
                    self.assertFalse(runner.grade(case, runner.dump({
                        "expression": "__import__('os').system('true')",
                    }))['success'])
                else:
                    self.assertTrue(runner.grade(case, runner.dump(case['golden']))['success'])
                    self.assertFalse(runner.grade(case, runner.dump({
                        **case['golden'], "unexpected": True,
                    }))['success'])
                    if case["family"] == "paged_search":
                        self.assertFalse(runner.grade(case, runner.dump({
                            **case['golden'], "port": str(case['golden']['port']),
                        }))['success'])

    def test_both_coding_fixture_sets_pass_actual_positive_negative_controls(self):
        with tempfile.TemporaryDirectory(prefix="tool-result-fixture-ci-") as tmp:
            for name in ("validate_fixtures.py", "validate_targeted_fixtures.py"):
                with self.subTest(script=name):
                    output = Path(tmp) / name.removesuffix(".py")
                    self.run_offline(CODING / name, output)
                    receipt = json.loads((output / "fixture-validation.json").read_text())
                    self.assertEqual(receipt["status"], "passed")
                    self.assertEqual(len(receipt["rows"]), 36)
                    self.assertTrue(all(r["all_passed"] and r["negative_initial_failed"]
                                        for r in receipt["rows"]))

    def test_coding_prepare_only_freezes_protocol_without_credential_access(self):
        with tempfile.TemporaryDirectory(prefix="tool-result-prepare-ci-") as tmp:
            for name, strategies in (("run.py", 6), ("run_targeted.py", 2)):
                with self.subTest(script=name):
                    output = Path(tmp) / name.removesuffix(".py")
                    self.run_offline(CODING / name, output, "--prepare-only")
                    original = (output / "protocol.json").read_bytes()
                    self.run_offline(CODING / name, output, "--prepare-only")
                    self.assertEqual(original, (output / "protocol.json").read_bytes())
                    protocol = json.loads(original)
                    self.assertEqual(len(protocol["strategies"]), strategies)
                    self.assertFalse(protocol["compaction"])
                    self.assertEqual(len(json.loads((output / "cases.json").read_text())), 12)
                    self.assertEqual(list((output / "results").iterdir()), [])

    def test_projection_prepare_only_does_not_require_bridge_or_key(self):
        with tempfile.TemporaryDirectory(prefix="tool-result-projection-ci-") as tmp:
            output = Path(tmp) / "prepared"
            self.run_offline(PROJECTION / "run.py", output, "--prepare-only",
                             "--key-file", str(Path(tmp) / "nonexistent-key"))
            protocol = json.loads((output / "protocol.json").read_text())
            self.assertEqual(len(protocol["variants"]), 7)
            self.assertEqual(len(json.loads((output / "cases.json").read_text())), 24)
            self.assertFalse((output / "production-projections.json").exists())

    def test_published_receipts_keep_failures_and_experiment_scope(self):
        projection = json.loads((PROJECTION / "results-20261031.json").read_text())
        self.assertEqual(projection["paired_cases"] * 7, projection["trials"])
        coding = json.loads((CODING / "results-20261031.json").read_text())
        cohorts = list(coding["cohorts"].values())
        self.assertEqual(sum(c["sessions"] for c in cohorts), coding["sessions"])
        self.assertEqual(sum(c["phase_evaluations"] for c in cohorts), coding["continuation_turns"])
        self.assertEqual(sum(c["hidden_assertion_executions"] for c in cohorts), coding["executed_hidden_assertions"])
        self.assertFalse(coding["production_source_modified"])
        targeted = coding["cohorts"]["targeted-matrix"]
        self.assertEqual(targeted["groups"]["typed_targeted"]["all_stages_verified"], 11)
        self.assertTrue(targeted["failures"], "Retained failures must not disappear from the report")


if __name__ == "__main__":
    unittest.main()
