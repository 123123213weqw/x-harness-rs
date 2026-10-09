#!/usr/bin/env node
// Serves the assembled product with its existing readiness fixture. No Host,
// native bridge, sign-in, credentials or reporting endpoint is enabled here.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../ui/dist/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'asset-manifest.json'), 'utf8'))
const files = new Set(['index.html', 'asset-manifest.json', ...Object.keys(manifest.files)])
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', wasm: 'application/wasm' }
const port = Number(process.env.PORT ?? 3192)
createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/' && !url.searchParams.has('fixture')) {
    res.writeHead(302, { Location: '/?fixture=1&lang=zh' }); res.end(); return
  }
  const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  if (!files.has(path)) { res.writeHead(404); res.end(); return }
  let body = readFileSync(join(root, path))
  if (path === 'index.html') {
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
    // Preview-only locale selection; the real product still follows its Host
    // preference/browser language. These controls do not save user settings.
    const controls = `<script>Object.defineProperty(navigator,'languages',{get:()=>['${lang}']});Object.defineProperty(navigator,'language',{get:()=>'${lang}'});</script>`
    const banner = `<aside style="position:fixed;top:8px;right:12px;z-index:80;font:11px system-ui;color:var(--dsw-alias-label-secondary);padding:6px 10px;background:var(--dsw-alias-bg-base);border-radius:8px">${lang === 'zh' ? '界面预览 · 示例会话 · 未接账号服务' : 'UI preview · fixture chats · no account service'} &nbsp; <a style="color:inherit" href="/?fixture=1&lang=${lang === 'zh' ? 'en' : 'zh'}">${lang === 'zh' ? 'English' : '中文'}</a></aside>`
    body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + controls).replace('</body>', banner + '</body>'))
  }
  res.writeHead(200, { 'Content-Type': types[path.split('.').at(-1)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}).listen(port, '127.0.0.1', () => console.log(`Account menu preview: http://127.0.0.1:${port}/ (fixture only)`))
