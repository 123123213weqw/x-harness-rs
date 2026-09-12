"""Read-only native code-signing verification shared by build and update tests.

Ad-hoc previews never claim Gatekeeper acceptance or Apple notarization. No
keychains, quarantine attributes, signatures or system security settings change.
"""
from pathlib import Path
import re
import subprocess


def verify(app, *, preview=False, evidence=None, team=None):
    def inspect(label, command):
        result = subprocess.run([str(arg) for arg in command], check=True, capture_output=True)
        if evidence is not None:
            (Path(evidence) / (label + '.log')).write_bytes(result.stdout + result.stderr)
        return (result.stdout + result.stderr).decode('utf-8', errors='replace')

    inspect('codesign', ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
    details = inspect('codesign-identity', ['codesign', '-dv', '--verbose=4', app])
    lines = details.splitlines()
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
