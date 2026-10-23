// Synthetic cookie continuity/isolation, not real-account or native WebView acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserUseEngine } from '../../plugins/browser-use/dist/engine.js';
if (process.platform !== 'linux' || process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw Error('Run only in the isolated V100 checkout');
const unwrap = result => { assert.equal(result.outcome, 'applied', JSON.stringify(result)); return result.result; };
test('headless keeps its own session across actions but never shares it with another context or restart', async () => {
  const seen = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    seen.set(path, request.headers.cookie ?? '');
    response.setHeader('content-type', path.startsWith('/record/') ? 'text/plain' : 'text/html');
    if (path.startsWith('/record/')) { response.end('recorded'); return; }
    response.end('<!doctype html><button>Mark synthetic session</button><script>document.querySelector("button").onclick=()=>{document.cookie="xh_boundary=synthetic-only; Path=/";fetch("/record/a")}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'xh-browser-boundary-'));
  const engines = [];
  try {
    const create = async () => { const engine = await BrowserUseEngine.create({ artifactRoot, allowedOrigins: [origin], timeoutMs: 1000 }); engines.push(engine); return engine; };
    const first = await create();
    unwrap(await first.execute({ action: 'navigate', url: origin + '/visit/first' }));
    assert.equal(seen.get('/visit/first'), '');
    unwrap(await first.execute({ action: 'click', target: { by: 'role', role: 'button', name: 'Mark synthetic session' } }));
    for (let i = 0; i < 100 && !seen.has('/record/a'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(seen.get('/record/a'), 'xh_boundary=synthetic-only');
    unwrap(await first.execute({ action: 'navigate', url: origin + '/visit/same-context' }));
    assert.equal(seen.get('/visit/same-context'), 'xh_boundary=synthetic-only');
    const second = await create();
    unwrap(await second.execute({ action: 'navigate', url: origin + '/visit/other-context' }));
    assert.equal(seen.get('/visit/other-context'), '');
    await first.close();
    const fresh = await create();
    unwrap(await fresh.execute({ action: 'navigate', url: origin + '/visit/restarted' }));
    assert.equal(seen.get('/visit/restarted'), '');
  } finally {
    for (const engine of engines) await engine.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
