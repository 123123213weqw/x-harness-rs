#!/usr/bin/env python3
"""Opt-in Rust production-agent acceptance on V100 through a nonce-authenticated
SSH loopback relay. API keys stay in local memory. No arbitrary provider host,
no deployment, no rollback, and no automatic retry of side effects.
"""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import secrets
import subprocess
import threading
import urllib.error
import urllib.request

SSH = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
       '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
       '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes']


def credential(state):
    if os.environ.get('XHARNESS_EVAL_API_KEY'):
        return os.environ['XHARNESS_EVAL_API_KEY']
    service = 'com.xlang.xharness.models.' + hashlib.sha256(str(state.resolve()).encode()).hexdigest()
    result = subprocess.run(['security', 'find-generic-password', '-s', service,
                             '-a', 'XHARNESS_DEEPSEEK_ONLY_KEY', '-w'], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError('Local configured credential unavailable')
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', default='WZU_Server')
    parser.add_argument('--state', type=pathlib.Path, default=pathlib.Path.home()/'Library/Application Support/com.xlang.xharness/state')
    parser.add_argument('--receipt', type=pathlib.Path, required=True)
    args = parser.parse_args()
    key = credential(args.state)
    nonce = secrets.token_urlsafe(32)
    ledger = []
    requests = 0
    lock = threading.Lock()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            nonlocal requests
            if self.headers.get('Authorization') != 'Bearer ' + nonce:
                self.send_error(403)
                return
            if self.path not in ['/chat/completions', '/v1/chat/completions']:
                self.send_error(404)
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2_000_000:
                self.send_error(413)
                return
            body = json.loads(self.rfile.read(length))
            if body.get('model') != 'deepseek-flash':
                self.send_error(400)
                return
            with lock:
                if requests >= 20:
                    self.send_error(429)
                    return
                requests += 1
                index = requests
            # A bounded, opt-in acceptance budget, not a product output limit.
            body['max_tokens'] = 8192
            if body.get('stream'):
                body['stream_options'] = {'include_usage': True}
            wire = json.dumps(body).encode()
            request = urllib.request.Request('https://api.deepseek.com/chat/completions', wire,
                {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            raw = bytearray()
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=150) as response:
                    self.send_response(response.status)
                    self.send_header('Content-Type', response.headers.get('Content-Type', 'text/event-stream'))
                    self.end_headers()
                    while True:
                        chunk = response.read1(16384)
                        if not chunk:
                            break
                        raw.extend(chunk)
                        self.wfile.write(chunk)
                        self.wfile.flush()
                usages = []
                for line in raw.decode(errors='replace').splitlines():
                    if line.startswith('data: ') and line[6:] != '[DONE]':
                        event = json.loads(line[6:])
                        if event.get('usage'):
                            usages.append(event['usage'])
                with lock:
                    ledger.append({'request': index, 'reported_usage': usages[-1] if usages else None,
                                   'input_messages': len(body.get('messages', []))})
            except (urllib.error.URLError, OSError) as error:
                with lock:
                    ledger.append({'request': index, 'transport_failure': type(error).__name__, 'reported_usage': None})
                self.close_connection = True
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Reserve an otherwise unused high port for this isolated reverse tunnel.
    remote_port = 35061
    fixture = '/tmp/xharness-revert-live-' + secrets.token_hex(8)
    command = ('cd ~/codex-build/x-harness-rs/subagent-first-request-20261013 && '
               f'XHARNESS_REVERT_FIXTURE={fixture} XHARNESS_REVERT_MODEL=deepseek-flash '
               f'XHARNESS_REVERT_RELAY=http://127.0.0.1:{remote_port} XHARNESS_REVERT_NONCE={nonce} '
               '~/codex-build/x-harness-rs/subagent-first-request-target-20261013/debug/examples/subagent_revert_acceptance')
    result = None
    try:
        result = subprocess.run(SSH + ['-R', f'127.0.0.1:{remote_port}:127.0.0.1:{server.server_port}',
                                       args.server, command], capture_output=True, text=True, timeout=600)
        evidence = {'scope': 'real_rust_production_agent_tool', 'passed': result.returncode == 0,
                    'exit_code': result.returncode, 'fixture': fixture, 'requests': requests,
                    'usage_receipts': ledger, 'stdout': result.stdout, 'stderr': result.stderr,
                    'provider_api_key_sent_to_server': False, 'filesystem_rollback': False}
        # Never include the nonce or provider key in output evidence.
        encoded = json.dumps(evidence, ensure_ascii=False, indent=2)
        encoded = encoded.replace(nonce, '[REDACTED_NONCE]').replace(key, '[REDACTED_KEY]')
        args.receipt.write_text(encoded)
        print(json.dumps({'passed': evidence['passed'], 'requests': requests,
                          'receipt': str(args.receipt), 'exit_code': result.returncode}))
        if result.returncode:
            raise SystemExit(result.returncode)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
