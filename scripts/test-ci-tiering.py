#!/usr/bin/env python3
"""Regression contract for the pull-request and release CI tiers.

This is intentionally a source-level test.  It does not compile Rust and keeps
the policy visible when jobs are renamed or packaging steps are added.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
MASTER_ONLY = "github.event_name == 'push' && github.ref == 'refs/heads/master'"


def workflow_source() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def job(source: str, name: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        source,
    )
    if match is None:
        raise AssertionError(f"CI job is missing: {name}")
    return match.group(1)


def assert_step_guarded(test: unittest.TestCase, body: str, step: str) -> None:
    pattern = rf"(?m)^      - name: {re.escape(step)}\n        if: {re.escape(MASTER_ONLY)}$"
    test.assertRegex(body, pattern, f"release-only step lost its master guard: {step}")


class CiTieringContract(unittest.TestCase):
    def test_superseded_runs_are_cancelled(self) -> None:
        source = workflow_source()
        self.assertIn("group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}", source)
        self.assertIn("cancel-in-progress: true", source)

    def test_native_and_web_contracts_install_locked_owned_toolchain(self) -> None:
        source = workflow_source()
        for name in ("ui-build", "ui-contracts", "ui-browser", "ui-parity", "update-channel-contract", "rust-linux", "rust-windows", "rust-macos-arm64", "desktop-linux"):
            with self.subTest(job=name):
                body = job(source, name)
                self.assertIn("actions/setup-node@", body)
                self.assertIn("npm ci --prefix ui --ignore-scripts", body)
                setup = body.index("actions/setup-node@")
                install = body.index("npm ci --prefix ui --ignore-scripts")
                self.assertLess(setup, install)
                script_calls = list(re.finditer(r"(?m)^\s+(?:- run: )?node scripts/", body))
                for call in script_calls:
                    self.assertLess(install, call.start(), "typed contract cannot use an absent toolchain")

    def test_ui_required_check_aggregates_all_shards_fail_closed(self) -> None:
        source = workflow_source()
        body = job(source, "context-layout")
        self.assertIn("name: Harness layout / Chromium + WebKit", body)
        self.assertIn("needs: [ui-build, ui-contracts, ui-browser, ui-parity]", body)
        self.assertIn("if: ${{ always() }}", body)
        self.assertIn("UI_CI_NEEDS: ${{ toJSON(needs) }}", body)
        self.assertIn("node scripts/ci-ui-gate.mjs", body)
        for name in ("ui-contracts", "ui-browser"):
            shard = job(source, name)
            self.assertIn("needs: ui-build", shard)
            self.assertIn("fail-fast: false", shard)
            self.assertIn("shard: [0, 1, 2, 3]", shard)
            self.assertIn("ui-build-${{ github.sha }}", shard)
            self.assertIn("ci-ui-artifact.mjs --verify", shard)
            self.assertIn("if: always()", shard)
        browser = job(source, "ui-browser")
        self.assertIn("browser: [chromium, webkit]", browser)
        self.assertIn("--browser ${{ matrix.browser }}", browser)
        self.assertIn("--shards 4", browser)
        parity = job(source, "ui-parity")
        self.assertLess(parity.index("--phase before"), parity.index("npm run build --prefix ui"))
        self.assertLess(parity.index("npm run build --prefix ui"), parity.index("--phase after"))
        self.assertNotIn("needs: ui-build", parity, "early parity must inspect committed artifacts")

    def test_pull_requests_run_portable_contracts_once(self) -> None:
        body = job(workflow_source(), "update-channel-contract")
        self.assertIn("github.event_name == 'pull_request'", body)
        self.assertIn("'[\"ubuntu-latest\"]'", body)
        self.assertIn("'[\"ubuntu-latest\",\"windows-2025\",\"macos-15\"]'", body)

    def test_native_update_rehearsal_is_release_only(self) -> None:
        body = job(workflow_source(), "unix-update-rehearsal")
        self.assertIn(f"if: {MASTER_ONLY}", body)

    def test_windows_packaging_and_acceptance_are_release_only(self) -> None:
        body = job(workflow_source(), "rust-windows")
        for step in (
            "Build native host and sandbox runner",
            "Package native host",
            "Stage Windows Tauri sidecars",
            "Build installable Windows application",
            "Hash Windows installer",
            "Native installation ownership and crash acceptance",
        ):
            with self.subTest(step=step):
                assert_step_guarded(self, body, step)
        self.assertIn("cargo check --workspace --all-targets", body)
        self.assertIn("cargo clippy --workspace --all-targets -- -D warnings", body)
        self.assertIn("cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets", body)
        self.assertIn("- name: Stage debug Windows sidecars for PR smoke\n        if: github.event_name == 'pull_request'", body)

    def test_macos_packaging_is_release_only_but_desktop_smoke_remains(self) -> None:
        body = job(workflow_source(), "rust-macos-arm64")
        for step in (
            "Build native host",
            "Stage macOS Tauri sidecars",
            "Build installable macOS application",
            "Verify packaged icon, UI and version",
            "Package macOS application",
            "Package native host",
        ):
            with self.subTest(step=step):
                assert_step_guarded(self, body, step)
        smoke_stage = body.index("- name: Stage debug macOS sidecars for PR smoke")
        self.assertIn("if: github.event_name == 'pull_request'", body[smoke_stage:body.index("run: |", smoke_stage)])
        smoke_check = body.index("- name: Check native Tauri desktop shell")
        self.assertNotIn("if:", body[smoke_check:body.index("run: |", smoke_check)])


if __name__ == "__main__":
    unittest.main()
