#!/usr/bin/env python3
# Opt-in isolated live test; provide the API credential on stdin, never in argv.
import os,sys,json,pathlib,tempfile,subprocess,time,urllib.request,uuid,socket
key=sys.stdin.read().strip();assert key
root=pathlib.Path(tempfile.mkdtemp(prefix='xh-question-real-'));root.chmod(0o700);work=root/'workspace';work.mkdir();(work/'README.md').write_text('This is a read-only acceptance fixture. No implementation or deployment is needed.\n')
config={'default':{'provider':'test-deepseek','model':'deepseek-flash','reasoning_effort':'off'},'providers':[{'id':'test-deepseek','base_url':'https://api.deepseek.com','protocol':'chat','api_key_env':'QUESTION_TEST_KEY','models':[{'id':'deepseek-flash','max_output_tokens':4096,'minimum_output_tokens':1024,'fallback_context_window_tokens':1048576,'reasoning':{'default_effort':'off','efforts':[{'id':'off','name':'off','request_patch':{'thinking':{'type':'disabled'}}}]}}]}]}
(root/'providers.json').write_text(json.dumps(config));sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();base=f'http://127.0.0.1:{port}'
env=os.environ.copy();env['QUESTION_TEST_KEY']=key;key=None
binary=os.environ.get('XHARNESS_TEST_HOST_BIN',os.path.expanduser('~/codex-build/x-harness-rs/target/debug/xharness-host'));p=None
log=open(root/'host.log','ab')
def start():
 global p
 p=subprocess.Popen([binary,'--bind',f'127.0.0.1:{port}','--workspace',str(work),'--state-dir',str(root/'state'),'--providers-file',str(root/'providers.json')],env=env,stdout=log,stderr=log)
 for _ in range(80):
  try:
   with urllib.request.urlopen(base+'/health/ready',timeout=1) as f: assert json.load(f)['ok'];return
  except Exception: time.sleep(.25)
 raise RuntimeError('Host did not start')
def stop():
 if p and p.poll() is None:
  p.terminate()
  try:p.wait(timeout=20)
  except subprocess.TimeoutExpired:p.kill();p.wait()
def post(path,data):
 req=urllib.request.Request(base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=15) as f:return json.load(f)
def rpc(m,payload):
 r=post('/api/'+m,{'type':'client-request','rpcId':str(uuid.uuid4()),'method':m,'payload':payload});assert r['result']['ok'],r;return r['result']['value']
def history():return rpc('session.history',{'sessionId':'question-acceptance','maxMessages':100})
def events(h):return [e['event'] for e in h['events']]
try:
 start();print('Isolated test:',root,flush=True)
 rpc('session.create',{'sessionId':'question-acceptance','cwd':str(work)})
 rpc('session.prompt',{'sessionId':'question-acceptance','mode':'queue','content':[{'type':'text','text':'这是一次问答工具的验收，不是编程任务。先使用 ask_user_question 问我测试标签选 Alpha 还是 Beta（纯测试选择，答案现在未知）。若等待超时，唯一可独立进行的工作是使用 read 读取当前目录 README.md，然后结束本轮等我回答，不重复询问，不用 bash、不写文件、不创建 goal/job。等我稍后回答后，用一句话确认我选择的标签并结束。'}]})
 start_time=time.monotonic();call=None;deferred=None
 for _ in range(100):
  time.sleep(1);h=history();es=events(h)
  call=next((e for e in es if e.get('type')=='tool/call' and e['data']['name']=='ask_user_question'),None)
  deferred=next((e for e in es if e.get('type')=='tool/result' and 'deferred' in json.dumps(e)),None)
  if deferred:break
 assert call and deferred,'No question/deferred result'
 elapsed=(deferred['time']-call['time'])/1000
 print('Deferred after seconds:',elapsed,flush=True);assert 59<=elapsed<75
 for _ in range(25):
  time.sleep(1);h=history();es=events(h)
  if any(e.get('type')=='turn/end' for e in es):break
 reads=[e for e in es if e.get('type')=='tool/call' and e['data']['name']=='read'];assert reads,'Model did not use read after timeout'
 assert len([e for e in es if e.get('type')=='tool/call' and e['data']['name']=='ask_user_question'])==1
 print('Read-only continuation completed. Restarting isolated Host before late answer.',flush=True)
 stop();start()
 args=json.loads(call['data']['arguments']);q=args['questions'][0];opt=next((x for x in q['options'] if 'Beta' in x['label']),q['options'][-1]);qid='question:'+call['data']['callId']
 reply={'type':'client-response','rpcId':qid,'result':{'ok':True,'value':{'sessionId':'question-acceptance','answer':{'answers':[{'id':q['id'],'selected':[opt['label']]}]}}}}
 receipt=post('/api/respond',reply);print('Late answer receipt:',receipt,flush=True);assert receipt['accepted']
 for _ in range(30):
  time.sleep(1);h=history();es=events(h)
  if len([e for e in es if e.get('type')=='turn/end'])>=2:break
 assert len([e for e in es if e.get('type')=='turn/end'])>=2,'Late answer did not trigger response'
 assert any(e.get('type')=='assistant/message' and 'Beta' in json.dumps(e) for e in es)
 stop();start();time.sleep(2)
 restored=events(history());assert len([e for e in restored if e.get('type')=='turn/end'])==len([e for e in es if e.get('type')=='turn/end']),'Answered outbox replayed on second restart'
 (root/'acceptance.json').write_text(json.dumps({'elapsedSeconds':elapsed,'lateAnswerAccepted':True,'readCalls':len(reads),'history':h},ensure_ascii=False,indent=2))
 print('PASS real DeepSeek: 60s deferred -> read -> stop -> restart -> late answer -> response',flush=True)
finally:stop();log.close()
