import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { patchChatReadingWidth } from './patch-chat-reading-width.mjs'

const dist = resolve('ui/dist')
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const id = '@xharness/dsh-client-ui-conversation'
const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
const source = bytes.toString()
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
assert.equal(graph.entries.find(entry => entry.id === id)?.rev, hash(bytes))
assert.equal(graph.rev, hash(Buffer.from(JSON.stringify(graph.entries))))
assert.equal(patchChatReadingWidth(id, bytes).toString(), source)
assert.match(source, /--dsh-chat-content-width:680px/)
assert.match(source, /\.IxU-fW_column\{max-width:var\(--dsh-chat-content-width\)/)
assert.match(source, /--dsh-composer-card-max-width:calc\(var\(--dsh-chat-content-width\) \+ 32px\)/)
assert.match(readFileSync('scripts/assemble-static-ui.mjs', 'utf8'), /bytes = patchChatReadingWidth\(entry\.name, bytes\)/)

const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const { chromium } = createRequire(resolve(deps, 'package.json'))('playwright')
const browser = await chromium.launch({ headless: true })
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!file.startsWith(dist + sep)) return response.writeHead(403).end()
  try {
    const body = readFileSync(file)
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(file)] ?? 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': mime }).end(body)
  } catch {
    response.writeHead(404).end()
  }
})
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  for (const width of [800, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const card = page.locator('[data-composer-card]')
    await card.waitFor()
    const geometry = await card.evaluate(element => {
      const root = element.closest('[class*="lvQYKa_root"]')
      return { card: element.getBoundingClientRect().width, column: getComputedStyle(root).getPropertyValue('--dsh-chat-content-width').trim(), page: document.documentElement.scrollWidth }
    })
    assert.equal(geometry.column, '680px')
    assert.ok(geometry.card <= 713, `composer stays within the reading column at ${width}px`)
    assert.ok(geometry.page <= width, `no horizontal overflow at ${width}px`)
    if (process.env.CHAT_WIDTH_SCREENSHOT && width === 1440) {
      await page.screenshot({ path: process.env.CHAT_WIDTH_SCREENSHOT })
    }
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}
console.log('chat reading width: shared 680px column, responsive composer, rebuild and graph passed')
