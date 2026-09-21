"""Loopback-only V100 disposable-VM artifact transport, not a product server."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json

parser=argparse.ArgumentParser()
parser.add_argument('--root',type=Path,required=True)
args=parser.parse_args()
root=args.root.resolve()
allowed={'guest.ps1','run.cmd','provenance.json','browser-inspect-probe.exe','browser-bounds-baseline.exe'}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name=self.path.removeprefix('/')
        if name not in allowed or not (root/name).is_file():
            self.send_error(404);return
        body=(root/name).read_bytes()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_POST(self):
        size=int(self.headers.get('Content-Length','0'))
        if self.path!='/result' or not 0<size<=262144:
            self.send_error(400);return
        try: value=json.loads(self.rfile.read(size))
        except (ValueError,UnicodeError):self.send_error(400);return
        if not isinstance(value,dict) or value.get('uuid')!='66B64058-BDCC-43E9-85EE-55A79FE2E875':
            self.send_error(403);return
        with (root/'guest-results.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(value,ensure_ascii=False)+'\n')
        self.send_response(200);self.end_headers();self.wfile.write(b'ok')
ThreadingHTTPServer(('127.0.0.1',18125),Handler).serve_forever()
