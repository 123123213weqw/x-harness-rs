import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'

const id = 'foundation-acceptance:message-preview'
const source = compileSourceModules(new URL('../ui', import.meta.url).pathname,
  [{ id, source: 'src/modules/conversation/chat/message-preview.ts' }]).get(id).bytes.toString()
let registration
runInNewContext(source, { window: { __ModuleLoader__: { load: row => { registration = row } } } })
assert.ok(registration, 'compile the actual TypeScript preview, not a copied test implementation')
const { messagePreview } = registration.factory(name => assert.fail('Unexpected preview dependency: ' + name))
const text = value => ({ type: 'text', text: value })
const original = content => content
  .filter(block => typeof block === 'object' && block !== null && !Array.isArray(block)
    && block.type === 'text' && typeof block.text === 'string')
  .map(block => block.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80)

test('preview ignores non-text blocks and preserves cross-block whitespace normalization', () => {
  for (const content of [
    [], [text('')], [text(' \t\r\n')], [text('a'), text(''), text('b')],
    [text(' \r\n hello'), { type: 'image', attachment: {} }, text('\t world \n')],
    [null, undefined, 0, false, 'text', [], { type: 'text', text: 3 },
      { type: 'reasoning', text: 'not a navigation preview' }, text(' visible ')],
  ]) {
    assert.equal(messagePreview(content), original(content))
  }
})

test('trim-before-slice order, empty blocks and UTF-16 boundaries stay equivalent', () => {
  for (const content of [
    [text('a'.repeat(79)), text('b')],
    [text('a'.repeat(79)), text(''), text(' \n')],
    [text('a'.repeat(79) + ' \t\n b')],
    [text('a'.repeat(80) + ' \n')],
    [text('🙂'.repeat(50))],
    [text('a'.repeat(79) + '🙂')],
    [text('a'.repeat(78) + '\ud83d'), text('\ude42')],
    [text(' \n'.repeat(50_000)), text('visible')],
  ]) {
    assert.equal(messagePreview(content), original(content))
    assert.ok(messagePreview(content).length <= 80)
  }
  assert.equal(messagePreview([text('a'.repeat(79)), text('b')]), 'a'.repeat(79) + ' ')
})

test('all ECMAScript whitespace collapses; non-whitespace Unicode stays visible', () => {
  const whitespace = ['\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
    ...Array.from({ length: 11 }, (_, n) => String.fromCharCode(0x2000 + n)),
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']
  for (const char of whitespace) assert.equal(messagePreview([text(char + 'a' + char + 'b' + char)]), 'a b')
  for (const char of ['\u0085', '\u180e', '\u200b', '\u2060']) {
    assert.equal(messagePreview([text(char + 'a' + char)]), char + 'a' + char)
  }
})

test('preview stops reading later blocks as soon as its display prefix is complete', () => {
  const unread = { get type() { assert.fail('A completed preview must not inspect later blocks') } }
  assert.equal(messagePreview([text('a'.repeat(80) + 'b'.repeat(1_000_000)), unread]), 'a'.repeat(80))
  assert.equal(messagePreview([text('a'.repeat(79)), text('b'), unread]), 'a'.repeat(79) + ' ')
})

test('10,000 deterministic mixed-block previews match the previous implementation', () => {
  let seed = 1985
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const alphabet = ['a', '中', '\r', '\n', '\t', ' ', '\u00a0', '\u2003',
    '\u2028', '\ufeff', '🙂', '\ud83d', '\ude42', '\u200b']
  for (let n = 0; n < 10_000; n++) {
    const content = Array.from({ length: next() % 6 }, () => next() % 5 === 0
      ? { type: 'image', attachment: { attachmentId: 'synthetic' } }
      : text(Array.from({ length: next() % 300 }, () => alphabet[next() % alphabet.length]).join('')))
    assert.equal(messagePreview(content), original(content), `case ${n}`)
  }
})
