#!/usr/bin/env python3
"""Opt-in official DeepSeek validation. Rust compilation is REMOTE ONLY.

Credentials travel in encrypted SSH stdin, then child environment; no remote
credential file and no key in argv, source, artifacts or printed output.
"""
import json
from pathlib import Path
import shlex
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
evidence = root / 'docs/evidence/job-continuation-production-20261014'
evidence.mkdir(parents=True, exist_ok=True)
remote = 'codex-build/x-harness-rs/job-continuation-prod-20261014/'
ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'WZU_Server']
subprocess.run(['rsync', '-az', '--exclude=.git/', '--exclude=target/', '--exclude=node_modules/', '--exclude=.env', '--exclude=.env.*', '--exclude=*.pem', '--exclude=*.key', '--exclude=ui/dist/', '--exclude=docs/evidence/job-continuation-production-20261014/remote*', str(root)+'/', 'WZU_Server:'+remote], check=True)
build = subprocess.run(ssh + ['export PATH="$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR=~/codex-build/x-harness-rs/target-unified-jobs-20261013 CARGO_BUILD_JOBS=4; cd ~/'+remote+'; cargo test -p xharness-host-app --test job_continuation --no-run --message-format=json'], capture_output=True, text=True, timeout=900)
(evidence/'remote-live-build.log').write_text(build.stdout+build.stderr)
if build.returncode:
    print(build.stderr)
    sys.exit(build.returncode)
artifacts = [json.loads(line) for line in build.stdout.splitlines() if line.startswith('{')]
binaries = [a['executable'] for a in artifacts if a.get('reason')=='compiler-artifact' and a.get('target',{}).get('name')=='job_continuation' and a.get('executable')]
if len(binaries)!=1:
    raise RuntimeError('expected one exact compiled live test artifact')
keyfile = Path.home() / 'Library/Application Support/XHarness/secrets/deepseek_api_key'
key = keyfile.read_text().strip()
if not key.startswith('sk-'):
    raise RuntimeError('expected existing official DeepSeek credential')
code = '''import json, os, subprocess, sys
p=json.load(sys.stdin)
env=os.environ.copy()
env['XHARNESS_LIVE_DEEPSEEK_KEY']=p['key']
env['XHARNESS_LIVE_DEEPSEEK_MODEL']=p['model']
r=subprocess.run([p['binary'],'live_deepseek_uses_production_defer_and_automatic_continuation','--exact','--ignored','--nocapture'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=210)
sys.stdout.write(r.stdout.replace(p['key'],'[REDACTED]'))
sys.exit(r.returncode)
'''
run = subprocess.run(ssh + ['python3 -c '+shlex.quote(code)], input=json.dumps({'key':key,'model':'deepseek-flash','binary':binaries[0]}), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
output=run.stdout.replace(key,'[REDACTED]')
(evidence/'remote-live-deepseek.log').write_text(output)
print(output)
reports=[]
for line in output.splitlines():
    if line.startswith('LIVE_JOB_REPORT '):
        report=json.loads(line.removeprefix('LIVE_JOB_REPORT '))
        reports.append(report)
(evidence/'live-deepseek.json').write_text(json.dumps({'runs':reports},ensure_ascii=False,indent=2)+'\n')
sys.exit(run.returncode)
