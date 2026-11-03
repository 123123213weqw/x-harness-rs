#!/usr/bin/env node
// Explicit owner CLI, not a browser endpoint or automatically activated service.
import { pathToFileURL } from 'node:url';
import { synchronize } from './workspace-sync/controller.mjs';
import { openPeers, readConfig, transfer } from './workspace-sync/transport.mjs';
export async function run(config) {
  const { local, cloud } = openPeers(config);
  let report; let failure;
  try { report = await synchronize(local, cloud, (side, objects) => transfer(config, side, objects)); }
  catch (e) { failure = e; }
  const stops = await Promise.allSettled([local.close(), cloud.close()]);
  if (stops.some(s => s.status !== 'fulfilled')) throw new Error('native peer clean exit not confirmed; journals retained');
  if (failure) throw failure;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await run(readConfig(process.argv[2])))); }
  catch (error) { console.error(`Workspace synchronization did not complete (${error.code ?? 'transport_or_state_failure'}); journals retained.`); process.exitCode = 1; }
}
