import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('../crates/xharness-computer-macos/src/accessibility-snapshot.js', import.meta.url), 'utf8');

function fixture(options = {}, config = {}) {
  let now = 0;
  const reads = {node:0, children:0, menus:0, frontmost:0, secureValue:0};
  const cost = config.cost ?? 1;
  function read(value, kind='node') { reads[kind] = (reads[kind] || 0)+1; now += cost; return value; }
  function node(role='AXButton', children=[]) {
    return {
      role:()=>{ if(config.slowRole) now+=500; return read(role); }, subrole:()=>read(null),
      title:()=>read(role==='AXUnknown'?'':'Save'), name:()=>read(''), description:()=>read(''), help:()=>read(''),
      attributes:{byName:()=>({value:()=>read('')})}, actions:()=>read([]),
      position:()=>read(role==='AXUnknown'?null:[10,20]), size:()=>read([30,40]),
      visible:()=>read(true), enabled:()=>read(true), focused:()=>read(false), selected:()=>read(false),
      value:()=>{ if(role==='AXSecureTextField') reads.secureValue++; return read('value'); },
      uiElements:()=>read(children,'children')
    };
  }
  const count = config.count ?? 30;
  const children = config.children ? config.children(node) : Array.from({length:count},()=>node(config.role));
  const windows = [1,2].map(index=>({
    position:()=>read([0,0],'window'), size:()=>read([500,500],'window'), name:()=>read(`Window ${index}`,'window'),
    attributes:{byName:name=>({value:()=>read(name==='AXFocused','window')})},
    uiElements:()=>read(children,'children')
  }));
  const processes = [1,2].map(pid=>({
    frontmost:()=>read(pid===2,'frontmost'), unixId:()=>read(pid,'process'), name:()=>read(`App ${pid}`,'process'),
    windows:()=>read(windows,'window'), menuBars:()=>read([],'menus')
  }));
  const se = {applicationProcesses:{whose:()=>()=>read(processes,'processes')}};
  const context = vm.createContext({Date:{now:()=>now}, Application:()=>se});
  const result = JSON.parse(vm.runInContext(`${source}\nrun([${JSON.stringify(JSON.stringify(options))}])`, context));
  return {result, reads};
}

test('window list returns all surfaces and never reads controls or menus',()=>{
  const {result,reads} = fixture({include_nodes:false,max_nodes:1});
  assert.equal(result.windows.length,4);
  assert.equal(result.nodes.length,0);
  assert.equal(result.truncated,false);
  assert.equal(reads.node,0);
  assert.equal(reads.children,0);
  assert.equal(reads.menus,0);
  assert.equal(reads.frontmost,2);
  assert.equal(result.windows[0].pid,2);
});
test('time budget returns completed targets, all windows, and an explicit reason',()=>{
  const {result}=fixture({time_budget_ms:120,max_nodes:220});
  assert.equal(result.windows.length,4);
  assert.ok(result.nodes.length>0 && result.nodes.length<30);
  assert.equal(result.truncated,true);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
  assert.ok(result.elapsed_ms<=121);
  assert.equal(result.nodes[0].node_id,'ax:2:w1:0');
  assert.deepEqual(result.nodes[0].path,[0]);
  assert.equal(result.nodes[0].root_index,1);
  for(const node of result.nodes) assert.ok(Object.hasOwn(node,'selected'));
});
test('a single slow property does not publish a half-read control',()=>{
  const {result}=fixture({time_budget_ms:120},{slowRole:true});
  assert.equal(result.windows.length,4);
  assert.equal(result.nodes.length,0);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
});
test('node limit no longer limits the window inventory',()=>{
  const {result}=fixture({max_nodes:1});
  assert.equal(result.windows.length,4);
  assert.equal(result.nodes.length,1);
  assert.deepEqual(result.truncation_reasons,['node_limit']);
});
test('max depth skips descendants but still reads siblings',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[n('AXGroup',[n()]),n()]});
  assert.ok(result.truncation_reasons.includes('depth_limit'));
  assert.ok(result.nodes.some(node=>node.path.join('.')==='1'));
  assert.ok(result.nodes.every(node=>node.depth<=1));
});
test('visit limit stops an unknown-node fanout without fabricating targets',()=>{
  const {result}=fixture({max_nodes:1},{role:'AXUnknown',count:1000});
  assert.equal(result.nodes.length,0);
  assert.equal(result.visited,5);
  assert.deepEqual(result.truncation_reasons,['visit_limit']);
});
test('password controls stay redacted in partial and full observations',()=>{
  const {result,reads}=fixture({max_nodes:1},{role:'AXSecureTextField',count:1});
  assert.equal(result.nodes[0].value,'<redacted>');
  assert.equal(reads.secureValue,0);
});
test('small full tree still returns complete records without false truncation',()=>{
  const {result}=fixture({max_nodes:80},{count:1});
  assert.equal(result.nodes.length,4);
  assert.equal(result.truncated,false);
  assert.deepEqual(result.truncation_reasons,[]);
});
test('deadline during window enumeration is also a partial result',()=>{
  const {result}=fixture({time_budget_ms:15,include_nodes:false});
  assert.ok(result.windows.length>0 && result.windows.length<4);
  assert.equal(result.nodes.length,0);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
});
