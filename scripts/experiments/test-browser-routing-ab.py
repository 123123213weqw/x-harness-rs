#!/usr/bin/env python3
"""Offline fixture and routing-oracle checks; never calls a model or desktop."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('browser_ab', Path(__file__).with_name('browser-routing-ab.py'))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)


class RoutingTest(unittest.TestCase):
    def setUp(self):
        self.c = ab.contract()
        self.case = ab.cases()[0]
        self.world = ab.World(self.case, self.c)

    def invoke(self, tool, arguments):
        return self.world.call('plugin_mcp', {'action': 'call', 'plugin': self.c['plugin'], 'server': self.c['server'], 'tool': tool, 'arguments': arguments})

    def test_production_contracts_and_lazy_schema(self):
        self.assertEqual(self.c['definition']['name'], 'plugin_mcp')
        self.assertTrue(self.c['definition']['description'].startswith('Discover and control'))
        self.assertIn('when available', self.c['policy'])
        self.assertEqual(set(self.c['schemas']), {'control', 'observe'})
        self.assertEqual(self.c['schemas']['control']['inputSchema']['oneOf'][1]['properties']['action']['const'], 'open')

    def test_description_preserves_literal_and_composed_source_policy(self):
        historical = 'Discover historical browser\\nRespect explicit choices.'
        self.assertEqual(ab.mcp_description(json.dumps(historical) + ', json!({})'), historical)
        boundary = ab.source(ab.BOUNDARY)
        guidance = ab.literal(boundary, 'const GUIDANCE: &str = ')
        tail = ab.source(ab.MCP).split('"plugin_mcp",', 1)[1]
        self.assertEqual(ab.mcp_description(tail, boundary), self.c['definition']['description'])
        self.assertTrue(self.c['definition']['description'].endswith(guidance))
        self.assertIn('never mix references, transfer cookies/profiles, or silently switch', guidance)
        self.assertTrue(self.c['summary'].startswith('Embedded browser:'))

    def test_description_unknown_expressions_fail_closed(self):
        boundary = 'const GUIDANCE: &str = " appended policy";'
        for expression in ('description()', 'format!("{}", "base"),',
                           'format!("{}{}", "base", other::GUIDANCE),',
                           'format!("{}{}", "base", browser_boundary::GUIDANCE + "ignored"),'):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                ab.mcp_description(expression, boundary)
        with self.assertRaises(ValueError):
            ab.mcp_description('format!("{}{}", "base", browser_boundary::GUIDANCE),')

    def test_extracted_boundary_uses_the_same_revision_as_other_contract_sources(self):
        current_source = ab.source
        reads = []
        def snapshot(path, revision):
            reads.append((path, revision))
            return current_source(path)
        with patch.object(ab, 'source', side_effect=snapshot):
            extracted = ab.contract('captured-revision')
        self.assertEqual(extracted, self.c)
        self.assertIn((ab.BOUNDARY, 'captured-revision'), reads)
        self.assertTrue(all(revision == 'captured-revision' for _, revision in reads))

    def test_wire_envelopes_preserve_lazy_discovery_and_native_result_boundaries(self):
        discovery = json.loads(ab.wire_result('plugin_mcp', {'action': 'list'}, {'plugins': []}))
        self.assertTrue(discovery['ok'])
        self.assertEqual(json.loads(discovery['content']), {'plugins': []})
        result = {'ok': True, 'state': 'ready'}
        opened = json.loads(ab.wire_result('plugin_mcp', {'action': 'call'}, result))
        mcp = json.loads(opened['content'])
        self.assertFalse(mcp['isError'])
        self.assertEqual(json.loads(mcp['content'][0]['text']), result)
        failed = json.loads(ab.wire_result('plugin_mcp', {'action': 'call'}, {'ok': False}))
        self.assertFalse(failed['ok'])
        self.assertEqual(failed['content'], '')

    def test_discovery_does_not_count_as_navigation(self):
        self.world.call('plugin_mcp', {'action': 'list'})
        self.assertFalse(self.world.score()['passed'])
        self.assertFalse(self.world.opened)

    def test_open_without_observation_is_not_pass(self):
        self.world.call('plugin_mcp', {'action': 'list'})
        self.invoke('control', {'action': 'open', 'url': ab.URL})
        self.assertFalse(self.world.score()['passed'])
        self.invoke('observe', {})
        self.assertTrue(self.world.score()['passed'])

    def test_no_tool_self_report_cannot_pass(self):
        self.assertFalse(self.world.score(finished=True)['passed'])

    def test_wrong_desktop_attempt_fails_even_after_recovery(self):
        self.world.call('computer', {'action': 'observe'})
        self.world.call('plugin_mcp', {'action': 'list'})
        self.invoke('control', {'action': 'open', 'url': ab.URL})
        self.invoke('observe', {})
        self.assertFalse(self.world.score()['passed'])

    def test_absent_bridge_does_not_claim_readiness(self):
        self.world = ab.World(ab.cases()[-1], self.c)
        index = self.world.call('plugin_mcp', {'action': 'list'})
        self.assertEqual(index['capabilities'], [])
        self.assertNotIn(self.c['plugin'], index['plugins'])
        self.invoke('control', {'action': 'open', 'url': ab.URL})
        self.assertFalse(self.world.opened)
        self.world.call('web_fetch', {'url': ab.URL})
        self.assertTrue(self.world.score()['passed'])

    def test_explicit_external_and_desktop_choices_are_not_rerouted(self):
        self.world = ab.World(ab.cases()[4], self.c)
        self.world.call('bash', {'command': 'open -a "Google Chrome" https://example.test'})
        self.assertTrue(self.world.score()['passed'])
        self.world = ab.World(ab.cases()[5], self.c)
        self.world.call('computer', {'action': 'observe'})
        self.assertTrue(self.world.score()['passed'])

    def test_specific_fact_without_open_request_can_use_fetch(self):
        self.world = ab.World(ab.cases()[-2], self.c)
        self.world.call('web_fetch', {'url': ab.URL})
        self.assertTrue(self.world.score()['passed'])
        self.assertFalse(self.world.opened)

    def test_wrong_target_or_malformed_open_does_not_pass(self):
        self.world.call('plugin_mcp', {'action': 'list'})
        self.invoke('control', {'action': 'open', 'url': 'file:///tmp/not-web'})
        self.invoke('observe', {})
        self.assertFalse(self.world.score()['passed'])


if __name__ == '__main__':
    unittest.main()
