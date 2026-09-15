import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contract, checkOld, validateSource, migrationManifest, updateChecksums } from './macos-preview-bridge.mjs'
const repo = '123123213weqw/x-harness-rs'
const c = contract(repo, repo, '0.2.18', '0.2.20')
for (const [old, next] of [['0.2.18','0.2.18'],['0.2.19','0.2.18'],['0.02.18','0.2.20'],['0.2.18','0.2.20\n'],['0.2.18','0.2.20;echo bad']]) {
  assert.throws(() => contract(repo, repo, old, next))
}
assert.throws(() => contract(repo, 'someone/else', '0.2.18', '0.2.20'))
assert.throws(() => contract('../bad', '../bad', '0.2.18', '0.2.20'))
const oldRelease = {tag_name:c.oldTag,draft:false,prerelease:true}
const oldFeed = {version:c.old,platforms:{'darwin-aarch64':{}}}
checkOld(c,oldRelease,oldFeed,'old','old')
for (const bad of [{...oldFeed,version:c.target},{...oldFeed,platforms:{'darwin-x86_64':{}}},{...oldFeed,platforms:{...oldFeed.platforms,'windows-x86_64':{}}}]) {
  assert.throws(() => checkOld(c,oldRelease,bad,'old','old'))
}
assert.throws(() => checkOld(c,{...oldRelease,prerelease:false},oldFeed,'old','old'))
assert.throws(() => checkOld(c,oldRelease,oldFeed,'other','old'))
const release = {tag_name:c.sourceTag,draft:false,prerelease:false}
const source = {version:c.target,platforms:{'darwin-aarch64':{url:`https://github.com/${repo}/releases/download/${c.sourceTag}/${c.file}`,signature:'signed'}}}
assert.throws(() => contract(repo + '\n', repo + '\n', '0.2.18', '0.2.20'))
const binary=Buffer.from(`${c.endpoint}\0new-key`)
validateSource(c,release,source,'signed',binary,'new-key')
for (const bad of [{...release,draft:true},{...release,prerelease:true},{...release,tag_name:'desktop-v0.2.19'}]) {
  assert.throws(() => validateSource(c,bad,source,'signed',binary,'new-key'))
}
assert.throws(() => validateSource(c,release,{...source,platforms:{}},'signed',binary,'new-key'))
assert.throws(() => validateSource(c,release,source,'wrong',binary,'new-key'))
assert.throws(() => validateSource(c,release,source,'signed',Buffer.from('version-pinned channel'),'new-key'))
assert.throws(() => validateSource(c,release,source,'signed',binary,'wrong-key'))
assert.throws(() => validateSource(c,release,{...source,platforms:{'darwin-aarch64':{...source.platforms['darwin-aarch64'],url:'https://example.invalid/app.tar.gz'}}},'signed',binary,'new-key'))
const feed=migrationManifest(c,'old-signature','2026-09-15T00:00:00.000Z')
assert.deepEqual(Object.keys(feed.platforms),['darwin-aarch64'])
assert.equal(feed.platforms['darwin-aarch64'].url,`https://github.com/${repo}/releases/download/${c.tag}/${c.file}`)
const oldHash='a'.repeat(64), newHash='b'.repeat(64), other='c'.repeat(64)+'  package.zip\n'
assert.equal(updateChecksums(`${oldHash}  latest.json\n${other}`,oldHash,newHash),`${newHash}  latest.json\n${other}`)
for(const bad of ['',`${oldHash}  latest.json\n${oldHash}  latest.json\n`,`${newHash}  latest.json\n`]) assert.throws(()=>updateChecksums(bad,oldHash,newHash))
const workflow=readFileSync(new URL('../.github/workflows/macos-preview-bridge.yml',import.meta.url),'utf8')
assert.ok(workflow.includes('default: false'))
assert.ok(workflow.includes('if: inputs.publish'))
assert.ok(workflow.includes("github.ref == 'refs/heads/master'"))
assert.ok(workflow.includes('XHARNESS_TEST_UPDATER_PRIVATE_KEY'))
assert.ok(!workflow.includes('cargo ') && !workflow.includes('pull_request_target'))
assert.ok(workflow.indexOf('macos-preview-bridge.mjs finish') < workflow.indexOf('macos-preview-bridge.mjs publish'))
console.log('Mac preview bridge: version, scope, signed source metadata, embedded channel, legacy feed drift, checksum consistency, opt-in publication passed. No native install simulated.')
