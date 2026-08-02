import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../ui/package.json',import.meta.url)),{buildSync}=require('esbuild'),module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:[new URL('../ui/src/modules/code-review/structured.ts',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,{module,exports:module.exports,Set,Map})
const {diffLines,decodeReviewReport,reportIsStale}=module.exports,plain=value=>JSON.parse(JSON.stringify(value))
const patch='@@ -10,2 +10,3 @@ fn call()\n context\n-old\n+new\n+return foo;'
const snapshot={account:'alice',repository:'org/repo',number:7,headSha:'a'.repeat(40),files:[{path:'src/main.rs',patch,status:'modified',additions:2,deletions:1}],filesHasMore:false,changedFiles:1}
const finding={priority:1,title:'Invalid return',explanation:'A concrete trigger and consequence',path:'src/main.rs',side:'right',startLine:11,endLine:12,evidence:'new\nreturn foo;'}
const decode=(findings=[],state=snapshot)=>decodeReviewReport(JSON.stringify({version:1,findings}),state)
test('hunk coordinates distinguish old and new sides, not patch offsets',()=>{
 assert.deepEqual(plain(diffLines(patch)),[{side:'left',line:10,text:'context'},{side:'right',line:10,text:'context'},{side:'left',line:11,text:'old'},{side:'right',line:11,text:'new'},{side:'right',line:12,text:'return foo;'}])
})
test('added/deleted files, multiple hunks, CRLF and no-newline marker',()=>{
 assert.deepEqual(plain(diffLines('@@ -0,0 +1 @@\r\n+new\r\n\\ No newline at end of file\r\n')),[{side:'right',line:1,text:'new'}])
 assert.deepEqual(plain(diffLines('@@ -1 +0,0 @@\n-old')),[{side:'left',line:1,text:'old'}])
 assert.equal(diffLines('@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n same').length,4)
})
test('malformed or truncated hunks provide no trustworthy locations',()=>{
 for(const value of [null,'','header only','@@ -1,2 +1,2 @@\n one','@@ -0 +0 @@\n a','@@ -1 +1 @@\n a\n extra','@@ -1 +1 @@\n?bad','@@ -999999999999999999999 +1 @@\n a'])assert.equal(diffLines(value).length,0)
})
test('valid evidence links a finding but does not confirm the defect or copy model metadata',()=>{
 const result=decodeReviewReport(JSON.stringify({version:1,target:{account:'evil',headSha:'fake'},findings:[{...finding,id:'spoofed',disposition:'confirmed'}]}),snapshot)
 assert.equal(result.findings.length,1);assert.equal(result.findings[0].validation,'evidence-linked');assert.equal(result.findings[0].disposition,'needs-confirmation');assert.equal(result.findings[0].id,'finding-1');assert.deepEqual(plain(result.target),{account:'alice',repository:'org/repo',number:7,headSha:'a'.repeat(40)})
})
test('left-side deleted code is supported and right-side lines cannot cite it',()=>{
 assert.equal(decode([{...finding,side:'left',startLine:11,endLine:11,evidence:'old'}]).findings.length,1)
 assert.equal(decode([{...finding,startLine:11,endLine:11,evidence:'old'}]).findings.length,0)
})
test('unknown files, traversal paths, absent lines, reversed ranges and fabricated evidence are rejected',()=>{
 for(const fields of [{path:'src/unknown.rs'},{path:'../secrets'},{path:'/etc/passwd'},{path:'src\\main.rs'},{startLine:0},{startLine:12,endLine:11},{startLine:90,endLine:91},{startLine:10,endLine:50},{evidence:'new\nreturn bar;'},{evidence:'new '},{side:'both'},{priority:4},{priority:'P1'},{title:''},{explanation:''}]){
  const result=decode([{...finding,...fields}]);assert.equal(result.findings.length,0,JSON.stringify(fields));assert.equal(result.rejected.length,1);assert.equal(result.outcome,'invalid-findings')
 }
})
test('cross-hunk gaps cannot be presented as contiguous evidence',()=>{
 const state={...snapshot,files:[{...snapshot.files[0],patch:'@@ -1 +1 @@\n a\n@@ -3 +3 @@\n b'}]}
 assert.equal(decode([{...finding,startLine:1,endLine:3,evidence:'a\nb'}],state).findings.length,0)
})
test('duplicates are retained once; a bad item does not discard valid evidence',()=>{
 const result=decode([finding,finding,{...finding,path:'other'}]);assert.equal(result.findings.length,1);assert.equal(result.rejected.length,2);assert.equal(result.outcome,'findings')
})
test('coverage is derived from supplied data, never model claims; empty results do not mean approval',()=>{
 assert.equal(decode([]).outcome,'no-findings-in-supplied-scope');assert.equal(decode([]).scopeIncomplete,false)
 for(const state of [{...snapshot,filesHasMore:true},{...snapshot,changedFiles:2},{...snapshot,files:[{...snapshot.files[0],patch:null}]}])assert.equal(decode([],state).scopeIncomplete,true)
 assert.deepEqual(plain(decode([],{...snapshot,files:[{...snapshot.files[0],patch:null}]}).unavailableFiles),['src/main.rs'])
})
test('account, PR, repository and exact commit bind the report and mark stale results',()=>{
 const result=decode([finding]);assert.equal(reportIsStale(result,snapshot),false);assert.equal(reportIsStale(result,{...snapshot,repository:'ORG/REPO'}),false)
 for(const fields of [{account:'bob'},{repository:'other/repo'},{number:8},{headSha:'b'.repeat(40)}])assert.equal(reportIsStale(result,{...snapshot,...fields}),true)
})
test('invalid envelope, partial output and oversized reports never become completed reports',()=>{
 for(const raw of ['{"version":1,','broken','{}','{"version":2,"findings":[]}',JSON.stringify({version:1,findings:Array(101).fill(finding)}),' '.repeat(1024*1024+1)])assert.throws(()=>decodeReviewReport(raw,snapshot))
})
