"""Extension of bounded lab collector, not a production bridge."""
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
source=Path(__file__).with_name('collector.py').read_text()
source=source.replace("server=ThreadingHTTPServer(('127.0.0.1', args.port), Handler)",'''files['/expanded.html']=('expanded.html','text/html; charset=utf-8')
base_get=Handler.do_GET
def expanded_get(self):
    url=urlsplit(self.path)
    if url.path=='/expanded.html':
        q=parse_qs(url.query)
        if set(q)!={'case'} or len(q['case'])!=1 or q['case'][0] not in ('filter','scroll-detail','modal','slow-layout'):
            return self.send(b'Invalid scenario',status=400)
        self.path=url.path
    return base_get(self)
Handler.do_GET=expanded_get
server=ThreadingHTTPServer(('127.0.0.1', args.port), Handler)''')
exec(compile(source,str(Path(__file__).with_name('collector.py')),'exec'))
