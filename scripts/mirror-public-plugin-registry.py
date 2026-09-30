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

def safe_api_reason(body, token):
    # Only structured validation messages, never raw HTML, headers or requests.
    try: value = json.loads(body)
    except (ValueError, UnicodeError): return ''
    if not isinstance(value, dict): return ''
    fields = {key: value[key] for key in ('message', 'error', 'errors') if key in value}
    if not fields: return ''
    text = json.dumps(fields, ensure_ascii=False).replace(token, '[redacted]')
    text = re.sub(r'(?:https?://)[^\s"<>]+', '[url]', text)
    text = re.sub(r'(?i)(access_token|password|authorization)(\s*[=:]\s*)[^,;\s"}]+', r'\1\2[redacted]', text)
    return text[:512]

def api(path, data=None, method=None):
    token = os.environ.get('GITEE_TOKEN')
    if not token: raise RuntimeError('GITEE_TOKEN is not configured')
    req = urllib.request.Request('https://gitee.com/api/v5'+path,
        data=urllib.parse.urlencode(data).encode() if data is not None else None,
        headers={'Authorization': 'token '+token, 'Accept': 'application/json'}, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            if int(response.headers.get('Content-Length', '0')) > 2*1024*1024:
                raise RuntimeError('Gitee response too large')
            body = response.read(2*1024*1024+1)
            if len(body) > 2*1024*1024: raise RuntimeError('Gitee response too large')
            return json.loads(body)
    except urllib.error.HTTPError as e:
        if e.code == 404: raise Absent() from None
        reason = safe_api_reason(e.read(4096), token)
        raise RuntimeError(f'Gitee API returned HTTP {e.code}' + (': '+reason if reason else '')) from None

def ensure_target(call=api, public_commits=frozenset()):
    user = call('/user')
    if user.get('login') != TARGET.split('/')[0]:
        raise RuntimeError('Gitee token owner does not match the intended mirror owner')
    try: repo = call('/repos/'+TARGET)
    except Absent:
        # Gitee only supports private creation and rejects making empty repos
        # public. Initialize exclusively from the already-public vetted source.
        repo = call('/user/repos', {'name': TARGET.split('/')[1], 'private':'true',
            'auto_init':'false', 'description':MARKER})
    if repo.get('description') != MARKER or not isinstance(repo.get('private'), bool):
        raise RuntimeError('Refusing to overwrite an unrelated or unclassified Gitee repository')
    if repo['private']:
        branches = call('/repos/'+TARGET+'/branches')
        if not isinstance(branches, list):
            raise RuntimeError('Invalid Gitee branch metadata')
        # An interrupted first publication is resumable only when the sole main
        # branch is a commit from the exact public source history. Never expose
        # unrelated private content or additional branches.
        if branches and (len(branches) != 1 or branches[0].get('name') != 'main'
                or branches[0].get('commit', {}).get('sha') not in public_commits):
            raise RuntimeError('Refusing to expose a private repository with unrelated branches')
        tags = call('/repos/'+TARGET+'/tags')
        if tags != []:
            raise RuntimeError('Refusing to expose a private repository with tags')
    return repo

def promote_target(call=api):
    repo = call('/repos/'+TARGET, {'name': TARGET.split('/')[1],
        'private':'false', 'default_branch':'main'}, method='PATCH')
    if repo.get('private') is not False or repo.get('description') != MARKER:
        raise RuntimeError('Gitee public visibility has not been confirmed')
    return repo

def verify_anonymous(repo):
    # Successful authenticated git push is not evidence of public downloads.
    opener = urllib.request.build_opener(NoRedirect)
    catalog = json.loads((repo/'catalog.json').read_text())
    paths = ['catalog.json'] + ['packages/'+p['name']+'/'+p['version']+'/plugin.zip'
                               for p in catalog['plugins']]
    import base64
    for path in paths:
        expected = (repo/path).read_bytes()
        if len(expected) > 64*1024*1024: raise RuntimeError('Plugin exceeds package budget')
        wire_limit = ((len(expected)+2)//3)*4+8192
        req = urllib.request.Request('https://gitee.com/api/v5/repos/'+TARGET+'/contents/'+path)
        with opener.open(req, timeout=30) as response:
            body = response.read(wire_limit+1)
        if len(body) > wire_limit: raise RuntimeError('Gitee verification response too large')
        envelope = json.loads(body)
        if envelope.get('type') != 'file' or envelope.get('encoding') != 'base64':
            raise RuntimeError('Gitee anonymous download is not a file')
        data = base64.b64decode(''.join(envelope['content'].split()), validate=True)
        if data != expected or envelope.get('size') != len(data):
            raise RuntimeError('Gitee anonymous download differs from the vetted public source')

def sync(call=api, run=subprocess.run):
    # Credentials are requested only for this HTTPS Gitee push. The source is
    # public; no GitHub access token or private source checkout is needed.
    with tempfile.TemporaryDirectory(prefix='xh-public-registry-') as temp:
        root = Path(temp); repo = root/'registry'
        askpass = root/'askpass.py'
        askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint("wangyue2006" if "username" in sys.argv[1].lower() else os.environ["GITEE_TOKEN"])\n')
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
        public_commits = frozenset(git('-C', str(repo), 'rev-list', 'HEAD').splitlines())
        metadata = ensure_target(call, public_commits)
        target = 'https://gitee.com/'+TARGET+'.git'
        # Non-fast-forward is a real conflict, never force-overwrite other work.
        git('-C', str(repo), 'push', '--quiet', target, 'HEAD:refs/heads/main')
        remote = git('ls-remote', target, 'refs/heads/main').split()
        if not remote or remote[0] != source_sha:
            raise RuntimeError('Gitee main SHA differs after push')
        if metadata['private'] or metadata.get('default_branch') != 'main':
            promote_target(call)
        verify_anonymous(repo)
        return source_sha

if __name__ == '__main__':
    try: print('Verified Gitee registry mirror at commit '+sync())
    except subprocess.CalledProcessError as e:
        # Suppress child stderr: credential helpers/remote errors might contain
        # sensitive details. The exit code is enough to mark this run failed.
        raise SystemExit(f'Registry validation or git operation failed (exit {e.returncode})')
