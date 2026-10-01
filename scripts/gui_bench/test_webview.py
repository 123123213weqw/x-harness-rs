"""No model/native input: fixture isolation and transport/ledger contract."""
import json
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from scripts.gui_bench.budget import BudgetLedger
from scripts.gui_bench.native_fixture import Fixture
from scripts.gui_bench.run_webview import budget_receipt, tuple_address, cleanup_profile, settle_quiet, pin_binary
from scripts.terminal_bench.broker import Broker


class WebviewTests(unittest.TestCase):
    def test_bridge_address_is_only_ipv4_loopback(self):
        self.assertEqual(tuple_address('127.0.0.1:123'), ('127.0.0.1',123))
        for value in ['example.com:123','127.0.0.1:0','127.0.0.1:65536','::1:123']:
            with self.assertRaises(ValueError): tuple_address(value)

    def test_genuine_component_fixture_has_no_mock_or_hidden_grader_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'react.js').write_text('public-react'); (root/'react-dom.js').write_text('public-react-dom')
            fixture = Fixture(root,'issue','a'*32,'actual-host-chat').start()
            try:
                with urllib.request.urlopen(fixture.main_url) as response: html = response.read().decode()
                self.assertIn('plugin.BrowserPane',html)
                self.assertIn('actual-host-chat',html)
                self.assertNotIn('__TAURI__=',html)
                self.assertNotIn('token',html)
                self.assertNotEqual(fixture.main_url.split('?')[0],fixture.target.split('?')[0])
                request = urllib.request.Request(fixture.target.replace('/?','/report?'),
                    data=json.dumps({'task':'issue','marker':'ORBIT-7319','openedIssue':105}).encode(),
                    headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(request): pass
                self.assertEqual(fixture.snapshot()['openedIssue'],105)
                for origin in [fixture.main_url, fixture.target.split('?')[0]]:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(origin + 'control/state')
                    self.assertEqual(caught.exception.code,404)
            finally: fixture.close()

    def test_teardown_waits_for_pending_provider_usage_and_stable_counter(self):
        clock = itertools.count(0,.2)
        samples = iter([{'requests':1,'pending_requests':1}, {'requests':2,'pending_requests':0}])
        last = {'requests':2,'pending_requests':0}
        with patch('scripts.gui_bench.run_webview.time.monotonic', side_effect=lambda: next(clock)), \
             patch('scripts.gui_bench.run_webview.time.sleep'), \
             patch('scripts.gui_bench.run_webview.budget_receipt', side_effect=lambda _: next(samples,last)) as receipts:
            self.assertTrue(settle_quiet({},timeout=5))
            self.assertGreater(receipts.call_count,2)
        clock = itertools.count(0,.2)
        with patch('scripts.gui_bench.run_webview.time.monotonic', side_effect=lambda: next(clock)), \
             patch('scripts.gui_bench.run_webview.time.sleep'), \
             patch('scripts.gui_bench.run_webview.budget_receipt', return_value={'requests':1,'pending_requests':1}):
            self.assertFalse(settle_quiet({},timeout=1))

    def test_suite_pins_binary_before_shared_target_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'host'; source.write_bytes(b'verified-binary')
            inputs=root/'inputs'; inputs.mkdir()
            pinned=pin_binary(source,inputs)
            source.write_bytes(b'another-task-binary')
            self.assertEqual(pinned.read_bytes(),b'verified-binary')
            self.assertEqual(pinned.stat().st_mode & 0o777,0o700)

    def test_cleanup_never_unmounts_arbitrary_user_paths(self):
        with patch('scripts.gui_bench.run_webview.subprocess.run') as process:
            self.assertFalse(cleanup_profile(Path('/user/browser-profile')))
            process.assert_not_called()

    def test_budget_receipt_authentication_and_no_api_forwarding(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = BudgetLedger(Path(directory)/'budget.json')
            def no_upstream(*_,**__): raise AssertionError('receipt must not contact model')
            broker = Broker('not-a-real-key','127.0.0.1',upstream_factory=no_upstream)
            broker.ledger = ledger
            try:
                receipt = budget_receipt({'base_url':broker.url,'capability':ledger.token})
                self.assertEqual(receipt['requests'],0)
                self.assertNotIn(ledger.token,json.dumps(receipt))
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    budget_receipt({'base_url':broker.url,'capability':'wrong'})
                self.assertEqual(caught.exception.code,403)
                ledger.close()
                self.assertTrue(budget_receipt({'base_url':broker.url,'capability':ledger.token})['closed'])
            finally: broker.stop(); ledger.release()


if __name__ == '__main__': unittest.main()
