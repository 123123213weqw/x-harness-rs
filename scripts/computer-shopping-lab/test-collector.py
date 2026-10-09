import json
import importlib.util
from http.server import ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

class CollectorTests(unittest.TestCase):
    def test_all_published_reads_are_locked_but_socket_responses_are_not(self):
        spec = importlib.util.spec_from_file_location(
            'shopping_collector_reads', Path(__file__).with_name('collector.py'))
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        with tempfile.TemporaryDirectory() as directory:
            collector.root = Path(directory)
            original_read = Path.read_bytes

            def locked_read(path):
                self.assertTrue(collector.lock.locked(), 'file read must own publication lock')
                return original_read(path)

            def send(data, content_type='text/plain', status=200):
                self.assertFalse(collector.lock.locked(), 'socket response must not block publication')
                replies.append((data, status))

            routes = {path: filename for path, (filename, _) in collector.files.items()}
            routes['/browser-image/0.png'] = 'browser-image-0.png'
            handler = object.__new__(collector.Handler)
            handler.send = send
            for route, filename in routes.items():
                with self.subTest(route=route):
                    payload = b'published snapshot'
                    (collector.root / filename).write_bytes(payload)
                    replies = []
                    handler.path = route
                    with patch.object(Path, 'read_bytes', locked_read):
                        handler.do_GET()
                    self.assertEqual(replies, [(payload, 200)])
                    (collector.root / filename).unlink()
                    replies = []
                    with patch.object(Path, 'read_bytes', locked_read):
                        handler.do_GET()
                    expected = (b'{}', 200) if route in ('/browser-next', '/browser-latest') else (b'Not prepared', 404)
                    self.assertEqual(replies, [expected])

    def test_windows_read_handle_cannot_race_atomic_replacement(self):
        """Deterministically simulate Windows' deny-delete open read handle."""
        spec = importlib.util.spec_from_file_location(
            'shopping_collector', Path(__file__).with_name('collector.py'))
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        reading = threading.Event()
        release_read = threading.Event()
        publication_waiting = threading.Event()
        writer_done = threading.Event()
        errors = []

        class ObservedLock:
            def __init__(self):
                self.lock = threading.Lock()

            def __enter__(self):
                if reading.is_set():
                    publication_waiting.set()
                self.lock.acquire()

            def __exit__(self, *unused):
                self.lock.release()

        with tempfile.TemporaryDirectory() as directory:
            collector.root = Path(directory)
            collector.lock = ObservedLock()
            latest = collector.root / 'browser-latest.json'
            latest.write_text(json.dumps({'id': 0, 'data': 'old'}))
            original_read = Path.read_bytes
            original_replace = Path.replace

            def held_read(path):
                if path != latest:
                    return original_read(path)
                try:
                    with path.open('rb') as stream:
                        reading.set()
                        if not release_read.wait(5):
                            raise TimeoutError('test read was not released')
                        return stream.read()
                finally:
                    reading.clear()

            def deny_open_handle_replace(path, target):
                if Path(target) == latest and reading.is_set():
                    raise PermissionError('simulated Windows sharing violation')
                return original_replace(path, target)

            server = ThreadingHTTPServer(('127.0.0.1', 0), collector.Handler)
            server_thread = threading.Thread(target=server.serve_forever)
            server_thread.start()
            base = f'http://127.0.0.1:{server.server_port}'

            def read():
                try:
                    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with http.open(base + '/browser-latest', timeout=5) as response:
                        self.assertEqual(json.load(response), {'id': 0, 'data': 'old'})
                except Exception as error:
                    errors.append(error)

            def write():
                try:
                    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    request = urllib.request.Request(base + '/browser-result',
                        data=json.dumps({'id': 1, 'data': 'new'}).encode())
                    with http.open(request, timeout=5) as response:
                        self.assertEqual(response.read(), b'OK')
                except Exception as error:
                    errors.append(error)
                finally:
                    writer_done.set()

            reader = threading.Thread(target=read)
            writer = threading.Thread(target=write)
            try:
                with patch.object(Path, 'read_bytes', held_read), \
                        patch.object(Path, 'replace', deny_open_handle_replace):
                    reader.start()
                    self.assertTrue(reading.wait(3), 'GET did not open the file')
                    writer.start()
                    self.assertTrue(publication_waiting.wait(3), 'POST did not reach publication')
                    self.assertFalse(writer_done.wait(0.1), 'writer raced the open read handle')
                    release_read.set()
                    reader.join(5)
                    writer.join(5)
                    self.assertFalse(reader.is_alive())
                    self.assertFalse(writer.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(json.loads(latest.read_text())['data'], 'new')
            finally:
                release_read.set()
                if reader.ident is not None:
                    reader.join(5)
                if writer.ident is not None:
                    writer.join(5)
                server.shutdown()
                server.server_close()
                server_thread.join(5)

    def test_concurrent_reads_idle_preconnect_and_input_limits(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile(mode='w+') as diagnostics:
            child=subprocess.Popen([sys.executable,str(Path(__file__).with_name('collector.py')),'--root',directory,'--port','0'],stdout=subprocess.PIPE,stderr=diagnostics,text=True)
            idle=None
            try:
                info=json.loads(child.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
                http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                idle=socket.create_connection(('127.0.0.1',info['port']),timeout=2)
                def post(path, value):
                    request=urllib.request.Request(base+path,data=json.dumps(value).encode(),headers={'Content-Type':'application/json'})
                    with http.open(request,timeout=3) as response:
                        return response.read()
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
                            with http.open(base+'/browser-latest',timeout=3) as response:
                                value=json.load(response)
                            self.assertEqual(len(value['data']),80000)
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
                diagnostics.seek(0)
                self.assertNotIn('Traceback', diagnostics.read(), 'collector server failed; see captured traceback')

if __name__=='__main__':unittest.main()
