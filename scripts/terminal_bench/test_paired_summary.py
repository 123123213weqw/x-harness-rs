import unittest
from summarize_paired import summarize


def row(agent, grade, dollars=.1, usage=True):
    return {'task': 'fixture', 'harness': agent, 'termination': 'COMPLETED', 'grade': {'status': grade},
            'budget': {'requests': 1, 'conservative_usd': dollars, 'rows': [
                {'usage': {'prompt_tokens': 100, 'completion_tokens': 20} if usage else None}]}}


class SummaryTests(unittest.TestCase):
    def test_infrastructure_is_not_zero_score_and_cost_is_kept(self):
        result = summarize([row('xharness', 'PASS'), row('official', 'INFRA_ERROR', .2)])
        self.assertEqual(result['trials'][1]['grade'], 'NA')
        self.assertAlmostEqual(result['total_conservative_usd'], .3)
        self.assertEqual(result['paired'][0]['outcome'], 'NA')
        self.assertIsNone(result['common_pass_efficiency'])

    def test_efficiency_requires_common_passes_and_complete_usage(self):
        for grade, usage in (('FAIL', True), ('PASS', False)):
            result = summarize([row('xharness', 'PASS'), row('official', grade, usage=usage)])
            self.assertIsNone(result['common_pass_efficiency'])
        result = summarize([row('xharness', 'PASS'), row('official', 'PASS')])
        self.assertEqual(result['common_pass_efficiency']['official']['input_tokens'], 100)

    def test_duplicates_cannot_be_best_of_selected(self):
        with self.assertRaises(ValueError):
            summarize([row('xharness', 'FAIL'), row('xharness', 'PASS')])

    def test_single_result_does_not_make_a_paired_win(self):
        self.assertEqual(summarize([row('xharness', 'PASS')])['paired'][0]['outcome'], 'NA')
