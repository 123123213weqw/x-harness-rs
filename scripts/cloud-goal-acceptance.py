#!/usr/bin/env python3
"""Real DeepSeek Goal in the retained, resource-bounded VM-1 only.

No generic Internet access, public listener, replacement of original services,
production capability registration, user conversation copy, or release. A scoped
loopback SSH relay forwards ONLY this test's exact model/completions endpoint.
The vendor key stays outside the guest and is never printed or persisted in reports.
"""
import argparse
import hashlib
import hmac
import http.client
import http.server
import importlib.util
import json
import inspect
import os
from pathlib import Path
import secrets
import shlex
import ssl
import subprocess
import threading
import time
import uuid

spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('cloud-native-acceptance.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
module=native.module

class Relay:
    def __init__(self,config):
        if config.get('base_url')!='https://api.deepseek.com' or config.get('model')!='deepseek-flash' or not isinstance(config.get('api_key'),str) or not config['api_key']:
            raise RuntimeError('invalid bounded test model configuration')
        self.config=config;self.token=secrets.token_urlsafe(32);self.rows=[];self.lock=threading.Lock();self.started=time.monotonic()
        relay=self
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*_):pass
            def do_POST(self):
                if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+relay.token):
                    self.send_error(403);return
                # The original provider probes this OPTIONAL counting route.
                # Unsupported is 404, not an authorization failure. Never
                # forward it or fabricate an exact token count for DeepSeek.
                if self.path=='/v1/chat/completions/input_tokens':
                    self.send_error(404);return
                if self.path!='/v1/chat/completions':
                    self.send_error(403);return
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<length<=512*1024:raise ValueError()
                    body=self.rfile.read(length);value=json.loads(body)
                    if value.get('model')!=relay.config['model'] or value.get('stream') is not True or not 1<=value.get('max_tokens',0)<=8192:raise ValueError()
                    with relay.lock:
                        if len(relay.rows)>=24 or time.monotonic()-relay.started>900:raise ValueError()
                        row={'status':'started','request_bytes':len(body),'usage':None};relay.rows.append(row)
                except Exception:
                    self.send_error(400);return
                connection=http.client.HTTPSConnection('api.deepseek.com',timeout=90,context=ssl.create_default_context())
                started=time.monotonic();pending=b''
                try:
                    connection.request('POST','/chat/completions',body=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+relay.config['api_key']})
                    response=connection.getresponse();row['http_status']=response.status
                    self.send_response(response.status);self.send_header('Content-Type',response.getheader('Content-Type','text/event-stream'));self.send_header('Connection','close');self.end_headers();self.close_connection=True
                    while True:
                        chunk=response.read1(16384)
                        if not chunk:break
                        self.wfile.write(chunk);self.wfile.flush()
                        pending+=chunk
                        while b'\n' in pending:
                            line,pending=pending.split(b'\n',1)
                            if line.startswith(b'data: '):
                                try:
                                    data=json.loads(line[6:])
                                    if isinstance(data.get('usage'),dict):row['usage']=data['usage']
                                except (ValueError,AttributeError):pass
                        if len(pending)>1024*1024:raise RuntimeError('bounded event exceeded')
                    row['status']='completed'
                except Exception:row['status']='transport_failed';self.close_connection=True
                finally:connection.close();row['elapsed_ms']=round((time.monotonic()-started)*1000)
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def stop(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
    def count(self):
        with self.lock:return len(self.rows)
    def metrics(self):
        with self.lock:return json.loads(json.dumps(self.rows))

def summarize_events(events):
    goals=[e['data'] for e in events if e.get('type')=='goal/change' and e.get('data',{}).get('operation')=='create']
    executions=[e['data']['change']['state'] for e in events if e.get('type')=='goal/execution']
    state=executions[-1] if executions else {}
    report=(state.get('latest_turn') or {}).get('report') or {}
    return {'goal_creates':len(goals),'goal_id':(goals[-1].get('goal') or {}).get('id') if goals else None,
        'rounds_started':state.get('rounds_started'),'report_status':report.get('status'),
        'pause_reason':state.get('pause_reason'),'turn_outcome':(state.get('latest_turn') or {}).get('outcome'),
        'running':state.get('running') is not None,'pending':state.get('pending') is not None,'events':len(events)}

def config_read(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>16384 or path.stat().st_mode&0o077:
        raise RuntimeError('model credential fixture must be a bounded private regular file')
    return json.loads(path.read_text())

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True);parser.add_argument('--host-binary',required=True);parser.add_argument('--permit-binary',required=True)
    parser.add_argument('--model-config',required=True)
    args=parser.parse_args()
    lab=module.lab_module.Lab(args.root);item=module.Dedicated(lab);item.promote();vm=item.vm
    if not all(lab.stopped(v) for v in lab.manifest['vms']):raise RuntimeError('all lab VMs must be stopped before acceptance')
    binaries=[Path(args.host_binary).resolve(strict=True),Path(args.permit_binary).resolve(strict=True)]
    if any(not p.is_file() or p.stat().st_size>1024**3 for p in binaries):raise RuntimeError('invalid bounded native artifact')
    host_sha=native.digest(binaries[0]);nonce='goal-'+uuid.uuid4().hex[:16];root='/home/agent/cloud-native/'+nonce;permit=root+'/permit';unit='xh-cloud-'+nonce+'.service';q=shlex.quote
    output=lab.root/'dedicated'/(nonce+'-report.json');rows=[];relay=None;tunnel=None;original_sha=None
    def save():
        module.lab_module.atomic_json(output,{'schema':'xharness-cloud-goal-acceptance/v1','checks':rows,'vm_instance':vm['uuid'],'host_sha256':host_sha,'model':'deepseek-flash','relay':None if relay is None else relay.metrics(),'not_production_task_admission':True})
    def check(name,fn):
        begin=time.monotonic()
        try:
            value=fn();rows.append({'name':name,'status':'passed','seconds':round(time.monotonic()-begin,3),'details':value});print('PASS '+name,flush=True);return value
        except Exception:
            rows.append({'name':name,'status':'failed','seconds':round(time.monotonic()-begin,3)});raise
        finally:save()
    def admin(action,payload=None):
        return json.loads(lab.ssh(vm,q(root+'/xharness-native-permit')+' --journal-dir '+q(permit)+' '+action,input=None if payload is None else json.dumps(payload).encode(),timeout=20))
    def unit_info():
        return dict(line.split('=',1) for line in lab.ssh(vm,'sudo systemctl show '+q(unit)+' --property=ActiveState,ExecStart,MemoryPeak --no-pager',timeout=10,check=False).splitlines() if '=' in line)
    def start_native():
        if unit_info().get('ActiveState') in ('active','activating','deactivating'):raise RuntimeError('duplicate native launch refused')
        lab.ssh(vm,'sudo systemctl reset-failed '+q(unit),check=False)
        command=['sudo','systemd-run','--quiet','--collect','--unit='+unit,'--uid=agent','--property=MemoryMax=1G','--property=MemorySwapMax=0','--property=TasksMax=128','--property=KillMode=control-group','--property=TimeoutStopSec=25s','--property=EnvironmentFile='+root+'/model.env','--setenv=TOKIO_WORKER_THREADS=2','--setenv=HOME=/home/agent',root+'/xharness-host','--bind','127.0.0.1:3082','--workspace',root+'/workspace','--state-dir',root+'/state','--hosted-permit-dir',permit,'--hosted-bootstrap-file',permit+'/bootstrap.json','--provider','deepseek-test','--model','deepseek-flash','--base-url','http://127.0.0.1:8091/v1','--context-window','65536','--max-output-tokens','8192']
        lab.ssh(vm,shlex.join(command),timeout=15)
    def stop_native():
        info=unit_info()
        if info.get('ActiveState') in ('active','activating','deactivating'):
            if root+'/xharness-host' not in info.get('ExecStart',''):raise RuntimeError('native service identity mismatch')
            lab.ssh(vm,'sudo systemctl stop '+q(unit),timeout=45)
    def phase(generation,name):
        def ready():
            try:return admin('launch '+str(generation))['phase']==name
            except Exception:return False
        lab.wait(ready,150);return admin('launch '+str(generation))
    def bridge():
        nonlocal tunnel
        if tunnel:
            tunnel.terminate();tunnel.wait(timeout=15)
        command=lab.ssh_command(vm,'')[:-1]
        command[1:1]=['-N','-o','ExitOnForwardFailure=yes','-R','127.0.0.1:8091:127.0.0.1:'+str(relay.server.server_port)]
        tunnel=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        time.sleep(1)
        if tunnel.poll() is not None:raise RuntimeError('scoped SSH model bridge failed')
    def summary():
        code="import json,pathlib\n"+inspect.getsource(summarize_events)+"\np=pathlib.Path("+repr(root+'/state/sessions/'+nonce+'-root.jsonl')+")\nif p.stat().st_size>8*1024*1024:raise RuntimeError('fixture journal exceeded')\nevents=[e['event'] for line in p.read_text().splitlines() for e in json.loads(line).get('events',[])]\nprint(json.dumps(summarize_events(events)))"
        return json.loads(lab.ssh(vm,'python3 -c '+q(code),timeout=10))
    def start_vm():
        item.operate('start',nonce+'-start');lab.ready(vm);return lab.check_caps(vm)
    def deploy():
        nonlocal original_sha,relay
        original_sha=lab.ssh(vm,'sha256sum /home/agent/xharness-host').split()[0]
        lab.ssh(vm,'umask 077 && test ! -e '+q(root)+' && mkdir -p '+q(root) +' && mkdir '+q(root+'/workspace')+' '+q(root+'/state'))
        for source,name in zip(binaries,['xharness-host','xharness-native-permit']):
            with source.open('rb') as stream:
                result=subprocess.run(lab.ssh_command(vm,'umask 077 && cat > '+q(root+'/'+name)+' && chmod 700 '+q(root+'/'+name)),stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
            if result.returncode:raise RuntimeError('native fixture upload failed')
        if lab.ssh(vm,'sha256sum '+q(root+'/xharness-host')).split()[0]!=host_sha:raise RuntimeError('native artifact digest changed')
        binding={'scope':{'task_id':nonce,'binding_id':nonce+'-binding','environment_instance_id':vm['uuid'],'volume_id':item.environment['volume_id'],'execution_epoch':item.environment['execution_epoch']},'root_session_id':nonce+'-root','host_build_ref':{'id':'goal-test-host','version':host_sha},'external_stop_authorized':True,'external_stop_support':'supported'}
        admin('initialize',{'binding':binding,'workspace':root+'/workspace','state_dir':root+'/state'})
        objective='在当前工作区实现一个纯 Python 3 的 JSON Lines 统计工具 summarize.py。函数 summarize(lines) 返回字典 {valid:合法 JSON 对象行数, invalid:坏行数, counts:按对象的字符串 type 字段计数}；空行忽略，非对象 JSON 算坏行，缺失 type 或非字符串 type 仍计 valid 但不加入 counts。必须跨两个自动 Goal 轮完成：第一轮实现 summarize.py 和 test_summarize.py（至少 5 个 unittest，覆盖 Unicode、空行、坏 JSON、非对象和多种 type），实际执行 python3 -m unittest -v，用现有 goal 工具 action=report 报 progress，remaining 明确保留 README 文档和最终验证，然后结束本轮。第二轮写 README.md 说明输入语义和测试方式，再执行测试，确认验收清单完成后用 goal action=report 报 complete，附三个文件的 artifact 证据，结束本轮等待用户确认。不要联网、安装依赖、部署或修改工作区外文件。'
        criteria=['实现指定统计语义','至少 5 个真实 unittest 通过','完成 README 并通过两阶段自动 Goal 推进','仅修改任务工作区']
        task=json.loads((Path(__file__).resolve().parents[1]/'crates/xharness-cloud/tests/fixtures/submit-v1.json').read_text())['payload']['spec'];task['objective']=objective;task['acceptance_criteria']=criteria
        task['workspace_source']={'kind':'existing_workspace','workspace_ref':{'id':'fixture-workspace','version':'v1'},'expected_fingerprint':'a'*64}
        bootstrap={'scope':binding['scope'],'task_spec':task,'goal':{'operation_id':nonce+'-prepare','session_id':binding['root_session_id'],'goal_id':nonce+'-goal','objective':objective,'acceptance_criteria':criteria,'max_goal_rounds':3,'created_at_ms':int(time.time()*1000),'workspace':root+'/workspace','provider':'deepseek-test','model':'deepseek-flash','reasoning_effort':None,'context_window_tokens':65536,'permission':'danger-full-access'}}
        lab.ssh(vm,'umask 077 && cat > '+q(permit+'/bootstrap.json'),input=json.dumps(bootstrap).encode())
        relay=Relay(config_read(args.model_config));bridge()
        lab.ssh(vm,'umask 077 && cat > '+q(root+'/model.env'),input=('XHARNESS_API_KEY='+relay.token+'\n').encode())
        return {'fixed_host_sha':host_sha,'vendor_key_not_in_guest':True,'generic_guest_egress_unchanged':True}
    def prepared():
        start_native();phase(1,'prepared_ready')
        result=summary()
        if relay.count()!=0 or result['goal_creates']!=1:raise RuntimeError('Prepared performed model work or duplicated Goal')
        lab.ssh(vm,"! curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:3082/health/ready >/dev/null",timeout=5)
        return result
    def restart_prepared():
        stop_native();receipt=phase(1,'stopped')
        if not receipt['shutdown']['runtime_graceful'] or receipt['shutdown']['sealed']:raise RuntimeError('temporary prepared stop lost authority')
        start_native();phase(2,'prepared_ready')
        if relay.count()!=0 or summary()['goal_creates']!=1:raise RuntimeError('prepared restart duplicated admission')
        return {'generation':2,'one_original_goal':True,'model_requests':0}
    def run_goal():
        head=admin('get');command={'operation_id':nonce+'-activate','scope':head['permit']['scope'],'expected_revision':head['permit']['revision'],'to':'active'}
        ack=admin('transition',command)
        if admin('transition',command)!=ack:raise RuntimeError('activation ack replay mismatch')
        phase(2,'ready');deadline=time.monotonic()+600
        while time.monotonic()<deadline:
            state=summary()
            if state['report_status']=='complete' and not state['running'] and not state['pending']:break
            if state['pause_reason'] and not state['running'] and not state['pending']:
                raise RuntimeError('real Goal paused before acceptance: '+state['pause_reason'])
            if unit_info().get('ActiveState')!='active':raise RuntimeError('original Goal Host stopped during real work')
            time.sleep(2)
        else:raise RuntimeError('real Goal did not reach confirmation-waiting complete report')
        if state['goal_creates']!=1 or (state.get('rounds_started') or 0)<2 or relay.count()==0:raise RuntimeError('real Goal was not uniquely driven')
        result=lab.ssh(vm,'cd '+q(root+'/workspace')+' && python3 -m unittest -v',timeout=30)
        independent="import unittest; from summarize import summarize; suite=unittest.defaultTestLoader.discover('.',pattern='test_summarize.py'); assert suite.countTestCases()>=5; assert summarize(['{\"type\":\"alpha\"}','{\"type\":\"中文\"}','{\"type\":\"alpha\"}','{}','{\"type\":null}','42','bad',' \t']) == {'valid':5,'invalid':2,'counts':{'alpha':2,'中文':1}}; assert summarize([])=={'valid':0,'invalid':0,'counts':{}}; print('independent semantic fixtures passed')"
        lab.ssh(vm,'cd '+q(root+'/workspace')+' && python3 -c '+q(independent),timeout=20)

        files=json.loads(lab.ssh(vm,'python3 -c '+q("import pathlib,json,hashlib; r=pathlib.Path("+repr(root+'/workspace')+"); print(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in r.glob('*.py')}))")))
        if not {'summarize.py','test_summarize.py'}.issubset(files):raise RuntimeError('required task artifacts missing')
        lab.ssh(vm,'test -s '+q(root+'/workspace/README.md'),timeout=10)
        return {'session':state,'artifact_sha256':files,'unittest_exit_zero':True,'at_least_five_tests':True,'independent_semantic_fixtures':True,'native_memory_peak':unit_info().get('MemoryPeak'),'model_requests':relay.count()}
    def restart_completed():
        stop_native();phase(2,'stopped');count=relay.count()
        start_native();phase(3,'ready');time.sleep(3)
        if relay.count()!=count or summary()['goal_creates']!=1:raise RuntimeError('confirmation-waiting Goal was replayed')
        return {'generation':3,'no_duplicate_requests':True,'model_requests':count}
    def cancel_and_quiet():
        head=admin('get');admin('transition',{'operation_id':nonce+'-seal','scope':head['permit']['scope'],'expected_revision':head['permit']['revision'],'to':'sealed'})
        receipt=phase(3,'stopped')
        if receipt['shutdown']!={'sealed':True,'runtime_graceful':True,'forced_workers':0,'cleanup_errors':0}:raise RuntimeError('original runtime stop not graceful')
        before=relay.count();start_native();lab.wait(lambda:unit_info().get('ActiveState') not in ('active','activating','deactivating'),150)
        if native.counter(admin('get')['launch_generation'])!=3 or relay.count()!=before:raise RuntimeError('sealed task was revived')
        if lab.ssh(vm,'sha256sum /home/agent/xharness-host').split()[0]!=original_sha:raise RuntimeError('original Host overwritten')
        lab.ssh(vm,'rm -f -- '+q(root+'/model.env'));item.operate('stop',nonce+'-stop')
        if not all(lab.stopped(v) for v in lab.manifest['vms']):raise RuntimeError('VM stop proof missing')
        return {'all_four_vms_stopped':True,'disk_retained':True,'scoped_guest_credential_removed':True}
    try:
        check('reuse dedicated VM hard caps',start_vm);check('deploy fixed Host and scoped model bridge',deploy);check('Prepared initializes exactly one Goal and zero requests',prepared);check('Prepared restart preserves unique Goal',restart_prepared);check('real DeepSeek programming and independent unittest acceptance',run_goal);check('completed report restart does not replay task',restart_completed);check('seal cannot revive work and external VM is quiet',cancel_and_quiet)
    finally:
        try:
            if not lab.stopped(vm):
                try:stop_native()
                finally:lab.ssh(vm,'rm -f -- '+q(root+'/model.env'),check=False,timeout=10)
        finally:
            if tunnel:tunnel.terminate();tunnel.wait(timeout=15)
            lab.stop(vm)
            if relay:relay.stop()
            save()
    print(json.dumps({'report':str(output),'checks':len(rows),'all_passed':all(r['status']=='passed' for r in rows)}))
if __name__=='__main__':main()
