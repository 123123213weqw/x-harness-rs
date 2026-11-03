// WZU_Server / macOS CI only. Uses built native peers, real processes and rsync.
// Toy state directories only; never opens installed Host state or credentials.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Peer,peerArgs} from '../workspace-sync/transport.mjs';
import {synchronize} from '../workspace-sync/controller.mjs';
import {handoff} from './controller.mjs';
const [wireBinary,sessionBinary,output]=process.argv.slice(2);assert.ok(wireBinary && sessionBinary);
const root=mkdtempSync(join(tmpdir(),'xh-idle-handoff-process-'));const cases=[];let passed=false;
const args=(e,side)=>[e.state,e.workspace,e.control,e.spool,e.registration,side];
function peer(e,side,fault){return new Peer(sessionBinary,args(e,side),{env:{...process.env,...(fault?{XHARNESS_HANDOFF_EXIT_AFTER:fault}:{})}},24*1024*1024+65536);}
function seed(state,content='old task 中文',cwd){
  const path=join(state,'sessions');mkdirSync(path,{recursive:true,mode:0o700});
  const header={version:1,id:'old-session',created_at_ms:1,cwd};
  const events=[['session/model-selected',{provider:'fixture',model:'fixture'}],['plan/mode',{active:true}],['turn/start',{turn:1}],['user/message',{message:{role:'user',content,reasoning:''}}],['step/start',{turn:1,step:1}],['assistant/message',{turn:1,step:1,message:{role:'assistant',content:'previous result',reasoning:''},usage:{native_float:1,large_integer:9007199254740992}}],['step/end',{turn:1,step:1}],['turn/end',{turn:1,reason:{kind:'completed'}}]].map(([type,data],seq)=>({seq,revision:1,timestamp_ms:10,event:{type,data}}));
  // Enum TurnEndReason is internally tagged; verify with the native parser.
  const bytes=JSON.stringify({record:'header',format:'xharness.session.jsonl',format_version:1,header})+'\n'+JSON.stringify({record:'batch',previous_revision:0,revision:1,events})+'\n';
  writeFileSync(join(path,'old-session.jsonl'),bytes.replace('"native_float":1','"native_float":1.0').replace('"large_integer":9007199254740992','"large_integer":9007199254740993'),{mode:0o600});return events;
}
async function fixture(content){
  const path=mkdtempSync(join(root,'pair-'));const c={};
  for(const side of ['local','cloud']){
    const e={workspace:join(path,side),control:join(path,side+'-control'),spool:join(path,side+'-spool'),state:join(path,side+'-state'),registration:randomBytes(32).toString('hex')};
    for(const p of [e.workspace,e.control,e.spool,e.state])mkdirSync(p,{mode:0o700});c[side]=e;
  }
  const binding={version:1,pair:'session-probe',epoch:1,policy:{id:'personal-workspace-capture',version:'v2-sync-reserved-unicode16-fold-unicode17-nfd'}};
  for(const side of ['local','cloud'])binding[side]=JSON.parse(execFileSync(wireBinary,peerArgs(c[side],side,'provision'),{encoding:'utf8'}));
  for(const side of ['local','cloud'])execFileSync(wireBinary,peerArgs(c[side],side,'bind'),{input:JSON.stringify(binding)});
  writeFileSync(join(c.local.workspace,'main.rs'),'fn main() {}\n');
  const l=new Peer(wireBinary,peerArgs(c.local,'local')),r=new Peer(wireBinary,peerArgs(c.cloud,'cloud'));
  try{await synchronize(l,r,async(side,hashes)=>{if(hashes.length)execFileSync('rsync',['-r','--checksum','--files-from=-','--',c[side].spool+'/',c[side==='local'?'cloud':'local'].spool+'/'],{input:hashes.join('\n')+'\n'});});}
  finally{await Promise.all([l.close(),r.close()]);}
  const events=seed(c.local.state,content,realpathSync(c.local.workspace));return {c,events};
}
async function run(c,{reverse=false,cut,fault}={}){
  const l=peer(c.local,'local',fault?.side==='local'?fault.operation:undefined),r=peer(c.cloud,'cloud',fault?.side==='cloud'?fault.operation:undefined);
  let value,error;
  try{value=await handoff(...(reverse?[r,l]:[l,r]),'old-session',async phase=>{if(phase===cut){l.child.kill('SIGTERM');r.child.kill('SIGTERM');throw new Error('acceptance disconnect');}});}
  catch(e){error=e;}
  const stops=await Promise.allSettled([l.close(),r.close()]);if(!error&&stops.some(s=>s.status!=='fulfilled'))error=new Error('unclean peer exit');if(error)throw error;return value;
}
try{
  {
    const {c,events}=await fixture('context '.repeat(350000));
    const receipt=await run(c);assert.equal(receipt.epoch,1);
    const journal=join(c.cloud.state,'sessions/old-session.jsonl');const records=readFileSync(journal,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records[1].events,events);assert.ok(readFileSync(journal,'utf8').includes('"native_float":1.0'));assert.ok(readFileSync(journal,'utf8').includes('9007199254740993'));assert.equal(records[0].header.cwd,realpathSync(c.cloud.workspace));
    const inode=statSync(journal,{bigint:true}).ino;await run(c);assert.equal(statSync(journal,{bigint:true}).ino,inode);
    const returned=await run(c,{reverse:true});assert.equal(returned.epoch,2);
    assert.equal(JSON.parse(readFileSync(join(c.local.state,'sessions/old-session.handoff-state'),'utf8')).phase,'active');
    assert.equal(JSON.parse(readFileSync(join(c.cloud.state,'sessions/old-session.handoff-state'),'utf8')).phase,'released');
    cases.push({name:'large_text_full_log_roundtrip_epoch2_and_idempotent_inode',passed:true});
  }
  for(const cut of ['frozen','prepared','released','active']){
    const {c}=await fixture();await assert.rejects(run(c,{cut}));
    const before=existsSync(join(c.cloud.state,'sessions/old-session.jsonl'))?statSync(join(c.cloud.state,'sessions/old-session.jsonl'),{bigint:true}).ino:null;
    await run(c);if(before!==null)assert.equal(statSync(join(c.cloud.state,'sessions/old-session.jsonl'),{bigint:true}).ino,before);
    cases.push({name:'controller_disconnect_'+cut,passed:true});
  }
  for(const [side,operation] of [['local','freeze'],['cloud','prepare'],['local','release'],['cloud','activate']]){
    const {c}=await fixture();await assert.rejects(run(c,{fault:{side,operation}}));await run(c);
    cases.push({name:'process_exit_before_reply_'+operation,passed:true});
  }
  {
    const {c}=await fixture();const one=peer(c.local,'local');await one.call({operation:'describe'});
    const two=peer(c.local,'local');await assert.rejects(two.call({operation:'describe'}));await assert.rejects(two.close());await one.close();
    const journal=join(c.local.state,'sessions/old-session.jsonl');
    const original=readFileSync(journal,'utf8');const lines=original.trim().split('\n');const head=JSON.parse(lines[0]);head.header.cwd='/';lines[0]=JSON.stringify(head);writeFileSync(journal,lines.join('\n')+'\n');
    await assert.rejects(run(c));assert.ok(!existsSync(join(c.local.state,'sessions/old-session.handoff-state')));writeFileSync(journal,original);
    writeFileSync(join(c.cloud.workspace,'main.rs'),'changed after checkpoint');const dirty=peer(c.cloud,'cloud');await assert.rejects(dirty.call({operation:'describe'}));await assert.rejects(dirty.close());
    cases.push({name:'native_state_directory_ownership_and_dirty_code_rejected',passed:true});
  }
  passed=true;
}finally{
  if(output)writeFileSync(output,JSON.stringify({scope:'real_native_session_processes',platform:process.platform,passed,cases,...(!passed?{retained_fixture:root}:{})},null,2)+'\n');
  if(passed)rmSync(root,{recursive:true});
}
console.log(JSON.stringify({passed,cases:cases.length}));
