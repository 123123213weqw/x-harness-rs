"""Read-only native code-signing verification shared by build and update tests.

Ad-hoc previews never claim Gatekeeper acceptance or Apple notarization. No
keychains, quarantine attributes, signatures or system security settings change.
"""
from pathlib import Path
import re
import hashlib
import tempfile
import subprocess


# Sign inside-out; the app/Main executable retain the same public bundle ID.
COMPONENT_IDENTIFIERS = {
    'Contents/MacOS/rg': 'com.xlang.xharness.rg',
    'Contents/MacOS/xharness-host': 'com.xlang.xharness.host',
    'Contents/MacOS/xharness-desktop': 'com.xlang.xharness',
    '.': 'com.xlang.xharness',
}


def requirement(identifier, fingerprint):
    if not re.fullmatch(r'[0-9a-f]{40}', fingerprint or ''):
        raise ValueError('Invalid pinned signing certificate')
    return f'identifier "{identifier}" and certificate leaf = H"{fingerprint}"'


def verify(app, *, preview=False, evidence=None, team=None, fingerprint=None):
    def inspect(label, command):
        result = subprocess.run([str(arg) for arg in command], check=True, capture_output=True, timeout=90)
        if evidence is not None:
            (Path(evidence) / (label + '.log')).write_bytes(result.stdout + result.stderr)
        return (result.stdout + result.stderr).decode('utf-8', errors='replace')

    if fingerprint is not None and (preview or team is not None):
        raise ValueError('Signing policies must not be combined')
    if fingerprint is not None:
        requirement('com.xlang.xharness', fingerprint)
    inspect('codesign', ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
    details = inspect('codesign-identity', ['codesign', '-dv', '--verbose=4', app])
    lines = details.splitlines()
    if fingerprint is not None:
        if 'Signature=adhoc' in lines:
            raise ValueError('Fixed publisher preview cannot use ad-hoc signing')
        for index, (relative, identifier) in enumerate(COMPONENT_IDENTIFIERS.items()):
            target = Path(app) if relative == '.' else Path(app) / relative
            if not target.exists() or target.is_symlink():
                raise ValueError('Signed component missing or symlinked')
            expected = requirement(identifier, fingerprint)
            inspect(f'component-{index}-verify', ['codesign', '--verify', '--strict', '-R', '=' + expected, target])
            actual = inspect(f'component-{index}-requirement', ['codesign', '-d', '-r-', target])
            designated = [line.removeprefix('designated => ').strip() for line in actual.splitlines()
                          if line.startswith('designated => ')]
            if designated != [expected]:
                raise ValueError('Designated requirement differs from the fixed publisher policy')
            with tempfile.TemporaryDirectory(prefix='xharness-public-certificate-') as folder:
                prefix = Path(folder) / 'certificate'
                # codesign uses an optional long-option argument: a separate
                # prefix is parsed as a signing target, not as the output path.
                inspect(f'component-{index}-certificate', ['codesign', '-d', '--extract-certificates=' + str(prefix), target])
                certificate = Path(str(prefix) + '0')
                if hashlib.sha1(certificate.read_bytes()).hexdigest() != fingerprint:
                    raise ValueError('Code-signing leaf certificate differs from the pinned publisher')
                inspect(f'component-{index}-expiry', ['openssl', 'x509', '-inform', 'DER', '-in', certificate,
                                                     '-checkend', '0', '-noout'])
        return {'codesignVerified': True, 'fixedCertificateVerified': True, 'designatedRequirementVerified': True}
    if preview:
        if 'Signature=adhoc' not in lines:
            raise ValueError('Mac preview must have a verified ad-hoc signature')
        return {'codesignVerified': True, 'adHocSignatureVerified': True}
    if 'Signature=adhoc' in lines or not any(line.startswith('Authority=Developer ID Application:') for line in lines):
        raise ValueError('Notarized release requires Developer ID Application signing')
    if team is not None and (not re.fullmatch(r'[A-Z0-9]{10}', team) or f'TeamIdentifier={team}' not in lines):
        raise ValueError('Signed application team differs from configured team')
    inspect('gatekeeper', ['spctl', '--assess', '--type', 'execute', '--verbose=4', app])
    inspect('stapler', ['xcrun', 'stapler', 'validate', app])
    return {'codesignVerified': True, 'gatekeeperAccepted': True, 'notarizationStapleVerified': True}


def verify_continuity(old_app, new_app, fingerprint):
    """Verify both versions AND that every new component satisfies the old DR."""
    verify(old_app, fingerprint=fingerprint)
    verify(new_app, fingerprint=fingerprint)
    for relative, identifier in COMPONENT_IDENTIFIERS.items():
        target = Path(new_app) if relative == '.' else Path(new_app) / relative
        subprocess.run(['codesign', '--verify', '--strict', '-R', '=' + requirement(identifier, fingerprint), str(target)],
                       check=True, capture_output=True, timeout=90)
    return {'signingIdentityContinuityVerified': True}
