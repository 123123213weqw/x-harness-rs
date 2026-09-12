import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchPermissionSelection} from './patch-permission-selection.mjs';
const path=new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js',import.meta.url);
const bytes=readFileSync(path),s=bytes.toString();
assert.equal(patchPermissionSelection(bytes).toString(),s);
const props=s.slice(s.indexOf('const accessSelect ='),s.indexOf('const deco ='));
assert.ok(props.includes('locked,')&&!props.includes('locked || running'),'running alone must not disable the picker');
const begin=s.indexOf('function permissionFeedback('),end=s.indexOf('function PermissionSelect(',begin);
const feedback=vm.runInNewContext(`(${s.slice(begin,end).trim()})`);
assert.equal(feedback({pending:false}),'');
assert.match(feedback({pending:true,activeValue:'workspace-write'}),/下一轮.*workspace-write/);
assert.match(feedback({pending:true,activeValue:'danger-full-access'}),/立即收紧请停止/);
assert.match(feedback({pending:true}),/正在准备/);
// Render the actual shipped component with minimal hooks/primitives, and invoke its handlers.
const a=s.indexOf('function PermissionSelect('),b=s.indexOf('\n\t\t}',a);
let cells=[],cursor=0,commands=[];
const ctx={
 react:{useState:initial=>{const i=cursor++;if(!(i in cells))cells[i]=initial;return[cells[i],x=>{cells[i]=x;}];},useEffect:()=>{}},
 react_jsx_runtime:{Fragment:'fragment',jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
 _deepseek_ai_dsh_client_ui_primitives:{Menu:'menu',RiskConfirmation:'confirm',IconChevronDownOutline14:'icon'},
 PermissionSelect_module_css_default:{},FULL_ACCESS:'danger-full-access',permissionGlyph:()=>undefined,
 optionLabel:o=>o.name,displayName:x=>x,clsx:()=>'',permissionFeedback:feedback,
};
const component=vm.runInNewContext(`(${s.slice(a,b+4)})`,ctx);
let value={currentValue:'workspace-write',activeValue:'workspace-write',pending:false,options:[{value:'workspace-write',name:'Workspace'},{value:'danger-full-access',name:'Full'}]};
let resolve;
const command=x=>{commands.push(x);return new Promise(r=>{resolve=r;});};
const render=(locked=false)=>{cursor=0;return component({value,locked,command,t:x=>x}).props.children;};
let [menu]=render();assert.equal(menu.props.anchor.props.disabled,false);
menu.props.onSelect('danger-full-access');
let [,confirmation]=render();assert.equal(confirmation.props.open,true);assert.equal(commands.length,0,'full access still requires confirmation');
confirmation.props.onConfirm();assert.equal(commands.length,0,'unacknowledged confirmation cannot submit');
confirmation.props.onAcknowledgedChange(true);[,confirmation]=render();confirmation.props.onConfirm();
assert.deepEqual(commands,['/permission danger-full-access']);
[menu]=render();assert.equal(menu.props.anchor.props.disabled,true);assert.match(menu.props.anchor.props.title,/正在保存/);
// A failed/rejected command does not mutate the host's selected value.
resolve(false);await new Promise(r=>setImmediate(r));
[menu]=render();assert.equal(menu.props.selectedId,'workspace-write');
value={...value,currentValue:'danger-full-access',pending:true};
[menu]=render();assert.equal(menu.props.selectedId,'danger-full-access');assert.match(menu.props.anchor.props.title,/当前轮：workspace-write/);
assert.equal(render(true)[0].props.anchor.props.disabled,true,'read-only/locked contexts remain locked');
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
const entry=graph.entries.find(e=>e.id==='@deepseek-ai/dsh-client-ui-conversation');
assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
console.log('permission selection: running/locked/confirmation/pending/save-failure/active-vs-selected/hash passed');
