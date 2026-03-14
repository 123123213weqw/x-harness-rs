"""Zero-bill integration test for the exact container-to-broker transport."""
from pathlib import Path
import subprocess
import tempfile
from broker import Broker, Ledger


def main():
    with tempfile.TemporaryDirectory(prefix="xharness-broker-") as directory:
        broker = Broker("must-never-be-sent", "127.0.0.1", Path(directory) / "api.sock")
        broker.ledger = Ledger()
        try:
            script = """import json,sys,urllib.request,urllib.error
sys.path.insert(0,'/opt/xharness')
from relay import Relay
r=Relay('/broker/api.sock')
try:
 req=urllib.request.Request(r.url+'/chat/completions',data=json.dumps({'model':'deepseek-flash','messages':[]}).encode())
 try: urllib.request.urlopen(req,timeout=5); raise AssertionError('unauthorized accepted')
 except urllib.error.HTTPError as e: assert e.code==403, e.code
 print('container Unix-socket broker preflight passed; zero model calls')
finally: r.stop()
"""
            result = subprocess.run(["docker", "run", "--rm", "--network", "none",
                                     "--mount", f"type=bind,src={directory},dst=/broker,readonly",
                                     "--mount", f"type=bind,src={Path(__file__).with_name('relay.py').resolve()},dst=/opt/xharness/relay.py,readonly",
                                     "alexgshaw/cancel-async-tasks:20251031", "python3", "-c", script],
                                    timeout=30, check=True, capture_output=True, text=True)
            assert broker.ledger.calls == 0
            print(result.stdout.strip())
        finally:
            broker.stop()


if __name__ == "__main__":
    main()
