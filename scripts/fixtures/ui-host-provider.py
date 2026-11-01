"""Isolated real-Host transport fixture; no real model account or Rust compilation.

Run on the machine holding a previously built Host executable. The binary version
is caller-selected and must be recorded separately from the UI source revision.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-binary', required=True, type=Path)
    parser.add_argument('--run-dir', required=True, type=Path)
    parser.add_argument('--ui-dir', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    run = args.run_dir.resolve()
    run.mkdir(parents=True, exist_ok=False)
    for directory in ('home', 'workspace'):
        (run / directory).mkdir()

    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def json_reply(self, value):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(value).encode())

        def do_GET(self):
            self.json_reply({'data': [{'id': 'test-model', 'object': 'model', 'owned_by': 'local-test'}]})

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path.endswith('/input_tokens'):
                self.json_reply({'input_tokens': 100})
                return
            users = [m for m in request.get('messages', []) if m.get('role') == 'user']
            last = str(users[-1].get('content', '')) if users else ''
            with (run / 'provider-requests.jsonl').open('a') as file:
                file.write(json.dumps({'at': time.time(), 'path': self.path, 'last': last}) + '\n')
            # Auto-title is a non-stream auxiliary request, not proof of a main reply.
            if not request.get('stream'):
                self.json_reply({'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'Isolated fixture session'}, 'finish_reason': 'stop'}]})
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            if last == 'hold-first':
                time.sleep(20)
            try:
                for chunk in [
                    {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Local provider completed: queued-second'}, 'finish_reason': None}]},
                    {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 5, 'total_tokens': 105}},
                ]:
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # Cancellation intentionally closes the held response.

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    command = [str(args.host_binary.resolve()), '--bind', '127.0.0.1:0', '--workspace', str(run / 'workspace'),
               '--state-dir', str(run / 'state'), '--static-dir', str(args.ui_dir.resolve()),
               '--provider', 'openai-compatible', '--model', 'test-model', '--base-url', f'http://127.0.0.1:{server.server_port}/v1',
               '--context-window', '65536', '--max-output-tokens', '4096', '--ready-file', str(run / 'ready'), '--shutdown-file', str(run / 'stop')]
    env = {'HOME': str(run / 'home'), 'PATH': '/usr/local/bin:/usr/bin:/bin', 'XHARNESS_API_KEY': 'isolated-local-test-only'}
    with (run / 'host.log').open('ab') as log:
        process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    (run / 'host.pid').write_text(str(process.pid))
    try:
        for _ in range(300):
            if process.poll() is not None:
                raise RuntimeError('Isolated Host exited before readiness')
            if (run / 'ready').exists():
                address = (run / 'ready').read_text().strip()
                try:
                    with urllib.request.urlopen('http://' + address + '/health/ready', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
            time.sleep(.2)
        else:
            raise RuntimeError('Host readiness timeout')
        report = {'address': address, 'pid': process.pid, 'providerPort': server.server_port, 'realHost': True, 'paidModel': False}
        (run / 'launch.json').write_text(json.dumps(report))
        print(json.dumps(report), flush=True)
        process.wait()
    finally:
        (run / 'stop').touch()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
        server.shutdown()


if __name__ == '__main__':
    main()
