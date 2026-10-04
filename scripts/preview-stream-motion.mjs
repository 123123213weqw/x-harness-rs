// Local-only, zero-API fixture. Uses the owned production Markdown renderer.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import http from 'node:http'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const root = new URL('../', import.meta.url).pathname
const output = '/tmp/xh-stream-motion-20261004'
mkdirSync(output, { recursive: true })
await require('esbuild').build({ entryPoints: [resolve(root, 'ui/demo/stream-motion.tsx')], bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: resolve(output, 'demo.js'), alias: { '@xharness/dsh-client-ui-primitives': resolve(root, 'ui/src/modules/platform/primitives/index.ts') }, plugins: [{ name: 'legacy-reasoning-css', setup(build) { build.onLoad({ filter: /\/(ReasoningRow|accessibility)\.css$/ }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' })) } }], loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' } })
writeFileSync(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流式文字 · XHarness</title><link rel="stylesheet" href="/demo.css"></head><body><div id="root"></div><script src="/demo.js"></script></body></html>')
if (process.argv.includes('--build-only')) process.exit(0)
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
http.createServer((request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname
  if (name !== '/' && !/^\/[A-Za-z0-9_.-]+$/.test(name)) { response.writeHead(404); response.end(); return }
  try {
    const file = resolve(output, name === '/' ? 'index.html' : name.slice(1))
    const bytes = readFileSync(file)
    response.writeHead(200, { 'Content-Type': name === '/' ? 'text/html; charset=utf-8' : mime[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(bytes)
  } catch { response.writeHead(404); response.end() }
}).listen(3267, '127.0.0.1', () => console.log('Zero-API stream demo: http://127.0.0.1:3267/'))
