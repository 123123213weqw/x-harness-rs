"""Official paired runner. --check and --mock never read or activate real keys."""
import argparse
import asyncio
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import time
from importlib.metadata import version

os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig, VerifierConfig
from harbor.trial.trial import Trial
from broker import Broker
from dependency_proxy import DependencyProxy
from environment_preflight import grade_evidence
import deepseek_agent
from paired_mock import MockConnection
from protocol import OFFICIAL

TASK_REVISION = '7131e4375048a0e408a8fb404b5f499d726b695b'
SOURCE_REVISION = '5fbf964067149ff448ba25b2343a3dae733fe028'
IMAGES = {
    'cancel-async-tasks': 'sha256:051de08970a9b9fe32918a897b29100fc27a5c6825daac525eba96bd65a179c7',
    'build-cython-ext': 'sha256:f3165ea87eb47f2ecfca1f1234867f46e24289968317a5cd23b489202f62db53',
    'log-summary-date-ranges': 'sha256:617c818d28f27f6dc87cdbb96025a839529a01e8a8306ecd7728660313c2c7de',
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def check_assets(args):
    expected = [(args.binary, 'c108aa8ebfd38222c01f9e2b31d33b24d0cad3884a67a348add48039c46f61f5'),
                (args.runtime / 'node', '596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9'),
                (args.runtime / 'dsh-official/package-lock.json', '3330bea6e9351a27c3531ffdbf6f47d6a4ac7da63ed405633aabfdda09173388')]
    for path, expected_hash in expected:
        if sha(path) != expected_hash:
            raise ValueError('frozen runtime artifact mismatch')
    for line in Path(__file__).with_name('python-artifacts.sha256').read_text().splitlines():
        digest, name = line.split()
        if sha(args.wheelhouse / name) != digest:
            raise ValueError('public Python cache mismatch')
    if sorted(p.name for p in args.wheelhouse.iterdir()) != sorted(line.split()[1] for line in Path(__file__).with_name('python-artifacts.sha256').read_text().splitlines()):
        raise ValueError('unexpected artifact in frozen cache')
    # WZU holds the verified GitHub source archive, not a Git checkout. Never
    # walk up into the unrelated host repository to infer its revision.
    archive = args.tasks.resolve().parent.parent / 'tasks-7131e43.tgz'
    archive_hash = sha(archive)
    if archive_hash != '2951abd19f7a866ddcc78e36ffc6b2ae92d4a6e192d4c7b902677c75992b41aa':
        raise ValueError('frozen task archive mismatch')
    with tarfile.open(archive) as bundle:
        for task in IMAGES:
            selected = {m.name.split('/tasks/', 1)[1]: m for m in bundle.getmembers()
                        if m.isfile() and '/tasks/' + task + '/' in m.name}
            actual = {str(p.relative_to(args.tasks)) for p in (args.tasks / task).rglob('*') if p.is_file()}
            if not selected or actual != set(selected):
                raise ValueError('task file inventory mismatch')
            for name, member in selected.items():
                if (args.tasks / name).read_bytes() != bundle.extractfile(member).read():
                    raise ValueError('task content differs from pinned archive')
    for image in IMAGES.values():
        result = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
        if result['Id'] != image:
            raise ValueError('neutral image mismatch')
    if version('harbor') != '0.16.1':
        raise ValueError('Harbor version mismatch')
    return {'source_revision': SOURCE_REVISION, 'task_revision': TASK_REVISION, 'task_archive_sha256': archive_hash,
            'binary_sha256': expected[0][1], 'node_sha256': expected[1][1], 'official_lock_sha256': expected[2][1],
            'official_artifact': '@deepseek-ai/dsh@0.1.5-rc.1', 'official_git_mapping': None,
            'images': IMAGES, 'python_cache_sha256': sha(Path(__file__).with_name('python-artifacts.sha256')),
            'dependencies': {name: version(name) for name in ('harbor', 'litellm', 'openai', 'pydantic')}}


def task_copy(source, target, image):
    # Controller-only copy: only environment metadata changes. Original task
    # instructions, oracle and hidden verifier bytes remain unchanged.
    shutil.copytree(source, target)
    path = target / 'task.toml'
    text = path.read_text()
    original = next(line for line in text.splitlines() if line.startswith('docker_image = '))
    text = text.replace(original, 'docker_image = ' + json.dumps(image))
    text = text.replace('allow_internet = true', 'network_mode = "no-network"')
    text = text.replace('[agent]\n', '[agent]\nnetwork_mode = "no-network"\n')
    text = text.replace('[verifier]\n', '[verifier]\nnetwork_mode = "no-network"\n')
    path.write_text(text)


def mock_task(target):
    (target / 'environment').mkdir(parents=True)
    (target / 'tests').mkdir()
    (target / 'instruction.md').write_text('Create /app/fixture-ready containing ready using the shell, then finish.')
    (target / 'task.toml').write_text('schema_version = "1.1"\n[task]\nname = "xharness/paired-fixture"\n'
        '[agent]\nnetwork_mode = "no-network"\ntimeout_sec = 30\n[verifier]\nnetwork_mode = "no-network"\ntimeout_sec = 30\n[environment]\n'
        'docker_image = ' + json.dumps(next(iter(IMAGES.values()))) + '\ncpus = 1\nmemory_mb = 2048\nnetwork_mode = "no-network"\n')
    (target / 'tests/test.sh').write_text('''#!/bin/bash
set -eu
mkdir -p /logs/verifier
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/app/fixture-ready')
passed = p.exists() and p.read_text() == 'ready'
Path('/logs/verifier/reward.txt').write_text('1' if passed else '0')
Path('/logs/verifier/ctrf.json').write_text(json.dumps({'results': {'summary': {'tests': 1, 'passed': int(passed), 'failed': int(not passed), 'skipped': 0, 'pending': 0, 'other': 0}, 'tests': [{'name': 'marker', 'status': 'passed' if passed else 'failed'}]}}))
PY
''')


def score(root):
    try:
        matches = list(root.rglob('ctrf.json'))
        if len(matches) != 1:
            raise ValueError('one independent verifier report required')
        ctrf = matches[0]
        return grade_evidence(float(ctrf.with_name('reward.txt').read_text()), json.loads(ctrf.read_text()))
    except (OSError, ValueError, KeyError, TypeError):
        return {'status': 'INFRA_ERROR', 'executed': 0, 'failed': None}


async def run(args):
    assets = check_assets(args)
    if args.check:
        print(json.dumps({'asset_preflight': 'PASS', 'model_requests': 0, 'assets': assets}))
        return
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    protocol = OFFICIAL if not args.mock else replace(OFFICIAL, seconds=10 if args.mock == 'timeout' else 30,
                                                       max_calls=3 if args.mock == 'budget' else 8)
    if args.mock:
        order = [('fixture', agent) for agent in ('xharness', 'official')]
        mock_task(root / 'task-configs/fixture')
        MockConnection.mode = args.mock
        credential = 'mock-only'
    else:
        order = [(task, agent) for i, task in enumerate(IMAGES)
                 for agent in (('xharness', 'official') if i % 2 == 0 else ('official', 'xharness'))]
        for task, image in IMAGES.items():
            task_copy(args.tasks / task, root / 'task-configs' / task, image)
        print(json.dumps({'event': 'credential_required', 'transport': 'single stdin JSON line; never argv/files'}), flush=True)
        credential = json.loads(sys.stdin.readline()).pop('api_key')
        if not isinstance(credential, str) or not credential.startswith('sk-'):
            raise ValueError('provider credential missing')
    frozen = dict(protocol.wire(), assets=assets, order=order, mock=args.mock,
                  thinking='enabled', reasoning_effort='high', temperature=1.0, top_p=.95,
                  budget_scope='main + child + auxiliary + retries',
                  timer='native task submission; official CLI launch includes its process startup',
                  task_network='none + shared restricted public artifact proxy/cache',
                  oracle_exposed_to_agent=False, sample_count_per_cell=1)
    frozen['runner_sha256'] = {p.name: sha(p) for p in Path(__file__).parent.glob('*.py')}
    (root / 'protocol.json').write_text(json.dumps(frozen, indent=2))
    reports = []
    with tempfile.TemporaryDirectory(prefix='paired-broker-') as socket_dir, tempfile.TemporaryDirectory(prefix='paired-deps-') as dependency_dir:
        broker = Broker(credential, '127.0.0.1', Path(socket_dir) / 'api.sock',
                        upstream_factory=MockConnection if args.mock else None)
        del credential
        deepseek_agent.BROKER = broker
        deepseek_agent.PROTOCOL = protocol
        try:
            for task, harness in order:
                name = f'{task}--{harness}'
                print(json.dumps({'event': 'start', 'trial': name, 'mock': args.mock}), flush=True)
                dependency = DependencyProxy(Path(dependency_dir) / 'deps.sock', seconds=protocol.seconds + 900)
                mounts = [{'type': 'bind', 'source': str(source), 'target': target, 'read_only': True} for source, target in (
                    (socket_dir, '/opt/benchmark-broker'), (dependency_dir, '/opt/benchmark-dependencies'),
                    (args.runtime.resolve(), '/opt/official'), (args.binary.resolve(), '/opt/xharness/xharness-host'),
                    (args.wheelhouse.resolve(), '/opt/benchmark-wheels'), (Path(__file__).parent.resolve(), '/opt/bench'))]
                config = TrialConfig(task=TaskConfig(path=root / 'task-configs' / task), trial_name=name, trials_dir=root / 'trials',
                    agent=AgentConfig(import_path='deepseek_agent:XHarnessNative' if harness == 'xharness' else 'deepseek_agent:NativeAgent',
                        model_name='deepseek-flash', override_timeout_sec=protocol.seconds + 210, override_setup_timeout_sec=90),
                    environment=EnvironmentConfig(import_path='paired_environment:EvaluationDocker', delete=True,
                        cpu_enforcement_policy='limit', memory_enforcement_policy='limit', mounts=mounts,
                        env={'BENCH_PIP_OFFLINE': '1'}), verifier=VerifierConfig(override_timeout_sec=300))
                started = time.monotonic()
                try:
                    trial = await Trial.create(config)
                    result = (await trial.run()).model_dump(mode='json')
                    exception = result.get('exception_info')
                    metadata = (result.get('agent_result') or {}).get('metadata') or {}
                    row = {'trial': name, 'task': task, 'harness': harness,
                           'termination': metadata.get('termination', 'INFRA_ERROR'),
                           'resources': metadata.get('resources'),
                           'exception_type': exception.get('exception_type') if isinstance(exception, dict) else None}
                except Exception as error:
                    if args.mock:
                        (root / (name + '-mock-error.txt')).write_text(str(error))
                    row = {'trial': name, 'task': task, 'harness': harness, 'termination': 'INFRA_ERROR',
                           'exception_type': type(error).__name__}
                finally:
                    budget = await asyncio.to_thread(deepseek_agent.LEDGER.close, 125) if deepseek_agent.LEDGER else {'requests': 0}
                    deepseek_agent.LEDGER = None
                    broker.ledger = None
                    dependency.stop()
                    socket = Path(dependency_dir) / 'deps.sock'
                    socket.unlink(missing_ok=True)
                row.update(grade=score(root / 'trials' / name), budget=budget, elapsed_seconds=time.monotonic() - started)
                provider_failed = bool(budget.get('rows')) and all(r['status'] != 200 for r in budget['rows'])
                if provider_failed:
                    row['provider_unavailable'] = True
                    row['raw_verifier_grade'] = row['grade']
                    row['grade'] = {'status': 'INFRA_ERROR', 'reason': 'no successful provider request'}
                reports.append(row)
                (root / 'paired-report.json').write_text(json.dumps(reports, indent=2))
                print(json.dumps({'event': 'end', 'trial': name, 'termination': row['termination'],
                                  'grade': row['grade'], 'requests': budget['requests'],
                                  'conservative_usd': budget.get('conservative_usd')}), flush=True)
                if row['grade']['status'] == 'INFRA_ERROR' or budget.get('inflight', 0) or row['termination'] == 'INFRA_ERROR' or provider_failed:
                    break
            missing = order[len(reports):]
            (root / 'unstarted.json').write_text(json.dumps(missing))
            if args.mock:
                expected = {'normal': 'COMPLETED', 'timeout': 'TIMEOUT', 'budget': 'BUDGET_LIMIT'}[args.mock]
                if missing or any(r['grade']['status'] != 'PASS' or r['termination'] != expected for r in reports):
                    raise RuntimeError('paired integration mock failed')
                print(json.dumps({'mock_gate': 'PASS', 'mode': args.mock, 'real_model_requests': 0}), flush=True)
        finally:
            broker.stop()


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('binary', 'runtime', 'tasks', 'wheelhouse', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--mock', choices=('normal', 'timeout', 'budget'))
    asyncio.run(run(parser.parse_args()))
