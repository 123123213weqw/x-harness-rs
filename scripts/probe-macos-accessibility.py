#!/usr/bin/env python3
"""Opt-in, read-only JXA regression probe. Retains counts/timings, not UI text."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('native macOS required; this is not a simulated AX test')
    source = Path(__file__).resolve().parents[1] / 'crates/xharness-computer-macos/src/accessibility-snapshot.js'
    script = source.read_text()
    cases = [
        ('windows', {'include_nodes': False}),
        ('low', {'max_nodes': 80, 'max_depth': 4}),
        ('auto', {'max_nodes': 220, 'max_depth': 8}),
        ('semantic', {'max_nodes': 300, 'max_depth': 10}),
    ]
    rows = []
    for name, options in cases:
        start = time.monotonic()
        row = {'case': name}
        try:
            result = subprocess.run(
                ['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, '--', json.dumps(options)],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=12,
            )
            row['exit_code'] = result.returncode
            if result.returncode == 0:
                value = json.loads(result.stdout)
                row.update(windows=len(value['windows']), nodes=len(value['nodes']),
                           truncated=value['truncated'], reasons=value['truncation_reasons'],
                           elapsed_ms=value['elapsed_ms'])
                row['passed'] = row['windows'] > 0 and value['elapsed_ms'] < 12000
                if name == 'windows':
                    row['passed'] = row['passed'] and row['nodes'] == 0
            else:
                # Do not retain stderr: it can contain application/UI text.
                row['passed'] = False
        except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError):
            row['passed'] = False
            row['error'] = 'timeout_or_invalid_snapshot'
        row['seconds'] = round(time.monotonic() - start, 3)
        rows.append(row)
        print(json.dumps(row), flush=True)
    receipt = {'script_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
               'scope': 'native JXA script only; does not run the Rust Host or capture screenshots',
               'cases': rows, 'passed': all(row['passed'] for row in rows)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
