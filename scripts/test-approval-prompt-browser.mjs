// Upstream-shipped ApprovalPanel, its composer-takeover selection, and the real
// ui-primitives Button; only the host services/slot harness are fixtures. No
// running App or user data is used.
//
// Issue #75 reported the approval request as invisible to the user while the
// tool waited. This suite pins the user-facing half of that contract: a pending
// approval must actually mount a prompt, name the tool, carry the asker's
// reason and the paired shell command, and deliver the only two client
// answerable outcomes on the wire — with a one-shot latch that never leaks into
// the next request.
import { verifyConversationArtifact, exposeConversation, legacyConversation } from './conversation-artifact-test.mjs'
import { installOwnedViewPlatform } from './fixtures/owned-view-platform-browser.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const implementation = process.env.UI_TEST_IMPL ?? 'source'
assert.ok(['source', 'native', 'legacy', 'frozen'].includes(implementation), 'known approval test implementation')
const frozen = implementation === 'legacy' || implementation === 'frozen'
const dist = resolve(root, frozen ? 'ui/reference/master-a613970' : 'ui/dist')
const shippedConversation = frozen ? legacyConversation().toString() : verifyConversationArtifact()
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engines = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await engines[engine].launch({ headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(8000)
  // Read the immutable HTML's real entry / compile the strict owned platform;
  // filename guesses cannot select a stale index bundle or hang on undefined.
  await installOwnedViewPlatform(page, frozen ? 'legacy' : 'source')
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  const plugins = readdirSync(resolve(dist,'plugins/@xharness'));
  for (const name of plugins) {
    const file = resolve(dist,'plugins/@xharness',name,'client.js');
    let source=readFileSync(file,'utf8');
    // ApprovalPanel is registered through a slot, not exported; surface it and the
    // selector so the takeover contract can be exercised directly.
    if(name==='dsh-client-ui-conversation') {
      assert.equal(source, shippedConversation, 'actual approval Conversation factory is the selected fresh/immutable artifact')
      source=exposeConversation(shippedConversation,["ApprovalPanel", "selectApproval", ...(frozen ? [] : ["PermissionSelect"])]);
    }
    await page.addScriptTag({content:source});
  }
  await page.evaluate(() => {
    const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;if(cache[name])return cache[name];const registration=registrations[name];if(registration===undefined)throw Error('Missing actual approval dependency: '+id);return cache[name]=registration.factory(load)};
    const React=staticModules.react,DOM=staticModules['react-dom'];
    const conversation=load('@xharness/dsh-client-ui-conversation/client');
    const runtime=load('@xharness/dsh-client-runtime/client');
    // The palette is provided by the theme plugin at apply time, not by the module
    // CSS; install it so the evidence screenshots carry the real tokens instead of
    // bare DOM that could be misread as an unstyled prompt.
    const themeCtx={effect:fn=>fn(),provide:(name,value)=>{themeCtx[name]=value},on:()=>{},emit:()=>{},
      settingsScope:{bind:()=>({subscribe:()=>()=>{},getSnapshot:()=>({value:{preference:'light'}})})},
      locale:{register:()=>()=>{}},slots:{inject:()=>{}}};
    load('@xharness/dsh-client-ui-theme/client').apply(themeCtx);
    document.documentElement.dataset.theme='light';
    for(const [name,value] of Object.entries(themeCtx.theme.getTheme().active.tokens))document.documentElement.style.setProperty(name,value);
    document.body.style.fontFamily='system-ui,sans-serif';
    document.body.style.background='var(--dsw-alias-bg-base)';
    document.body.style.color='var(--dsw-alias-label-primary)';
    // The composer layout custom properties live on the shipped ConversationRoot
    // class, not on :root; scope them onto the mount so the prompt keeps the real
    // composer clearance instead of silently dropping its padding and max-width.
    const conversationRoot=[...document.querySelectorAll('style[data-plugin-css]')].find(tag=>tag.dataset.pluginCss.endsWith('ConversationRoot.module.css'));
    if(conversationRoot===undefined)throw new Error('ConversationRoot stylesheet missing: composer scope unknown');
    const composerVars=[...conversationRoot.textContent.matchAll(/(--dsh-[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(match=>[match[1],match[2]]);
    if(composerVars.length===0)throw new Error('ConversationRoot exposes no composer custom properties');
    for(const [name,value] of composerVars)document.getElementById('root').style.setProperty(name,value);
    const root=DOM.createRoot(document.getElementById('root'));
    // Verbatim `conversation` namespace strings: a rename must fail loudly, not
    // silently pass through an identity `t`.
    const STRINGS={
      'approval.waiting':'等待审批',
      'approval.reviewing':'正在代你审核…',
      'approval.detail.aria':'审批详情',
      'approval.escalation':'工具 {toolName} 请求越权执行',
      'approval.reject':'拒绝',
      'approval.allowOnce':'允许一次',
    };
    window.t=(key,params)=>{const raw=STRINGS[key];if(raw===undefined)throw new Error('unexpected approval string: '+key);return params===undefined?raw:raw.replace(/\{(\w+)\}/g,(_,k)=>String(params[k]))};
    window.answers=[];window.accept=true;window.hold=false;window.snapshot=void 0;
    window.setAccept=value=>{window.accept=value};
    window.setHold=value=>{window.hold=value};
    window.release=()=>{};
    window.selectPick=interactions=>{const picked=conversation.selectApproval({interactions});return picked===null?null:picked.kind};
    window.renderApproval=(options={})=>{
      const wait={key:options.key??'a:appr-1',sessionId:options.sessionId??'test',
        payload:{reviewing:options.reviewing,approvalId:options.approvalId??'appr-1',toolName:options.toolName??'bash',
          ...options.reason===undefined?{}:{reason:options.reason},
          ...options.callId===undefined?{}:{callId:options.callId}},
        respond:answer=>{
          window.answers.push(answer);
          const settle=()=>window.accept?{accepted:true}:{accepted:false,reason:'stale approval'};
          if(!window.hold)return Promise.resolve(settle());
          return new Promise(resolve=>{window.release=()=>resolve(settle())});
        }};
      DOM.flushSync(()=>root.render(React.createElement('div',{'data-composer-seat':''},
        React.createElement('div',{'data-slot':'conversation.composer'},
          React.createElement('div',{'data-chain-overlay-fallback':'conversation.composer',style:{display:'none'}},
            React.createElement('div',{'data-normal-composer':''},React.createElement('textarea',{'aria-label':'Message the agent'}))),
          React.createElement(conversation.ApprovalPanel,{matched:wait,t:window.t,useSession:selector=>selector(window.snapshot)})))));
    };
    window.permissionCommands=[];
    window.renderPermission=(currentValue='workspace-write-ai-review',locked=false)=>{
      const options=[
        {value:'workspace-write',name:'Workspace Write'},
        {value:'workspace-write-ai-review',name:'AI review'},
        {value:'danger-full-access',name:'Full access'},
        {value:'custom',name:'Custom'},
      ];
      DOM.flushSync(()=>root.render(React.createElement('div',{'data-permission-preview':'',
        style:{containerType:'inline-size',width:600,padding:16,margin:'300px 0 0 120px'}},
        React.createElement(conversation.PermissionSelect,{value:{currentValue,options},locked,
          command:async line=>{permissionCommands.push(line);return true},
          t:(key,args)=>key==='input.accessMode'?`Permission mode: ${args.name}`:key}))));
    };
    // A paired running bash-family call, as the transcript stores it, so the
    // panel can resolve the command line through the Chat Node index.
    window.pairedCall=(callId,args)=>window.snapshot={chat:{nodes:new Map([[runtime.conversationContextKey('tool-call',callId),
      {kind:'tool-call',data:{root:{callId,argsRaw:JSON.stringify(args),name:'bash',callView:null,time:1,turn:1,step:1,subCalls:[]}}}]])}};
    window.buttonState=()=>[...document.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled}));
    window.renderApproval();
  });
  // A newly advertised Host preset must render on both permission surfaces.
  // Use the real shipped Menu and palette, not a mock SVG or a screenshot-only page.
  if (!frozen) {
    const evidence=resolve(root,'dist/approval-ui');mkdirSync(evidence,{recursive:true});
    const permissionColors=[];
    for (const dark of [false,true]) {
      await page.evaluate(dark=>{
        document.body.toggleAttribute('data-ds-dark-theme',dark);
        window.renderPermission();
      },dark);
      const trigger=page.getByRole('button',{name:'Permission mode: AI review',exact:true});
      const glyph=trigger.locator('svg').first();
      assert.notEqual(await trigger.locator('span').nth(1).evaluate(el=>getComputedStyle(el).display),'none','wide composer keeps the mode label');
      assert.equal(await trigger.locator('svg').count(),2,'AI review has a leading shield as well as the dropdown chevron');
      assert.equal(await glyph.getAttribute('aria-hidden'),'true');
      assert.deepEqual(await glyph.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),{width:14,height:14},'trigger keeps the existing permission icon size');
      assert.equal(await glyph.locator('path').count(),2,'shield and sparkle are both painted');
      assert.ok((await glyph.locator('path').evaluateAll(paths=>paths.map(el=>({width:el.getBBox().width,height:el.getBBox().height})))).every(box=>box.width>0&&box.height>0),'both SVG paths have valid, non-empty geometry');
      const color=await glyph.locator('path').first().evaluate(el=>getComputedStyle(el).stroke);
      permissionColors.push(color);
      assert.equal(color,await trigger.evaluate(el=>getComputedStyle(el).color),'shield follows the active palette, not a hard-coded color');
      const triggerMarkup=await glyph.evaluate(el=>el.innerHTML);
      await trigger.click();
      const item=page.getByRole('menuitem',{name:'AI review',exact:true});
      await item.waitFor();
      assert.equal(await page.getByRole('menuitem').count(),3,'Custom stays display-only');
      const menuGlyph=item.locator('svg').first();
      assert.equal(await menuGlyph.evaluate(el=>el.innerHTML),triggerMarkup,'menu and current preset share the same AI glyph');
      assert.deepEqual(await menuGlyph.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),{width:16,height:16},'menu keeps the existing 16px leading icon size');
      await page.screenshot({path:resolve(evidence,`${engine}-${implementation}-ai-review-${dark?'dark':'light'}.png`),clip:{x:120,y:160,width:280,height:220}});
      await trigger.press('Escape');
      await page.getByRole('menu').waitFor({state:'detached'});
      // At a narrow composer width labels deliberately hide. The icon and full
      // accessible name must remain, so AI review never becomes an empty chip.
      await page.locator('[data-permission-preview]').evaluate(el=>el.style.width='320px');
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-permission-preview] button > span:nth-child(2)')).display==='none');
      assert.equal(await glyph.isVisible(),true);
      assert.equal(await trigger.getAttribute('aria-label'),'Permission mode: AI review');
      await page.locator('[data-permission-preview]').evaluate(el=>el.style.width='600px');
    }
    assert.notEqual(permissionColors[0],permissionColors[1],'AI shield changes with the real light/dark palette');
    await page.evaluate(()=>{document.body.removeAttribute('data-ds-dark-theme');window.renderPermission('workspace-write')});
    await page.getByRole('button',{name:'Permission mode: Workspace Write',exact:true}).click();
    await page.getByRole('menuitem',{name:'AI review',exact:true}).click();
    await page.waitForFunction(()=>permissionCommands.length===1);
    assert.deepEqual(await page.evaluate(()=>permissionCommands),['/permission workspace-write-ai-review'],'glyph changes do not alias or bypass the AI review command');
    assert.equal(await page.getByRole('dialog').count(),0,'selecting AI review does not open the Full access gate');
    await page.evaluate(()=>window.renderPermission('workspace-write-ai-review',true));
    assert.equal(await page.getByRole('button',{name:'Permission mode: AI review',exact:true}).isDisabled(),true,'locked contexts remain locked');
    await page.evaluate(()=>window.renderApproval());
  }
  // The approval is the only client-answerable carrier; a question never satisfies it.
  assert.equal(await page.evaluate(()=>window.selectPick([])),null,'no interactions must not mount the approval prompt');
  assert.equal(await page.evaluate(()=>window.selectPick([{kind:'question'}])),null,'a question must not mount the approval prompt');
  assert.equal(await page.evaluate(()=>window.selectPick([{kind:'question'},{kind:'approval'}])),'approval','a pending approval wins the composer takeover');
  assert.equal(await page.evaluate(()=>window.selectPick([{kind:'approval'}])),'approval');

  const panel=page.locator('[data-approval-key]');
  const detail=page.locator('[data-approval-scroll]');
  const reject=page.getByRole('button',{name:'拒绝',exact:true});
  const allowOnce=page.getByRole('button',{name:'允许一次',exact:true});
  assert.equal(await panel.count(),1,'a pending approval must be visible to the user');
  assert.equal(await panel.getAttribute('data-approval-key'),'a:appr-1','render identity is the carrier key');
  assert.equal((await panel.innerText()).includes('等待审批'),true,'the prompt names the wait');
  assert.equal(await detail.getAttribute('role'),'group');
  assert.equal(await detail.getAttribute('aria-label'),'审批详情');
  assert.equal(await detail.locator('div').count(),1,'no paired command hides the command line');
  assert.equal((await panel.innerText()).includes('工具 bash 请求越权执行'),true,'the headline falls back to the escalation string with the tool name');
  assert.equal(await reject.count(),1);
  assert.equal(await allowOnce.count(),1);
  assert.equal(await page.getByRole('textbox',{name:'Message the agent',exact:true}).isVisible(),false,'a pending approval retains the composer takeover');

  // The asker's own reason outranks the generic escalation sentence.
  await page.evaluate(()=>window.renderApproval({reason:'删除工作区内全部构建产物'}));
  assert.equal((await panel.innerText()).includes('删除工作区内全部构建产物'),true,'an explicit reason is shown verbatim');
  assert.equal((await panel.innerText()).includes('工具 bash 请求越权执行'),false,'the generic sentence yields to the reason');

  // The paired shell command is what the user is actually approving.
  await page.evaluate(()=>{window.pairedCall('call-9',{command:'rm -rf build'});window.renderApproval({callId:'call-9'})});
  assert.equal(await detail.locator('div').count(),2,'a paired running call shows its command');
  assert.equal((await detail.locator('div').nth(1).innerText()).trim(),'rm -rf build');
  // A non-bash-family call carries no command; the line must hide, not print null.
  await page.evaluate(()=>{window.pairedCall('call-10',{path:'notes.md'});window.renderApproval({callId:'call-10'})});
  assert.equal(await detail.locator('div').count(),1,'a call without a command hides the line');
  await page.evaluate(()=>{window.pairedCall('call-11',{});window.snapshot.chat.nodes.forEach(node=>{node.data.root.argsRaw='not json'});window.renderApproval({callId:'call-11'})});
  assert.equal(await detail.locator('div').count(),1,'unparsable call args must not surface or throw');

  // Both answerable outcomes, on the wire, with the audit correlation the host reconciles.
  // Frozen pre-feature baseline still exercises its original human contract.
  if (!frozen) {
    await page.evaluate(()=>window.renderApproval({reviewing:true}));
    assert.match(await page.locator('[data-approval-key]').innerText(),/正在代你审核/);
    assert.equal(await page.getByRole('button',{name:'允许一次',exact:true}).isDisabled(),true,'AI review cannot be accidentally overridden by allow');
    assert.equal(await page.getByRole('button',{name:'拒绝',exact:true}).isDisabled(),false,'user can reject during AI review');
    await page.evaluate(()=>window.renderApproval({reviewing:false}));
    assert.equal(await page.getByRole('button',{name:'允许一次',exact:true}).isEnabled(),true,'fallback restores manual approval on the same request');
  }
  await page.evaluate(()=>window.renderApproval());
  await allowOnce.click();
  assert.deepEqual(await page.evaluate(()=>window.answers),[{ok:true,value:{sessionId:'test',approvalId:'appr-1',outcome:'allowed-once'}}],'allow-once posts the approval correlation and outcome');
  assert.deepEqual(await page.evaluate(()=>window.buttonState().map(b=>b.disabled)),[true,true],'both actions latch once answered');
  await page.evaluate(()=>window.renderApproval());
  assert.deepEqual(await page.evaluate(()=>window.buttonState().map(b=>b.disabled)),[true,true],'re-rendering the same request must not rearm the latch');
  await page.evaluate(()=>window.renderApproval({key:'a:appr-2',approvalId:'appr-2'}));
  assert.deepEqual(await page.evaluate(()=>window.buttonState().map(b=>b.disabled)),[false,false],'the one-shot latch must not leak into the next approval');
  await page.evaluate(()=>window.renderApproval({key:'a:appr-3',approvalId:'appr-3'}));
  await reject.click();
  assert.deepEqual(await page.evaluate(()=>window.answers.at(-1)),{ok:true,value:{sessionId:'test',approvalId:'appr-3',outcome:'rejected'}},'reject posts the refusal for its own approval id');

  // A refused receipt must rearm the same prompt instead of stranding the user.
  await page.evaluate(()=>{window.setAccept(false);window.setHold(true);window.renderApproval({key:'a:appr-4',approvalId:'appr-4'})});
  await allowOnce.click();
  assert.deepEqual(await page.evaluate(()=>window.buttonState().map(b=>b.disabled)),[true,true],'the latch holds while the host receipt is in flight');
  await page.evaluate(()=>{window.setHold(false);window.release()});
  await page.waitForFunction(()=>window.buttonState().every(b=>b.disabled===false));
  assert.equal(await panel.count(),1,'a refused receipt keeps the prompt mounted for a retry');
  await page.evaluate(()=>window.setAccept(true));

  const evidence=resolve(root,'dist/approval-ui');mkdirSync(evidence,{recursive:true});
  await page.evaluate(()=>window.renderApproval({reason:'删除工作区内全部构建产物'}));
  await page.screenshot({path:resolve(evidence,engine+'-'+implementation+'-desktop.png')});
  await page.setViewportSize({width:375,height:700});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=375),true,'narrow viewport must not overflow');
  await page.screenshot({path:resolve(evidence,engine+'-'+implementation+'.png')});
  assert.deepEqual(errors.filter(e=>e!=='owned feature fixture: stop Host boot'),[]);
  console.log(engine+'/'+implementation+': approval prompt mounted, waiting strip, escalation fallback, explicit reason, paired command shown/hidden/unparsable, allow-once and reject wire payloads, one-shot latch, no latch leak across requests, refused receipt retry, composer takeover, narrow layout passed');
} finally {await browser.close()}
