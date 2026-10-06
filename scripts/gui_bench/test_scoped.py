import json
from pathlib import Path
import tempfile
import unittest

from scripts.gui_bench.serve_scoped import ScopedLedger, POLICY
from scripts.terminal_bench.broker import BudgetError, INPUT_RATE, OUTPUT_RATE
from scripts.gui_bench.budget import INPUT_LIMIT, OUTPUT_LIMIT


class ScopedLedgerTests(unittest.TestCase):
    def test_explicit_continuation_preserves_total_and_cannot_raise_money_ceiling(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'budget.json';ledger=ScopedLedger(path,calls=2)
            ticket=ledger.reserve(ledger.token,0)
            ledger.settle(ticket,dict(prompt_tokens=1000,completion_tokens=100),200,.1)
            spent=ledger.spent;ledger.close();ledger.release()
            with self.assertRaises(ValueError): ScopedLedger(path,dollars=.9,continuation=True)
            resumed=ScopedLedger(path,calls=200,continuation=True)
            try:
                self.assertEqual(resumed.spent,spent)
                self.assertEqual(resumed.calls,1)
                self.assertEqual(len(resumed.rows),1)
                self.assertEqual(resumed.limit,1)
                self.assertEqual(resumed.continuations[0]['start_usd'],spent)
            finally: resumed.close();resumed.release()

    def test_pending_and_nonexistent_scopes_cannot_be_continued(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'budget.json'
            with self.assertRaises(ValueError): ScopedLedger(path,continuation=True)
            ledger=ScopedLedger(path);ledger.reserve(ledger.token,0);ledger.close();ledger.release()
            with self.assertRaises(ValueError): ScopedLedger(path,calls=200,continuation=True)

    def test_admission_is_durable_before_forwarding_and_no_key_is_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'budget.json'
            ledger = ScopedLedger(path)
            try:
                ticket = ledger.reserve(ledger.token,1)
                self.assertAlmostEqual(ticket, INPUT_LIMIT*INPUT_RATE+OUTPUT_LIMIT*OUTPUT_RATE)
                doc=json.loads(path.read_text())
                self.assertEqual(doc['pending_requests'],1)
                self.assertEqual(doc['requests'],1)
                self.assertNotIn(ledger.token,path.read_text())
                ledger.settle(ticket,{'prompt_tokens':1000,'completion_tokens':50,'secret':'not persisted'},200,.1)
                self.assertNotIn('not persisted',path.read_text())
                self.assertEqual(ledger.receipt(ledger.token)['pending_requests'],0)
                self.assertEqual(doc['policy']['currency'],'USD')
                self.assertEqual(doc['policy'],POLICY)
            finally:
                ledger.close();ledger.release()

    def test_closed_or_crashed_checkpoint_is_never_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'budget.json';ledger=ScopedLedger(path)
            ledger.reserve(ledger.token,0);ledger.close();ledger.release()
            original=path.read_bytes()
            with self.assertRaises(ValueError): ScopedLedger(path)
            self.assertEqual(path.read_bytes(),original)

    def test_missing_usage_retains_reservation_and_budget_stops_forwarding(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger=ScopedLedger(Path(directory)/'budget.json',dollars=.32)
            try:
                ticket=ledger.reserve(ledger.token,0)
                ledger.settle(ticket,None,'transport_error',.1)
                with self.assertRaises(BudgetError): ledger.reserve(ledger.token,0)
                self.assertAlmostEqual(ledger.spent,ticket)
                self.assertEqual(ledger.calls,1)
            finally: ledger.close();ledger.release()

    def test_auth_and_checkpoint_failure_deny_before_forwarding(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            ledger=ScopedLedger(Path(directory)/'budget.json')
            try:
                with self.assertRaises(PermissionError): ledger.reserve('wrong',0)
                with self.assertRaises(PermissionError): ledger.receipt('wrong')
                with patch.object(ledger,'_save',side_effect=OSError('disk')):
                    with self.assertRaises(OSError): ledger.reserve(ledger.token,0)
                with self.assertRaises(PermissionError): ledger.reserve(ledger.token,0)
                self.assertFalse(ledger.active)
            finally: ledger.close();ledger.release()


if __name__=='__main__': unittest.main()
