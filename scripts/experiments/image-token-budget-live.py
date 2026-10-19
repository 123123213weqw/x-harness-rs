#!/usr/bin/env python3
"""Opt-in official DeepSeek image-budget check through the real Rust adapter.

Requires SSH and an explicitly available evaluation credential. No app state is
changed. Credentials travel only in SSH stdin and the remote child's environment.
All Rust compilation is remote. Fixtures are generated with Python's stdlib.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import struct
import subprocess
import zlib

ROOT = Path(__file__).resolve().parents[2]
REMOTE = 'codex-build/x-harness-rs/image-token-budget-20261018'
TEST = 'provider::image_budget_tests::live_official_deepseek_image_allowance'


def fixtures(destination):
    destination.mkdir(parents=True, exist_ok=True)
    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data)))
    for name, width, height in [('tiny', 64, 32), ('square', 512, 512),
                                ('screenshot', 3600, 2400), ('panorama', 8192, 16)]:
        row = b'\0' + b'\xff\0\0' * (width // 2) + b'\0\0\xff' * (width - width // 2)
        data = (b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b''))
        (destination / (name + '.png')).write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path)
    parser.add_argument('--remote', default='WZU_Server')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.fixtures:
        fixtures(args.fixtures)
        return
    if args.output is None:
        parser.error('--output is required for the paid live experiment')
    args.output.mkdir(parents=True, exist_ok=True)
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no',
           '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', args.remote]
    subprocess.run(['rsync', '-az', '--delete', '--exclude=.git/', '--exclude=target/',
                    '--exclude=node_modules/', '--exclude=.env', '--exclude=.env.*',
                    '--exclude=*.pem', '--exclude=*.key', str(ROOT)+'/',
                    args.remote+':'+REMOTE+'/'], check=True)
    setup = ('cd ~/'+REMOTE+'; python3 scripts/experiments/image-token-budget-live.py '
             '--fixtures /tmp/xharness-image-token-budget-20261018')
    subprocess.run(ssh+[setup], check=True)
    command = ('export PATH="$HOME/.cargo/bin:$PATH" '
               'CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/target" CARGO_BUILD_JOBS=6; '
               'cd ~/'+REMOTE+'; touch crates/xharness-provider-openai/src/provider.rs '
               'crates/xharness-provider-openai/src/provider/image_budget_tests.rs; '
               'cargo test --locked -p xharness-provider-openai --lib --no-run --message-format=json')
    built = subprocess.run(ssh+[command], capture_output=True, text=True, timeout=900)
    (args.output/'build.log').write_text(built.stdout+built.stderr)
    if built.returncode:
        raise RuntimeError('remote build failed; see build.log')
    binaries = [row['executable'] for line in built.stdout.splitlines() if line.startswith('{')
                for row in [json.loads(line)] if row.get('reason') == 'compiler-artifact'
                and row.get('target', {}).get('name') == 'xharness_provider_openai'
                and row.get('executable')]
    if len(binaries) != 1:
        raise RuntimeError('expected exactly one provider test executable')
    key = os.environ.get('XHARNESS_IMAGE_BUDGET_KEY') or (
        Path.home()/'Library/Application Support/XHarness/secrets/deepseek_api_key'
    ).read_text().strip()
    if not key or any(c.isspace() for c in key):
        raise RuntimeError('evaluation credential unavailable')
    launcher = '''import json, os, subprocess, sys
p=json.load(sys.stdin)
env=os.environ.copy()
env['XHARNESS_IMAGE_BUDGET_KEY']=p['key']
env['XHARNESS_IMAGE_BUDGET_ROOT']='/tmp/xharness-image-token-budget-20261018'
env['XHARNESS_IMAGE_BUDGET_REPORT']='/tmp/xharness-image-token-budget-20261018/report.json'
r=subprocess.run([p['binary'],p['test'],'--exact','--ignored','--nocapture'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
print(r.stdout.replace(p['key'],'[REDACTED]'),end='')
sys.exit(r.returncode)
'''
    result = subprocess.run(ssh+['python3 -c '+shlex.quote(launcher)],
                            input=json.dumps({'key':key, 'binary':binaries[0], 'test':TEST}),
                            capture_output=True, text=True, timeout=900)
    clean = (result.stdout+result.stderr).replace(key, '[REDACTED]')
    (args.output/'live.log').write_text(clean)
    print(clean, end='')
    subprocess.run(['rsync', '-az', args.remote+':/tmp/xharness-image-token-budget-20261018/',
                    str(args.output/'artifacts')+'/'], check=True)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
