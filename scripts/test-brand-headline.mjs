import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs'
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs'
import {sourceDeclaration} from './fixtures/source-declaration.mjs'
import assert from 'node:assert/strict'
const shipped=verifyConversationArtifact()
for(const [label,source] of [['native',shipped],['frozen',legacyConversation().toString()]]) {
 const {api}=conversationFixture(source,['en','zh'])
 assert.equal(api.zh['hero.headline'],'新时代的语言',label)
 assert.equal(api.en['hero.headline'],'The Language of a New Era',label)
 assert.doesNotMatch(sourceDeclaration(source,'HeroShell'),/hero\.preview/,`${label}: Preview is not rendered`)
 assert.ok(!source.includes('Into the Unknown'),label)
}
console.log('PASS: native/frozen Chinese/English titles, Preview not rendered and source-fresh artifact')
