import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs'
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs'
import {sourceDeclaration} from './fixtures/source-declaration.mjs'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {patchSilverSurface} from './patch-silver-surface.mjs'
const source=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',import.meta.url),'utf8')
assert.equal(patchSilverSurface(legacyConversation().toString()),legacyConversation().toString());verifyConversationArtifact();
const block=source.startsWith('// Generated')?sourceDeclaration(source,'HeroGlow'):source.slice(source.indexOf('function HeroGlow('),source.indexOf('\n\t\t/**',source.indexOf('function HeroGlow(')))
assert.ok(block.includes('"data-xh-silver-glow"'))
assert.ok(!/6187D8|feGaussianBlur|useId|filter:/.test(block))
assert.match(source,/["']data-xh-silver-input["']: workspaceTrigger \? (?:undefined|void 0) : ["']["']/);if(source.startsWith('// Generated'))assert.equal(conversationFixture(source,['HeroGlow']).api.HeroGlow({}).props['data-xh-silver-glow'],'');
const css=readFileSync(new URL('../ui/overrides/monochrome.css',import.meta.url),'utf8')
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-glow]'))
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-input]:focus-within'))
assert.ok(css.includes('@media (forced-colors: active)'))
assert.ok(!css.slice(0, css.indexOf('body .xh-model-switching')).includes('animation:'), 'neutral glow remains static')
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'progress animation honors reduced motion')
assert.throws(()=>patchSilverSurface(''),/signature missing/)
console.log('PASS: neutral static glow, no SVG blur, workspace affordance retained, focus/dark/high-contrast, idempotence')
