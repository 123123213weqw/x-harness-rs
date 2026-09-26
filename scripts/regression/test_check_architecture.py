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
        (self.host / "example_processor.rs").write_text("use xharness_api::RpcError;\n")
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

    def test_new_internal_dependency_is_rejected(self) -> None:
        (self.host / "example_processor.rs").write_text(
            "use xharness_api::RpcError;\nuse xharness_session::Session;\n"
        )
        self.assertIn("undeclared internal crates", "\n".join(self.check()))

    def test_undeclared_direct_consumer_is_rejected(self) -> None:
        (self.host / "runtime.rs").write_text(
            "use crate::example_processor::ExampleProcessor;\n"
        )
        self.assertIn("bypasses", "\n".join(self.check()))

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
