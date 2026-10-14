#!/usr/bin/env python3
"""Opt-in compiler mutation acceptance, only in an isolated remote Linux clone.

Not a keyword scanner: inject actual unsafe code / a local allow attribute into
all protected modules, require the compiler to reject every file, restore exact
source bytes in finally, then check the unchanged positive source again.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if sys.platform != 'linux' or os.environ.get('XHARNESS_REMOTE_RUST') != '1':
        parser.error('Rust compilation is remote-only; invoke through SSH on the Linux test server')
    if not root.name.startswith('unsafe-guard-') or not os.environ.get('CARGO_TARGET_DIR'):
        parser.error('use an isolated unsafe-guard-* source clone and an explicit Cargo target directory')
    policy = json.loads((root/'config/architecture-host-modules.json').read_text())
    paths = [root/'crates/xharness-host/src'/row['source'] for row in policy['managedModules']]
    original = {path: path.read_bytes() for path in paths}
    cases = {
        'unsafe_block': '\nfn unsafe_gate_probe() { unsafe { std::ptr::read(&0u8); } }\n',
        'local_allow_cannot_override_forbid': '\n#[allow(unsafe_code)]\nfn unsafe_gate_probe() { unsafe { std::ptr::read(&0u8); } }\n',
    }
    rows = []
    logs = args.receipt.with_suffix('.logs')
    logs.mkdir(parents=True, exist_ok=True)
    command = ['cargo', 'check', '--locked', '-p', 'xharness-host', '--lib']
    try:
        for name, addition in cases.items():
            for path, content in original.items():
                path.write_bytes(content + addition.encode())
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300)
            output = result.stdout + result.stderr
            (logs/f'{name}.log').write_text(output)
            # Guard-origin error and diagnostics for EVERY protected file are
            # required. An unrelated compile error does not count as rejection.
            expected = 'usage of an `unsafe` block' if name == 'unsafe_block' else 'incompatible with previous forbid'
            rejected = [path.name for path in paths if path.name in output]
            passed = result.returncode != 0 and expected in output and len(rejected) == len(paths)
            rows.append({'case': name, 'exit_code': result.returncode, 'passed': passed, 'rejected_files': rejected})
            if not passed:
                raise RuntimeError(f'compiler guard failed for {name}; see {logs}')
    finally:
        for path, content in original.items():
            path.write_bytes(content)
    restored = all(path.read_bytes() == content for path, content in original.items())
    result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300)
    (logs/'positive_restored.log').write_text(result.stdout + result.stderr)
    evidence = {'scope': 'actual_rust_compiler_mutation_on_protected_processors',
                'protected_files': [str(path.relative_to(root)) for path in paths], 'cases': rows,
                'original_source_bytes_restored': restored, 'positive_exit_code': result.returncode,
                'passed': restored and result.returncode == 0 and all(row['passed'] for row in rows)}
    args.receipt.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
