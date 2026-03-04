#!/usr/bin/env python3
"""Independent live-Goal acceptance; not placed in the model's work directory."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location('ledger_under_test', ROOT / 'ledger.py')
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)

class LedgerAcceptance(unittest.TestCase):
    def summary(self, text):
        return ledger.summarize(ledger.parse_rows(text))

    def test_exact_decimal_aggregation(self):
        r = self.summary('date,category,amount\n2024-02-29,food,0.10\n2024-03-01,food,0.20\n2024-03-02,refund,-0.05\n')
        self.assertEqual(r, {'count': 3, 'total': '0.25', 'by_category': {'food': '0.30', 'refund': '-0.05'}})

    def test_header_only(self):
        self.assertEqual(self.summary('date,category,amount\n'), {'count': 0, 'total': '0.00', 'by_category': {}})

    def test_quoted_unicode_and_sorted_categories(self):
        r = self.summary('date,category,amount\n2024-01-01, 餐饮 ,12.30\n2024-01-02,"a,b",-2.00\n2024-01-03,z,1\n')
        self.assertEqual(r['by_category'], {'a,b': '-2.00', 'z': '1.00', '餐饮': '12.30'})
        self.assertEqual(list(r['by_category']), sorted(r['by_category']))
        self.assertEqual(r['total'], '11.30')

    def test_precision_without_binary_float(self):
        text = 'date,category,amount\n' + '2024-01-01,a,0.01\n' * 1001
        self.assertEqual(self.summary(text)['total'], '10.01')

    def test_invalid_amounts(self):
        for value in ['NaN', 'Infinity', '-Infinity', '1e2', '1.001', 'abc', '']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.summary(f'date,category,amount\n2024-01-01,a,{value}\n')

    def test_calendar_validation(self):
        for day in ['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-01', '2024-1-1', '20240101', 'not-a-date']:
            with self.subTest(day=day), self.assertRaises(ValueError):
                self.summary(f'date,category,amount\n{day},a,1.00\n')

    def test_wrong_headers(self):
        for header in ['amount,category,date', 'date,category,amount,extra', 'date,category', 'DATE,category,amount', '']:
            with self.subTest(header=header), self.assertRaises(ValueError):
                self.summary(header + '\n')

    def test_bad_records(self):
        for row in ['2024-01-01,,1', '2024-01-01,   ,1', '2024-01-01,a', '2024-01-01,a,1,extra']:
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.summary('date,category,amount\n' + row + '\n')

    def test_error_has_row_context(self):
        with self.assertRaises(ValueError) as raised:
            self.summary('date,category,amount\n2024-01-01,a,1\n2024-01-02,b,bad\n')
        self.assertRegex(str(raised.exception).lower(), r'(row|line|行|record|记录).*\d|\d.*(row|line|行|record|记录)')

    def test_cli_bom_json(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'input.csv'
            p.write_text('date,category,amount\n2024-01-01,旅行,12.34\n', encoding='utf-8-sig')
            result = subprocess.run([sys.executable, str(ROOT / 'ledger.py'), str(p)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'count': 1, 'total': '12.34', 'by_category': {'旅行': '12.34'}})

    def test_cli_invalid_and_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'bad.csv'; p.write_text('bad\n')
            for path in [p, Path(temp) / 'absent.csv']:
                r = subprocess.run([sys.executable, str(ROOT / 'ledger.py'), str(path)], capture_output=True, text=True, timeout=10)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn('Traceback', r.stdout + r.stderr)

    def test_deliverables(self):
        for name in ['README.md', 'test_ledger.py']:
            self.assertGreater((ROOT / name).stat().st_size, 100)
        r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-v'], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('Ran ', r.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
