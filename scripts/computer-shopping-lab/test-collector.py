import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

class CollectorTests(unittest.TestCase):
    def test_concurrent_reads_idle_preconnect_and_input_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            child=subprocess.Popen([sys.executable,str(Path(__file__).with_name('collector.py')),'--root',directory,'--port','0'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
            idle=None
            try:
                info=json.loads(child.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
                http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                idle=socket.create_connection(('127.0.0.1',info['port']),timeout=2)
                def post(path, value):
                    request=urllib.request.Request(base+path,data=json.dumps(value).encode(),headers={'Content-Type':'application/json'})
                    return http.open(request,timeout=3).read()
                self.assertEqual(post('/browser-job',{'id':0,'request':{'action':'observe'}}),b'OK')
                with self.assertRaises(urllib.error.HTTPError) as error:post('/browser-job',{'id':True,'request':{}})
                self.assertEqual(error.exception.code,400)
                with self.assertRaises(urllib.error.HTTPError) as error:http.open(base+'/../secret',timeout=3)
                self.assertEqual(error.exception.code,404)
                post('/browser-result',{'id':0,'data':'x'*80000})
                errors=[]
                def read():
                    try:
                        for _ in range(30):
                            value=json.load(http.open(base+'/browser-latest',timeout=3));self.assertEqual(len(value['data']),80000)
                    except Exception as error:errors.append(str(error))
                readers=[threading.Thread(target=read) for _ in range(3)]
                for reader in readers:reader.start()
                for i in range(30):post('/browser-result',{'id':i,'data':'x'*80000})
                for reader in readers:reader.join(timeout=5);self.assertFalse(reader.is_alive())
                self.assertEqual(errors,[])
                import base64
                png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')
                def binary_post(path, data):
                    return http.open(urllib.request.Request(base+path, data=data, headers={'Content-Type':'image/png'}),timeout=3).read()
                self.assertEqual(binary_post('/browser-image/0.png', png), b'OK')
                self.assertEqual(http.open(base+'/browser-image/0.png',timeout=3).read(), png)
                for path in ('/browser-image/80.png','/browser-image/01.png','/browser-image/../secret.png','/browser-image/0.png?x=1'):
                    with self.assertRaises(urllib.error.HTTPError) as error:binary_post(path, png)
                    self.assertEqual(error.exception.code,404)
                with self.assertRaises(urllib.error.HTTPError) as error:binary_post('/browser-image/1.png', b'not png')
                self.assertEqual(error.exception.code,400)
                self.assertEqual(post('/browser-job',{'stop':True}),b'OK')
            finally:
                if idle:idle.close()
                child.terminate();child.wait(timeout=3);child.stdout.close()

if __name__=='__main__':unittest.main()
