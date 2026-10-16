#!/usr/bin/env python3
"""Plan/apply the isolated V100_222 experiment. No SSH, sudo, TLS or model setup.

Default is a side-effect-free redacted plan. --apply runs ON V100_222 as xs,
using explicitly supplied remotely built binaries and a current nginx SHA-256.
This script never reads an existing env/key/credential file or process argv.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

ROOT = Path('/home/xs/services/xharness-mobile-experiment-20261013')
EDGE_CONFIG = Path('/home/xs/services/xharness-admin-device-candidate-20261008/nginx.conf')
EDGE_UNIT = 'xharness-admin-edge.service'
RELAY_UNIT = 'xharness-mobile-relay-experiment.service'
HOST_UNIT = 'xharness-mobile-host-experiment.service'
OWNER = 'xharness-mobile-experiment-20261013-v1'
BEGIN = '# BEGIN XHARNESS MOBILE EXPERIMENT 20261013'
END = '# END XHARNESS MOBILE EXPERIMENT 20261013'
ALLOWLIST_BEGIN = '# BEGIN XHARNESS MOBILE METHOD ALLOWLIST 20261013'
ALLOWLIST_END = '# END XHARNESS MOBILE METHOD ALLOWLIST 20261013'
PUBLIC_ORIGIN = 'https://engine.xxdevs.com'
SMOKE_URLS = (PUBLIC_ORIGIN + '/', PUBLIC_ORIGIN + '/plugins/catalog.json')
ENV_KEYS = frozenset({
    'XHARNESS_BIND', 'XHARNESS_WORKSPACE', 'XHARNESS_STATE_DIR',
    'XHARNESS_DESKTOP_TOKEN', 'XHARNESS_REMOTE_CONTROL',
    'XHARNESS_MODEL', 'XHARNESS_PROVIDER', 'XHARNESS_BASE_URL',
    'XHARNESS_API_KEY', 'OPENAI_API_KEY', 'XHARNESS_DEBUG_TRACE',
    'XHARNESS_READY_FILE', 'XHARNESS_MOBILE_RELAY_URL',
    'XHARNESS_MOBILE_HOST_KEY', 'XHARNESS_MOBILE_ALLOW_LOOPBACK',
    'XHARNESS_MOBILE_PUBLIC_URL',
    'XHARNESS_WEB_DIST',
})
OPTIONAL_ENV_KEYS = frozenset({'XHARNESS_WEB_DIST'})

class DeployError(RuntimeError):
    """Closed errors: never include credentials, config text or subprocess stderr."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class Scope:
    header: tuple[str, ...]
    opening: int
    closing: int = -1
    statements: list[tuple[str, ...]] = field(default_factory=list)
    children: list['Scope'] = field(default_factory=list)


def nginx_scopes(text: str) -> Scope:
    """Small structural lexer: ignore comments/quoted braces, keep byte offsets.

    Only identifies a server block; it never rewrites existing directives. UTF-8
    config is decoded and encoded losslessly; offsets here are string offsets.
    """
    tokens: list[tuple[str, int, int]] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char.isspace():
            i += 1
        elif char == '#':
            end = text.find('\n', i)
            i = len(text) if end < 0 else end + 1
        elif char in '{};':
            tokens.append((char, i, i + 1))
            i += 1
        elif char in "\"'":
            quote, start = char, i
            i += 1
            value = []
            while i < len(text) and text[i] != quote:
                if text[i] == '\\':
                    i += 1
                    if i >= len(text):
                        raise DeployError('unterminated nginx quoted value')
                value.append(text[i])
                i += 1
            if i >= len(text):
                raise DeployError('unterminated nginx quoted value')
            i += 1
            tokens.append((''.join(value), start, i))
        else:
            start = i
            while i < len(text) and not text[i].isspace() and text[i] not in '{};#':
                if text[i] == '\\' and i + 1 < len(text):
                    i += 2
                else:
                    i += 1
            tokens.append((text[start:i], start, i))
    root = Scope((), -1)
    stack = [root]
    statement: list[str] = []
    for value, start, _ in tokens:
        if value == '{':
            child = Scope(tuple(statement), start)
            stack[-1].children.append(child)
            stack.append(child)
            statement = []
        elif value == '}':
            if len(stack) < 2 or statement:
                raise DeployError('unbalanced nginx configuration')
            stack.pop().closing = start
        elif value == ';':
            stack[-1].statements.append(tuple(statement))
            statement = []
        else:
            statement.append(value)
    if len(stack) != 1 or statement:
        raise DeployError('unbalanced nginx configuration')
    return root


def route_template() -> str:
    """Exact protocol/asset routes only; all other prefix paths fail closed."""
    # The public 443 origin fronts an internal TLS 8443 listener. Do not inherit
    # absolute_redirect/port_in_redirect and leak the internal listener port.
    lines = [BEGIN, f'location = /remote-control {{ access_log off; return 302 {PUBLIC_ORIGIN}/remote-control/; }}']
    routes = {
        '/remote-control/': '/',
        '/remote-control/index.html': '/index.html',
        '/remote-control/app.js': '/app.js',
        '/remote-control/style.css': '/style.css',
        '/remote-control/api/mobile/pair': '/api/mobile/pair',
        '/remote-control/api/mobile/action': '/api/mobile/action',
        '/remote-control/api/mobile/logout': '/api/mobile/logout',
        '/remote-control/api/mobile/host': '/api/mobile/host',
    }
    for public, internal in routes.items():
        websocket = internal == '/api/mobile/host'
        lines.extend([
            f'location = {public} {{',
            '    access_log off;',
            f'    proxy_pass http://127.0.0.1:31368{internal};',
            '    proxy_http_version 1.1;',
            '    proxy_set_header Host $host;',
            '    proxy_set_header Origin $http_origin;',
            '    proxy_set_header Upgrade $http_upgrade;' if websocket else '    proxy_set_header Upgrade "";',
            '    proxy_set_header Connection "upgrade";' if websocket else '    proxy_set_header Connection "";',
            '    proxy_read_timeout 75s;' if websocket else '    proxy_read_timeout 35s;',
            '    proxy_connect_timeout 3s;',
            '    proxy_send_timeout 10s;',
            '    client_max_body_size 8m;',
            '    proxy_buffering off;',
            '    add_header Cache-Control "no-store" always;',
            '}',
        ])
    lines.extend(['location ^~ /remote-control/ { access_log off; return 404; }', END])
    return '\n'.join(lines) + '\n'


def mobile_method_entries() -> tuple[tuple[str, str], ...]:
    static_paths = ('/remote-control', '/remote-control/', '/remote-control/index.html', '/remote-control/app.js', '/remote-control/style.css')
    return tuple((method, path) for path in static_paths for method in ('GET', 'HEAD')) + (
        ('POST', '/remote-control/api/mobile/pair'),
        ('POST', '/remote-control/api/mobile/action'),
        ('POST', '/remote-control/api/mobile/logout'),
        ('GET', '/remote-control/api/mobile/host'),
    )


def mobile_method_allowlist_template() -> str:
    lines = [ALLOWLIST_BEGIN]
    lines.extend(f'"{mobile_method_pattern(method, path)}" mobile;' for method, path in mobile_method_entries())
    lines.append(ALLOWLIST_END)
    return '\n'.join(lines) + '\n'


def mobile_method_pattern(method: str, path: str) -> str:
    # Literal Nginx map strings ignore case. Anchored `~` PCRE keys (not `~*`)
    # enforce the method/URI's actual case; [.] avoids quote/backslash ambiguity.
    return '~^' + method + ':' + path.replace('.', '[.]') + '$'


def mobile_method_insertion() -> bytes:
    return ('\n' + '\n'.join('        ' + line for line in mobile_method_allowlist_template().splitlines()) + '\n').encode()


def add_mobile_method_allowlist(original: bytes) -> bytes:
    """Standalone CAS-patch helper for a previously installed mobile location.

    The server's existing URI gate executes before location selection. Extend
    only its one exact method/URI map, preserving default deny and every old
    entry verbatim. This helper neither applies nor reloads any configuration.
    """
    try:
        text = original.decode('utf-8')
    except UnicodeDecodeError as error:
        raise DeployError('nginx config must be UTF-8') from error
    if ALLOWLIST_BEGIN in text or ALLOWLIST_END in text:
        raise DeployError('mobile method allowlist marker already present')
    scopes = nginx_scopes(text)
    targets = []
    todo = [scopes]
    while todo:
        scope = todo.pop()
        todo.extend(scope.children)
        if scope.header == ('map', '$request_method:$uri', '$xh_route'):
            targets.append(scope)
    if len(targets) != 1:
        raise DeployError('expected exactly one method/URI route map')
    target = targets[0]
    defaults = [stmt for stmt in target.statements if stmt and stmt[0] == 'default']
    if defaults != [('default', 'deny')]:
        raise DeployError('method/URI map must retain exactly one default deny')
    # Existing literal equivalents are conflicts (they ignore case). Reject
    # existing canonical regex equivalents as well, including escaped-dot and
    # case-insensitive forms; never silently shadow an older whitelist entry.
    literals = {(method + ':' + path).lower() for method, path in mobile_method_entries()}
    patterns = {mobile_method_pattern(method, path).lower().replace('[.]', '.') for method, path in mobile_method_entries()}
    def conflicts(key: str) -> bool:
        normalized = key.lower().replace('~*', '~', 1).replace(r'\.', '.').replace('[.]', '.')
        return key.lower() in literals or normalized in patterns
    if any(stmt and conflicts(stmt[0]) for stmt in target.statements):
        raise DeployError('mobile exact method/URI key already configured; refusing conflict')
    insertion = mobile_method_insertion()
    candidate = text[:target.closing].encode() + insertion + text[target.closing:].encode()
    if candidate.replace(insertion, b'', 1) != original:
        raise DeployError('existing method/URI map preservation proof failed')
    return candidate


def add_routes(original: bytes) -> bytes:
    try:
        text = original.decode('utf-8')
    except UnicodeDecodeError as error:
        raise DeployError('nginx config must be UTF-8') from error
    if BEGIN in text or END in text:
        raise DeployError('route owner marker already present; explicit review required')
    if '/remote-control' in text:
        raise DeployError('public prefix already exists; refusing to override')
    mapped = add_mobile_method_allowlist(original)
    text = mapped.decode('utf-8')
    scopes = nginx_scopes(text)
    candidates = []
    todo = [scopes]
    while todo:
        scope = todo.pop()
        todo.extend(scope.children)
        names = [value for stmt in scope.statements if stmt and stmt[0] == 'server_name' for value in stmt[1:]]
        listeners = [value for stmt in scope.statements if stmt and stmt[0] == 'listen' for value in stmt[1:]]
        if scope.header == ('server',) and 'engine.xxdevs.com' in names and any(re.fullmatch(r'(?:.*:)?8443', value) for value in listeners):
            candidates.append(scope)
    if len(candidates) != 1:
        raise DeployError('expected exactly one engine.xxdevs.com TLS 8443 server')
    offset = candidates[0].closing
    insertion = '\n' + '\n'.join('    ' + line for line in route_template().splitlines()) + '\n'
    candidate = (text[:offset] + insertion + text[offset:]).encode('utf-8')
    # Exact proof that no existing byte/directive was rewritten.
    if candidate.replace(insertion.encode('utf-8'), b'', 1).replace(mobile_method_insertion(), b'', 1) != original:
        raise DeployError('existing-route preservation proof failed')
    return candidate


def unit_templates(root: Path = ROOT) -> dict[str, str]:
    common = '[Unit]\nAfter=network-online.target\n\n[Service]\nType=simple\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=25\n'
    clean = f'/usr/bin/env -i HOME={root}/home PATH=/usr/bin:/bin LANG=C.UTF-8'
    relay = common + f'WorkingDirectory={root}\nExecStart={clean} {root}/bin/xharness-relay --bind 127.0.0.1:31368 --static-dir {root}/ui/mobile --hosts-file {root}/config/hosts.json --public-origin {PUBLIC_ORIGIN}\n\n[Install]\nWantedBy=default.target\n'
    host = common + f'WorkingDirectory={root}\nExecStart={clean} /usr/bin/python3 {root}/bin/launch-host.py\n\n[Install]\nWantedBy=default.target\n'
    return {RELAY_UNIT: '# ' + OWNER + '\n' + relay, HOST_UNIT: '# ' + OWNER + '\n' + host}


def launcher_template(root: Path = ROOT) -> str:
    keys = repr(sorted(ENV_KEYS))
    return f'''#!/usr/bin/env python3
# {OWNER}: reads only this experiment's new private env file.
import os
from pathlib import Path
root = Path({str(root)!r})
allowed = set({keys})
env = {{'HOME': str(root / 'home'), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}}
for line in (root / 'config/host.env').read_text().splitlines():
    key, value = line.split('=', 1)
    if key not in allowed or key in env or '\\x00' in value:
        raise SystemExit('invalid experiment environment')
    env[key] = value
os.execve(str(root / 'bin/xharness-host-app'), [str(root / 'bin/xharness-host-app')], env)
'''


def host_environment(root: Path, desktop_token: str, host_key: str, desktop_static: Path | None = None) -> dict[str, str]:
    env = {
        'XHARNESS_BIND': '127.0.0.1:31369',
        'XHARNESS_WORKSPACE': str(root / 'workspace'),
        'XHARNESS_STATE_DIR': str(root / 'state'),
        'XHARNESS_DESKTOP_TOKEN': desktop_token,
        'XHARNESS_REMOTE_CONTROL': 'enabled',
        'XHARNESS_MODEL': 'unconfigured',
        'XHARNESS_PROVIDER': 'openai-compatible',
        'XHARNESS_BASE_URL': 'http://127.0.0.1:9/v1',
        'XHARNESS_API_KEY': '',
        'OPENAI_API_KEY': '',
        'XHARNESS_DEBUG_TRACE': 'off',
        'XHARNESS_READY_FILE': str(root / 'run/host.ready'),
        'XHARNESS_MOBILE_RELAY_URL': 'ws://127.0.0.1:31368/api/mobile/host',
        'XHARNESS_MOBILE_HOST_KEY': host_key,
        'XHARNESS_MOBILE_ALLOW_LOOPBACK': 'enabled',
        'XHARNESS_MOBILE_PUBLIC_URL': PUBLIC_ORIGIN + '/remote-control/',
    }
    if desktop_static is not None:
        if not desktop_static.is_absolute():
            raise DeployError('desktop static directory must be absolute')
        env['XHARNESS_WEB_DIST'] = str(desktop_static)
    return env


def environment_bytes(env: dict[str, str]) -> bytes:
    if not set(env).issubset(ENV_KEYS) or set(env) - OPTIONAL_ENV_KEYS != ENV_KEYS - OPTIONAL_ENV_KEYS or any('\n' in value or '\r' in value or '\x00' in value for value in env.values()):
        raise DeployError('invalid closed experiment environment')
    if 'XHARNESS_WEB_DIST' in env and not Path(env['XHARNESS_WEB_DIST']).is_absolute():
        raise DeployError('desktop static environment must not expose the working directory')
    return ''.join(f'{key}={env[key]}\n' for key in sorted(env)).encode()


def redacted_plan(args: argparse.Namespace) -> dict:
    return {
        'mode': 'dry-run', 'executes_ssh': False, 'writes_files': False,
        'target': 'V100_222 (run on the server as xs)', 'root': str(ROOT),
        'nginx_config': str(EDGE_CONFIG), 'nginx_binary': str(args.nginx_binary),
        'public_url': PUBLIC_ORIGIN + '/remote-control/',
        'host_loopback': '127.0.0.1:31369', 'relay_loopback': '127.0.0.1:31368',
        'model': 'unconfigured', 'inherited_keys': False,
        'desktop_static': str(ROOT / 'desktop-ui') if args.desktop_static_dir is not None else 'API-only (optional --desktop-static-dir enables isolated desktop Settings)',
        'requires_current_nginx_sha256': True, 'enables_linger': False,
        'reloads_edge_not_restart': EDGE_UNIT,
        'smoke_urls': list(args.smoke_url or SMOKE_URLS),
        'route_template': route_template(), 'method_allowlist_template': mobile_method_allowlist_template(), 'units': unit_templates(),
        'secret_creation': 'fresh random desktop token and separate Host key; private new env only; registry SHA-256 only',
        'rollback': 'generated rollback.sh is also dry-run unless --apply; compares current config SHA before restoring the exact backup',
        'unchanged': ['/downloads', '/updates', '/plugins', '/identity', '/api/inference', 'TLS settings', 'existing credentials'],
        'apply_requirements': ['--apply', '--expect-nginx-sha256 CURRENT_SHA256', '--host-binary ABS_PATH', '--relay-binary ABS_PATH', '--static-dir ABS_PATH'],
    }


def regular(path: Path) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise DeployError('required regular file unavailable') from error
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise DeployError('required file is not regular or is a symlink')
    return metadata


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.xharness-mobile-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def cas_write(path: Path, expected: str, replacement: bytes) -> None:
    metadata = regular(path)
    if digest(path.read_bytes()) != expected:
        raise DeployError('nginx configuration CAS changed; no overwrite')
    atomic_write(path, replacement, stat.S_IMODE(metadata.st_mode))


def known_command(argv: list[str]) -> subprocess.CompletedProcess:
    # Known argv only; never inspect process argv or read manager environment.
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, env={'PATH': '/usr/bin:/bin', 'HOME': '/home/xs', 'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}', 'LANG': 'C.UTF-8'})


def command(argv: list[str]) -> None:
    result = known_command(argv)
    if result.returncode:
        raise DeployError('deployment command failed (output omitted to protect existing configuration)')


def nginx_test(binary: str, config: Path, prefix: Path) -> None:
    command([binary, '-t', '-p', str(prefix) + '/', '-c', str(config)])


def nginx_test_bytes(binary: str, data: bytes, actual_config: Path, prefix: Path) -> None:
    # Nginx derives conf_prefix from the directory of the -c file, overriding
    # -p for config-relative includes/certificates. Validate beside the actual
    # config, not in the experiment backup folder, without replacing it.
    descriptor, temporary = tempfile.mkstemp(prefix='.xharness-mobile-validate-', suffix='.conf', dir=actual_config.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        nginx_test(binary, Path(temporary), prefix)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def edge_reload_mode() -> str:
    # Read one non-secret service capability, never an ExecStart/process argv or
    # the service-manager environment. Some user units omit ExecReload.
    result = known_command(['systemctl', '--user', 'show', '--property=CanReload', '--value', EDGE_UNIT])
    if result.returncode:
        raise DeployError('edge reload capability unavailable')
    value = result.stdout.decode('ascii', errors='strict').strip()
    if value not in ('yes', 'no'):
        raise DeployError('edge reload capability is not a closed value')
    return 'systemd_reload' if value == 'yes' else 'nginx_signal'


def edge_reload(mode: str) -> None:
    if mode == 'systemd_reload':
        command(['systemctl', '--user', 'reload', EDGE_UNIT])
    elif mode == 'nginx_signal':
        command(['/usr/sbin/nginx', '-s', 'reload', '-p', str(EDGE_CONFIG.parent) + '/', '-c', str(EDGE_CONFIG)])
    else:
        raise DeployError('invalid edge reload mode')


def warmup_ready(ready_text: str, relay_health: dict) -> bool:
    # Native publish_ready_file writes address.to_string(), currently without a
    # newline. Accept surrounding whitespace but require this exact endpoint.
    connected = relay_health.get('connected_hosts')
    return ready_text.strip() == '127.0.0.1:31369' and relay_health.get('ok') is True and type(connected) is int and connected >= 1


def smoke(url: str) -> dict:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'engine.xxdevs.com' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443):
        raise DeployError('smoke URL must be credential-free existing public HTTPS origin')
    if parsed.path.startswith('/remote-control'):
        raise DeployError('before/after smoke must target existing public routes')
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError):
        return {'url': url, 'status': 0, 'error': 'network_unavailable'}
    with response:
        data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            return {'url': url, 'status': int(response.code), 'error': 'body_limit'}
        return {'url': url, 'status': int(response.code), 'body_sha256': digest(data), 'content_type': response.headers.get('Content-Type', '')}


def comparison(before: list[dict], after: list[dict]) -> dict:
    if [item['url'] for item in before] != [item['url'] for item in after]:
        raise DeployError('smoke result URL mismatch')
    degradation = []
    changed = []
    unavailable = []
    for prior, current in zip(before, after):
        if current.get('error'):
            unavailable.append(current['url'])
        elif current['status'] >= 400 and current['status'] != prior['status']:
            degradation.append(current['url'])
        elif current.get('body_sha256') != prior.get('body_sha256'):
            # Concurrent legitimate publishers may update a body. Never restore
            # old route configuration on body-hash differences alone.
            changed.append(current['url'])
    return {'http_degradation': degradation, 'body_changed_review_required': changed, 'unavailable_review_required': unavailable}


def ensure_owner(root: Path, create: bool = False) -> None:
    if root.exists():
        if root.is_symlink() or not root.is_dir() or root.resolve() != root:
            raise DeployError('experiment root is not a canonical owned directory')
        marker = root / '.owner'
        regular(marker)
        if marker.read_text() != OWNER + '\n':
            raise DeployError('experiment directory belongs to another owner')
    elif create:
        root.mkdir(mode=0o700)
        atomic_write(root / '.owner', (OWNER + '\n').encode())
    else:
        raise DeployError('experiment ownership missing')
    if stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise DeployError('experiment root permissions must be 0700')


def private_directory(path: Path) -> None:
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        raise DeployError('experiment subdirectory is not a directory')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def install_file(source: Path, target: Path, mode: int) -> None:
    regular(source)
    atomic_write(target, source.read_bytes(), mode)


def install_static(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise DeployError('mobile static source must be a regular directory')
    # This version deliberately serves just these source-controlled artifacts.
    expected = {'index.html', 'app.js', 'style.css'}
    if not expected.issubset({item.name for item in source.iterdir()}):
        raise DeployError('mobile static source missing required artifacts')
    private_directory(target)
    for name in sorted(expected):
        install_file(source / name, target / name, 0o600)


def install_desktop_static(source: Path, target: Path) -> None:
    """Copy only the explicitly supplied generated desktop public assets.

    Reject symlinks, dotfiles, environment files and native binaries rather than
    accidentally serving credentials if the operator supplies the wrong path.
    """
    if not source.is_absolute() or source.is_symlink() or not source.is_dir():
        raise DeployError('generated desktop static source must be an absolute regular directory')
    regular(source / 'index.html')
    allowed = {'.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.wasm', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.map'}
    entries = sorted(source.rglob('*'))
    if len(entries) > 10000:
        raise DeployError('desktop static artifact count exceeded')
    for entry in entries:
        relative = entry.relative_to(source)
        if entry.is_symlink() or any(part.startswith('.') or part in {'node_modules', 'target'} for part in relative.parts):
            raise DeployError('desktop static source contains a forbidden path')
        if not entry.is_dir() and (not entry.is_file() or entry.suffix.lower() not in allowed):
            raise DeployError('desktop static source contains a non-public artifact')
    private_directory(target)
    for entry in entries:
        destination = target / entry.relative_to(source)
        if entry.is_dir():
            private_directory(destination)
        else:
            private_directory(destination.parent)
            install_file(entry, destination, 0o600)


def validate_machine() -> None:
    if os.name != 'posix' or pwd.getpwuid(os.getuid()).pw_name != 'xs' or Path.home() != Path('/home/xs'):
        raise DeployError('--apply must run on V100_222 as xs; no SSH or sudo is performed')


def rollback(args: argparse.Namespace) -> dict:
    validate_machine()
    ensure_owner(ROOT)
    receipt_path = ROOT / 'transaction.json'
    regular(receipt_path)
    receipt = json.loads(receipt_path.read_text())
    if receipt.get('owner') != OWNER or receipt.get('nginx_config') != str(EDGE_CONFIG) or receipt.get('nginx_binary') != '/usr/sbin/nginx':
        raise DeployError('rollback receipt scope mismatch')
    expected = receipt['new_sha256']
    if args.expect_nginx_sha256 != expected:
        raise DeployError('rollback requires the recorded applied SHA-256')
    backup = Path(receipt['backup'])
    if backup.parent != ROOT / 'rollback':
        raise DeployError('rollback backup outside owned directory')
    regular(backup)
    old = backup.read_bytes()
    if digest(old) != receipt['old_sha256']:
        raise DeployError('rollback backup integrity mismatch')
    prefix = Path(receipt['nginx_prefix'])
    if prefix != EDGE_CONFIG.parent:
        raise DeployError('rollback nginx prefix scope mismatch')
    reload_mode = edge_reload_mode()
    nginx_test_bytes('/usr/sbin/nginx', old, EDGE_CONFIG, prefix)
    applied = EDGE_CONFIG.read_bytes()
    cas_write(EDGE_CONFIG, expected, old)
    try:
        nginx_test('/usr/sbin/nginx', EDGE_CONFIG, prefix)
    except DeployError:
        cas_write(EDGE_CONFIG, receipt['old_sha256'], applied)
        raise
    edge_reload(reload_mode)
    return {'status': 'rolled_back', 'nginx_sha256': receipt['old_sha256'], 'restored_exact_original': True, 'tls_changed': False}


def apply(args: argparse.Namespace) -> dict:
    validate_machine()
    if not args.expect_nginx_sha256 or not re.fullmatch('[0-9a-f]{64}', args.expect_nginx_sha256):
        raise DeployError('--apply requires an explicit current nginx SHA-256')
    if str(args.nginx_binary) != '/usr/sbin/nginx':
        raise DeployError('experiment nginx binary scope mismatch')
    for name in ('host_binary', 'relay_binary', 'static_dir'):
        value = getattr(args, name)
        if value is None or not value.is_absolute():
            raise DeployError('absolute supplied binary/static paths required')
    regular(args.host_binary)
    regular(args.relay_binary)
    regular(EDGE_CONFIG)
    if ROOT.exists():
        ensure_owner(ROOT)
        if (ROOT / 'config/host.env').exists() or (ROOT / 'config/hosts.json').exists():
            raise DeployError('private experiment credentials already exist; explicit upgrade review required')
    unit_dir = Path('/home/xs/.config/systemd/user')
    for name in unit_templates():
        path = unit_dir / name
        if path.exists():
            regular(path)
            if not path.read_text().startswith('# ' + OWNER + '\n'):
                raise DeployError('refusing to replace an unowned user unit')
    original = EDGE_CONFIG.read_bytes()
    if digest(original) != args.expect_nginx_sha256:
        raise DeployError('nginx config differs from explicitly inspected SHA-256')
    candidate = add_routes(original)
    reload_mode = edge_reload_mode()
    before = [smoke(url) for url in (args.smoke_url or SMOKE_URLS)]
    if any(item.get('error') for item in before):
        raise DeployError('baseline public-route smoke unavailable; nothing deployed')
    ensure_owner(ROOT, create=True)
    for name in ('bin', 'config', 'home', 'state', 'workspace', 'run', 'rollback', 'ui'):
        private_directory(ROOT / name)
    backup = ROOT / 'rollback' / ('nginx.conf.' + args.expect_nginx_sha256)
    if backup.exists():
        regular(backup)
        if digest(backup.read_bytes()) != args.expect_nginx_sha256:
            raise DeployError('existing backup does not match CAS baseline')
    else:
        atomic_write(backup, original)
    install_file(args.host_binary, ROOT / 'bin/xharness-host-app', 0o700)
    install_file(args.relay_binary, ROOT / 'bin/xharness-relay', 0o700)
    install_static(args.static_dir, ROOT / 'ui/mobile')
    desktop_static = None
    if args.desktop_static_dir is not None:
        install_desktop_static(args.desktop_static_dir, ROOT / 'desktop-ui')
        desktop_static = ROOT / 'desktop-ui'
    atomic_write(ROOT / 'bin/launch-host.py', launcher_template().encode(), 0o700)
    env_file, registry = ROOT / 'config/host.env', ROOT / 'config/hosts.json'
    if env_file.exists() or registry.exists():
        # Do NOT read existing secrets or silently rotate credentials on rerun.
        # Explicit paired setup must be reviewed instead of mixing registries.
        raise DeployError('private experiment credentials already exist; explicit upgrade review required')
    desktop_token, host_key = secrets.token_hex(32), secrets.token_hex(32)
    host_id = 'host-' + digest(str((ROOT / 'state').resolve()).encode())
    atomic_write(env_file, environment_bytes(host_environment(ROOT, desktop_token, host_key, desktop_static)))
    atomic_write(registry, json.dumps({'hosts': {host_id: {'key_sha256': digest(host_key.encode())}}}, separators=(',', ':')).encode() + b'\n')
    unit_dir = Path('/home/xs/.config/systemd/user')
    unit_dir.mkdir(parents=True, exist_ok=True)
    for name, content in unit_templates().items():
        path = unit_dir / name
        if path.exists():
            regular(path)
            if not path.read_text().startswith('# ' + OWNER + '\n'):
                raise DeployError('refusing to replace an unowned user unit')
        atomic_write(path, content.encode())
    command(['systemctl', '--user', 'daemon-reload'])
    command(['systemctl', '--user', 'start', RELAY_UNIT])
    command(['systemctl', '--user', 'start', HOST_UNIT])
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        ready = ROOT / 'run/host.ready'
        if ready.exists() and not ready.is_symlink():
            try:
                with urllib.request.urlopen('http://127.0.0.1:31368/healthz', timeout=2) as response:
                    health = json.loads(response.read(4096))
                    if response.status == 200 and isinstance(health, dict) and warmup_ready(ready.read_text(), health):
                        break
            except (OSError, urllib.error.URLError, ValueError):
                pass
        time.sleep(0.25)
    else:
        raise DeployError('isolated services did not become ready; public nginx untouched')
    candidate_path = ROOT / 'rollback/nginx.candidate.conf'
    atomic_write(candidate_path, candidate)
    nginx_test_bytes('/usr/sbin/nginx', candidate, EDGE_CONFIG, EDGE_CONFIG.parent)
    receipt = {'owner': OWNER, 'nginx_config': str(EDGE_CONFIG), 'nginx_binary': '/usr/sbin/nginx', 'nginx_prefix': str(EDGE_CONFIG.parent), 'backup': str(backup), 'old_sha256': digest(original), 'new_sha256': digest(candidate), 'smoke_before': before, 'host_id': host_id, 'edge_reload_mode': reload_mode}
    atomic_write(ROOT / 'transaction.json', json.dumps(receipt, sort_keys=True, indent=2).encode() + b'\n')
    install_file(Path(__file__).resolve(), ROOT / 'bin/deploy-mobile-experiment.py', 0o700)
    rollback_script = f'''#!/bin/sh
set -eu
if [ "${{1-}}" != "--apply" ]; then
  printf '%s\\n' 'Dry-run: restores the exact pre-experiment nginx config using CAS; add --apply to execute.'
  exit 0
fi
exec /usr/bin/env -i HOME=/home/xs PATH=/usr/bin:/bin /usr/bin/python3 {ROOT}/bin/deploy-mobile-experiment.py --rollback --apply --expect-nginx-sha256 {digest(candidate)}
'''
    atomic_write(ROOT / 'rollback.sh', rollback_script.encode(), 0o700)
    cas_write(EDGE_CONFIG, digest(original), candidate)
    try:
        nginx_test('/usr/sbin/nginx', EDGE_CONFIG, EDGE_CONFIG.parent)
        edge_reload(reload_mode)
    except DeployError:
        # Only undo our exact candidate; no overwrite if an external editor won.
        cas_write(EDGE_CONFIG, digest(candidate), original)
        nginx_test('/usr/sbin/nginx', EDGE_CONFIG, EDGE_CONFIG.parent)
        edge_reload(reload_mode)
        raise
    after = [smoke(item['url']) for item in before]
    review = comparison(before, after)
    receipt['smoke_after'], receipt['review'] = after, review
    atomic_write(ROOT / 'transaction.json', json.dumps(receipt, sort_keys=True, indent=2).encode() + b'\n')
    if review['http_degradation']:
        restore_args = argparse.Namespace(expect_nginx_sha256=digest(candidate))
        rollback(restore_args)
        raise DeployError('existing public HTTP status degraded; exact route insertion rolled back')
    return {'status': 'applied_needs_review' if review['body_changed_review_required'] or review['unavailable_review_required'] else 'applied', 'public_url': PUBLIC_ORIGIN + '/remote-control/', 'host_id': host_id, 'nginx_sha256': digest(candidate), 'model': 'unconfigured', 'smoke_before': before, 'smoke_after': after, 'review': review, 'rollback_script': str(ROOT / 'rollback.sh'), 'linger_enabled': False, 'edge_action': 'graceful reload only'}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Explicitly perform isolated deployment on V100_222 as xs')
    parser.add_argument('--rollback', action='store_true', help='Restore exact original config; still dry-run unless --apply')
    parser.add_argument('--expect-nginx-sha256')
    parser.add_argument('--host-binary', type=Path)
    parser.add_argument('--relay-binary', type=Path)
    parser.add_argument('--static-dir', type=Path)
    parser.add_argument('--desktop-static-dir', type=Path, help='Optional generated ui/dist to copy for SSH-only native desktop Settings')
    parser.add_argument('--nginx-binary', type=Path, default=Path('/usr/sbin/nginx'))
    parser.add_argument('--smoke-url', action='append')
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if not args.apply:
            result = redacted_plan(args)
            if args.rollback:
                result['mode'] = 'dry-run-rollback'
        elif args.rollback:
            result = rollback(args)
        else:
            result = apply(args)
        print(json.dumps(result, sort_keys=True, indent=2))
        return 2 if result.get('status') == 'applied_needs_review' else 0
    except (DeployError, OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'status': 'failed_closed', 'error': 'deployment/validation failed; no secret output; inspect owned receipts and specified inputs'}), file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
