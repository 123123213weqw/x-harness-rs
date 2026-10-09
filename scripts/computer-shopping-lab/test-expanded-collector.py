"""Exercise only the local test bridge; no VM or provider required."""
import unittest,tempfile,subprocess,sys,socket,time,urllib.request,urllib.error
from pathlib import Path
class TestRouting(unittest.TestCase):
 def test_generator_contract(self):
  with tempfile.TemporaryDirectory() as d:
   subprocess.run([sys.executable,str(Path(__file__).with_name('create-expanded-shop.py')),'--output',d],check=True,stdout=subprocess.DEVNULL)
   html=(Path(d)/'expanded.html').read_text()
   for text in ['scenario=new URLSearchParams','seq:++seq','visible:showing.map','initializeScenario();render();',"event('layout_shift'","event('navigate_detail'","event('return_products'","event('dismiss_modal'"]:
    self.assertIn(text,html)
 def test_explicit_scenarios_only(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'expanded.html').write_text('fixture');(root/'secret').write_text('not published')
   with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
   p=subprocess.Popen([sys.executable,str(Path(__file__).with_name('expanded-collector.py')),'--root',d,'--port',str(port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=f'http://127.0.0.1:{port}'
   def get(path):
    try:
     with opener.open(base+path,timeout=2) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
   try:
    for _ in range(50):
     try:get('/browser-latest');break
     except OSError:time.sleep(.05)
    else:raise RuntimeError('Collector failed to start')
    for case in ['filter','scroll-detail','modal','slow-layout']:
     self.assertEqual(get('/expanded.html?case='+case),(200,b'fixture'))
    for path in ['/expanded.html','/expanded.html?case=other','/expanded.html?case=filter&case=modal','/expanded.html?case=filter&file=secret']:
     self.assertEqual(get(path)[0],400)
    for path in ['/secret','/../secret','/expanded.html/secret']:self.assertEqual(get(path)[0],404)
   finally:p.terminate();p.wait(timeout=5)
unittest.main()
