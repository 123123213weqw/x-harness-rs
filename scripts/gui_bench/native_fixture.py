"""Two loopback origins: trusted production BrowserPane and unprivileged task.

No Playwright browser, simulated Tauri IPC, hidden completion driver or credential
is served. Fixture reports are held in evaluator memory, not exposed as an API.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit

REPO = Path(__file__).resolve().parents[2]
MAIN = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>Native WebView acceptance</title>
<style>:root{font-family:system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fafafa;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#888;--dsw-alias-border-l1:#eee;--dsw-alias-border-l2:#ddd}body{margin:0}#root{height:100vh}</style>
<div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load:x=>window.registration=x}</script><script src="/browser.js"></script><script>
const config=CONFIG;const plugin=registration.factory(id=>id==='react'?React:{});
plugin.apply({effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:()=>{}}});
function App(){const[item,setItem]=React.useState({id:'bench:browser',kind:'browser',entries:[config.target],position:0,title:'Acceptance'});
return React.createElement(plugin.BrowserPane,{item,sessionId:config.session,open:true,onUpdate:patch=>setItem(value=>({...value,...patch})),onClose:()=>{},onNewBrowser:()=>{}})}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
</script></html>'''


class Fixture:
    def __init__(self, assets, task, run, session):
        self.assets = Path(assets)
        self.task, self.run, self.session = task, run, session
        self.state, self.lock = {}, threading.Lock()
        self.servers, self.threads = [], []

    def start(self):
        parent = self
        class Guest(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                if urlsplit(self.path).path != '/':
                    self.send_error(404); return
                data = (REPO / 'scripts/gui_bench/fixtures/index.html').read_bytes()
                self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            def do_POST(self):
                url = urlsplit(self.path)
                size = int(self.headers.get('Content-Length', '0'))
                if url.path != '/report' or parse_qs(url.query).get('run') != [parent.run] or not 0 < size <= 64000:
                    self.send_error(400); return
                try:
                    state = json.loads(self.rfile.read(size))
                    if not isinstance(state, dict) or state.get('task') not in ('issue', 'pr', 'dynamic', 'game'):
                        raise ValueError('invalid fixture state')
                except (ValueError, UnicodeDecodeError):
                    self.send_error(400); return
                with parent.lock: parent.state = state
                self.send_response(200); self.end_headers()
                try: self.wfile.write(b'{}')
                except (BrokenPipeError, ConnectionResetError): pass
        guest = self._serve(Guest)
        self.target = ('https://github.com/123123213weqw/x-harness-rs/issues' if self.task == 'github'
                       else f'http://127.0.0.1:{guest.server_port}/?task={self.task}&run={self.run}')
        main = MAIN.replace('CONFIG', json.dumps({'target': self.target, 'session': self.session}))
        class Main(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                path = urlsplit(self.path).path
                if path == '/': data = main.encode(); kind = 'text/html'
                elif path in ('/react.js', '/react-dom.js'):
                    data = (parent.assets / path[1:]).read_bytes(); kind = 'text/javascript'
                elif path == '/browser.js':
                    data = (REPO / 'ui/plugins/@xlang/xharness-client-ui-browser/client.js').read_bytes(); kind = 'text/javascript'
                else: self.send_error(404); return
                self.send_response(200); self.send_header('Content-Type', kind + '; charset=utf-8')
                self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        server = self._serve(Main)
        self.main_url = f'http://127.0.0.1:{server.server_port}/'
        return self

    def _serve(self, handler):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.servers.append(server); self.threads.append(thread)
        return server

    def snapshot(self):
        with self.lock: return json.loads(json.dumps(self.state))

    def close(self):
        for server in self.servers: server.shutdown(); server.server_close()
        for thread in self.threads: thread.join(timeout=5)
