from dataclasses import FrozenInstanceError
import threading
import time
import unittest
from broker import Ledger, normalize, INPUT_RATE, OUTPUT_RATE
from protocol import OFFICIAL, Protocol


class ProtocolTests(unittest.TestCase):
    def test_submission_starts_once_and_cannot_extend_budget(self):
        ledger = Ledger(protocol=OFFICIAL, deferred=True)
        with self.assertRaises(PermissionError):
            ledger.reserve(ledger.token, 10)
        with self.assertRaises(PermissionError):
            ledger.start('wrong')
        ledger.start(ledger.token)
        deadline = ledger.deadline
        ledger.start(ledger.token)
        self.assertEqual(ledger.deadline, deadline)
        ledger.close()
        with self.assertRaises(PermissionError):
            ledger.start(ledger.token)

    def test_frozen_approved_limits(self):
        self.assertEqual(OFFICIAL.seconds, 600)
        with self.assertRaises(FrozenInstanceError):
            OFFICIAL.seconds = 1
        for kwargs in ({'seconds': 601}, {'dollars': .51}, {'max_calls': 41}):
            with self.assertRaises(ValueError):
                Protocol(**kwargs)

    def test_output_cap_and_auxiliary_preservation(self):
        body = {'model': 'deepseek-flash', 'messages': [], 'max_tokens': 64}
        self.assertEqual(normalize(body, OFFICIAL)['max_tokens'], 64)
        body['max_tokens'] = 99999
        self.assertEqual(normalize(body, OFFICIAL)['max_tokens'], 16384)

    def test_reservation_uses_shared_output_limit(self):
        ledger = Ledger(protocol=OFFICIAL)
        amount = ledger.reserve(ledger.token, 100)
        self.assertAlmostEqual(amount, 8292 * INPUT_RATE + 16384 * OUTPUT_RATE)
        ledger.settle(amount, None, 500, 0)
        self.assertEqual(ledger.close()['conservative_usd'], amount)

    def test_unknown_or_malformed_usage_keeps_reservation(self):
        for usage in ({}, {'prompt_tokens': -1, 'completion_tokens': 1},
                      {'prompt_tokens': 1}, {'prompt_tokens': True, 'completion_tokens': 2}):
            ledger = Ledger(protocol=OFFICIAL)
            amount = ledger.reserve(ledger.token, 100)
            ledger.settle(amount, usage, 200, 0)
            self.assertEqual(ledger.close()['conservative_usd'], amount)

    def test_close_waits_for_inflight_settlement(self):
        ledger = Ledger(protocol=OFFICIAL)
        amount = ledger.reserve(ledger.token, 100)
        def finish():
            time.sleep(.03)
            ledger.settle(amount, {'prompt_tokens': 10, 'completion_tokens': 5}, 200, .03)
        thread = threading.Thread(target=finish)
        thread.start()
        report = ledger.close(wait_seconds=1)
        thread.join()
        self.assertEqual(report['inflight'], 0)
        self.assertEqual(len(report['rows']), 1)
        self.assertFalse(ledger.active)
