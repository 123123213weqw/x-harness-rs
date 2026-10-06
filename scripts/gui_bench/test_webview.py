"""No model/native input: fixture isolation and transport/ledger contract."""
import json
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

from scripts.gui_bench.budget import BudgetLedger
from scripts.gui_bench.native_fixture import Fixture, zero_tab_html
from scripts.gui_bench.run_webview import budget_receipt, tuple_address, cleanup_profile, settle_quiet, pin_binary, native_environment, acceptance_passed, classify_outcome, wait_ready, verify_unbound_discovery
from scripts.gui_bench.webview_contract import Contract
from scripts.terminal_bench.broker import Broker


class WebviewTests(unittest.TestCase):
    def test_contract_retries_only_readiness_reads_and_never_an_action(self):
        call=Mock(side_effect=[RuntimeError('native browser is hidden'),
                              {'source':{'engine':'tauri-webview'},'nodes':[]}])
        with patch('scripts.gui_bench.webview_contract.time.sleep'):
            checks=Contract(call)
            checks.observe()
        self.assertEqual(checks.readiness_denials,['native browser is hidden'])
        self.assertTrue(all(item.args[0]=='observe' for item in call.call_args_list))
        for message in ['native bridge interrupted','invalid native observation arguments']:
            call=Mock(side_effect=RuntimeError(message))
            with self.assertRaises(RuntimeError): Contract(call).observe()
            self.assertEqual(call.call_count,1)
        clock=itertools.count(0,.5)
        call=Mock(side_effect=RuntimeError('native browser is hidden'))
        with patch('scripts.gui_bench.webview_contract.time.sleep'), \
             patch('scripts.gui_bench.webview_contract.time.monotonic',side_effect=lambda:next(clock)), \
             self.assertRaises(RuntimeError):
            Contract(call).observe()
        self.assertLessEqual(call.call_count,11)

    def test_zero_tab_fixture_loads_canonical_appframe_without_opening_a_page(self):
        html = zero_tab_html('owned-session')
        self.assertIn('AppFrame', html)
        self.assertIn('/modules/runtime.js', html)
        self.assertIn('"session": "owned-session"', html)
        self.assertNotIn('desktop_browser_navigate', html)
        self.assertNotIn('xharness-browser-control-open', html)
        self.assertNotIn('config.target', html)
        self.assertNotIn('entries:[', html)

    def test_zero_tab_fixture_supplies_session_service_and_root_injected_navigation(self):
        html = zero_tab_html('owned-session')
        self.assertIn("get:name=>name==='sessions'?sessions:undefined", html)
        self.assertIn('const injected=definition.inject(store.actions)', html)
        self.assertIn('React.createElement(AppFrame,{...injected,', html)
        self.assertIn('React.useSyncExternalStore(sessions.list.subscribe,sessions.list.getSnapshot)', html)
        self.assertIn('phase:\'ready\'', html)
        self.assertIn('ids:[config.session]', html)
        self.assertIn('listeners.delete(listener)', html)
        self.assertNotIn('navigation:', html, 'fixture must not replace the actual ShellNavigation')
        self.assertNotIn('useSessions:s=>s({', html, 'selection must be observable, not a stale render snapshot')

    def test_zero_tab_readiness_does_not_infer_a_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'private.json'
            connection = {'address':'127.0.0.1:1234','token':'a'*64}
            path.write_text(json.dumps(connection))
            with patch('scripts.gui_bench.run_webview.bridge_call', side_effect=[
                {'available':False,'bound':False}, {'available':True,'bound':False}
            ]) as call, patch('scripts.gui_bench.run_webview.time.sleep'):
                self.assertEqual(wait_ready(path,Mock(poll=lambda:None),'owner',zero_tabs=True),connection)
                self.assertEqual(call.call_count,2)

    def test_native_ready_requires_binding_not_just_zero_tab_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private.json'
            connection = {'address':'127.0.0.1:1234', 'token':'a'*64}
            path.write_text(json.dumps(connection))
            with patch('scripts.gui_bench.run_webview.bridge_call', side_effect=[
                {'available':True,'bound':False}, {'available':True,'bound':True}
            ]) as call, patch('scripts.gui_bench.run_webview.time.sleep'):
                self.assertEqual(wait_ready(path, Mock(poll=lambda:None), 'owner'), connection)
                self.assertEqual(call.call_count, 2)
            clock = itertools.count(0,.2)
            with patch('scripts.gui_bench.run_webview.bridge_call', return_value={'available':True,'bound':False}), \
                 patch('scripts.gui_bench.run_webview.time.sleep'), \
                 patch('scripts.gui_bench.run_webview.time.monotonic', side_effect=lambda:next(clock)):
                with self.assertRaises(TimeoutError):
                    wait_ready(path, Mock(poll=lambda:None), 'owner', timeout=1)

    def test_public_discovery_does_not_grant_observation_or_actions(self):
        def denied(op, arguments):
            if op == 'list': return {'available':True,'bound':False}
            if op == 'observe': raise RuntimeError('native browser is not delegated to this session')
            return {'ok':False,'effect':'not_started'}
        verify_unbound_discovery(denied)
        faults = [
            ('list', {'available':True,'bound':True}),
            ('list', {'available':True,'bound':False,'tab_id':'other'}),
            ('observe', {'nodes':[]}),
            ('observe', RuntimeError('transport interrupted')),
            ('perform', {'ok':True,'effect':'applied'}),
            ('perform', {'ok':False,'effect':'unknown'}),
        ]
        for fault_op, value in faults:
            def call(op, arguments):
                if op == fault_op:
                    if isinstance(value, Exception): raise value
                    return value
                return denied(op, arguments)
            with self.subTest(op=fault_op, value=value), self.assertRaises(AssertionError):
                verify_unbound_discovery(call)

    def test_budget_gate_is_not_model_quality_and_is_never_a_pass(self):
        settled = dict(passed=False, cleanup_passed=True, tier='genuine-host-model-tauri-webview',
            provider_settled_before_teardown=True, pending_requests=0, model_calls=2)
        self.assertEqual(classify_outcome(settled), 'task_failed')
        self.assertEqual(classify_outcome(dict(settled, budget_denials=1)), 'blocked_by_budget_gate')
        self.assertFalse(acceptance_passed(dict(settled, budget_denials=1)))
        self.assertEqual(classify_outcome(dict(settled, model_calls=0)), 'not_evaluated')
        self.assertEqual(classify_outcome(dict(settled, accounting_pending=True)), 'evaluation_failed')
        self.assertEqual(classify_outcome(dict(settled, cleanup_passed=False)), 'evaluation_failed')
        self.assertEqual(classify_outcome(dict(settled, turn_reasons=[{'kind':'error'}])), 'evaluation_failed')
        self.assertEqual(classify_outcome(dict(settled, passed=True)), 'passed')
        # Previous denials cannot disqualify a genuinely completed, settled task.
        self.assertEqual(classify_outcome(dict(settled, passed=True, budget_denials=1)), 'passed')

    def test_task_success_cannot_hide_unverified_accounting(self):
        result = dict(passed=True,cleanup_passed=True,tier='genuine-host-model-tauri-webview',
            provider_settled_before_teardown=True,pending_requests=0,model_calls=5)
        self.assertTrue(acceptance_passed(result))
        for patch in [dict(provider_settled_before_teardown=False),dict(pending_requests=1),
                      dict(accounting_pending=True),dict(model_calls=None),dict(model_calls=0),
                      dict(cleanup_passed=False),dict(passed=False)]:
            self.assertFalse(acceptance_passed(dict(result,**patch)))
        self.assertTrue(acceptance_passed(dict(passed=True,cleanup_passed=True,tier='native-binding-contract',model_calls=0)))

    def test_settlement_retries_only_transient_side_effect_free_receipts(self):
        clock = itertools.count(0,.1)
        samples = iter([urllib.error.URLError('temporary'),{'requests':2,'pending_requests':0}])
        def sample(*args,**kwargs):
            self.assertLessEqual(kwargs['timeout'],3)
            value=next(samples,{'requests':2,'pending_requests':0})
            if isinstance(value,Exception): raise value
            return value
        with patch('scripts.gui_bench.run_webview.time.monotonic',side_effect=lambda:next(clock)), \
             patch('scripts.gui_bench.run_webview.time.sleep'), \
             patch('scripts.gui_bench.run_webview.budget_receipt',side_effect=sample):
            self.assertTrue(settle_quiet({},timeout=5))
        with patch('scripts.gui_bench.run_webview.budget_receipt',side_effect=urllib.error.HTTPError('local',403,'denied',{},None)) as receipt:
            self.assertFalse(settle_quiet({}))
            self.assertEqual(receipt.call_count,1)

    def test_native_proxy_is_explicit_loopback_only_and_never_ambient(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict('os.environ', {'HTTPS_PROXY':'http://secret@ambient','DEEPSEEK_API_KEY':'secret'}, clear=True):
                direct = native_environment(Path(directory))
                self.assertNotIn('HTTPS_PROXY',direct)
                self.assertNotIn('DEEPSEEK_API_KEY',direct)
            routed = Path(directory)/'routed'; routed.mkdir()
            env = native_environment(routed,'socks5://127.0.0.1:12345')
            self.assertEqual(env['https_proxy'],'socks5://127.0.0.1:12345')
            self.assertEqual(env['no_proxy'],'127.0.0.1,localhost')
            for value in ['http://example.com:123','http://user:secret@127.0.0.1:123','socks5://127.0.0.1',
                          'http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:123/path',
                          'http://127.0.0.1:123?key=secret','http://127.0.0.1:123#fragment','ftp://127.0.0.1:123']:
                with self.assertRaises(ValueError): native_environment(Path(directory),value)

    def test_contract_unknown_effect_is_never_replayed(self):
        calls = []
        def call(op, arguments):
            calls.append((op,arguments))
            if op == 'observe':
                return {'source':{'engine':'tauri-webview'},'frame_id':'fresh',
                    'nodes':[{'label':'Target','ref':'n9','disabled':False}]}
            return {'ok':False,'effect':'unknown'}
        with self.assertRaisesRegex(AssertionError,'did not settle'):
            Contract(call).act('click','Target')
        self.assertEqual([op for op,_ in calls],['observe','perform'])
        self.assertEqual(calls[1][1]['ref'],'n9')

    def test_contract_replay_check_requires_unstarted_effect(self):
        for effect in ('applied','unknown','not_started'):
            calls = []
            def call(op, arguments):
                calls.append(op)
                if op == 'observe':
                    return {'source':{'engine':'tauri-webview'},'frame_id':'fresh',
                        'nodes':[{'label':'Target','ref':'n2','disabled':False}]}
                return {'ok':calls.count('perform') == 1,
                    'effect':'applied' if calls.count('perform') == 1 else effect}
            contract = Contract(call)
            if effect == 'not_started':
                contract.act('click','Target')
                self.assertEqual(contract.denials,['consumed_frame'])
            else:
                with self.assertRaisesRegex(AssertionError,'no scheduled effect'):
                    contract.act('click','Target')

    def test_contract_pages_observed_controls_and_rejects_ambiguous_targets(self):
        def call(op, arguments):
            return {'source':{'engine':'tauri-webview'},'frame_id':'page-'+str(arguments['node_offset']),
                'next_node_offset':60 if arguments['node_offset'] == 0 else None,
                'nodes':[] if arguments['node_offset'] == 0 else [{'label':'Target','ref':'n61','disabled':False}]}
        snapshot, node = Contract(call).target('Target')
        self.assertEqual((snapshot['frame_id'],node['ref']),('page-60','n61'))
        def ambiguous(*_):
            return {'source':{'engine':'tauri-webview'},'frame_id':'fresh',
                'nodes':[{'label':'Target'},{'label':'Target'}]}
        with self.assertRaisesRegex(AssertionError,'ambiguous'):
            Contract(ambiguous).target('Target')

    def test_contract_cannot_count_simulated_native_or_disabled_target_as_success(self):
        for engine, disabled in [('mock',False),('tauri-webview',True)]:
            def call(op, arguments):
                self.assertEqual(op,'observe')
                return {'source':{'engine':engine},'frame_id':'fresh',
                    'nodes':[{'label':'Target','ref':'n0','disabled':disabled}]}
            with self.assertRaises(AssertionError): Contract(call).act('click','Target')

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
             patch('scripts.gui_bench.run_webview.budget_receipt', side_effect=lambda *_,**__: next(samples,last)) as receipts:
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
