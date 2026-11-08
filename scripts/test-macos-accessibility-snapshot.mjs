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
      role:()=>{ if(config.slowRole) now+=500; if(config.slowMenuRole && role==='AXMenuBar') now+=1000; return read(role); }, subrole:()=>read(null),
      title:()=>read(role==='AXUnknown'?'':'Save'), name:()=>read('','name'), description:()=>read(''), help:()=>read('','help'),
      attributes:{byName:()=>({value:()=>read('')})}, actions:()=>read([]),
      position:()=>read(role==='AXUnknown'?null:[10,20]), size:()=>read([30,40]),
      visible:()=>read(true), enabled:()=>read(true), focused:()=>read(false), selected:()=>read(false),
      value:()=>{ if(role==='AXSecureTextField') reads.secureValue++; return read('value'); },
      uiElements:()=>read(children,'children')
    };
  }
  const count = config.count ?? 30;
  const children = config.children ? config.children(node) : Array.from({length:count},()=>node(config.role));
  const windows = pid => Array.from({length:pid===1 ? (config.backgroundWindows ?? 2) : 2},(_,index)=>({
    position:()=>read(config.position?.(pid) ?? [0,0],'window'), size:()=>read([500,500],'window'), name:()=>read(`Window ${index}`,'window'),
    attributes:{byName:name=>({value:()=>read(name==='AXFocused','window')})},
    uiElements:()=>read(children,'children')
  }));
  const processes = [1,2].map(pid=>({
    _frontmost:pid===2, frontmost:()=>read(pid===2,'frontmost'), unixId:()=>read(pid,'process'), name:()=>read(`App ${pid}`,'process'),
    windows:()=>read(windows(pid),'window'), menuBars:()=>read(config.menus ? [node('AXMenuBar',Array.from({length:config.menuCount ?? 1000},()=>node('AXMenuItem')))] : [],'menus')
  }));
  const se = {applicationProcesses:{whose:criteria=>()=>read(processes.filter(p=>criteria.frontmost===undefined || p._frontmost===criteria.frontmost),'processes')}};
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
  assert.equal(reads.frontmost,0);
  assert.equal(result.windows[0].pid,2);
});
test('time budget prioritizes completed foreground targets before global inventory',()=>{
  const {result}=fixture({time_budget_ms:120,max_nodes:220});
  assert.equal(result.windows.length,1);
  assert.equal(result.inventory_complete,false);
  assert.equal(result.scope,'frontmost_windows');
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
  assert.equal(result.windows.length,1);
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
  assert.equal(result.nodes.length,2);
  assert.equal(result.truncated,false);
  assert.deepEqual(result.truncation_reasons,[]);
});
test('deadline during window enumeration is also a partial result',()=>{
  const {result}=fixture({time_budget_ms:15,include_nodes:false});
  assert.ok(result.windows.length>0 && result.windows.length<4);
  assert.equal(result.nodes.length,0);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
});

test('background window cost cannot starve active controls or consume eight seconds',()=>{
  const {result}=fixture({max_nodes:80},{cost:50,count:1,backgroundWindows:100});
  assert.ok(result.nodes.length>0);
  assert.ok(result.nodes.every(node=>node.pid===2));
  assert.ok(result.elapsed_ms<5000, result.elapsed_ms);
  assert.equal(result.inventory_complete,false);
  assert.deepEqual(result.truncation_reasons,['window_inventory_budget']);
});
test('region scope skips unrelated foreground controls but retains original background paths',()=>{
  const {result}=fixture({region:{x:-900,y:0,width:300,height:300}},
    {count:1,position:pid=>pid===1?[-1000,0]:[0,0]});
  assert.equal(result.scope,'intersecting_windows');
  assert.equal(result.nodes.length,2);
  assert.ok(result.nodes.every(node=>node.pid===1));
  assert.equal(result.nodes[0].node_id,'ax:1:w1:0');
  assert.deepEqual(result.nodes[0].path,[0]);
  assert.equal(result.inventory_complete,true);
});
test('region misses all windows without fabricating nodes',()=>{
  const {result}=fixture({region:{x:-2000,y:-1000,width:100,height:100}},{count:1});
  assert.equal(result.nodes.length,0);
  assert.equal(result.truncated,false);
  assert.equal(result.inventory_complete,true);
});
test('label fallbacks avoid redundant Apple Events for titled controls',()=>{
  const {result,reads}=fixture({}, {count:1});
  assert.equal(result.nodes[0].label,'Save');
  assert.equal(reads.name||0,0);
  assert.equal(reads.help||0,0);
});

test('window list does not inherit the shortened background inventory budget',()=>{
  const {result}=fixture({include_nodes:false,max_nodes:80},{cost:50,count:1,backgroundWindows:100});
  assert.equal(result.nodes.length,0);
  assert.ok(result.elapsed_ms>=8000);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
  assert.equal(result.scope,'windows_only');
});

test('scoped background controls are read before the remaining window inventory',()=>{
  const {result}=fixture({region:{x:-900,y:0,width:300,height:300},max_nodes:80},
    {cost:50,count:1,backgroundWindows:100,position:pid=>pid===1?[-1000,0]:[0,0]});
  assert.ok(result.nodes.length>0);
  assert.ok(result.nodes.every(node=>node.pid===1));
  assert.equal(result.nodes[0].node_id,'ax:1:w1:0');
  assert.equal(result.inventory_complete,false);
  assert.deepEqual(result.truncation_reasons,['time_budget']);
});

test('large menu trees cannot consume the remaining foreground observation budget',()=>{
  const {result}=fixture({max_nodes:80},{cost:10,count:1,menus:true});
  assert.deepEqual(result.truncation_reasons,['menu_budget']);
  assert.equal(result.nodes.filter(n=>n.root_kind==='window').length,2);
  assert.ok(result.nodes.some(n=>n.root_kind==='menu_bar'));
  assert.ok(result.elapsed_ms<2500,result.elapsed_ms);
  assert.equal(result.inventory_complete,true);
  assert.equal(result.windows.length,4);
});
test('one slow menu property preserves window targets and resumes window inventory',()=>{
  const {result}=fixture({max_nodes:80},{count:1,menus:true,slowMenuRole:true});
  assert.deepEqual(result.truncation_reasons,['menu_budget']);
  assert.equal(result.nodes.length,2);
  assert.ok(result.nodes.every(n=>n.root_kind==='window'));
  assert.equal(result.inventory_complete,true);
  assert.equal(result.windows.length,4);
});
test('small complete menu trees retain paths without a false budget warning',()=>{
  const {result}=fixture({max_nodes:80},{count:1,menus:true,menuCount:2});
  assert.equal(result.truncated,false);
  assert.equal(result.nodes.filter(n=>n.root_kind==='menu_bar').length,3);
  assert.deepEqual(result.nodes.find(n=>n.root_kind==='menu_bar' && n.depth===1).path,[0]);
});
