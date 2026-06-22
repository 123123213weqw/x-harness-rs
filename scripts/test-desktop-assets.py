#!/usr/bin/env python3
"""检查桌面图标配置，以及 macOS 安装包是否真正携带当前图标与更新脚本。"""
import argparse
import hashlib
import json
import plistlib
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELECTED_ICON_SHA256 = '7d89974b3f7b9c784e3004fbf1a914219e1a58cbaf07c240fc042acd6afc0e1a'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(app=None):
    desktop = ROOT / 'apps/desktop/src-tauri'
    master = ROOT / 'assets/brand/xharness-app-icon.png'
    assert digest(master) == SELECTED_ICON_SHA256, 'selected first icon master was modified or replaced'
    assert master.read_bytes()[16:24] == (1254).to_bytes(4, 'big') * 2, 'unexpected icon master dimensions'
    assert (ROOT / 'ui/overrides/favicon.png').read_bytes() == (ROOT / 'ui/dist/favicon.png').read_bytes(), 'web favicon export is stale'
    assert (ROOT / 'ui/overrides/app-icon-512.png').read_bytes() == (ROOT / 'ui/dist/app-icon-512.png').read_bytes(), 'web app icon export is stale'
    assert 'href="/favicon.png"' in (ROOT / 'ui/dist/index.html').read_text(), 'web shell does not load selected icon'
    web_manifest = json.loads((ROOT / 'ui/dist/manifest.webmanifest').read_text())
    assert web_manifest['icons'] == [{'src': '/app-icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'}], 'web manifest icon is stale'
    config = json.loads((desktop / 'tauri.conf.json').read_text())
    for name in config['bundle']['icon']:
        asset = desktop / name
        assert asset.is_file() and asset.stat().st_size > 0, f'missing icon: {asset}'
    assert (desktop / 'icons/icon.icns').read_bytes()[:4] == b'icns'
    assert (desktop / 'icons/icon.ico').read_bytes()[:4] == b'\x00\x00\x01\x00'
    for name in ('32x32.png', '128x128.png', '128x128@2x.png'):
        png = (desktop / 'icons' / name).read_bytes()
        assert png[:8] == b'\x89PNG\r\n\x1a\n', f'invalid PNG: {name}'
        assert png[25] == 6, f'Tauri requires RGBA PNG, got color type {png[25]}: {name}'
    assert (ROOT / 'ui/desktop/updater.js').read_bytes() == (ROOT / 'ui/dist/desktop-updater.js').read_bytes(), 'stale updater in ui/dist'
    assert (ROOT / 'ui/desktop/startup.js').read_bytes() == (ROOT / 'ui/dist/desktop-startup.js').read_bytes(), 'stale startup instrumentation in ui/dist'
    directory_plugin = 'plugins/@xlang/xharness-client-ui-directory/client.js'
    computer_plugin = 'plugins/@xlang/xharness-client-ui-computer/client.js'
    assert (ROOT / 'ui' / directory_plugin).read_bytes() == (ROOT / 'ui/dist' / directory_plugin).read_bytes(), 'stale directory flow in ui/dist'
    assert (ROOT / 'ui' / computer_plugin).read_bytes() == (ROOT / 'ui/dist' / computer_plugin).read_bytes(), 'stale computer privacy UI in ui/dist'
    graph = json.loads((ROOT / 'ui/dist/client-graph.json').read_text(encoding='utf-8'))
    assert any(entry['id'] == '@xlang/xharness-client-ui-directory' for entry in graph['entries']), 'missing directory flow in boot graph'
    assert any(entry['id'] == '@xlang/xharness-client-ui-computer' for entry in graph['entries']), 'missing computer privacy UI in boot graph'
    manifest = (desktop / 'build.rs').read_text(encoding='utf-8')
    capability = json.loads((desktop / 'capabilities/desktop-main.json').read_text(encoding='utf-8'))
    assert 'desktop_set_computer_activity' in manifest, 'native computer activity command missing from desktop manifest'
    assert 'allow-desktop-set-computer-activity' in capability['permissions'], 'native computer activity bridge is not authorized'
    native_activity = (desktop / 'src/computer_activity.rs').read_text(encoding='utf-8')
    assert 'NSPanel' in native_activity and 'NSWindowSharingType::None' in native_activity, 'macOS privacy overlay is missing or capturable'
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
        assert (app / 'Contents/Resources/web/desktop-startup.js').read_bytes() == (ROOT / 'ui/desktop/startup.js').read_bytes(), 'packaged startup instrumentation is stale'
        web = app / 'Contents/Resources/web'
        for relative in ['index.html', 'client-graph.json', 'favicon.png', 'app-icon-512.png', 'manifest.webmanifest',
                         directory_plugin,
                         computer_plugin,
                         'plugins/@xharness/dsh-client-connection/client.js',
                         'plugins/@xharness/dsh-client-ui-model-selection/client.js']:
            assert digest(web / relative) == digest(ROOT / 'ui/dist' / relative), f'packaged UI is stale: {relative}'

        # Execute the final signed sidecar, not the CI machine's PATH rg.
        rg = app.resolve() / 'Contents/MacOS/rg'
        env = {'PATH': '/usr/bin:/bin', 'HOME': tempfile.gettempdir()}
        dependencies = subprocess.check_output(['otool', '-L', str(rg)], text=True).splitlines()[1:]
        assert all(line.strip().startswith(('/usr/lib/', '/System/Library/')) for line in dependencies), 'rg has external dylibs'
        subprocess.run([str(rg), '--version'], check=True, env=env, capture_output=True)
        with tempfile.TemporaryDirectory(prefix='xh-signed-rg-') as tmp:
            Path(tmp, 'sample.txt').write_text('signed-sidecar-fixture\n')
            for args, code in [(['--files', '-g', '*.txt'], 0), (['signed-sidecar-fixture', '.'], 0), (['no-such-content', '.'], 1)]:
                result = subprocess.run([str(rg), *args], cwd=tmp, env=env, capture_output=True)
                assert result.returncode == code, (args, result.returncode, result.stderr)

        for binary in ['xharness-desktop', 'xharness-host', 'rg']:
            assert (app / 'Contents/MacOS' / binary).is_file(), f'missing executable: {binary}'
    print('desktop assets verified' + (f': {app}' if app else ''))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path)
    args = parser.parse_args()
    verify(args.app)
