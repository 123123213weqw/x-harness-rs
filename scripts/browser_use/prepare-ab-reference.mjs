#!/usr/bin/env node
// Reproduce the isolated official reference without vendoring it into production.
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const home=dirname(fileURLToPath(import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');if(i<0)throw Error('Use --output=... [--checkout=...]');return[arg.slice(2,i),arg.slice(i+1)];}));
if(!args.output)throw Error('An explicit new isolated --output directory is required');
const output=resolve(args.output), manifest=JSON.parse(await readFile(join(home,'reference/source-manifest.json'),'utf8'));
await mkdir(output,{recursive:false,mode:0o700});
for(const name of ['ab-reference.mjs','check-reference-shim.mjs','build-reference.mjs','source-manifest.json','package.json','README.reference.txt'])await copyFile(join(home,'reference',name),join(output,name));
for(const entry of manifest.files){
 let bytes;
 if(args.checkout){bytes=(await promisify(execFile)('git',['show',`${manifest.revision}:${entry.path}`],{cwd:resolve(args.checkout),encoding:'buffer',maxBuffer:1024*1024})).stdout;}
 else{let last;for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(`https://raw.githubusercontent.com/zai-org/ZCode/${manifest.revision}/${entry.path}`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`Reference HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());break;}catch(error){last=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}}if(!bytes)throw last;}
 if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256||createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')!==entry.gitBlob)throw Error(`Pinned reference bytes mismatch: ${entry.path}`);
 const path=join(output,'original',entry.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);console.log(`Verified exact original blob: ${entry.path}`);
}
console.log(JSON.stringify({output,revision:manifest.revision,next:['npm install --ignore-scripts --no-audit --no-fund','node build-reference.mjs','node check-reference-shim.mjs'],warning:'Build and real browser execution belong on V100. Transpilation is not full ZCode monorepo typechecking or agent acceptance.'}));
