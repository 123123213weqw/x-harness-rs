#!/usr/bin/env python3
"""Cache corruption, isolation and workflow regressions. Never compiles Rust."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


rg = module('rg_cache', 'portable-rg-cache.py')
bench = module('build_benchmark', 'benchmark-desktop-build.py')


class PortableSearchCache(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'rg'
        self.expected = dict(schema=1, version=rg.VERSION, system='Darwin', machine='arm64',
                             toolchain='1.99.0', rustc='fixture', config='fixture', flags={})
        self.fixture()

    def fixture(self):
        (self.root / 'bin').mkdir(parents=True, exist_ok=True)
        (self.root / 'bin/rg').write_bytes(struct.pack('<II', 0xfeedfacf, 0x0100000c) + b'fixture')
        self.receipt()

    def receipt(self):
        (self.root / 'receipt.json').write_text(json.dumps({**self.expected, 'binary_sha256': rg.digest(self.root / 'bin/rg')}))

    def test_valid_cache_reuses_without_any_cargo_invocation(self):
        with patch.object(rg.subprocess, 'check_output', return_value='ripgrep 15.2.0\nfeatures:-PCRE2\n') as execute, patch.object(rg.subprocess, 'run') as cargo:
            self.assertTrue(rg.ensure(self.root, self.expected))
        cargo.assert_not_called()
        self.assertEqual(execute.call_args.args[0], [str(self.root / 'bin/rg'), '--version'])
        self.assertEqual(execute.call_args.kwargs['timeout'], 10)

    def test_corrupt_binary_is_never_executed(self):
        (self.root / 'bin/rg').write_bytes(b'tampered')
        with patch.object(rg.subprocess, 'check_output') as execute:
            self.assertFalse(rg.valid(self.root, self.expected))
            execute.assert_not_called()

    def test_changed_identity_is_never_executed(self):
        for field in self.expected:
            bad = copy.deepcopy(self.expected)
            bad[field] = 'changed'
            with self.subTest(field=field), patch.object(rg.subprocess, 'check_output') as execute:
                self.assertFalse(rg.valid(self.root, bad))
                execute.assert_not_called()

    def test_cross_architecture_receipt_cannot_hide_wrong_binary(self):
        self.expected['machine'] = 'x86_64'
        self.receipt()
        with patch.object(rg.subprocess, 'check_output') as execute:
            self.assertFalse(rg.valid(self.root, self.expected))
            execute.assert_not_called()

    def test_bad_missing_or_oversize_receipts_are_not_executed(self):
        for value in ('{', '{}', 'x' * 16385, ''):
            (self.root / 'receipt.json').write_text(value)
            with self.subTest(value=value[:10]), patch.object(rg.subprocess, 'check_output') as execute:
                self.assertFalse(rg.valid(self.root, self.expected))
                execute.assert_not_called()
        (self.root / 'receipt.json').unlink()
        self.assertFalse(rg.valid(self.root, self.expected))

    def test_wrong_version_pcre_or_hung_binary_are_rejected(self):
        for value in ('ripgrep 15.1.0\n', 'ripgrep 15.2.0\nfeatures:+PCRE2', ''):
            with self.subTest(value=value), patch.object(rg.subprocess, 'check_output', return_value=value):
                self.assertFalse(rg.valid(self.root, self.expected))
        with patch.object(rg.subprocess, 'check_output', side_effect=subprocess.TimeoutExpired('rg', 10)):
            self.assertFalse(rg.valid(self.root, self.expected))

    def test_invalid_cache_rebuild_is_locked_and_portable(self):
        (self.root / 'receipt.json').unlink()
        with patch.object(rg.subprocess, 'check_output', return_value='ripgrep 15.2.0\n'), \
                patch.object(rg.subprocess, 'run', side_effect=lambda *a, **k: self.fixture()) as cargo:
            self.assertFalse(rg.ensure(self.root, self.expected))
        args = cargo.call_args.args[0]
        self.assertEqual(args[:6], ['cargo', 'install', 'ripgrep', '--version', '15.2.0', '--locked'])
        self.assertIn('--no-default-features', args)
        self.assertTrue(cargo.call_args.kwargs['check'])

    def test_failed_rebuild_does_not_masquerade_as_cache_success(self):
        (self.root / 'receipt.json').unlink()
        with patch.object(rg.subprocess, 'run', side_effect=subprocess.CalledProcessError(2, ['cargo'])), self.assertRaises(subprocess.CalledProcessError):
            rg.ensure(self.root, self.expected)
        self.assertFalse((self.root / 'receipt.json').exists())

    def test_symlink_root_never_deletes_outside_files(self):
        link = Path(self.temp.name) / 'link'
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except OSError:
            self.skipTest('Symlink privilege unavailable')
        with self.assertRaises(ValueError):
            rg.ensure(link, self.expected)
        self.assertTrue((self.root / 'bin/rg').is_file())

    def test_local_execution_is_rejected_before_compiler_queries(self):
        with patch.dict(os.environ, {'CI': 'false'}), patch.object(rg.subprocess, 'check_output') as query, self.assertRaises(ValueError):
            rg.main()
        query.assert_not_called()


class BuildCacheContracts(unittest.TestCase):
    def test_compiler_is_pinned_in_all_ordinary_workflows(self):
        pin = tomllib.loads((ROOT / 'rust-toolchain.toml').read_text())['toolchain']['channel']
        self.assertRegex(pin, r'^\d+\.\d+\.\d+$')
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            for step in re.findall(r'(?ms)^      - uses: dtolnay/rust-toolchain@stable\n(.*?)(?=^      - |\Z)', path.read_text()):
                # The existing explicit historical compiler ablation is intentional.
                if path.name == 'dynamic-projection-comparison.yml':
                    continue
                self.assertIn("toolchain: '" + pin + "'", step, path.name)

    def test_production_profiles_and_safety_checks_remain(self):
        source = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        self.assertIn('CARGO_PROFILE_RELEASE_DEBUG=2', source)
        self.assertIn('CARGO_PROFILE_RELEASE_STRIP=none', source)
        self.assertIn("ZSTD_CLEVEL: '1'", source)
        self.assertIn('cache-workspace-crates: false', source)
        self.assertNotIn('cache-workspace-crates: true', source)
        for preserved in ('Exact Windows one-hop update and data preservation', 'Three production updater rounds', 'Verify and archive exact EXE/PDB pairs', 'signing-gate --platform', 'fetch-in-build --plan'):
            self.assertIn(preserved, source)
        self.assertNotIn('continue-on-error', source)

    def test_portable_cache_ignores_unrelated_workspace_edits_and_prs_cannot_write_it(self):
        for filename in ['ci.yml', 'desktop-release.yml', 'desktop-unix-update-acceptance.yml', 'desktop-macos-preview.yml', 'desktop-update-test.yml']:
            source = (ROOT / '.github/workflows' / filename).read_text()
            self.assertIn('actions/cache/restore@v4', source)
            self.assertIn("hashFiles('rust-toolchain.toml', '.cargo/config.toml', 'scripts/install-portable-rg.sh', 'scripts/portable-rg-cache.py')", source)
            save = source.split('- name: Save verified portable ripgrep cache', 1)[1]
            self.assertIn("github.ref == 'refs/heads/master'", save.split('uses:', 1)[0])
            self.assertIn("outputs.cache-hit != 'true'", save)

    def test_benchmark_is_same_source_on_fresh_jobs_and_cannot_publish(self):
        source = (ROOT / '.github/workflows/desktop-build-benchmark.yml').read_text()
        self.assertIn('needs: populate', source)
        worker = (ROOT / '.github/workflows/desktop-build-benchmark-pass.yml').read_text()
        self.assertIn('benchmark-native-${{ matrix.target }}-${{ matrix.mode }}-${{ github.sha }}', worker)
        self.assertIn("matrix.mode == 'workspace'", worker)
        self.assertIn('contents: read', worker)
        for forbidden in ['secrets.', 'contents: write', 'actions: write', 'desktop-candidate', 'acceptance.json', 'release create', 'release edit', 'tauri signer', 'tauri build']:
            self.assertNotIn(forbidden, worker)
        self.assertIn('if: always()', worker)
        self.assertIn('dist/build-cache/metrics.json', worker)

    def test_benchmark_has_all_compile_gates_and_no_installers(self):
        for target in bench.TARGETS:
            commands = dict(bench.commands(target))
            self.assertEqual(set(commands), {'host-release', 'stage-sidecars', 'desktop-tests', 'desktop-clippy', 'desktop-release'})
            self.assertIn('--locked', commands['host-release'])
            self.assertIn('--all-targets', commands['desktop-tests'])
            self.assertEqual(commands['desktop-clippy'][-3:], ['--', '-D', 'warnings'])
        with self.assertRaises(ValueError):
            bench.commands('unknown')

    def test_benchmark_cannot_run_rust_locally(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), patch.object(bench.subprocess, 'run') as run, self.assertRaises(ValueError):
            bench.measure('x86_64-apple-darwin', 'warm', 'dependencies', 'true', Path('not-written'))
        run.assert_not_called()

    def test_failed_compilation_saves_metrics_and_never_runs_later_stages(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'metrics.json'
            env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                   'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1',
                   'TAURI_SIGNING_PRIVATE_KEY': 'must-not-appear'}
            with patch.dict(os.environ, env), \
                    patch.object(bench.subprocess, 'check_output', side_effect=['a' * 40, 'fixture rustc']), \
                    patch.object(bench.subprocess, 'run', return_value=subprocess.CompletedProcess([], 7)) as run, \
                    self.assertRaises(subprocess.CalledProcessError):
                bench.measure('x86_64-apple-darwin', 'warm', 'dependencies', 'false', output)
            report = json.loads(output.read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['steps'][0]['exitCode'], 7)
            self.assertTrue(report['diagnosticOnly'])
            self.assertFalse(report['releaseEligible'])
            self.assertNotIn('must-not-appear', output.read_text())
            self.assertEqual(run.call_count, 1)

    def test_checkout_mismatch_fails_before_any_compilation(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'GITHUB_SHA': 'a' * 40}), \
                patch.object(bench.subprocess, 'check_output', return_value='b' * 40), \
                patch.object(bench.subprocess, 'run') as run, self.assertRaises(ValueError):
            bench.measure('x86_64-apple-darwin', 'warm', 'dependencies', 'true', Path('not-written'))
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
