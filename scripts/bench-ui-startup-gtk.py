"""Isolated Linux WebKitGTK UI probe; no Tauri/Host/model/real data.

Serve original/optimized ui/dist and run this under xvfb-run for each localhost
fixture URL. Process PSS includes this Python/GTK wrapper and its WebKit tree,
not the desktop application's Rust host or native bootstrap page.
"""
import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit, parse_qs

import gi
gi.require_version('Gtk', '3.0')
try:
    gi.require_version('WebKit2', '4.1')
except ValueError:
    gi.require_version('WebKit2', '4.0')
from gi.repository import Gtk, WebKit2, GLib

SCRIPT = r"""
(() => {
  let facade;
  Object.defineProperty(window, '__ModuleLoader__', {configurable: true, get: () => facade, set: value => {
    const create = value.create;
    value.create = function(options) {window.benchPlatform = options.staticModules; return create.call(this, options)};
    facade = value;
  }});
  let committed = false;
  const observer = new MutationObserver(() => {
    const root = document.getElementById('root');
    if (committed || !root?.querySelector('textarea,[contenteditable="true"]') || root.querySelector('[data-dsh-boot]')) return;
    committed = true; observer.disconnect();
    const commitMs = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.webkit.messageHandlers.startupBench.postMessage(JSON.stringify({commitMs, frameMs: performance.now(), inputs: root.querySelectorAll('textarea,[contenteditable="true"]').length}));
    }));
  });
  observer.observe(document, {subtree: true, childList: true});
  addEventListener('error', e => window.webkit.messageHandlers.startupBench.postMessage(JSON.stringify({error: String(e.message)})));
  addEventListener('unhandledrejection', e => window.webkit.messageHandlers.startupBench.postMessage(JSON.stringify({error: String(e.reason)})));
  window.measureFirstCode = async () => {
    const R = benchPlatform.react, D = benchPlatform['react-dom'], P = benchPlatform['@xharness/dsh-client-ui-primitives'];
    const host = document.createElement('div'); document.body.append(host);
    const root = benchPlatform['react-dom/client'].createRoot(host), results = [];
    let active = true, lastFrame = performance.now(); const gaps = [];
    function tick(now) {gaps.push(now-lastFrame); lastFrame=now; if(active) requestAnimationFrame(tick)}
    requestAnimationFrame(tick);
    for (const [lang, code] of [['json', '{"answer":42}'], ['typescript', 'const answer: number = 42'], ['typescript', 'const again = 43']]) {
      const start = performance.now(), gapStart = gaps.length;
      D.flushSync(() => root.render(R.createElement(P.CodeBlock, {lang, code})));
      const initialMs = performance.now() - start;
      const immediateExact = host.querySelector('pre')?.textContent === code;
      const initialHeight = host.querySelector('pre')?.getBoundingClientRect().height;
      while (!host.querySelector('.shiki') && performance.now() - start < 10000) await new Promise(requestAnimationFrame);
      results.push({lang, initialMs, immediateExact, maxFrameGapMs: gaps.length > gapStart ? Math.max(...gaps.slice(gapStart)) : null, elapsedMs: performance.now() - start, stableHeight: initialHeight === host.querySelector('pre')?.getBoundingClientRect().height, exact: host.querySelector('pre')?.textContent === code, highlighted: Boolean(host.querySelector('.shiki'))});
    }
    active=false; root.unmount(); host.remove();
    window.webkit.messageHandlers.startupBench.postMessage(JSON.stringify({firstCode: results}));
  };
})();
"""


def memory():
    children = {os.getpid()}
    frontier = list(children)
    while frontier:
        pid = frontier.pop()
        try:
            for task in Path(f'/proc/{pid}/task').iterdir():
                for raw in (task / 'children').read_text().split():
                    child = int(raw)
                    if child not in children:
                        children.add(child); frontier.append(child)
        except (OSError, ValueError):
            pass
    pss = rss = 0
    names = []
    for pid in children:
        try:
            info = Path(f'/proc/{pid}/smaps_rollup').read_text()
            values = {line.split()[0]: int(line.split()[1]) for line in info.splitlines() if line.startswith(('Pss:', 'Rss:'))}
            pss += values['Pss:']; rss += values['Rss:']
            names.append(Path(f'/proc/{pid}/comm').read_text().strip())
        except (OSError, ValueError, KeyError):
            pass
    return dict(pssMiB=pss / 1024, rssMiB=rss / 1024, processes=sorted(names))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--session', choices=['fx-alpha'])
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or 'fixture' not in parse_qs(url.query):
        parser.error('probe accepts only an explicit localhost fixture, not a live Host')
    receipt = dict(scope='WebKitGTK ephemeral window/full generated UI/fixture; NOT Tauri or real history',
                   webkitVersion=f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}',
                   startup=None, samples=[], errors=[], ready=False)
    started = time.monotonic()
    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler('startupBench')

    def message(_manager, result):
        value = json.loads(result.get_js_value().to_string())
        if 'error' in value:
            receipt['errors'].append(value['error'])
        elif 'firstCode' in value:
            receipt['firstCode'] = value['firstCode']
            if not all(row['immediateExact'] and row['exact'] and row['highlighted'] and row['stableHeight'] for row in value['firstCode']):
                receipt['errors'].append('first code highlighting changed content')
            finish()
        else:
            receipt['startup'] = value
            receipt['firstFrameObservedMs'] = (time.monotonic()-started)*1000
            receipt['ready'] = True
            GLib.timeout_add(1800, first_code)

    def first_code():
        receipt['startupPeakPssMiB'] = max((row['pssMiB'] for row in receipt['samples']), default=None)
        view.run_javascript('window.measureFirstCode()', None, None, None)
        return False

    def finish():
        if Gtk.main_level() > 0:
            Gtk.main_quit()
        return False

    manager.connect('script-message-received::startupBench', message)
    script = (f"localStorage.setItem('dsh.sessions.current', JSON.stringify({{sessionId: {json.dumps(args.session)}}}));\n"
              if args.session else '') + SCRIPT
    manager.add_script(WebKit2.UserScript.new(script, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                                              WebKit2.UserScriptInjectionTime.START, None, None))
    context = WebKit2.WebContext.new_ephemeral()
    # Same cache model as the owned Linux desktop; never keeps a spare renderer.
    context.set_cache_model(WebKit2.CacheModel.DOCUMENT_BROWSER)
    view = WebKit2.WebView(web_context=context, user_content_manager=manager)
    view.connect('web-process-terminated', lambda _view, reason: (receipt['errors'].append(f'web process terminated: {reason}'), finish()))
    window = Gtk.Window(); window.set_default_size(1280, 820); window.add(view)
    window.connect('destroy', lambda _window: finish())

    def sample():
        receipt['samples'].append(dict(atMs=(time.monotonic()-started)*1000, **memory()))
        return True

    GLib.timeout_add(50, sample)
    GLib.timeout_add_seconds(60, finish)
    window.show_all(); view.load_uri(args.url); Gtk.main()
    window.destroy()
    receipt['peakPssMiB'] = max((row['pssMiB'] for row in receipt['samples']), default=None)
    receipt['peakRssMiB'] = max((row['rssMiB'] for row in receipt['samples']), default=None)
    receipt['beforeFramePeakPssMiB'] = max((row['pssMiB'] for row in receipt['samples']
        if row['atMs'] <= receipt.get('firstFrameObservedMs', 0)), default=None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'samples'}))
    return 0 if receipt['ready'] and len(receipt.get('firstCode', [])) == 3 and not receipt['errors'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
