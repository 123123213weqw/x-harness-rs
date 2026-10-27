"""Verify real native-fit screenshots, not just the probe's success boolean."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.gui_bench.native_png import pixel


def verify(log: str, images: Path) -> dict:
    prefix = 'FIT_VIEWPORT_EVIDENCE '
    rows = [json.loads(line[len(prefix):]) for line in log.splitlines() if line.startswith(prefix)]
    if len(rows) != 1 or rows[0].get('passed') is not True:
        raise ValueError('missing unique successful fit receipt')
    result = rows[0]
    cases = result.get('cases')
    if not isinstance(cases, list) or len(cases) != 3 or result.get('responsive_restored') is not True:
        raise ValueError('incomplete fit matrix')
    for index, case in enumerate(cases):
        if case.get('index') != index or case.get('trusted_corners') is not True or case.get('modal_checkbox') is not True or case.get('stale_frame') != 'denied':
            raise ValueError('missing native input/epoch acceptance')
        if case.get('pane') != [[426,500], [640,400], [360,500]][index]:
            raise ValueError('missing required narrow-pane cases')
        preview = case['preview']
        if not (0 < preview['width'] <= case['pane'][0] + 2 and 0 < preview['height'] <= case['pane'][1] + 2):
            raise ValueError('native preview overflows the pane')
        viewport = case['viewport']
        w, h = viewport['width'], viewport['height']
        if abs(w - 1280) >= 8 or abs(h - 720) >= 8:
            raise ValueError('responsive layout was falsely labelled fixed')
        png = (images / f'fit-{index}.png').read_bytes()
        _, size = pixel(png, 0, 0)
        if tuple(size) != (case['image']['width'], case['image']['height']):
            raise ValueError('image geometry does not match actual PNG')
        markers = case['markers']
        if len(markers) != 4:
            raise ValueError('missing four corner markers')
        for point, expected in zip(markers, [(255,0,0), (0,255,0), (0,0,255), (255,255,0)]):
            # CSS/image scale, not an assumed DPR or the sidebar zoom factor.
            rgb, _ = pixel(png, round(point['x'] * size[0] / w), round(point['y'] * size[1] / h))
            if tuple(rgb) != expected:
                raise ValueError(f'cropped or incorrectly mapped native image: {index} {point} {rgb}')
        case['four_corner_pixels_verified'] = True
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('log', type=Path)
    parser.add_argument('images', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.log.read_text(), args.images), ensure_ascii=False, indent=2))
