/** Exact latest master / strict-source platform, intercepted only before Host
 * boot. Feature tests consume real React, Cordis, slots and UI primitives. */
import {readFileSync,existsSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {compilePlatformUi} from '../build-platform-ui.mjs'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),ui=join(repo,'ui'),frozen=join(ui,'reference/master-a613970')
const html=readFileSync(join(frozen,'index.html'),'utf8'),entry=html.match(/<script type="module" crossorigin src="(\/assets\/[^"?]+\.js)"/)[1]
let built
export async function installOwnedViewPlatform(page,implementation,{origin='http://owned-platform-fixture.test'}={}){
 const source=implementation==='source'?(built??=compilePlatformUi(ui)):undefined
 const script=source?'/'+source.entryPath:entry
 const styles=[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(x=>x[1])
 if(source)styles.push(...source.cssPaths.map(x=>'/'+x))
 await page.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname,local=path.slice(1)
  if(path==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>${styles.map(path=>`<link rel="stylesheet" href="${path}">`).join('')}<script>window.__ModuleLoader__={create:options=>{window.staticModules=options.staticModules;throw Error('owned feature fixture: stop Host boot')}};</script><script type="module" src="${script}"></script></head><body><div id="root"></div></body></html>`})
  const bytes=source?.outputs.get(local)??(existsSync(join(frozen,local))?readFileSync(join(frozen,local)):undefined)
  if(!bytes)return route.abort()
  return route.fulfill({body:bytes,contentType:local.endsWith('.css')?'text/css':local.endsWith('.woff2')?'font/woff2':local.endsWith('.woff')?'font/woff':local.endsWith('.ttf')?'font/ttf':'application/javascript'})
 })
 await page.goto(origin+'/')
 await page.waitForFunction(()=>window.staticModules)
 await page.evaluate(()=>{window.React=staticModules.react;window.ReactDOM=staticModules['react-dom']})
}
/** Preserve an existing feature fixture's initial HTML after capturing the real
 * platform. Only inert DOM/style markup is adopted; fixture scripts are still
 * explicit test actions, not run from arbitrary HTML. */
export async function installOwnedViewHtml(page,implementation,html,options){
 await installOwnedViewPlatform(page,implementation==='legacy'?'legacy':'source',options)
 await page.evaluate(html=>{
  const parsed=new DOMParser().parseFromString(html,'text/html')
  document.documentElement.lang=parsed.documentElement.lang
  document.body.innerHTML=parsed.body.innerHTML
  document.body.style.cssText=parsed.body.style.cssText
  for(const style of parsed.head.querySelectorAll('style'))document.head.appendChild(document.importNode(style,true))
 },html)
}
