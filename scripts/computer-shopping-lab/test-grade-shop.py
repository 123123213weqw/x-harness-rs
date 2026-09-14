import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('grade-shop.py')

class OracleTests(unittest.TestCase):
    def grade(self, events):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = [dict(id='a', name='SSD A', capacity='1TB', interface='NVMe PCIe 4.0', nand='TLC', warranty=5, tbw=600, price=500),
                       dict(id='b', name='SSD B', capacity='1TB', interface='NVMe PCIe 4.0', nand='TLC', warranty=5, tbw=650, price=600),
                       dict(id='trap', name='Cheap SSD', capacity='1TB', interface='NVMe PCIe 4.0', nand='QLC', warranty=5, tbw=100, price=300)]
            (root/'catalog.json').write_text(json.dumps(catalog))
            (root/'events.jsonl').write_text('\n'.join(json.dumps(row) for row in events))
            return subprocess.run([sys.executable, str(SCRIPT), str(root/'events.jsonl'), str(root/'catalog.json')], capture_output=True).returncode
    def events(self):
        base = dict(cart=[], query='SSD', tlc=True, order='asc')
        return [dict(base, type='initial', detail=dict(total=3, domNodes=6493)),
                dict(base, type='search', detail={}), dict(base, type='filter', detail={}),
                dict(base, type='sort', detail={}), dict(base, type='compare', detail=dict(ids=['a','b'])),
                dict(base, type='add_to_cart', detail=dict(id='a'), cart=['a'])]
    def test_correct_page_state(self):
        self.assertEqual(self.grade(self.events()), 0)
    def test_wrong_cheaper_product_is_not_success(self):
        events=self.events();events[-1]['cart']=['trap'];self.assertNotEqual(self.grade(events),0)
    def test_duplicate_cart_is_not_success(self):
        events=self.events();events[-1]['cart']=['a','a'];self.assertNotEqual(self.grade(events),0)
    def test_missing_compare_is_not_success(self):
        events=self.events();del events[-2];self.assertNotEqual(self.grade(events),0)
    def test_prior_success_does_not_mask_latest_failure(self):
        events=self.events()+[self.events()[0]];self.assertNotEqual(self.grade(events),0)
    def test_missing_initial_is_not_success(self):
        self.assertNotEqual(self.grade(self.events()[1:]),0)

if __name__=='__main__':unittest.main()
