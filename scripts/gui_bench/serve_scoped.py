"""One new, explicit USD-capped browser experiment; never resets an old ledger.

The real provider key stays in local memory. Every request reserves the full
model input/output envelope durably before forwarding. Missing usage retains
that reservation. A crash closes the scope: an existing checkpoint is never
silently reopened with a fresh budget. This controller is not production code.
"""
import argparse
import fcntl
import hmac
import json
import os
from pathlib import Path
import signal
import tempfile
import threading

from scripts.gui_bench.budget import normalize_gui, INPUT_LIMIT, OUTPUT_LIMIT
from scripts.gui_bench.serve import local_credential
from scripts.terminal_bench.broker import Broker, Ledger, INPUT_RATE, OUTPUT_RATE

POLICY = dict(model='deepseek-flash', currency='USD', input_limit=INPUT_LIMIT,
              output_limit=OUTPUT_LIMIT, input_per_million=0.30,
              output_per_million=1.20, source_date='2026-10-06',
              source='https://api-docs.deepseek.com/quick_start/pricing/')


class ScopedLedger(Ledger):
    def __init__(self, path, *, dollars=1.0, calls=80, seconds=1800):
        if not 0 < dollars <= 1 or not 0 < calls <= 80 or not 0 < seconds <= 1800:
            raise ValueError('invalid explicit experiment limits')
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(str(self.path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.owner = os.fdopen(fd, 'a')
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists() or self.path.is_symlink():
                raise ValueError('existing ledger cannot be reset or reopened')
            from types import SimpleNamespace
            super().__init__(protocol=SimpleNamespace(dollars=dollars, max_calls=calls,
                              seconds=seconds, max_output_tokens=OUTPUT_LIMIT))
            with self.lock:
                self._save()
        except BaseException:
            self.owner.close()
            raise

    def _document(self):
        return dict(policy=POLICY, requests=self.calls, conservative_usd=self.spent,
                    limit_usd=self.limit, pending_requests=self.inflight,
                    budget_denials=self.denials, closed=not self.active,
                    rows=list(self.rows))

    def _save(self):
        fd, name = tempfile.mkstemp(prefix='.scope-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(self._document(), file, allow_nan=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def reserve(self, token, _bytes):
        # Base ledger reserves bytes+8192 input tokens. Feed a fixed envelope;
        # never equate a serialized request's byte length with exact tokens.
        ticket = super().reserve(token, INPUT_LIMIT - 8192)
        try:
            with self.lock:
                self._save()
        except BaseException:
            with self.lock:
                self.active = False
            raise  # No request is forwarded without durable admission.
        return ticket

    def settle(self, reserved, usage, status, elapsed, evidence=None):
        # Persist only numeric billing fields, never arbitrary response payloads.
        if isinstance(usage, dict):
            usage = {key: usage.get(key) for key in ('prompt_tokens', 'completion_tokens')}
        super().settle(reserved, usage, status, elapsed, evidence)
        with self.lock:
            try:
                self._save()
            except BaseException:
                self.active = False
                raise

    def receipt(self, token):
        with self.lock:
            if not hmac.compare_digest(token, self.token):
                raise PermissionError('invalid scope capability')
            return self._document()

    def close(self, wait_seconds=0):
        super().close(wait_seconds)
        with self.lock:
            self._save()
            return self._document()

    def release(self):
        self.owner.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=1800)
    parser.add_argument('--state-dir', type=Path,
                        default=Path.home()/'Library/Application Support/com.xlang.xharness/state')
    args = parser.parse_args()
    args.root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.root, 0o700)
    ledger = ScopedLedger(args.root/'budget-usd.json', seconds=args.seconds)
    broker, control = None, args.root/'capability.json'
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    try:
        broker = Broker(local_credential(args.state_dir), '127.0.0.1',
                        request_normalizer=normalize_gui, max_body=48*1024*1024)
        broker.ledger = ledger
        fd = os.open(control, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(dict(base_url=broker.url, capability=ledger.token), file)
        print('New browser-only experiment ready; USD 1 admission ceiling; real key stays local.', flush=True)
        stop.wait(args.seconds)
    finally:
        try:
            ledger.close(wait_seconds=120)
        finally:
            control.unlink(missing_ok=True)
            try:
                if broker:
                    broker.ledger = None # Already closed; disk errors must not skip socket teardown.
                    broker.stop()
            finally:
                ledger.release()


if __name__ == '__main__':
    main()
