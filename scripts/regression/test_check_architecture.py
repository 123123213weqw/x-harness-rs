"""Mutation tests for the managed Host architecture boundary."""

import importlib.util
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).with_name("check-architecture.py")
SPEC = importlib.util.spec_from_file_location("check_architecture", SOURCE)
assert SPEC and SPEC.loader
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class ManagedHostPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".clippy.toml").write_text("allow-expect-in-tests = true\nallow-unwrap-in-tests = true\nallow-expect-in-consts = false\nallow-unwrap-in-consts = false\n")
        self.host = self.root / "crates" / "xharness-host" / "src"
        (self.host / "rpc").mkdir(parents=True)
        (self.host / "lib.rs").write_text("mod example_processor;\n")
        (self.host / "example_processor.rs").write_text("#![forbid(unsafe_code)]\nuse xharness_api::RpcError;\n")
        (self.host / "rpc" / "example.rs").write_text(
            "use crate::example_processor::ExampleProcessor;\n"
        )
        self.policy = {
            "managedModules": [
                {
                    "id": "example",
                    "stateOwner": "Example state",
                    "source": "example_processor.rs",
                    "entrypoint": "rpc/example.rs",
                    "allowedConsumers": [],
                    "allowedCrates": ["xharness_api"],
                }
            ]
        }

    def check(self) -> list[str]:
        return CHECKER.check_managed_host_modules(self.root, self.policy)

    def test_declared_boundary_passes(self) -> None:
        self.assertEqual(self.check(), [])

    def test_unsafe_guard_cannot_be_deleted_downgraded_or_spoofed(self) -> None:
        for header in [
            "", "#![allow(unsafe_code)]", "#![warn(unsafe_code)]",
            "#![deny(unsafe_code)]", "#[forbid(unsafe_code)]",
            "#![cfg_attr(any(), forbid(unsafe_code))]",
            "// #![forbid(unsafe_code)]", "/* #![forbid(unsafe_code)] */",
            'const FAKE: &str = "#![forbid(unsafe_code)]";',
            "#[cfg(any())] mod hidden { #![forbid(unsafe_code)] }",
            "/* unterminated #![forbid(unsafe_code)]",
        ]:
            with self.subTest(header=header):
                (self.host / "example_processor.rs").write_text(header + "\nuse xharness_api::RpcError;\n")
                self.assertIn("requires unconditional", "\n".join(self.check()))

    def test_real_guard_after_documentation_and_nested_comments_passes(self) -> None:
        for header in [
            "//! Business policy\n\n#![forbid(unsafe_code)]",
            "/* copyright /* nested */ text */\n#![forbid(unsafe_code)]",
            "#![ forbid ( unsafe_code ) ] // compiler guard",
        ]:
            with self.subTest(header=header):
                (self.host / "example_processor.rs").write_text(header + "\nuse xharness_api::RpcError;\n")
                self.assertEqual(self.check(), [])

    def test_new_internal_dependency_is_rejected(self) -> None:
        (self.host / "example_processor.rs").write_text(
            "#![forbid(unsafe_code)]\nuse xharness_api::RpcError;\nuse xharness_session::Session;\n"
        )
        self.assertIn("undeclared internal crates", "\n".join(self.check()))

    def test_undeclared_direct_consumer_is_rejected(self) -> None:
        (self.host / "runtime.rs").write_text(
            "use crate::example_processor::ExampleProcessor;\n"
        )
        self.assertIn("bypasses", "\n".join(self.check()))

    def test_explicit_bootstrap_consumer_does_not_allow_other_bypasses(self) -> None:
        self.policy["managedModules"][0]["allowedConsumers"] = ["bootstrap.rs"]
        (self.host / "bootstrap.rs").write_text("use crate::example_processor::ExampleProcessor;\n")
        self.assertEqual(self.check(), [])
        (self.host / "runtime.rs").write_text("use crate::example_processor::ExampleProcessor;\n")
        self.assertIn("runtime.rs: bypasses", "\n".join(self.check()))

    def test_missing_entrypoint_and_duplicate_owner_are_rejected(self) -> None:
        self.policy["managedModules"][0]["entrypoint"] = "rpc/missing.rs"
        self.assertIn("missing source or entrypoint", "\n".join(self.check()))
        self.policy["managedModules"][0]["entrypoint"] = "rpc/example.rs"
        self.policy["managedModules"].append(
            {**self.policy["managedModules"][0], "source": "other_processor.rs"}
        )
        errors = "\n".join(self.check())
        self.assertIn("unique state owner", errors)


class RemoteInteractionSeamPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".clippy.toml").write_text("allow-expect-in-tests = true\nallow-unwrap-in-tests = true\nallow-expect-in-consts = false\nallow-unwrap-in-consts = false\n")
        for relative in set(CHECKER.SOURCE_BOUNDARIES) | set(CHECKER.FORBIDDEN_SOURCE_FRAGMENTS) | CHECKER.ERROR_BOUNDARIES:
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(CHECKER.BUSINESS_ERROR_GUARD)
        (self.root / "crates/xharness-host/src/lib.rs").write_text("")
        self.baseline = self.root / "baseline.json"
        self.baseline.write_text("{}")
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({"version": 1, "managedModules": []}))

    def run_checker(self) -> tuple[int, str]:
        output = io.StringIO()
        # This disposable fixture tests dependency/source seams, not a Git diff.
        # The independent freeze mutation suite exercises the real freeze gate.
        with patch("sys.argv", ["check-architecture.py"]), patch.object(
            CHECKER.runpy, "run_path", return_value={"run": lambda _root, _base: 0}
        ), patch.object(CHECKER, "ROOT", self.root), patch.object(CHECKER, "BASELINE", self.baseline), patch.object(CHECKER, "HOST_POLICY", self.policy), contextlib.redirect_stdout(output):
            result = CHECKER.main()
        return result, output.getvalue()

    def test_empty_declared_seams_pass_real_checker(self) -> None:
        self.assertEqual(self.run_checker()[0], 0)

    def test_interaction_ticket_observer_and_catalog_raw_rpc_bypasses_fail(self) -> None:
        for relative in ["crates/xharness-remote/src/media.rs", "crates/xharness-channel-telegram/src/media.rs", "crates/xharness-remote/src/command_replies.rs", "crates/xharness-channel-telegram/src/commands.rs", "crates/xharness-remote/src/projection.rs", "crates/xharness-channel-telegram/src/output.rs", "crates/xharness-remote/src/catalogue.rs", "crates/xharness-remote/src/tickets.rs", "crates/xharness-remote/src/routing.rs", "crates/xharness-channel-telegram/src/interactions.rs"]:
            for token in ["backend.respond(response)", "backend.call(id,method,payload)", "backend.mux_events()"]:
                with self.subTest(source=relative, token=token):
                    file = self.root / relative
                    file.write_text(token)
                    result, output = self.run_checker()
                    self.assertEqual(result, 1)
                    self.assertIn(relative + ": forbidden coupling", output)
                    file.write_text(CHECKER.BUSINESS_ERROR_GUARD)

    def test_platform_observer_cannot_import_api_host_agent_or_core(self) -> None:
        relative = "crates/xharness-channel-telegram/src/commands.rs"
        for token in ["xharness_api::ApiBackend", "xharness_host::BasicHost", "xharness_core::AgentLoop", "xharness_agent::Agent"]:
            with self.subTest(token=token):
                (self.root / relative).write_text(token)
                self.assertEqual(self.run_checker()[0], 1)


class BusinessErrorGuardTests(unittest.TestCase):
    def test_all_required_lints_need_unconditional_deny_and_production_forbid(self):
        lints = sorted(CHECKER.BUSINESS_ERROR_LINTS)
        good = CHECKER.BUSINESS_ERROR_GUARD
        self.assertTrue(CHECKER.has_business_error_guards("//! docs\n/* nested /* x */ */\n#![forbid(unsafe_code)]\n" + good))
        for source in ["", good.replace("forbid", "deny"), good.replace("forbid", "warn"),
                       "// " + good, "/* " + good + " */", "const S: &str = " + json.dumps(good) + ";",
                       "#![cfg_attr(not(test), forbid(" + ",".join(lints) + "))]",
                       "mod child { " + good + " }", "fn first() {}\n" + good]:
            with self.subTest(source=source):
                self.assertFalse(CHECKER.has_business_error_guards(source))
        for missing in lints:
            self.assertFalse(CHECKER.has_business_error_guards(good.replace(missing, "different_lint")))
        for bypass in [good.replace("not(test)", "test"), good.replace("not(test)", "not(debug_assertions)"), good.split("\n",1)[1]]:
            self.assertFalse(CHECKER.has_business_error_guards(bypass))

    def test_scope_automatically_includes_new_managed_processors(self):
        paths = CHECKER.business_error_sources({"managedModules":[{"source":"new_processor.rs"}]})
        self.assertIn("crates/xharness-host/src/new_processor.rs", paths)
        self.assertTrue(set(CHECKER.SOURCE_BOUNDARIES) <= paths)
        self.assertTrue(CHECKER.ERROR_BOUNDARIES <= paths)

    def test_production_type_exemption_or_disabled_test_policy_cannot_bypass_guard(self):
        good = "allow-expect-in-tests = true\nallow-unwrap-in-tests = true\nallow-expect-in-consts = false\nallow-unwrap-in-consts = false\n"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for config in ["", good + 'allow-unwrap-types = ["Result"]',
                           good.replace("allow-expect-in-tests = true", "allow-expect-in-tests = false"),
                           good.replace("allow-unwrap-in-tests = true", "allow-unwrap-in-tests = false"),
                           good.replace("allow-expect-in-consts = false", "allow-expect-in-consts = true"),
                           good.replace("allow-unwrap-in-consts = false", "allow-unwrap-in-consts = true")]:
                with self.subTest(config=config):
                    (root/".clippy.toml").write_text(config)
                    self.assertIn(".clippy.toml", CHECKER.check_business_error_guards(root,{"managedModules":[]})[0])

    def test_deleted_guard_or_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".clippy.toml").write_text("allow-expect-in-tests = true\nallow-unwrap-in-tests = true\nallow-expect-in-consts = false\nallow-unwrap-in-consts = false\n")
            policy = {"managedModules":[]}
            paths = CHECKER.business_error_sources(policy)
            guard = CHECKER.BUSINESS_ERROR_GUARD
            for name in paths:
                path = root/name
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(guard)
            self.assertEqual(CHECKER.check_business_error_guards(root,policy),[])
            path = root/sorted(paths)[0]
            path.write_text("")
            self.assertEqual(len(CHECKER.check_business_error_guards(root,policy)),1)
            path.unlink()
            self.assertEqual(len(CHECKER.check_business_error_guards(root,policy)),1)


if __name__ == "__main__":
    unittest.main()
