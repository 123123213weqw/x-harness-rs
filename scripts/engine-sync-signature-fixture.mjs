// Disposable offline test key ONLY; never signs a production release.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const names = process.argv.slice(3)
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const id = randomBytes(8)
const packet = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)])
writeFileSync(join(root, 'updater.pub'), Buffer.from('untrusted comment: disposable offline fixture\n' + packet.toString('base64') + '\n').toString('base64') + '\n')
for (const name of names) {
  if (name === 'latest.json') {
    const manifest = JSON.parse(readFileSync(join(root, name), 'utf8'))
    for (const entry of Object.values(manifest.platforms)) {
      const packageName = entry.url.split('/').at(-1)
      entry.signature = readFileSync(join(root, packageName + '.sig'), 'utf8').trim()
    }
    writeFileSync(join(root, name), JSON.stringify(manifest, null, 2) + '\n')
  }
  const payload = readFileSync(join(root, name))
  const signed = sign(null, createHash('blake2b512').update(payload).digest(), privateKey)
  const comment = 'timestamp:1\tfile:' + name
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey)
  writeFileSync(join(root, name + '.sig'), Buffer.from('untrusted comment: disposable fixture signature\n' +
    Buffer.concat([Buffer.from('ED'), id, signed]).toString('base64') + '\ntrusted comment: ' + comment + '\n' + global.toString('base64') + '\n').toString('base64') + '\n')
}
