#!/usr/bin/env python3
"""Opt-in fixed publisher signing. Never compiles Rust. The system certificate trust stores are never modified.

Private certificate bytes live only in protected CI Secrets / a temporary
runner-owned keychain. This is NOT Developer ID signing or notarization.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import secrets
import shutil
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('macos_signing', Path(__file__).with_name('macos-signing.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(args, *, env=None):
    try:
        return subprocess.run([str(a) for a in args], check=True, capture_output=True, timeout=90,
                              env=env).stdout
    except (OSError, subprocess.SubprocessError) as error:
        # Never reproduce argv, arbitrary stderr or private environment values.
        raise ValueError('Native signing operation failed (' + operation(args) + '): ' + type(error).__name__) from None


def operation(args):
    # Only a fixed public stage name is allowed into errors, never paths/argv.
    stages = {'openssl': 'certificate conversion', 'codesign': 'code signing',
              'security': 'keychain operation', 'sudo': 'admin trust operation'}
    return stages.get(str(args[0]), 'native operation')


def cleanup_after_failure(keychain, original):
    try:
        cleanup_path(keychain)
    except Exception as cleanup:
        # Both helper errors contain only public stages, not private argv/stderr.
        raise ValueError(str(original) + '; cleanup also failed: ' + str(cleanup)) from None


def fingerprint(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9a-fA-F]{40}', value), 'Require a pinned certificate SHA1')
    return value.lower()


def create_identity(output):
    require(os.name == 'posix', 'Publisher identity creation requires POSIX private-file permissions')
    password = os.environ.get('XHARNESS_MACOS_PREVIEW_P12_PASSWORD', '')
    require(len(password) >= 16, 'Provide a strong P12 password via environment, not command line')
    output = Path(output).absolute()
    require(not output.exists() and not output.is_symlink(), 'Never overwrite a publisher identity')
    output.mkdir(mode=0o700)
    try:
        config = output / 'openssl.cnf'
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n'
                          '[dn]\nCN=XHarness Preview Signing\nO=XHarness Preview Publisher\n'
                          '[signing]\nbasicConstraints=critical,CA:FALSE\n'
                          'keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n')
        command(['openssl', 'req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '1825',
                 '-config', config, '-keyout', output / 'private.pem', '-out', output / 'certificate.pem',
                 '-passout', 'env:XHARNESS_MACOS_PREVIEW_P12_PASSWORD'])
        (output / 'private.pem').chmod(0o600)
        command(['openssl', 'pkcs12', '-export', '-inkey', output / 'private.pem', '-in', output / 'certificate.pem',
                 '-out', output / 'publisher.p12', '-passin', 'env:XHARNESS_MACOS_PREVIEW_P12_PASSWORD',
                 '-passout', 'env:XHARNESS_MACOS_PREVIEW_P12_PASSWORD'])
        (output / 'publisher.p12').chmod(0o600)
        der = command(['openssl', 'x509', '-in', output / 'certificate.pem', '-outform', 'DER'])
        pin = hashlib.sha1(der).hexdigest()  # codesign certificate pin, not a payload integrity hash
        (output / 'fingerprint.txt').write_text(pin + '\n')
        print(json.dumps({'fingerprint': pin, 'privateP12': str(output / 'publisher.p12'),
                          'policy': 'self-signed-unnotarized-preview'}))
    finally:
        (output / 'private.pem').unlink(missing_ok=True)
        (output / 'openssl.cnf').unlink(missing_ok=True)


def import_identity():
    require(sys.platform == 'darwin', 'Fixed Mac identity import requires macOS')
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
            'Private identity import is restricted to hosted release runners')
    event, ref = os.environ.get('GITHUB_EVENT_NAME'), os.environ.get('GITHUB_REF', '')
    require((event == 'workflow_dispatch' and ref == 'refs/heads/master') or
            (event == 'push' and re.fullmatch(r'refs/tags/desktop-v[0-9]+\.[0-9]+\.[0-9]+', ref)),
            'Private identity import requires trusted release dispatch/tag, never PR')
    pin = fingerprint(os.environ.get('XHARNESS_MACOS_PREVIEW_CERT_SHA1', ''))
    password = os.environ.get('XHARNESS_MACOS_PREVIEW_P12_PASSWORD', '')
    require(password, 'Missing publisher P12 password')
    try:
        data = base64.b64decode(os.environ.get('XHARNESS_MACOS_PREVIEW_P12', ''), validate=True)
    except ValueError:
        raise ValueError('Invalid publisher P12 encoding') from None
    require(0 < len(data) <= 1024 * 1024, 'Missing or oversized publisher P12')
    root = Path(os.environ['RUNNER_TEMP']).resolve()
    work = Path(tempfile.mkdtemp(prefix='xharness-publisher-signing-', dir=root))
    keychain = work / 'publisher.keychain-db'
    p12 = work / 'publisher.p12'
    key_password = secrets.token_urlsafe(32)
    try:
        p12.write_bytes(data); p12.chmod(0o600)
        command(['security', 'create-keychain', '-p', key_password, keychain])
        command(['security', 'unlock-keychain', '-p', key_password, keychain])
        command(['security', 'set-keychain-settings', '-lut', '7200', keychain])
        command(['security', 'import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
        command(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', key_password, keychain])
        certificate = work / 'certificate.pem'
        command(['openssl', 'pkcs12', '-in', p12, '-clcerts', '-nokeys', '-out', certificate,
                 '-passin', 'env:XHARNESS_MACOS_PREVIEW_P12_PASSWORD'])
        validate_publisher_certificate(certificate, pin)
        attach_runner_keychain(keychain)
        identities = command(['security', 'find-identity', '-p', 'codesigning', keychain]).decode()
        require(re.search(r'\b' + re.escape(pin) + r'\b', identities, re.I) is not None,
                'Imported code-signing identity does not match the pinned certificate')
        with Path(os.environ['GITHUB_ENV']).open('a') as output:
            output.write('XHARNESS_MACOS_PREVIEW_KEYCHAIN=' + str(keychain) + '\n')
        # The search-list addition is restored during cleanup; default keychain and trust stores stay untouched.
    except Exception as original:
        cleanup_after_failure(keychain, original)
        raise
    finally:
        p12.unlink(missing_ok=True)


def validate_publisher_certificate(certificate, pin):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and sys.platform == 'darwin', 'Publisher validation requires disposable hosted macOS CI')
    pin = fingerprint(pin)
    der = command(['openssl', 'x509', '-in', certificate, '-outform', 'DER'])
    require(hashlib.sha1(der).hexdigest() == pin, 'P12 leaf certificate differs from pinned publisher')
    names = command(['openssl', 'x509', '-in', certificate, '-subject', '-issuer', '-noout', '-nameopt', 'RFC2253']).decode().splitlines()
    require(len(names) == 2 and names[0].removeprefix('subject=') == names[1].removeprefix('issuer='),
            'Preview publisher must use the explicit self-signed policy')
    command(['openssl', 'x509', '-in', certificate, '-checkend', '0', '-noout'])


def owned_runner_keychain(keychain):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and sys.platform == 'darwin', 'Keychain search changes require disposable hosted macOS CI')
    keychain = Path(keychain)
    root = Path(os.environ['RUNNER_TEMP']).resolve()
    require(keychain.name == 'publisher.keychain-db' and keychain.parent.name.startswith('xharness-publisher-signing-')
            and keychain.parent.parent.resolve() == root and not keychain.parent.is_symlink(), 'Unsafe keychain cleanup path')
    return keychain


def macos_keychain_path(value):
    # These strings come from macOS `security`, not from the host filesystem
    # running the portable policy tests. Never reinterpret a Mac absolute path
    # using Windows drive/UNC semantics.
    return isinstance(value, str) and PurePosixPath(value).is_absolute()


def attach_runner_keychain(keychain):
    keychain = owned_runner_keychain(keychain)
    receipt = keychain.parent / 'search-list.json'
    require(not receipt.exists(), 'Never overwrite runner keychain search-list receipt')
    previous = shlex.split(command(['security', 'list-keychains', '-d', 'user']).decode())
    require(all(macos_keychain_path(path) for path in previous), 'Invalid runner keychain search list')
    # Write-ahead receipt covers a timeout/unknown outcome of the native mutation.
    receipt.write_text(json.dumps(previous)); receipt.chmod(0o600)
    command(['security', 'list-keychains', '-d', 'user', '-s', keychain, *previous])


def cleanup_path(keychain):
    keychain = owned_runner_keychain(keychain)
    failures = []
    receipt = keychain.parent / 'search-list.json'
    if receipt.exists():
        try:
            previous = json.loads(receipt.read_text())
            require(isinstance(previous, list) and all(macos_keychain_path(path) for path in previous),
                    'Invalid runner keychain search-list receipt')
            command(['security', 'list-keychains', '-d', 'user', '-s', *previous])
        except (ValueError, OSError):
            failures.append('Failed to restore runner keychain search list')
    if keychain.exists():
        try:
            command(['security', 'delete-keychain', keychain])
        except ValueError:
            failures.append('Failed to delete temporary private keychain')
    if failures:
        raise ValueError('; '.join(failures))  # retain files so cleanup can be diagnosed/retried
    shutil.rmtree(keychain.parent)


def sign_app(app, pin, keychain):
    pin = fingerprint(pin)
    app = Path(app)
    require(app.is_dir() and not app.is_symlink(), 'Require a real app bundle')
    for relative, identifier in policy.COMPONENT_IDENTIFIERS.items():
        target = app if relative == '.' else app / relative
        require(target.exists() and not target.is_symlink(), 'Missing or symlinked signed component')
        command(['codesign', '--force', '--options', 'runtime', '--timestamp=none',
                 '--preserve-metadata=entitlements', '--identifier', identifier,
                 '--requirements', '=designated => ' + policy.requirement(identifier, pin),
                 '--keychain', keychain, '--sign', pin.upper(), target])
    policy.verify(app, fingerprint=pin)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('create'); create.add_argument('--output', type=Path, required=True)
    sub.add_parser('import')
    sign = sub.add_parser('sign'); sign.add_argument('--app', type=Path, required=True)
    sub.add_parser('cleanup')
    args = parser.parse_args()
    if args.command == 'create':
        create_identity(args.output)
    elif args.command == 'import':
        import_identity()
    elif args.command == 'sign':
        require(sys.platform == 'darwin', 'Signing requires macOS')
        sign_app(args.app, os.environ['XHARNESS_MACOS_PREVIEW_CERT_SHA1'], os.environ['XHARNESS_MACOS_PREVIEW_KEYCHAIN'])
    elif os.environ.get('XHARNESS_MACOS_PREVIEW_KEYCHAIN'):
        cleanup_path(os.environ['XHARNESS_MACOS_PREVIEW_KEYCHAIN'])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
