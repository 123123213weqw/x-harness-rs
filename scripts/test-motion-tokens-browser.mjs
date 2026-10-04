#!/usr/bin/env node
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
const pluginCss = name => read(`ui/src/modules/${name}/${name[0].toUpperCase()+name.slice(1)}.css`)

const styles = [
  read('ui/overrides/motion-tokens.css'),
  pluginCss('terminal'),
  pluginCss('tasks'),
  pluginCss('motion'),
  read('ui/overrides/logo-motion.css'),
].join('\n')
const browser = await ({ chromium, webkit })[engine].launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  await page.setContent(`<style>${styles}</style>
    <div id="dock" class="xhterm-dock xhterm-dock-closing"></div>
    <div id="task" class="xhtask-panel"></div>
    <p id="stream" data-xh-stream-animate="true">stream</p>
    <img id="logo" class="xh-logo-sweep" src="/app-icon-512.png" width="10" height="10">
    <div class="U910La_root"><span class="U910La_brandIdentity"><span id="brand-mark" class="U910La_brandMark"><span>X</span></span><span id="brand-name" class="U910La_brandName">XHarness</span></span></div>`)
  const properties = () => page.evaluate(() => Object.fromEntries(
    ['dock', 'task', 'stream', 'logo', 'brand-mark', 'brand-name'].map(id => {
      const style = getComputedStyle(document.getElementById(id))
      return [id, {
        name: style.animationName,
        duration: style.animationDuration,
        easing: style.animationTimingFunction,
        display: style.display,
        opacity: style.opacity,
        width: style.width,
      }]
    }),
  ))
  let value = await properties()
  assert.equal(value.dock.name, 'xhterm-dock-out')
  assert.equal(value.task.name, 'none', 'Tasks is a page, not an animated drawer')
  assert.equal(value.dock.duration, '0.18s')
  assert.equal(value.task.duration, '0s')
  assert.equal(value.stream.duration, '0.9s')
  assert.equal(value.logo.duration, '5s')
  assert.equal(value['brand-mark'].name, 'xh-sidebar-mark-out')
  assert.equal(value['brand-name'].name, 'xh-sidebar-name-in')
  assert.equal(value['brand-mark'].duration, '0.26s')
  assert.match(value.dock.easing, /cubic-bezier\(0\.23, 1, 0\.32, 1\)/)

  // The terminal drawer follows its token; Tasks remains a static page.
  await page.addStyleTag({ content: ':root{--xh-duration-panel-out:430ms}' })
  value = await properties()
  assert.equal(value.dock.duration, '0.43s')
  assert.equal(value.task.duration, '0s')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  value = await properties()
  assert.equal(value.dock.name, 'none')
  assert.equal(value.task.name, 'none')
  assert.equal(value.stream.name, 'none')
  assert.equal(value.logo.name, 'none')
  assert.equal(value['brand-mark'].name, 'none')
  assert.equal(value['brand-name'].name, 'none')
  assert.equal(value['brand-mark'].width, '0px')
  assert.equal(value['brand-mark'].opacity, '0')
  assert.equal(value['brand-name'].opacity, '1')
  assert.notEqual(value.logo.display, 'none', 'reduced motion keeps the mark visible')
  console.log(`${engine}: shared motion tokens and reduced-motion styles verified`)
} finally {
  await browser.close()
}
