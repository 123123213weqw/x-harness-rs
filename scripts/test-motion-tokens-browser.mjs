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
const pluginCss = name => {
  const source = read(`ui/plugins/@xlang/xharness-client-ui-${name}/client.js`)
  const start = source.indexOf('const CSS = `')
  assert.notEqual(start, -1, `${name} CSS is present`)
  const from = start + 'const CSS = `'.length
  return source.slice(from, source.indexOf('`', from))
}

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
    <div id="task" class="xhtask-panel-wrap xhtask-panel-wrap-closing"></div>
    <p id="stream" data-xh-stream-animate="true">stream</p>
    <svg><rect id="logo" class="xh-logo-sweep" width="10" height="10"></rect></svg>`)
  const properties = () => page.evaluate(() => Object.fromEntries(
    ['dock', 'task', 'stream', 'logo'].map(id => {
      const style = getComputedStyle(document.getElementById(id))
      return [id, {
        name: style.animationName,
        duration: style.animationDuration,
        easing: style.animationTimingFunction,
        display: style.display,
      }]
    }),
  ))
  let value = await properties()
  assert.equal(value.dock.name, 'xhterm-dock-out')
  assert.equal(value.task.name, 'xhtask-panel-out')
  assert.equal(value.dock.duration, '0.18s')
  assert.equal(value.task.duration, '0.18s')
  assert.equal(value.stream.duration, '0.9s')
  assert.equal(value.logo.duration, '5s')
  assert.match(value.dock.easing, /cubic-bezier\(0\.23, 1, 0\.32, 1\)/)

  // A single token override changes both independently loaded panels.
  await page.addStyleTag({ content: ':root{--xh-duration-panel-out:430ms}' })
  value = await properties()
  assert.equal(value.dock.duration, '0.43s')
  assert.equal(value.task.duration, '0.43s')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  value = await properties()
  assert.equal(value.dock.name, 'none')
  assert.equal(value.task.name, 'none')
  assert.equal(value.stream.name, 'none')
  assert.equal(value.logo.display, 'none')
  console.log(`${engine}: shared motion tokens and reduced-motion styles verified`)
} finally {
  await browser.close()
}
