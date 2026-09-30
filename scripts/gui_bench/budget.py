"""Crash-resumable CNY admission for the existing credential broker.

Reserve the model's entire input window, not screenshot bytes. Unknown usage
retains that reservation. Files contain numbers/closed labels only; credentials,
prompts, tool arguments and provider response bodies are never checkpointed.
"""
from dataclasses import dataclass
from decimal import Decimal
import fcntl
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time

from scripts.terminal_bench.broker import BudgetError

INPUT_LIMIT = 1_000_000
OUTPUT_LIMIT = 8192
INPUT_CNY = Decimal('2') / 1_000_000
OUTPUT_CNY = Decimal('8') / 1_000_000
RESERVATION = INPUT_LIMIT * INPUT_CNY + OUTPUT_LIMIT * OUTPUT_CNY
POLICY = {'model': 'deepseek-flash', 'input_limit': INPUT_LIMIT,
          'output_limit': OUTPUT_LIMIT, 'input_cny_per_million': 2,
          'output_cny_per_million': 8, 'source_date': '2026-09-30'}


@dataclass(frozen=True)
class Ticket:
    sequence: int


class BudgetLedger:
    protocol = None

    def __init__(self, path, *, limit_cny='200', calls=2000, seconds=3600):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise ValueError('budget checkpoint must not be a symlink')
        limit = Decimal(str(limit_cny))
        if not limit.is_finite() or not 0 < limit <= 200:
            raise ValueError('CNY ceiling must be positive and at most 200')
        if type(calls) is not int or calls < 1 or not math.isfinite(seconds) or seconds <= 0:
            raise ValueError('invalid call or duration limit')
        fd = os.open(str(self.path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.owner = os.fdopen(fd, 'a')
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.owner.close()
            raise
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.active, self.started = True, True
        self.denials, self.inflight = 0, 0
        self.limit, self.max_calls = limit, calls
        self.spent, self.calls, self.rows, self.pending = Decimal(0), 0, [], {}
        self.wall_deadline = time.time() + seconds
        try:
            if self.path.exists():
                doc = json.loads(self.path.read_text())
                if doc['policy'] != POLICY or Decimal(doc['limit_cny']) != limit or doc['max_calls'] != calls:
                    raise ValueError('resume cannot change budget policy or ceiling')
                if doc['closed']:
                    raise ValueError('budget already closed; do not create a replacement budget')
                self.spent = Decimal(doc['conservative_cny'])
                self.calls, self.rows = doc['requests'], doc['rows']
                self.denials = doc['budget_denials']
                self.wall_deadline = min(self.wall_deadline, doc['wall_deadline'])
                if (not self.spent.is_finite() or self.spent < 0 or self.spent > limit
                        or type(self.calls) is not int or not 0 <= self.calls <= calls):
                    raise ValueError('invalid budget checkpoint')
                for sequence in doc['pending']:
                    self.rows.append({'sequence': int(sequence), 'status': 'crash_unknown',
                                      'usage': None, 'conservative_cny': str(RESERVATION)})
            self.deadline = time.monotonic() + max(0, self.wall_deadline - time.time())
            self._save()
        except BaseException:
            self.owner.close()
            raise

    def _document(self):
        return {'version': 1, 'policy': POLICY, 'limit_cny': str(self.limit),
                'max_calls': self.max_calls, 'wall_deadline': self.wall_deadline,
                'requests': self.calls, 'conservative_cny': str(self.spent),
                'rows': list(self.rows), 'pending': dict(self.pending),
                'budget_denials': self.denials, 'closed': not self.active}

    def _save(self):
        # Called under the ledger lock. Durable admission precedes forwarding.
        data = json.dumps(self._document(), sort_keys=True, allow_nan=False).encode()
        fd, temporary = tempfile.mkstemp(prefix='.gui-budget-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def start(self, token):
        with self.lock:
            if not self.active or not hmac.compare_digest(token, self.token):
                raise PermissionError('invalid benchmark capability')

    def reserve(self, token, _request_bytes):
        with self.lock:
            if not self.active or time.monotonic() >= self.deadline or not hmac.compare_digest(token, self.token):
                raise PermissionError('invalid or expired benchmark capability')
            if self.calls >= self.max_calls or self.spent + RESERVATION > self.limit:
                self.denials += 1
                self._save()
                raise BudgetError('GUI benchmark budget exhausted')
            self.spent += RESERVATION
            self.calls += 1
            self.inflight += 1
            self.pending[str(self.calls)] = str(RESERVATION)
            self._save()
            return Ticket(self.calls)

    def settle(self, ticket, usage, status, elapsed, evidence=None):
        with self.condition:
            key = str(ticket.sequence)
            if key not in self.pending:
                raise ValueError('unknown or already settled reservation')
            valid = isinstance(usage, dict) and all(
                type(usage.get(k)) is int and usage[k] >= 0
                for k in ('prompt_tokens', 'completion_tokens'))
            charge = RESERVATION
            safe_usage = None
            if valid:
                charge = usage['prompt_tokens'] * INPUT_CNY + usage['completion_tokens'] * OUTPUT_CNY
                safe_usage = {k: usage[k] for k in ('prompt_tokens', 'completion_tokens')}
                if charge > RESERVATION:
                    self.active = False
            self.spent += charge - RESERVATION
            self.pending.pop(key)
            self.inflight -= 1
            self.rows.append({'sequence': ticket.sequence, 'status': status,
                              'usage': safe_usage, 'seconds': round(elapsed, 3),
                              'conservative_cny': str(charge), 'reserved_cny': str(RESERVATION)})
            self._save()
            self.condition.notify_all()

    def close(self, wait_seconds=0):
        with self.condition:
            self.active = False
            self.condition.wait_for(lambda: self.inflight == 0, timeout=wait_seconds)
            self._save()
            return self._document()

    def release(self):
        """Release file ownership, never erase charged unknown requests."""
        self.owner.close()


def normalize_gui(body, _protocol=None):
    if not isinstance(body, dict) or body.get('model') != POLICY['model']:
        raise ValueError('only the benchmark model is permitted')
    if not isinstance(body.get('messages'), list):
        raise ValueError('messages required')
    result = dict(body)
    output = body.get('max_tokens', body.get('max_completion_tokens', OUTPUT_LIMIT))
    if type(output) is not int or not 0 < output <= OUTPUT_LIMIT:
        raise ValueError('output exceeds the reserved maximum')
    if result.get('reasoning_effort') not in (None, 'low', 'high', 'max'):
        raise ValueError('unsupported reasoning effort')
    result['max_tokens'], result['n'] = output, 1
    result.pop('max_completion_tokens', None)
    if result.get('stream'):
        result['stream_options'] = {'include_usage': True}
    return result
