#!/usr/bin/env python3
"""No compilation/network. Optimizations must preserve fail-closed acceptance."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def job(source, name):
    return re.search(rf'(?ms)^  {name}:\n(.*?)(?=^  [\w-]+:\n|\Z)', source).group(1)


class LatencyContract(unittest.TestCase):
    def test_exports_are_generated_by_full_workspace_tests_not_duplicate_builds(self):
        source = (ROOT / '.github/workflows/ci.yml').read_text()
        for name in ['rust-linux', 'rust-windows', 'rust-macos-arm64']:
            body = job(source, name)
            full = re.search(r'(?ms)- name: Run workspace tests and export native wire fixtures once\n(.*?)(?=^      - )', body).group(1)
            self.assertIn('cargo test --locked --workspace --all-targets', full)
            self.assertIn('XHARNESS_GITHUB_WIRE_FIXTURE: ${{ runner.temp }}/github-wire.json', full)
            paths = re.findall(r'XHARNESS_GITHUB_WIRE_FIXTURE: (.*)', body)
            self.assertEqual(paths, ['${{ runner.temp }}/github-wire.json'] * 2,
                             'Rust export and strict TS consumer must use the same fresh runner path')
            self.assertIn('node --test scripts/test-github-review.mjs', body)
            self.assertNotIn('cargo test --locked -p xharness-host-app --lib github_service', body)
            self.assertIn('cargo clippy --workspace --all-targets -- -D warnings', body)
            self.assertIn("save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/master' }}", body)
            if name == 'rust-linux':
                for env in ['XHARNESS_SESSION_TERMINAL_EXPORT', 'XHARNESS_FILE_DISPLAY_EXPORT',
                            'XHARNESS_FORK_WIRE_EXPORT', 'XHARNESS_GOAL_REMOTE_FIXTURE', 'XHARNESS_PLUGIN_WIRE_FIXTURE']:
                    self.assertIn(env + ':', full)
                    paths = re.findall(re.escape(env) + r': (.*)', body)
                    self.assertEqual(len(paths), 2)
                    self.assertEqual(paths[0], paths[1])
                for consumer in ['generate-session-terminal-contract.mjs', 'generate-file-display-contract.mjs',
                                 'test-fork-wire-contract.mjs', 'test-goal-remote-contract.mjs', 'test-plugin-wire-contract.mjs']:
                    self.assertIn(consumer, body)
                # This isolated rerun is intentionally different: runtime-drop
                # cleanup must still run without another concurrent Tokio runtime.
                self.assertIn('cargo test --locked -p xharness-process --test process dropping_ -- --test-threads=1', body)

    def test_release_profile_is_set_before_cache_fingerprinting(self):
        source = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        body = job(source, 'build')
        self.assertLess(body.index('CARGO_PROFILE_RELEASE_DEBUG=2'), body.index('Swatinem/rust-cache@v2'))
        self.assertLess(body.index('CARGO_PROFILE_RELEASE_STRIP=none'), body.index('Swatinem/rust-cache@v2'))
        envs = re.search(r'env-vars: (.*)', body).group(1).split()
        self.assertEqual(envs, ['CARGO', 'CC', 'CFLAGS', 'CXX', 'CMAKE', 'RUST',
                               'XHARNESS_ACCOUNT_ORIGIN', 'XHARNESS_INSTALLATION_ENDPOINT', 'XHARNESS_RELEASE_CHANNEL'])
        self.assertNotIn('cache-workspace-crates: true', body, 'Do not bloat the already large native cache blindly')
        self.assertIn('shared-key: desktop-native-${{ matrix.target }}', body)
        self.assertIn('cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets', body)
        self.assertIn('cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets', body)

    def test_update_gates_and_complete_immutable_candidate_are_not_short_circuited(self):
        source = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        self.assertNotIn('continue-on-error', source)
        body = job(source, 'build')
        self.assertIn('Three production updater rounds against the exact signed Unix target', body)
        self.assertIn('Exact Windows one-hop update and data preservation', body)
        self.assertIn('fetch-in-build --plan', body)
        self.assertIn('Independently verify all selected immutable platform receipts and aggregate once', source)
        self.assertIn('node --test scripts/test-ci-ui-timing.mjs', job((ROOT / '.github/workflows/ci.yml').read_text(), 'ui-build'))


if __name__ == '__main__':
    unittest.main()
