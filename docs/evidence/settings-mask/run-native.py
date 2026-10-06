"""Serve read-only shipped UI resources to an isolated, non-persistent WKWebView."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('resources', type=Path, help='directory containing index.html and the full UI graph')
parser.add_argument('log', type=Path)
args = parser.parse_args()
resources = args.resources.resolve(strict=True)
assert resources.joinpath('index.html').is_file()
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(resources)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    result = subprocess.run(
        ['xcrun', 'swift', str(Path(__file__).with_name('MaskProbe.swift')),
         f'http://127.0.0.1:{server.server_address[1]}/?fixture=1'],
        capture_output=True, text=True, timeout=70)
    receipt = result.stdout + result.stderr
    args.log.write_text(receipt)
    print(receipt, end='')
    raise SystemExit(result.returncode)
finally:
    server.shutdown()
    server.server_close()
