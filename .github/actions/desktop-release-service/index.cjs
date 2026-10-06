'use strict'
const { spawnSync } = require('node:child_process')
const { resolve, dirname } = require('node:path')
const { statSync } = require('node:fs')
async function main() {
  if (process.argv[2] === 'checkpoint') {
    const { DefaultArtifactClient } = await import('@actions/artifact')
    const [name, file] = process.argv.slice(3)
    if (!/^release-task-[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*-[1-9][0-9]*-[0-9]{6}$/.test(name)) throw new Error('Invalid checkpoint name')
    if (!statSync(file).isFile() || statSync(file).size >= 1048576) throw new Error('Invalid checkpoint file')
    await new DefaultArtifactClient().uploadArtifact(name, [resolve(file)], dirname(resolve(file)), { retentionDays: 90 })
  } else {
    // A JavaScript action receives the scoped artifact runtime identity. Pass
    // it only to our coordinator/child checkpoint uploader, never log it.
    const script = process.env.INPUT_REHEARSAL === 'true' ? 'scripts/test-release-checkpoints-hosted.py' : 'scripts/desktop-release-service.py'
    const result = spawnSync('python3', ['-B', script], { stdio: 'inherit', env: process.env })
    if (result.error) throw new Error('Cannot launch release coordinator')
    process.exitCode = result.status ?? 2
  }
}
main().catch(() => { console.error('Release coordinator/checkpoint failed; resume the same run, never dispatch manually'); process.exitCode = 2 })
