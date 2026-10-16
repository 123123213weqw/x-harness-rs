"""Git-backed mutations: freeze foundations without freezing tool development."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("architecture_freeze", Path(__file__).with_name("architecture_freeze.py"))
assert SPEC and SPEC.loader
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
ROOT = Path(__file__).resolve().parents[2]


class FreezeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        self.policy = copy.deepcopy(json.loads((ROOT / F.POLICY).read_text(encoding="utf-8")))
        self.write(F.POLICY, json.dumps(self.policy))
        self.native = "crates/xharness-process/src/lib.rs"
        self.tool = "crates/xharness-coding-tools/src/lib.rs"
        self.wire = "crates/xharness-api/src/lib.rs"
        self.install = "apps/desktop/src-tauri/tauri.conf.json"
        self.write(self.native, "pub fn spawn() {}\n")
        self.write(self.tool, "pub fn tools() {}\n")
        self.write(self.wire, 'rpc_methods! {\n    Read => "session.history",\n}\n')
        self.write(self.install, json.dumps({"identifier":"com.xlang.xharness","bundle":{"windows":{"nsis":{"installMode":"currentUser"}}}}))
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return F.git(self.root, *args).decode()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="")

    def result(self):
        return F.check(self.root, self.base)

    def record(self, targets, name="fixture", **overrides):
        data = {"schema":1,"kind":"bugfix","reason":"Correct a reproducible fixture defect.",
                "compatibility":"Keep all existing wire and execution semantics.",
                "paths":{p:{"before":F.digest(F.before(self.root,self.base,p)),"after":F.digest(F.after(self.root,p))} for p in targets},
                "regressions":sorted(F.GROUPS)}
        data.update(overrides)
        path = F.RECORDS + name + ".json"
        self.write(path, json.dumps(data))
        return path

    def test_unchanged_baseline_passes(self):
        self.assertEqual(self.result()[0], [])

    def test_tool_handler_description_schema_and_new_tool_remain_flexible(self):
        self.write(self.tool, 'pub fn tools() { /* new arguments, defaults, description */ }\n')
        self.write("crates/xharness-coding-tools/src/new_tool.rs", "pub fn flexible() {}\n")
        self.write("ui/src/modules/tool/new-card.tsx", "export const card = 'new schema'\n")
        errors, report = self.result()
        self.assertEqual(errors, [])
        self.assertEqual(len(report["flexible_changes"]), 3)
        self.assertEqual(report["protected"], [])

    def test_tool_dependencies_are_flexible_but_shared_and_desktop_manifests_need_review(self):
        self.write("crates/xharness-coding-tools/Cargo.toml", '[dependencies]\nnew_tool_dependency = "1"\n')
        self.assertEqual(self.result()[0], [])
        for path in ["Cargo.toml", "apps/desktop/src-tauri/Cargo.toml"]:
            self.write(path, '[dependencies]\nshared_runtime = "1"\n')
        errors, report = self.result()
        self.assertEqual(len(errors),2)
        self.record(report["protected"])
        self.assertEqual(self.result()[0], [])

    def test_all_six_layers_are_enforced_and_correct_records_pass(self):
        for path in [self.native,"crates/xharness-tools/src/executor.rs","crates/xharness-api/src/protocol.rs",
                     "crates/xharness-session-jsonl/src/recovery.rs","apps/desktop/src-tauri/src/updater.rs","scripts/regression/check-architecture.py"]:
            self.write(path, "// Focused compatible fixture correction.\n")
        errors, report = self.result()
        self.assertEqual(len(errors), 6)
        self.record(report["protected"])
        self.assertEqual(self.result()[0], [])

    def test_staged_and_untracked_foundation_changes_cannot_hide(self):
        self.write(self.native, "pub fn corrected() {}\n")
        self.git("add", self.native)
        new = "crates/xharness-process/src/new.rs"
        self.write(new, "pub fn newly_added() {}\n")
        self.assertEqual(set(self.result()[1]["protected"]), {self.native,new})
        self.record([self.native,new], kind="compatible-addition")
        self.assertEqual(self.result()[0], [])

    def test_deleted_and_renamed_files_need_both_sides(self):
        new = "crates/xharness-process/src/renamed.rs"
        self.git("mv", self.native, new)
        self.record([new])
        self.assertIn(self.native, "\n".join(self.result()[0]))
        self.record([self.native,new])
        self.assertEqual(self.result()[0], [])

    def test_old_record_cannot_waive_a_future_change(self):
        self.write(self.native, "pub fn first_fix() {}\n")
        self.record([self.native])
        self.git("add", "."); self.git("commit", "-qm", "first accepted fixture")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.write(self.native, "pub fn second_fix() {}\n")
        self.assertIn("requires a content-bound", "\n".join(self.result()[0]))

    def test_late_edits_invalidate_the_exact_content_binding(self):
        self.write(self.native, "pub fn fix() {}\n")
        self.record([self.native])
        self.write(self.native, "pub fn changed_after_record() {}\n")
        self.assertIn("stale content binding", "\n".join(self.result()[0]))

    def test_missing_regression_group_and_redesign_are_rejected(self):
        self.write(self.native, "pub fn fix() {}\n")
        self.record([self.native], regressions=["native"])
        self.assertIn("missing regression groups: windows", "\n".join(self.result()[0]))
        self.record([self.native], kind="redesign")
        self.assertIn("not redesign/breaking", "\n".join(self.result()[0]))

    def test_record_cannot_use_globs_escape_or_cover_unchanged_paths(self):
        self.write(self.native, "pub fn fix() {}\n")
        for path in ["../outside", "/tmp/outside", "C:/outside", "crates/**", "crates/./same", self.tool]:
            with self.subTest(path=path):
                self.record([self.native], paths={path:{"before":None,"after":None}})
                self.assertIn("not an exact changed protected path", "\n".join(self.result()[0]))

    def test_base_policy_cannot_be_weakened_in_its_own_change(self):
        self.write(self.native, "pub fn fix() {}\n")
        self.policy["layers"][0]["paths"] = ["crates/not-real/**"]
        self.policy["layers"][0]["regressions"] = ["native"]
        self.write(F.POLICY, json.dumps(self.policy))
        self.record([F.POLICY])
        self.assertIn(self.native, "\n".join(self.result()[0]))
        self.record([F.POLICY,self.native], regressions=["architecture","native"])
        self.assertIn("windows", "\n".join(self.result()[0]))

    def test_application_identity_and_install_mode_cannot_be_waived(self):
        for value in [{"identifier":"other"},{"bundle":{"windows":{"nsis":{"installMode":"perMachine"}}}}]:
            self.write(self.install, json.dumps(value))
            self.record([self.install])
            self.assertIn("cannot waive identity migration", "\n".join(self.result()[0]))

    def test_rpc_additions_are_allowed_but_removal_or_rename_is_not(self):
        self.write(self.wire, 'rpc_methods! {\n    Read => "session.history",\n    New => "feature.new",\n}\n')
        self.record([self.wire], kind="compatible-addition")
        self.assertEqual(self.result()[0], [])
        self.write(self.wire, 'rpc_methods! {\n    New => "feature.new",\n}\n')
        self.record([self.wire])
        self.assertIn("removed/renamed: session.history", "\n".join(self.result()[0]))

    def test_invalid_base_and_missing_git_metadata_fail_with_explicit_base(self):
        for base in ["HEAD", "--help", "0"*40]:
            with self.subTest(base=base):
                self.assertEqual(F.run(self.root,base),1)
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(F.run(Path(directory),self.base),1)

    def test_crlf_checkout_preserves_repository_content_binding(self):
        self.write(self.native, "pub fn fix() {}\n")
        self.record([self.native])
        self.write(self.native, "pub fn fix() {}\r\n")
        self.assertEqual(self.result()[0], [])

    def test_bootstrap_is_explicit_and_still_requires_records(self):
        self.git("rm", F.POLICY); self.git("commit", "-qm", "pre-policy fixture")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.write(F.POLICY,json.dumps(self.policy))
        self.assertTrue(self.result()[1]["bootstrap"])
        self.assertIn(F.POLICY,"\n".join(self.result()[0]))
        self.record([F.POLICY], kind="compatible-addition")
        self.assertEqual(self.result()[0],[])

    def test_flexible_tool_paths_cannot_mask_a_protected_path(self):
        self.policy["flexible"].append("crates/xharness-process/**")
        self.write(F.POLICY,json.dumps(self.policy))
        self.write(self.native,"pub fn fix() {}\n")
        self.record([F.POLICY,self.native])
        self.assertIn("ambiguous protected/flexible", "\n".join(self.result()[0]))

    def test_record_generator_binds_current_files_but_does_not_waive_hard_pins(self):
        self.write(self.native,"pub fn fix() {}\n")
        F.write_record(self.root,self.base,"generated","bugfix","Correct the native fixture defect.","Preserve existing execution semantics.")
        self.assertEqual(self.result()[0],[])
        self.write(self.install,'{"identifier":"other"}')
        F.write_record(self.root,self.base,"generated","bugfix","Correct the native fixture defect.","Preserve existing execution semantics.")
        self.assertIn("cannot waive identity migration","\n".join(self.result()[0]))
        with self.assertRaises(ValueError):
            F.write_record(self.root,self.base,"../escape","bugfix","Long enough fixture explanation.","Long enough compatibility rationale.")

    def test_no_record_is_needed_or_created_for_tool_only_work(self):
        self.write(self.tool,"pub fn flexible_new_schema() {}\n")
        self.assertIsNone(F.write_record(self.root,self.base,"tool-only","bugfix","Correct a flexible tool implementation.","Preserve shared executor boundaries."))
        self.assertFalse((self.root/F.RECORDS).exists())

    def test_policy_validation_rejects_unknown_groups_and_unsafe_paths(self):
        for key,value in [("paths",["../escape"]),("regressions",["skip-windows"])]:
            candidate=copy.deepcopy(self.policy); candidate["layers"][0][key]=value
            with self.assertRaises(ValueError):F.load_policy(candidate)


if __name__ == "__main__":
    unittest.main()
