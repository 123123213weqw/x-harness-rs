import assert from 'node:assert/strict'
import {test}from'node:test'
import vm from'node:vm'
import{readFileSync}from'node:fs'
import{compileSourceModules}from'./build-source-modules.mjs'
const id='@xharness/dsh-client-ui-attachment';
const compiled=compileSourceModules('ui',[{id,source:'src/modules/attachment/index.ts'}]).get(id).bytes.toString();
function load(code){let registration;const styles=[],slots=[],effects=[];let seq=0;
 const node=(type,props={},key)=>({type,props,key});const react={createElement:(type,props,...children)=>node(type,{...props,children}),useRef:()=>({current:null}),useState:value=>[value,()=>{}],useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useCallback:fn=>fn,Fragment:'fragment'};
 const primitives=new Proxy({}, {get:(_target,key)=>key});
 const context={window:{__ModuleLoader__:{load:x=>registration=x}},document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:x=>styles.push(x)},body:{}},console};
 vm.runInNewContext(code,context);const plugin=registration.factory(name=>({react,'react-dom':{createPortal:x=>x},'react/jsx-runtime':{jsx:node,jsxs:node,Fragment:'fragment'},'@xharness/dsh-client-ui-primitives':primitives}[name]));
 plugin.apply({slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})}});
 return{plugin,styles,slots,render(index,props){return slots[index].component(props)}}
}
const original=readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8');const pair=[load(original),load(compiled)];const json=x=>JSON.parse(JSON.stringify(x));
function names(tree){if(!tree||typeof tree!=='object')return typeof tree==='string'?tree:'';if(Array.isArray(tree))return tree.map(names).join(' ');if(typeof tree.type==='function')return names(tree.type(tree.props));return names(tree.props?.children)}
test('attachment ABI, slots and exact style/cascade retained',()=>{assert.deepEqual(Object.keys(pair[1].plugin).sort(),Object.keys(pair[0].plugin).sort());assert.deepEqual(json(pair[1].plugin.inject),json(pair[0].plugin.inject));assert.deepEqual(json(pair[1].slots.map(x=>x.spec)),json(pair[0].slots.map(x=>x.spec)));assert.deepEqual(json(pair[1].styles),json(pair[0].styles))});
test('draft image rail and file card retain presentation callbacks',()=>{const props={attachments:[{id:'i',kind:'image',file:{name:'photo.png',size:10},previewUrl:'data:image/png,a'},{id:'f',kind:'file',file:{name:'file.txt',size:2048}}],canAcceptDrop:true,onAddImages(){},onRemoveImage(){},t:key=>key};for(const api of pair){const text=names(api.render(0,props));assert.match(text,/file.txt/);assert.match(text,/2.0 KiB/)}assert.equal(names(pair[1].render(0,props)),names(pair[0].render(0,props)))});
test('history routes file and missing dimensions to durable download card, image to loading preview',()=>{for(const images of [[{kind:'file',attachment:{attachmentId:'f',name:'notes.txt',bytes:50}}],[{attachment:{attachmentId:'f',name:'unknown',bytes:50}}],[{attachment:{attachmentId:'i',name:'photo',bytes:50,width:800,height:600}}]]){const props={images,loadImage:async()=> 'url',align:'end',t:key=>key};assert.equal(names(pair[1].render(1,props)),names(pair[0].render(1,props)))}for(const api of pair)assert.equal(names(api.render(1,{images:[],t:key=>key})), '')});
