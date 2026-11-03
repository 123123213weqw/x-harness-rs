import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from './controller.mjs';
import { validateConfig, readConfig, transfer } from './transport.mjs';
const endpoint = side => ({binary:'/private/tmp/peer',workspace:`/private/tmp/${side}`,control:`/private/tmp/${side}-control`,spool:`/private/tmp/${side}-spool`,registration:'a'.repeat(64)});
const config = () => ({local:endpoint('local'),cloud:endpoint('cloud'),sshHost:'WZU_Server'});
test('native owner config: no shell/rsync path injection, unknown fields or options',()=>{
  validateConfig(config());
  for (const value of ['-oProxyCommand=evil','host;id','a b','host:22']) assert.throws(()=>validateConfig({...config(),sshHost:value}));
  for (const value of ['/tmp/x;id','/tmp/../x','/tmp/space here','/tmp//x','relative']) assert.throws(()=>validateConfig({...config(),local:{...endpoint('local'),spool:value}}));
  assert.throws(()=>validateConfig({...config(),program:'/bin/sh'}));
});
test('config requires owner-only regular single-link file; symlink denied',()=>{
  const root=mkdtempSync(join(tmpdir(),'xh-wire-config-'));
  try {
    const file=join(root,'config');writeFileSync(file,JSON.stringify(config()),{mode:0o600});assert.deepEqual(readConfig(file),config());
    symlinkSync(file,join(root,'alias'));assert.throws(()=>readConfig(join(root,'alias')));
    const publicFile=join(root,'public');writeFileSync(publicFile,JSON.stringify(config()),{mode:0o644});assert.throws(()=>readConfig(publicFile));
    const oversized=join(root,'large');writeFileSync(oversized,'x'.repeat(16385),{mode:0o600});assert.throws(()=>readConfig(oversized));
  } finally {rmSync(root,{recursive:true});}
});
test('object names are bounded SHA256 only, never transfer-selected paths',async()=>{
  for (const objects of [['../escape'],['--delete'],['a'.repeat(64),'a'.repeat(64)],Array(257).fill('a'.repeat(64))]) await assert.rejects(transfer(config(),'local',objects));
  await assert.rejects(transfer(config(),'unknown',[]));await transfer(config(),'local',[]);
});

test('coordinator rejects binding drift and peer pending state before any transfer or mutation',async()=>{
  for (const variant of ['binding','pending']) {
    const calls=[];
    const local={call:async request=>{calls.push(request.operation);return {role:'local',binding:{pair:'a'},base:{generation:0},round:null};}};
    const cloud={call:async request=>{calls.push(request.operation);return {role:'cloud',binding:{pair:variant==='binding'?'b':'a'},base:{generation:0},round:variant==='pending'?{id:'unresolved'}:null};}};
    await assert.rejects(synchronize(local,cloud,()=>assert.fail('must not transfer')));
    assert.deepEqual(calls,['status','status']);
  }
});
