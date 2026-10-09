#!/usr/bin/env node
// Isolated preview of actual source components/platform. Fixture RPC only;
// no Host, credentials, native authorization or paid model requests.
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
const ui=fileURLToPath(new URL('../ui/',import.meta.url)), dist=join(ui,'dist')
const ids={menu:'@xharness/dsh-client-ui-model-selection',labels:'preview-model-labels',shell:'preview-settings-shell'}
const output=compileSourceModules(ui,[{id:ids.menu,source:'src/modules/model-selection/index.ts'},{id:ids.labels,source:'src/modules/model-selection/locales.ts'},{id:ids.shell,source:'src/modules/settings-general/SettingsRoot.tsx'}])
const manifest=JSON.parse(readFileSync(join(dist,'asset-manifest.json'),'utf8'))
const allowed=new Set(Object.keys(manifest.files))
const index=readFileSync(join(dist,'index.html'),'utf8')
const entry=index.match(/<script type="module" crossorigin src="([^"]+)"/)[1]
const themeCss=['base.css','design-platform.css','scrollbar.css','typography.css'].map(name=>readFileSync(join(ui,'src/modules/theme',name),'utf8')).join('\n')
const sheets=[...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m=>m[1])
export function createManagedModelPreview(){
 return createServer((req,res)=>{
  const url=new URL(req.url??'/', 'http://127.0.0.1')
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  let body,type='application/javascript; charset=utf-8'
  if(url.pathname==='/'){
   type='text/html; charset=utf-8'
   body=`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1">${sheets.map(href=>`<link rel="stylesheet" href="${href}">`).join('')}<style>${themeCss}</style><style>body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui}#preview-controls{padding:20px;display:flex;gap:12px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}#preview-controls button{background:var(--dsw-specific-menu);color:inherit;border:1px solid var(--dsw-alias-border-l3);padding:6px 10px;border-radius:8px}#fixture-composer{position:fixed;bottom:40px;right:24px;width:min(540px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l3);border-radius:20px;padding:18px;box-sizing:border-box}#fixture-picker{display:flex;justify-content:flex-end;margin-top:36px}</style><script>window.previewRegistrations={};window.__ModuleLoader__={load:row=>previewRegistrations[row.id]=row,create:options=>{window.staticModules=options.staticModules;window.dispatchEvent(new Event('preview-platform-ready'));throw Error('preview: Host boot intentionally disabled')}};</script>${[...output.keys()].map(id=>`<script src="/preview/${encodeURIComponent(id)}.js"></script>`).join('')}<script src="/fixture.js"></script><script type="module" src="${entry}"></script></head><body><div id="root"></div></body></html>`
  }else if(url.pathname==='/fixture.js')body=readFileSync(new URL('./fixtures/managed-model-menu-preview.js',import.meta.url))
  else if(url.pathname.startsWith('/preview/'))body=output.get(decodeURIComponent(url.pathname.slice(9,-3)))?.bytes
  else if(allowed.has(url.pathname.slice(1))){body=readFileSync(join(dist,url.pathname.slice(1)));type=url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.woff2')?'font/woff2':url.pathname.endsWith('.woff')?'font/woff':'application/javascript'}
  if(body===undefined){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body)
 })
}
if(process.argv[1]===fileURLToPath(import.meta.url))createManagedModelPreview().listen(Number(process.env.PORT??3193),'127.0.0.1',()=>console.log('Model-source UI preview: http://127.0.0.1:'+ (process.env.PORT??3193)))
