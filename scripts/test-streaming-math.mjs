import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
import {patchStreamingMath} from './patch-streaming-math.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dist=resolve(root,'ui/dist');
const html=readFileSync(resolve(dist,'index.html'),'utf8'),asset=html.match(/src="(\/assets\/index-[^"?]+\.js)/)[1];
const source=readFileSync(resolve(dist,'.'+asset),'utf8');
assert.equal(patchStreamingMath(source),source);
assert.equal(patchStreamingMath(source.replace('Parse with the same math','Old implementation of math')),source);
assert.throws(()=>patchStreamingMath('changed upstream'),/anchors changed/);
new Script(readFileSync(resolve(root,'ui/overrides/streaming-math.js'),'utf8'));
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';const browser=await require('playwright')[engine].launch({headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const assets=readdirSync(resolve(dist,'assets'));
 await page.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname,name=path.slice('/assets/'.length);
  if(path.startsWith('/assets/')&&assets.includes(name))return route.fulfill({body:readFileSync(resolve(dist,'assets',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  if(path==='/')return route.fulfill({contentType:'text/html',body:`<script>window.__ModuleLoader__={create:o=>{window.staticModules=o.staticModules;throw Error('fixture stop boot')}};</script><script type="module" src="${asset}"></script><div id="root"></div>`});
  return route.abort();
 });
 await page.goto('http://math.test');await page.waitForFunction(()=>window.staticModules);
 await page.evaluate(()=>{
  const R=staticModules.react,D=staticModules['react-dom'],M=staticModules['@deepseek-ai/dsh-client-ui-primitives'].MarkdownText;
  const root=D.createRoot(document.getElementById('root'));const labels={copyLabel:'copy',copiedLabel:'copied'};
  window.renderMath=(text,streaming=true,key='test')=>D.flushSync(()=>root.render(R.createElement(M,{text,streaming,key,codeLabels:labels})));
 });
 let checks=0;
 const cases=[
  ['inline dollar','公式 $x^2+1$ 后面继续回答。',1],
  ['inline backslash',String.raw`公式 \(\frac{a}{b}\) 后面继续。`,1],
  ['display dollar','前文\n\n$$\nx^2+y^2=z^2\n$$\n\n后文',1],
  ['same-line display','$$x^2$$\n\n后文',1],
  ['display backslash',String.raw`\[\frac{a}{b}\]`+'\n\n后文',1],
  ['matrix','$$\n'+String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`+'\n$$',1],
  ['code','`$x$`\n\n```latex\n$$x^2$$\n```',0],
  ['escaped dollar',String.raw`金额 \$20；代码 \$x\$`,0],
  ['mixed','中文 $\u03b1+\u03b2$\n\n$$\nx^2\n$$\n\n```js\nconst x="$y$";\n```',2],
 ];
 for(const [name,text,count] of cases){
  // Each code unit arrives separately, including backslashes and delimiter splits.
  for(let i=1;i<=text.length;i++)await page.evaluate(({text,key})=>renderMath(text,true,key),{text:text.slice(0,i),key:name});
  assert.equal(await page.locator('.katex').count(),count,name+' renders before stream ends');
  const streaming=await page.locator('#root').innerHTML();
  await page.evaluate(({text,key})=>renderMath(text,false,key),{text,key:name});
  assert.equal(await page.locator('.katex').count(),count,name+' final count');
  if(!text.includes('```'))assert.equal(await page.locator('#root').innerHTML(),streaming,name+' final projection equals streaming');
  checks++;
 }
 for(const text of ['$$','$$\nx^2',String.raw`\[x^2`,String.raw`\(x^2`,'$x^2']){
  await page.evaluate(text=>renderMath(text,true,'partial'),text);
  assert.equal(await page.locator('.katex').count(),0,'partial math stays literal '+text);
  assert.ok((await page.locator('#root').innerText()).includes('x^2')||text==='$$');checks++;
 }
 // An earlier formula does not await completion of the following unfinished formula.
 await page.evaluate(()=>renderMath('$a^2$\n\n$$\nb^2',true,'mixed-partial'));
 assert.equal(await page.locator('.katex').count(),1);checks++;
 // Frozen paragraph/KaTeX DOM remains stable across tail updates (no full re-render).
 await page.evaluate(()=>{renderMath('$a^2$\n\nsecond\n\nthird\n\nfourth',true,'frozen');window.firstFormula=document.querySelector('.katex')});
 await page.evaluate(()=>renderMath('$a^2$\n\nsecond\n\nthird\n\nfourth more text',true,'frozen'));
 assert.ok(await page.evaluate(()=>firstFormula===document.querySelector('.katex')));checks++;
 // Replacement/retry must reset frozen content instead of leaving old formula nodes.
 await page.evaluate(()=>renderMath('Replacement text',true,'frozen'));assert.equal(await page.locator('.katex').count(),0);checks++;
 await page.evaluate(()=>renderMath(String.raw`$\notARealCommand$`,true,'bad'));assert.ok(await page.locator('#root').innerText());checks++;
 assert.deepEqual(errors.filter(e=>!e.includes('fixture stop boot')),[]);
 console.log(JSON.stringify({engine,checks,asset,passed:'stream fragments, closed/unclosed math, code isolation, final equivalence, frozen DOM, replacement, invalid TeX'}));
}finally{await browser.close()}
