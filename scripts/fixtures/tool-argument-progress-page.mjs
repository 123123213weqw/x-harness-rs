/** Isolated preview of real owned components. Synthetic events only; no Host/model boot. */
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {compilePlatformUi} from '../build-platform-ui.mjs'
import {compileSourceModules} from '../build-source-modules.mjs'
import {exposeConversation,verifyConversationArtifact} from '../conversation-artifact-test.mjs'

const ui = fileURLToPath(new URL('../../ui/',import.meta.url))
export function toolArgumentPreviewFiles() {
  const platform = compilePlatformUi(ui)
  const outputs = new Map(platform.outputs)
  // Exactly the product theme inputs, not a preview-specific color palette.
  for (const file of ['base.css','design-platform.css','scrollbar.css']) outputs.set('preview/theme/'+file,readFileSync(ui+'src/modules/theme/'+file))
  outputs.set('preview/theme/monochrome.css',readFileSync(ui+'overrides/monochrome.css'))
  const compiled = compileSourceModules(ui,[
    {id:'@test/tool',source:'src/modules/tool/test-exports.ts'},
    {id:'@test/runtime-path',source:'src/modules/client-runtime/workspaces/path.ts'},
    {id:'@test/transcript-state',source:'src/modules/conversation/chat/transcript-state.ts'},
  ])
  outputs.set('preview/runtime.js',readFileSync(ui+'dist/plugins/@xharness/dsh-client-runtime/client.js'))
  outputs.set('preview/conversation.js',Buffer.from(exposeConversation(verifyConversationArtifact(),['AssistantMarkdown','en','zh'])))
  for (const [id,row] of compiled) outputs.set('preview/'+id.slice(6)+'.js',row.bytes)
  outputs.set('preview/scenario.js',Buffer.from(`
    for(let tries=0;!window.staticModules;tries++) {
      if(tries>200) throw Error('Preview platform timeout');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const registrations = {};
    window.__ModuleLoader__ = {load: row=>{registrations[row.id]=row}};
    for(const file of ['runtime','conversation','runtime-path','transcript-state','tool']) {
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/preview/'+file+'.js';script.onload=resolve;script.onerror=reject;document.head.appendChild(script)});
    }
    const requirePlatform = name=>{if(!(name in staticModules))throw Error('Missing real platform '+name);return staticModules[name]};
    const runtime=registrations['@xharness/dsh-client-runtime'].factory(requirePlatform);
    const conversation=registrations['@xharness/dsh-client-ui-conversation'].factory(name=>name==='@xharness/dsh-client-runtime/client'?runtime:requirePlatform(name));
    const paths=registrations['@test/runtime-path'].factory(requirePlatform);
    const tool=registrations['@test/tool'].factory(name=>name==='@xharness/dsh-client-runtime/client'?paths:requirePlatform(name));
    const bridge=registrations['@test/transcript-state'].factory(requirePlatform).transcriptState;
    const React=staticModules.react,DOM=staticModules['react-dom'];
    document.getElementById('root').innerHTML='<main class="preview-shell"><header><span class="preview-brand">XHarness</span><div class="preview-header-controls"><span class="preview-badge">前端预览 · 不执行命令</span><button class="preview-theme" aria-label="切换预览配色" id="preview-theme"></button></div></header><h1>看清工具调用的每个阶段</h1><p class="preview-description">参数还在生成，不代表 Bash 已经开始运行。展开即可查看模型正在写什么。</p><nav aria-label="预览阶段"><button data-stage="generating">生成参数</button><button data-stage="running">执行中</button><button data-stage="done">已完成</button></nav><section class="preview-chat"><div class="preview-user">把项目说明补充到 README（合成示例）</div><div id="preview-component"></div></section><p class="preview-footnote">使用真实 TS 聊天组件与工具行；示例数据不会连接模型、执行脚本或保存会话。</p></main>';
    const root=DOM.createRoot(document.getElementById('preview-component')),store=new Map();
    let locale='zh', stage='generating';
    const t=(key,params={})=>(conversation[locale][key]??key).replace(/\\{(\\w+)\\}/g,(_,name)=>String(params[name]??'{'+name+'}'));
    const renderElement=element=>DOM.flushSync(()=>root.render(React.createElement(bridge.Context.Provider,{value:store},element)));
    const render=(blocks,streaming=true,interrupted=false)=>renderElement(React.createElement(conversation.AssistantMarkdown,{blocks,streaming,interrupted,t,renderMessageImages:()=>null}));
    const command="cat >> README.md <<'DOC'\\n\\n## 项目结构\\n- core：Agent Loop 与消息生命周期\\n- provider：统一模型流式事件\\n- tools：文件与命令工具\\n\\n## 本地开发\\n1. 安装依赖\\n2. 运行测试\\n3. 检查改动\\n\\n这是一段只用于界面预览的文本，不会执行。\\n";
    const raw=JSON.stringify({command:command.replaceAll('\\\\n','\\n')}).slice(0,-2);
    const startedAt=Date.now()-12000;
    function show(next) {
      stage=next;
      for(const button of document.querySelectorAll('[data-stage]'))button.setAttribute('aria-pressed',String(button.dataset.stage===next));
      if(next==='generating') render([{kind:'tool-call',callId:'preview-call',name:'bash',argsRaw:raw,startedAt}]);
      else renderElement(React.createElement(tool.ToolRow,{stateKey:'preview-execution',t,variant:'bash',toolName:'bash',title:'Bash',icon:null,summary:'补充 README 文档（模拟）',body:raw+'"}',output:next==='done'?'模拟结果：文档写入成功，实际未执行任何命令。':null,state:next==='done'?'ok':'running'}));
    }
    for(const button of document.querySelectorAll('[data-stage]'))button.onclick=()=>show(button.dataset.stage);
    window.previewApi={render,show,setLocale:value=>{locale=value},store,renderElement,stage:()=>stage};
    function setDark(dark) {
      document.body.toggleAttribute('data-ds-dark-theme',dark);
      document.documentElement.style.colorScheme=dark?'dark':'light';
      const button=document.getElementById('preview-theme');
      button.textContent=dark?'浅色':'深色';button.setAttribute('aria-pressed',String(dark));
    }
    const systemTheme=matchMedia('(prefers-color-scheme: dark)');
    setDark(systemTheme.matches);
    document.getElementById('preview-theme').onclick=()=>setDark(!document.body.hasAttribute('data-ds-dark-theme'));
    show('generating');
  `))
  outputs.set('index.html',Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHarness · 工具参数生成预览</title>${platform.cssPaths.map(path=>`<link rel="stylesheet" href="/${path}">`).join('')}${['base.css','design-platform.css','scrollbar.css','monochrome.css'].map(file=>`<link rel="stylesheet" href="/preview/theme/${file}">`).join('')}
    <style>
      /* Layout only: colors and dark mode come from the real product theme. */
      html,body,#root{height:auto;min-height:100%;overflow:visible}
      body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .preview-shell{max-width:850px;padding:40px 24px;margin:auto}.preview-shell header{display:flex;align-items:center;justify-content:space-between;gap:16px}.preview-brand{font-size:19px;font-weight:650;letter-spacing:-.5px}.preview-header-controls{display:flex;align-items:center;gap:8px}
      .preview-badge{font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:99px;padding:4px 9px}.preview-theme{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer}
      .preview-shell h1{font-size:26px;font-weight:600;letter-spacing:-.5px;margin:36px 0 8px}.preview-description,.preview-footnote{color:var(--dsw-alias-label-secondary)}.preview-description{margin:0 0 24px}
      nav{display:flex;gap:8px;margin-bottom:20px}nav button{font:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 15px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer}nav button[aria-pressed=true]{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .preview-chat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:16px;padding:24px;min-height:390px;box-shadow:var(--dsw-shadow-lv2)}.preview-user{background:var(--dsw-specific-bubble);border-radius:15px;padding:10px 16px;width:fit-content;max-width:90%;margin:0 0 30px auto}.preview-footnote{font-size:11px;margin:18px 0}
      button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}@media(max-width:480px){.preview-shell{padding:24px 14px}.preview-shell h1{font-size:22px}.preview-chat{padding:14px}.preview-badge{font-size:10px}}

    </style><script>window.__ModuleLoader__={create:options=>{window.staticModules=options.staticModules;throw Error('isolated preview: stop Host boot')}};</script><script type="module" src="/${platform.entryPath}"></script><script type="module" src="/preview/scenario.js"></script></head><body><div id="root"></div></body></html>`))
  return outputs
}

export function serveToolArgumentPreview(files,request,response) {
  const path=new URL(request.url,'http://127.0.0.1').pathname
  const bytes=files.get(path==='/'?'index.html':path.slice(1))
  if(!bytes){response.writeHead(404);response.end();return}
  response.setHeader('Cache-Control','no-store')
  response.setHeader('Content-Type',path==='/'?'text/html; charset=utf-8':path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':path.endsWith('.ttf')?'font/ttf':'application/javascript')
  response.end(bytes)
}
