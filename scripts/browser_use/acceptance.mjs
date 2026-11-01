#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startFixture } from './fixture.mjs';
import { provenance, verifyUnchanged } from './provenance.mjs';

// Run on an isolated Linux server after building the plugin, never against user tabs.
if (process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw new Error('Set XHARNESS_BROWSER_TEST_SERVER=1 on the isolated test server');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineModule = resolve(process.env.BROWSER_ENGINE_MODULE ?? resolve(repository, 'plugins/browser-use/dist/engine.js'));
const runProvenance = await provenance(repository, engineModule);
const { BrowserUseEngine } = await import(pathToFileURL(engineModule).href);
const fixture = await startFixture();
const root = await mkdtemp(resolve(tmpdir(), 'xharness-browser-acceptance-'));
const evidence = [];
let failures = 0;
let ordinal = 0;
const role = (name, value = 'button', frameId) => ({ by: 'role', role: value, name, exact: true, ...(frameId ? { frameId } : {}) });
const unwrap = receipt => { assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt)); return receipt.result; };
const checkFailure = receipt => { assert.notEqual(receipt.outcome, 'applied', JSON.stringify(receipt)); assert.ok(receipt.error); return receipt; };
async function eventually(predicate, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(await predicate(), 'Page-owned state did not reach the expected value');
}
async function run(id, title, body, options = {}) {
  ordinal++;
  const started = performance.now();
  const artifactRoot = resolve(root, id);
  await mkdir(artifactRoot, { recursive: true });
  let engine;
  // Origin rejection has a dedicated forbidden-origin recorder. It cannot inherit
  // legitimate frame/favicon traffic from the allowed cross-origin case.
  const activeFixture = ['origin', 'cancel-fetch'].includes(id) ? await startFixture() : fixture;
  const facts = {};
  try {
    engine = await BrowserUseEngine.create({ artifactRoot, allowedOrigins: [activeFixture.origin], timeoutMs: 600, viewport: { width: 1100, height: 760 }, maxOutputChars: 18000, ...options });
    unwrap(await engine.execute({ action: 'navigate', url: `${activeFixture.origin}/?id=${id}${id === 'bounded' ? '&mode=large' : id === 'bounded-cjk' ? '&mode=cjk' : ''}` }));
    await body({ engine, artifactRoot, state: () => activeFixture.state(id), id, facts, fixture: activeFixture });
    evidence.push({ id, title, status: 'passed', facts, durationMs: Math.round(performance.now() - started) });
    console.log(`ok ${ordinal} - ${id}: ${title}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    evidence.push({ id, title, status: 'failed', facts, durationMs: Math.round(performance.now() - started), error: message.slice(0, 5000) });
    console.log(`not ok ${ordinal} - ${id}: ${title}\n  ---\n  error: ${JSON.stringify(message)}\n  ...`);
  } finally { await engine?.close(); if (activeFixture !== fixture) await activeFixture.close(); }
}
async function hasEvent(state, kind, extra = () => true) { return (await state()).events.some(event => event.kind === kind && extra(event)); }
async function observe(engine) { return unwrap(await engine.execute({ action: 'observe' })); }
async function click(engine, name, value = 'button', frameId) { return engine.execute({ action: 'click', target: role(name, value, frameId) }); }

console.log('TAP version 13');
try {
  await run('trusted', 'native and ARIA custom controls use trusted browser input', async ({ engine, state }) => {
    const result = await observe(engine);
    assert.match(result.frames.map(frame => frame.aria).join('\n'), /Custom action/);
    for (const name of ['Native action', 'Custom action', 'Associated action']) unwrap(await click(engine, name));
    for (const kind of ['native', 'custom', 'associated-button']) await eventually(() => hasEvent(state, kind, event => event.trusted === true));
  });
  await run('form', 'fill, keyboard, native select and check update actual page state', async ({ engine, state }) => {
    unwrap(await engine.execute({ action: 'fill', target: { by: 'label', value: 'Search products' }, text: 'laptop' }));
    unwrap(await engine.execute({ action: 'press', target: { by: 'label', value: 'Search products' }, key: 'End' }));
    unwrap(await engine.execute({ action: 'type', target: { by: 'label', value: 'Search products' }, text: ' pro' }));
    unwrap(await engine.execute({ action: 'selectOption', target: { by: 'label', value: 'Sort products' }, values: ['rating'] }));
    unwrap(await engine.execute({ action: 'check', target: { by: 'label', value: 'Consent' }, checked: true }));
    await eventually(() => hasEvent(state, 'query', event => event.value === 'laptop pro' && event.trusted));
    await eventually(() => hasEvent(state, 'sort', event => event.value === 'rating'));
    await eventually(() => hasEvent(state, 'consent', event => event.value === true && event.trusted));
  });
  await run('frames', 'semantic snapshots and targets pierce open shadow roots and permitted iframes', async ({ engine, state }) => {
    const snapshot = await observe(engine);
    assert.match(snapshot.frames.map(frame => frame.aria).join('\n'), /Shadow action/);
    const child = snapshot.frames.find(frame => frame.name === 'embedded');
    assert.ok(child, 'Embedded frame must be discoverable');
    assert.match(child.aria, /Frame action/);
    unwrap(await click(engine, 'Shadow action'));
    unwrap(await click(engine, 'Frame action', 'button', child.frameId));
    await eventually(() => hasEvent(state, 'shadow', event => event.trusted));
    await eventually(() => hasEvent(state, 'frame', event => event.trusted));
    const cross = snapshot.frames.find(frame => frame.name === 'cross-embedded');
    assert.ok(cross); assert.match(cross.aria, /Cross frame action/);
    unwrap(await click(engine, 'Cross frame action', 'button', cross.frameId));
    await eventually(() => hasEvent(state, 'crossframe', event => event.trusted));
  }, { allowedOrigins: [fixture.origin, fixture.forbiddenOrigin] });
  await run('ambiguous', 'ambiguous locators fail without guessing or dispatching', async ({ engine, state }) => {
    const receipt = checkFailure(await click(engine, 'Duplicate action'));
    assert.equal(receipt.outcome, 'not-started');
    assert.match(receipt.error.message, /exactly one|strict|matched 2/i);
    assert.equal((await state()).events.length, 0);
  });
  await run('overlay', 'blocked actions fail before dispatch; a deliberate dismissal allows progress', async ({ engine, state }) => {
    unwrap(await click(engine, 'Show overlay'));
    const failure = checkFailure(await click(engine, 'Covered action'));
    assert.equal(failure.outcome, 'not-started');
    assert.equal(await hasEvent(state, 'covered'), false);
    unwrap(await click(engine, 'Dismiss overlay'));
    unwrap(await click(engine, 'Covered action'));
    await eventually(() => hasEvent(state, 'covered', event => event.trusted));
  });
  await run('delayed', 'semantic action waits for a delayed target instead of requiring a fixed sleep', async ({ engine, state }) => {
    unwrap(await click(engine, 'Schedule delayed control'));
    unwrap(await click(engine, 'Delayed action'));
    await eventually(() => hasEvent(state, 'delayed', event => event.trusted));
  });
  await run('scroll', 'actionability scrolls below-fold targets into view', async ({ engine, state }) => {
    unwrap(await click(engine, 'Below fold action'));
    await eventually(() => hasEvent(state, 'far', event => event.trusted));
  });
  await run('ref-replay', 'a mutating reference is consumed once and cannot duplicate an effect', async ({ engine, state }) => {
    const snapshot = await observe(engine);
    const node = snapshot.nodes.find(node => node.name === 'Native action');
    assert.ok(node);
    const command = { action: 'click', target: { ref: node.ref, observationId: snapshot.observationId } };
    unwrap(await engine.execute(command));
    const failure = checkFailure(await engine.execute(command));
    assert.equal(failure.outcome, 'not-started');
    await eventually(() => hasEvent(state, 'native'));
    assert.equal((await state()).events.filter(event => event.kind === 'native').length, 1);
  });
  await run('replaced', 'identity validation rejects an autonomous same-looking replacement without consuming the observation first', async ({ engine, state, id }) => {
    const snapshot = await observe(engine);
    const node = snapshot.nodes.find(node => node.name === 'Replaceable action');
    assert.ok(node);
    // This mutation is triggered outside the browser engine. No execute() command
    // runs between observation and the stale-handle action; observation consumption
    // cannot explain a passing identity assertion.
    await fixture.replaceNode(id);
    await eventually(() => hasEvent(state, 'autonomous-replace'));
    const rejected = checkFailure(await engine.execute({ action: 'click', target: { ref: node.ref, observationId: snapshot.observationId } }));
    assert.match(rejected.error.message, /identity|detached|changed|connected/i);
    assert.doesNotMatch(rejected.error.message, /stale observation/i);
    assert.equal(await hasEvent(state, 'old-target'), false);
    assert.equal(await hasEvent(state, 'replacement-target'), false);
  });
  await run('tabs', 'popup, select, reuse, close and explicit new tab preserve truthful tab identity', async ({ engine, id, facts, state }) => {
    const first = unwrap(await engine.execute({ action: 'tabs' }));
    assert.equal(first.length, 1);
    const popupClick = await click(engine, 'Open popup');
    facts.popupClick = popupClick;
    unwrap(popupClick);
    let tabs;
    facts.tabPolls = [];
    try {
      await eventually(async () => {
        const receipt = await engine.execute({ action: 'tabs' });
        facts.tabPolls.push(receipt);
        if (facts.tabPolls.length > 10) facts.tabPolls.shift();
        tabs = unwrap(receipt);
        return tabs.length === 2;
      });
    } catch (error) {
      facts.observeDiagnostic = await engine.execute({ action: 'observe', tabId: first[0].tabId });
      facts.policyTrace = await engine.execute({ action: 'network', tabId: first[0].tabId });
      facts.popupEvents = (await state()).events.filter(event => event.kind === 'popup');
      throw error;
    }
    const popup = tabs.find(tab => tab.tabId !== first[0].tabId);
    assert.ok(popup);
    unwrap(await engine.execute({ action: 'select', targetTabId: popup.tabId }));
    const snapshot = await observe(engine);
    assert.match(snapshot.text, /Popup content/);
    unwrap(await engine.execute({ action: 'close', targetTabId: popup.tabId }));
    assert.equal(unwrap(await engine.execute({ action: 'tabs' })).length, 1);
    checkFailure(await engine.execute({ action: 'observe', tabId: popup.tabId }));
    const created = await engine.execute({ action: 'new', url: `${fixture.origin}/popup?id=${id}` });
    unwrap(created);
    assert.ok(created.tabId);
    unwrap(await engine.execute({ action: 'navigate', url: `${fixture.origin}/?id=${id}`, reuse: true }));
    assert.equal(unwrap(await engine.execute({ action: 'tabs' })).filter(tab => tab.selected).length, 1);
    unwrap(await engine.execute({ action: 'close', targetTabId: created.tabId }));
  });
  await run('dialogs', 'native prompt is surfaced and completed without deadlocking the command queue', async ({ engine, state, facts }) => {
    const action = await click(engine, 'Prompt action');
    facts.initialReceipt = { outcome: action.outcome, replaySafe: action.replaySafe };
    assert.ok(['applied', 'possibly-applied'].includes(action.outcome));
    if (action.outcome === 'possibly-applied') assert.equal(action.replaySafe, false);
    // A pending browser dialog must not make semantic observation hang indefinitely.
    const snapshot = await observe(engine);
    assert.equal(snapshot.dialog.type, 'prompt');
    assert.match(snapshot.dialog.message, /Fixture confirmation/);
    unwrap(await engine.execute({ action: 'dialog', accept: true, text: 'approved in fixture' }));
    await eventually(() => hasEvent(state, 'dialog', event => event.answer === 'approved in fixture'));
    assert.equal((await state()).events.filter(event => event.kind === 'dialog').length, 1, 'No effect may be replayed after an uncertain receipt');
    unwrap(await click(engine, 'Native action'));
  });
  await run('screenshot', 'viewport PNG geometry and raster click coordinates agree', async ({ engine, state, artifactRoot }) => {
    const snapshot = await observe(engine);
    const canvas = snapshot.nodes.find(node => node.tag === 'canvas');
    // The geometric target may be absent from semantic candidates; use a visible button.
    const node = canvas ?? snapshot.nodes.find(node => node.name === 'Native action');
    assert.ok(node?.bounds);
    const screenshot = unwrap(await engine.execute({ action: 'screenshot' }));
    const png = await readFile(screenshot.path);
    assert.equal(png.readUInt32BE(16), screenshot.viewport.width);
    assert.equal(png.readUInt32BE(20), screenshot.viewport.height);
    assert.equal(screenshot.scale, 1);
    assert.ok(!relative(artifactRoot, screenshot.path).startsWith('..'));
    const { x, y, width, height } = node.bounds;
    unwrap(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: screenshot.screenshotId, x: x + width / 2, y: y + height / 2 }));
    await eventually(() => hasEvent(state, canvas ? 'canvas' : 'native', event => event.trusted));
    checkFailure(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: screenshot.screenshotId, x, y }));
  });
  await run('pointer-gesture', 'held mouse button rejects semantic effects until its matching release', async ({ engine, state, facts }) => {
    const snapshot = await observe(engine);
    const button = snapshot.nodes.find(node => node.name === 'Native action');
    assert.ok(button?.bounds);
    const shot = unwrap(await engine.execute({ action: 'screenshot' }));
    const x = button.bounds.x + button.bounds.width / 2;
    const y = button.bounds.y + button.bounds.height / 2;
    unwrap(await engine.execute({ action: 'mouse', operation: 'down', screenshotId: shot.screenshotId, x, y }));
    const semantic = checkFailure(await click(engine, 'Custom action'));
    const navigation = checkFailure(await engine.execute({ action: 'navigate', url: `${fixture.origin}/popup?id=pointer-gesture` }));
    assert.equal(semantic.outcome, 'not-started');
    assert.equal(navigation.outcome, 'not-started');
    assert.match(semantic.error.message, /pointer|release/i);
    assert.match(navigation.error.message, /pointer|release/i);
    assert.equal(await hasEvent(state, 'custom'), false);
    assert.equal(await hasEvent(state, 'native'), false, 'Mouse down alone must not dispatch a click');
    const held = await observe(engine);
    assert.deepEqual(held.pointer, { button: 'left', screenshotId: shot.screenshotId });
    const tabs = unwrap(await engine.execute({ action: 'tabs' }));
    assert.equal(tabs.length, 1);
    assert.ok(held.url.includes('id=pointer-gesture'), 'Rejected navigation must not change the document');
    unwrap(await engine.execute({ action: 'mouse', operation: 'up', screenshotId: shot.screenshotId, x, y }));
    await eventually(() => hasEvent(state, 'native', event => event.trusted));
    assert.equal((await observe(engine)).pointer, null);
    unwrap(await click(engine, 'Native action'));
    await eventually(async () => (await state()).events.filter(event => event.kind === 'native').length === 2);
    assert.equal(await hasEvent(state, 'custom'), false);
    facts.rejections = [semantic, navigation];
    facts.nativeClickCount = (await state()).events.filter(event => event.kind === 'native').length;
  });
  await run('raster-invalidated', 'full-page, out-of-bounds and scrolled screenshots cannot dispatch raster actions', async ({ engine }) => {
    const full = unwrap(await engine.execute({ action: 'screenshot', fullPage: true }));
    assert.equal(full.actionable, false);
    checkFailure(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: full.screenshotId, x: 10, y: 10 }));
    const shot = unwrap(await engine.execute({ action: 'screenshot' }));
    checkFailure(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: shot.screenshotId, x: shot.viewport.width, y: 0 }));
    unwrap(await engine.execute({ action: 'scroll', y: 300 }));
    checkFailure(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: shot.screenshotId, x: 10, y: 10 }));
  });
  await run('raster-layout', 'autonomous DOM layout changes revoke captured coordinate frames before dispatch', async ({ engine, state, id }) => {
    const shot = unwrap(await engine.execute({ action: 'screenshot' }));
    // No engine effect consumes the screenshot. Only the page changes layout.
    await fixture.shiftLayout(id);
    await eventually(() => hasEvent(state, 'autonomous-shift'));
    const stale = checkFailure(await engine.execute({ action: 'mouse', operation: 'click', screenshotId: shot.screenshotId, x: 30, y: 30 }));
    assert.match(stale.error.message, /layout|changed/i);
    assert.equal(await hasEvent(state, 'native'), false);
  });
  await run('upload', 'uploads are limited to the operator artifact root, including symlinks', async ({ engine, artifactRoot, state }) => {
    const input = resolve(artifactRoot, 'report.txt');
    await writeFile(input, 'upload fixture');
    unwrap(await engine.execute({ action: 'upload', target: { by: 'label', value: 'Upload report' }, files: ['report.txt'] }));
    await eventually(() => hasEvent(state, 'upload', event => event.names.includes('report.txt')));
    const outside = resolve(root, 'outside.txt'); await writeFile(outside, 'outside');
    const before = (await state()).events.filter(event => event.kind === 'upload').length;
    checkFailure(await engine.execute({ action: 'upload', target: { by: 'label', value: 'Upload report' }, files: [outside] }));
    await symlink(outside, resolve(artifactRoot, 'escape.txt'));
    checkFailure(await engine.execute({ action: 'upload', target: { by: 'label', value: 'Upload report' }, files: ['escape.txt'] }));
    assert.equal((await state()).events.filter(event => event.kind === 'upload').length, before);
  });
  await run('download', 'download bytes and untrusted filenames cannot escape the artifact root', async ({ engine, artifactRoot }) => {
    unwrap(await click(engine, 'Download report', 'link'));
    let snapshot;
    await eventually(async () => { snapshot = await observe(engine); return snapshot.downloads.length === 1; });
    const saved = unwrap(await engine.execute({ action: 'download', downloadId: snapshot.downloads[0].id }));
    assert.ok(!relative(artifactRoot, saved.path).startsWith('..'));
    assert.equal(await readFile(saved.path, 'utf8'), 'download fixture bytes');
    checkFailure(await engine.execute({ action: 'download', downloadId: '../../escape' }));
  });
  await run('origin', 'unapproved origin receives zero direct, iframe, linked, redirected or subresource requests', async ({ engine, facts, state, fixture: isolated }) => {
    try {
      await eventually(() => hasEvent(state, 'origin-fetch-complete'));
      await eventually(() => hasEvent(state, 'origin-image-complete'));
      assert.equal(isolated.foreignRequests.length, 0, 'Even the initial cross-origin iframe must be blocked');
      assert.equal(checkFailure(await engine.execute({ action: 'navigate', url: `${isolated.forbiddenOrigin}/direct` })).outcome, 'not-started');
      await click(engine, 'Forbidden navigation', 'link');
      unwrap(await engine.execute({ action: 'navigate', url: `${isolated.origin}/?id=origin` }));
      await click(engine, 'Forbidden redirect', 'link');
      const chain = await engine.execute({ action: 'navigate', url: `${isolated.origin}/redirect-chain?id=origin` });
      checkFailure(chain);
      unwrap(await engine.execute({ action: 'navigate', url: `${isolated.origin}/iframe-redirect-page?id=origin` }));
      assert.match((await observe(engine)).text, /Allowed parent/);
      unwrap(await engine.execute({ action: 'navigate', url: `${isolated.origin}/popup-redirect-page?id=origin` }));
      const beforePopupIds = new Set(unwrap(await engine.execute({ action: 'tabs' })).map(tab => tab.tabId));
      await click(engine, 'Open redirect popup');
      let popupTabs;
      await eventually(async () => { popupTabs = unwrap(await engine.execute({ action: 'tabs' })); return popupTabs.length >= 2; });
      const popup = popupTabs.find(tab => !beforePopupIds.has(tab.tabId));
      assert.ok(popup, 'The redirect must exercise a newly created popup target');
      let terminalNetwork;
      await eventually(async () => {
        terminalNetwork = unwrap(await engine.execute({ action: 'network', tabId: popup.tabId }));
        facts.popupTerminalNetwork = terminalNetwork;
        facts.foreignRequests = [...isolated.foreignRequests];
        return terminalNetwork.entries.some(entry => entry.event === 'failed' && entry.url === `${isolated.forbiddenOrigin}/redirect-destination`);
      }, 5000);
      facts.popupTerminalFailure = terminalNetwork.entries.find(entry => entry.event === 'failed' && entry.url === `${isolated.forbiddenOrigin}/redirect-destination`);
      facts.redirectChainOutcome = chain.outcome;
      facts.popupTabCount = popupTabs.length;
      facts.foreignRequests = [...isolated.foreignRequests];
      assert.equal(isolated.foreignRequests.length, 0, JSON.stringify(isolated.foreignRequests));
    } finally {
      // Preserve actual observed traffic even when a preceding terminal assertion fails.
      facts.foreignRequests = [...isolated.foreignRequests];
    }
  });
  await run('cancel-fetch', 'navigation cancels real unfinished requests without poisoning the native policy or browser', async ({ engine, state, facts, fixture: isolated }) => {
    try {
      unwrap(await click(engine, 'Start pending fetch'));
      await eventually(async () => (await state()).pendingFetch?.started > 0);
      facts.beforeNavigation = (await state()).pendingFetch;
      assert.equal(facts.beforeNavigation.completed, 0);
      unwrap(await engine.execute({ action: 'navigate', url: `${isolated.origin}/popup?id=cancel-fetch` }));
      await eventually(async () => (await state()).pendingFetch?.cancelled > 0);
      facts.afterNavigation = (await state()).pendingFetch;
      assert.equal(facts.afterNavigation.completed, 0, 'The server never completed the cancelled response');
      assert.match((await observe(engine)).text, /Popup content/);
      facts.networkAfterCancellation = unwrap(await engine.execute({ action: 'network' }));
      assert.ok(facts.networkAfterCancellation.entries.some(entry => entry.event === 'failed' && entry.url === `${isolated.origin}/pending-fetch`), 'A real browser request must have been cancelled');
      unwrap(await engine.execute({ action: 'navigate', url: `${isolated.origin}/?id=cancel-fetch` }));
      unwrap(await click(engine, 'Native action'));
      await eventually(() => hasEvent(state, 'native', event => event.trusted));
      assert.equal((await state()).events.filter(event => event.kind === 'native').length, 1);
      assert.equal(isolated.foreignRequests.length, 0);
    } finally { facts.foreignRequests = [...isolated.foreignRequests]; }
  });
  await run('logs', 'bounded console and network observations retain useful facts without URL query secrets', async ({ engine }) => {
    unwrap(await click(engine, 'Produce logs'));
    let logs;
    await eventually(async () => { logs = unwrap(await engine.execute({ action: 'console' })); return logs.entries.some(entry => entry.text === 'fixture-log'); });
    const network = unwrap(await engine.execute({ action: 'network' }));
    assert.ok(network.entries.length > 0);
    assert.ok(!JSON.stringify(network).includes('redact-me'));
    assert.ok(network.entries.length <= 50);
    const next = unwrap(await engine.execute({ action: 'console', after: logs.next }));
    assert.equal(next.entries.length, 0);
  });
  await run('bounded', 'large pages have bounded observations, pagination and no password values', async ({ engine }) => {
    const result = await observe(engine);
    assert.ok(JSON.stringify(result).length <= 18000, `Observation was ${JSON.stringify(result).length} chars`);
    assert.ok(result.nodes.length <= 60);
    assert.ok(result.nextNodeOffset !== null);
    assert.ok(result.nextTextOffset !== null);
    assert.ok(!JSON.stringify(result).includes('hidden-test-password'));
    const second = unwrap(await engine.execute({ action: 'observe', nodeOffset: result.nextNodeOffset, textOffset: result.nextTextOffset }));
    assert.equal(second.nodeOffset, result.nextNodeOffset);
    assert.ok(second.nodes.some(node => !result.nodes.some(previous => previous.ref === node.ref)));
  });
  await run('bounded-small', 'minimum configured observation budget remains a hard bound', async ({ engine }) => {
    const result = await observe(engine);
    assert.ok(JSON.stringify(result).length <= 4000, `Minimum-budget observation was ${JSON.stringify(result).length} chars`);
  }, { maxOutputChars: 4000 });
  await run('bounded-cjk', 'CJK observations and logs respect UTF-8 byte budgets with strictly advancing pagination', async ({ engine, state, facts }) => {
    const budget = 5000;
    let maximumBytes = 0;
    const bounded = value => {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      maximumBytes = Math.max(maximumBytes, bytes);
      assert.ok(bytes <= budget, `UTF-8 result was ${bytes} bytes, over ${budget}`);
    };
    const seenChineseNodes = new Set();
    const seenChineseIndices = new Set();
    facts.cjkPagination = [];
    let nodeOffset = 0, nodePages = 0, first;
    do {
      const snapshot = unwrap(await engine.execute({ action: 'observe', nodeOffset }));
      bounded(snapshot); first ??= snapshot; nodePages++;
      for (const node of snapshot.nodes) {
        const match = node.name.match(/^中文操作([0-9]+)：/);
        if (match) { seenChineseNodes.add(node.ref); seenChineseIndices.add(Number(match[1])); }
      }
      facts.cjkPagination.push({ nodeOffset, nextNodeOffset: snapshot.nextNodeOffset, nodeTotal: snapshot.nodeTotal, samples: snapshot.nodes.slice(0, 3).map(node => ({ ref: node.ref, name: node.name.slice(0, 80) })) });
      if (facts.cjkPagination.length > 8) facts.cjkPagination.shift();
      facts.seenChineseNodes = seenChineseNodes.size;
      if (snapshot.nextNodeOffset === null) break;
      assert.ok(snapshot.nodes.length > 0, 'Node pagination returned an empty page with more nodes remaining');
      assert.ok(snapshot.nextNodeOffset > nodeOffset, 'Node pagination did not advance');
      nodeOffset = snapshot.nextNodeOffset;
      assert.ok(nodePages < 160, 'Node pagination did not terminate');
    } while (true);
    assert.equal(seenChineseNodes.size, 80, 'Every fixture CJK node must remain discoverable');
    assert.deepEqual([...seenChineseIndices].sort((a, b) => a - b), Array.from({ length: 80 }, (_, index) => index), 'Each distinct Chinese fixture control must be discoverable');
    const mainFrame = first.frames.find(frame => frame.url.startsWith(fixture.origin));
    assert.ok(mainFrame);
    let textOffset = 0, textPages = 0, textCharacters = 0;
    do {
      const snapshot = unwrap(await engine.execute({ action: 'observe', frameId: mainFrame.frameId, nodeOffset: first.nodeTotal, textOffset }));
      bounded(snapshot); textPages++;
      assert.ok(snapshot.text.length > 0, 'Text pagination returned an empty/non-progress page');
      textCharacters += snapshot.text.length;
      if (snapshot.nextTextOffset === null) break;
      assert.ok(snapshot.nextTextOffset > textOffset, 'Text pagination did not advance');
      textOffset = snapshot.nextTextOffset;
      assert.ok(textPages < 160, 'Text pagination did not terminate');
    } while (true);
    assert.ok(textCharacters > 3000, 'Long Chinese page content must actually be read');
    unwrap(await click(engine, '中文日志'));
    await eventually(() => hasEvent(state, 'cjk-logs'));
    let logs;
    await eventually(async () => { logs = unwrap(await engine.execute({ action: 'console' })); return logs.entries.some(entry => entry.text.startsWith('第7条')); });
    bounded(logs);
    assert.ok(logs.entries.length < 8, 'Eight near-1000-character Chinese logs cannot fit the byte budget');
    bounded(unwrap(await engine.execute({ action: 'tabs' })));
    Object.assign(facts, { budgetBytes: budget, maximumBytes, nodePages, chineseNodeCount: seenChineseNodes.size, textPages, textCharacters, retainedLogs: logs.entries.length });
  }, { maxOutputChars: 5000 });
  await run('navigation-ref', 'navigation revokes previous references and subsequent reading still works', async ({ engine, id }) => {
    const snapshot = await observe(engine);
    const node = snapshot.nodes.find(node => node.name === 'Native action'); assert.ok(node);
    unwrap(await engine.execute({ action: 'navigate', url: `${fixture.origin}/popup?id=${id}` }));
    checkFailure(await engine.execute({ action: 'click', target: { ref: node.ref, observationId: snapshot.observationId } }));
    unwrap(await engine.execute({ action: 'back' }));
    assert.match((await observe(engine)).text, /Browser acceptance/);
    unwrap(await engine.execute({ action: 'forward' }));
    assert.match((await observe(engine)).text, /Popup content/);
  });
} finally {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}
await verifyUnchanged(repository, runProvenance);
console.log(`1..${ordinal}`);
const report = { schema: 'xharness.browser-use.acceptance.v1', referenceCommit: '3c5b227649371507ddc4eb46ac5133afe6db1cab', provenance: runProvenance, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, environment: 'isolated Chromium; no live user tabs; no LLM used', scope: 'Direct engine integration, not complete ZCode product parity or model quality', totals: { cases: evidence.length, passed: evidence.length - failures, failed: failures }, cases: evidence };
const output = process.env.BROWSER_ACCEPTANCE_EVIDENCE;
if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report.totals));
process.exitCode = failures ? 1 : 0;
