import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs'
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs'
import {sourceDeclaration} from './fixtures/source-declaration.mjs'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=verifyConversationArtifact()
for(const actual of [source,legacyConversation().toString()]) {
 const block=sourceDeclaration(actual,'HeroGlow')
 assert.ok(block.includes('"data-xh-silver-glow"'))
 assert.ok(!/6187D8|feGaussianBlur|useId|filter:/.test(block))
 assert.equal(conversationFixture(actual,['HeroGlow']).api.HeroGlow({}).props['data-xh-silver-glow'],'')
}
assert.match(source,/["']data-xh-silver-input["']: workspaceTrigger \? (?:undefined|void 0) : ["']["']/)
const css=readFileSync(new URL('../ui/overrides/monochrome.css',import.meta.url),'utf8')
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-glow]'))
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-input]:focus-within'))
assert.ok(css.includes('@media (forced-colors: active)'))
assert.ok(!css.slice(0, css.indexOf('body .xh-model-switching')).includes('animation:'), 'neutral glow remains static')
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'progress animation honors reduced motion')
console.log('PASS: native/frozen neutral static glow, no SVG blur, workspace affordance retained, focus/dark/high-contrast')
