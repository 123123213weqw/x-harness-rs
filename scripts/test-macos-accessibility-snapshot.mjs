import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const common = fs.readFileSync(new URL('../crates/xharness-computer-macos/src/accessibility-common.js', import.meta.url), 'utf8');
const source = common + '\n' + fs.readFileSync(new URL('../crates/xharness-computer-macos/src/accessibility-snapshot.js', import.meta.url), 'utf8');

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
      attributes:{byName:key=>({exists:()=>{ if(properties.descriptionError && key==='AXDescription') throw new Error('unavailable'); return read(true); },value:()=>read(key==='AXDescription' ? prop('explicitDescription',prop('description','')) : prop('identifier',''))})},
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
  const se = {applicationProcesses:{whose:criteria=>()=>read(processes.filter(p=>(criteria.frontmost===undefined || p._frontmost===criteria.frontmost) && (criteria.unixId===undefined || p.unixId()===criteria.unixId)),'processes')}};
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


test('generic localized role descriptions are not business labels; explicit descriptions still are',()=>{
  for (const description of ['group','组','Gruppe','arbitrary localized role']) {
    const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>{
      let tree=n('AXButton',[],{title:'Deep target',actions:['AXPress']});
      for(let i=0;i<24;i++) tree=layout(n,[tree],{description,explicitDescription:''});
      return [tree];
    }});
    assert.equal(result.truncated,false);
    assert.equal(result.nodes.length,2);
    assert.ok(result.nodes.every(n=>n.depth===25 && n.semantic_depth===1));
  }
  for (const explicitDescription of ['Navigation','项目分组']) {
    const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[layout(n,[n()],{description:'group',explicitDescription})]});
    assert.equal(result.search.compressed_layout_nodes,0);
    assert.ok(result.nodes.every(n=>n.label===explicitDescription));
    assert.ok(result.truncation_reasons.includes('depth_limit'));
  }
});

test('an unreadable explicit group label never becomes transparent',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[layout(n,[n()],{descriptionError:true})]});
  assert.equal(result.search.transparent_layout_nodes,0);
  assert.ok(result.truncation_reasons.includes('depth_limit'));
});

const actionSource=common+'\n'+fs.readFileSync(new URL('../crates/xharness-computer-macos/src/accessibility-node-action.js',import.meta.url),'utf8');
function actionFixture(config={}) {
  const effects={activations:0,presses:0,focusSets:0};
  const rect={x:-900,y:20,width:180,height:32};
  const windowRect={x:-940,y:0,width:640,height:500};
  let focused=false;
  function element(role,label,id,children=[],position=rect) {
    const actions=()=>[];
    actions.byName=()=>({exists:()=>!config.actionMissing,perform:()=>{effects.presses++;}});
    return {exists:()=>true,role:()=>role,subrole:()=>null,title:()=>label,name:()=>{if(config.windowNameError && role==='AXWindow')throw new Error('unavailable');return role==='AXWindow'?label:'';},description:()=>'',help:()=>'',
      attributes:{byName:key=>key==='AXFocused'?{exists:()=>true,get value(){return ()=>focused;},set value(v){effects.focusSets++;focused=config.focusFails?false:v;}}:{exists:()=>true,value:()=>key==='AXIdentifier'?id:''}},
      position:()=>[position.x,position.y],size:()=>[position.width,position.height],enabled:()=>!config.disabled,
      actions,uiElements:()=>children,sheets:()=>config.sheet?[{}]:[]};
  }
  const button=element(config.role||'AXButton',config.label||'Save',config.identifier||'save');
  const sheet=element('AXSheet','Sheet',null,[button]);
  const window=element('AXWindow',config.windowTitle??'Window',null,config.insideSheet?[sheet]:config.missingPath?[]:[button],windowRect);
  const process={windows:()=>config.missingWindow?[]:[window],menuBars:()=>[],get frontmost(){return ()=>!config.background;},set frontmost(value){if(value)effects.activations++;}};
  const request={pid:42,root_kind:'window',root_index:1,path:config.insideSheet?[0,0]:[0],node_id:'ax:42:w1:0',operation:'AXPress',window_id:77,foreground_window_id:77,window_bounds:windowRect,bounds:rect,
    windows:[{pid:42,id:config.replacedWindow?78:77,bounds:windowRect}],identity:{role:'AXButton',subrole:null,label:'Save',identifier:'save'},...config.request};
  if(config.ambiguous)request.windows.push({pid:42,id:78,bounds:windowRect});
  const se={applicationProcesses:{whose:()=>()=>config.missingProcess?[]:[process]}};
  const context=vm.createContext({Application:()=>se});
  const result=JSON.parse(vm.runInContext(actionSource+'\nrun(['+JSON.stringify(JSON.stringify(request))+'])',context));
  return {result,effects};
}
test('native action validates a unique OS window and exact node before real dispatch',()=>{
  const {result,effects}=actionFixture();
  assert.equal(result.ok,true);assert.equal(result.effect_verified,false);
  assert.deepEqual(effects,{activations:1,presses:1,focusSets:0});
});
test('coordinate fallback validation cannot activate or press a target',()=>{
  const {result,effects}=actionFixture({request:{operation:'validate'}});
  assert.equal(result.ok,true);assert.deepEqual(effects,{activations:0,presses:0,focusSets:0});
});
for(const [name,config,code] of [
  ['recreated same-title same-bounds window',{replacedWindow:true},'stale_node'],
  ['ambiguous overlapping windows',{ambiguous:true},'stale_node'],
  ['missing process',{missingProcess:true},'stale_node'],
  ['missing window',{missingWindow:true},'stale_node'],
  ['missing child path',{missingPath:true},'stale_node'],
  ['same path now belongs to another control',{identifier:'delete'},'stale_node'],
  ['changed role',{role:'AXCheckBox'},'stale_node'],
  ['changed label',{label:'Delete'},'stale_node'],
  ['disabled control',{disabled:true},'target_disabled'],
  ['modal parent target',{sheet:true},'target_obscured'],
  ['removed action',{actionMissing:true},'stale_node'],
  ['missing OS window identity',{request:{window_id:null}},'stale_node'],
  ['moved window',{request:{window_bounds:{x:0,y:0,width:640,height:500}}},'stale_node'],
  ['moved control',{request:{bounds:{x:0,y:0,width:180,height:32}}},'stale_node']
])test('rejects '+name+' before activation or input',()=>{
  const {result,effects}=actionFixture(config);
  assert.equal(result.ok,false);assert.equal(result.error.code,code);
  assert.deepEqual(effects,{activations:0,presses:0,focusSets:0});
});
test('controls inside the modal sheet remain usable',()=>{
  const {result,effects}=actionFixture({sheet:true,insideSheet:true});
  assert.equal(result.ok,true);assert.equal(effects.presses,1);
});
test('focus must be acknowledged before text can be posted',()=>{
  assert.equal(actionFixture({request:{operation:'focus'}}).result.ok,true);
  const {result,effects}=actionFixture({focusFails:true,request:{operation:'focus'}});
  assert.equal(result.ok,false);assert.equal(effects.presses,0);assert.equal(effects.focusSets,1);
});

test('coordinate fallback refuses background or covered windows without activation',()=>{
  for(const config of [{background:true},{request:{foreground_window_id:78}}]) {
    const {result,effects}=actionFixture({...config,request:{...config.request,operation:'validate'}});
    assert.equal(result.ok,false);assert.equal(result.error.code,'target_obscured');
    assert.deepEqual(effects,{activations:0,presses:0,focusSets:0});
  }
});

test('a successfully read null AXDescription is an absent label, not a read failure',()=>{
  const {result}=fixture({max_depth:1,max_nodes:80},{children:n=>[layout(n,[n()],{description:'group',explicitDescription:null})]});
  assert.equal(result.truncated,false);assert.equal(result.search.compressed_layout_nodes,2);
});

test('Host-selected PID takes precedence over stale System Events foreground flags',()=>{
  const {result}=fixture({frontmost_pid:1},{count:1});
  assert.ok(result.nodes.length>0);
  assert.ok(result.nodes.every(n=>n.pid===1));
  assert.equal(result.windows[0].pid,1);
  assert.ok(result.windows[0].frontmost);
});
test('a missing explicitly selected app never falls back to another apps controls',()=>{
  for(const region of [null,{x:0,y:0,width:100,height:100}]) {
    const {result}=fixture({frontmost_pid:999,region},{count:1});
    assert.equal(result.nodes.length,0);
    assert.ok(result.truncation_reasons.includes('foreground_unavailable'));
    assert.ok(result.windows.every(w=>!w.frontmost));
  }
});


const foregroundSource=fs.readFileSync(new URL('../crates/xharness-computer-macos/src/foreground-process.js',import.meta.url),'utf8');
test('foreground PID extraction never reads nullable LaunchServices launchDate',()=>{
  let reads=0;
  for(const date of [null,undefined,123.5]) {
    const app={processIdentifier:42,get launchDate(){reads++;if(date===undefined)throw new Error('unavailable');return date;}};
    const context=vm.createContext({ObjC:{import:()=>{}},$:{NSWorkspace:{sharedWorkspace:{frontmostApplication:app}}}});
    assert.deepEqual(JSON.parse(vm.runInContext(foregroundSource+'\nrun()',context)),{pid:42});
  }
  assert.equal(reads,0);
});

test('window roots revalidate the same 240-character and empty-title contract as surfaces',()=>{
  for(const length of [0,120,160,161,200,240,260]) {
    const title='W'.repeat(length);
    const label=length<=240?title:title.slice(0,240)+'…';
    const {result,effects}=actionFixture({windowTitle:title,request:{path:[],bounds:{x:-940,y:0,width:640,height:500},identity:{role:'AXWindow',subrole:null,label,identifier:null},operation:'validate'}});
    assert.equal(result.ok,true,'title length '+length);
    assert.deepEqual(effects,{activations:0,presses:0,focusSets:0});
  }
});
test('changed or unreadable window names still fail before activation/input',()=>{
  for(const config of [{windowTitle:'Other'},{windowNameError:true}]) {
    const {result,effects}=actionFixture({...config,request:{path:[],bounds:{x:-940,y:0,width:640,height:500},identity:{role:'AXWindow',subrole:null,label:'Window',identifier:null},operation:'validate'}});
    assert.equal(result.ok,false);assert.equal(result.error.code,'stale_node');
    assert.deepEqual(effects,{activations:0,presses:0,focusSets:0});
  }
});
