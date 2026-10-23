import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
const version=JSON.parse(readFileSync('scripts/ui-test-deps/package.json','utf8')).dependencies.playwright;
const require=createRequire(resolve(process.env.UI_TEST_DEPS,'package.json'));
assert.equal(require('playwright/package.json').version,version,'installed Playwright must match the locked image version');
const engines=(process.argv[2]??'chromium,webkit').split(',');
for(const engine of engines){
 assert.ok(['chromium','webkit'].includes(engine),'known CI browser required');
 const type=require('playwright')[engine];
 const executable=type.executablePath();
 assert.ok(executable.startsWith('/ms-playwright/'),'use the image-baked browser, not an unverified runner cache');
 assert.ok(existsSync(executable),'matching browser executable must exist in the pinned image');
 const browser=await type.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  await page.setContent('<!doctype html><button>Runtime ready</button>');
  assert.equal(await page.getByRole('button',{name:'Runtime ready'}).count(),1);
  const png=await page.screenshot();assert.equal(png.readUInt32BE(16),320);assert.equal(png.readUInt32BE(20),240);
  console.log(JSON.stringify({engine,version,executable,launch:true,png:true}));
 }finally{await browser.close();}
}
