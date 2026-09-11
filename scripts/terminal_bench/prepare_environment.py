"""Build clean neutral task images BEFORE any oracle/agent/test is supplied."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
from dependency_proxy import DependencyProxy
from preflight_oracle import verify_bundle, SOURCE_COMMIT

IMAGES = {
    'cancel-async-tasks': 'sha256:84c7fae6b256dcc56a350790e2a9715eefc7dad662a9d8e8a472363aa71ef18d',
    'build-cython-ext': 'sha256:3612a38fadb89a96f74a1a951fb0b0af734198fd160571eeaba6401593234594',
    'log-summary-date-ranges': 'sha256:cbeb6ba905c2fec294f16cd5e16e3ea7f2e04d38ac2484d51a11de262aa7dc51',
}


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    name = 'xhbench-prepare-' + uuid.uuid4().hex[:12]
    base = f'alexgshaw/{args.task}@{IMAGES[args.task]}'
    source_bundle = getattr(args, 'source_bundle', None)
    source_hash = None
    if source_bundle:
        if args.task != 'build-cython-ext':
            raise ValueError('source mirror is only defined for Cython task')
        source_hash = verify_bundle(source_bundle, args.source_sha256)
    with tempfile.TemporaryDirectory(prefix='xhbench-prepare-') as directory:
        proxy = DependencyProxy(Path(directory) / 'deps.sock', seconds=600)
        def docker(*argv, timeout=30):
            return subprocess.run(['docker', *argv], check=True, capture_output=True, text=True, timeout=timeout).stdout
        try:
            docker('run', '-d', '--rm', '--network', 'none', '--name', name, '--cpus', '1', '--memory', '2g',
                   '--mount', f'type=bind,src={directory},dst=/opt/benchmark-dependencies,readonly',
                   '--mount', f'type=bind,src={Path(__file__).parent.resolve()},dst=/opt/bench,readonly',
                   base, 'sleep', '600')
            before = json.loads(docker('exec', name, 'python3', '-m', 'pip', 'list', '--format=json'))
            # Transport-only source change in this container; retain Debian's
            # Signed-By keyring and suites. Never touch host APT/network config.
            command = ("sed -i 's|^URIs: http://deb.debian.org/|URIs: https://mirrors.tuna.tsinghua.edu.cn/|' "
                       '/etc/apt/sources.list.d/debian.sources && '
                       'apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=30 update && '
                       'apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=30 install -y curl ripgrep procps && '
                       'command -v curl && command -v rg && command -v ps')
            with (output / 'prepare.log').open('w') as log:
                subprocess.run(['docker', 'exec', name, 'python3', '/opt/bench/proxy_exec.py', 'sh', '-c', command],
                               check=True, timeout=480, stdout=log, stderr=subprocess.STDOUT)
            after = json.loads(docker('exec', name, 'python3', '-m', 'pip', 'list', '--format=json'))
            if before != after:
                raise ValueError('neutral preparation changed Python packages')
            if source_bundle:
                # Mirror only the original public repository. No checkout in
                # /app and no oracle-built artifact; both agents must clone it.
                docker('exec', name, 'mkdir', '-p', '/opt/benchmark-sources')
                docker('cp', str(source_bundle.resolve()), name + ':/opt/benchmark-sources/source.bundle')
                copied = docker('exec', name, 'sha256sum', '/opt/benchmark-sources/source.bundle').split()[0]
                if copied != source_hash:
                    raise ValueError('copied source mirror checksum mismatch')
                docker('exec', name, 'git', 'clone', '--bare', '/opt/benchmark-sources/source.bundle',
                       '/opt/benchmark-sources/pyknotid.git')
                commit = docker('exec', name, 'git', '-C', '/opt/benchmark-sources/pyknotid.git',
                                'rev-parse', 'refs/tags/0.5.3').strip()
                if commit != SOURCE_COMMIT:
                    raise ValueError('source mirror version mismatch')
                docker('exec', name, 'git', 'config', '--system',
                       'url.file:///opt/benchmark-sources/pyknotid.git.insteadOf',
                       'https://github.com/SPOCKnots/pyknotid.git')
            # This container has never received a task, solution, model or tests.
            image_id = docker('commit', name, timeout=60).strip()
            result = dict(status='PASS', task=args.task, base=base, image_id=image_id,
                          python_packages=before, model_requests=0, oracle_exposed=False,
                          public_source_bundle_sha256=source_hash,
                          apt_mirror='https://mirrors.tuna.tsinghua.edu.cn')
            (output / 'manifest.json').write_text(json.dumps(result, indent=2))
            print(json.dumps({key: result[key] for key in ('status', 'task', 'image_id')}))
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
            proxy.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task', required=True, choices=IMAGES)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-bundle', type=Path)
    parser.add_argument('--source-sha256')
    run(parser.parse_args())
