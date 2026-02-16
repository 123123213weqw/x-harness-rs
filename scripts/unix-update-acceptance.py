#!/usr/bin/env python3
"""Disposable Unix native updater acceptance; never compiles Rust itself.

prepare copies source and injects a driver ONLY into the disposable base. The
candidate-update command installs the EXACT signed candidate via the production
Tauri handlers. The untouched candidate proves restart and session replay using
its normal ready file and opt-in production debug trace. candidate-native is a
separate smoke check and can never emit nativeUpdateAccepted=true.

All launch commands require a native, disposable GitHub-hosted runner. No global
certificate/keychain, /Applications, production HOME, or live feed is modified.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import pathlib
import platform
import plistlib
import re
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
PLATFORMS = {
    'linux-x86_64-appimage': ('linux', 'x86_64', 'x86_64-unknown-linux-gnu'),
    'darwin-aarch64': ('darwin', 'arm64', 'aarch64-apple-darwin'),
    'darwin-x86_64': ('darwin', 'x86_64', 'x86_64-apple-darwin'),
}
MARKER = 'ISOLATED_UNIX_UPDATE_ONLY'
SESSION = 'unix-update-preserved-session'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(pathlib.Path(path).read_text())


def write_json(path, value):
    pathlib.Path(path).write_text(json.dumps(value, indent=2) + '\n')


def digest(path):
    value = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def run(command, timeout=90, **kwargs):
    # Never print inherited environments, signer output or potential credentials.
    return subprocess.run([str(arg) for arg in command], check=True, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def native_runner(name):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
            'Native acceptance requires a disposable GitHub-hosted runner')
    operating_system, machine, _ = PLATFORMS[name]
    require(sys.platform == operating_system and platform.machine().lower() == machine,
            'Native OS/architecture mismatch; emulation is not acceptance')


def isolated_root(path, create=False):
    raw = pathlib.Path(path).absolute()
    root = raw.resolve()
    require(not raw.is_symlink(), 'Isolation root may not be a symlink')
    parents = [pathlib.Path(tempfile.gettempdir()).resolve()]
    if os.environ.get('RUNNER_TEMP'):
        parents.append(pathlib.Path(os.environ['RUNNER_TEMP']).resolve())
    require(any(base in root.parents for base in parents), 'Isolation root must be below a temporary directory')
    require(root != pathlib.Path.home().resolve() and not str(root).startswith('/Applications/'),
            'Production HOME and /Applications are forbidden')
    if create:
        root.mkdir(mode=0o700, parents=False, exist_ok=False)
        (root / MARKER).write_text('Disposable synthetic data only.\n')
    require(root.is_dir() and (root / MARKER).is_file(), 'Missing isolation marker')
    require(root.stat().st_uid == os.getuid() and stat.S_IMODE(root.stat().st_mode) == 0o700,
            'Isolation root must be owned by current user with mode 0700')
    return root


def runtime_environment(root):
    # Allow-list, not a growing secret-name deny-list. No model/account/signing
    # credentials, proxy configuration, PYTHONHOME or production XHARNESS_* leaks.
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY')
           if key in os.environ}
    env.update(HOME=str(root / 'home'), CFFIXED_USER_HOME=str(root / 'home'),
               TMPDIR=str(root / 'tmp'), XDG_DATA_HOME=str(root / 'data'),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'),
               XDG_RUNTIME_DIR=str(root / 'runtime'), XHARNESS_STATE_DIR=str(root / 'state'),
               XHARNESS_WORKSPACE=str(root / 'workspace'),
               XHARNESS_PROVIDERS_FILE=str(root / 'config/providers.json'),
               XHARNESS_REHEARSAL_ROOT=str(root), XHARNESS_DEBUG_TRACE='full',
               XHARNESS_DEBUG_DIR=str(root / 'trace'),
               APPIMAGE_EXTRACT_AND_RUN='1', WEBKIT_DISABLE_DMABUF_RENDERER='1',
               LIBGL_ALWAYS_SOFTWARE='1', SSL_CERT_FILE=str(root / 'ca.pem'),
               SSL_CERT_DIR=str(root / 'empty-ca-dir'), NO_PROXY='localhost,127.0.0.1')
    # Fixture RPC helper must not inherit the bundled AppImage's PYTHONHOME.
    env['XHARNESS_REHEARSAL_PYTHON'] = str(pathlib.Path(sys.executable).resolve())
    return env


def create_data(root):
    for name in ('home', 'tmp', 'data', 'config', 'cache', 'runtime', 'state',
                 'workspace', 'trace', 'empty-ca-dir'):
        (root / name).mkdir(mode=0o700)
    paths = []
    for name in ('workspace/保留-fixture.txt', 'state/preserved.txt', 'config/preserved.txt',
                 'data/preserved.txt', 'home/preserved.txt'):
        path = root / name
        path.write_text('preserve-through-update\n')
        paths.append(name)
    # Tauri app_config_dir adds the stable bundle ID; macOS resolves it under
    # Library/Application Support rather than XDG_CONFIG_HOME. Exercise the
    # real credential-file loader, not a convenient inherited API-key variable.
    secrets = ['config/com.xlang.xharness/secrets/unix_fixture_key',
               'home/Library/Application Support/com.xlang.xharness/secrets/unix_fixture_key']
    for secret in secrets:
        (root / secret).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        (root / secret).write_text('synthetic-not-a-real-provider-key\n')
    config = {'default': {'provider': 'fixture', 'model': 'fixture-model'}, 'providers': [{
        'id': 'fixture', 'display_name': 'Unix acceptance fixture', 'kind': 'openai-compatible',
        'base_url': 'http://127.0.0.1:9/v1', 'protocol': 'chat',
        'api_key_env': 'UNIX_FIXTURE_KEY', 'models': [{'id': 'fixture-model',
            'display_name': 'Fixture model', 'fallback_context_window_tokens': 32768,
            'max_output_tokens': 8192, 'minimum_output_tokens': 1024}]}]}
    write_json(root / 'config/providers.json', config)
    paths.extend(secrets + ['config/providers.json'])
    return {name: digest(root / name) for name in paths}


def verify_signature(asset, signature, public_key):
    run(['node', REPO / 'scripts/verify-updater-package.mjs', asset, signature, public_key])


def current_checkout_sha():
    # A control branch may advance after the candidate was built. Verify the
    # actual checkout, not the dispatch event's GITHUB_SHA.
    return run(['git', '-C', REPO, 'rev-parse', 'HEAD']).stdout.decode().strip()


def public_key_digest(path):
    lines = base64.b64decode(pathlib.Path(path).read_text().strip(), validate=True).decode().strip().splitlines()
    require(len(lines) == 2, 'Malformed updater public key')
    packet = base64.b64decode(lines[1], validate=True)
    require(len(packet) == 42 and packet[:2] == b'Ed', 'Malformed public key packet')
    return hashlib.sha256(packet).hexdigest()


def verify_receipt(args):
    receipt = read_json(args.receipt)
    asset = pathlib.Path(args.candidate if hasattr(args, 'candidate') else args.asset).resolve()
    signature = pathlib.Path(args.signature).read_text().strip()
    require(receipt.get('schema_version') == 1, 'Unsupported receipt schema')
    require(receipt.get('platform') == args.platform, 'Receipt platform mismatch')
    require(receipt.get('target') == PLATFORMS[args.platform][2], 'Receipt target mismatch')
    require(receipt.get('package') == asset.name, 'Receipt package name mismatch')
    require(receipt.get('package_sha256') == digest(asset), 'Receipt package hash mismatch')
    require(receipt.get('package_size') == asset.stat().st_size, 'Receipt package size mismatch')
    require(receipt.get('signature') == signature, 'Receipt signature mismatch')
    require(receipt.get('public_key_sha256') == public_key_digest(args.public_key), 'Receipt key mismatch')
    require(receipt.get('identifier') == 'com.xlang.xharness', 'Receipt identifier mismatch')
    require(re.fullmatch(r'[0-9a-f]{40}', receipt.get('sha', '')) is not None, 'Invalid source SHA')
    for key in ('release_run_id', 'release_run_attempt'):
        require(re.fullmatch(r'[1-9][0-9]*', str(receipt.get(key, ''))) is not None,
                'Missing immutable build identity: ' + key)
    verify_signature(asset, args.signature, args.public_key)
    if getattr(args, 'manifest', None):
        manifest = read_json(args.manifest)
        require(manifest['version'] == receipt['version'], 'Manifest version mismatch')
        entry = manifest['platforms'][args.platform]
        require(entry['signature'] == signature, 'Manifest signature mismatch')
        expected = 'https://github.com/{}/releases/download/{}/{}'.format(
            receipt['repository'], receipt['tag'], asset.name)
        require(entry['url'] == expected, 'Manifest package URL mismatch')
        require(receipt['embedded_endpoint'] == 'https://github.com/{}/releases/latest/download/latest.json'.format(
            receipt['repository']), 'Receipt embedded endpoint mismatch')
    return receipt


def safe_extract_app(archive, destination):
    """Allow normal .app internal symlinks, never outside paths or link traversal."""
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, 'r:gz') as stream:
        members = stream.getmembers()
        require(bool(members), 'Empty app archive')
        names = set()
        roots = set()
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            require(parts and not member.name.startswith('/') and '..' not in parts,
                    'Unsafe archive path')
            require(parts[0].endswith('.app'), 'Archive must contain only one .app')
            require(member.name not in names, 'Duplicate archive path')
            names.add(member.name)
            roots.add(parts[0])
            require(member.isdir() or member.isfile() or member.issym(), 'Unsupported archive entry')
            if member.issym():
                target = pathlib.PurePosixPath(member.linkname)
                require(not target.is_absolute(), 'Absolute app symlink')
                resolved = (destination / member.name).parent.joinpath(member.linkname).resolve()
                require(destination / parts[0] in resolved.parents or resolved == destination / parts[0],
                        'App symlink escapes bundle')
        require(len(roots) == 1, 'Expected exactly one app bundle')
        symlinks = {pathlib.PurePosixPath(m.name) for m in members if m.issym()}
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            require(not any(parent in symlinks for parent in path.parents), 'Archive writes through symlink')
        # Write links last; no archive-controlled metadata or special nodes.
        for member in members:
            path = destination / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(member) as source, path.open('xb') as output:
                    shutil.copyfileobj(source, output)
                path.chmod(member.mode & 0o777)
        for member in members:
            if member.issym():
                path = destination / member.name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(member.linkname)
    return destination / next(iter(roots))


def tree_digest(root):
    value = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            item = ['link', relative, os.readlink(path)]
        elif path.is_file():
            item = ['file', relative, stat.S_IMODE(path.stat().st_mode), digest(path)]
        else:
            continue
        value.update(json.dumps(item, ensure_ascii=True).encode() + b'\n')
    return value.hexdigest()


def mac_binary(app):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    name = info['CFBundleExecutable']
    require(pathlib.Path(name).name == name, 'Unsafe CFBundleExecutable')
    require(info['CFBundleIdentifier'] == 'com.xlang.xharness', 'Unexpected app identifier')
    return app / 'Contents/MacOS' / name, info


def native_signature(app, version, evidence):
    binary, info = mac_binary(app)
    require(info['CFBundleShortVersionString'] == version, 'Installed app version mismatch')
    # Commands inspect only the isolated copy; no security add-trusted-cert,
    # keychain mutation, xattr deletion, re-signing, sudo, or installation.
    for label, command in (
        ('codesign', ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app]),
        ('gatekeeper', ['spctl', '--assess', '--type', 'execute', '--verbose=4', app]),
        ('stapler', ['xcrun', 'stapler', 'validate', app]),
    ):
        result = run(command)
        (evidence / (label + '.log')).write_bytes(result.stdout + result.stderr)
    return {'codesignVerified': True, 'gatekeeperAccepted': True, 'notarizationStapleVerified': True}


def launch_command(root, binary, name):
    if name.startswith('linux-'):
        require(shutil.which('xvfb-run') is not None and shutil.which('dbus-run-session') is not None,
                'Linux native acceptance requires xvfb-run and dbus-run-session')
        # Keep the disposable display/bus alive after Tauri's parent exits during
        # restart. The owner always TERM/KILLs this entire process group.
        return ['xvfb-run', '-a', 'dbus-run-session', '--', 'sh', '-c',
                '"$1" & p=$!; wait "$p"; s=$?; [ "$s" -eq 0 ] || exit "$s"; sleep 600',
                'unix-update-acceptance', str(binary)]
    require(shutil.which('sandbox-exec') is not None, 'macOS sandbox-exec required for write confinement')
    profile = root / 'app.sb'
    profile.write_text('(version 1)\n(allow default)\n(deny file-write*)\n'
                       '(allow file-write* (subpath ' + json.dumps(str(root)) + ') (literal "/dev/null"))\n')
    return ['sandbox-exec', '-f', str(profile), str(binary)]


def process_ownership(name):
    if name.startswith('darwin-'):
        # Darwin can reject cross-session killpg even for a same-UID child.
        # Match the production process runtime: a new group, same session.
        # process_group avoids unsafe Python preexec_fn in our threaded server.
        require(sys.version_info >= (3, 11), 'macOS native acceptance requires Python 3.11+')
        return {'process_group': 0}
    return {'start_new_session': True}


def stop_process(process):
    if process is None:
        return
    # The original desktop PID may have exited on restart; its owned group is
    # still ours. Never kill by process name or target any existing installation.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        if sig == signal.SIGTERM:
            time.sleep(1)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def json_lines(path):
    try:
        data = path.read_text()
    except FileNotFoundError:
        return []
    # Writers append JSONL concurrently. Ignore only an unfinished final line,
    # never malformed completed evidence (which is a hard failure).
    return [json.loads(line) for line in data.splitlines(keepends=True) if line.endswith('\n')]


def healthy_ready(root, excluded=()):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for path in list((root / 'cache').rglob('ready-*.address')) + list((root / 'home').rglob('ready-*.address')):
        if str(path) in excluded:
            continue
        address = path.read_text().strip()
        require(re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}', address) is not None,
                'Ready file points outside loopback')
        require(int(address.rsplit(':', 1)[1]) < 65536, 'Invalid ready port')
        try:
            with opener.open('http://' + address + '/health/ready', timeout=2) as response:
                health = json.load(response)
            if health.get('ok') is True and health.get('service') == 'xharness-host':
                return path, health
        except (OSError, ValueError):
            pass
    return None


def session_inventory(root):
    directory = root / 'state/sessions'
    require(directory.is_dir() and not directory.is_symlink(), 'Invalid session inventory directory')
    result = {}
    for path in sorted(directory.glob('*.jsonl')):
        require(path.is_file() and not path.is_symlink(), 'Session inventory contains a non-regular journal')
        result[path.name] = digest(path)
    return result


def validated_snapshot_inventory(before):
    require(before.get('hostStoppedBeforeSnapshot') is True, 'Session snapshot preceded Host shutdown barrier')
    inventory = before.get('sessionInventory')
    require(isinstance(inventory, dict) and SESSION + '.jsonl' in inventory, 'Snapshot lacks known session journal')
    require(all(isinstance(name, str) and pathlib.PurePath(name).name == name and name.endswith('.jsonl') and
                isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value)
                for name, value in inventory.items()), 'Invalid snapshot session inventory')
    journal = base64.b64decode(before['journalBase64'], validate=True)
    require(hashlib.sha256(journal).hexdigest() == inventory[SESSION + '.jsonl'],
            'Known session bytes do not match snapshot inventory')
    return inventory


def restored_candidate(root, ready, before):
    inventory = validated_snapshot_inventory(before)
    require(session_inventory(root) == inventory, 'Session inventory changed across update')
    for trace in (root / 'trace').glob('*/events.jsonl'):
        events = json_lines(trace)
        starts = [event for event in events if event.get('layer') == 'host' and event.get('event') == 'start']
        if not any(event['payload'].get('readyFile') == str(ready) and
                   event['payload'].get('stateDir') == str(root / 'state') for event in starts):
            continue
        restores = [event['payload'] for event in events if event.get('layer') == 'host' and event.get('event') == 'restore']
        # Host restore enumerates every persisted journal before readiness.
        # An untouched UI may also create a default session in the BASE; bind
        # the count to the stopped Host's exact inventory, never a fixed 1 or >=1.
        if any(type(event.get('restoredSessions')) is int and event['restoredSessions'] == len(inventory) and
               event.get('issues') == [] for event in restores):
            return {'trace': str(trace.relative_to(root)), 'sha256': digest(trace),
                    'restoredSessions': len(inventory), 'issues': [],
                    'sessionInventory': inventory, 'knownSession': SESSION}
    return None


def update_diagnostics(root, process, config, receipt):
    """Capture only synthetic lifecycle metadata while failed children still exist.

    Keep this in evidence.json (already exported by the CI wrapper), never raw
    process environments, journal content, provider payloads or whole HOME.
    """
    def safe_path(value):
        if not isinstance(value, str):
            return None
        path = pathlib.Path(value)
        try:
            return str(path.relative_to(root))
        except ValueError:
            return '<outside-root>/' + path.name

    result = {'status': 'diagnostic-only', 'nativeUpdateAccepted': False,
              'platform': config['platform'], 'expected_package_sha256': receipt['package_sha256'],
              'readyFiles': [], 'hostLifecycle': [], 'ownedProcesses': [],
              'launcherExitCode': process.poll() if process is not None else None}
    installed = root / 'installed.AppImage'
    if installed.is_file():
        result['installed_package_sha256'] = digest(installed)
        result['exactCandidateInstalled'] = result['installed_package_sha256'] == receipt['package_sha256']
    expected_apps = list((root / 'expected-candidate').glob('*.app'))
    if len(expected_apps) == 1 and (root / 'installed' / expected_apps[0].name).is_dir():
        result['expected_bundle_tree_sha256'] = tree_digest(expected_apps[0])
        result['installed_bundle_tree_sha256'] = tree_digest(root / 'installed' / expected_apps[0].name)
        result['exactCandidateInstalled'] = result['installed_bundle_tree_sha256'] == result['expected_bundle_tree_sha256']
    try:
        result['sessionInventory'] = session_inventory(root)
    except ValueError:
        result['sessionInventory'] = None
    for directory in ('cache', 'home'):
        for path in (root / directory).rglob('ready-*.address'):
            try:
                address = path.read_text().strip()
                result['readyFiles'].append({'path': str(path.relative_to(root)),
                    'loopbackAddress': address if re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}', address) else None})
            except OSError:
                continue
    try:
        ready = healthy_ready(root)
        result['healthyReady'] = {'path': str(ready[0].relative_to(root)), 'health': {key: ready[1].get(key) for key in ('ok', 'service', 'version')}} if ready else None
    except Exception as error:
        result['healthErrorType'] = type(error).__name__
    for path in (root / 'trace').glob('*/events.jsonl'):
        lifecycle = []
        for event in json_lines(path):
            if event.get('layer') != 'host':
                continue
            fields = {'start': ('readyFile', 'stateDir', 'workspace', 'desktopMode'),
                      'restore': ('restoredSessions', 'issues'), 'exit': ('outcome',)}.get(event.get('event'))
            if fields:
                payload = {key: event['payload'].get(key) for key in fields}
                for key in ('readyFile', 'stateDir', 'workspace'):
                    if key in payload:
                        payload[key] = safe_path(payload[key])
                if 'issues' in payload:
                    issues = payload.pop('issues')
                    payload['issueCount'] = len(issues) if isinstance(issues, list) else None
                lifecycle.append({'event': event['event'], 'payload': payload})
        result['hostLifecycle'].append({'trace': str(path.relative_to(root)), 'events': lifecycle})
    if sys.platform == 'linux' and process is not None:
        allowed_env = {'APPIMAGE', 'APPDIR', 'HOME', 'XDG_CACHE_HOME', 'XHARNESS_STATE_DIR',
                       'XHARNESS_DEBUG_DIR', 'XHARNESS_REHEARSAL_ROOT', 'DBUS_SESSION_BUS_ADDRESS'}
        for proc in pathlib.Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                pid = int(proc.name)
                if os.getpgid(pid) != process.pid:
                    continue
                environ = {}
                for entry in (proc / 'environ').read_bytes().split(b'\0'):
                    key, separator, value = entry.partition(b'=')
                    name = key.decode(errors='replace')
                    if separator and name in allowed_env:
                        environ[name] = bool(value) if name == 'DBUS_SESSION_BUS_ADDRESS' else safe_path(value.decode(errors='replace'))
                result['ownedProcesses'].append({'pid': pid, 'exe': safe_path(os.readlink(proc / 'exe')),
                    'state': (proc / 'stat').read_text().rsplit(') ', 1)[-1].split()[0], 'environment': environ})
            except (OSError, ValueError, IndexError):
                continue
    return result


def generate_tls(root):
    # Private, one-day CA + leaf. Trust is inherited ONLY by our child process.
    # Explicit SKI/AKI extensions are required by modern OpenSSL strict chain
    # verification (Python 3.13+); never weaken TLS checks to accept the fixture.
    (root / 'ca.cnf').write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n'
        '[dn]\nCN=Unix acceptance ephemeral CA\n[ca]\nbasicConstraints=critical,CA:TRUE\n'
        'keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n'
        'authorityKeyIdentifier=keyid:always,issuer\n', encoding='utf-8')
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', root / 'tls.key',
         '-out', root / 'ca.pem', '-days', '1', '-config', root / 'ca.cnf'])
    (root / 'server.ext').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\n'
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
        'extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer\n',
        encoding='utf-8')
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', root / 'server.key',
         '-out', root / 'server.csr', '-subj', '/CN=localhost'])
    run(['openssl', 'x509', '-req', '-in', root / 'server.csr', '-CA', root / 'ca.pem',
         '-CAkey', root / 'tls.key', '-CAcreateserial', '-out', root / 'server.pem',
         '-days', '1', '-extfile', root / 'server.ext'])
    for name in ('tls.key', 'server.key'):
        (root / name).chmod(0o600)


def fixture_server(root, asset, signature, config):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            mode = (root / 'mode').read_text()
            with (root / 'http-requests.jsonl').open('a') as log:
                log.write(json.dumps({'path': self.path, 'mode': mode}) + '\n')
            if self.path == '/latest.json':
                time.sleep(.25)  # deterministic overlap for concurrent-check test
                if mode == 'unavailable':
                    self.send_error(503)
                    return
                body = json.dumps({'version': config['target_version'], 'notes': 'Isolated acceptance feed',
                    'platforms': {config['platform']: {'signature': signature,
                        'url': config['endpoint'].replace('/latest.json', '/candidate')}}}).encode()
            elif self.path == '/candidate':
                body = asset.read_bytes()
                if mode == 'tampered':
                    body = body[:-1] + bytes([body[-1] ^ 1])
            else:
                self.send_error(404)
                return
            try:
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # expected when a failed check/download cancels its request
    server = http.server.ThreadingHTTPServer(('127.0.0.1', config['port']), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / 'server.pem', root / 'server.key')
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def prepare(args):
    root = isolated_root(args.root, create=True)
    source = pathlib.Path(args.source).resolve()
    require(source not in root.parents and root not in source.parents,
            'Source and disposable root must not contain each other')
    versions = []
    for version in (args.base_version, args.target_version):
        require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) is not None,
                'Use a plain major.minor.patch version')
        versions.append(tuple(map(int, version.split('.'))))
    require(versions[0] < versions[1], 'Base version must be lower than candidate')
    shutil.copytree(source, root / 'source', symlinks=True,
                    ignore=shutil.ignore_patterns('.git', 'target', 'node_modules', 'dist',
                        '.env', '.env.*', '*.key', '*.pem', '*.p12', '*.pfx', '*.p8', '*.keychain*', '.aws', '.ssh',
                        'credentials*', 'id_rsa*', 'id_ed25519*', '__pycache__'))
    if (source / 'ui/dist').is_dir():
        shutil.copytree(source / 'ui/dist', root / 'source/ui/dist', symlinks=True)
    desktop = root / 'source/apps/desktop/src-tauri'
    shutil.copy2(REPO / 'scripts/fixtures/unix-update-driver.rs', desktop / 'src/rehearsal.rs')
    path = desktop / 'src/sidecar.rs'
    text = path.read_text()
    require(text.count('    token: String,') == 1, 'Sidecar driver injection anchor drifted')
    path.write_text(text.replace('    token: String,', '    pub(crate) token: String,', 1))
    path = desktop / 'src/lib.rs'
    text = path.read_text()
    require(text.count('mod sidecar;') == 1, 'Desktop module injection anchor drifted')
    text = text.replace('mod sidecar;', 'mod rehearsal;\nmod sidecar;', 1)
    anchor = '                }\n            });\n            Ok(())'
    require(text.count(anchor) == 1, 'Desktop startup injection anchor drifted')
    path.write_text(text.replace(anchor, '                }\n                rehearsal::run(handle).await;\n            });\n            Ok(())', 1))
    # The base is never a release artifact: no updater private key is needed.
    path = desktop / 'tauri.conf.json'
    tauri_config = read_json(path)
    tauri_config['bundle']['createUpdaterArtifacts'] = False
    write_json(path, tauri_config)
    # reqwest 0.13 uses macOS native verification, which ignores SSL_CERT_FILE.
    # Add one extra CA through the plugin's documented client hook ONLY in this
    # disposable base. Certificate/hostname/signature verification stays on.
    path = desktop / 'src/updater.rs'
    text = path.read_text()
    anchor = '        .timeout(Duration::from_secs(30));'
    require(text.count(anchor) == 1, 'Updater TLS injection anchor drifted')
    text = text.replace(anchor, '        .configure_client(crate::rehearsal::tls_client)\n' + anchor, 1)
    anchor = '    if let Err(error) = update.install(bytes.as_slice()) {'
    require(text.count(anchor) == 1, 'Updater post-shutdown snapshot injection anchor drifted')
    path.write_text(text.replace(anchor, '    crate::rehearsal::snapshot_before_install();\n' + anchor, 1))
    path = desktop / 'Cargo.toml'
    text = path.read_text()
    require('[dependencies]\n' in text and '\nreqwest =' not in text, 'Disposable reqwest dependency anchor drifted')
    path.write_text(text.replace('[dependencies]\n', '[dependencies]\nreqwest = { version = "=0.13.4", default-features = false }\n', 1))
    path = desktop / 'Cargo.lock'
    text = path.read_text()
    require('name = "reqwest"\nversion = "0.13.4"' in text, 'Pinned reqwest lockfile changed')
    prefix, desktop_lock = text.split('name = "xharness-desktop"\n', 1)
    require('dependencies = [\n' in desktop_lock, 'Desktop lockfile dependency anchor drifted')
    desktop_lock = desktop_lock.replace('dependencies = [\n', 'dependencies = [\n "reqwest",\n', 1)
    path.write_text(prefix + 'name = "xharness-desktop"\n' + desktop_lock)
    generate_tls(root)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    config = {'platform': args.platform, 'base_version': args.base_version,
              'target_version': args.target_version, 'port': port,
              'endpoint': f'https://localhost:{port}/latest.json'}
    write_json(root / 'rehearsal.json', config)
    public_key = pathlib.Path(args.public_key).read_text().strip()
    (root / 'updater.pub').write_text(public_key + '\n')
    build_env = {'XHARNESS_UPDATER_ENDPOINT': config['endpoint'], 'XHARNESS_UPDATER_PUBKEY': public_key}
    write_json(root / 'build-env.json', build_env)
    env = os.environ.copy()
    env.update(build_env)
    run([sys.executable, root / 'source/scripts/prepare-desktop-test-version.py', args.base_version], env=env)
    print(json.dumps({'source': str(root / 'source'), 'buildEnv': str(root / 'build-env.json'),
                      'target': PLATFORMS[args.platform][2], **config}, indent=2))


def candidate_native(args):
    native_runner(args.platform)
    receipt = verify_receipt(args)
    root = isolated_root(args.evidence_dir, create=True)
    process = None
    try:
        retained = create_data(root)
        asset = pathlib.Path(args.asset).resolve()
        checks = {'signatureVerified': True}
        if args.platform.startswith('darwin-'):
            app = safe_extract_app(asset, root / 'installed')
            binary, _ = mac_binary(app)
            checks.update(native_signature(app, receipt['version'], root))
        else:
            binary = root / 'installed.AppImage'
            shutil.copy2(asset, binary)
            binary.chmod(0o755)
        with (root / 'app.log').open('wb') as log:
            process = subprocess.Popen(launch_command(root, binary, args.platform),
                cwd=root, env=runtime_environment(root), stdout=log, stderr=log, **process_ownership(args.platform))
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline:
                ready = healthy_ready(root)
                if ready:
                    break
                require(process.poll() is None, 'Native candidate exited before Host readiness')
                time.sleep(.25)
            else:
                raise TimeoutError('Native candidate did not publish healthy Host readiness')
        require(all(digest(root / path) == value for path, value in retained.items()), 'Smoke changed fixture data')
        checks['nativeLaunchVerified'] = True
        result = {**receipt_binding(receipt, args.manifest), 'status': 'passed',
                  'scope': 'signed-candidate-native-smoke', 'nativeUpdateAccepted': False,
                  'checks': checks, 'limitations': ['No update operation was exercised by this smoke check.']}
        write_json(root / 'acceptance.json', result)
        print(json.dumps(result, indent=2))
    except Exception as error:
        write_json(root / 'FAIL.json', {'status': 'failed', 'errorType': type(error).__name__, 'message': str(error)})
        raise
    finally:
        try:
            stop_process(process)
        except Exception as error:
            (root / 'acceptance.json').unlink(missing_ok=True)
            write_json(root / 'FAIL.json', {'status': 'failed', 'errorType': type(error).__name__,
                                          'message': 'Owned-process cleanup failed'})
            raise


def receipt_binding(receipt, manifest):
    keys = ('version', 'sha', 'release_run_id', 'release_run_attempt', 'platform', 'package_sha256')
    result = {key: receipt[key] for key in keys}
    result['schema_version'] = 1
    if manifest:
        result['manifest_sha256'] = digest(manifest)
    return result


def candidate_update(args):
    root = isolated_root(args.root)
    config = read_json(root / 'rehearsal.json')
    args.platform = config['platform']
    native_runner(args.platform)
    receipt = verify_receipt(args)
    require(receipt['version'] == config['target_version'], 'Prepared target version mismatch')
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]*', os.environ.get(key, '')) is not None, 'Missing CI run identity')
    source_sha = current_checkout_sha()
    require(source_sha == receipt['sha'], 'Acceptance checkout source SHA differs from candidate')
    require(pathlib.Path(args.public_key).read_text().strip() == (root / 'updater.pub').read_text().strip(),
            'Prepared base public key differs from candidate trust key')
    process = None
    server = None
    try:
        retained = create_data(root)
        asset = pathlib.Path(args.candidate).resolve()
        base = pathlib.Path(args.base).resolve()
        checks = {'signatureVerified': True}
        if args.platform.startswith('darwin-'):
            installed = safe_extract_app(base, root / 'installed')
            expected = safe_extract_app(asset, root / 'expected-candidate')
            require(installed.name == expected.name, 'Base/candidate bundle names differ')
            binary, info = mac_binary(installed)
            require(info['CFBundleShortVersionString'] == config['base_version'], 'Base app version mismatch')
            if not args.rehearsal:
                checks.update(native_signature(expected, receipt['version'], root))
            expected_hash = tree_digest(expected)
            exact = lambda: installed.exists() and tree_digest(installed) == expected_hash
        else:
            installed = root / 'installed.AppImage'
            shutil.copy2(base, installed)
            installed.chmod(0o755)
            binary = installed
            exact = lambda: installed.is_file() and digest(installed) == receipt['package_sha256']
        (root / 'mode').write_text('normal')
        server = fixture_server(root, asset, pathlib.Path(args.signature).read_text().strip(), config)
        with (root / 'app.log').open('wb') as log:
            process = subprocess.Popen(launch_command(root, binary, args.platform), cwd=root,
                env=runtime_environment(root), stdout=log, stderr=log, **process_ownership(args.platform))
            deadline = time.monotonic() + args.timeout
            before = None
            replay = None
            while time.monotonic() < deadline:
                events = json_lines(root / 'events.jsonl')
                require(not any('failed' in event for event in events), 'Native production-handler driver failed')
                confirmed = [event for event in events if event.get('installConfirmed')]
                if confirmed:
                    before = confirmed[-1]
                    ready = healthy_ready(root, before['readyFiles'])
                    if ready and exact():
                        replay = restored_candidate(root, ready[0], before)
                        if replay:
                            break
                code = process.poll()
                require(code is None or (code == 0 and confirmed), 'Base exited before confirmed installation')
                time.sleep(.25)
            else:
                raise TimeoutError('Updater failed to install/restart/replay the exact candidate within deadline')
        require(before is not None and replay is not None, 'Missing restart evidence')
        journal = root / 'state/sessions' / (SESSION + '.jsonl')
        require(journal.read_bytes() == base64.b64decode(before['journalBase64']), 'Session journal changed across update')
        require(all(digest(root / path) == value for path, value in retained.items()), 'User fixture changed across update')
        require(session_inventory(root) == validated_snapshot_inventory(before), 'Session inventory changed after readiness')
        require(exact(), 'Installed artifact changed after readiness')
        required = ('checkFailureKeepsHost', 'concurrentCheckRejected', 'tamperedPackageRejected',
                    'unconfirmedInstallRejected', 'persistedSessionCreated', 'downloadBeforeCheckRejected',
                    'installBeforeDownloadRejected')
        for check in required:
            require(any(event.get(check) is True for event in events), 'Missing production-handler assertion: ' + check)
        requests = json_lines(root / 'http-requests.jsonl')
        for request in ({'path': '/latest.json', 'mode': 'unavailable'}, {'path': '/candidate', 'mode': 'tampered'},
                        {'path': '/candidate', 'mode': 'normal'}):
            require(request in requests, 'Missing HTTPS failure/download evidence')
        checks.update(unavailableFeedRejected=True, concurrentCheckRejected=True,
            tamperedPackageRejected=True, unconfirmedInstallRejected=True,
            exactCandidateInstalled=True, restartVerified=True, dataPreserved=True,
            persistedSessionRestored=True, nativeLaunchVerified=True)
        if args.platform.startswith('darwin-') and not args.rehearsal:
            checks.update(native_signature(installed, receipt['version'], root))
        result = {**receipt_binding(receipt, args.manifest), 'status': 'passed',
            'scope': 'isolated-production-handler-rehearsal' if args.rehearsal else 'instrumented-base-to-signed-candidate',
            'nativeUpdateAccepted': not args.rehearsal, 'baseInstrumented': True,
            'candidateModified': False, 'provenance': {
                'workflow': '.github/workflows/desktop-unix-update-acceptance.yml',
                'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                'source_sha': source_sha}, 'base_version': config['base_version'],
            'base_sha256': digest(base), 'checks': checks, 'retained': retained,
            'journal_sha256': digest(journal), 'replay': replay,
            'limitations': ['Base is a disposable instrumented build, not an untouched historical installer.',
                            'Production IPC handlers are exercised; UI mouse-click acceptance is separate.']}
        write_json(root / 'evidence.json', result)
        fields = {'schema_version', 'platform', 'version', 'sha', 'release_run_id', 'release_run_attempt',
                  'manifest_sha256', 'package_sha256', 'status', 'nativeUpdateAccepted', 'checks',
                  'scope', 'baseInstrumented', 'base_version', 'provenance'}
        acceptance = {key: result[key] for key in fields}
        write_json(root / 'acceptance.json', acceptance)
        print(json.dumps(acceptance, indent=2))
    except Exception as error:
        write_json(root / 'FAIL.json', {'status': 'failed', 'errorType': type(error).__name__, 'message': str(error)})
        try:
            write_json(root / 'evidence.json', update_diagnostics(root, process, config, receipt))
        except Exception as diagnostic_error:
            write_json(root / 'evidence.json', {'status': 'diagnostic-only', 'nativeUpdateAccepted': False,
                       'diagnosticErrorType': type(diagnostic_error).__name__})
        raise
    finally:
        try:
            try:
                stop_process(process)
            finally:
                if server is not None:
                    server.shutdown()
                    server.server_close()
        except Exception as error:
            (root / 'acceptance.json').unlink(missing_ok=True)
            write_json(root / 'FAIL.json', {'status': 'failed', 'errorType': type(error).__name__,
                                          'message': 'Owned-process/server cleanup failed'})
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Copy/instrument source; does NOT compile Rust')
    for key in ('root', 'source', 'base-version', 'target-version', 'public-key'):
        prep.add_argument('--' + key, required=True)
    prep.add_argument('--platform', choices=PLATFORMS, required=True)
    prep.set_defaults(function=prepare)
    for command, function in (('candidate-native', candidate_native), ('candidate-update', candidate_update)):
        sub = commands.add_parser(command)
        for key in ('signature', 'public-key', 'receipt', 'manifest'):
            sub.add_argument('--' + key, required=True)
        sub.add_argument('--timeout', type=float, default=240)
        if command == 'candidate-native':
            sub.add_argument('--asset', required=True)
            sub.add_argument('--evidence-dir', required=True)
            sub.add_argument('--platform', choices=PLATFORMS, required=True)
        else:
            for key in ('root', 'base', 'candidate'):
                sub.add_argument('--' + key, required=True)
            sub.add_argument('--rehearsal', action='store_true',
                             help='Allow ad-hoc Mac candidate; NEVER produce formal update acceptance')
        sub.set_defaults(function=function)
    args = parser.parse_args()
    if hasattr(args, 'timeout'):
        require(0 < args.timeout <= 1800, 'Timeout must be within (0, 1800] seconds')
    args.function(args)


if __name__ == '__main__':
    main()
