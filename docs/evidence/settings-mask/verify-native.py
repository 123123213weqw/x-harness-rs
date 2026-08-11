"""Validate the committed isolated WKWebView A/B geometry checkpoints."""
import json
from pathlib import Path

base = Path(__file__).parent
expected = ['General', 'Profile', 'Archived chats', 'General', 'Profile',
            'Profile-native-zoom', 'larger', 'smaller', 'animated-larger',
            'animated-smaller', 'reopened']
for mode in ['before', 'after']:
    lines = base.joinpath(f'native-{mode}.log').read_text().splitlines()
    assert [line.split(' native ', 1)[0] for line in lines] == expected
    rows = []
    for line in lines:
        assert line.endswith('error none'), line
        row = json.loads(line.split(' js ', 1)[1].split(' error ', 1)[0])
        rows.append(row)
        if mode == 'after':
            for part in ['dialog', 'mask']:
                assert row[part]['x'] == 0 and row[part]['y'] == 0
                assert row[part]['width'] == row['viewport']['width']
                assert row[part]['height'] == row['viewport']['height']
            assert abs(row['panel']['x'] + row['panel']['width'] / 2 - row['viewport']['width'] / 2) < 1
            assert abs(row['panel']['y'] + row['panel']['height'] / 2 - row['viewport']['height'] / 2) < 1
    if mode == 'before':
        assert rows[1]['mask']['width'] == 1040 < 1280
        assert rows[2]['mask']['width'] == 1180 < 1280
print('Native A/B geometry verified: old Profile/Archive coverage failures; 11 fixed coverage/centering checkpoints passed')
