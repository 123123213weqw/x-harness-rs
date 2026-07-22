// Minimal host hooks for evaluating real emitted components without a DOM.
// JSX remains an inspectable tree; no business selection logic is duplicated.
export function testHooks() {
  let cells=[],cursor=0,effects=[];
  const react={
    useState:initial=>{const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value}]},
    useEffect:fn=>effects.push(fn),useLayoutEffect:()=>{},useMemo:fn=>fn(),useCallback:fn=>fn,
    useRef:initial=>({current:initial}),useId:()=>':test:',memo:fn=>fn,
  };
  const jsx={Fragment:'fragment',jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  return {react,jsx,render:fn=>{cursor=0;effects=[];return fn()},effects:()=>{for(const effect of effects)effect()},reset:()=>{cells=[];cursor=0;effects=[]}};
}
export function descendants(node, predicate) {
  const found=[];
  function visit(value){if(Array.isArray(value)){value.forEach(visit);return}if(value===null||typeof value!=='object')return;if(predicate(value))found.push(value);visit(value.props?.children)}
  visit(node);return found;
}
export function barFixture(input, permissions, session={running:true,subagent:null,removed:false}) {
  return {sessionId:'test',useInput:select=>select(input),useSession:select=>select(session),useNotices:()=>null,useLexicon:()=>new Map(),useMenuLauncher:()=>false,
    useProjection:(key,select)=>{const value=key==='permissions'?permissions:undefined;return select?select(value):value},keyboard:{},inputActions:{},draftImages:()=>[],resolveSubmitMode:()=> 'queue',renderSlot:()=>null,t:key=>key,command:async()=>false};
}
