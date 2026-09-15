// Isolated fixture: no production API, settings or user data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','package.json'));
const {chromium,webkit}=require('playwright');
const browser=await ({chromium,webkit}[process.env.UI_TEST_BROWSER??'chromium']).launch({headless:true,
  ...(process.env.UI_TEST_EXECUTABLE?{executablePath:process.env.UI_TEST_EXECUTABLE}:{})});
try {
  const page=await browser.newPage({viewport:{width:640,height:460}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<html lang="zh"><body style="font:16px system-ui;background:#f5f5f5"><dialog style="width:440px;border:1px solid #ddd;border-radius:12px;padding:24px"><h2>设置 / Settings</h2><label>外观 <select><option>深色 / Dark</option></select></label><p>隔离的保存失败测试，不连接客户端。</p></dialog></body></html>');
  await page.evaluate(()=>document.querySelector('dialog').showModal());
  await page.addScriptTag({content:readFileSync(new URL('../ui/overrides/settings-save-feedback.js',import.meta.url),'utf8')});
  await page.locator('select').focus();
  await page.evaluate(()=>{for(let i=0;i<20;i++) xhSettingsSaveFeedback('ui-theme',true)});
  const notice=page.getByRole('alert');
  assert.equal(await notice.count(),1);
  assert.equal(await page.locator('dialog [role="alert"]').count(),1,'notice shares the modal layer');
  await notice.waitFor({state:'visible'});
  assert.match(await notice.innerText(),/设置未保存/);
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT','notice does not steal focus');
  if(process.env.XHARNESS_UI_SCREENSHOT) await page.screenshot({path:process.env.XHARNESS_UI_SCREENSHOT});
  await page.evaluate(()=>xhSettingsSaveFeedback('locale',false));
  assert.equal(await notice.count(),1,'unrelated successful save must not clear failure');
  await page.getByRole('button',{name:'关闭提示'}).click();
  assert.equal(await notice.count(),0);
  await page.evaluate(()=>{document.documentElement.lang='en';xhSettingsSaveFeedback('locale',true)});
  assert.match(await notice.innerText(),/Settings were not saved/);
  await page.evaluate(()=>xhSettingsSaveFeedback('locale',false));
  assert.equal(await notice.count(),0);
  await page.setViewportSize({width:320,height:480});
  await page.evaluate(()=>{document.querySelector('dialog').close();xhSettingsSaveFeedback('ui-theme',true)});
  const box=await notice.boundingBox();
  assert.ok(box.x>=0 && box.x+box.width<=321,'notice fits narrow viewport');
  assert.deepEqual(errors,[]);
  console.log('Settings save notice browser: modal layer, localization, bounded DOM, focus, dismiss, success, narrow viewport passed');
} finally { await browser.close(); }
