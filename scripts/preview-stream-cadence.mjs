// Isolated comparison built from the actual before/after Markdown components.
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs'
import {resolve, dirname, extname} from 'node:path'
import {tmpdir} from 'node:os'
import http from 'node:http'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const root = new URL('../', import.meta.url).pathname
const output = resolve(process.env.STREAM_DEMO_DIR ?? resolve(tmpdir(), 'xh-stream-cadence-20261024'))
const baseline = '2b398856c2e3412fe6da828986a215f3f00403ef'
mkdirSync(output, {recursive:true})
const markdown = resolve(root,'ui/src/modules/platform/primitives/markdown')
await require('esbuild').build({entryPoints:[resolve(root,'ui/demo/stream-cadence.tsx')], bundle:true, format:'iife',platform:'browser',jsx:'automatic',outfile:resolve(output,'demo.js'),
  plugins:[{name:'pinned-baseline',setup(build){
    build.onResolve({filter:/baseline-stream-markdown$/},()=>({path:resolve(markdown,'MarkdownText.tsx'),namespace:'baseline'}))
    build.onResolve({filter:/^\.\/(use-stream-presentation|stream-presentation)$/ ,namespace:'baseline'},args=>({path:resolve(markdown,args.path+'.ts'),namespace:'baseline'}))
    build.onLoad({filter:/.*/,namespace:'baseline'},args=>({contents:execFileSync('git',['show',`${baseline}:${args.path.slice(root.length)}`],{cwd:root,encoding:'utf8'}),loader:extname(args.path)==='.tsx'?'tsx':'ts',resolveDir:dirname(args.path)}))
  }}],loader:{'.woff2':'file','.woff':'file','.ttf':'file'},define:{'process.env.NODE_ENV':'"production"'}})
writeFileSync(resolve(output,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHarness · 流式显示对比</title><link rel="stylesheet" href="/demo.css"></head><body><div id="root"></div><script src="/demo.js"></script></body></html>')
console.log(`Built pinned-before/current-after preview: ${output}`)
if(process.argv.includes('--build-only'))process.exit(0)
const mime={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'}
http.createServer((req,res)=>{const name=new URL(req.url,'http://127.0.0.1').pathname;if(name!=='/'&&!/^\/[A-Za-z0-9_.-]+$/.test(name)){res.writeHead(404);res.end();return}try{const data=readFileSync(resolve(output,name==='/'?'index.html':name.slice(1)));res.writeHead(200,{'Content-Type':name==='/'?'text/html; charset=utf-8':mime[extname(name)]??'application/octet-stream','Cache-Control':'no-store'});res.end(data)}catch{res.writeHead(404);res.end()}}).listen(Number(process.env.STREAM_DEMO_PORT??3270),'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:'+(process.env.STREAM_DEMO_PORT??3270)+'/'))
