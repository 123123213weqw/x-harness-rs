// Independent CI/download verification of Tauri's base64-encoded Minisign files.
// Same ED(BLAKE2b-512) + Ed25519 + trusted-comment checks as minisign-verify.
// This supplements, never replaces, the Tauri runtime verifier.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function verifyPackage(bytes, publicKeyText, signatureText) {
  const publicLines = Buffer.from(publicKeyText.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const signatureLines = Buffer.from(signatureText.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  assert.equal(publicLines.length, 2, 'invalid public key')
  assert.equal(signatureLines.length, 4, 'invalid signature')
  assert.ok(publicLines[0].startsWith('untrusted comment: '))
  assert.ok(signatureLines[0].startsWith('untrusted comment: '))
  assert.ok(signatureLines[2].startsWith('trusted comment: '))
  const keyData = Buffer.from(publicLines[1], 'base64')
  const sigData = Buffer.from(signatureLines[1], 'base64')
  assert.equal(keyData.length, 42)
  assert.equal(sigData.length, 74)
  assert.equal(keyData.subarray(0, 2).toString(), 'Ed')
  assert.ok(['Ed', 'ED'].includes(sigData.subarray(0, 2).toString()))
  assert.ok(keyData.subarray(2, 10).equals(sigData.subarray(2, 10)), 'signature key id mismatch')
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyData.subarray(10)]),
    format: 'der', type: 'spki',
  })
  const signature = sigData.subarray(10)
  const payload = sigData.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes
  assert.ok(verify(null, payload, key, signature), 'update payload signature mismatch')
  const comment = Buffer.from(signatureLines[2].slice('trusted comment: '.length))
  assert.ok(verify(null, Buffer.concat([signature, comment]), key, Buffer.from(signatureLines[3], 'base64')), 'trusted comment signature mismatch')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , file, signatureFile, publicKeyFile] = process.argv
  if (!file || !signatureFile || !publicKeyFile) throw new Error('usage: verify-updater-package.mjs <package> <sig> <pubkey>')
  verifyPackage(readFileSync(file), readFileSync(publicKeyFile, 'utf8'), readFileSync(signatureFile, 'utf8'))
  console.log('Verified update payload and trusted-comment signatures: ' + file)
}
