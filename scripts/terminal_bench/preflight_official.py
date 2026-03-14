"""Run the installed official full headless against a zero-cost mock endpoint."""
import argparse
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
from socketserver import ThreadingMixIn, UnixStreamServer
import subprocess
import tempfile
import threading
import uuid


def run(args):
    evidence = []
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    name = 'xhbench-official-' + uuid.uuid4().hex[:12]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.connection.settimeout(10)
            size = int(self.headers.get('Content-Length', '0'))
            if self.path not in ('/v1/chat/completions', '/chat/completions'):
                # Match an absent optional provider API: XHarness can fall
                # back to its native token estimate after an unsupported route.
                return self.send_error(404)
            if not 0 < size < 2**20:
                return self.send_error(400)
            if self.headers.get('Authorization') != 'Bearer fixture-capability':
                return self.send_error(403)
            if len(evidence) >= 8:
                return self.send_error(429)
            body = json.loads(self.rfile.read(size))
            tools = {tool['function']['name']: tool['function'] for tool in body.get('tools', [])}
            tool_results = [str(m.get('content')) for m in body['messages'] if m['role'] == 'tool']
            evidence.append({'tool_names': sorted(tools), 'tool_results': tool_results,
                             'model': body.get('model'), 'max_tokens': body.get('max_tokens')})
            calls = None
            shell_tool = next((name for name in tools if name.lower() == 'bash'), None)
            if shell_tool and not tool_results:
                properties = tools[shell_tool]['parameters'].get('properties', {})
                arguments = {key: value for key, value in {'command': 'pwd', 'description': 'Read working directory'}.items()
                             if key in properties}
                calls = [{'index': 0, 'id': 'fixture-pwd', 'type': 'function',
                          'function': {'name': shell_tool, 'arguments': json.dumps(arguments)}}]
            delta = {'role': 'assistant', 'reasoning_content': 'Checking the workspace.'}
            delta.update({'tool_calls': calls} if calls else {'content': 'Fixture complete.'})
            usage = {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
            self.end_headers()
            if body.get('stream'):
                for item in [
                    {'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                    {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if calls else 'stop'}], 'usage': usage},
                ]:
                    self.wfile.write(('data: ' + json.dumps(item) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.wfile.write(json.dumps({'choices': [{'index': 0, 'message': delta, 'finish_reason': 'stop'}], 'usage': usage}).encode())

    class Server(ThreadingMixIn, UnixStreamServer):
        daemon_threads = True

    with tempfile.TemporaryDirectory(prefix='xhbench-official-mock-') as directory:
        server = Server(str(Path(directory) / 'api.sock'), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = {'capability': 'fixture-capability', 'instruction': 'Run pwd once and report the working directory.',
                      'seconds': 60, 'context_window': 65536, 'max_output_tokens': 16384}
            command = ['docker', 'run', '--rm', '-i', '--name', name, '--network', 'none',
                       '--cpus', '1', '--memory', '2g',
                       '--mount', f'type=bind,src={directory},dst=/opt/benchmark-broker,readonly',
                       '--mount', f'type=bind,src={Path(__file__).parent.resolve()},dst=/opt/bench,readonly',
                       '--mount', f'type=bind,src={output},dst=/logs/agent']
            if args.harness == 'official':
                command += ['--mount', f'type=bind,src={args.runtime.resolve()},dst=/opt/official,readonly']
                launcher = 'official_headless.py'
            else:
                command += ['--mount', f'type=bind,src={args.binary.resolve()},dst=/opt/xharness/xharness-host,readonly']
                launcher = 'headless.py'
            command += [args.image, 'python3', '/opt/bench/' + launcher]
            result = subprocess.run(command, input=json.dumps(config), text=True, capture_output=True, timeout=90)
            (output / 'launcher.json').write_text(json.dumps({'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
            (output / 'wire-summary.json').write_text(json.dumps(evidence, indent=2))
            passed = result.returncode == 0 and any('/app' in value for item in evidence for value in item['tool_results'])
            print(json.dumps({'native_tool_preflight': 'PASS' if passed else 'FAIL', 'harness': args.harness,
                              'mock_requests': len(evidence), 'real_model_requests': 0,
                              'exit_code': result.returncode}))
            return 0 if passed else 1
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--harness', choices=('official', 'xharness'), default='official')
    parser.add_argument('--image', default='alexgshaw/cancel-async-tasks:20251031')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (args.harness == 'official' and not args.runtime) or (args.harness == 'xharness' and not args.binary):
        parser.error('official requires --runtime; xharness requires --binary')
    raise SystemExit(run(args))
