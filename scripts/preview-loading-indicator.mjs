// Local-only preview of the real component; no Host, model, or tools.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../ui/package.json', import.meta.url))
export async function startLoadingPreview({ output = resolve(root, 'dist/loading-preview'), port = 4187, buildOnly = false } = {}) {
  mkdirSync(output, { recursive: true })
  await require('esbuild').build({
    entryPoints: [resolve(root, 'ui/demo/loading-indicator.tsx')], bundle: true, format: 'iife',
    platform: 'browser', jsx: 'automatic', outfile: resolve(output, 'demo.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'component-css-text', setup(build) {
      build.onLoad({ filter: /\/LoadingIndicator\.css$/ }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
    } }],
  })
  for (const name of ['base.css', 'design-platform.css', 'scrollbar.css']) writeFileSync(resolve(output, name), readFileSync(resolve(root, 'ui/src/modules/theme', name)))
  for (const name of ['monochrome.css', 'motion-tokens.css']) writeFileSync(resolve(output, name), readFileSync(resolve(root, 'ui/overrides', name)))
  writeFileSync(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHarness · 等待动效</title>' + ['base.css', 'design-platform.css', 'scrollbar.css', 'monochrome.css', 'motion-tokens.css', 'demo.css'].map(name => '<link rel="stylesheet" href="/' + name + '">').join('') + '</head><body><div id="root"></div><script src="/demo.js"></script></body></html>')
  if (!buildOnly) {
    const names = new Set(['index.html', 'demo.js', 'demo.css', 'base.css', 'design-platform.css', 'scrollbar.css', 'monochrome.css', 'motion-tokens.css'])
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' }
    const server = createServer((request, response) => {
      const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html'
      if (!names.has(name)) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': types[extname(name)], 'Cache-Control': 'no-store' })
      response.end(readFileSync(resolve(output, name)))
    })
    await new Promise((ready, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', ready)
    })
    return server
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startLoadingPreview({
    output: resolve(process.env.XH_LOADING_PREVIEW_OUTPUT ?? resolve(root, 'dist/loading-preview')),
    port: Number(process.env.PORT ?? 4187), buildOnly: process.argv.includes('--build-only'),
  })
  if (server) console.log('Isolated loading preview: http://127.0.0.1:' + server.address().port + '/')
}
