#!/usr/bin/env node
// Both Hosts must be stopped. Explicit owner CLI, no browser write endpoint.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {handoff} from './session-handoff/controller.mjs';
import {Peer, readConfig, sshOptions, quote} from './workspace-sync/transport.mjs';
export async function run(syncConfig, localState, cloudState, direction, session) {
  assert.ok(['local-to-cloud','cloud-to-local'].includes(direction));
  for(const p of [localState,cloudState]) assert.match(p,/^\/[a-zA-Z0-9_./+-]+$/);
  const c=readConfig(syncConfig);
  const args=(e,state,role)=>[state,e.workspace,e.control,e.spool,e.registration,role];
  // Config binaries MUST be the handoff peer, not workspace_sync_peer.
  const local=new Peer(c.local.binary,args(c.local,localState,'local'),{},24*1024*1024+65536);
  const command='exec '+[c.cloud.binary,...args(c.cloud,cloudState,'cloud')].map(quote).join(' ');
  const cloud=new Peer('ssh',[...sshOptions,c.sshHost,command],{},24*1024*1024+65536);
  let report, failure;
  try {report=await handoff(...(direction==='local-to-cloud'?[local,cloud]:[cloud,local]),session);}
  catch(e){failure=e;}
  const stops=await Promise.allSettled([local.close(),cloud.close()]);
  if(stops.some(s=>s.status!=='fulfilled')) throw new Error('native peer clean exit unconfirmed; retain state');
  if(failure) throw failure;
  return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await run(...process.argv.slice(2))));}
  catch {console.error('Session handoff did not complete; retain both native state directories for recovery.');process.exitCode=1;}
}
