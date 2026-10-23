import { createManagedCdpBrowserRuntime } from './dist/browser/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const methods = ['list','newTab','activateTab','close','navigate','back','forward','reload','snapshot','click','fill','type','press','hover','select','check','scroll','waitFor','playwrightWaitForTimeout','getState','getDialog','handleDialog','playwright','screenshot'];
const properties = {
  method: {type:'string',enum:methods,description:'Unmodified original BrowserCommand.method. snapshot returns original elements refs such as e1; fill takes value, select takes values.'},
  tabId:{type:'string',description:'Original tabId returned by list/newTab; omit to use the active tab.'},url:{type:'string',description:'Native navigate.url. Original newTab has no URL parameter; any provided top-level URL is still checked against the experiment fixture origin.'},ref:{type:'string',description:'Original snapshot.elements ref such as e1.'},value:{type:'string',description:'Native fill.value: replacement input text. For native type use text instead.'},text:{type:'string',description:'Native type.text: text entered with page.keyboard.type; also the visible text condition for waitFor.'},textGone:{type:'string',description:'Native waitFor.textGone: visible text to wait to disappear.'},key:{type:'string',description:'Native press.key: Playwright keyboard key name.'},selector:{type:'string',description:'Native waitFor.selector: visible element selector.'},
  x:{type:'number'},y:{type:'number'},button:{type:'string',enum:['left','right','middle']},doubleClick:{type:'boolean'},
  values:{type:'array',items:{type:'string'}},checked:{type:'boolean'},accept:{type:'boolean'},promptText:{type:'string'},
  fullPage:{type:'boolean'},
  action:{type:'object',properties:{name:{type:'string',enum:['domSnapshot','locator','waitForLoadState','waitForURL']},selector:{type:'string'},operation:{type:'string',enum:['click','dblclick','fill','press','selectOption','setChecked','waitFor']},value:{},checked:{type:'boolean'},selections:{type:'array',items:{type:'object',properties:{value:{type:'string'},label:{type:'string'},index:{type:'integer'}},additionalProperties:false}},state:{type:'string',enum:['visible','hidden','load','domcontentloaded','networkidle'],description:'locator waitFor uses visible/hidden; waitForLoadState uses load/domcontentloaded/networkidle.'},timeoutMs:{type:'integer',minimum:1,maximum:3000},url:{type:'string'},waitUntil:{type:'string',enum:['load','domcontentloaded','networkidle','commit']}},required:['name'],additionalProperties:false},
  modifiers:{type:'array',items:{type:'string',enum:['Alt','Control','ControlOrMeta','Meta','Shift']}},
  timeoutMs:{type:'integer',minimum:0,maximum:10000},maxElements:{type:'integer',minimum:1,maximum:200},includeHidden:{type:'boolean',enum:[false]},
};
export const referenceTools = [{type:'function',function:{name:'zcode_browser',description:'Official ZCode managed headless BrowserControlPort (pinned revision 3c5b2276), direct native command arguments. Public interaction subset only: list/newTab/activateTab/close, navigate/back/forward/reload, snapshot, click/fill/type/press/hover/select/check/scroll, waitFor(selector or text or textGone), playwrightWaitForTimeout(timeoutMs), getState/getDialog/handleDialog, original Playwright domSnapshot/locator interaction actions, optional native screenshot(fullPage/ref). No evaluate, arbitrary JS, HTTP, routes, filesystem or hidden DOM access. Every task uses a new isolated browser; no automatic action replay.',parameters:{type:'object',properties,required:['method'],additionalProperties:false}}}];
export function validateReferenceCommand(args, origins, visual=true) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !methods.includes(args.method)) throw Error('Command is outside the disclosed original public interaction subset');
  for (const key of Object.keys(args)) if (!(key in properties)) throw Error('Unknown native command field: '+key);
  if (args.url!==undefined) {const url=new URL(args.url);if(!origins.has(url.origin)||url.username||url.password)throw Error('A/B fixture-origin input scope rejected navigation');}
  if(args.method==='screenshot'&&!visual)throw Error('Screenshot is disabled in the text-only common subset');
  if(args.method==='playwright'){const action=args.action;if(!action||!['domSnapshot','locator','waitForLoadState','waitForURL'].includes(action.name))throw Error('Original Playwright action outside common public subset');if(action.name==='locator'&&!['click','dblclick','fill','press','selectOption','setChecked','waitFor'].includes(action.operation))throw Error('Original locator operation outside public interaction subset');for(const key of Object.keys(action))if(!(key in properties.action.properties))throw Error('Unsupported original Playwright argument: '+key);if(action.state!==undefined){const states=action.name==='locator'?['visible','hidden']:action.name==='waitForLoadState'?['load','domcontentloaded','networkidle']:[];if(!states.includes(action.state))throw Error('State is not valid for original action '+action.name);}}
  if(args.includeHidden===true)throw Error('Hidden DOM is outside the common A/B interaction subset');
  if(args.timeoutMs!==undefined && (!Number.isInteger(args.timeoutMs)||args.timeoutMs<0||args.timeoutMs>10000))throw Error('A/B wait budget is 0..10000ms');
  if(args.maxElements!==undefined && (!Number.isInteger(args.maxElements)||args.maxElements<1||args.maxElements>200))throw Error('maxElements must be 1..200');
}
export async function createReference({allowedOrigins,artifactRoot,executablePath,viewport={width:1280,height:800},sessionId='reference-'+randomUUID(),visual=false}={}) {
  if(!Array.isArray(allowedOrigins)||!allowedOrigins.length)throw Error('A/B fixture origins are required');
  const origins=new Set(allowedOrigins.map(value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value)throw Error('Exact fixture origins required');return value;}));
  if(artifactRoot)await mkdir(artifactRoot,{recursive:true,mode:0o700});
  const manifest=JSON.parse(await readFile(new URL('./source-manifest.json',import.meta.url),'utf8'));
  const runtime=createManagedCdpBrowserRuntime({...(executablePath?{executablePath}:{})});
  const base={requestId:randomUUID(),workspaceKey:'ab-reference',workspacePath:artifactRoot??process.cwd(),sessionId,turnId:'ab-task',clientMode:'web-remote-replayable',sessionContext:'live'};
  let descriptor;
  try {
    [descriptor]=await runtime.browserControlPort.list(base);
    if(!descriptor)throw Error('Original backend returned no descriptor');
    const native=command=>runtime.browserControlPort.execute({...base,requestId:randomUUID(),browserId:descriptor.id,browserGeneration:descriptor.generation,command});
    const initial=await native({method:'newTab'});if(!initial.ok)throw Error('Original newTab failed: '+JSON.stringify(initial));
    const sizing=await native({method:'browserViewportSet',...viewport});if(!sizing.ok)throw Error('Original viewport command failed: '+JSON.stringify(sizing));
    const provenance={schema:'xharness.zcode-reference-adapter.v1',originalRevision:manifest.revision,repository:manifest.repository,sourceManifest:manifest,source:'Exact 8 original adapter TS blobs, TypeScript transpilation only; backend bodies unchanged',shim:'Fixed BrowserControlPort session/browser identities, OpenAI native-command subset schema, fixture-origin input scope, public viewport bootstrap and optional text-only screenshot crop only. No rewritten Playwright reading/clicking implementation.',excludedOriginalCapabilities:['evaluate','playwright.evaluate','filesystem','HTTP/response bodies','routes','hidden snapshot','recording','user tab/profile claiming'],dependency:{playwrightCore:require('playwright-core/package.json').version,typescript:require('typescript/package.json').version},viewport,visual,executablePath:executablePath??null,descriptor,adapterSha256:createHash('sha256').update(await readFile(new URL('./ab-reference.mjs',import.meta.url))).digest('hex')};
    const tools=structuredClone(referenceTools);if(!visual)tools[0].function.parameters.properties.method.enum=methods.filter(method=>method!=='screenshot');
    return {tools,provenance,async call(name,args){if(name!=='zcode_browser')throw Error('Unknown reference tool');validateReferenceCommand(args,origins,visual);return await native(args);},async close(){await runtime.close();}};
  } catch(error){await runtime.close();throw error;}
}
