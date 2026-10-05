#!/usr/bin/env python3
"""Loopback-only disposable-VM test bridge, never a product service."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Lock

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--port', type=int, default=18086)
args = parser.parse_args()
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
lock = Lock()
files = {'/shop.html': ('shop.html', 'text/html; charset=utf-8'),
         '/guest-shopping.ps1': ('guest-shopping.ps1', 'text/plain; charset=utf-8'),
         '/computer-probe.exe': ('computer-probe.exe', 'application/octet-stream'),
         '/computer-provenance.json': ('computer-provenance.json', 'application/json'),
         '/browser-next': ('browser-next.json', 'application/json'),
         '/browser-latest': ('browser-latest.json', 'application/json'),
         '/shop-history': ('shop-events.jsonl', 'application/x-ndjson')}

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)
    def send(self, data, content_type='text/plain', status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path not in files:
            return self.send(b'Not published', status=404)
        filename, mime = files[self.path]
        try:
            data=(root/filename).read_bytes()
        except FileNotFoundError:
            if self.path in ('/browser-next', '/browser-latest'):
                data=b'{}'
            else:
                return self.send(b'Not prepared', status=404)
        self.send(data, mime)
    def do_POST(self):
        if self.path not in ('/browser-job', '/browser-result', '/shop-event'):
            return self.send(b'Not published', status=404)
        limit=128*1024 if self.path=='/browser-job' else 1024*1024
        try:
            length=int(self.headers.get('Content-Length', '0'))
            if not 0<length<=limit:
                return self.send(b'Body limit', status=413)
            value=json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                return self.send(b'Object required', status=400)
            if self.path=='/browser-job' and not value.get('stop'):
                if type(value.get('id')) is not int or not 0<=value['id']<80 or not isinstance(value.get('request'),dict):
                    return self.send(b'Invalid job', status=400)
            with lock:
                if self.path=='/browser-job':
                    name='browser-next.json'
                else:
                    value['host_received_utc']=datetime.now(timezone.utc).isoformat()
                    name='browser-latest.json' if self.path=='/browser-result' else None
                    log='browser-results.jsonl' if self.path=='/browser-result' else 'shop-events.jsonl'
                    with (root/log).open('a') as stream:
                        stream.write(json.dumps(value, ensure_ascii=False)+'\n')
                if name:
                    temporary=root/(name+'.tmp')
                    temporary.write_text(json.dumps(value, ensure_ascii=False))
                    temporary.replace(root/name)
        except (ValueError, TimeoutError):
            return self.send(b'Invalid input', status=400)
        self.send(b'OK')

server=ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
print(json.dumps({'port':server.server_address[1], 'root':str(root)}), flush=True)
server.serve_forever()
