"""Real installed Chrome/Edge through the compiled production Rust manager.

Only disposable loopback pages, independent profiles and a test-owned process.
No LLM, installed Host, existing browser or user credentials are involved.
"""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
from PIL import Image
import psutil


class Fixture:
    def __init__(self):
        self.events = []
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size < 2048: self.send_error(400); return
                outer.events.append(json.loads(self.rfile.read(size)))
                self.send_response(204); self.end_headers()
            def do_GET(self):
                if self.path.startswith('/delayed'): time.sleep(.2)
                if self.path == '/child':
                    html = '<body style="margin:0"><button style="width:160px;height:44px" onclick="parent.postMessage({child:true,trusted:event.isTrusted},\'*\')">Child action</button>'
                else:
                    html = f'''<!doctype html><style>body{{margin:0;font:16px sans-serif}}#marker{{position:absolute;left:1100px;top:20px;width:120px;height:80px;background:rgb(220,30,40)}}button{{position:absolute;left:20px;top:70px;width:160px;height:44px}}input{{position:absolute;left:220px;top:70px;width:220px;height:40px}}#state{{position:absolute;left:20px;top:130px}}iframe{{position:absolute;left:20px;top:220px;width:200px;height:80px;border:0}}</style>
                    <h1>Ready</h1><div id="marker"></div><div style="position:absolute;left:1100px;top:800px;width:120px;height:80px;background:rgb(230,200,20)"></div><button id="apply">Apply</button><input aria-label="Command"><div id="state">Count:0 Child:0 Enter:0</div><iframe src="http://127.0.0.1:{self.server.server_port if self.server is outer.child else outer.child.server_port}/child"></iframe>
                    <div style="position:absolute;top:400px;height:2000px">{'Synthetic document ' * 300}</div>
                    <script>let count=0,child=0,enter=0;const colors=['rgb(220,30,40)','rgb(20,170,60)','rgb(30,80,220)'];
                    function record(kind,trusted){{document.querySelector('#state').textContent='Count:'+count+' Child:'+child+' Enter:'+enter;document.querySelector('#marker').style.background=colors[count%3];fetch('/event',{{method:'POST',body:JSON.stringify({{kind,trusted,count,child,enter}})}})}}
                    document.querySelector('#apply').onclick=e=>{{count++;record('click',e.isTrusted)}};document.querySelector('input').onkeydown=e=>{{if(e.key==='Enter'){{enter++;record('enter',e.isTrusted)}}}};
                    addEventListener('message',e=>{{if(e.origin==='http://127.0.0.1:{outer.child.server_port}'&&e.data.child){{child++;record('child',e.data.trusted)}}}});</script>'''
                data = html.encode(); self.send_response(200); self.send_header('Content-Type','text/html'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        self.child = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.top = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        for server in [self.child,self.top]:threading.Thread(target=server.serve_forever,daemon=True).start()
        self.url = f'http://127.0.0.1:{self.top.server_port}/'
    def close(self):
        for server in [self.child,self.top]:server.shutdown();server.server_close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cycles',type=int,default=100,choices=range(2,201))
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    fixture=Fixture();responses=queue.Queue();seq=0
    log=(args.output/'worker.log').open('w')
    process=subprocess.Popen([str(args.binary.resolve())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
    def read():
        for line in process.stdout:
            if line.startswith('BENCH_REPLY '):responses.put(json.loads(line[len('BENCH_REPLY '):]))
        responses.put(None)
    threading.Thread(target=read,daemon=True).start()
    transcript=(args.output/'protocol.jsonl').open('w')
    def compact(value):
        if isinstance(value,dict):return {key:('<image bytes omitted>' if key in ['image','png_base64'] and isinstance(item,str) else compact(item)) for key,item in value.items()}
        if isinstance(value,list):return [compact(item) for item in value]
        return value
    def call(op,arguments=None,owner='acceptance-owner',allow_error=False):
        nonlocal seq
        seq+=1;process.stdin.write(json.dumps({'seq':seq,'op':op,'args':arguments or {},'owner':owner})+'\n');process.stdin.flush()
        reply=responses.get(timeout=45);assert reply is not None and reply['seq']==seq,reply
        transcript.write(json.dumps({'op':op,'arguments':arguments or {},'owner':owner,'reply':compact(reply)})+'\n');transcript.flush()
        if not allow_error:assert reply['ok'],reply
        return reply['result'] if reply['ok'] else reply
    proofs=[];cases=[];passed=False
    def owned_children():
        children=[];profiles=set()
        for child in psutil.Process(process.pid).children(recursive=True):
            try:
                command=child.cmdline()
                children.append((child.pid,child.create_time()))
                for index,word in enumerate(command):
                    if word.startswith('--user-data-dir='): profiles.add(Path(word.split('=',1)[1]))
                    if word=='--xharness-owned-browser-helper': profiles.add(Path(command[index+2]))
            except (psutil.NoSuchProcess,psutil.AccessDenied): pass
        assert profiles and children, (profiles,children)
        assert all(path.name.startswith('xharness-owned-browser-') for path in profiles)
        return children,profiles
    def assert_reaped(owned):
        children,profiles=owned;deadline=time.monotonic()+8
        while True:
            live=[]
            for pid,created in children:
                try:
                    child=psutil.Process(pid)
                    if child.create_time()==created and child.status()!=psutil.STATUS_ZOMBIE:live.append(pid)
                except psutil.NoSuchProcess:pass
            if not live and all(not path.exists() for path in profiles):return
            assert time.monotonic()<deadline, {'unreaped':live,'remaining_profiles':[str(p) for p in profiles if p.exists()]}
            time.sleep(.05)
    def capture(count,name):
        image=call('screenshot');data=base64.b64decode(image['png_base64'],validate=True)
        with Image.open(io.BytesIO(data)) as png:
            assert png.size==(1280,720),png.size
            color=png.convert('RGB').getpixel((1160,60))
            expected=[(220,30,40),(20,170,60),(30,80,220)][count%3]
            assert all(abs(a-b)<=5 for a,b in zip(color,expected)),(count,color)
        (args.output/name).write_bytes(data);proofs.append({'file':name,'color':color})
        return image
    def preview_until(tab):
        deadline=time.monotonic()+5
        while True:
            result=call('preview',{'tab_id':tab})
            if result.get('busy') is not True:return result
            assert time.monotonic()<deadline,'bounded preview retries exhausted'
            time.sleep(.05)
    def click(x,y):
        observed=call('observe');return call('input',{'action':'click','frame_id':observed['frame_id'],'x':x,'y':y})
    def observe_state(expected):
        deadline=time.monotonic()+2
        while True:
            observed=call('observe')
            if expected in observed['text']:return observed
            assert time.monotonic()<deadline,(expected,observed['text']);time.sleep(.01)
    try:
        assert responses.get(timeout=10)['result']['ready']
        state=call('control',{'action':'status'});assert state['available'] and not state['bound']
        opened=call('control',{'action':'open','url':fixture.url});assert opened['state']=='ready' and opened['preview_optional']
        tab=opened['tab_id'];cases.append('open without sidebar/UI rendezvous')
        assert not call('preview',{'tab_id':tab},owner='other-chat',allow_error=True)['ok'];cases.append('preview owner isolation')
        frame=call('observe');preview=preview_until(tab)
        with Image.open(io.BytesIO(base64.b64decode(preview['image'],validate=True))) as jpeg:assert jpeg.size==(640,360)
        receipt=call('input',{'action':'click','frame_id':frame['frame_id'],'x':100,'y':92});assert receipt['effect']=='applied',receipt
        observe_state('Count:1 ');capture(1,'expanded.png');cases.append('preview leaves model frame actionable')
        repeated=call('input',{'action':'click','frame_id':frame['frame_id'],'x':100,'y':92});assert repeated['effect']=='not_started';cases.append('consumed frame replay denied')
        click(100,242);observe_state('Child:1 Enter:0');click(300,92)
        for key in ['a','Enter']:
            frame=call('observe');assert call('input',{'action':'key','frame_id':frame['frame_id'],'key':key})['effect']=='applied'
        observe_state('Child:1 Enter:1');cases.append('trusted cross-origin iframe and keyboard')
        count=1
        # Intentionally no preview calls throughout this workload. No visibility
        # parameter or renderer renewal is needed by the production manager.
        for index in range(args.cycles):
            assert click(100,92)['effect']=='applied';count+=1;observe_state(f'Count:{count} ');capture(count,f'hidden-{index}.png')
        cases.append(f'{args.cycles} hidden observe/input/PNG cycles')
        frame=call('observe');assert call('perform',{'action':'scroll','frame_id':frame['frame_id'],'delta_y':780})['ok']
        image=call('screenshot');data=base64.b64decode(image['png_base64'],validate=True)
        with Image.open(io.BytesIO(data)) as png:
            assert png.size==(1280,720);color=png.convert('RGB').getpixel((1160,60));assert all(abs(a-b)<=5 for a,b in zip(color,(230,200,20))),color
        (args.output/'scrolled.png').write_bytes(data)
        frame=call('observe');assert call('perform',{'action':'scroll','frame_id':frame['frame_id'],'delta_y':-780})['ok']
        cases.append('scrolled viewport PNG uses page offsets rather than document origin')

        preview=preview_until(tab);assert preview['mime']=='image/jpeg';observe_state(f'Count:{count} ');cases.append('reopen preview preserves target state')
        opened_b=call('control',{'action':'open','url':fixture.url},owner='other-chat');assert opened_b['tab_id']!=tab
        assert 'Count:0 ' in call('observe',owner='other-chat')['text'];observe_state(f'Count:{count} ');cases.append('chat profiles and state are independent')
        assert call('control',{'action':'close'},owner='other-chat')['closed']
        call('control',{'action':'close'});assert not call('observe',allow_error=True)['ok']
        reopened=call('control',{'action':'open','url':fixture.url});assert reopened['tab_id']!=tab
        assert not call('preview',{'tab_id':tab},allow_error=True)['ok'];cases.append('closed tab cannot target successor')
        navigated=call('control',{'action':'open','url':fixture.url+'delayed'})
        assert navigated['url']==fixture.url+'delayed',navigated
        cases.append('navigation readiness belongs to the newly committed document')
        time.sleep(.2)
        assert len(fixture.events)==count+2 and all(event['trusted'] for event in fixture.events),(len(fixture.events),count)
        cases.append('actual fixture effects and isTrusted verified')
        owned=owned_children()
        call('close');process.wait(timeout=8);assert process.returncode==0
        assert_reaped(owned);cases.append('normal close reaps owned process tree and removes only its profiles')
        # Unexpected parent death must release the same-executable helper lease.
        # Only this test-owned probe is killed, never an installed app/browser.
        responses=queue.Queue();seq=0
        process=subprocess.Popen([str(args.binary.resolve())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        threading.Thread(target=read,daemon=True).start()
        assert responses.get(timeout=10)['result']['ready']
        call('control',{'action':'open','url':fixture.url})
        owned=owned_children();process.kill();process.wait(timeout=8)
        assert_reaped(owned);cases.append('unexpected controller death revokes lease and reaps browser/profile')
        passed=True
    finally:
        if process.poll() is None:
            process.stdin.close()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=5)
        fixture.close();log.close();transcript.close()
        receipt={'passed':passed,'model_calls':0,'scope':'real installed browser + production Rust manager; no installed app/Host or LLM','cases':cases,'proofs':proofs,'exit_code':process.returncode}
        (args.output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps({'passed':passed,'cases':len(cases),'screenshots':len(proofs)}))
    return 0


if __name__=='__main__':raise SystemExit(main())
