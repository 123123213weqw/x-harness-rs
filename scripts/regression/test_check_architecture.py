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
        for relative in set(CHECKER.SOURCE_BOUNDARIES) | set(CHECKER.FORBIDDEN_SOURCE_FRAGMENTS):
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("")
        (self.root / "crates/xharness-host/src/lib.rs").write_text("")
        self.baseline = self.root / "baseline.json"
        self.baseline.write_text("{}")
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({"version": 1, "managedModules": []}))

    def run_checker(self) -> tuple[int, str]:
        output = io.StringIO()
        with patch.object(CHECKER, "ROOT", self.root), patch.object(CHECKER, "BASELINE", self.baseline), patch.object(CHECKER, "HOST_POLICY", self.policy), contextlib.redirect_stdout(output):
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
                    file.write_text("")

    def test_platform_observer_cannot_import_api_host_agent_or_core(self) -> None:
        relative = "crates/xharness-channel-telegram/src/commands.rs"
        for token in ["xharness_api::ApiBackend", "xharness_host::BasicHost", "xharness_core::AgentLoop", "xharness_agent::Agent"]:
            with self.subTest(token=token):
                (self.root / relative).write_text(token)
                self.assertEqual(self.run_checker()[0], 1)


if __name__ == "__main__":
    unittest.main()
