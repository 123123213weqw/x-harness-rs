// Collect only lockfile-selected, integrity-verified PUBLIC npm tarballs.
// No npm user configuration, credentials or unrelated cache entries are copied.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.length < 4) throw new Error('Usage: node collect_npm_cache.cjs ROOT NPM_NODE_MODULES [EXISTING_CACACHE]');
const npmRoot = path.resolve(process.argv[3]);
const cacache = require(npmRoot + '/cacache');
const pacote = require(npmRoot + '/pacote');
const root = path.resolve(process.argv[2]);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const target = path.join(root, 'cache');
const existing = process.argv[4] && path.resolve(process.argv[4]);
const accepted = (list, value) => !list || (!list.includes('!' + value) &&
  (!list.some(x => !x.startsWith('!')) || list.includes(value)));
const packages = [...new Map(Object.values(lock.packages).filter(p => p.resolved &&
  accepted(p.os, 'linux') && accepted(p.cpu, 'x64') && accepted(p.libc, 'glibc')
).map(p => [p.integrity, p])).values()];
let cursor = 0, completed = 0;
async function worker() {
  while (cursor < packages.length) {
    const pkg = packages[cursor++];
    const url = new URL(pkg.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || !pkg.integrity || url.username || url.password)
      throw new Error('Non-public or unverified artifact in lockfile');
    let data;
    try {
      if (!existing) throw new Error('No existing cache selected');
      data = await cacache.get.byDigest(existing, pkg.integrity);
    }
    catch { data = await pacote.tarball(pkg.resolved, {integrity: pkg.integrity, cache: target,
      fetchRetries: 2, fetchTimeout: 30000, timeout: 30000}); }
    await cacache.put(path.join(target, '_cacache'), 'forwarded:' + pkg.resolved,
      data, {integrity: pkg.integrity});
    completed++;
    if (completed % 25 === 0) console.log(JSON.stringify({completed, total: packages.length}));
  }
}
Promise.all(Array.from({length: 4}, worker)).then(() => {
  fs.writeFileSync(path.join(root, 'cache-manifest.json'), JSON.stringify({
    packages: packages.map(({resolved, integrity, version}) => ({resolved, integrity, version})),
    completed, target: 'linux-x64-glibc'
  }, null, 2));
  console.log(JSON.stringify({complete: true, completed}));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
