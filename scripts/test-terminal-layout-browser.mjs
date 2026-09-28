#!/usr/bin/env node
// Isolated layout regression using the shipped conversation, terminal, and
// product CSS. No user sessions or running Harness instance are touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? root, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const read = path => readFileSync(resolve(root, path), 'utf8')

const conversation = read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js')
const cssLine = conversation.split('\n').find(line => line.includes('const css') && line.includes('[data-conversation-composer-overlay]'))
assert.ok(cssLine, 'upstream conversation CSS must be present')
const conversationCss = JSON.parse(cssLine.trim().match(/^const \S+ = (".*");$/)[1])
const classBlock = conversation.match(/var ConversationRoot_module_css_default = \{([\s\S]*?)\};/)[1]
const classes = Object.fromEntries([...classBlock.matchAll(/"(\w+)": "([^"]+)"/g)].map(match => [match[1], match[2]]))
const terminal = read('ui/plugins/@xlang/xharness-client-ui-terminal/client.js')
const start = terminal.indexOf('const CSS = `') + 'const CSS = `'.length
assert.ok(start > 13, 'terminal CSS must be present')
const terminalCss = terminal.slice(start, terminal.indexOf('`', start))
const css = [conversationCss, terminalCss, read('ui/overrides/monochrome.css')].join('\n')

const browser = await ({ chromium, webkit })[engine].launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setContent(`<style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}${css}</style>
    <div id="root"><div class="${classes.root}" data-phase="active">
      <header class="${classes.header}" style="height:60px">Chat header</header>
      <div class="${classes.scrollBody}" data-conversation-scroll>
        <div data-slot="conversation.session" style="display:contents">
          <div class="${classes.viewArea}"><div style="height:8000px">Long chat</div></div>
        </div>
        <div class="${classes.composerSeat}" data-composer-seat>
          <div class="${classes.composerStack}">
            <div class="xhterm-dock" style="height:640px">
              <div class="xhterm-tabbar">Terminal</div>
              <div class="xhterm-viewport"><div class="xterm-viewport" style="height:100px;overflow:auto">
                <div style="height:1000px">Long terminal output</div>
              </div></div>
            </div>
            <div style="height:105px">Composer</div>
          </div>
        </div>
      </div>
    </div></div>`)

  const measure = () => page.evaluate(() => {
    const dock = document.querySelector('.xhterm-dock')
    const header = document.querySelector('header')
    const scroll = document.querySelector('[data-conversation-scroll]')
    const terminalScroll = document.querySelector('.xterm-viewport')
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
      windowScrollY: scrollY,
      headerTop: header.getBoundingClientRect().top,
      dockHeight: dock.getBoundingClientRect().height,
      dockBottom: dock.getBoundingClientRect().bottom,
      scrollOverscroll: getComputedStyle(scroll).overscrollBehaviorY,
      terminalOverscroll: getComputedStyle(terminalScroll).overscrollBehaviorY,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
    }
  })
  for (const height of [600, 460]) {
    await page.setViewportSize({ width: 900, height })
    for (const dark of [false, true]) {
      await page.evaluate(enabled => document.body.toggleAttribute('data-ds-dark-theme', enabled), dark)
      await page.mouse.move(500, 100)
      await page.mouse.wheel(0, -1000)
      const state = await measure()
      assert.ok(state.documentHeight <= height + 1, `document must not become a scroll container: ${JSON.stringify(state)}`)
      assert.equal(state.windowScrollY, 0)
      assert.equal(state.headerTop, 0, 'scrolling cannot pull the app header away')
      assert.ok(state.dockHeight < 640 && state.dockBottom <= height + 1, `dock must fit the WebView: ${JSON.stringify(state)}`)
      assert.equal(state.scrollOverscroll, 'contain')
      assert.equal(state.terminalOverscroll, 'contain')
      assert.equal(state.htmlBackground, dark ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)')
    }
  }
  console.log(`${engine}: terminal dock fits WebView, document stays fixed, scroll boundaries and theme backing verified`)
} finally {
  await browser.close()
}
