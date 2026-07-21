import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import vm from 'node:vm'
import {compileScriptAssets} from './build-script-assets.mjs'
import {scriptAsset} from './fixtures/script-asset-test.mjs'
const windows = Object.fromEntries(['legacy','source'].map(impl=>{
  const window={}; vm.runInNewContext(scriptAsset('desktop-updater.js',impl),{window});return [impl,window]
}))
const copy = value=>JSON.parse(JSON.stringify(value))
test('valid updater wire states preserve projection and command routing against latest master', async()=>{
  for(const phase of ['idle','checking','available','downloading','downloaded','stopping-host','host-force-stopped','installing','recovering-host','installed','error','up-to-date','future-phase']) {
    const snapshot={seq:1,phase,version:'1.2.3',notes:'<img src=x>',message:null,retryAction:'download',downloaded:51,total:100,future: {kept:true}}
    const old=windows.legacy.__XHARNESS_DESKTOP_UPDATER_TEST__, next=windows.source.__XHARNESS_DESKTOP_UPDATER_TEST__
    assert.deepEqual(copy(old.updateView(snapshot)),copy(next.updateView(snapshot)),phase)
    const execute=async api=>{
      const commands=[],controller=api.createController(async (command,args)=>{commands.push([command,args]);return {...snapshot,seq:2,phase:'downloaded'}})
      controller.accept(snapshot);await controller.act();if(controller.confirming)await controller.confirm()
      return {commands:copy(commands),phase:controller.state.phase,seq:controller.state.seq,extra:copy(controller.state.future)}
    }
    assert.deepEqual(await execute(old),await execute(next),phase)
  }
})
test('unknown native updater data is validated without erasing it to any', ()=>{
  const api=windows.source.__XHARNESS_DESKTOP_UPDATER_TEST__,c=api.createController(async()=>{})
  c.accept({seq:1,phase:'available',future:{preserved:true}})
  for(const value of [null,[],false,'payload',{}, {seq:'2',phase:'installed'}, {seq:NaN}, {seq:Infinity},
    {seq:Number.MAX_SAFE_INTEGER+1}, {seq:2,phase:5}, {seq:2,notes:{}}, {seq:2,version:[]},
    {seq:2,message:false}, {seq:2,retryAction:'execute-anything'}, {seq:2,downloaded:'100'},
    {seq:2,downloaded:Infinity}, {seq:2,total:{}}, {seq:2,total:NaN}]) {
    c.accept(value);assert.equal(c.state.seq,1);assert.equal(c.state.phase,'available')
  }
  c.accept({seq:2,phase:'downloading',downloaded:5,total:null})
  assert.equal(c.state.seq,2);assert.equal(c.state.total,null)
  assert.doesNotMatch(api.updateView(c.state).label,/NaN|Infinity|%/)
})
test('script compiler is deterministic, has no runtime package imports, and rejects assertions', ()=>{
  const rows=['startup','titlebar','updater','logo-motion'].map(name=>({path:name+'.js',source:'src/desktop/'+name+'.ts'}))
  const first=compileScriptAssets(resolve('ui'),rows),second=compileScriptAssets(resolve('ui'),rows)
  for(const [path,built] of first) {
    assert.deepEqual(built.bytes,second.get(path).bytes)
    assert.doesNotMatch(built.bytes.toString(),/\brequire\s*\(/)
    assert.ok(built.sources.some(row=>row.source.startsWith('src/desktop/')))
  }
  const root=mkdtempSync(join(tmpdir(),'xh-script-policy-'))
  try{
    mkdirSync(join(root,'src/desktop'),{recursive:true});writeFileSync(join(root,'src/desktop/bad.ts'),'const x = {} as {id:string}; void x;')
    assert.throws(()=>compileScriptAssets(root,[{source:'src/desktop/bad.ts',path:'bad.js'}]),/unvalidated type assertion/)
    assert.throws(()=>compileScriptAssets(root,[{source:'dist/bad.js',path:'bad.js'}]),/Invalid owned script/)
  }finally{rmSync(root,{recursive:true,force:true})}
})
