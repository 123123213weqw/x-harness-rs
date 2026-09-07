#!/usr/bin/env python3
"""Hosted-CI orchestration for immutable desktop candidates (never compiles Rust).

The separate desktop-release.py owns the package/manifest cryptographic contract.
This helper owns GitHub provenance, draft immutability and native bundler checks.
Private credentials are only checked for presence; they are never written/logged.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = {
    'windows-x86_64': 'x86_64-pc-windows-msvc',
    'linux-x86_64-appimage': 'x86_64-unknown-linux-gnu',
    'darwin-aarch64': 'aarch64-apple-darwin',
    'darwin-x86_64': 'x86_64-apple-darwin',
}
ACCEPTANCE_WORKFLOWS = {
    'unix': '.github/workflows/desktop-unix-update-acceptance.yml',
    'windows': '.github/workflows/desktop-windows-update-acceptance.yml',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args, capture=False):
    result = subprocess.run([str(a) for a in args], check=True, text=True, encoding='utf-8',
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def load(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), 'Missing or unsafe JSON file')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def api(path):
    return json.loads(run('gh', 'api', path, capture=True))


def contract(*args):
    run(sys.executable, '-B', ROOT / 'scripts/desktop-release.py', *args)


def repository():
    value = os.environ.get('GITHUB_REPOSITORY', '')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+', value), 'Invalid repository')
    require(os.environ.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY') == value, 'Repository has not opted in')
    return value


def hosted():
    require(os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'GitHub-hosted CI only')


def ancestor(repo, older, newer):
    require(re.fullmatch(r'[0-9a-f]{40}', older or '') and re.fullmatch(r'[0-9a-f]{40}', newer or ''), 'Invalid source SHA')
    if older != newer:
        comparison = api(f'repos/{repo}/compare/{older}...{newer}')
        require(comparison['status'] in {'ahead', 'identical'}, 'Source is not in the trusted master ancestry')


def trusted_checkout():
    hosted()
    repo = repository()
    sha = run('git', '-C', ROOT, 'rev-parse', 'HEAD', capture=True)
    workflow_sha = os.environ.get('GITHUB_SHA', '')
    master = api(f'repos/{repo}/git/ref/heads/master')['object']['sha']
    ancestor(repo, workflow_sha, master)
    ancestor(repo, sha, workflow_sha)
    return repo, sha


def public_key(path):
    value = os.environ.get('XHARNESS_UPDATER_PUBKEY', '').strip()
    require(value, 'Missing stable public key')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        stream.write(value + '\n')


def signing_gate(platform, environment=None):
    e = os.environ if environment is None else environment
    names = ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'XHARNESS_UPDATER_PUBKEY']
    if platform.startswith('darwin-'):
        names += ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
                  'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']
    require(all(e.get(name, '').strip() for name in names),
            'Missing formal signing/notarization configuration; no ad-hoc fallback is allowed')
    if platform.startswith('darwin-'):
        require(e['APPLE_SIGNING_IDENTITY'].startswith('Developer ID Application:'),
                'A Developer ID Application identity is required for the stable channel')
        require(re.fullmatch(r'[A-Z0-9]{10}', e['APPLE_TEAM_ID']), 'Invalid Apple team identity')


def stage(platform, target):
    require(PLATFORMS.get(platform) == target, 'Platform/target mismatch')
    suffix = '.exe' if platform == 'windows-x86_64' else ''
    rg = os.environ.get('XHARNESS_RG') if suffix else shutil.which('rg')
    require(rg and Path(rg).is_file(), 'Native ripgrep is not available')
    for source, name in [(ROOT / 'target' / target / 'release' / ('xharness-host' + suffix), 'xharness-host'), (rg, 'rg')]:
        run(sys.executable, '-B', ROOT / 'scripts/stage-tauri-sidecar.py', source, target, '--name', name)


def collect(args):
    require(PLATFORMS.get(args.platform) == args.target, 'Platform/target mismatch')
    plan = load(args.plan)
    root = ROOT / 'apps/desktop/src-tauri/target' / args.target / 'release'
    binary = root / ('xharness-desktop.exe' if args.platform == 'windows-x86_64' else 'xharness-desktop')
    if args.platform.startswith('darwin-'):
        app = root / 'bundle/macos/XHarness.app'
        binary = app / 'Contents/MacOS/xharness-desktop'
        package = root / 'bundle/macos/XHarness.app.tar.gz'
        run('codesign', '--verify', '--deep', '--strict', app)
        details = subprocess.run(['codesign', '-dv', '--verbose=4', str(app)], check=True, capture_output=True, text=True, encoding='utf-8').stderr
        require('Authority=Developer ID Application:' in details and 'Signature=adhoc' not in details,
                'Formal package is not Developer ID signed')
        team = os.environ.get('APPLE_TEAM_ID', '')
        require(re.fullmatch(r'[A-Z0-9]{10}', team) and f'TeamIdentifier={team}\n' in details,
                'Signed application team differs from configured team')
        run('xcrun', 'stapler', 'validate', app)
        run('spctl', '--assess', '--type', 'execute', '--verbose=4', app)
        run(sys.executable, '-B', ROOT / 'scripts/test-desktop-assets.py', '--app', app)
    elif args.platform == 'windows-x86_64':
        package = root / 'bundle/nsis' / f'XHarness_{plan["version"]}_x64-setup.exe'
        run(sys.executable, '-B', ROOT / 'scripts/test-windows-desktop-bundle.py')
    else:
        package = root / 'bundle/appimage' / f'XHarness_{plan["version"]}_amd64.AppImage'
    contract('receipt', '--plan', args.plan, '--platform', args.platform, '--target', args.target,
             '--package', package, '--public-key', args.public_key, '--binary', binary, '--output', args.output)



def verify_tag(repo, tag, sha):
    require(re.fullmatch(r'desktop-v[0-9]+\.[0-9]+\.[0-9]+', tag), 'Unexpected production tag')
    obj = api(f'repos/{repo}/git/ref/tags/{tag}')['object']
    for _ in range(8):
        require(re.fullmatch(r'[0-9a-f]{40}', obj.get('sha', '')), 'Malformed tag object')
        if obj.get('type') == 'commit':
            require(obj['sha'] == sha, 'Remote release tag moved away from the reviewed source')
            return
        require(obj.get('type') == 'tag', 'Release tag does not resolve to a commit')
        obj = api(f'repos/{repo}/git/tags/{obj["sha"]}')['object']
    raise ValueError('Annotated tag nesting exceeds the safe limit')

def snapshot(release):
    keys = ['id', 'tag_name', 'target_commitish', 'name', 'body', 'draft', 'prerelease', 'created_at', 'published_at']
    result = {key: release[key] for key in keys}
    asset_keys = ['id', 'name', 'size', 'digest', 'state', 'created_at', 'updated_at']
    result['assets'] = sorted([{key: asset.get(key) for key in asset_keys} for asset in release['assets']], key=lambda a: a['name'])
    require(len({a['name'] for a in result['assets']}) == len(result['assets']), 'Duplicate release asset names')
    require(all(a['state'] == 'uploaded' for a in result['assets']), 'Release contains incomplete uploads')
    return result


def list_files(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Unsafe artifact directory')
    files = {}
    for item in root.iterdir():
        require(item.is_file() and not item.is_symlink(), 'Artifact must contain only regular flat files')
        files[item.name] = item
    return files


def compare_release_files(root, other):
    expected, actual = list_files(root), list_files(other)
    require(set(expected) == set(actual), 'Draft assets differ from the accepted candidate')
    require(all(digest(expected[name]) == digest(actual[name]) for name in expected), 'Draft asset bytes changed')


def check_run(run_data, repo, sha, path, *, event=None):
    require((sha is None or run_data['head_sha'] == sha) and run_data['path'] == path, 'Workflow source/provenance mismatch')
    require(run_data['status'] == 'completed' and run_data['conclusion'] == 'success', 'Workflow has not succeeded')
    require(run_data.get('head_repository', {}).get('full_name') == repo, 'Workflow came from another repository')
    require(isinstance(run_data.get('run_attempt'), int) and run_data['run_attempt'] > 0, 'Missing run attempt')
    if event:
        require(run_data['event'] == event and run_data['head_branch'] == 'master', 'Acceptance must be dispatched from master')
    else:
        require(run_data['event'] in {'push', 'workflow_dispatch'}, 'Unsupported release trigger')
        if run_data['event'] == 'workflow_dispatch':
            require(run_data['head_branch'] == 'master', 'Release dispatch was not on master')


def successful_run(repo, run_id, sha, path, *, event=None):
    require(re.fullmatch(r'[1-9][0-9]*', str(run_id)), 'Invalid workflow run id')
    value = api(f'repos/{repo}/actions/runs/{run_id}')
    check_run(value, repo, sha, path, event=event)
    if event:
        ancestor(repo, value['head_sha'], api(f'repos/{repo}/git/ref/heads/master')['object']['sha'])
    pages = json.loads(run('gh', 'api', '--paginate', '--slurp',
                          f'repos/{repo}/actions/runs/{run_id}/attempts/{value["run_attempt"]}/jobs?per_page=100', capture=True))
    jobs = [job for page in pages for job in page['jobs']]
    require(jobs and all(j['status'] == 'completed' and j['conclusion'] == 'success' for j in jobs),
            'Every native/matrix gate in the latest attempt must pass; skipped gates do not count')
    return value


def download_artifact(repo, run_data, name, destination):
    destination = Path(destination)
    require(not destination.exists(), 'Refusing to merge or overwrite artifacts')
    pages = json.loads(run('gh', 'api', '--paginate', '--slurp',
                          f'repos/{repo}/actions/runs/{run_data["id"]}/artifacts?per_page=100', capture=True))
    matches = [a for page in pages for a in page['artifacts'] if a['name'] == name]
    require(len(matches) == 1 and not matches[0]['expired'], 'Missing, ambiguous or expired immutable artifact')
    artifact = matches[0]
    require(artifact.get('workflow_run', {}).get('head_sha') == run_data['head_sha'], 'Artifact source differs from run')
    require(artifact['created_at'] >= run_data['run_started_at'], 'Artifact is from an older run attempt')
    run('gh', 'run', 'download', run_data['id'], '--repo', repo, '--name', name, '--dir', destination)
    return {key: artifact.get(key) for key in ['id', 'name', 'digest', 'created_at', 'updated_at']}


def fetch_candidate(run_id, destination):
    repo, sha = trusted_checkout()
    build = successful_run(repo, run_id, sha, '.github/workflows/desktop-release.yml')
    artifact = download_artifact(repo, build, 'desktop-candidate', destination)
    candidate = Path(destination)
    plan = load(candidate / 'plan.json')
    require(plan['repository'] == repo and plan['sha'] == sha and plan['release_run_id'] == str(run_id)
            and plan['release_run_attempt'] == str(build['run_attempt']), 'Candidate plan is not from this exact build attempt')
    if build['event'] == 'push':
        require(build['head_branch'] == plan['tag'], 'Tag build provenance mismatch')
    key = candidate.parent / 'trusted-updater.pub'
    public_key(key)
    contract('verify-release', '--plan', candidate / 'plan.json', '--release-dir', candidate / 'release', '--public-key', key)
    return build, artifact


def download_release(repo, tag, destination, names=None):
    require(re.fullmatch(r'(?:desktop|friends)-v[0-9]+\.[0-9]+\.[0-9]+', tag), 'Unexpected stable release tag')
    require(not Path(destination).exists(), 'Refusing to overwrite a release download')
    arguments = ['gh', 'release', 'download', tag, '--repo', repo, '--dir', destination]
    for name in names or []:
        require(re.fullmatch(r'[A-Za-z0-9_.+-]+', name) and name not in {'.', '..'}, 'Unsafe asset name')
        arguments += ['--pattern', name]
    run(*arguments)


def live_names(manifest, repo, tag):
    names = {'latest.json', 'updater.pub'}
    require(isinstance(manifest.get('platforms'), dict) and manifest['platforms'], 'Live manifest has no platforms')
    for item in manifest['platforms'].values():
        parsed = urlsplit(item['url'])
        prefix = f'/{repo}/releases/download/{tag}/'
        require(parsed.scheme == 'https' and parsed.netloc == 'github.com' and not parsed.query
                and not parsed.fragment and parsed.path.startswith(prefix), 'Live asset is not immutable in this repository/tag')
        name = unquote(parsed.path[len(prefix):])
        require(re.fullmatch(r'[A-Za-z0-9_.+-]+', name) and name not in {'.', '..'}, 'Unsafe live asset path')
        names.update([name, name + '.sig'])
    return sorted(names)


def fetch_promotion(args):
    repo, sha = trusted_checkout()
    root = Path(args.output)
    require(not root.exists(), 'Promotion workspace must be fresh')
    root.mkdir(parents=True)
    build, build_artifact = fetch_candidate(args.release_run_id, root / 'candidate')
    plan = load(root / 'candidate/plan.json')
    runs = {'release': {'run': build, 'artifact': build_artifact}}
    for kind, run_id in [('unix', args.unix_run_id), ('windows', args.windows_run_id)]:
        value = successful_run(repo, run_id, None, ACCEPTANCE_WORKFLOWS[kind], event='workflow_dispatch')
        platforms = [p for p in PLATFORMS if (p == 'windows-x86_64') == (kind == 'windows')]
        artifacts = []
        for platform in platforms:
            dest = root / 'native-evidence' / platform
            artifacts.append(download_artifact(repo, value, f'desktop-acceptance-{platform}', dest))
            receipt = dest / 'acceptance.json'
            require(receipt.is_file() and not receipt.is_symlink(), 'Native acceptance receipt missing')
            binding = load(receipt).get('provenance', {})
            require(binding == {'workflow': ACCEPTANCE_WORKFLOWS[kind], 'run_id': str(value['id']),
                                'run_attempt': str(value['run_attempt']), 'source_sha': sha},
                    'Native receipt is not from this exact authenticated attempt/source')
            compact = root / 'acceptance' / platform
            compact.mkdir(parents=True)
            shutil.copyfile(receipt, compact / 'acceptance.json')
        runs[kind] = {'run': value, 'artifacts': artifacts}
    remote_draft = api(f'repos/{repo}/releases/tags/{plan["tag"]}')
    require(remote_draft['draft'] and not remote_draft['prerelease'], 'Candidate is no longer a private stable draft')
    require(snapshot(remote_draft) == load(root / 'candidate/draft-snapshot.json'), 'Draft changed after candidate staging')
    download_release(repo, plan['tag'], root / 'draft-download')
    compare_release_files(root / 'candidate/release', root / 'draft-download')
    live = api(f'repos/{repo}/releases/latest')
    require(not live['draft'] and not live['prerelease'], 'No public stable channel to preserve')
    download_release(repo, live['tag_name'], root / 'live-manifest', ['latest.json', 'updater.pub'])
    names = live_names(load(root / 'live-manifest/latest.json'), repo, live['tag_name'])
    download_release(repo, live['tag_name'], root / 'live', names)
    write(root / 'live-snapshot.json', snapshot(live))
    write(root / 'provenance.json', runs)


def publish(args):
    repo, sha = trusted_checkout()
    root = Path(args.workspace)
    plan = load(root / 'candidate/plan.json')
    provenance = load(root / 'provenance.json')
    require(plan['sha'] == sha and plan['repository'] == repo, 'Promotion checkout changed')
    for kind, entry in provenance.items():
        path = '.github/workflows/desktop-release.yml' if kind == 'release' else ACCEPTANCE_WORKFLOWS[kind]
        fresh = successful_run(repo, entry['run']['id'], sha if kind == 'release' else None, path, event=None if kind == 'release' else 'workflow_dispatch')
        require(fresh['run_attempt'] == entry['run']['run_attempt'] and fresh['updated_at'] == entry['run']['updated_at'],
                'A build/acceptance run changed or was rerun during promotion')
    verify_tag(repo, plan['tag'], sha)
    # Re-download and re-verify directly before the single publication operation.
    latest = api(f'repos/{repo}/releases/latest')
    require(snapshot(latest) == load(root / 'live-snapshot.json'), 'Live release changed during acceptance/promotion')
    draft = api(f'repos/{repo}/releases/tags/{plan["tag"]}')
    require(snapshot(draft) == load(root / 'candidate/draft-snapshot.json') and draft['draft'], 'Draft changed during promotion')
    download_release(repo, plan['tag'], root / 'final-draft')
    compare_release_files(root / 'candidate/release', root / 'final-draft')
    download_release(repo, latest['tag_name'], root / 'final-live', live_names(load(root / 'live/latest.json'), repo, latest['tag_name']))
    compare_release_files(root / 'live', root / 'final-live')
    contract('promotion', '--plan', root / 'candidate/plan.json', '--release-dir', root / 'final-draft',
             '--acceptance-root', root / 'acceptance', '--live-dir', root / 'final-live',
             '--public-key', root / 'trusted-updater.pub', '--output', root / 'promotion.json')
    require(snapshot(api(f'repos/{repo}/releases/latest')) == snapshot(latest), 'Live pointer raced with final verification')
    require(snapshot(api(f'repos/{repo}/releases/tags/{plan["tag"]}')) == snapshot(draft), 'Draft raced with final verification')
    verify_tag(repo, plan['tag'], sha)
    promote_draft(repo, draft, root)


def public_bytes(url):
    # Intentionally unauthenticated: clients must be able to fetch the rolling
    # channel without the Actions token. Never include remote bodies in errors.
    request = Request(url, headers={'User-Agent': 'XHarness-release-verifier', 'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=15) as response:
        require(urlsplit(response.geturl()).scheme == 'https', 'Public feed redirected away from HTTPS')
        require(response.status == 200, 'Public feed HTTP status is not 200')
        body = response.read(1024 * 1024 + 1)
        require(len(body) <= 1024 * 1024, 'Public feed exceeded its size limit')
        return body


def verify_public_channel(repo, root):
    expected = {name: (root / 'final-draft' / name).read_bytes() for name in ['latest.json', 'updater.pub']}
    # GitHub's public CDN can lag behind the authenticated release API. Retry
    # reads only, with a fixed budget; never republish or mutate assets on failure.
    for attempt, delay in enumerate([0, 2, 5, 10], 1):
        if delay:
            time.sleep(delay)
        try:
            observed = {name: public_bytes(f'https://github.com/{repo}/releases/latest/download/{name}')
                        for name in expected}
            require(observed == expected, 'Public channel bytes differ from the accepted candidate')
        except Exception:
            if attempt == 4:
                raise ValueError('Public channel could not be verified after four bounded reads') from None
        else:
            return {'attempts': attempt, 'authenticated': False,
                    'sha256': {name: hashlib.sha256(body).hexdigest() for name, body in observed.items()}}


def promote_draft(repo, draft, root):
    # Persist intent before the network mutation. A timeout can occur after
    # GitHub committed the PATCH, so that state must never be called "unpublished".
    write(root / 'publication-attempt.json', {'release_id': draft['id'], 'tag': draft['tag_name'],
                                            'state': 'publication_requested'})
    # Address the authenticated immutable release id, not a second tag lookup.
    try:
        run('gh', 'api', '--method', 'PATCH', f'repos/{repo}/releases/{draft["id"]}',
            '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true', capture=True)
    except Exception:
        write(root / 'publication-result.json', {'release_id': draft['id'], 'state': 'publication_unknown'})
        raise ValueError('Publication request failed with uncertain server state; inspect the release id. '
                         'Do not retry publication, delete, overwrite or automatically roll it back') from None
    try:
        published = api(f'repos/{repo}/releases/latest')
        require(published['id'] == draft['id'] and not published['draft'] and not published['prerelease'],
                'Published release is not the expected stable latest')
        before, after = snapshot(draft), snapshot(published)
        require(all(after[key] == value for key, value in before.items() if key not in {'draft', 'published_at'}),
                'Published release metadata or asset identity changed after acceptance')
        write(root / 'published.json', after)
        public = verify_public_channel(repo, root)
    except Exception:
        write(root / 'publication-result.json', {'release_id': draft['id'], 'state': 'published_but_unverified'})
        raise ValueError('Release was already published, but final API/public-channel verification failed. '
                         'Do not delete, overwrite or automatically roll it back') from None
    write(root / 'publication-result.json', {'release_id': draft['id'], 'state': 'published_and_verified', 'public': public})



def export_environment(values):
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output:
        for key, value in values.items():
            require(re.fullmatch(r'[A-Z_]+', key) and '\n' not in str(value) and '\r' not in str(value), 'Unsafe environment projection')
            output.write(f'{key}={value}\n')


def rehearsal_init(destination):
    hosted()
    require(os.environ.get('GITHUB_REF') == 'refs/heads/master' or os.environ.get('GITHUB_EVENT_NAME') in {'pull_request', 'push'}, 'Rehearsals require a CI source event')
    root = Path(destination)
    require(Path(os.environ['RUNNER_TEMP']).resolve() in root.resolve().parents, 'Rehearsal keys must stay in runner temporary storage')
    root.mkdir(mode=0o700)
    (root / 'release').mkdir()
    # Signer generation can print private material: capture and discard its output.
    subprocess.run(['npm', 'exec', '--yes', '--package', '@tauri-apps/cli@2.11.4', '--',
                    'tauri', 'signer', 'generate', '-w', str(root / 'disposable.key'), '-p', '', '--ci'],
                   cwd=ROOT / 'apps/desktop', check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    key = (root / 'disposable.key.pub').read_text(encoding='utf-8').strip()
    repo = os.environ['GITHUB_REPOSITORY']
    endpoint = f'https://github.com/{repo}/releases/latest/download/latest.json'
    values = {'XHARNESS_UPDATER_ENDPOINT': endpoint, 'XHARNESS_UPDATER_PUBKEY': key,
              'TAURI_SIGNING_PRIVATE_KEY': str(root / 'disposable.key'), 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD': ''}
    export_environment(values)
    version = '0.0.902'
    env = {**os.environ, **values}
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/prepare-desktop-test-version.py'), version], check=True, env=env)
    (root / 'release/updater.pub').write_text(key + '\n')
    write(root / 'plan.json', {'rehearsal_only': True, 'version': version, 'sha': run('git', '-C', ROOT, 'rev-parse', 'HEAD', capture=True),
                             'repository': repo, 'tag': 'desktop-v' + version, 'endpoint': endpoint,
                             'release_run_id': os.environ['GITHUB_RUN_ID'], 'release_run_attempt': os.environ['GITHUB_RUN_ATTEMPT']})


def rehearsal_receipt(args):
    plan = load(args.candidate / 'plan.json')
    require(plan.get('rehearsal_only') is True, 'This helper is never a production release receipt producer')
    require(PLATFORMS.get(args.platform) == args.target and args.platform != 'windows-x86_64', 'Invalid Unix platform')
    bundle = ROOT / 'apps/desktop/src-tauri/target' / args.target / 'release/bundle'
    if args.platform.startswith('darwin-'):
        source = bundle / 'macos/XHarness.app.tar.gz'
        architecture = 'aarch64' if args.platform == 'darwin-aarch64' else 'x86_64'
        name = f'XHarness_{plan["version"]}_{architecture}.app.tar.gz'
    else:
        name = f'XHarness_{plan["version"]}_amd64.AppImage'
        source = bundle / 'appimage' / name
    destination = args.candidate / 'release' / name
    shutil.copyfile(source, destination)
    shutil.copyfile(str(source) + '.sig', str(destination) + '.sig')
    key_path = args.candidate / 'release/updater.pub'
    run('node', ROOT / 'scripts/verify-updater-package.mjs', destination, str(destination) + '.sig', key_path)
    signature = Path(str(destination) + '.sig').read_text(encoding='utf-8').strip()
    key_lines = base64.b64decode(key_path.read_text(encoding='utf-8').strip(), validate=True).decode().strip().splitlines()
    packet = base64.b64decode(key_lines[-1], validate=True)
    require(len(packet) == 42 and packet[:2] == b'Ed', 'Unexpected public key packet')
    receipt = {**plan, 'schema_version': 1, 'platform': args.platform, 'target': args.target, 'package': name,
               'package_sha256': digest(destination), 'package_size': destination.stat().st_size,
               'signature': signature, 'public_key_sha256': hashlib.sha256(packet).hexdigest(),
               'embedded_endpoint': plan['endpoint'], 'identifier': 'com.xlang.xharness'}
    write(args.candidate / 'release' / (args.platform + '.receipt.json'), receipt)
    write(args.candidate / 'release/latest.json', {'version': plan['version'], 'notes': 'Disposable rehearsal only; never a publishable release.',
          'platforms': {args.platform: {'signature': signature,
          'url': f'https://github.com/{plan["repository"]}/releases/download/{plan["tag"]}/{name}'}}})
    # Never retain private key material beyond the only step needing it.
    (args.candidate / 'disposable.key').unlink()
    (args.candidate / 'disposable.key.pub').unlink()


def native_target_dir(candidate):
    # Reuse this runner's restored/just-built Cargo cache, not a cold target in
    # the disposable source tree. Packaging may overwrite target/bundle files;
    # the separately copied, signed candidate/release must never overlap it.
    desktop = (ROOT / 'apps/desktop/src-tauri').resolve()
    target = desktop / 'target'
    require(not target.is_symlink(), 'Native Cargo target must not be redirected by a symlink')
    target = target.resolve()
    protected = Path(candidate).resolve()
    require(target != protected and target not in protected.parents and protected not in target.parents,
            'Native Cargo cache must not overlap the immutable candidate')
    return target


def prepare_native(args):
    plan = load(args.candidate / 'plan.json')
    target = native_target_dir(args.candidate)
    run(sys.executable, '-B', ROOT / 'scripts/unix-update-acceptance.py', 'prepare', '--source', ROOT,
        '--root', args.root, '--platform', args.platform, '--base-version', '0.0.901',
        '--target-version', plan['version'], '--public-key', args.candidate / 'release/updater.pub')
    export_environment({**load(args.root / 'build-env.json'), 'CARGO_TARGET_DIR': str(target)})


def native_run(args):
    config = load(args.root / 'rehearsal.json')
    platform = config['platform']
    receipt = args.candidate / 'release' / (platform + '.receipt.json')
    name = load(receipt)['package']
    target = PLATFORMS[platform]
    bundle = native_target_dir(args.candidate) / target / 'release/bundle'
    if platform.startswith('darwin-'):
        base = args.root / 'base.app.tar.gz'
        subprocess.run(['tar', '-czf', str(base), '-C', str(bundle / 'macos'), 'XHarness.app'],
                       check=True, env={**os.environ, 'COPYFILE_DISABLE': '1'})
    else:
        base = bundle / 'appimage/XHarness_0.0.901_amd64.AppImage'
    command = [sys.executable, '-B', ROOT / 'scripts/unix-update-acceptance.py', 'candidate-update',
               '--root', args.root, '--base', base, '--candidate', args.candidate / 'release' / name,
               '--signature', args.candidate / 'release' / (name + '.sig'),
               '--public-key', args.candidate / 'release/updater.pub', '--receipt', receipt,
               '--manifest', args.candidate / 'release/latest.json', '--timeout', '600']
    if args.rehearsal:
        command += ['--rehearsal']
    run(*command)


def export_native(args):
    args.output.mkdir(parents=True, exist_ok=False)
    # Never upload source, TLS CA/private keys, disposable signer keys or HOME.
    for name in ['acceptance.json', 'evidence.json', 'FAIL.json', 'app.log', 'events.jsonl', 'http-requests.jsonl',
                 'codesign.log', 'gatekeeper.log', 'stapler.log']:
        source = args.root / name
        if source.is_file() and not source.is_symlink():
            shutil.copyfile(source, args.output / name)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan'); p.add_argument('--output', required=True, type=Path)
    p = sub.add_parser('signing-gate'); p.add_argument('--platform', choices=PLATFORMS, required=True)
    p = sub.add_parser('stage'); p.add_argument('--platform', choices=PLATFORMS, required=True); p.add_argument('--target', required=True)
    p = sub.add_parser('configure'); p.add_argument('--plan', type=Path, required=True); p.add_argument('--public-key', type=Path, required=True)
    p = sub.add_parser('collect')
    for name in ['plan', 'public-key', 'output']: p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--platform', choices=PLATFORMS, required=True); p.add_argument('--target', required=True)
    p = sub.add_parser('aggregate')
    for name in ['plan', 'artifacts', 'output']: p.add_argument('--' + name, type=Path, required=True)
    p = sub.add_parser('stage-draft'); p.add_argument('--candidate', type=Path, required=True)
    p = sub.add_parser('resolve-source'); p.add_argument('--release-run-id', required=True)
    p = sub.add_parser('fetch-candidate'); p.add_argument('--release-run-id', required=True); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('fetch-promotion')
    for name in ['release-run-id', 'unix-run-id', 'windows-run-id']: p.add_argument('--' + name, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('publish'); p.add_argument('--workspace', type=Path, required=True)
    p = sub.add_parser('rehearsal-init'); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('rehearsal-receipt'); p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--platform', choices=PLATFORMS, required=True); p.add_argument('--target', required=True)
    p = sub.add_parser('prepare-native'); p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True); p.add_argument('--platform', choices=PLATFORMS, required=True)
    p = sub.add_parser('native-run'); p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True); p.add_argument('--rehearsal', action='store_true')
    p = sub.add_parser('export-native'); p.add_argument('--root', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        _, sha = trusted_checkout()
        require(sha == os.environ.get('GITHUB_SHA'), 'Release planning must use the exact workflow source')
        tag = os.environ.get('RELEASE_TAG_INPUT', '')
        require(re.fullmatch(r'desktop-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', tag), 'Invalid release tag')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        contract('plan', tag, '--output', args.output)
    elif args.command == 'signing-gate': signing_gate(args.platform)
    elif args.command == 'stage': stage(args.platform, args.target)
    elif args.command == 'configure':
        plan = load(args.plan)
        require(plan['sha'] == os.environ.get('GITHUB_SHA'), 'Plan/check-out source mismatch')
        require(plan['endpoint'] == os.environ.get('XHARNESS_UPDATER_ENDPOINT'), 'Plan/build endpoint mismatch')
        public_key(args.public_key)
        run(sys.executable, '-B', ROOT / 'scripts/prepare-desktop-test-version.py', plan['version'])
    elif args.command == 'collect': collect(args)
    elif args.command == 'aggregate':
        expected = {f'desktop-package-{platform}' for platform in PLATFORMS}
        require({p.name for p in args.artifacts.iterdir()} == expected, 'Expected exactly four platform artifacts')
        normalized = args.artifacts.parent / 'normalized-platforms'
        normalized.mkdir()
        for platform in PLATFORMS:
            shutil.copytree(args.artifacts / f'desktop-package-{platform}', normalized / platform, symlinks=True)
        key = args.output.parent / 'aggregate-trusted.pub'
        public_key(key)
        contract('aggregate', '--plan', args.plan, '--artifacts', normalized, '--public-key', key, '--output', args.output)
        key.unlink()
    elif args.command == 'stage-draft':
        repo, sha = trusted_checkout()
        plan = load(args.candidate / 'plan.json')
        require(plan['sha'] == sha == os.environ.get('GITHUB_SHA') and plan['repository'] == repo, 'Draft source differs from plan')
        contract('verify-release', '--plan', args.candidate / 'plan.json', '--release-dir', args.candidate / 'release',
                 '--public-key', args.candidate / 'release/updater.pub')
        verify_tag(repo, plan['tag'], sha)
        # gh create fails rather than reusing any pre-existing draft or public release.
        run('gh', 'release', 'create', plan['tag'], '--repo', repo, '--verify-tag', '--target', sha,
            '--draft', '--latest=false', '--title', f'XHarness Desktop {plan["version"]}',
            '--notes', 'Complete signed Windows x64, macOS arm64/Intel and Linux AppImage candidate. Native acceptance is required before separate promotion. No live feed has changed.')
        files = list_files(args.candidate / 'release')
        run('gh', 'release', 'upload', plan['tag'], *[files[n] for n in sorted(files)], '--repo', repo)
        result = api(f'repos/{repo}/releases/tags/{plan["tag"]}')
        require(result['draft'] and not result['prerelease'] and {a['name'] for a in result['assets']} == set(files), 'Incomplete or changed draft')
        require(all(a['size'] == files[a['name']].stat().st_size for a in result['assets']), 'Uploaded asset size mismatch')
        write(args.candidate / 'draft-snapshot.json', snapshot(result))
    elif args.command == 'resolve-source':
        repo, sha = trusted_checkout()
        require(os.environ.get('GITHUB_REF') == 'refs/heads/master' and sha == os.environ.get('GITHUB_SHA'), 'Resolve source from the trusted master control checkout')
        value = successful_run(repo, args.release_run_id, None, '.github/workflows/desktop-release.yml')
        ancestor(repo, value['head_sha'], sha)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('source_sha=' + value['head_sha'] + '\n')
    elif args.command == 'fetch-candidate': fetch_candidate(args.release_run_id, args.output)
    elif args.command == 'fetch-promotion': fetch_promotion(args)
    elif args.command == 'publish': publish(args)
    elif args.command == 'rehearsal-init': rehearsal_init(args.output)
    elif args.command == 'rehearsal-receipt': rehearsal_receipt(args)
    elif args.command == 'prepare-native': prepare_native(args)
    elif args.command == 'native-run': native_run(args)
    elif args.command == 'export-native': export_native(args)


if __name__ == '__main__':
    main()
