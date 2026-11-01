#!/usr/bin/env python3
"""Forward an existing keychain credential to V100 stdin, never argv/env/disk."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', required=True, help='Absolute isolated server output directory; parent must exist')
p.add_argument('--local-log', required=True)
p.add_argument('--repeats', type=int, default=3)
p.add_argument('--concurrency', type=int, default=2)
p.add_argument('--tasks')
p.add_argument('--wait-for-success', help='Wait for a server-only evaluator report with passed:true before starting paid trials')
p.add_argument('--ssh-host', default='WZU_Server')
p.add_argument('--ssh-option', action='append', default=[])
args = p.parse_args()
state = Path.home() / 'Library/Application Support/com.xlang.xharness/state'
service = 'com.xlang.xharness.models.' + hashlib.sha256(str(state.resolve()).encode()).hexdigest()
credential = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', 'XHARNESS_DEEPSEEK_ONLY_KEY', '-w'], capture_output=True, text=True, timeout=20)
if credential.returncode or not credential.stdout.strip():
    sys.exit('Existing evaluation credential unavailable; no key was printed or persisted')
command = ''
if args.wait_for_success:
    path = shlex.quote(args.wait_for_success)
    command += f'for i in $(seq 1 180); do test -f {path} && break; sleep 2; done; '
    check = 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(r.passed!==true)process.exit(2);'
    command += 'node -e ' + shlex.quote(check) + ' ' + path + ' && '
command += 'cd ~/codex-build/x-harness-rs/browser-use-parity-20261022 && '
runner_hash = hashlib.sha256(Path(__file__).with_name('ab-runner.mjs').read_bytes()).hexdigest()
command += 'test "$(sha256sum scripts/browser_use/ab-runner.mjs | head -c 64)" = ' + shlex.quote(runner_hash) + ' && '

command += 'XHARNESS_BROWSER_TEST_SERVER=1 BROWSER_AB_REFERENCE_MODULE="$HOME/codex-build/x-harness-rs/browser-use-ab-20261022/reference-zcode-3c5b2276/ab-reference.mjs" '
command += 'BROWSER_AB_CHROMIUM="$HOME/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell" '
command += 'node scripts/browser_use/ab-runner.mjs '
command += ' '.join(shlex.quote(value) for value in [f'--output={args.output}', f'--repeats={args.repeats}', f'--concurrency={args.concurrency}'])
if args.tasks:
    command += ' ' + shlex.quote(f'--tasks={args.tasks}')
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6']
for option in args.ssh_option:
    ssh += ['-o', option]
ssh += [args.ssh_host, command]
log = Path(args.local_log)
log.parent.mkdir(parents=True, exist_ok=True)
with log.open('w') as stream:
    log.chmod(0o600)
    child = subprocess.Popen(ssh, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    child.stdin.write(json.dumps({'api_key': credential.stdout.strip()}))
    child.stdin.close()
    del credential
    for line in child.stdout:
        sys.stdout.write(line); sys.stdout.flush(); stream.write(line); stream.flush()
    exit_code = child.wait()
print(f'A/B remote process exit: {exit_code}; log: {log}')
sys.exit(exit_code)
