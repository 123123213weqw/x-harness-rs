"""Deterministic native-bridge regression, never a model competence score.

Only observed labels/refs drive actions. Fixture state is read separately by the
grader, never used to complete a task. Public GitHub mode is observation-only.
"""
import json
import re
import time


class Contract:
    def __init__(self, call):
        self.call, self.actions, self.denials = call, [], []
        self.readiness_denials = []
        self.observed_postconditions = []
        self._target_page_offset = 0

    def observe(self, scope='page', **paging):
        # AppFrame expands/resizes a real native pane asynchronously. Retry
        # only a bounded, side-effect-free observation while its presentation
        # is settling or a navigation invalidated the read. Never replay an
        # action, relax native scope checks or conceal transport/JS failures.
        deadline = time.monotonic() + 5
        transient = {'native browser is hidden', 'native browser is not delegated to this session',
                     'only the active, laid-out browser tab can be inspected',
                     'browser navigation changed during inspection; observe again'}
        while True:
            try:
                snapshot = self.call('observe', dict(scope=scope, **paging))
                break
            except RuntimeError as error:
                if str(error) not in transient or time.monotonic() >= deadline:
                    raise
                self.readiness_denials.append(str(error))
                time.sleep(.1)
        if snapshot.get('source', {}).get('engine') != 'tauri-webview':
            raise AssertionError('contract requires genuine native evidence')
        return snapshot

    def target(self, label, scope='page', timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            offset = 0
            for _ in range(20):
                snapshot = self.observe(scope, node_offset=offset)
                nodes = [node for node in snapshot['nodes'] if node['label'] == label]
                if len(nodes) > 1: raise AssertionError('ambiguous contract target: ' + label)
                if nodes:
                    self._target_page_offset = offset
                    return snapshot, nodes[0]
                offset = snapshot.get('next_node_offset')
                if offset is None: break
            time.sleep(.1)
        raise TimeoutError('observed target unavailable: ' + label)

    def deny(self, request, name):
        receipt = self.call('perform', request)
        if receipt.get('ok') is not False or receipt.get('effect') != 'not_started':
            raise AssertionError('expected no scheduled effect: ' + name)
        self.denials.append(name)
        return receipt

    def verify_select_postcondition(self, snapshot, node, receipt, label, scope, expected, request):
        # This is an explicitly requested, read-only goal check, NOT an Applied
        # receipt or permission to replay. The native owner remains the fixed
        # owner of self.call; the fresh observation must pass its native binding.
        def require(condition, reason):
            if not condition:
                raise AssertionError('unknown select postcondition rejected: ' + reason)
        def complete(page):
            return (page.get('truncated') is False and page.get('source_text_truncated') is False
                    and page.get('next_node_offset') is None and page.get('next_text_offset') is None
                    and page.get('text_offset') == 0)
        def frame(value):
            return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None
        def utf16_size(value):
            if not isinstance(value, str): return None
            try: return len(value.encode('utf-16-le')) // 2
            except UnicodeEncodeError: return None  # Never compare lone surrogate prefixes.
        def bounded(value, cap):
            size = utf16_size(value)
            return size is not None and size < cap
        def url_budget_unambiguous(page):
            # Match browser_observe.js's INITIAL snapshot, before node/text
            # paging and before native source metadata is attached. If line91
            # ever trimmed URL, the last pre-trim JSON exceeded 6000 bytes;
            # .slice(0, -100) removes at most 600 JSON bytes (100 UTF-16 units,
            # worst-case \uXXXX escapes). Thus its post-trim empty-text metadata
            # exceeds 5400 bytes. <=5400 is a sufficient, conservative proof
            # that no such silent URL trim occurred. The later line121 fallback
            # always sets options_truncated, independently rejected by choice().
            initial = dict(frame_id=page.get('frame_id'), scope=page.get('scope'),
                           url=page.get('url'), title=page.get('title'), text_offset=0,
                           text='', nodes=[], next_node_offset=None, next_text_offset=None,
                           source_text_truncated=False)
            # Compact Unicode JSON matches JSON.stringify for these typed
            # string/bool/null/integer fields, including control-character escapes.
            size = len(json.dumps(initial, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            return size + 100 * 6 <= 6000
        def unambiguous_strings(page, target):
            # browser_observe.js uses JS .slice(), which silently cuts UTF-16
            # at these exact caps. Equality AT a cap cannot establish full
            # identity/value equality (nor can truncated flags prove otherwise).
            return (bounded(page.get('url'), 2048) and bounded(page.get('title'), 240)
                    and bounded(target.get('label'), 240) and bounded(target.get('value'), 500)
                    and url_budget_unambiguous(page)
                    and all(bounded(option.get('label'), 120) and bounded(option.get('value'), 120)
                            for option in target.get('options', []))
                    and all(utf16_size(target.get(key)) is not None for key in ('ref', 'tag', 'type', 'role'))
                    and utf16_size(page.get('scope')) is not None
                    and all(utf16_size(page.get('source', {}).get(key)) is not None
                            for key in ('engine', 'tab_id', 'native_origin')))
        def choice(target):
            options = target.get('options', [])
            return (target.get('option_offset') == 0 and target.get('next_option_offset') is None
                    and target.get('options_truncated', False) is False
                    and target.get('option_count') == len(options)
                    and sum(option.get('value') == expected for option in options) == 1)
        require(set(receipt) <= {'ok', 'effect', 'frame_id', 'message'}
                and receipt.get('ok') is False and receipt.get('effect') == 'unknown'
                and receipt.get('frame_id') == snapshot.get('frame_id')
                and utf16_size(receipt.get('message', '')) is not None
                and len(receipt.get('message', '').encode('utf-8')) <= 500,
                'invalid original receipt')  # PerformResult limits native messages by UTF-8 bytes.
        evidence = dict(action='select', label=label, expected_value=expected,
                        original_receipt=dict(receipt), verification='unverified')
        self.observed_postconditions.append(evidence)
        source = snapshot.get('source', {})
        require(source.get('engine') == 'tauri-webview' and source.get('tab_id')
                and source.get('native_origin') and snapshot.get('url') and snapshot.get('title')
                and snapshot.get('scope') == scope and frame(snapshot.get('frame_id')), 'missing native identity')
        require(self._target_page_offset == 0 and complete(snapshot), 'incomplete original page')
        require(bounded(expected, 120) and unambiguous_strings(snapshot, node),
                'original string evidence reaches a native slice boundary or byte-budget limit or is invalid UTF-16')
        require(isinstance(expected, str) and node.get('tag') == 'select'
                and node.get('disabled') is False and isinstance(node.get('value'), str)
                and node.get('value_truncated', False) is False and node['value'] != expected
                and choice(node), 'original select is not a distinct observable goal')
        identity = ('ref', 'tag', 'type', 'role', 'label')
        require(sum(candidate.get('label') == label for candidate in snapshot.get('nodes', [])) == 1,
                'ambiguous original target')
        fresh = self.observe(scope)  # One fresh read; never poll until the value happens to match.
        evidence['before'] = dict(frame_id=snapshot['frame_id'], url=snapshot['url'],
                                 title=snapshot['title'], scope=scope, source=source, node=node)
        evidence['fresh'] = fresh
        require(fresh.get('source') == source and fresh.get('url') == snapshot['url']
                and fresh.get('title') == snapshot['title'] and fresh.get('scope') == scope,
                'page or native binding identity changed')
        require(frame(fresh.get('frame_id')) and fresh['frame_id'] != snapshot['frame_id'], 'not a fresh frame')
        require(complete(fresh), 'incomplete fresh page')
        targets = [candidate for candidate in fresh.get('nodes', []) if candidate.get('label') == label]
        require(len(targets) == 1, 'missing or ambiguous fresh target')
        observed = targets[0]
        require(unambiguous_strings(fresh, observed),
                'fresh string evidence reaches a native slice boundary or byte-budget limit or is invalid UTF-16')
        require(all(observed.get(key) == node.get(key) for key in identity)
                and observed.get('disabled') is False and observed.get('value_truncated', False) is False
                and choice(observed)
                and observed.get('options') == node.get('options') and observed.get('value') == expected,
                'select identity, availability or value differs')
        # An intentional old-frame negative control, not an action replay:
        # the native guard MUST prove not_started (zero scheduled effects).
        evidence['consumed_frame_denial'] = self.deny(request, 'consumed_frame')
        evidence['verification'] = 'matched_observed_state_not_applied_receipt'

    def act(self, action, label, scope='page', *, verify_unknown_select=False, **fields):
        snapshot, node = self.target(label, scope)
        if node['disabled']: raise AssertionError('contract target is disabled: ' + label)
        request = dict(action=action, frame_id=snapshot['frame_id'], ref=node['ref'], **fields)
        receipt = self.call('perform', request)
        if receipt.get('ok') is not True or receipt.get('effect') != 'applied':
            if (verify_unknown_select is True and action == 'select'
                    and receipt.get('ok') is False and receipt.get('effect') == 'unknown'):
                self.verify_select_postcondition(snapshot, node, receipt, label, scope, fields.get('value'), request)
                return  # Keep the original unknown OUT of Applied actions.
            # Unknown/applied effects must NEVER be automatically replayed.
            diagnostic = {key: receipt.get(key) for key in ('ok', 'effect', 'message')}
            raise AssertionError('native action did not settle: ' + action + ' ' + label
                                 + ' receipt=' + json.dumps(diagnostic, ensure_ascii=True))
        self.actions.append(dict(action=action, label=label))
        self.deny(request, 'consumed_frame')

    def run(self, task):
        if task == 'issue':
            self.deny({'action':'eval','script':'forbidden'}, 'invalid_schema')
            self.act('fill', 'Search issues', text='compaction')
            self.act('click', 'Search')
            self.act('click', '#105 Compaction recovery does not settle')
            self.act('fill', 'Recovery marker answer', text='ORBIT-7319')
        elif task == 'pr':
            self.act('click', 'New draft')
            self.act('fill', 'Title', text='Restore compact completion')
            self.act('fill', 'Description', text='Handle the completion event. Tests: replay and restart.')
        elif task == 'dynamic':
            self.act('click', 'Configure provider')
            snapshot, behind = self.target('Configure provider')
            if behind['disabled'] is not True:
                raise AssertionError('modal background is still actionable')
            self.deny(dict(action='click',frame_id=snapshot['frame_id'],ref=behind['ref']), 'modal_background')
            snapshot = self.observe()
            self.deny(dict(action='scroll',frame_id=snapshot['frame_id'],delta_y=500), 'modal_page_scroll')
            self.act('select', 'Provider', scope='dialog', value='gamma')
            self.act('select', 'Reasoning level', scope='dialog', value='low', verify_unknown_select=True)
            self.act('click', 'Save settings', scope='dialog')
        elif task == 'game':
            for _ in range(8): self.act('click', 'Target')
        elif task == 'github':
            # A genuine page load/read is useful infrastructure evidence, but
            # it is NOT a model search/view success or a submitted PR.
            snapshots = []
            offset = 0
            for _ in range(8):
                snapshot = self.observe('main', text_offset=offset)
                snapshots.append(snapshot)
                offset = snapshot.get('next_text_offset')
                if offset is None: break
            expected = 'https://github.com/123123213weqw/x-harness-rs/issues'
            if any(s['url'].split('?')[0].rstrip('/') != expected for s in snapshots):
                raise AssertionError('public probe navigated outside the fixed signed-out target')
            if not any('Issues' in s['text'] for s in snapshots):
                raise AssertionError('public page content unavailable')
            return dict(actions=[], denials=[], public_observations=snapshots,
                        searched_via_ui=False, model_task_passed=None)
        else: raise ValueError('unknown contract task')
        return dict(actions=self.actions, denials=self.denials,
                    readiness_denials=self.readiness_denials,
                    observed_postconditions=self.observed_postconditions, model_task_passed=None)
