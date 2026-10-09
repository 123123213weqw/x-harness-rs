#!/usr/bin/env python3
"""Loopback-only disposable-VM test bridge, never a product service."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import struct
from pathlib import Path
from threading import Lock

lock = Lock()
files = {'/shop.html': ('shop.html', 'text/html; charset=utf-8'),
         '/guest-shopping.ps1': ('guest-shopping.ps1', 'text/plain; charset=utf-8'),
         '/computer-probe.exe': ('computer-probe.exe', 'application/octet-stream'),
         '/computer-provenance.json': ('computer-provenance.json', 'application/json'),
         '/browser-next': ('browser-next.json', 'application/json'),
         '/browser-latest': ('browser-latest.json', 'application/json'),
         '/shop-history': ('shop-events.jsonl', 'application/x-ndjson')}

def image_name(path):
    match = re.fullmatch(r'/browser-image/(0|[1-9][0-9]?)\.png', path)
    return f"browser-image-{match[1]}.png" if match and int(match[1]) < 80 else None

def valid_png(data):
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        return False
    width, height = struct.unpack('>II', data[16:24])
    return 0 < width <= 16384 and 0 < height <= 16384 and width * height <= 64000000

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
        binary = image_name(self.path)
        if binary:
            filename, mime = binary, 'image/png'
        elif self.path in files:
            filename, mime = files[self.path]
        else:
            return self.send(b'Not published', status=404)
        try:
            # Windows readers can deny replacement while their file handle is
            # open. Serialize the entire read with publication, not the socket
            # response: slow clients must never hold the filesystem lock.
            with lock:
                data=(root/filename).read_bytes()
        except FileNotFoundError:
            if self.path in ('/browser-next', '/browser-latest'):
                data=b'{}'
            else:
                return self.send(b'Not prepared', status=404)
        self.send(data, mime)
    def do_POST(self):
        binary = image_name(self.path)
        if binary:
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8 * 1024 * 1024:
                    return self.send(b'Body limit', status=413)
                data = self.rfile.read(length)
                if len(data) != length or not valid_png(data):
                    return self.send(b'Invalid PNG header', status=400)
                with lock:
                    temporary = root / (binary + '.tmp')
                    temporary.write_bytes(data)
                    temporary.replace(root / binary)
            except (ValueError, TimeoutError):
                return self.send(b'Invalid input', status=400)
            return self.send(b'OK')
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

def main(handler_class=Handler):
    global root
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18086)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler_class) as server:
        print(json.dumps({'port':server.server_address[1], 'root':str(root)}), flush=True)
        server.serve_forever()

if __name__ == '__main__':
    main()
