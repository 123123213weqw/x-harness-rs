#!/usr/bin/env node
// Compatibility entry: rebuild all owned UI sources so bytes, graph and boot
// stay coherent. This intentionally no longer performs a partial bundle patch.
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
if(process.argv.length>3)throw Error('usage: update-context-composition-dist.mjs [OUTPUT_DIRECTORY]')
const root=fileURLToPath(new URL('../',import.meta.url))
console.error('update-context-composition-dist.mjs: using the complete owned-source UI build')
const result=spawnSync(process.execPath,[resolve(root,'scripts/assemble-static-ui.mjs'),'--out-dir',resolve(process.argv[2]??resolve(root,'ui/dist'))],{cwd:root,stdio:'inherit'})
if(result.error)throw result.error
if(result.signal)throw Error(`UI build terminated by ${result.signal}`)
if(!Number.isInteger(result.status))throw Error('UI build did not return an exit status')
process.exitCode=result.status
