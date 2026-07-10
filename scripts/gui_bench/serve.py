"""One overnight credential/budget controller, shared by every trial and retry.

The real key stays in memory. Child Hosts receive only an expiring loopback
capability. The private control file is outside the repository and is removed
on shutdown; numeric accounting survives both clean shutdown and crashes.
"""
import argparse
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import signal
import threading
import urllib.request

from scripts.gui_bench.budget import BudgetLedger, normalize_gui
from scripts.terminal_bench.broker import Broker


def local_credential(state_dir):
    # Reuse the existing evaluation credential resolution, not desktop secrets.
    source = Path(__file__).resolve().parents[1] / 'eval-compact-task-scope.py'
    spec = importlib.util.spec_from_file_location('xh_gui_credential', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.credential(state_dir)


def balance(key):
    request = urllib.request.Request('https://api.deepseek.com/user/balance',
                                     headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(request, timeout=15) as result:
            payload = json.load(result)
        return [row for row in payload.get('balance_infos', []) if row.get('currency') == 'CNY']
    except Exception:
        return None  # Balance is ancillary, never required for cost admission.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--deadline', required=True, help='timezone-aware ISO time')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / 'Library/Application Support/com.xlang.xharness/state')
    args = parser.parse_args()
    deadline = datetime.fromisoformat(args.deadline)
    if deadline.tzinfo is None:
        raise ValueError('deadline must have a timezone')
    seconds = deadline.timestamp() - datetime.now().timestamp()
    args.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.root, 0o700)
    ledger = BudgetLedger(args.root / 'budget.json', seconds=seconds)
    broker, control = None, args.root / 'capability.json'
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    try:
        key = local_credential(args.state_dir)
        start_balance = balance(key)
        broker = Broker(key, '127.0.0.1', request_normalizer=normalize_gui, max_body=48*1024*1024)
        broker.ledger = ledger
        fd = os.open(control, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump({'base_url': broker.url, 'capability': ledger.token}, stream)
        print('GUI benchmark budget controller ready; ceiling CNY 200', flush=True)
        stop.wait(max(0, ledger.wall_deadline - datetime.now().timestamp()))
        ledger.close(wait_seconds=120)
        (args.root / 'account-balance.json').write_text(json.dumps({
            'start': start_balance, 'end': balance(key),
            'caveat': 'Other account clients may consume balance; not a per-run invoice.'}, indent=2))
    finally:
        control.unlink(missing_ok=True)
        if broker:
            broker.stop()
        ledger.release()


if __name__ == '__main__':
    main()
