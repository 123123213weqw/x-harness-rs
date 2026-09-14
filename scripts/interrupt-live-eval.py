#!/usr/bin/env python3
"""Real-provider interruption evaluation in a disposable Host/workspace.
Credential + provider document arrive over stdin; never saved or logged.
"""
import argparse, hashlib, importlib.util, json, os, pathlib, socket, subprocess, sys, time
spec = importlib.util.spec_from_file_location('ablation', pathlib.Path(__file__).with_name('compaction-ablation.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--host-binary', required=True); p.add_argument('--output', required=True)
p.add_argument('--repeats', type=int, default=3); p.add_argument('--timeout', type=int, default=240)
args=p.parse_args(); credentials=json.load(sys.stdin)
root=pathlib.Path(args.output).resolve();root.mkdir(parents=True,exist_ok=False);root.chmod(0o700)
doc=credentials['providers']; provider=doc['providers'][0]; model=doc['default']['model']
# Reuse actual model/effort request patches, with an explicit bounded test context.
provider['models']=[m for m in provider['models'] if m['id']==model]
provider['models'][0]['max_output_tokens']=8192
provider['models'][0]['minimum_output_tokens']=1024
provider['models'][0]['fallback_context_window_tokens']=131072
# Config contains only an environment variable reference; key stays in memory.
config=root/'providers.json';config.write_text(json.dumps(doc));config.chmod(0o600)
env=os.environ.copy();env[provider['api_key_env']]=credentials['key'];del credentials
state=root/'state';workspace=root/'workspace';workspace.mkdir()
port=a.free_port();client=a.RpcClient(f'http://127.0.0.1:{port}')
command=[str(pathlib.Path(args.host_binary).resolve()),'--bind',f'127.0.0.1:{port}','--workspace',str(workspace),'--state-dir',str(state),'--providers-file',str(config),'--compaction-config','disabled','--debug-trace','full','--debug-dir',str(root/'debug')]
report={'model':model,'effort':doc['default'].get('reasoning_effort'),'cases':[]}
def events(sid):
    out=[]
    for line in (state/'sessions'/f'{sid}.jsonl').open():
        rec=json.loads(line)
        out.extend(x['event'] for x in rec.get('events',[]))
    return out

def wait_until(fn,seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if process.poll() is not None:raise RuntimeError('isolated host exited')
        value=fn()
        if value:return value
        time.sleep(.1)
    raise TimeoutError('evaluation stage timed out')

def ended(sid,n):return len([e for e in events(sid) if e['type']=='turn/end'])>=n

def fingerprints(path):
    return {str(f.relative_to(path)):hashlib.sha256(f.read_bytes()).hexdigest() for f in path.rglob('*') if f.is_file() and f.name not in ('prepare.started','stop-preparation') and '__pycache__' not in f.parts}

def prompt(sid,text):return client.call('session.prompt',{'sessionId':sid,'mode':'queue','content':[{'type':'text','text':text}]})

def turn_summary(ev,turn):
    selected=[];inside=False
    for e in ev:
        if e['type']=='turn/start':inside=e['data']['turn']==turn
        if inside:selected.append(e)
    return {'tool_calls':[e['data']['call'] for e in selected if e['type']=='tool/call'],
        'answers':[e['data']['message'].get('content','') for e in selected if e['type']=='assistant/message' and e['data']['message'].get('content')],
        'ending':next((e['data']['reason'] for e in selected if e['type']=='turn/end'),None)}

with (root/'host.log').open('w') as log:
 process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env)
 try:
    a.wait_for_host(client,process)
    settings=client.call('settings.describe',{});perm=next(x for x in settings['namespaces'] if x['ns']=='permission')
    client.call('settings.mutate',{'ns':'permission','ops':[{'op':'set','path':['defaultPreset'],'value':'danger-full-access'}],'expectedRevision':perm['revision']})
    instructions=['先不做实现了，只检查当前目录的文件占用，告诉我最大的文件是什么，不要修改或删除文件。',
                  '现在这个目录里面，文件占用分别是多少？',
                  '暂停编程，先只读检查 stats.py 当前实现到哪一步，报告即可，不要继续修改。']
    for i in range(args.repeats):
        case={'case':i+1};report['cases'].append(case);cwd=workspace/f'case-{i+1}';cwd.mkdir()
        (cwd/'stats.py').write_text('def mean(values):\n    raise NotImplementedError\n')
        (cwd/'test_stats.py').write_text('import unittest\nfrom stats import mean\nclass Tests(unittest.TestCase):\n def test_mean(self):\n  self.assertEqual(mean([2,4,6]),4)\n  self.assertEqual(mean([-2,2]),0)\n  self.assertEqual(mean([1.5,2.5]),2)\n def test_empty(self):\n  with self.assertRaises(ValueError): mean([])\n')
        (cwd/'sample.dat').write_bytes(b'x'*8192)
        (cwd/'prepare.py').write_text('import pathlib,time,os\np=pathlib.Path(__file__).parent\n(p/"prepare.started").write_text(str(os.getpid()))\nend=time.monotonic()+120\nwhile time.monotonic()<end and not (p/"stop-preparation").exists(): time.sleep(.1)\nprint("Preparation ended")\n')
        sid=client.call('session.create',{'sessionId':f'interrupt-live-{i+1}','cwd':str(cwd)})['sessionId'];case['session_id']=sid
        try:
            prompt(sid,'在当前工作区完成 stats.py 的 mean 函数，空列表抛 ValueError。先执行 python3 prepare.py 完成准备步骤，再修改 stats.py，最后执行 python3 -m unittest -v；不要修改测试文件，只操作这个工作区。')
            def preparation_started():
                if (cwd/'prepare.started').exists(): return True
                if ended(sid,1):
                    raise RuntimeError('initial turn ended before preparation: ' + str(turn_summary(events(sid),1)['ending']))
                return False
            wait_until(preparation_started,args.timeout)
            start=time.monotonic();client.call('session.cancel',{'sessionId':sid});wait_until(lambda:ended(sid,1),30)
            case['cancel_seconds']=round(time.monotonic()-start,3)
            # Release only our fixture process if the model chose a detached job.
            (cwd/'stop-preparation').touch();time.sleep(.3)
            before=fingerprints(cwd);case['before']=before
            redirected_at=time.monotonic()
            prompt(sid,instructions[i%len(instructions)])
            wait_until(lambda:ended(sid,2),args.timeout)
            case['redirect_seconds']=round(time.monotonic()-redirected_at,3)
            after=fingerprints(cwd);case['changed_after_redirect']=[k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)]
            ev=events(sid);case['old_turn']=turn_summary(ev,1);case['redirect_turn']=turn_summary(ev,2)
            audit=state/'sessions'/'request-audit';inside=False;first=None
            for e in ev:
                if e['type']=='turn/start':inside=e['data']['turn']==2
                if inside and e['type']=='request/header':first=e['data']['header'];break
            snapshot=json.load((audit/(first['options']['auditSnapshot']['sha256']+'.json')).open())
            msgs=[json.load((audit/(h+'.json')).open()) for h in snapshot['input']]
            ids=[j for j,m in enumerate(msgs) if '<turn_aborted>' in m.get('content','')]
            case['marker_count']=len(ids);case['marker_before_latest_user']=len(ids)==1 and ids[0]<len(msgs)-1 and msgs[-1].get('content')==instructions[i%len(instructions)]
            case['redirect_passed']=case['old_turn']['ending']=={'kind':'user_interrupted'} and case['redirect_turn']['ending']=={'kind':'completed'} and not case['changed_after_redirect'] and case['marker_before_latest_user']
            resumed_at=time.monotonic()
            prompt(sid,'现在明确恢复之前的编程任务：实现 stats.py 的 mean（空列表抛 ValueError），运行测试验收。prepare.py 的准备阶段已结束，不必再次运行；不要修改测试文件。')
            wait_until(lambda:ended(sid,3),args.timeout)
            case['resume_seconds']=round(time.monotonic()-resumed_at,3)
            check=subprocess.run([sys.executable,'-m','unittest','-v'],cwd=cwd,text=True,capture_output=True,timeout=20)
            case['resume_turn']=turn_summary(events(sid),3);case['acceptance_exit']=check.returncode;case['acceptance_output']=check.stdout+check.stderr
            case['tests_unchanged']=fingerprints(cwd).get('test_stats.py')==before['test_stats.py']
            case['passed']=case['redirect_passed'] and check.returncode==0 and case['tests_unchanged'] and case['resume_turn']['ending']=={'kind':'completed'}
        except Exception as e:
            case['error']=str(e);case['passed']=False
            (cwd/'stop-preparation').touch()
            try:client.call('session.cancel',{'sessionId':sid})
            except Exception:pass
        (root/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({k:v for k,v in case.items() if k not in ('before','old_turn','redirect_turn','resume_turn','acceptance_output')},ensure_ascii=False),flush=True)
 finally:
    for f in workspace.glob('case-*'): (f/'stop-preparation').touch()
    report['host_exit'],report['forced_cleanup']=a.stop_host(process)
    report['passed']=len(report['cases'])==args.repeats and all(c.get('passed') for c in report['cases'])
    (root/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'passed':report['passed'],'cases':len(report['cases']),'forced_cleanup':report['forced_cleanup']},ensure_ascii=False),flush=True)
sys.exit(0 if report['passed'] else 1)
