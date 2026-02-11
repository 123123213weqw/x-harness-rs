#!/usr/bin/env python3
"""仅在 Linux 远程机器执行：隔离 AppImage 更新演练，不发布、不改系统安装。
正式 Rust/更新器不改动；在临时源码中注入自动驾驶入口，复用生产 IPC handler。
"""
import base64, hashlib, io, http.server, json, os, pathlib, shutil, ssl, shlex, subprocess, sys, tarfile, threading, time, urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
def run(args, **kwargs):
    print('+', ' '.join(map(str,args)), flush=True)
    return subprocess.run(list(map(str,args)),check=True,**kwargs)
def start_server(root, port=0):
    if not (root/'server.pem').exists():
        (root/'server.ext').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
        run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',root/'server.key','-out',root/'server.csr','-subj','/CN=localhost'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['openssl','x509','-req','-in',root/'server.csr','-CA',root/'ca.pem','-CAkey',root/'tls.key','-CAcreateserial','-out',root/'server.pem','-days','1','-extfile',root/'server.ext'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            with (root/'http-requests.jsonl').open('a') as log:log.write(json.dumps({'path':self.path})+'\n')
            mode=(root/'mode').read_text() if (root/'mode').exists() else 'normal'
            if self.path=='/latest.json':
                time.sleep(.15)
                if mode=='unavailable':self.send_error(503);return
                body=(root/'latest.json').read_bytes()
            elif self.path=='/update.AppImage':
                body=(root/'update.AppImage').read_bytes()
                if mode=='tampered':body=body[:-1]+bytes([body[-1]^1])
            else:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(root/'server.pem',root/'server.key');server.socket=ctx.wrap_socket(server.socket,server_side=True)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server

def run_app(root,env,server):
    # AppRun injects PYTHONHOME/PYTHONPATH for its own bundle. Our test-only
    # RPC helper uses system Python, so explicitly isolate it from those values.
    python=root/'safe-bin/python3'
    if python.is_symlink():
        real=python.resolve();python.unlink()
        python.write_text('#!/bin/sh\nexec '+shlex.quote(str(real))+' -E "$@"\n');python.chmod(0o755)
    events_file=root/'events.jsonl'
    if events_file.exists():events_file.rename(root/('events.previous-'+str(time.time_ns())+'.jsonl'))
    for directory in ['workspace','state','config','data','cache','home']:
        (root/directory).mkdir(exist_ok=True);(root/directory/'preserved.txt').write_text('preserve-through-update\n')
    installed=root/'installed.AppImage';shutil.copy2(root/'base.AppImage',installed);installed.chmod(0o755)
    runtime=env.copy()
    for key in list(runtime):
        if any(word in key.upper() for word in ['PROXY','API_KEY','TOKEN','SECRET','SIGNING']):runtime.pop(key)
    runtime.update(HOME=str(root/'home'),XDG_DATA_HOME=str(root/'data'),XDG_CONFIG_HOME=str(root/'config'),XDG_CACHE_HOME=str(root/'cache'),XHARNESS_STATE_DIR=str(root/'state'),XHARNESS_WORKSPACE=str(root/'workspace'),XHARNESS_REHEARSAL_ROOT=str(root),SSL_CERT_FILE=str(root/'ca.pem'),SSL_CERT_DIR=str(root/'home'),WEBKIT_DISABLE_DMABUF_RENDERER='1',LIBGL_ALWAYS_SOFTWARE='1')
    runtime.pop('XHARNESS_PROVIDERS_FILE',None)
    with (root/'app.log').open('w') as log:
        process=subprocess.Popen(['xvfb-run','-a','dbus-run-session','--','sh','-c','"$1" & wait; sleep 190','rehearsal',str(installed)],env=runtime,stdout=log,stderr=log,start_new_session=True)
        try:
            deadline=time.monotonic()+180
            while time.monotonic()<deadline:
                events=[json.loads(l) for l in (root/'events.jsonl').read_text().splitlines()] if (root/'events.jsonl').exists() else []
                if any('failed' in x for x in events):raise RuntimeError('Native rehearsal failed; inspect '+str(root/'events.jsonl'))
                if any(x.get('complete') for x in events):break
                time.sleep(.5)
            else:raise TimeoutError('Rehearsal did not finish; inspect '+str(root/'app.log'))
            assert hashlib.sha256(installed.read_bytes()).digest()==hashlib.sha256((root/'update.AppImage').read_bytes()).digest(),'installed binary differs from signed target'
            result={'passed':True,'root':str(root),'events':events,'exactTargetInstalled':True,'scope':'native production handlers, not UI mouse-click acceptance'}
            (root/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
        finally:
            import signal
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            server.shutdown()

def main():
    if sys.platform != 'linux': raise SystemExit('禁止本机编译：请同步源码后在 Linux 服务器执行')
    if len(sys.argv)==3 and sys.argv[1]=='--run-existing':
        root=pathlib.Path(sys.argv[2]).resolve()
        assert root.parent==REPO/'dist' and root.name.startswith('linux-update-rehearsal-') and (root/'ISOLATED_TEST_ONLY').is_file()
        from urllib.parse import urlparse
        port=urlparse(json.loads((root/'latest.json').read_text())['platforms']['linux-x86_64']['url']).port
        env=os.environ.copy();env.update(PATH=str(root/'safe-bin'),APPIMAGE_EXTRACT_AND_RUN='1')
        return run_app(root,env,start_server(root,port))
    root=REPO/'dist'/('linux-update-rehearsal-'+time.strftime('%Y%m%d-%H%M%S'));root.mkdir(parents=True)
    os.chmod(root,0o700);(root/'ISOLATED_TEST_ONLY').touch()
    src=root/'source'
    shutil.copytree(REPO,src,ignore=shutil.ignore_patterns('.git','target','node_modules','dist','.env','.env.*','*.key','*.pem'))
    shutil.copytree(REPO/'ui/dist',src/'ui/dist')
    desktop=src/'apps/desktop/src-tauri'
    shutil.copy2(REPO/'scripts/fixtures/linux-update-driver.rs',desktop/'src/rehearsal.rs')
    p=desktop/'src/sidecar.rs';s=p.read_text();assert '    token: String,' in s;s=s.replace('    token: String,','    pub(crate) token: String,',1);p.write_text(s)
    p=desktop/'src/lib.rs';s=p.read_text();assert 'mod sidecar;' in s
    s=s.replace('mod sidecar;','mod rehearsal;\nmod sidecar;',1)
    needle='if let Err(error) = sidecar::start(&handle).await {'
    assert needle in s
    s=s.replace(needle,'if let Err(error) = sidecar::start(&handle).await {',1)
    needle='''                }
            });
            Ok(())'''
    assert needle in s
    s=s.replace(needle,'''                }
                rehearsal::run(handle).await;
            });
            Ok(())''',1);p.write_text(s)
    env=os.environ.copy();env['PATH']=str(pathlib.Path.home()/'.cargo/bin')+':'+env['PATH'];env['npm_config_registry']='https://registry.npmjs.org';env['APPIMAGE_EXTRACT_AND_RUN']='1'
    run(['cargo','build','--locked','--release','-p','xharness-host-app'],cwd=REPO,env=env)
    run(['python3',src/'scripts/stage-tauri-sidecar.py',REPO/'target/release/xharness-host','x86_64-unknown-linux-gnu'],cwd=src,env=env)
    run(['python3',src/'scripts/stage-tauri-sidecar.py',shutil.which('rg'),'x86_64-unknown-linux-gnu','--name','rg'],cwd=src,env=env)
    # Install only the two pinned CLI packages; verify registry SHA-512 and do
    # not execute npm lifecycle scripts or inherit a stale registry mirror cache.
    modules=root/'cli/node_modules/@tauri-apps'
    for package in ['cli','cli-linux-x64-gnu']:
        with urllib.request.urlopen('https://registry.npmjs.org/@tauri-apps/'+package+'/2.11.4',timeout=30) as response:
            dist=json.load(response)['dist']
        with urllib.request.urlopen(dist['tarball'],timeout=60) as response:data=response.read()
        assert 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()==dist['integrity']
        destination=modules/package;destination.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            for member in archive.getmembers():
                parts=pathlib.PurePosixPath(member.name).parts
                assert parts[0]=='package' and '..' not in parts and not member.issym() and not member.islnk()
                path=destination.joinpath(*parts[1:])
                if member.isdir():path.mkdir(parents=True,exist_ok=True)
                elif member.isfile():
                    path.parent.mkdir(parents=True,exist_ok=True)
                    with archive.extractfile(member) as source,path.open('wb') as target:shutil.copyfileobj(source,target)
    cli=['node',str(modules/'cli/tauri.js')]
    with (root/'key-generation.log').open('w') as log:
        run(cli+['signer','generate','-w',root/'test.key','-p','', '--ci'],cwd=src/'apps/desktop',env=env,stdout=log,stderr=log)
    pub=(root/'test.key.pub').read_text().strip()
    run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',root/'tls.key','-out',root/'ca.pem','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    server=start_server(root)
    endpoint=f'https://localhost:{server.server_port}'
    env.update(XHARNESS_UPDATER_ENDPOINT=endpoint+'/latest.json',XHARNESS_UPDATER_PUBKEY=pub,TAURI_SIGNING_PRIVATE_KEY=str(root/'test.key'),TAURI_SIGNING_PRIVATE_KEY_PASSWORD='',CARGO_TARGET_DIR=str(REPO/'apps/desktop/src-tauri/target'))
    # linuxdeploy scans every PATH entry for plugins. Broken/private symlinks
    # in a host-wide /usr/bin can abort it; use an isolated accessible tool view.
    safe_bin=root/'safe-bin';safe_bin.mkdir()
    for directory in env['PATH'].split(os.pathsep):
        try: entries=list(pathlib.Path(directory).iterdir())
        except OSError: continue
        for entry in entries:
            try:
                target=safe_bin/entry.name
                if not target.exists() and entry.is_file() and os.access(entry,os.X_OK):
                    target.symlink_to(entry.resolve())
            except OSError: continue
    env['PATH']=str(safe_bin)
    runtime_file=pathlib.Path.home()/'.cache/tauri/runtime-x86_64'
    if runtime_file.is_file():env['LDAI_RUNTIME_FILE']=str(runtime_file)
    for version,label in [('0.0.901','base'),('0.0.902','update')]:
        run(['python3',src/'scripts/prepare-desktop-test-version.py',version],env=env)
        run(cli+['build','--bundles','appimage','--verbose'],cwd=src/'apps/desktop',env=env)
        bundle=pathlib.Path(env['CARGO_TARGET_DIR'])/'release/bundle/appimage'
        candidates=list(bundle.glob(f'*{version}*.AppImage'));assert len(candidates)==1,candidates
        shutil.copy2(candidates[0],root/(label+'.AppImage'))
        shutil.copy2(pathlib.Path(str(candidates[0])+'.sig'),root/(label+'.AppImage.sig'))
    latest={'version':'0.0.902','notes':'Isolated Linux update rehearsal only','platforms':{'linux-x86_64':{'signature':(root/'update.AppImage.sig').read_text().strip(),'url':endpoint+'/update.AppImage'}}}
    (root/'latest.json').write_text(json.dumps(latest));(root/'mode').write_text('normal')
    run_app(root,env,server)
if __name__=='__main__':main()
