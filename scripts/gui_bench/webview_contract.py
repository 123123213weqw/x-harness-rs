"""Deterministic native-bridge regression, never a model competence score.

Only observed labels/refs drive actions. Fixture state is read separately by the
grader, never used to complete a task. Public GitHub mode is observation-only.
"""
import time


class Contract:
    def __init__(self, call):
        self.call, self.actions, self.denials = call, [], []

    def observe(self, scope='page', **paging):
        snapshot = self.call('observe', dict(scope=scope, **paging))
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
                if nodes: return snapshot, nodes[0]
                offset = snapshot.get('next_node_offset')
                if offset is None: break
            time.sleep(.1)
        raise TimeoutError('observed target unavailable: ' + label)

    def deny(self, request, name):
        receipt = self.call('perform', request)
        if receipt.get('ok') is not False or receipt.get('effect') != 'not_started':
            raise AssertionError('expected no scheduled effect: ' + name)
        self.denials.append(name)

    def act(self, action, label, scope='page', **fields):
        snapshot, node = self.target(label, scope)
        if node['disabled']: raise AssertionError('contract target is disabled: ' + label)
        request = dict(action=action, frame_id=snapshot['frame_id'], ref=node['ref'], **fields)
        receipt = self.call('perform', request)
        if receipt.get('ok') is not True or receipt.get('effect') != 'applied':
            # Unknown/applied effects must NEVER be automatically replayed.
            raise AssertionError('native action did not settle: ' + action + ' ' + label)
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
            self.act('select', 'Reasoning level', scope='dialog', value='low')
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
        return dict(actions=self.actions, denials=self.denials, model_task_passed=None)
