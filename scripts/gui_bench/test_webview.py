"""No model/native input: fixture isolation and transport/ledger contract."""
import json
import copy
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
    def unknown_select(self):
        node = dict(ref='n1', tag='select', type='', role='', label='Chosen mode', disabled=False,
            value='', options=[dict(label='Choose', value=''), dict(label='Strict', value='strict')],
            option_offset=0, option_count=2, next_option_offset=None)
        before = dict(frame_id='a'*32, scope='dialog', url='https://fixture.invalid/settings', title='Fixture',
            source=dict(engine='tauri-webview', tab_id='browser:fixture', native_origin='https://fixture.invalid',
                        untrusted=True), nodes=[node], next_node_offset=None, next_text_offset=None,
            source_text_truncated=False, truncated=False, text_offset=0)
        fresh = copy.deepcopy(before); fresh['frame_id'] = 'b'*32; fresh['nodes'][0]['value'] = 'strict'
        receipt = dict(ok=False, effect='unknown', frame_id='a'*32,
                       message='browser changed during action; effect may have occurred; observe again')
        denied = dict(ok=False, effect='not_started', frame_id='a'*32, message='stale_frame: observe again')
        call = Mock(side_effect=[receipt, fresh, denied])
        checks = Contract(call); checks.target = Mock(return_value=(before, node))
        return checks, call, before, fresh, receipt

    def test_opted_in_unknown_select_verifies_state_without_claiming_applied_or_replaying(self):
        checks, call, before, fresh, receipt = self.unknown_select()
        checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
        self.assertEqual([item.args[0] for item in call.call_args_list], ['perform', 'observe', 'perform'])
        # Two perform invocations: one uncertain action and one deliberate
        # old-frame denial proving not_started / zero newly scheduled effects.
        self.assertEqual(call.call_args_list[0].args[1], call.call_args_list[2].args[1])
        self.assertEqual(checks.actions, [])
        self.assertEqual(checks.denials, ['consumed_frame'])
        evidence = checks.observed_postconditions[0]
        self.assertEqual(evidence['original_receipt'], receipt)
        self.assertEqual(evidence['fresh'], fresh)
        self.assertEqual(evidence['verification'], 'matched_observed_state_not_applied_receipt')
        self.assertEqual(evidence['consumed_frame_denial']['effect'], 'not_started')
        self.assertNotIn('verify_unknown_select', call.call_args_list[0].args[1])

    def test_unknown_select_default_and_nonselect_opt_in_remain_failures(self):
        for action, opt_in in [('select', False), ('click', True), ('fill', True), ('scroll', True)]:
            checks, call, *_ = self.unknown_select()
            with self.subTest(action=action, opt_in=opt_in), self.assertRaises(AssertionError):
                checks.act(action, 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=opt_in)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(checks.observed_postconditions, [])

    def test_not_started_and_inconsistent_receipts_are_not_postcondition_success(self):
        for patch_value in [dict(effect='not_started'), dict(effect='applied'), dict(ok=True)]:
            checks, call, before, fresh, receipt = self.unknown_select(); receipt.update(patch_value)
            with self.subTest(patch_value=patch_value), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(checks.actions, [])

    def test_unknown_select_rejects_invalid_receipt_without_exposing_private_transport(self):
        for patch_value in [dict(frame_id='c'*32), dict(token='private-transport'), dict(message=['invalid']),
                            dict(message='\ud800'), dict(message='\U0001f600'*126)]:
            checks, call, before, fresh, receipt = self.unknown_select(); receipt.update(patch_value)
            with self.subTest(patch_value=patch_value), self.assertRaises(AssertionError) as failure:
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertNotIn('private-transport', str(failure.exception))
            self.assertEqual(call.call_count, 1)
            self.assertEqual(checks.observed_postconditions, [])

    def test_unknown_select_rejects_already_matched_or_unavailable_original_goal(self):
        for change in ['matched', 'tag', 'option', 'duplicate', 'partial-options', 'partial-page']:
            checks, call, before, fresh, receipt = self.unknown_select(); node = before['nodes'][0]
            if change == 'matched': node['value'] = 'strict'
            if change == 'tag': node['tag'] = 'input'
            if change == 'option': node['options'][1]['value'] = 'other'
            if change == 'duplicate': before['nodes'].append(copy.deepcopy(node))
            if change == 'partial-options': node['next_option_offset'] = 2
            if change == 'partial-page': checks._target_page_offset = 60
            with self.subTest(change=change), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 1)

    def test_unknown_select_requires_known_string_original_value(self):
        for value in [None, 123, False, [], {'value': 'other'}, 'missing-field']:
            checks, call, before, fresh, receipt = self.unknown_select()
            if value == 'missing-field': del before['nodes'][0]['value']
            else: before['nodes'][0]['value'] = value
            with self.subTest(value=value), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(checks.actions, [])

    def test_unknown_select_rejects_truncated_original_or_fresh_value(self):
        for page in ['before', 'fresh']:
            checks, call, before, fresh, receipt = self.unknown_select()
            (before if page == 'before' else fresh)['nodes'][0]['value_truncated'] = True
            with self.subTest(page=page), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 1 if page == 'before' else 2)
            self.assertEqual(checks.actions, [])

    def test_unknown_select_rejects_real_native_slice_boundaries_in_utf16_units(self):
        for field, cap in [('url', 2048), ('title', 240), ('label', 240), ('value', 500),
                           ('option-label', 120), ('option-value', 120), ('expected', 120)]:
            for content in ['x'*cap, '\U0001f600'*(cap//2)]:
                checks, call, before, fresh, receipt = self.unknown_select()
                expected = 'strict'
                if field in ('url', 'title'):
                    before[field] = fresh[field] = content
                elif field == 'label':
                    before['nodes'][0]['label'] = fresh['nodes'][0]['label'] = content
                elif field == 'value': before['nodes'][0]['value'] = content
                elif field == 'option-label':
                    before['nodes'][0]['options'][1]['label'] = fresh['nodes'][0]['options'][1]['label'] = content
                else:
                    expected = content
                    before['nodes'][0]['options'][1]['value'] = fresh['nodes'][0]['options'][1]['value'] = content
                    fresh['nodes'][0]['value'] = content
                with self.subTest(field=field, units=cap, codepoints=len(content)), self.assertRaises(AssertionError):
                    checks.act('select', before['nodes'][0]['label'], scope='dialog', value=expected,
                               verify_unknown_select=True)
                self.assertEqual(call.call_count, 1)
                self.assertEqual(checks.actions, [])
        # Fresh boundary fields also fail even without a truncation flag.
        for field, cap in [('value', 500), ('option-label', 120), ('option-value', 120)]:
            checks, call, before, fresh, receipt = self.unknown_select()
            if field == 'value': fresh['nodes'][0]['value'] = '\U0001f600'*(cap//2)
            else: fresh['nodes'][0]['options'][1][field.split('-')[1]] = '\U0001f600'*(cap//2)
            with self.subTest(fresh_field=field), self.assertRaisesRegex(AssertionError, 'native slice boundary'):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 2)

    def test_unknown_select_proves_url_was_not_silently_trimmed_by_native_byte_budget(self):
        def initial(page):
            # These are exactly the pre-paging/pre-native-source JS fields.
            return dict(frame_id=page['frame_id'], scope=page['scope'], url=page['url'],
                        title=page['title'], text_offset=0, text='', nodes=[],
                        next_node_offset=None, next_text_offset=None, source_text_truncated=False)
        def size(page):
            return len(json.dumps(initial(page), ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        for extra, allowed in [(70, True), (71, False)]:
            checks, call, before, fresh, receipt = self.unknown_select()
            before['url'] = fresh['url'] = 'https://fixture.invalid/' + '界'*1700 + 'x'*extra
            self.assertEqual(size(before), 5330 + extra)
            self.assertLess(len(before['url'].encode('utf-16-le')) // 2, 2048)
            if allowed:
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
                self.assertEqual(call.call_count, 3)
                self.assertEqual(checks.observed_postconditions[0]['original_receipt'], receipt)
            else:
                with self.assertRaisesRegex(AssertionError, 'byte-budget'):
                    checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
                self.assertEqual(call.call_count, 1)
        # Exercise the real JS while-condition/slice size: the original URL is
        # BELOW 2048 units, but metadata exceeds 6000 bytes. After its last
        # 100-unit trim the apparently complete prefix is still >5400 bytes.
        checks, call, before, fresh, receipt = self.unknown_select()
        before['url'] = 'https://fixture.invalid/' + '界'*2000
        self.assertEqual(size(before), 6230)
        while size(before) > 6000: before['url'] = before['url'][:-100]
        self.assertEqual(size(before), 5930)
        fresh['url'] = before['url']
        with self.assertRaisesRegex(AssertionError, 'byte-budget'):
            checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
        self.assertEqual(call.call_count, 1)

    def test_unknown_select_budget_json_preserves_native_unicode_and_escape_encoding(self):
        checks, call, before, fresh, receipt = self.unknown_select()
        before['url'] = fresh['url'] = 'https://fixture.invalid/' + 'x'*1900
        before['title'] = fresh['title'] = 'line\n\t"\\\u2028😀'
        # Unicode JSON leaves emoji and U+2028 literal; quotes/backslashes and
        # C0 characters use the same escapes as modern JSON.stringify.
        sample = dict(title='line\n\t"\\\u2028😀', enabled=False, next=None, offset=0)
        encoded = json.dumps(sample, ensure_ascii=False, separators=(',', ':'))
        self.assertEqual(encoded, '{"title":"line\\n\\t\\"\\\\\u2028😀","enabled":false,"next":null,"offset":0}')
        checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
        self.assertEqual(call.call_count, 3)  # No arbitrary URL length/ASCII-only restriction.

    def test_unknown_select_allows_complete_unicode_evidence_below_source_caps(self):
        checks, call, before, fresh, receipt = self.unknown_select()
        before['title'] = fresh['title'] = '\U0001f600'*119 + 'a'  # 239 UTF-16 units, not 120.
        before['nodes'][0]['label'] = fresh['nodes'][0]['label'] = before['title']
        before['nodes'][0]['options'][1]['label'] = fresh['nodes'][0]['options'][1]['label'] = '\U0001f600'*59 + 'a'
        checks.act('select', before['nodes'][0]['label'], scope='dialog', value='strict', verify_unknown_select=True)
        self.assertEqual(call.call_count, 3)
        self.assertEqual(checks.actions, [])
        self.assertEqual(checks.observed_postconditions[0]['original_receipt']['effect'], 'unknown')

    def test_unknown_select_rejects_illegal_surrogates_in_compared_strings(self):
        for field in ['url', 'title', 'label', 'value', 'option-label', 'expected', 'type', 'native_origin']:
            for bad in ['\ud800', '\udfff']:
                checks, call, before, fresh, receipt = self.unknown_select(); expected = 'strict'
                if field in ('url', 'title'): before[field] = fresh[field] = bad
                elif field in ('label', 'type'): before['nodes'][0][field] = fresh['nodes'][0][field] = bad
                elif field == 'value': before['nodes'][0]['value'] = bad
                elif field == 'option-label':
                    before['nodes'][0]['options'][1]['label'] = fresh['nodes'][0]['options'][1]['label'] = bad
                elif field == 'native_origin': before['source'][field] = fresh['source'][field] = bad
                else:
                    expected = bad
                    before['nodes'][0]['options'][1]['value'] = fresh['nodes'][0]['options'][1]['value'] = bad
                    fresh['nodes'][0]['value'] = bad
                with self.subTest(field=field, bad=repr(bad)), self.assertRaises(AssertionError):
                    checks.act('select', before['nodes'][0]['label'], scope='dialog', value=expected,
                               verify_unknown_select=True)
                self.assertEqual(call.call_count, 1)

    def test_unknown_select_rejects_changed_page_even_when_value_matches(self):
        for key, value in [('url', 'https://fixture.invalid/settings#changed'), ('title', 'Other'), ('scope', 'page')]:
            checks, call, before, fresh, receipt = self.unknown_select(); fresh[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 2)
            self.assertEqual(checks.observed_postconditions[0]['original_receipt'], receipt)

    def test_unknown_select_rejects_native_source_or_binding_mismatch(self):
        for key, value in [('engine', 'playwright'), ('tab_id', 'browser:other'),
                           ('native_origin', 'https://other.invalid'), ('untrusted', False), ('owner', 'other-session')]:
            checks, call, before, fresh, receipt = self.unknown_select(); fresh['source'][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 2)

    def test_unknown_select_requires_distinct_canonical_fresh_frame(self):
        for value in ['a'*32, 'invalid', None]:
            checks, call, before, fresh, receipt = self.unknown_select(); fresh['frame_id'] = value
            with self.subTest(value=value), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 2)

    def test_unknown_select_rejects_every_incomplete_observation(self):
        changes = [('truncated', True), ('source_text_truncated', True), ('next_node_offset', 60),
                   ('next_text_offset', 100), ('text_offset', 100)]
        for page in ['before', 'fresh']:
            for key, value in changes:
                checks, call, before, fresh, receipt = self.unknown_select()
                (before if page == 'before' else fresh)[key] = value
                with self.subTest(page=page, key=key), self.assertRaises(AssertionError):
                    checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
                self.assertEqual(call.call_count, 1 if page == 'before' else 2)

    def test_unknown_select_requires_one_enabled_identical_target_and_expected_value(self):
        for change in ['missing', 'ambiguous', 'disabled', 'value', 'ref', 'tag', 'type', 'role', 'options']:
            checks, call, before, fresh, receipt = self.unknown_select(); target = fresh['nodes'][0]
            if change == 'missing': fresh['nodes'] = []
            elif change == 'ambiguous': fresh['nodes'].append(copy.deepcopy(target))
            elif change == 'disabled': target['disabled'] = True
            elif change == 'value': target['value'] = 'other'
            elif change == 'options': target['options'][1]['label'] = 'Changed meaning'
            else: target[change] = 'changed'
            with self.subTest(change=change), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 2)
            self.assertEqual(checks.actions, [])

    def test_unknown_select_fresh_read_failure_never_replays_or_matches(self):
        checks, call, before, fresh, receipt = self.unknown_select()
        call.side_effect = [receipt, RuntimeError('native bridge interrupted')]
        with self.assertRaises(RuntimeError):
            checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
        self.assertEqual([item.args[0] for item in call.call_args_list], ['perform', 'observe'])
        self.assertEqual(checks.observed_postconditions[0]['verification'], 'unverified')

    def test_unknown_select_still_requires_old_frame_zero_effect_negative_control(self):
        for effect in ['unknown', 'applied']:
            checks, call, before, fresh, receipt = self.unknown_select()
            call.side_effect = [receipt, fresh, dict(ok=effect=='applied', effect=effect)]
            with self.subTest(effect=effect), self.assertRaises(AssertionError):
                checks.act('select', 'Chosen mode', scope='dialog', value='strict', verify_unknown_select=True)
            self.assertEqual(call.call_count, 3)
            self.assertEqual(checks.actions, [])
            self.assertEqual(checks.observed_postconditions[0]['verification'], 'unverified')

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

    def test_navigation_invalidated_observation_is_reobserved_with_the_same_scope(self):
        message = 'browser navigation changed during inspection; observe again'
        page = {'source': {'engine': 'tauri-webview'}, 'nodes': []}
        call = Mock(side_effect=[RuntimeError(message), page])
        checks = Contract(call)
        with patch('scripts.gui_bench.webview_contract.time.sleep'):
            self.assertEqual(checks.observe('dialog', node_offset=20), page)
        self.assertEqual(checks.readiness_denials, [message])
        self.assertEqual([item.args for item in call.call_args_list],
                         [('observe', {'scope': 'dialog', 'node_offset': 20})] * 2)
        clock = itertools.count(0, .5)
        call = Mock(side_effect=RuntimeError(message))
        with patch('scripts.gui_bench.webview_contract.time.sleep'), \
             patch('scripts.gui_bench.webview_contract.time.monotonic', side_effect=lambda: next(clock)), \
             self.assertRaisesRegex(RuntimeError, 'navigation changed'):
            Contract(call).observe()
        self.assertLessEqual(call.call_count, 11)
        for message in ['browser tab changed during inspection', 'native observation exceeds output budget',
                        'unauthorized origin', 'browser navigation changed during inspection; different error']:
            call = Mock(side_effect=RuntimeError(message))
            with self.subTest(message=message), self.assertRaises(RuntimeError):
                Contract(call).observe()
            self.assertEqual(call.call_count, 1)

    def test_failed_action_retains_diagnostic_without_replay_or_private_transport(self):
        for effect in ('not_started', 'unknown', 'applied'):
            call = Mock(return_value={'ok':False, 'effect':effect,
                                      'message':'stale_target: observe again',
                                      'token':'private-transport'})
            checks = Contract(call)
            checks.target = Mock(return_value=({'frame_id':'observed'},
                                               {'ref':'n1', 'disabled':False}))
            with self.subTest(effect=effect), self.assertRaises(AssertionError) as failure:
                checks.act('select', 'Reasoning level', value='low')
            self.assertIn('"effect": "' + effect + '"', str(failure.exception))
            self.assertIn('stale_target', str(failure.exception))
            self.assertNotIn('private-transport', str(failure.exception))
            self.assertEqual(call.call_count, 1)
            self.assertEqual(call.call_args.args[0], 'perform')
            self.assertEqual(checks.actions, [])

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
