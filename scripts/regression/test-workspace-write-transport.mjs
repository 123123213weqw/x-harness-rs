#!/usr/bin/env node
// True Mac native root <-> verified SSH + rsync <-> WZU native root. Disposable
// owner fixtures only. No production roots/credentials/App mutation or local Rust.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { synchronize } from '../workspace-sync/controller.mjs';
import { openPeers, transfer, peerArgs, sshOptions, quote, Peer } from '../workspace-sync/transport.mjs';
const [binary, evidence] = process.argv.slice(2); assert.equal(process.platform,'darwin'); assert.ok(binary && evidence);
const run = 'codex-build/x-harness-rs/runs/workspace-write-transport-v1-20261103';
const ssh = command => execFileSync('ssh',[...sshOptions,'WZU_Server',command],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
const remoteBinary = ssh('readlink -f "$HOME/codex-build/x-harness-rs/target-personal-handoff/debug/examples/workspace_sync_peer"').trim();
const remoteBuild = ssh('readlink -f "$HOME/codex-build/x-harness-rs/target-personal-handoff/debug/examples/workspace_sync_build_probe"').trim();
const remoteRoot = ssh(`mktemp -d "$HOME/${run}/write-probe.XXXXXXXX"`).trim();
assert.match(remoteRoot, /^\/[a-zA-Z0-9_./+-]+\/write-probe\.[a-zA-Z0-9]+$/);
const localRoot = realpathSync(mkdtempSync(join(tmpdir(),'xh-wire-network-')));
const config = {sshHost:'WZU_Server',local:{binary,workspace:join(localRoot,'source'),control:join(localRoot,'control'),spool:join(localRoot,'spool'),registration:randomBytes(32).toString('hex')},cloud:{binary:remoteBinary,workspace:remoteRoot+'/source',control:remoteRoot+'/control',spool:remoteRoot+'/spool',registration:randomBytes(32).toString('hex')}};
for (const p of [config.local.workspace,config.local.control,config.local.spool]) mkdirSync(p,{mode:0o700});
ssh([config.cloud.workspace,config.cloud.control,config.cloud.spool].map(p=>`mkdir -m 700 ${quote(p)}`).join(' && '));
const native = (side,mode,input) => {
 const e=config[side]; const args=peerArgs(e,side,mode);
 return side==='local'?execFileSync(e.binary,args,{input,encoding:'utf8',timeout:20000}):execFileSync('ssh',[...sshOptions,'WZU_Server',[e.binary,...args].map(quote).join(' ')],{input,encoding:'utf8',timeout:20000});
};
const receipt = {scope:'real_Mac_WZU_native_write_and_rsync',passed:false,checks:[],local_rust_compilation:false,installed_app_changed:false,local_root:localRoot,remote_root:remoteRoot};
let processesClean=true;
async function runSync({cut,fault}={}) {
 const p=openPeers(config);
 if (fault) {
  // Replace the unused fresh remote channel with a separately observed native
  // owner fault process. No wire request can enable this environment variable.
  await p.cloud.close();
  const cmd=['env',`XHARNESS_SYNC_PEER_EXIT_AFTER=${fault}`,config.cloud.binary,...peerArgs(config.cloud,'cloud')].map(quote).join(' ');
  p.cloud=new Peer('ssh',[...sshOptions,'WZU_Server',cmd]);
 }
 let report,error;
 try {report=await synchronize(p.local,p.cloud,(side,objects)=>transfer(config,side,objects),label=>{if(label===cut){p.cloud.child.kill('SIGTERM');throw new Error('owned SSH channel interruption');}});}
 catch(e){error=e;}
 const stops=await Promise.allSettled([p.local.close(),p.cloud.close()]);
 if (stops.some(s=>s.status!=='fulfilled') && !error) error=new Error('clean exit unconfirmed');
 if (error) throw error;
 return report;
}
try {
 const binding={version:1,pair:'mac-wzu-probe',epoch:1,local:JSON.parse(native('local','provision')),cloud:JSON.parse(native('cloud','provision')),policy:{id:'personal-workspace-capture',version:'v2-sync-reserved-unicode16-fold-unicode17-nfd'}};
 for(const side of ['local','cloud']) native(side,'bind',JSON.stringify(binding));
 const payload=Buffer.from(Array.from({length:524299},(_,i)=>i%251));
 mkdirSync(join(config.local.workspace,'中文'));writeFileSync(join(config.local.workspace,'中文/data.bin'),payload);
 writeFileSync(join(config.local.workspace,'main.rs'),'fn main() { println!("wire-sync-build-ok"); }\n');writeFileSync(join(config.local.workspace,'.env'),'fixture-excluded');
 const one=await runSync();assert.equal(one.generation,1);
 assert.equal(ssh(`sha256sum ${quote(config.cloud.workspace+'/中文/data.bin')}`).split(' ')[0],createHash('sha256').update(payload).digest('hex'));
 assert.equal(ssh(`test ! -e ${quote(config.cloud.workspace+'/.env')} && printf excluded`),'excluded');
 receipt.checks.push('mac_to_linux_binary_unicode_full_hash','env_excluded');
 ssh(`printf cloud-return > ${quote(config.cloud.workspace+'/remote.txt')}`);
 const two=await runSync();assert.equal(two.generation,2);assert.equal(readFileSync(join(config.local.workspace,'remote.txt'),'utf8'),'cloud-return');
 receipt.checks.push('linux_to_mac_source_write');
 const inode=statSync(join(config.local.workspace,'remote.txt'),{bigint:true}).ino;assert.ok((await runSync()).unchanged);assert.equal(statSync(join(config.local.workspace,'remote.txt'),{bigint:true}).ino,inode);
 receipt.checks.push('no_op_does_not_republish');
 for (const cut of ['staged','decision','cloud_released']) {
  writeFileSync(join(config.local.workspace,'resume.txt'),cut);
  await assert.rejects(runSync({cut}));
  const recovered=await runSync();assert.equal(recovered.recovered,true);assert.equal(ssh(`cat ${quote(config.cloud.workspace+'/resume.txt')}`),cut);
  receipt.checks.push(`ssh_disconnect_${cut}_recovered`);
 }
 writeFileSync(join(config.local.workspace,'lost-reply.txt'),'apply-once');
 await assert.rejects(runSync({fault:'apply'}));
 const appliedInode=ssh(`stat -c %i ${quote(config.cloud.workspace+'/lost-reply.txt')}`).trim();
 const recovered=await runSync();assert.equal(recovered.recovered,true);assert.equal(ssh(`stat -c %i ${quote(config.cloud.workspace+'/lost-reply.txt')}`).trim(),appliedInode);receipt.checks.push('remote_process_exit_before_apply_reply_recovered_same_inode');
 ssh(`mkdir -m 700 ${quote(remoteRoot+'/snapshot')} ${quote(remoteRoot+'/cache')} ${quote(remoteRoot+'/journal')}`);
 const rustc=ssh('export PATH="$HOME/.cargo/bin:$PATH"; rustup which rustc').trim();
 const buildArgs=[config.cloud.workspace,config.cloud.control,config.cloud.spool,config.cloud.registration,remoteRoot+'/snapshot',remoteRoot+'/cache',remoteRoot+'/journal',rustc];
 const build=JSON.parse(ssh(`XHARNESS_REMOTE_RUST=1 ${[remoteBuild,...buildArgs].map(quote).join(' ')}`));
 assert.equal(build.success,true);assert.match(build.stdout,/wire-sync-build-ok/);assert.equal(build.local_fallback,false);assert.equal(build.checkpoint.pair,binding.pair);assert.equal(build.checkpoint.generation,String(recovered.generation));assert.equal(build.checkpoint.manifest,recovered.common_base_sha256);receipt.build=build;
 receipt.checks.push('synchronized_committed_checkpoint_real_remote_rustc_build');
 writeFileSync(join(config.local.workspace,'remote.txt'),'local-conflict');ssh(`printf remote-conflict > ${quote(config.cloud.workspace+'/remote.txt')}`);
 await assert.rejects(runSync());assert.equal(readFileSync(join(config.local.workspace,'remote.txt'),'utf8'),'local-conflict');assert.equal(ssh(`cat ${quote(config.cloud.workspace+'/remote.txt')}`),'remote-conflict');
 receipt.checks.push('dual_edit_conflict_no_overwrite');
 writeFileSync(join(config.local.workspace,'remote.txt'),'cloud-return');ssh(`printf cloud-return > ${quote(config.cloud.workspace+'/remote.txt')}`);
 unlinkSync(join(config.local.workspace,'remote.txt'));await assert.rejects(runSync());assert.equal(ssh(`cat ${quote(config.cloud.workspace+'/remote.txt')}`),'cloud-return');
 receipt.checks.push('deletion_not_propagated');
 receipt.passed=true;
} catch {
 receipt.failure="cross_machine_acceptance_failed";
} finally {
 // Verify only this fixture's exact executable/argv before any fixture cleanup.
 try {
  const command=`python3 -c ${quote('import os,json; binary='+JSON.stringify(remoteBinary)+'; root='+JSON.stringify(config.cloud.workspace)+'; found=[]\nfor p in os.listdir("/proc"):\n if not p.isdigit(): continue\n try:\n  if os.readlink("/proc/"+p+"/exe")==binary and root.encode() in open("/proc/"+p+"/cmdline","rb").read().split(b"\\0"): found.append(int(p))\n except (OSError,ProcessLookupError): pass\nprint(json.dumps(found))')}`;
  receipt.remaining_remote_pids=JSON.parse(ssh(command));processesClean=receipt.remaining_remote_pids.length===0;
 } catch {processesClean=false;}
 receipt.clean_exit_confirmed=processesClean;
 if (!processesClean) receipt.passed=false;
 writeFileSync(evidence,JSON.stringify(receipt,null,2)+'\n');
 if (receipt.passed) {rmSync(localRoot,{recursive:true});ssh(`rm -rf -- ${quote(remoteRoot)}`);}
}
assert.equal(receipt.passed,true,'retain failed fixtures for owner recovery');console.log(JSON.stringify({passed:true,checks:receipt.checks.length,build:receipt.build.checkpoint}));
