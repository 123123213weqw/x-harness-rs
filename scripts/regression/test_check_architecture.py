"""Mutation tests for the managed Host architecture boundary."""

import importlib.util
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
