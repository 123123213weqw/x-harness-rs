#!/usr/bin/env python3
"""Offline observation benchmark grading; never dispatches desktop input.

Each directory supplies manifest.json with source_sha, title_contains, url,
required_labels (regular expressions), and samples [{file, detail}]. Native
latency is descriptive, not a causal speedup claim when traversal is partial.
"""
import argparse
import gzip
import json
import math
from pathlib import Path
import re
from statistics import median


def validate(receipt, manifest):
    if receipt.get('ok') is not True or receipt.get('source_sha') != manifest['source_sha']:
        raise ValueError('failed operation or wrong artifact source')
    result = receipt['result']
    front = [s for s in result['surfaces'] if s.get('frontmost')]
    if len(front) != 1 or manifest['title_contains'] not in front[0]['title']:
        raise ValueError('wrong foreground: not a product-page benchmark')
    if result.get('action') != 'observe' or result.get('coordinate_space') != 'physical_desktop_pixels':
        raise ValueError('not a Windows physical-coordinate observation')
    ax = result['accessibility']
    nodes = ax['nodes']
    ids = {n['node_id'] for n in nodes}
    if len(ids) != len(nodes) or any(n.get('parent_id') is not None and n['parent_id'] not in ids for n in nodes):
        raise ValueError('duplicate nodes or broken ancestor closure')
    if not any(n.get('role') == 'edit' and n.get('value') == manifest['url'] for n in nodes):
        raise ValueError('exact observed URL missing or different')
    if any(not any(re.search(pattern, n.get('label', '')) for n in nodes) for pattern in manifest['required_labels']):
        raise ValueError('required visible content missing')
    elapsed = receipt['elapsed_ms']
    if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0:
        raise ValueError('invalid native elapsed time')
    if ax['returned'] != len(nodes):
        raise ValueError('returned count differs from actual nodes')
    return receipt


def grade(root):
    root = Path(root)
    manifest = json.loads((root / 'manifest.json').read_text())
    modes = {}
    seen = set()
    geometry = None
    for item in manifest['samples']:
        filename = item['file']
        if filename in seen or Path(filename).name != filename:
            raise ValueError('duplicate sample or nonlocal filename')
        seen.add(filename)
        data = (root / filename).read_bytes()
        if filename.endswith('.gz'):
            data = gzip.decompress(data)
        receipt = validate(json.loads(data), manifest)
        ax = receipt['result']['accessibility']
        current = {k: ax[k] for k in ('region', 'viewport', 'scope')}
        if geometry is not None and current != geometry:
            raise ValueError('capture geometry or scope changed')
        geometry = current
        modes.setdefault(item['detail'], []).append(receipt)
    if not modes or any(len(samples) < 3 for samples in modes.values()):
        raise ValueError('at least three independent samples per mode required')
    report = {'source_sha': manifest['source_sha'], 'geometry': geometry, 'modes': {}}
    for mode, samples in modes.items():
        timings = [s['result']['accessibility']['timings'] for s in samples]
        resources = [r for s in samples for r in s.get('resource_samples', [])]
        report['modes'][mode] = {
            'samples': len(samples),
            'native_elapsed_median_ms': median(s['elapsed_ms'] for s in samples),
            'timing_medians': {k: median(t.get(k, 0) for t in timings) for k in ('discovery_ms', 'child_navigation_ms', 'materialization_ms', 'pattern_ms', 'invoke_cache_hits', 'invoke_live_fallbacks')},
            'returned_range': [min(s['result']['accessibility']['returned'] for s in samples), max(s['result']['accessibility']['returned'] for s in samples)],
            'partial_samples': sum(s['result']['accessibility']['truncated'] is True for s in samples),
            'time_limit_samples': sum('time_limit' in s['result']['accessibility']['truncation_reasons'] for s in samples),
            'native_peak_working_set_bytes': max((r.get('native_rss_bytes', 0) for r in resources), default=None),
            'edge_peak_working_set_bytes': max((r.get('edge_rss_bytes', 0) for r in resources), default=None),
        }
    report['all_required_anchors_observed'] = True
    report['expected_input_coverage'] = {}
    all_samples = [sample for samples in modes.values() for sample in samples]
    for expected in manifest.get('expected_inputs', []):
        observed = sum(any(n.get('role') == 'edit' and n.get('label') == expected['label'] and n.get('value') == expected['value'] for n in s['result']['accessibility']['nodes']) for s in all_samples)
        report['expected_input_coverage'][expected['label']] = {'observed_samples': observed, 'total_samples': len(all_samples)}
    report['required_input_coverage_passed'] = all(c['observed_samples'] == c['total_samples'] for c in report['expected_input_coverage'].values())
    report['complete_tree_accepted'] = all(m['partial_samples'] == 0 for m in report['modes'].values())
    report['causal_speedup_claim'] = False
    report['memory_scope'] = 'Process working-set sums, not PSS or installed XHarness memory.'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    args = parser.parse_args()
    before, after = grade(args.baseline), grade(args.candidate)
    if before['geometry'] != after['geometry'] or before['modes'].keys() != after['modes'].keys():
        raise ValueError('before/after geometry or modes differ')
    print(json.dumps({'baseline': before, 'candidate': after, 'comparison': 'Descriptive same-page samples; partial trees and varying node counts do not establish a causal speedup.'}, indent=2))


if __name__ == '__main__':
    main()
