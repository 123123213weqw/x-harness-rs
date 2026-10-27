#!/usr/bin/env python3
"""Offline, isolated Host request capture. No real provider credentials or calls."""
import hashlib, json, os, pathlib, secrets, shutil, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT=pathlib.Path(__file__).resolve().parent
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def digest(x): return hashlib.sha256(x).hexdigest()
def dump(p,x):
    p.write_text(json.dumps(x,ensure_ascii=False,indent=2));p.chmod(0o600)
class Mock(BaseHTTPRequestHandler):
    captured=[]
    def log_message(self,*a): pass
    def do_GET(self):
        self.send_response(404);self.send_header('Content-Length','0');self.end_headers()
    def do_POST(self):
        b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not self.path.endswith('/responses'): return self.do_GET()
        self.captured.append(b)
        ev=[{'type':'response.output_text.delta','delta':'PROBE_OK'},
            {'type':'response.completed','response':{'id':'offline-probe','status':'completed','output':[],
              'usage':{'input_tokens':512,'output_tokens':4}}}]
        data=''.join('data: '+json.dumps(e)+'\n\n' for e in ev).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
class Rpc:
    def __init__(self,address,token):self.address=address;self.token=token;self.n=0
    def call(self,m,p):
        self.n+=1
        r=urllib.request.Request('http://'+self.address+'/api/'+m,
          data=json.dumps({'type':'client-request','rpcId':f'probe-{self.n}','method':m,'payload':p}).encode(),
          headers={'Content-Type':'application/json','x-xharness-desktop-token':self.token})
        with OPENER.open(r,timeout=20) as s:x=json.load(s)['result']
        if not x.get('ok'):raise RuntimeError(m+': '+str(x.get('error'))[:300])
        return x.get('value')
def system(r):return '\n\n'.join(c.get('text','') for m in r['input'] if m.get('role')=='system' for c in m.get('content',[]) if isinstance(c,dict))
def run(binary,arm,server,workspace_override=None):
    root=ROOT/arm;root.mkdir(exist_ok=False)
    ws=root/'workspace-a';ws.mkdir();ws2=root/'workspace-b';ws2.mkdir()
    if workspace_override:
        ws,ws2=workspace_override
    st=root/'state';st.mkdir();ready=root/'ready';shutdown=root/'shutdown';token=secrets.token_hex(32)
    env={k:v for k,v in os.environ.items() if k in ['HOME','PATH','LANG','USER','LOGNAME']}
    env.update(XHARNESS_API_KEY='offline-not-a-real-key',XHARNESS_DESKTOP_TOKEN=token,NO_PROXY='127.0.0.1,localhost')
    args=[str(binary),'--bind','127.0.0.1:0','--workspace',str(ws),'--state-dir',str(st),'--ready-file',str(ready),'--shutdown-file',str(shutdown),
      '--provider','deepseek','--model','deepseek-flash','--protocol','responses','--base-url',f'http://127.0.0.1:{server.server_port}/v1',
      '--context-window','1000000','--max-output-tokens','65536']
    proc=None;rows=[]
    try:
        with (root/'host.log').open('wb') as log:proc=subprocess.Popen(args,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        deadline=time.monotonic()+65
        while time.monotonic()<deadline:
            if proc.poll() is not None:raise RuntimeError('Owned Host exited during readiness')
            if ready.exists():
                rpc=Rpc(ready.read_text().strip(),token)
                try:
                    with OPENER.open('http://'+rpc.address+'/health/ready',timeout=3) as r:
                        if r.status==200:break
                except OSError:pass
            time.sleep(.2)
        else:raise RuntimeError('readiness timeout')
        desc=rpc.call('settings.describe',{});perm=next(n for n in desc['namespaces'] if n['ns']=='permission')
        rpc.call('settings.mutate',{'ns':'permission','expectedRevision':perm['revision'],'ops':[{'op':'set','path':['defaultPreset'],'value':'danger-full-access'}]})
        cases=[('one',ws,'Title one'),('two',ws,'Title two'),('three',ws2,'Title three'),('four',ws,'Title one')]
        for sid,cwd,title in cases:
            rpc.call('session.create',{'sessionId':sid,'cwd':str(cwd)})
            rpc.call('session.rename',{'sessionId':sid,'title':title})
            start=len(Mock.captured)
            rpc.call('session.prompt',{'sessionId':sid,'mode':'queue','content':[{'type':'text','text':'Return PROBE_OK.'}]})
            deadline=time.monotonic()+45
            while time.monotonic()<deadline:
                page=rpc.call('session.history',{'sessionId':sid,'maxMessages':100})
                ev=[e.get('event',e) for e in page.get('events',[])]
                ends=[e for e in ev if e.get('type')=='turn/end']
                if ends:
                    if ends[-1]['data']['reason']['kind']!='completed':raise RuntimeError(str(ends[-1]))
                    break
                time.sleep(.1)
            else:raise RuntimeError('turn timeout')
            captured=Mock.captured[start:]
            if len(captured)!=1:raise RuntimeError(f'Unexpected requests {len(captured)}')
            r=captured[0];dump(root/(sid+'-wire.json'),r);dump(root/(sid+'-events.json'),ev)
            text=system(r);tools=r.get('tools',[])
            row={'session':sid,'cwd':str(cwd),'system_bytes':len(text.encode()),'system_sha256':digest(text.encode()),
               'tools_sha256':digest(json.dumps(tools,sort_keys=True,separators=(',',':')).encode()),
               'tool_count':len(tools),'wire_keys':list(r),'wire_utf8_bytes':len(json.dumps(r,ensure_ascii=False,separators=(',',':')).encode())}
            rows.append(row);print(arm,sid,row['system_bytes'],flush=True)
    finally:
        if proc and proc.poll() is None:
            shutdown.write_text('shutdown')
            try:proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.terminate();proc.wait(timeout=10)
    dump(root/'summary.json',{'binary_sha256':digest(binary.read_bytes()),'requests':rows,'owned_host_exit':proc.returncode if proc else None})
    return rows
def main():
    import argparse
    global ROOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',type=pathlib.Path,required=True)
    parser.add_argument('--candidate',type=pathlib.Path,required=True)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args()
    ROOT=args.output.resolve();ROOT.mkdir(mode=0o700,parents=True,exist_ok=False)
    server=ThreadingHTTPServer(('127.0.0.1',0),Mock)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        run(args.baseline.resolve(),'baseline',server)
        run(args.candidate.resolve(),'candidate',server)
        run(args.candidate.resolve(),'restart',server,(ROOT/'candidate/workspace-a',ROOT/'candidate/workspace-b'))
    finally:
        server.shutdown();server.server_close()
    def read(arm,name='one'):return json.load(open(ROOT/arm/(name+'-wire.json')))
    before,after=read('baseline'),read('candidate')
    old={t['name']:t for t in before['tools']};new={t['name']:t for t in after['tools']}
    assert old.keys()==new.keys(), 'tool catalogue changed'
    for name in old:
        assert {k:v for k,v in old[name].items() if k!='description'}=={k:v for k,v in new[name].items() if k!='description'},name
    controls=lambda r:{k:v for k,v in r.items() if k not in {'input','tools'}}
    assert controls(before)==controls(after), 'model/output/reasoning controls changed'
    for arm in ['baseline','candidate','restart']:
        assert read(arm)==read(arm,'two')==read(arm,'four'), 'same-cwd session/title instability'
    assert after==read('restart'), 'process restart changed the request'
    a,b=system(after).encode(),system(read('candidate','three')).encode()
    offset=next((i for i,(x,y) in enumerate(zip(a,b)) if x!=y),min(len(a),len(b)))
    assert offset>2000, 'dynamic workspace data precedes the shared policies'
    assert after['input'][0]['role']=='system'
    for forbidden in ['harnessSnapshot','measurement','requestId']:
        assert forbidden not in after, 'audit metadata leaked into provider envelope'
    size=lambda x:len(json.dumps(x,ensure_ascii=False,separators=(',',':')).encode())
    summary={'passed':True,'mock_requests':12,'tool_schemas_and_controls_unchanged':True,
             'system_utf8_bytes_before':len(system(before).encode()),'system_utf8_bytes_after':len(a),
             'tools_json_bytes_before':size(before['tools']),'tools_json_bytes_after':size(after['tools']),
             'cross_workspace_first_difference_byte':offset,
             'mock_usage_is_not_cost_or_cache_evidence':True}
    assert summary['system_utf8_bytes_after']<summary['system_utf8_bytes_before']*.7
    assert summary['tools_json_bytes_after']<summary['tools_json_bytes_before']
    dump(ROOT/'summary.json',summary);print(json.dumps(summary),flush=True)
if __name__=='__main__':main()
