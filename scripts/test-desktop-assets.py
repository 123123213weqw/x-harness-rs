#!/usr/bin/env python3
"""检查桌面图标配置，以及 macOS 安装包是否真正携带当前图标与更新脚本。"""
import argparse
import hashlib
import json
import plistlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(app=None):
    desktop = ROOT / 'apps/desktop/src-tauri'
    config = json.loads((desktop / 'tauri.conf.json').read_text())
    for name in config['bundle']['icon']:
        asset = desktop / name
        assert asset.is_file() and asset.stat().st_size > 0, f'missing icon: {asset}'
    assert (desktop / 'icons/icon.icns').read_bytes()[:4] == b'icns'
    assert (desktop / 'icons/icon.ico').read_bytes()[:4] == b'\x00\x00\x01\x00'
    assert (desktop / 'icons/128x128.png').read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
    assert (ROOT / 'ui/desktop/updater.js').read_bytes() == (ROOT / 'ui/dist/desktop-updater.js').read_bytes(), 'stale updater in ui/dist'
    if app:
        app = Path(app)
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        icon = info['CFBundleIconFile']
        if not icon.endswith('.icns'):
            icon += '.icns'
        installed = app / 'Contents/Resources' / icon
        assert digest(installed) == digest(desktop / 'icons/icon.icns'), f'packaged icon is stale: {installed}'
        assert info['CFBundleShortVersionString'] == config['version'], 'packaged version mismatch'
        assert (app / 'Contents/Resources/web/desktop-updater.js').read_bytes() == (ROOT / 'ui/desktop/updater.js').read_bytes(), 'packaged updater is stale'
        for binary in ['xharness-desktop', 'xharness-host', 'rg']:
            assert (app / 'Contents/MacOS' / binary).is_file(), f'missing executable: {binary}'
    print('desktop assets verified' + (f': {app}' if app else ''))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path)
    args = parser.parse_args()
    verify(args.app)
