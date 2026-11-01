import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {generateWireContract} from './generate-session-terminal-contract.mjs'
const require=createRequire(resolve('ui/package.json')),id='@xlang/xharness-client-ui-browser/display-test'
const out=compileSourceModules(resolve('ui'),[{id,source:'src/modules/browser/file-display/test-exports.ts'}])
let entry;vm.runInNewContext(out.get(id).bytes.toString(),{window:{__ModuleLoader__:{load:x=>entry=x}},TextEncoder,TextDecoder,AbortSignal,DOMException,URL,Blob,Uint8Array,atob});const api=entry.factory(name=>name==='zod'?require('zod'):undefined)
const fixture=JSON.parse(readFileSync('protocol/fixtures/file-display-v1.json','utf8'))
test('Rust-exported display schemas and client guards agree; no handwritten file union',()=>{
 const contract=JSON.parse(readFileSync('protocol/file-display.schema.json','utf8'))
 const emitted=generateWireContract(contract,{source:'crates/xharness-api/src/display.rs',command:'scripts/generate-file-display-contract.mjs',prefix:'FILE_DISPLAY'})
 assert.equal(readFileSync('ui/src/modules/shared/generated/file-display.ts','utf8'),emitted)
 for(const file of fixture.files)assert.equal(api.DisplayFileSchema.safeParse(file).success,true)
 assert.equal(api.DisplayOpenSchema.safeParse(fixture.open).success,true)
 for(const bad of [{...fixture.open,sessionId:undefined},{...fixture.open,owner:'other'}])assert.equal(api.DisplayOpenSchema.safeParse(bad).success,false)
 assert.equal(api.DisplayFileSchema.safeParse({kind:'image',path:'x',mediaType:'image/png',dataBase64:'',width:1.5,height:1}).success,false)
 assert.equal(api.DisplayReadSchema.safeParse({sessionId:'s',path:'x',relativeTo:'y',owner:'other'}).success,false)
})
test('local resource classification never turns remote or executable URLs into file reads',()=>{
 for(const url of ['https://example.com/a.png','javascript:alert(1)','data:image/png;base64,A','file:///etc/passwd','//evil/a.png','#section'])assert.equal(api.localResource(url),undefined)
 for(const [url,path] of [['../figure.png','../figure.png'],['images/a%20b.png','images/a b.png'],['C:\\project\\a.md','C:\\project\\a.md']])assert.equal(api.localResource(url),path)
 assert.equal(api.localResource('%invalid'),undefined)
})
test('preview calls original Host channel with abort and session-relative resource base',async()=>{
 let captured;const client=new api.FileDisplayClient({call:async(...args)=>{captured=args;return {ok:true,value:fixture.files[0]}}})
 const control=new AbortController();const file=await client.read('s','figure.png',control.signal,'/workspace/docs/report.md')
 assert.equal(file.kind,'markdown');assert.equal(captured[0],'/api');assert.equal(captured[1],'display/read');assert.deepEqual(JSON.parse(JSON.stringify(captured[2])),{sessionId:'s',path:'figure.png',relativeTo:'/workspace/docs/report.md'});control.abort();assert.equal(captured[3].aborted,true)
})
test('bad format, oversized bytes, image dimensions and RPC failure fail visibly',async()=>{
 const image=fixture.files[2],variants=[{...image,mediaType:'image/svg+xml'},{...image,width:20000,height:20000},{...image,dataBase64:'AA<script>'},{...image,width:0},{...image,dataBase64:'A'.repeat(12*1024*1024)},{...fixture.files[0],text:'a'.repeat(512*1024+1)}]
 for(const value of variants){const client=new api.FileDisplayClient({call:async()=>({ok:true,value})});await assert.rejects(()=>client.read('s','x',new AbortController().signal))}
 const client=new api.FileDisplayClient({call:async()=>({ok:false,error:{message:'permission denied'}})});await assert.rejects(()=>client.read('s','x',new AbortController().signal),/permission denied/)
})
test('Markdown resources have per-preview count and byte caps; unknown code uses plain fallback',()=>{
 const budget=new api.ResourceBudget();for(let i=0;i<8;i++)assert.equal(budget.admit(),true);assert.equal(budget.admit(),false)
 assert.equal(budget.retain(16*1024*1024),true);assert.equal(budget.retain(1),false)
 const decoded=new api.ResourceBudget();assert.equal(decoded.retain(1,64*1024*1024),true);assert.equal(decoded.retain(1,4),false)
 assert.equal(api.codeLanguage('main.rs'),'rust');assert.equal(api.codeLanguage('README'),undefined)
})

test('native handoff remains explicit and cannot resolve relative files against the wrong Host cwd',async()=>{
 let opened;const client=new api.FileDisplayClient({call:async()=>{}},{available:()=>true,open:async path=>{opened=path}})
 assert.equal(client.canOpenExternal('/workspace/report.md'),true);assert.equal(client.canOpenExternal('report.md'),false)
 await assert.rejects(()=>client.openExternal('report.md'));assert.equal(opened,undefined)
 await client.openExternal('/workspace/report.md');assert.equal(opened,'/workspace/report.md')
})


test('Git scopes are strict and travel through the same file display channel',async()=>{
 assert.equal(api.GitDiffScopeSchema.safeParse('head').success,true);assert.equal(api.GitDiffScopeSchema.safeParse('shell').success,false)
 assert.equal(api.DisplayOpenSchema.safeParse({sessionId:'s',path:'.',gitDiff:'working'}).success,true)
 assert.equal(api.DisplayFileSchema.safeParse({kind:'diff',path:'.',text:'',source:'working'}).success,true)
 assert.equal(api.DisplayFileSchema.safeParse({kind:'diff',path:'.',text:'',source:'invented'}).success,false)
 let payload;const client=new api.FileDisplayClient({call:async(_channel,_endpoint,args)=>{payload=args;return {ok:true,value:{kind:'diff',path:'/workspace',text:'',source:'staged'}}}})
 await client.read('s','.',new AbortController().signal,undefined,'staged')
 assert.deepEqual(JSON.parse(JSON.stringify(payload)),{sessionId:'s',path:'.',gitDiff:'staged'})
})
test('multi-file unified diffs reuse strict Review hunk coordinates; additions/deletions/CRLF survive',()=>{
 const patch='diff --git a/main.rs b/main.rs\n--- a/main.rs\n+++ b/main.rs\n@@ -3,2 +3,2 @@ fn\n keep\n-old\n+new\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n'
 const parsed=api.inspectPatch(patch.replaceAll('\n','\r\n'));assert.equal(parsed.error,undefined);assert.equal(parsed.files.length,2)
 assert.equal(parsed.files[0].path,'main.rs');assert.equal(parsed.files[0].added,1);assert.equal(parsed.files[0].removed,1)
 assert.equal(parsed.files[0].rows[1].left,3);assert.equal(parsed.files[0].rows[3].right,4);assert.equal(parsed.files[1].rows[1].right,1)
 const split=api.splitRows(parsed.files[0].rows);assert.equal(split[2].left.text,'old');assert.equal(split[2].right.text,'new')
 const deleted=api.inspectPatch('--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');assert.equal(deleted.files[0].path,'deleted.txt');assert.equal(deleted.files[0].rows[1].left,1)
})
test('header-looking content stays in its hunk, and plain multi-file patches remain separate',()=>{
 const patch='--- a/first\n+++ b/first\n@@ -1,2 +1,2 @@\n--- text\n+++ text\n context\n--- a/second\n+++ b/second\n@@ -1 +1 @@\n-before\n+after\n'
 const result=api.inspectPatch(patch);assert.equal(result.error,undefined);assert.equal(result.files.length,2);assert.equal(result.files[0].rows[1].text,'-- text');assert.equal(result.files[1].path,'second')
})
test('quoted Unicode paths, binary/rename/mode-only files and no-newline markers display faithfully',()=>{
 const quoted=api.inspectPatch('--- "a/\\344\\270\\255.rs"\n+++ "b/\\344\\270\\255.rs"\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n');assert.equal(quoted.error,undefined);assert.equal(quoted.files[0].path,'中.rs');assert.equal(quoted.files[0].rows.at(-1).kind,'note')
 const binary=api.inspectPatch('diff --git a/img.png b/img.png\nindex a..b 100644\nBinary files a/img.png and b/img.png differ\n');assert.equal(binary.files[0].binary,true)
 const rename=api.inspectPatch('diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n');assert.equal(rename.files[0].rename,true);assert.equal(rename.files[0].oldPath,'old');assert.equal(rename.files[0].path,'new')
 const mode=api.inspectPatch('diff --git a/run b/run\nold mode 100644\nnew mode 100755\n');assert.equal(mode.files[0].mode,'100644 → 100755')
})
test('empty, malformed, unsupported and giant patches never claim a partial valid diff',()=>{
 assert.equal(api.inspectPatch('').files.length,0)
 for(const patch of ['not a diff','--- a/x\n@@ -1 +1 @@\n-old\n+new\n','--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n','--- a/x\n+++ b/x\n@@ -999999999999999999999 +1 @@\n-old\n+new\n','diff --git a/x b/x\n@@@ -1,1 -1,1 +1,1 @@@\n','diff --git a/x b/x\nGIT binary patch\n',('\n').repeat(20001)]) {
  const parsed=api.inspectPatch(patch);if(!patch.trim())continue;assert.ok(parsed.error,patch);assert.equal(parsed.files.length,0)
 }
 const huge='--- a/x\n+++ b/x\n@@ -0,0 +1,20001 @@\n'+'+x\n'.repeat(20001);assert.match(api.inspectPatch(huge).error,/too many lines/)
})


test('Git filename metadata and zero-context malformed hunks do not invent coordinates',()=>{
 assert.equal(api.inspectPatch('diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n').files[0].path,'image.png')
 assert.equal(api.inspectPatch('diff --git a/image name.png b/image name.png\nBinary files a/image name.png and b/image name.png differ\n').files[0].path,'image name.png')
 for(const patch of ['diff --git a/x b/x\nindex a..b 100644\n','--- a/x\n+++ b/x\n','diff --git a/x b/x\n@@ malformed\n','--- a/x\n+++ b/x\n@@ -0,0 +0,0 @@\n+invalid\n','--- a/x\n+++ b/x\n@@ -999999999999999999999,0 +0,0 @@\n'])assert.ok(api.inspectPatch(patch).error)
 const notes=api.inspectPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');assert.equal(notes.files[0].rows.filter(row=>row.kind==='note').length,2)
})

test('reveal capability is explicit; old or non-local openers never masquerade as Finder reveal',async()=>{
 const calls=[]
 const client=new api.FileDisplayClient({}, {available:()=>true,open:async path=>calls.push(['open',path]),canReveal:()=>true,reveal:async path=>calls.push(['reveal',path])})
 assert.equal(client.canReveal('/workspace/a b.md'),true)
 for(const path of ['relative.md','file:///workspace/a','https://example.com','/tmp/a\0b'])assert.equal(client.canReveal(path),false)
 await client.reveal('/workspace/a b.md');await client.openExternal('/workspace/a b.md')
 assert.deepEqual(calls,[['reveal','/workspace/a b.md'],['open','/workspace/a b.md']])
 const legacy=new api.FileDisplayClient({}, {available:()=>true,open:async()=>{throw Error('must not open instead of revealing')}})
 assert.equal(legacy.canReveal('/workspace/a'),false);await assert.rejects(()=>legacy.reveal('/workspace/a'))
 const remote=new api.FileDisplayClient({}, {available:()=>false,open:async()=>{},canReveal:()=>true,reveal:async()=>{}})
 assert.equal(remote.canReveal('/workspace/a'),false)
})
test('PDF previews are bounded, byte-identified blobs, never a model attachment',async()=>{
 const pdf=fixture.files.find(file=>file.kind==='pdf');assert.ok(pdf)
 const client=new api.FileDisplayClient({call:async()=>({ok:true,value:pdf})})
 assert.equal((await client.read('s','report.pdf',new AbortController().signal)).kind,'pdf')
 for(const dataBase64 of ['PHNjcmlwdD4=','JVBERi0<script>','JVBERi0'+'A'.repeat(12*1024*1024)]){
  const bad=new api.FileDisplayClient({call:async()=>({ok:true,value:{...pdf,dataBase64}})})
  await assert.rejects(()=>bad.read('s','x',new AbortController().signal))
 }
 const url=api.pdfObjectUrl(pdf)
 try{const response=await fetch(url);assert.equal(response.headers.get('content-type'),'application/pdf');assert.ok((await response.text()).startsWith('%PDF-'))}finally{URL.revokeObjectURL(url)}
 await assert.rejects(()=>fetch(url))
 assert.equal(api.isHtmlPath('/workspace/hello.HTML'),true);assert.equal(api.isHtmlPath('/workspace/program.ts'),false)
})

test('card metadata validates safe uint64, nullable dimensions and bounded PNG thumbnails',()=>{
 const info={path:'/workspace/deck.pptx',bytes:2048,preview:'unsupported'}
 assert.equal(api.validateInspection(info).bytes,2048)
 for(const value of [{...info,bytes:2**53},{...info,bytes:-1},{...info,bytes:0.5},{...info,modifiedMs:9e15},{...info,width:0},{...info,extra:'no'},{...info,thumbnail:{width:97,height:1,dataBase64:'AA=='}}])assert.throws(()=>api.validateInspection(value))
 assert.equal(api.validateInspection({...info,width:null,height:null,modifiedMs:null}).preview,'unsupported')
 assert.equal(api.DisplayInspectSchema.safeParse({sessionId:'s',path:'x',thumbnail:false,command:'cat'}).success,false)
})
test('metadata cache bounds concurrency/entries, cancellation and session/revision isolation',async()=>{
 let active=0,peak=0,calls=0
 const cache=new api.FileInspectionCache({call:async(_channel,_endpoint,args,signal)=>{
  calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--
  if(signal.aborted)throw new DOMException('Aborted','AbortError')
  return{ok:true,value:{path:args.path,bytes:4,preview:'text'}}
 }})
 await Promise.all(Array.from({length:40},(_,i)=>cache.read('s','p'+i,0,false,new AbortController().signal)))
 assert.equal(peak,2);assert.equal(cache.stats.entries,24)
 await cache.read('s','p39',0,false,new AbortController().signal);assert.equal(calls,40)
 await cache.read('other','p39',0,false,new AbortController().signal);await cache.read('s','p39',1,false,new AbortController().signal);assert.equal(calls,42)
 const aborted=new AbortController();aborted.abort();await assert.rejects(()=>cache.read('s','x',0,true,aborted.signal))
 const failing=new api.FileInspectionCache({call:async()=>({ok:false,error:{message:'unknown endpoint display/inspect'}})})
 assert.equal(await failing.read('s','a',0,false,new AbortController().signal),undefined)
 const missing=new api.FileInspectionCache({call:async(_c,_e,args)=>args.path==='bad'?{ok:false,error:{message:'file not found'}}:{ok:true,value:{path:'good',bytes:0,preview:'text'}}})
 assert.equal(await missing.read('s','bad',0,false,new AbortController().signal),undefined);assert.equal((await missing.read('s','good',0,false,new AbortController().signal)).bytes,0)
})
