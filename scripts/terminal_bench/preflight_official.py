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
            if self.path not in ('/v1/chat/completions', '/chat/completions') or not 0 < size < 2**20:
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
            if 'bash' in tools and not tool_results:
                properties = tools['bash']['parameters'].get('properties', {})
                arguments = {key: value for key, value in {'command': 'pwd', 'description': 'Read working directory'}.items()
                             if key in properties}
                calls = [{'index': 0, 'id': 'fixture-pwd', 'type': 'function',
                          'function': {'name': 'bash', 'arguments': json.dumps(arguments)}}]
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
                       '--mount', f'type=bind,src={args.runtime.resolve()},dst=/opt/official,readonly',
                       '--mount', f'type=bind,src={Path(__file__).parent.resolve()},dst=/opt/bench,readonly',
                       '--mount', f'type=bind,src={output},dst=/logs/agent',
                       'alexgshaw/cancel-async-tasks:20251031', 'python3', '/opt/bench/official_headless.py']
            result = subprocess.run(command, input=json.dumps(config), text=True, capture_output=True, timeout=90)
            (output / 'launcher.json').write_text(json.dumps({'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
            (output / 'wire-summary.json').write_text(json.dumps(evidence, indent=2))
            passed = result.returncode == 0 and any('/app' in value for item in evidence for value in item['tool_results'])
            print(json.dumps({'official_native_tool_preflight': 'PASS' if passed else 'FAIL',
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
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    raise SystemExit(run(parser.parse_args()))
