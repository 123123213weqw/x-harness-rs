#!/usr/bin/env python3
"""Mirror only the vetted public registry. Tokens never enter files or git URLs."""
import json, os, re, subprocess, tempfile, urllib.error, urllib.parse, urllib.request
from pathlib import Path
SOURCE = 'https://github.com/123123213weqw/xharness-plugin-registry.git'
TARGET = 'wangyue2006/xharness-plugin-registry'
MARKER = 'XHarness public plugin registry mirror (source: 123123213weqw/xharness-plugin-registry)'
class Absent(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None

def api(path, data=None):
    token = os.environ.get('GITEE_TOKEN')
    if not token: raise RuntimeError('GITEE_TOKEN is not configured')
    req = urllib.request.Request('https://gitee.com/api/v5'+path,
        data=urllib.parse.urlencode(data).encode() if data is not None else None,
        headers={'Authorization': 'token '+token, 'Accept': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            if int(response.headers.get('Content-Length', '0')) > 2*1024*1024:
                raise RuntimeError('Gitee response too large')
            body = response.read(2*1024*1024+1)
            if len(body) > 2*1024*1024: raise RuntimeError('Gitee response too large')
            return json.loads(body)
    except urllib.error.HTTPError as e:
        if e.code == 404: raise Absent() from None
        raise RuntimeError(f'Gitee API returned HTTP {e.code}') from None

def ensure_target(call=api):
    user = call('/user')
    if user.get('login') != TARGET.split('/')[0]:
        raise RuntimeError('Gitee token owner does not match the intended mirror owner')
    try: repo = call('/repos/'+TARGET)
    except Absent:
        repo = call('/user/repos', {'name': TARGET.split('/')[1], 'private':'false',
            'auto_init':'false', 'description':MARKER})
    if repo.get('private') is not False or repo.get('description') != MARKER:
        raise RuntimeError('Refusing to overwrite a private or unrelated Gitee repository')
    return repo

def sync(call=api, run=subprocess.run):
    ensure_target(call)
    # Credentials are requested only for this HTTPS Gitee push. The source is
    # public; no GitHub access token or private source checkout is needed.
    with tempfile.TemporaryDirectory(prefix='xh-public-registry-') as temp:
        root = Path(temp); repo = root/'registry'
        askpass = root/'askpass.py'
        askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint("oauth2" if "username" in sys.argv[1].lower() else os.environ["GITEE_TOKEN"])\n')
        askpass.chmod(0o700)
        env = dict(os.environ, GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT='0')
        def git(*args):
            return run(['git', '-c', 'credential.helper=', *args], env=env,
                check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
        git('clone', '--quiet', '--single-branch', '--branch', 'main', SOURCE, str(repo))
        # Validate the exact sources and SHA-256 before publishing to a mirror.
        run(['python3', str(repo/'scripts/test_registry.py')], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        source_sha = git('-C', str(repo), 'rev-parse', 'HEAD')
        target = 'https://gitee.com/'+TARGET+'.git'
        # Non-fast-forward is a real conflict, never force-overwrite other work.
        git('-C', str(repo), 'push', '--quiet', target, 'HEAD:refs/heads/main')
        remote = git('ls-remote', target, 'refs/heads/main').split()
        if not remote or remote[0] != source_sha:
            raise RuntimeError('Gitee main SHA differs after push')
        return source_sha

if __name__ == '__main__':
    try: print('Verified Gitee registry mirror at commit '+sync())
    except subprocess.CalledProcessError as e:
        # Suppress child stderr: credential helpers/remote errors might contain
        # sensitive details. The exit code is enough to mark this run failed.
        raise SystemExit(f'Registry validation or git operation failed (exit {e.returncode})')
