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
  function node(role='AXButton', children=[], properties={}) {
    const prop = (key, fallback) => Object.hasOwn(properties,key) ? properties[key] : fallback;
    return {
      role:()=>{ if(config.slowRole) now+=500; if(config.slowMenuRole && role==='AXMenuBar') now+=1000; return read(role); },
      subrole:()=>read(prop('subrole',null)),
      title:()=>read(prop('title',role==='AXUnknown'?'':'Save')),
      name:()=>read(prop('name',''),'name'), description:()=>read(prop('description','')),
      help:()=>read(prop('help',''),'help'),
      attributes:{byName:()=>({value:()=>read(prop('identifier',''))})},
      actions:()=>{
        if(properties.actionsError) throw new Error('fixture property unavailable');
        return read(prop('actions',[]).map(name=>({name:()=>read(name)})));
      },
      position:()=>read(prop('position',role==='AXUnknown'?null:[10,20]),'bounds'),
      size:()=>read(prop('size',[30,40]),'bounds'),
      visible:()=>read(prop('visible',true)), enabled:()=>read(prop('enabled',true)),
      focused:()=>read(prop('focused',false)), selected:()=>read(prop('selected',false)),
      value:()=>{ if(role==='AXSecureTextField' || properties.subrole==='AXSecureTextField') reads.secureValue++; return read(prop('value','value')); },
      uiElements:()=>{
        if(role==='AXSecureTextField' || properties.subrole==='AXSecureTextField') reads.secureChildren=(reads.secureChildren||0)+1;
        if(properties.childrenError) throw new Error('fixture children unavailable');
        return read(children,'children');
      }
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
  function resolve(target) {
    let element = windows(target.pid)[target.root_index-1];
    for (const index of target.path) element = element.uiElements()[index];
    return element;
  }
  return {result, reads, resolve};
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
  assert.deepEqual(result.truncation_reasons,['queue_limit','node_limit']);
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
  assert.deepEqual(result.truncation_reasons,['queue_limit','visit_limit']);
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
  assert.deepEqual(result.truncation_reasons,['queue_limit','menu_budget']);
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


function layout(n, children, properties={}) {
  return n('AXGroup',children,{title:'',value:null,...properties});
}
test('anonymous single-child chains do not spend semantic depth or change target paths',()=>{
  let button;
  const {result,resolve}=fixture({max_depth:1,max_nodes:80},{children:n=>{
    button=n('AXButton',[],{title:'Target',actions:['AXPress']});
    let tree=button;
    for(let index=0;index<24;index++) tree=layout(n,[tree]);
    return [tree];
  }});
  const target=result.nodes.find(n=>n.root_index===1);
  assert.equal(result.nodes.length,2);
  assert.equal(target.depth,25);
  assert.equal(target.semantic_depth,1);
  assert.deepEqual(target.path,Array(25).fill(0));
  assert.equal(target.parent_id,'window:2:1');
  assert.equal(resolve(target),button);
  assert.equal(result.search.compressed_layout_nodes,48);
  assert.equal(result.search.transparent_layout_nodes,48);
  assert.equal(result.truncated,false);
});
test('context-menu layout groups stay actionable while passing through semantic depth',()=>{
  let group,button;
  const {result,resolve}=fixture({max_depth:1,max_nodes:80},{children:n=>{
    button=n('AXButton',[],{actions:['AXPress']});
    group=layout(n,[button],{actions:['AXShowMenu','AXScrollToVisible']});
    return [group];
  }});
  const parent=result.nodes.find(n=>n.node_id==='ax:2:w1:0');
  const child=result.nodes.find(n=>n.node_id==='ax:2:w1:0.0');
  assert.deepEqual(parent.actions,['AXShowMenu','AXScrollToVisible']);
  assert.equal(resolve(parent),group);
  assert.equal(resolve(child),button);
  assert.equal(child.parent_id,parent.node_id);
  assert.equal(child.depth,2);
  assert.equal(child.semantic_depth,1);
  assert.equal(result.search.compressed_layout_nodes,0);
  assert.equal(result.search.transparent_layout_nodes,2);
  assert.equal(result.truncated,false);
});
test('anonymous branching contexts remain records and do not starve sibling targets',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[
    layout(n,[n('AXButton',[],{title:'One'}),n('AXTextField',[],{title:'Two'})])
  ]});
  assert.equal(result.nodes.length,6);
  assert.equal(result.search.transparent_layout_nodes,2);
  assert.equal(result.search.compressed_layout_nodes,0);
  assert.equal(result.truncated,false);
  const group=result.nodes.find(n=>n.node_id==='ax:2:w1:0');
  for(const target of result.nodes.filter(n=>n.root_index===1 && n.path.length===2)) {
    assert.equal(target.parent_id,group.node_id);
    assert.equal(target.semantic_depth,1);
  }
});
test('meaningful group metadata, state and interaction actions are never folded away',()=>{
  for(const properties of [
    {title:'Named panel'}, {identifier:'panel'}, {description:'Description'}, {help:'Help'},
    {subrole:'AXLandmarkMain'}, {value:0}, {value:false}, {focused:true}, {selected:true},
    {actions:['AXPress']}, {actions:['AXConfirm']}, {actionsError:true}
  ]) {
    const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[
      layout(n,[n()],properties)
    ]});
    assert.equal(result.search.transparent_layout_nodes,0,JSON.stringify(properties));
    assert.equal(result.nodes.length,2);
    assert.ok(result.nodes.every(n=>n.role==='AXGroup'));
    assert.deepEqual(result.truncation_reasons,['depth_limit']);
  }
});
test('semantic breadth-first visits a sibling before descending a deep first branch',()=>{
  const {result}=fixture({max_nodes:3,max_depth:8},{children:n=>{
    let chain=n('AXButton',[],{title:'Deep target'});
    for(let i=0;i<6;i++) chain=n('AXGroup',[chain],{title:'Named context'});
    return [chain,n('AXButton',[],{title:'Sibling target'})];
  }});
  assert.equal(result.nodes[0].path.join('.'),'0');
  assert.equal(result.nodes[1].path.join('.'),'1');
  assert.equal(result.nodes[1].label,'Sibling target');
  assert.ok(result.nodes.length<=3);
});
test('raw-depth guard bounds cyclic anonymous containers without recursion',()=>{
  const {result}=fixture({max_nodes:80,max_depth:1},{children:n=>{
    const cycle=layout(n,[]);cycle.uiElements=()=>[cycle];return [cycle];
  }});
  assert.equal(result.nodes.length,0);
  assert.equal(result.visited,128);
  assert.equal(result.search.max_raw_depth,64);
  assert.equal(result.search.compressed_layout_nodes,128);
  assert.deepEqual(result.truncation_reasons,['raw_depth_limit']);
  assert.ok(result.search.peak_pending<=result.search.max_pending);
});
test('pending and visit budgets bound very wide native child lists',()=>{
  const {result}=fixture({max_nodes:2},{role:'AXUnknown',count:10000});
  assert.equal(result.nodes.length,0);
  assert.equal(result.visited,10);
  assert.equal(result.search.peak_pending,10);
  assert.equal(result.search.max_pending,10);
  assert.deepEqual(result.truncation_reasons,['queue_limit','visit_limit']);
});
test('visibility of a transparent wrapper never prunes a visible child',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[
    layout(n,[n('AXButton',[],{visible:true})],{visible:false})
  ]});
  assert.equal(result.nodes.length,2);
  assert.ok(result.nodes.every(n=>n.visible));
  assert.equal(result.truncated,false);
});
test('secure fields redact values and never enumerate descendants carrying secret labels',()=>{
  for(const [role,properties] of [
    ['AXSecureTextField',{}], ['AXGroup',{subrole:'AXSecureTextField'}]
  ]) {
    const {result,reads}=fixture({max_nodes:80},{children:n=>[
      n(role,[n('AXStaticText',[],{title:'DO_NOT_EXPOSE_SECRET'})],properties)
    ]});
    assert.equal(result.nodes.length,2);
    assert.ok(result.nodes.every(n=>n.value==='<redacted>'));
    assert.equal(reads.secureValue,0);
    assert.equal(reads.secureChildren||0,0);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE_SECRET'));
  }
});
test('unavailable child enumeration is explicit partial evidence, not an empty complete subtree',()=>{
  const {result}=fixture({max_depth:8,max_nodes:80},{children:n=>[
    layout(n,[n()],{childrenError:true})
  ]});
  assert.equal(result.nodes.length,2);
  assert.equal(result.search.compressed_layout_nodes,0);
  assert.deepEqual(result.truncation_reasons,['children_unavailable']);
});
test('published parent links always resolve within the same window domain after folding',()=>{
  const {result}=fixture({max_depth:8,max_nodes:80},{children:n=>[
    n('AXGroup',[layout(n,[n('AXButton')]),layout(n,[n('AXTextField')])],{title:'Panel'})
  ]});
  const byId=new Map(result.nodes.map(n=>[n.node_id,n]));
  for(const node of result.nodes) {
    if(node.parent_id.startsWith('window:')) continue;
    const parent=byId.get(node.parent_id);
    assert.ok(parent);
    assert.equal(parent.surface_id,node.surface_id);
    assert.ok(parent.depth<node.depth);
    assert.ok(parent.semantic_depth<=node.semantic_depth);
  }
});
test('search policy and actual pending limits are explicit in an inventory-only snapshot',()=>{
  const {result}=fixture({include_nodes:false});
  assert.equal(result.search.policy,'semantic_breadth_first');
  assert.equal(result.search.depth_metric,'semantic');
  assert.equal(result.search.max_raw_depth,64);
  assert.equal(result.search.peak_pending,0);
  assert.equal(result.search.compressed_layout_nodes,0);
});

test('generated semantic snapshot remains compatible with the Rust decoder fixture',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>{
    let tree=n('AXButton',[],{title:'Save',actions:['AXPress']});
    for(let index=0;index<24;index++) tree=layout(n,[tree]);
    return [tree];
  }});
  result.elapsed_ms=0; // wire semantics, not virtual getter-cost accounting
  const path=new URL('../crates/xharness-computer-macos/tests/fixtures/semantic-search.json',import.meta.url);
  if(process.env.XHARNESS_UPDATE_MACOS_AX_FIXTURE==='1') fs.writeFileSync(path,JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(result,JSON.parse(fs.readFileSync(path,'utf8')));
});

test('seeded mixed trees keep every budget, parent domain and raw path invariant',()=>{
  let seed=0x5eed1234;
  const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
  for(let run=0;run<64;run++) {
    const options={max_nodes:1+random(16),max_depth:1+random(4)};
    const {result,resolve}=fixture(options,{cost:0,children:n=>{
      function tree(depth) {
        if(depth===0 || random(3)===0) return n('AXButton',[],{actions:['AXPress']});
        const children=Array.from({length:1+random(3)},()=>tree(depth-1));
        switch(random(5)) {
          case 0:return layout(n,children);
          case 1:return layout(n,children,{actions:['AXShowMenu']});
          case 2:return n('AXGroup',children,{title:'Named context'});
          case 3:return n('AXSecureTextField',children);
          default:return n('AXUnknown',children);
        }
      }
      return [tree(5),tree(4)];
    }});
    assert.ok(result.nodes.length<=options.max_nodes);
    assert.ok(result.visited<=options.max_nodes*5);
    assert.ok(result.search.peak_pending<=result.search.max_pending);
    const byId=new Map(result.nodes.map(n=>[n.node_id,n]));
    assert.equal(byId.size,result.nodes.length);
    for(const node of result.nodes) {
      assert.ok(node.depth<=64);
      assert.equal(node.depth,node.path.length);
      assert.ok(node.semantic_depth<=options.max_depth);
      assert.equal(resolve(node).role(),node.role);
      if(!node.parent_id.startsWith('window:')) {
        const parent=byId.get(node.parent_id);
        assert.ok(parent);
        assert.equal(parent.surface_id,node.surface_id);
        assert.ok(parent.depth<node.depth);
      }
    }
  }
});
