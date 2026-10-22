#!/usr/bin/env node
// Actual GoalDock and platform primitives; isolated in-memory RPC receipts only.
// Never connects to a Host, credentials, user history, or model endpoints.
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
const ui=fileURLToPath(new URL('../ui/',import.meta.url)),dist=join(ui,'dist')
const output=compileSourceModules(ui,[{id:'@xharness/dsh-client-ui-goal',source:'src/modules/goal/index.ts'},{id:'preview-goal-labels',source:'src/modules/goal/locales.ts'}])
const manifest=JSON.parse(readFileSync(join(dist,'asset-manifest.json'),'utf8'))
const allowed=new Set(Object.keys(manifest.files)),index=readFileSync(join(dist,'index.html'),'utf8')
const entry=index.match(/<script type="module" crossorigin src="([^"]+)"/)[1]
const sheets=[...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m=>m[1])
const theme=['base.css','design-platform.css','scrollbar.css','typography.css'].map(name=>readFileSync(join(ui,'src/modules/theme',name),'utf8')).join('\n')
export function createGoalPreview(){
 return createServer((req,res)=>{
  const url=new URL(req.url??'/','http://127.0.0.1')
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  let body,type='application/javascript; charset=utf-8'
  if(url.pathname==='/'){
   type='text/html; charset=utf-8'
   body=`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1">${sheets.map(href=>`<link rel="stylesheet" href="${href}">`).join('')}<style>${theme}</style><style>
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui}*{box-sizing:border-box}#preview-controls{padding:20px 24px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}#preview-controls button,#preview-controls select{font:inherit;color:inherit;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l3);padding:5px 9px;border-radius:6px}main{width:min(800px,calc(100% - 32px));margin:72px auto 32px}.preview-message{font-size:15px;line-height:1.8;color:var(--dsw-alias-label-secondary);padding:0 20px 100px}#fixture-goal{--dsh-composer-card-max-width:800px;--dsh-composer-side-clearance:0px;--dsh-composer-dock-inset:5px}.preview-composer{border:1px solid var(--dsw-alias-border-l2);border-radius:24px;padding:20px;min-height:152px;background:var(--dsw-specific-tip)}.preview-composer textarea{resize:none;border:0;outline:0;width:100%;height:60px;font:inherit;font-size:16px;background:transparent;color:var(--dsw-alias-label-primary)}.preview-footer{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:14px}.preview-send{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}@media(max-width:520px){main{margin-top:24px}.preview-message{padding-bottom:80px}#preview-controls{padding:16px}.preview-composer{padding:16px}}
</style><script>window.previewRegistrations={};window.__ModuleLoader__={load:row=>previewRegistrations[row.id]=row,create:options=>{window.staticModules=options.staticModules;window.dispatchEvent(new Event('preview-platform-ready'));throw Error('goal preview: Host boot intentionally disabled')}};</script>${[...output.keys()].map(id=>`<script src="/preview/${encodeURIComponent(id)}.js"></script>`).join('')}<script src="/fixture.js"></script><script type="module" src="${entry}"></script></head><body><div id="root"></div></body></html>`
  }else if(url.pathname==='/fixture.js')body=readFileSync(new URL('./fixtures/goal-controls-preview.js',import.meta.url))
  else if(url.pathname.startsWith('/preview/'))body=output.get(decodeURIComponent(url.pathname.slice(9,-3)))?.bytes
  else if(allowed.has(url.pathname.slice(1))){body=readFileSync(join(dist,url.pathname.slice(1)));type=url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.woff2')?'font/woff2':url.pathname.endsWith('.woff')?'font/woff':url.pathname.endsWith('.ttf')?'font/ttf':'application/javascript'}
  if(body===undefined){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body)
 })
}
if(process.argv[1]===fileURLToPath(import.meta.url))createGoalPreview().listen(Number(process.env.PORT??3198),'127.0.0.1',()=>console.log('Goal controls preview: http://127.0.0.1:'+(process.env.PORT??3198)+' (fixture only)'))
