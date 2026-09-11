"""Zero-model official oracle/verifier check in a throwaway grader-only container.

Never reuse or commit this container as an agent image: it contains the oracle.
Only the structured result is printed; solutions and grader details stay private.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
from dependency_proxy import DependencyProxy
from environment_preflight import grade_evidence

TASKS = ('cancel-async-tasks', 'build-cython-ext', 'log-summary-date-ranges')
SOURCE_COMMIT = '441c807dbec2ee32e1da572e24e58d52a4eb7afa'


def verify_bundle(path, expected):
    if not expected or len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
        raise ValueError('a lowercase SHA-256 is required for a forwarded bundle')
    with path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise ValueError('forwarded bundle hash mismatch')
    return actual


def run(args):
    task = args.tasks.resolve() / args.task
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    name = 'xhbench-oracle-' + uuid.uuid4().hex[:12]
    bundle_hash = None
    if args.source_bundle:
        if args.task != 'build-cython-ext':
            raise ValueError('source bundle only applies to the Cython oracle fixture')
        bundle_hash = verify_bundle(args.source_bundle, args.source_sha256)
    with tempfile.TemporaryDirectory(prefix='xhbench-deps-') as directory:
        proxy = DependencyProxy(Path(directory) / 'deps.sock', seconds=1200)
        def docker(*argv, timeout=30):
            return subprocess.run(['docker', *argv], timeout=timeout, check=True, capture_output=True, text=True)
        def command(command, logfile, timeout):
            with (output / logfile).open('w') as stream:
                return subprocess.run(['docker', 'exec', name, 'python3', '/opt/bench/proxy_exec.py',
                                       'bash', '-c', command], stdout=stream, stderr=subprocess.STDOUT,
                                      timeout=timeout).returncode
        try:
            docker('run', '-d', '--rm', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '2g',
                   '--mount', f'type=bind,src={directory},dst=/opt/benchmark-dependencies,readonly',
                   '--mount', f'type=bind,src={Path(__file__).parent.resolve()},dst=/opt/bench,readonly',
                   f'alexgshaw/{args.task}:20251031', 'sleep', '1200')
            # Neutral OS tools only. Never upgrade the task's Python/Cython/NumPy.
            code = command('apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 update && '
                           'apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 install -y curl ripgrep procps && '
                           'mkdir -p /logs/agent /logs/verifier', 'prepare.log', 240)
            if code:
                raise RuntimeError('neutral dependency installation failed')
            if args.task == 'build-cython-ext':
                # Grader-only fixture: the shipped oracle assumes the checkout
                # requested in instruction.md already exists. Never add this to
                # a scored agent's initial image or count it as agent work.
                source = 'https://github.com/SPOCKnots/pyknotid.git'
                if args.source_bundle:
                    docker('cp', str(args.source_bundle.resolve()), name + ':/tmp/pyknotid.bundle')
                    code = command('sha256sum /tmp/pyknotid.bundle', 'source-hash.log', 10)
                    copied_hash = (output / 'source-hash.log').read_text().split()[0]
                    if code or copied_hash != bundle_hash:
                        raise ValueError('copied source bundle hash mismatch')
                    source = '/tmp/pyknotid.bundle'
                code = command(f'git clone --depth 1 --branch 0.5.3 {source} /app/pyknotid && '
                               f'test "$(git -C /app/pyknotid rev-parse HEAD)" = {SOURCE_COMMIT}',
                               'oracle-fixture.log', 120)
                if code:
                    raise RuntimeError('oracle-only source fixture failed')
            docker('cp', str(task / 'solution'), name + ':/solution')
            code = command('bash /solution/solve.sh', 'oracle.log', 300)
            if code:
                raise RuntimeError('official oracle execution failed')
            docker('cp', str(task / 'tests'), name + ':/tests')
            command('bash /tests/test.sh', 'verifier.log', 300)
            docker('cp', name + ':/logs/verifier/.', str(output))
            reward = float((output / 'reward.txt').read_text().strip())
            ctrf = json.loads((output / 'ctrf.json').read_text())
            result = dict(task=args.task, model_requests=0,
                          source_bundle_sha256=bundle_hash,
                          oracle_fixture_checkout=args.task == 'build-cython-ext', **grade_evidence(reward, ctrf))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            result = {'task': args.task, 'status': 'INFRA_ERROR', 'model_requests': 0,
                      'error_type': type(error).__name__}
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
            proxy.stop()
        (output / 'preflight-result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
        return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tasks', type=Path, required=True)
    parser.add_argument('--task', choices=TASKS, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-bundle', type=Path)
    parser.add_argument('--source-sha256')
    raise SystemExit(run(parser.parse_args()))
