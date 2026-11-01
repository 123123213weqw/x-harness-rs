#!/usr/bin/env python3
"""Opt-in immutable local credential helper. No Rust build or secret migration.

Only the helper accesses secrets, after authenticating its direct Host parent.
Normal updates must NEVER run a fresh build/sign over an existing helper.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'native/macos-keychain-helper/main.c'
HELPER_ID = 'com.xlang.xharness.keychain-helper'


def require(ok, message):
    if not ok: raise ValueError(message)


def command(args):
    # No signing-key password or credential value is accepted by this script.
    r = subprocess.run([str(x) for x in args], capture_output=True, timeout=90)
    require(r.returncode == 0, 'Local helper build/signature verification failed')
    return r.stdout + r.stderr


def fingerprint(value):
    require(re.fullmatch(r'[a-f0-9]{40}', value or ''), 'Require lowercase certificate SHA1')
    return value


def signed(path, identity, identifier):
    req = f'=identifier "{identifier}" and certificate leaf = H"{fingerprint(identity)}"'
    command(['/usr/bin/codesign', '--verify', '--strict', '-R', req, path])


def build(output, identity, *, keychain=None):
    require(sys.platform == 'darwin', 'Native helper requires macOS')
    command(['/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
             SOURCE, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', output])
    args = ['/usr/bin/codesign', '--force', '--sign', fingerprint(identity), '--identifier', HELPER_ID,
            '--options', 'runtime', '--timestamp=none']
    if keychain is not None: args += ['--keychain', keychain]
    command([*args, output])
    output.chmod(0o700)
    signed(output, identity, HELPER_ID)


def private(path, owner, directory=False):
    m = path.lstat()
    require(not path.is_symlink() and m.st_uid == owner and m.st_mode & 0o077 == 0,
            'Local helper paths must be private and owned by this user')
    require(path.is_dir() if directory else path.is_file(), 'Unexpected helper file type')


def install(state, identity, host):
    require(sys.platform == 'darwin', 'Installation requires macOS')
    import fcntl
    identity = fingerprint(identity)
    require(state.is_absolute() and state.exists() and not state.is_symlink(), 'Require existing real state directory')
    state = state.resolve()
    require(state.stat().st_uid == os.getuid(), 'State belongs to a different user')
    # Authenticate the installed caller before creating a pin. Never trust only a
    # certificate display name, ad-hoc binary, or a caller-chosen requirement.
    host_id = None
    for candidate in ['xharness-host', 'com.xlang.xharness.host']:
        try: signed(host, identity, candidate); host_id = candidate; break
        except ValueError: pass
    require(host_id, 'Installed Host must use the same persistent signing certificate')
    home = state / 'credential-helper'
    home.mkdir(mode=0o700, exist_ok=True); private(home, os.getuid(), True)
    lock = home / 'setup.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        destination = home / 'v1'
        config = state / 'local-keychain-helper.json'
        if destination.exists():
            private(destination, os.getuid(), True)
            binary = destination / 'xharness-keychain-helper'
            private(binary, os.getuid()); private(config, os.getuid())
            pin = json.loads(config.read_text())
            require(pin == {'schema':1, 'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
                            'certificate_sha1':identity}, 'Existing helper pin differs; explicit recovery required')
            require((destination / 'source.sha256').read_text().strip() == hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                    'Helper source changed; requires explicit versioned migration, never overwrite silently')
            signed(binary, identity, HELPER_ID)
            return {'installed':True, 'reusedUnchanged':True, 'credentialsRead':False}
        require(not config.exists() and not config.is_symlink() and not destination.is_symlink(),
                'Partial/foreign helper configuration needs explicit repair')
        with tempfile.TemporaryDirectory(prefix='.prepare-', dir=home) as folder:
            staged = Path(folder) / 'v1'; staged.mkdir(mode=0o700)
            binary = staged / 'xharness-keychain-helper'; build(binary, identity)
            source_pin = staged / 'source.sha256'; source_pin.write_text(hashlib.sha256(SOURCE.read_bytes()).hexdigest()+'\n'); source_pin.chmod(0o600)
            pin = {'schema':1,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'certificate_sha1':identity}
            # Binary becomes immutable before activation; incomplete installs are
            # rejected instead of falling back to an unpinned helper.
            staged.rename(destination)
            config_fd, temp = tempfile.mkstemp(prefix='.helper-pin-', dir=state)
            try:
                with os.fdopen(config_fd, 'w') as stream:
                    json.dump(pin, stream); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
                os.replace(temp, config)
            finally:
                if os.path.exists(temp): os.unlink(temp)
        return {'installed':True,'reusedUnchanged':False,'credentialsRead':False,
                'firstUseAuthorizationRequired':True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--host', type=Path, default=Path('/Applications/XHarness.app/Contents/MacOS/xharness-host'))
    args = parser.parse_args()
    print(json.dumps(install(args.state, args.identity, args.host)))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.TimeoutExpired):
        print('Local helper setup failed; existing credentials have not been migrated or deleted.', file=sys.stderr)
        raise SystemExit(2)
