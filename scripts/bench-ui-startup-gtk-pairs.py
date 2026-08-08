"""Sequential full-UI baseline/candidate pairs, fresh WebKitGTK process trees.

UI_STARTUP_BASELINE=... UI_STARTUP_RESULTS=... UI_STARTUP_REPEATS=3 python3 -B ...
No Tauri, real Host, model traffic or changes to running application data.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading

baseline = Path(os.environ['UI_STARTUP_BASELINE']).resolve()
output = Path(os.environ.get('UI_STARTUP_RESULTS', '/tmp/xh-ui-startup-gtk')).resolve()
repetitions = int(os.environ.get('UI_STARTUP_REPEATS', '3'))
if not 1 <= repetitions <= 30:
    raise ValueError('repetitions must be in [1,30]')
roots = {'baseline': baseline, 'optimized': Path('ui/dist').resolve()}
servers, receipts = {}, []


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


try:
    for variant, folder in roots.items():
        if not (folder / 'index.html').is_file():
            raise FileNotFoundError(folder / 'index.html')
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(folder)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers[variant] = (server, thread)
    for scenario in ['empty', 'history']:
        for repetition in range(repetitions):
            for variant in (['baseline', 'optimized'] if repetition % 2 == 0 else ['optimized', 'baseline']):
                file = output / f'{scenario}-{variant}-{repetition}.json'
                url = f'http://127.0.0.1:{servers[variant][0].server_port}/?fixture=1'
                command = ['xvfb-run', '-a', 'python3', '-B', 'scripts/bench-ui-startup-gtk.py', '--url', url, '--output', str(file)]
                if scenario == 'history':
                    command += ['--session', 'fx-alpha']
                completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=85)
                if completed.returncode:
                    print(completed.stdout, completed.stderr, flush=True)
                    raise RuntimeError('GTK probe failed')
                data = json.loads(file.read_text())
                data.update(scenario=scenario, variant=variant, repetition=repetition)
                receipts.append(data)
                print(json.dumps({key: data.get(key) for key in ['scenario', 'variant', 'repetition', 'startup', 'startupPeakPssMiB', 'peakPssMiB', 'firstCode', 'errors']}), flush=True)
finally:
    for server, thread in servers.values():
        server.shutdown()
        server.server_close()
        thread.join()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'all.json').write_text(json.dumps(receipts, indent=2) + '\n')
if len(receipts) != repetitions * 4:
    raise RuntimeError('incomplete paired startup measurement')
print('GTK_PAIRED_PASSED', flush=True)
