"""Add verified symbols to the immutable candidate BEFORE draft creation."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

spec = importlib.util.spec_from_file_location('symbols', Path(__file__).with_name('archive-desktop-symbols.py'))
symbols = importlib.util.module_from_spec(spec)
spec.loader.exec_module(symbols)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--symbols', required=True, type=Path)
    args = parser.parse_args()
    plan = json.loads((args.candidate / 'plan.json').read_text(encoding='utf-8'))
    symbols.verify_archive(args.symbols, plan['sha'])
    destination = args.candidate / 'release/windows-debug-symbols.zip'
    if destination.exists() or (args.candidate / 'draft-created.json').exists():
        raise ValueError('refusing to mutate an existing symbol candidate or draft')
    shutil.copyfile(args.symbols, destination)
    inventory = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
                        for path in sorted(destination.parent.iterdir(), key=lambda path: path.name) if path.name != 'SHA256SUMS')
    (destination.parent / 'SHA256SUMS').write_text(inventory, encoding='ascii', newline='\n')
