#!/usr/bin/env node
// Isolated visual preview of the real card. No native bridge, API or persistent consent.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'ui/package.json'))
const { buildSync } = require('esbuild')
const out = '/tmp/xharness-consent-preview'
mkdirSync(out, { recursive: true })
const component = JSON.stringify(join(root, 'ui/src/modules/experience/InstallationConsent.tsx'))
const modal = JSON.stringify(join(root, 'ui/src/modules/platform/primitives/Modal.tsx'))
const css = JSON.stringify(join(root, 'ui/src/modules/experience/Experience.css'))
const entry = join(out, 'preview.tsx')
writeFileSync(entry, `import * as React from 'react'; import {createRoot} from 'react-dom/client';
import {ConsentCard,consentLabels} from ${component}; import {Modal} from ${modal}; import ${css};
function Preview(){
 const [lang,setLang]=React.useState(new URLSearchParams(location.search).get('lang')==='en'?'en':'zh');
 const [dark,setDark]=React.useState(new URLSearchParams(location.search).get('theme')==='dark');
 const [choice,setChoice]=React.useState(null); const [open,setOpen]=React.useState(true);
 React.useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.lang=lang},[lang,dark]);
 const controls=<div className="preview-controls"><span>{lang==='zh'?'界面预览 · 不上报数据':'UI preview · no reports'}</span><div><button onClick={()=>setLang(lang==='zh'?'en':'zh')}>{lang==='zh'?'English':'中文'}</button><button onClick={()=>setDark(!dark)}>{dark?(lang==='zh'?'浅色':'Light'):(lang==='zh'?'深色':'Dark')}</button></div></div>;
 return <>{!open&&<main>{controls}<p>{lang==='zh'?(choice?'已选择开启（仅预览）':'已选择暂不开启（仅预览）'):(choice?'Enabled in this preview only':'Not enabled in this preview')}</p><button onClick={()=>{setOpen(true);setChoice(null)}}>{lang==='zh'?'重新预览':'Preview again'}</button></main>}<Modal open={open} headless title={consentLabels[lang].title} className="xhi-dialog" onClose={()=>{setChoice(false);setOpen(false)}}><ConsentCard copy={consentLabels[lang]} onChoose={v=>{setChoice(v);setOpen(false)}} /></Modal></>
};createRoot(document.getElementById('root')).render(<Preview/>);`)
buildSync({ entryPoints: [entry], outfile: join(out, 'preview.js'), bundle: true, platform: 'browser', jsx: 'automatic', nodePaths: [join(root, 'ui/node_modules')],
  alias: { '@xharness/dsh-client-ui-primitives': resolve(root, 'ui/src/modules/platform/primitives/Modal.tsx') },
  loader: { '.module.css': 'local-css' }, sourcemap: false })
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHarness — Installation consent preview</title><link rel="stylesheet" href="/preview.css"><style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#696969;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-border-l2:#dedede;--dsw-alias-border-inverted:#dedede;--dsw-alias-bg-mask-1:rgba(0,0,0,.16);--dsw-mask-blur:blur(2px);--dsw-shadow-lv3:0 20px 80px rgba(0,0,0,.12);--dsw-alias-state-error-primary:#ba3030}
:root[data-theme=dark]{color-scheme:dark;--dsw-alias-label-primary:#f1f1f1;--dsw-alias-label-secondary:#a3a3a3;--dsw-alias-bg-base:#171717;--dsw-alias-bg-layer-2:#202020;--dsw-alias-border-l2:#414141;--dsw-alias-border-inverted:#414141;--dsw-alias-bg-mask-1:rgba(0,0,0,.4)}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}main{padding:48px;text-align:center;opacity:.5}main button,.preview-controls button{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:inherit;padding:5px 9px}.preview-controls{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:10px}.preview-controls div{display:flex;gap:6px}.preview-controls button{font-size:11px}
</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>`)
const files = new Map([['/', 'index.html'], ['/preview.js', 'preview.js'], ['/preview.css', 'preview.css']])
createServer((req, res) => {
  const file = files.get(new URL(req.url || '/', 'http://localhost').pathname)
  if (!file) { res.writeHead(404); res.end(); return }
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(join(out, file)))
}).listen(3191, '127.0.0.1', () => process.stdout.write('Consent preview: http://127.0.0.1:3191/ (no reporting)\n'))
