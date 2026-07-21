import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patchConversationScrollFollow} from './patch-conversation-scroll-follow.mjs';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {harness} from './conversation-test-harness.mjs';
const helper=readFileSync(new URL('../ui/overrides/conversation-scroll-follow.js',import.meta.url),'utf8');
const context={};vm.runInNewContext(helper+'\nglobalThis.decide=xhScrollFollowAtBottom;',context);
const source=verifyConversationArtifact(),api=harness(exposeConversation(source,['xhScrollFollowAtBottom'])).plugin;
for(const decide of [context.decide,api.xhScrollFollowAtBottom]) {
 assert.equal(decide(true,30,80,100,false),true);assert.equal(decide(true,50,100,50,false),true);
 assert.equal(decide(true,30,80,100,true),false);assert.equal(decide(true,78,80,100,true),true);
 assert.equal(decide(false,30,80,30,false),false);
}
const golden=legacyConversation();assert.deepEqual(patchConversationScrollFollow(golden),golden);
// Native listener lifetime remains bound to reader gesture attribution. The real
// geometry/compaction/append/prepend behavior is exercised in transcript-windowing.
assert.match(source,/readerInputRecent && Math\.abs/);
for(const [event,handler] of [['wheel','markReaderInput'],['touchmove','markReaderInput'],['pointerdown','onPointer'],['keydown','onKey']]){
 const bind=new RegExp('addEventListener\\(["\']'+event+'["\'], '+handler),unbind=new RegExp('removeEventListener\\(["\']'+event+'["\'], '+handler);
 assert.ok(bind.test(source),'native gesture '+event+' binding');assert.ok(unbind.test(source),'native gesture '+event+' cleanup');
}
assert.match(source,/scrollFollowAtBottom\(atBottomRef\.current/);
console.log('conversation scroll follow: native + golden compaction reflow, reader gesture, listener lifetime + freshness/hash/boot passed');
