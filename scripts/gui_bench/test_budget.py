import concurrent.futures
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from scripts.gui_bench.budget import BudgetLedger, RESERVATION, normalize_gui
from scripts.terminal_bench.broker import Broker, BudgetError


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ledger.json'
        self.ledger = BudgetLedger(self.path, seconds=600)

    def tearDown(self):
        self.ledger.release()
        self.temp.cleanup()

    def test_reserves_full_input_window_not_png_size(self):
        self.ledger.reserve(self.ledger.token, 1)
        self.assertEqual(self.ledger.spent, RESERVATION)
        self.assertEqual(json.loads(self.path.read_text())['pending'], {'1': str(RESERVATION)})

    def test_usage_releases_only_unused_reservation(self):
        ticket = self.ledger.reserve(self.ledger.token, 10)
        self.ledger.settle(ticket, {'prompt_tokens': 1000, 'completion_tokens': 100}, 200, .5)
        self.assertEqual(self.ledger.spent, Decimal('.0028'))
        self.assertEqual(self.ledger.inflight, 0)
        with self.assertRaises(ValueError):
            self.ledger.settle(ticket, {}, 200, 1)

    def test_unknown_usage_and_network_failure_are_not_free(self):
        for usage in [None, {}, {'prompt_tokens': True, 'completion_tokens': 2},
                      {'prompt_tokens': -1, 'completion_tokens': 1}]:
            ticket = self.ledger.reserve(self.ledger.token, 1)
            self.ledger.settle(ticket, usage, 'transport_error', 1)
        self.assertEqual(self.ledger.spent, RESERVATION * 4)

    def test_concurrent_admission_never_exceeds_ceiling(self):
        self.ledger.release()
        self.path.unlink()
        self.ledger = BudgetLedger(self.path, limit_cny='10', seconds=600)
        def reserve(_):
            try:
                self.ledger.reserve(self.ledger.token, 1)
                return True
            except BudgetError:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            admitted = list(pool.map(reserve, range(20)))
        self.assertEqual(sum(admitted), 4)
        self.assertLessEqual(self.ledger.spent, self.ledger.limit)

    def test_wrong_capability_and_deadline_never_charge(self):
        with self.assertRaises(PermissionError):
            self.ledger.reserve('not-a-capability', 1)
        self.ledger.deadline = 0
        with self.assertRaises(PermissionError):
            self.ledger.reserve(self.ledger.token, 1)
        self.assertEqual(self.ledger.calls, 0)

    def test_crash_resume_retains_unknown_cost_and_deadline(self):
        self.ledger.reserve(self.ledger.token, 1)
        deadline = self.ledger.wall_deadline
        self.ledger.release()
        self.ledger = BudgetLedger(self.path, seconds=3600)
        self.assertEqual(self.ledger.wall_deadline, deadline)
        self.assertEqual(self.ledger.spent, RESERVATION)
        self.assertEqual(self.ledger.rows[0]['status'], 'crash_unknown')
        self.assertEqual(self.ledger.inflight, 0)
        self.ledger.reserve(self.ledger.token, 1)
        self.assertEqual(self.ledger.calls, 2)

    def test_second_controller_cannot_own_same_budget(self):
        with self.assertRaises(BlockingIOError):
            BudgetLedger(self.path)

    def test_resume_cannot_change_ceiling_or_reset_closed_budget(self):
        self.ledger.release()
        with self.assertRaises(ValueError):
            BudgetLedger(self.path, limit_cny='100')
        self.ledger = BudgetLedger(self.path, seconds=600)
        self.ledger.close()
        self.ledger.release()
        with self.assertRaises(ValueError):
            BudgetLedger(self.path)

    def test_explicit_continuation_preserves_totals_and_increment_after_crash(self):
        ticket = self.ledger.reserve(self.ledger.token, 1)
        self.ledger.settle(ticket, {'prompt_tokens': 1000, 'completion_tokens': 100}, 200, .1)
        self.ledger.close()
        self.ledger.release()
        self.ledger = BudgetLedger(self.path, seconds=600, continuation_cny='5')
        self.assertEqual(self.ledger.spent, Decimal('.0028'))
        self.assertEqual(self.ledger.calls, 1)
        self.assertEqual(self.ledger.admission_limit, Decimal('5.0028'))
        deadline = self.ledger.wall_deadline
        self.ledger.reserve(self.ledger.token, 1)
        self.ledger.release()
        self.ledger = BudgetLedger(self.path, seconds=3600)
        self.assertEqual(self.ledger.wall_deadline, deadline)
        self.assertEqual(self.ledger.admission_limit, Decimal('5.0028'))
        self.ledger.reserve(self.ledger.token, 1)
        with self.assertRaises(BudgetError):
            self.ledger.reserve(self.ledger.token, 1)
        self.assertEqual(len(self.ledger.continuations), 1)

    def test_continuation_requires_existing_closed_settled_budget(self):
        for increment in ['1', '0', '-1', 'NaN', 'Infinity', '201']:
            self.ledger.release()
            with self.assertRaises(ValueError):
                BudgetLedger(self.path, continuation_cny=increment)
            self.ledger = BudgetLedger(self.path)
        self.ledger.reserve(self.ledger.token, 1)
        self.ledger.close()
        self.ledger.release()
        with self.assertRaises(ValueError):
            BudgetLedger(self.path, continuation_cny='5')
        self.assertTrue(json.loads(self.path.read_text())['closed'])
        with self.assertRaises(ValueError):
            BudgetLedger(Path(self.temp.name) / 'missing.json', continuation_cny='5')

    def test_write_failure_denies_before_forwarding(self):
        with patch.object(self.ledger, '_save', side_effect=OSError('fixture')):
            with self.assertRaises(OSError):
                self.ledger.reserve(self.ledger.token, 1)
        self.assertEqual(self.ledger.spent, RESERVATION)

    def test_checkpoint_contains_no_capability_or_untrusted_evidence(self):
        ticket = self.ledger.reserve(self.ledger.token, 1)
        self.ledger.settle(ticket, {'prompt_tokens': 1, 'completion_tokens': 1, 'secret': 'credential'},
                           200, .1, {'prompt': 'private-body', 'key': 'private-key'})
        data = self.path.read_text()
        for text in [self.ledger.token, 'private-body', 'private-key', 'credential']:
            self.assertNotIn(text, data)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_provider_violating_admitted_bound_stops_further_calls(self):
        ticket = self.ledger.reserve(self.ledger.token, 1)
        self.ledger.settle(ticket, {'prompt_tokens': 2_000_000, 'completion_tokens': 8192}, 200, .1)
        with self.assertRaises(PermissionError):
            self.ledger.reserve(self.ledger.token, 1)

    def test_invalid_settings_fail_closed(self):
        for limit in ['0', '-1', '201', 'NaN', 'Infinity']:
            with self.assertRaises(ValueError):
                BudgetLedger(Path(self.temp.name) / 'bad.json', limit_cny=limit)

    def test_normalizer_preserves_ablation_and_rejects_unreserved_output(self):
        body = normalize_gui({'model': 'deepseek-flash', 'messages': [],
                              'thinking': {'type': 'disabled'}, 'max_tokens': 1024, 'stream': True})
        self.assertEqual(body['thinking'], {'type': 'disabled'})
        self.assertTrue(body['stream_options']['include_usage'])
        for key, value in [('max_tokens', 8193), ('max_tokens', True), ('model', 'deepseek-v4-pro'),
                           ('reasoning_effort', 'xhigh')]:
            with self.assertRaises(ValueError):
                normalize_gui({'model': 'deepseek-flash', 'messages': [], key: value})

    def test_existing_broker_transport_accepts_injected_policy_and_settles_cny(self):
        class Upstream:
            def __init__(self, *args, **kwargs): pass
            def request(self, method, path, data, headers):
                self.body = json.loads(data)
                self.assert_body()
            def assert_body(self):
                assert self.body['thinking']['type'] == 'disabled'
                assert self.body['max_tokens'] == 1024
            def getresponse(self):
                result = io.BytesIO(b'{"model":"deepseek-flash","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}')
                result.status = 200
                return result
            def close(self): pass
        broker = Broker('never-persist-fixture-key', '127.0.0.1', upstream_factory=Upstream,
                        request_normalizer=normalize_gui, max_body=48*1024*1024)
        broker.ledger = self.ledger
        try:
            request = urllib.request.Request(broker.url + '/chat/completions',
                data=json.dumps({'model': 'deepseek-flash', 'messages': [], 'max_tokens': 1024,
                                 'thinking': {'type': 'disabled'}}).encode(),
                headers={'Authorization': 'Bearer ' + self.ledger.token})
            with urllib.request.urlopen(request, timeout=5) as result:
                json.load(result)
            self.ledger.close(wait_seconds=5)
            self.assertEqual(self.ledger.spent, Decimal('.00006'))
        finally:
            broker.stop()


if __name__ == '__main__':
    unittest.main()
