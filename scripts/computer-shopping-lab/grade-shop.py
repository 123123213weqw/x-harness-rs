#!/usr/bin/env python3
"""Grade actual synthetic page events, never LLM self-assessment."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('events', type=Path)
parser.add_argument('catalog', type=Path)
args = parser.parse_args()
rows = [json.loads(line) for line in args.events.read_text().splitlines() if line.strip()]
initials = [i for i, row in enumerate(rows) if row.get('type') == 'initial']
if not initials:
    raise SystemExit('No independent page initialization event')
rows = rows[initials[-1]:]
products = json.loads(args.catalog.read_text())
eligible = sorted((p for p in products if p['capacity'] == '1TB'
                   and p['interface'] == 'NVMe PCIe 4.0' and p['nand'] == 'TLC'
                   and p['warranty'] == 5 and p['tbw'] >= 600 and p['price'] <= 700),
                  key=lambda p: p['price'])
if len(eligible) < 2:
    raise SystemExit('Fixture does not provide two eligible products')
expected = [p['id'] for p in eligible[:2]]
checks = {
    'initial_product_count': rows[0]['detail']['total'] == len(products),
    'large_dom': rows[0]['detail']['domNodes'] >= 6000,
    'submitted_search': any(r['type'] == 'search' and r['query'] == 'SSD' for r in rows),
    'tlc_filter': any(r['type'] == 'filter' and r['tlc'] for r in rows),
    'ascending_price': any(r['type'] == 'sort' and r['order'] == 'asc' for r in rows),
    'compared_two_cheapest_eligible': any(r['type'] == 'compare'
        and set(r['detail'].get('ids', [])) == set(expected) for r in rows),
    'exact_cart': rows[-1]['cart'] == expected[:1],
}
print(json.dumps({'checks': checks, 'expected_products': eligible[:2],
                  'page_event_oracle_passed': all(checks.values()),
                  'llm_report_accuracy_checked': False,
                  'full_installed_host_runtime_checked': False}, indent=2))
raise SystemExit(0 if all(checks.values()) else 1)
