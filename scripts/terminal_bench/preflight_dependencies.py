"""Exercise public dependency HTTPS from a network-disabled Docker container."""
from pathlib import Path
import subprocess
import tempfile
import uuid
from dependency_proxy import DependencyProxy


def main():
    name = 'xhbench-dependency-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='xhbench-dependency-') as directory:
        proxy = DependencyProxy(Path(directory) / 'deps.sock', seconds=90)
        script = """import sys,urllib.request,http.client,urllib.parse
sys.path.insert(0,'/opt/bench')
from relay import Relay
r=Relay('/proxy/deps.sock')
try:
 p=r.url.removesuffix('/v1')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':p,'https':p}))
 for url in ('https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/pytest/','http://deb.debian.org/debian/dists/bookworm/InRelease'):
  with opener.open(url,timeout=20) as response:
   assert response.status==200
   body=response.read()
   if url.endswith('/InRelease'):
    assert body.startswith(b'-----BEGIN PGP SIGNED MESSAGE-----'), repr(body[:80])
    assert b'-----END PGP SIGNATURE-----' in body, len(body)
   print('PASS '+url,flush=True)
 # Do not let urllib's localhost proxy-bypass fake a successful denial test.
 c=http.client.HTTPConnection('127.0.0.1',urllib.parse.urlsplit(p).port,timeout=5)
 c.set_tunnel('127.0.0.1',443)
 try: c.connect(); raise AssertionError('private access allowed')
 except OSError as error:
  assert '403' in str(error), type(error).__name__
  print('PASS private destination denied by proxy',flush=True)
 finally: c.close()
finally: r.stop()
"""
        try:
            subprocess.run(['docker', 'run', '--rm', '--name', name, '--network', 'none',
                            '--mount', f'type=bind,src={directory},dst=/proxy,readonly',
                            '--mount', f"type=bind,src={Path(__file__).with_name('relay.py').resolve()},dst=/opt/bench/relay.py,readonly",
                            'alexgshaw/cancel-async-tasks:20251031', 'python3', '-c', script],
                           check=True, timeout=60)
            print('dependency proxy preflight passed; zero model calls')
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
            proxy.stop()


if __name__ == '__main__':
    main()
