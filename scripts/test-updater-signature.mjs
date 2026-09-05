import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { verifyPackage } from './verify-updater-package.mjs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const id = randomBytes(8)
const pubBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const key = Buffer.from('untrusted comment: test key\n' +
  Buffer.concat([Buffer.from('Ed'), id, pubBytes]).toString('base64') + '\n').toString('base64')
const payload = Buffer.from('XHarness update signature regression fixture\n')
function makeSignature(prehashed, data = payload) {
  const signed = sign(null, prehashed ? createHash('blake2b512').update(data).digest() : data, privateKey)
  const comment = 'timestamp:1\tfile:XHarness.app.tar.gz'
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey)
  return Buffer.from('untrusted comment: signature from minisign secret key\n' +
    Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), id, signed]).toString('base64') +
    '\ntrusted comment: ' + comment + '\n' + global.toString('base64') + '\n').toString('base64')
}
for (const prehashed of [true, false]) {
  const signature = makeSignature(prehashed)
  verifyPackage(payload, key, signature)
  assert.throws(() => verifyPackage(Buffer.concat([payload, Buffer.from('tampered')]), key, signature))
  const changedComment = Buffer.from(signature, 'base64').toString().replace('timestamp:1', 'timestamp:2')
  assert.throws(() => verifyPackage(payload, key, Buffer.from(changedComment).toString('base64')))
}
const badKey = Buffer.from('untrusted comment: test key\n' + Buffer.concat([
  Buffer.from('Ed'), randomBytes(8), pubBytes,
]).toString('base64')).toString('base64')
assert.throws(() => verifyPackage(payload, badKey, makeSignature(true)), /key id mismatch/)
assert.throws(() => verifyPackage(payload, key, Buffer.from('invalid').toString('base64')))
console.log('Updater signature: ED/Ed valid, payload/comment tampering, wrong key and malformed input passed')
