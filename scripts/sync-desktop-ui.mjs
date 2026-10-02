#!/usr/bin/env node
// A desktop bridge change must go through the same strict, atomic source build;
// no partial copies from old JS can bypass the manifest or output hashes.
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
if(process.argv.length!==2) throw Error('usage: sync-desktop-ui.mjs (no external directory)')
execFileSync(process.execPath,[fileURLToPath(new URL('./assemble-static-ui.mjs',import.meta.url))],{stdio:'inherit'})
