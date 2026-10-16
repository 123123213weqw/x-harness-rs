#!/usr/bin/env python3
"""Remote compilation timings only; never signing, installing or publishing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {'x86_64-apple-darwin': 'darwin-x86_64', 'x86_64-pc-windows-msvc': 'windows-x86_64'}


def commands(target):
    if target not in TARGETS:
        raise ValueError('Unsupported benchmark target')
    desktop = ['--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml']
    host = [('host-release', ['cargo', 'build', '--locked', '--release', '-p', 'xharness-host-app', '--target', target])]
    if TARGETS[target] == 'windows-x86_64':
        host.extend([
            ('sandbox-release', ['cargo', 'build', '--locked', '--release', '-p', 'xharness-sandbox', '--bin', 'xharness-windows-sandbox-runner', '--target', target]),
            ('stage-sandbox', [sys.executable, 'scripts/stage-tauri-sidecar.py',
                               f'target/{target}/release/xharness-windows-sandbox-runner.exe', target,
                               '--name', 'xharness-windows-sandbox-runner']),
        ])
    return host + [
        ('stage-sidecars', [sys.executable, '-B', 'scripts/desktop-release-build.py', 'stage', '--platform', TARGETS[target], '--target', target]),
        ('desktop-tests', ['cargo', 'test', *desktop, '--all-targets', '--target', target]),
        ('desktop-clippy', ['cargo', 'clippy', *desktop, '--all-targets', '--target', target, '--', '-D', 'warnings']),
        ('desktop-release', ['cargo', 'build', *desktop, '--release', '--target', target]),
    ]


def measure(target, phase, mode, cache_hit, output):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('Benchmark compilation is restricted to hosted CI')
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if sha != os.environ['GITHUB_SHA']:
        raise ValueError('Benchmark checkout differs from the exact workflow source')
    report = {'schema': 1, 'diagnosticOnly': True, 'releaseEligible': False, 'sourceSha': sha,
              'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
              'target': target, 'phase': phase, 'workspaceCache': mode, 'exactCacheHit': cache_hit == 'true',
              'rustc': subprocess.check_output(['rustc', '-vV'], text=True),
              'locks': {str(p): hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
                        for p in ['Cargo.lock', 'apps/desktop/src-tauri/Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml']},
              'publicBuildConfig': {k: os.environ.get(k, '') for k in ('XHARNESS_RELEASE_CHANNEL',
                  'XHARNESS_INSTALLATION_ENDPOINT', 'XHARNESS_ACCOUNT_ORIGIN', 'CARGO_PROFILE_RELEASE_DEBUG',
                  'CARGO_PROFILE_RELEASE_STRIP', 'ZSTD_CLEVEL')}, 'steps': [], 'status': 'running'}
    started = time.monotonic()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        if phase == 'warm' and cache_hit != 'true':
            report['invalidSample'] = 'Warm pass did not restore the exact populated cache'
            raise ValueError(report['invalidSample'])
        for name, argv in commands(target):
            before = time.monotonic()
            result = subprocess.run(argv, cwd=ROOT, check=False)
            report['steps'].append({'name': name, 'seconds': round(time.monotonic() - before, 3), 'exitCode': result.returncode})
            if result.returncode:
                raise subprocess.CalledProcessError(result.returncode, argv)
        report['status'] = 'passed'
    finally:
        report['seconds'] = round(time.monotonic() - started, 3)
        if report['status'] != 'passed':
            report['status'] = 'failed'
        output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=TARGETS, required=True)
    parser.add_argument('--phase', choices=['populate', 'warm'], required=True)
    parser.add_argument('--workspace-cache', choices=['dependencies', 'workspace'], required=True)
    parser.add_argument('--cache-hit', default='false')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    measure(args.target, args.phase, args.workspace_cache, args.cache_hit, args.output)
