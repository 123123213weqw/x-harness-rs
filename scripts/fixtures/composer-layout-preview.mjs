// A reusable isolated browser fixture and manual preview. All UI behavior comes
// from production source; only Host projections and mutation receipts are fake.
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {platformAliases} from '../build-platform-ui.mjs'
const repo=fileURLToPath(new URL('../../',import.meta.url)),ui=resolve(repo,'ui')
export function composerPreview() {
  const require=createRequire(resolve(ui,'package.json')),esbuild=require('esbuild')
  const built=esbuild.buildSync({absWorkingDir:repo,entryPoints:[resolve(repo,'scripts/fixtures/composer-layout-app.jsx')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,outdir:'/preview',entryNames:'fixture',jsx:'automatic',nodePaths:[resolve(ui,'node_modules')],alias:{...platformAliases(ui),immer:resolve(ui,'src/modules/client-runtime/vendor/immer/src/immer.ts'),'@xharness/dsh-client-runtime/client':resolve(ui,'src/modules/client-runtime/index.ts')},define:{'process.env.NODE_ENV':'"production"','process.env.CORDIS_SHARED':'undefined'},loader:{'.css':'text','.module.css':'local-css','.raw.css':'text','.svg':'text','.woff':'file','.woff2':'file','.ttf':'file'}})
  const outputs=new Map(built.outputFiles.map(file=>[file.path.slice('/preview'.length),file.contents]))
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHarness composer preview</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}body{font:14px/1.6 system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}button,input,textarea{font-family:inherit}#root{height:calc(100% - 50px)}.preview-chrome{height:50px;box-sizing:border-box;padding:12px 24px;border-bottom:1px solid #8883;font-size:12px;display:flex;justify-content:space-between;color:#888}.preview-transcript{box-sizing:border-box;flex:1 0 auto;display:flex;gap:16px;width:100%;max-width:680px;margin:0 auto;padding:60px 0}.preview-avatar{height:28px;width:28px;flex:none;border-radius:9px;display:grid;place-items:center;background:#8882}.preview-transcript h1{font-size:20px;line-height:28px;margin:0 0 12px;font-weight:600}.preview-transcript p{color:#888;margin:0 0 12px}@media(max-width:730px){.preview-transcript{padding:36px 24px}.preview-chrome{padding:12px 16px}}</style></head><body><header class="preview-chrome"><span>XHarness · Composer</span><span>Isolated preview</span></header><div id="root" style="height:calc(100% - 50px)"></div><script src="/fixture.js"></script></body></html>`
  return createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}const bytes=outputs.get(path);if(!bytes){res.writeHead(404);res.end();return}res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'application/javascript':'application/octet-stream');res.end(bytes)})
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const server=composerPreview(),port=Number(process.env.PORT??3197)
  server.listen(port,'127.0.0.1',()=>console.log(`Isolated composer preview: http://127.0.0.1:${server.address().port}/`))
}
