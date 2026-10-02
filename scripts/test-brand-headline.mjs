import {verifyConversationArtifact} from './conversation-artifact-test.mjs'
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs'
import {sourceDeclaration} from './fixtures/source-declaration.mjs'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {readFileSync,mkdtempSync,mkdirSync,cpSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
const dir=mkdtempSync(join(tmpdir(),'xh-headline-'))
const plugin='plugins/@xharness/dsh-client-ui-conversation/client.js'
try {
 mkdirSync(join(dir,'plugins/@xharness/dsh-client-ui-conversation'),{recursive:true})
 for(const file of [plugin,'index.html','client-graph.json']) cpSync(new URL('../ui/'+(file===plugin?'legacy/':'dist/')+file,import.meta.url),join(dir,file))
 const run=()=>execFileSync(process.execPath,[fileURLToPath(new URL('./patch-brand-headline.mjs',import.meta.url)),dir])
 run(); const before=readFileSync(join(dir,'index.html'),'utf8');run()
 assert.equal(readFileSync(join(dir,'index.html'),'utf8'),before)
 const s=readFileSync(join(dir,plugin),'utf8')
 assert.match(s,/const zh = \{[\s\S]*?"hero.headline": "新时代的语言"/)
 assert.match(s,/const en = \{[\s\S]*?"hero.headline": "The Language of a New Era"/)
 assert.ok(!s.includes('children: t("hero.preview")'))
 assert.ok(!s.includes('Into the Unknown'))
 const shipped=verifyConversationArtifact();if(shipped.startsWith('// Generated')){const {api}=conversationFixture(shipped,['en','zh']);assert.equal(api.zh['hero.headline'],'新时代的语言');assert.equal(api.en['hero.headline'],'The Language of a New Era');assert.doesNotMatch(sourceDeclaration(shipped,'HeroShell'),/hero\.preview/);}
 console.log('PASS: Chinese/English titles, Preview not rendered, idempotent patch')
} finally { rmSync(dir,{recursive:true,force:true}) }
