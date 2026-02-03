#!/usr/bin/env python3
"""Isolated real-model delegation evaluation. Read credentials from stdin, never argv/logs.
Run only with an already compiled host binary. No existing user session is modified.
"""
import argparse, importlib.util, json, os, pathlib, socket, subprocess, sys, time

spec=importlib.util.spec_from_file_location('ablation',pathlib.Path(__file__).with_name('compaction-ablation.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--host-binary',required=True);p.add_argument('--output',required=True)
p.add_argument('--model',default='deepseek-v4-flash');p.add_argument('--base-url',default='https://api.deepseek.com')
p.add_argument('--case',choices=['coding','control','iterative'],required=True);p.add_argument('--timeout',type=int,default=600)
args=p.parse_args();credential=json.load(sys.stdin)
root=pathlib.Path(args.output).resolve();root.mkdir(parents=True,exist_ok=False);root.chmod(0o700)
workspace=root/'workspace';workspace.mkdir();state=root/'state'
(workspace/'stats.py').write_text('def mean(values):\n    raise NotImplementedError\n')
(workspace/'paths.py').write_text('def suffix(name):\n    raise NotImplementedError\n')
(workspace/'test_acceptance.py').write_text('''import unittest
from stats import mean
from paths import suffix
class Acceptance(unittest.TestCase):
 def test_mean(self):
  self.assertEqual(mean([2,4,6]),4)
  self.assertEqual(mean([-4,4]),0)
  self.assertEqual(mean([1.5,2.5]),2)
  with self.assertRaises(ValueError): mean([])
 def test_suffix(self):
  self.assertEqual(suffix("a.tar.gz"),"gz")
  self.assertEqual(suffix("README"),"")
  self.assertEqual(suffix(".gitignore"),"")
  self.assertEqual(suffix("a."),"")
  self.assertEqual(suffix("dir.x/name"),"")
if __name__=="__main__":unittest.main()
''')
with socket.socket() as sock: sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
command=[str(pathlib.Path(args.host_binary).resolve()),'--bind',f'127.0.0.1:{port}','--workspace',str(workspace),'--state-dir',str(state),
 '--provider','deepseek-eval','--model',args.model,'--base-url',args.base_url,'--context-window','65536','--max-output-tokens','8192',
 '--token-safety-margin','1024','--compaction-config','disabled','--debug-trace','full','--debug-dir',str(root/'debug')]
env=os.environ.copy();env['XHARNESS_API_KEY']=credential['api_key'];del credential
client=a.RpcClient(f'http://127.0.0.1:{port}');report={'case':args.case,'model':args.model};started=time.monotonic()
with (root/'host.log').open('w') as log:
 process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env)
 try:
  a.wait_for_host(client,process)
  settings=client.call('settings.describe',{})
  permission=next(x for x in settings['namespaces'] if x['ns']=='permission')
  client.call('settings.mutate',{'ns':'permission','ops':[{'op':'set','path':['defaultPreset'],'value':'danger-full-access'}],'expectedRevision':permission['revision']})
  sid=client.call('session.create',{'sessionId':'agent-eval-'+args.case,'cwd':str(workspace)})['sessionId']
  if args.case in ('coding','iterative'):
   prompt='''请完成这个 Python 小项目。必须委派两个独立子 Agent：一个只实现 stats.py 的 mean（空列表抛 ValueError），另一个只实现 paths.py 的 suffix（返回最后扩展名、不带点，隐藏文件和无扩展名返回空串；只看最后路径段）。不要让他们同时改同一个文件，不要修改 test_acceptance.py。向子 Agent 给出完整需求和工作区路径。主 Agent 等待自动结果通知，不要循环查询；收到两个结果后运行 python3 -m unittest -v 验收，有问题再跟对应子 Agent 继续沟通，最终报告实际结果。'''
  else:
   prompt='''测试子 Agent 控制链路。创建一个子 Agent，让它先通过 bash 执行 sleep 30，再只读检查 stats.py；返回 ID 后给同一子 Agent 发送补充消息，改为之后检查 paths.py；查询一次它的状态，然后立即停止它。不需要等它自然结束，不要自己执行 sleep，不要新建替代 Agent，不要修改任何文件。最终区分“停止请求已接受”和“任务已成功完成”。'''
  client.call('session.prompt',{'sessionId':sid,'mode':'queue','content':[{'type':'text','text':prompt}]})
  quiet=0;children=[];hist={};phase=0
  while time.monotonic()-started < args.timeout:
   time.sleep(1)
   listing=client.call('session.list',{});sessions=listing.get('items',[]) if isinstance(listing,dict) else listing
   children=client.call('subagent.list',{'parentSessionId':sid}).get('entries',[])
   hist=client.call('session.history',{'sessionId':sid,'maxMessages':2000})
   events=a.normalized_events(hist)
   agent_calls=[e['data'] for e in events if e.get('type')=='tool/call' and e.get('data',{}).get('name')=='agent']
   related=[x for x in sessions if x.get('sessionId')==sid or x.get('parentSessionId')==sid]
   running=any(x.get('running') for x in related) or any(x.get('activity')=='running' for x in children)
   needed=2 if args.case in ('coding','iterative') else 1
   if not running and len(children)>=needed:quiet+=1
   else:quiet=0
   if quiet>=4:
    if args.case=='iterative' and phase==0:
     with (workspace/'test_acceptance.py').open('a') as tests:
      tests.write('\nclass WindowsPaths(unittest.TestCase):\n def test_windows_suffix(self):\n  self.assertEqual(suffix(r"dir.x\\README"), "")\n  self.assertEqual(suffix(r"dir.x\\.gitignore"), "")\n  self.assertEqual(suffix(r"dir.x\\file.tar.gz"), "gz")\n')
     client.call('session.prompt',{'sessionId':sid,'mode':'queue','content':[{'type':'text','text':'新增需求：suffix 同时支持 Windows 反斜杠路径；我已经追加了验收测试。请给原来的 suffix 子 Agent 发送跟进任务修复，不要新建第三个 Agent，不要改 stats.py 和测试文件。收自动结果后运行全部 unittest 并汇报。'}]})
     phase=1;quiet=0
    else: break
  else:report['timeout']=True
  report['elapsed_seconds']=round(time.monotonic()-started,2)
  report['children']=children
  report['debug_run_failures']=[]
  for trace in (root/'debug').rglob('*.jsonl'):
   for line in trace.open():
    item=json.loads(line)
    if item.get('event')=='run.end' and str(item.get('payload',{}).get('status','')).lower()=='failed':
     report['debug_run_failures'].append({'scope':item.get('scope'),'error':item.get('payload',{}).get('error')})
  report['actions']=[]
  for c in agent_calls:
   try: report['actions'].append(json.loads(c.get('arguments','{}')).get('action'))
   except (ValueError,TypeError):report['actions'].append('invalid_json')
  report['answers']=a.assistant_answers(events)
  report['turn_reasons']=a.turn_reasons(events)
  report['tool_failures']=[e for e in events if e.get('type')=='tool/result' and any(b.get('isError') for b in e.get('data',{}).get('message',{}).get('content',[]))]
  (root/'parent-history.json').write_text(json.dumps(hist,ensure_ascii=False,indent=2))
  report['child_turn_reasons']=[]
  for child in children:
   history=client.call('session.history',{'sessionId':child['id'],'maxMessages':2000})
   report['child_turn_reasons'].extend(a.turn_reasons(a.normalized_events(history)))
   (root/(child['id']+'.json')).write_text(json.dumps(history,ensure_ascii=False,indent=2))
  if args.case in ('coding','iterative'):
   check=subprocess.run(['python3','-m','unittest','-v'],cwd=workspace,text=True,capture_output=True,timeout=30)
   report['acceptance_exit_code']=check.returncode;report['acceptance_output']=check.stdout+check.stderr
   report['passed']=check.returncode==0 and report['actions'].count('start')>=2 and not report.get('timeout')
  else:
   report['passed']=set(['start','send','inspect','stop']).issubset(report['actions']) and len(children)==1 and not report.get('timeout')
  report['passed']=report['passed'] and not report['debug_run_failures']
  if args.case=='iterative':report['passed']=report['passed'] and 'send' in report['actions'] and len(children)==2
  if args.case=='control':report['passed']=report['passed'] and any(x.get('kind')=='cancelled' for x in report['child_turn_reasons'])
 except Exception as error: report['error']=str(error);report['passed']=False
 finally:
  report['host_exit'],report['forced_cleanup']=a.stop_host(process)
  (root/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ['answers','tool_failures']},ensure_ascii=False,indent=2))
sys.exit(0 if report.get('passed') else 1)
