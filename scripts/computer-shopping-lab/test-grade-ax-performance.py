import copy
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('grade_ax', Path(__file__).with_name('grade-ax-performance.py'))
grade_ax = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grade_ax)


class PerformanceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'source_sha': 'exact', 'title_contains': 'Product', 'url': 'https://shop.test/search?q=SSD', 'required_labels': ['SSD']}
        self.receipt = {'ok': True, 'source_sha': 'exact', 'elapsed_ms': 9000, 'result': {'action': 'observe', 'coordinate_space': 'physical_desktop_pixels', 'surfaces': [{'frontmost': True, 'title': 'Product'}], 'accessibility': {'returned': 2, 'nodes': [{'node_id': 'root', 'parent_id': None, 'label': 'SSD', 'role': 'window'}, {'node_id': 'url', 'parent_id': 'root', 'label': 'Address', 'role': 'edit', 'value': self.manifest['url']}]}}}

    def test_actual_anchor_and_exact_source(self):
        grade_ax.validate(self.receipt, self.manifest)

    def reject(self, receipt):
        with self.assertRaises(ValueError):
            grade_ax.validate(receipt, self.manifest)

    def test_shell_foreground_is_not_fast_product_page(self):
        self.receipt['result']['surfaces'][0]['title'] = 'Windows task switcher'
        self.reject(self.receipt)

    def test_wrong_artifact_source(self):
        self.receipt['source_sha'] = 'previous'
        self.reject(self.receipt)

    def test_same_title_different_query_is_not_same_page(self):
        self.receipt['result']['accessibility']['nodes'][1]['value'] += '-old'
        self.reject(self.receipt)

    def test_missing_product_anchor(self):
        self.receipt['result']['accessibility']['nodes'][0]['label'] = 'Unrelated'
        self.reject(self.receipt)

    def test_broken_ancestor_closure(self):
        self.receipt['result']['accessibility']['nodes'][1]['parent_id'] = 'missing'
        self.reject(self.receipt)

    def test_nonfinite_latency(self):
        for value in (float('nan'), float('inf'), -1, True):
            receipt = copy.deepcopy(self.receipt)
            receipt['elapsed_ms'] = value
            self.reject(receipt)

    def test_partial_tree_and_missing_input_do_not_become_quality_pass(self):
        receipt = copy.deepcopy(self.receipt)
        ax = receipt['result']['accessibility']
        ax.update(region={}, viewport={}, scope='foreground_window', timings={}, truncated=True, truncation_reasons=['time_limit'])
        manifest = dict(self.manifest, expected_inputs=[{'label': 'Search', 'value': 'SSD'}])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest['samples'] = [{'file': f'{i}.json', 'detail': 'auto'} for i in range(3)]
            (root / 'manifest.json').write_text(json.dumps(manifest))
            for sample in manifest['samples']:
                (root / sample['file']).write_text(json.dumps(receipt))
            report = grade_ax.grade(root)
            self.assertFalse(report['required_input_coverage_passed'])
            self.assertFalse(report['complete_tree_accepted'])
            self.assertFalse(report['causal_speedup_claim'])
            for sample in manifest['samples']:
                original = root / sample['file']
                sample['file'] += '.gz'
                (root / sample['file']).write_bytes(gzip.compress(original.read_bytes(), mtime=0))
            (root / 'manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(grade_ax.grade(root), report)
            manifest['samples'].pop()
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                grade_ax.grade(root)


if __name__ == '__main__':
    unittest.main()
