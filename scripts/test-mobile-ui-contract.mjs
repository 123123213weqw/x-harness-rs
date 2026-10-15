#!/usr/bin/env node
// Actual mobile UI source in a disposable VM + deliberately small DOM/fetch
// doubles. No browser, account, network, model, Rust compiler or real cookie.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'ui/mobile/app.js'), 'utf8');
const html = await readFile(path.join(root, 'ui/mobile/index.html'), 'utf8');
const css = await readFile(path.join(root, 'ui/mobile/style.css'), 'utf8');
assert.match(source, /\nrefresh\(\);\s*$/, 'explicit bootstrap required for deterministic VM tests');
const bootless = source.replace(/\nrefresh\(\);\s*$/, '\n');
const clone = value => JSON.parse(JSON.stringify(value));
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.children = []; this.parentElement = null;
    this.hidden = false; this.disabled = false; this._text = ''; this._value = '';
    this.files = []; this.elements = {}; this.className = '';
    this.dataset = {}; this.styleValues = new Map();
    this.style = { setProperty: (key, value) => this.styleValues.set(key, value) };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = String(value); if (this.type === 'file' && value === '') this.files = []; }
  get value() { return this._value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  set innerHTML(_) { throw new Error('test forbids HTML injection'); }
  append(...nodes) {
    for (const node of nodes) {
      assert.ok(node instanceof Element, 'this UI must append constructed DOM nodes');
      node.remove(); node.parentElement = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } }
  querySelectorAll(tag) { const result = []; for (const child of this.children) { if (child.tagName === tag) result.push(child); result.push(...child.querySelectorAll(tag)); } return result; }
  querySelector(tag) { return this.querySelectorAll(tag)[0] ?? null; }
}

function documentFixture() {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]); node.hidden = /\bhidden\b/.test(match[2]); nodes.set(match[3], node);
  }
  const get = id => { assert.ok(nodes.has(id), `missing actual markup id: ${id}`); return nodes.get(id); };
  const pair = get('pair-form');
  for (const name of ['host', 'code', 'name']) { const input = new Element('input'); input.name = name; input.value = name === 'name' ? 'fixture phone' : ''; pair.elements[name] = input; pair.append(input); }
  const pairButton = new Element('button'); pair.append(pairButton); get('pair').append(pair, get('reconnect'));
  for (const id of ['sessions', 'refresh', 'review-interactions', 'new-session', 'scope', 'conversation', 'interaction-dialog', 'prompt-form']) get('control').append(get(id));
  for (const id of ['timeline', 'unknown', 'automation-panel']) get('conversation').append(get(id));
  get('interaction-dialog').append(get('close-interactions'), get('interactions'));
  get('automation-panel').append(get('automations'), get('automation-list'));
  get('unknown').append(get('inspect'), get('abandon'));
  get('files').type = 'file'; get('mode').value = 'queue';
  get('prompt-form').append(get('prompt'), get('files'), get('mode'), get('cancel'), get('file-status'), new Element('button'));
  const loading = new Element('p'); loading.textContent = '正在读取原生会话记录…'; get('timeline').append(loading);
  return { nodes, get, document: { hidden: false, documentElement: new Element('html'), getElementById: get, createElement: tag => new Element(tag) } };
}

function success(result) { return new Response(JSON.stringify({ ok: true, result }), { status: 200 }); }
function failure(error) { return new Response(JSON.stringify({ ok: false, error }), { status: 409 }); }
function status(session = 'session-a', generation = 1) { return { host: 'fixture-host', device: 'fixture-device', binding: { workspace: 'workspace-a', session, generation }, generation, principal_revision: 1 }; }
function event(seq, type = 'user/message', data = { content: [{ type: 'text', text: 'native text' }] }, session = 'session-a') {
  return { method: 'session/event', payload: { type: 'session/event', sessionId: session, event: { seq, type, data } } };
}
function page(after = 0, items = [], generation = 1) { return { generation, page: { start_seq: after, next_seq: after + items.length, head_seq: after + items.length, events: items } }; }
function receipt(state = 'completed', value = null) { return { key: 'fixture-original-delivery', generation: 1, principal_revision: 1, state, result: state === 'completed' ? { ok: true, value } : null, result_withheld: false }; }

function harness({ href = 'https://relay.fixture/', stored = {}, fetchPlan, confirm = () => true, visualViewport = { height: 844, offsetTop: 0, scale: 1 } } = {}) {
  const dom = documentFixture(); const requests = []; const storage = new Map(Object.entries(stored)); const timers = new Set(); const intervals = [];
  const clock = { now: Date.now() };
  class FixtureDate extends Date { static now() { return clock.now; } }
  const location = new URL(href); const historyCalls = [];
  const windowEvents = new Map(), viewportEvents = new Map();
  const listen = events => (name, callback) => { events.set(name, callback); };
  const viewport = visualViewport ? { ...visualViewport, addEventListener: listen(viewportEvents) } : null;
  const window = { innerHeight: 844, visualViewport: viewport, addEventListener: listen(windowEvents) };
  const defaultResult = body => {
    switch (body.type) {
      case 'status': return status();
      case 'catalogue': return { principal_revision: 1, binding_generation: 1, catalogue: { workspaces: [{ id: 'workspace-a', title: 'Test workspace' }], sessions: [{ workspace: 'workspace-a', id: 'session-a', title: 'Test session', running: false }], next: null } };
      case 'events': return page(body.after ?? 0);
      case 'snapshot': return { generation: 1, frames: [], interactions: [] };
      case 'command': return receipt();
      case 'delivery': return receipt();
      default: return {};
    }
  };
  let uuid = 0;
  const context = vm.createContext({
    document: dom.document, window, location,
    history: { replaceState: (_state, _title, url) => { historyCalls.push(url); location.href = new URL(url, location.href).href; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    FormData: class { constructor(form) { this.entries = new Map(Object.entries(form.elements).map(([key, input]) => [key, input.value])); } get(key) { return this.entries.get(key) ?? null; } },
    fetch: async (url, options) => {
      assert.ok(String(url).startsWith('https://relay.fixture/api/mobile/'), 'fixture must not reach network or another origin');
      const request = { url: String(url), route: new URL(url).pathname.split('/').at(-1), options, body: JSON.parse(options.body) }; requests.push(request);
      if (fetchPlan) { const planned = await fetchPlan(request, requests.length); if (planned !== undefined) return planned; }
      if (request.route === 'pair') return success({ host: request.body.host, device: 'fixture-device' });
      if (request.route === 'logout') return success({});
      return success(defaultResult(request.body));
    },
    setTimeout: (callback, delay) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay === 35000 ? delay : Math.min(delay, 1)); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    AbortController, URL, URLSearchParams, TextDecoder, Uint8Array, Intl, Date: FixtureDate,
    crypto: { randomUUID: () => `fixture-request-${++uuid}` },
    btoa: value => Buffer.from(value, 'binary').toString('base64'), confirm,
  });
  vm.runInContext(`${bootless}\n;globalThis.__hooks={
    renderReceipt, command, refresh, events, bodyText, frame, interaction, snapshot, remember,
    state:()=>({status,generation,after,pending,working,polling,active,epoch,messageCount:messages.size,interactionCount:interactionViews.size}),
    seed:(s,a=0)=>{status=s;generation=s.generation;after=a;active=true;},
    setApi:fn=>{api=fn;}
  };`, context, { filename: path.join(root, 'ui/mobile/app.js'), timeout: 2000 });
  return { ...dom, hooks: context.__hooks, requests, storage, location, historyCalls, intervals, window, viewport, windowEvents, viewportEvents,
    advanceTime(ms) { clock.now += ms; },
    dispose() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
    submit: id => dom.get(id).onsubmit({ preventDefault() {}, currentTarget: dom.get(id), target: dom.get(id) }),
  };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });
async function withHarness(options, run) { if (typeof options === 'function') { run = options; options = {}; } const h = harness(options); try { await run(h); } finally { h.dispose(); } }

test('viewport presentation follows visible keyboard height and offset without any request or draft mutation', () => withHarness(h => {
  const root = h.document.documentElement;
  assert.equal(root.styleValues.get('--app-height'), '844px');
  h.get('prompt').value = 'unsent draft';
  h.hooks.remember({ request_id: 'original', unknown: true });
  const original = h.storage.get('xh-mobile-pending');
  h.viewport.height = 350.4; h.viewport.offsetTop = 17.2;
  h.viewportEvents.get('resize')();
  assert.equal(root.styleValues.get('--app-height'), '350px');
  assert.equal(root.styleValues.get('--app-top'), '17px');
  assert.equal(root.dataset.compact, 'true');
  assert.equal(h.get('prompt').value, 'unsent draft');
  assert.equal(h.storage.get('xh-mobile-pending'), original);
  assert.equal(h.requests.length, 0);
  h.viewport.height = 844; h.viewport.offsetTop = 0;
  h.viewportEvents.get('scroll')();
  assert.equal(root.dataset.compact, 'false');
  assert.equal(root.styleValues.get('--app-top'), '0px');
}));

test('viewport fallback handles rotation and pageshow without visualViewport', () => withHarness({ visualViewport: null }, h => {
  h.window.innerHeight = 390; h.windowEvents.get('resize')();
  assert.equal(h.document.documentElement.styleValues.get('--app-height'), '390px');
  h.window.innerHeight = 720; h.windowEvents.get('pageshow')();
  assert.equal(h.document.documentElement.styleValues.get('--app-height'), '720px');
  assert.equal(h.document.documentElement.dataset.compact, 'false');
  assert.equal(h.requests.length, 0);
}));

test('pinch zoom and invalid viewport sizes do not force an app resize', () => withHarness(h => {
  const root = h.document.documentElement;
  h.viewport.height = 300; h.viewport.scale = 2; h.viewportEvents.get('resize')();
  assert.equal(root.styleValues.get('--app-height'), '844px');
  h.viewport.scale = 1;
  for (const height of [0, -5, NaN, Infinity]) { h.viewport.height = height; h.viewportEvents.get('resize')(); assert.equal(root.styleValues.get('--app-height'), '844px'); }
  h.viewport.height = 600; h.viewport.offsetTop = -10; h.viewportEvents.get('resize')();
  assert.equal(root.styleValues.get('--app-height'), '600px');
  assert.equal(root.styleValues.get('--app-top'), '0px');
}));

test('view mode follows authoritative auth; sealed recovery preserves original inspection and never replays', () => {
  let unauthorized = false;
  return withHarness({ fetchPlan: request => unauthorized && request.body.type === 'status' ? failure('unauthorized') : undefined }, async h => {
    const root = h.document.documentElement;
    assert.equal(root.dataset.view, 'pair');
    await h.hooks.refresh(); assert.equal(root.dataset.view, 'control');
    h.hooks.remember({ request_id: 'original', unknown: true });
    unauthorized = true; await h.hooks.refresh();
    assert.equal(root.dataset.view, 'recovery');
    assert.equal(h.get('control').hidden, false); assert.equal(h.get('prompt').disabled, true);
    assert.equal(h.get('inspect').parentElement, h.get('unknown'));
    assert.equal(h.get('unknown').parentElement, h.get('conversation'));
    assert.equal(h.requests.some(r => r.body.type === 'command'), false);
    unauthorized = false; await h.get('reconnect').onclick(); assert.equal(root.dataset.view, 'control');
    await h.get('logout').onclick(); assert.equal(root.dataset.view, 'pair');
  });
});

test('layout contract separates scrolling history from a bounded composer and preserves zoom and focus', () => {
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /id="conversation" tabindex="0" aria-label="会话记录与待确认操作"/);
  assert.ok(html.indexOf('id="automation-panel"') < html.indexOf('id="prompt-form"'));
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  assert.match(css, /--app-height:\s*100dvh/);
  assert.match(css, /#conversation\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto/s);
  assert.match(css, /#prompt-form\s*\{[^}]*flex-shrink:\s*0/s);
  assert.match(css, /input, select, textarea\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /#conversation:focus-visible/);
  assert.doesNotMatch(css, /max-height:\s*(48|56)dvh/);
});

test('nullable native success is not failure; known failure remains unsuccessful', () => withHarness(h => {
  h.hooks.remember({ request_id: 'original', kind: 'prompt' });
  const accepted = h.hooks.renderReceipt(receipt());
  assert.notEqual(accepted, null); assert.equal(accepted.ok, true); assert.equal(accepted.value, null); assert.equal(h.hooks.state().pending, null);
  h.hooks.remember({ request_id: 'original-failure', kind: 'prompt' });
  const failed = receipt(); failed.result = { ok: false, error: { code: 'operation_failed' } };
  assert.throws(() => h.hooks.renderReceipt(failed), /request_rejected/);
  assert.equal(h.hooks.state().pending, null); assert.equal(h.storage.has('xh-mobile-pending'), false);
}));

test('malformed completed receipt retains original pending identity instead of unlocking a replay', async () => {
  const malformed = [
    r => { r.result = null; }, r => { r.result = {}; }, r => { r.result = { ok: 'true', value: null }; },
    r => { r.result = { ok: true }; },
  ];
  for (const alter of malformed) await withHarness(h => {
    h.hooks.remember({ request_id: 'original-malformed', generation: 1, kind: 'cancel', unknown: true });
    const r = receipt(); alter(r); assert.throws(() => h.hooks.renderReceipt(r), /invalid_response/);
    assert.equal(h.hooks.state().pending.request_id, 'original-malformed'); assert.equal(h.get('unknown').hidden, false);
    assert.equal(JSON.parse(h.storage.get('xh-mobile-pending')).request_id, 'original-malformed');
  });
});

test('post-admission errors preserve original request identity and never retry mutations', async () => {
  for (const code of ['conflict', 'unauthorized', 'invalid_request', 'capacity', 'storage_unavailable', 'timeout']) {
    await withHarness({ fetchPlan: request => request.body.type === 'command' ? failure(code) : undefined }, async h => {
      h.hooks.seed(status()); assert.equal(await h.hooks.command({ type: 'cancel' }), null);
      const pending = h.hooks.state().pending; assert.equal(pending.request_id, h.requests[0].body.request_id); assert.equal(pending.unknown, true);
      assert.equal(h.get('unknown').hidden, false); assert.equal(h.hooks.state().working, false);
      await h.hooks.command({ type: 'cancel' }); await h.intervals[0]();
      assert.equal(h.requests.filter(r => r.body.type === 'command').length, 1);
      const persisted = JSON.parse(h.storage.get('xh-mobile-pending')); assert.equal(persisted.request_id, pending.request_id); assert.equal(persisted.kind, 'cancel');
    });
  }
});

test('terminal rejection and abandonment clear pending instead of permanently locking controls', async () => {
  for (const terminal of ['rejected', 'abandoned']) {
    await withHarness(async h => {
      h.hooks.seed(status()); h.hooks.remember({ request_id: 'original', unknown: true });
      assert.throws(() => h.hooks.renderReceipt(receipt(terminal)), /request_rejected/);
      assert.equal(h.hooks.state().pending, null); assert.equal(h.storage.has('xh-mobile-pending'), false); assert.equal(h.get('unknown').hidden, true);
      assert.equal((await h.hooks.command({ type: 'cancel' })).ok, true);
    });
  }
});

test('uncertain delivery survives inspection and never automatically replays', () => withHarness(h => {
  h.hooks.remember({ request_id: 'original', generation: 1 });
  assert.equal(h.hooks.renderReceipt(receipt('uncertain')), null);
  assert.equal(h.hooks.state().pending.request_id, 'original'); assert.equal(h.hooks.state().pending.key, 'fixture-original-delivery'); assert.equal(h.hooks.state().pending.unknown, true);
  assert.equal(h.requests.length, 0);
}));

test('pairing waits for in-flight initial refresh then enters the authenticated control page', () => {
  const initial = deferred(); let reads = 0;
  return withHarness({ fetchPlan: request => request.body.type === 'status' && ++reads === 1 ? initial.promise : undefined }, async h => {
    const boot = h.hooks.refresh(); await pause(); assert.equal(h.hooks.state().polling, true);
    h.get('pair-form').elements.host.value = 'fixture-host'; h.get('pair-form').elements.code.value = 'fixture-pair-code';
    const pairing = h.submit('pair-form'); await pause();
    assert.equal(h.get('pair-form').elements.code.value, ''); assert.equal(h.hooks.state().active, false);
    initial.resolve(failure('unauthorized')); await boot; await pairing;
    assert.ok(reads >= 2); assert.equal(h.hooks.state().active, true); assert.equal(h.get('pair').hidden, true); assert.equal(h.get('control').hidden, false);
    assert.equal(h.get('pair-form').querySelector('button').disabled, false); assert.equal(h.get('error').hidden, true);
  });
});

test('failed/unknown first pairing never presents control success and offers visible reconnect', () => withHarness({ fetchPlan: request => request.route === 'pair' ? failure('host_offline') : undefined }, async h => {
  h.get('pair-form').elements.host.value = 'fixture-host'; h.get('pair-form').elements.code.value = 'fixture-pair-code';
  await h.submit('pair-form'); assert.equal(h.hooks.state().active, false); assert.equal(h.get('pair').hidden, false); assert.equal(h.get('control').hidden, true);
  assert.equal(h.get('pair-form').elements.code.value, ''); assert.equal(typeof h.get('reconnect').onclick, 'function');
  await h.get('reconnect').onclick(); assert.equal(h.hooks.state().active, true);
}));

test('select waits for forced refresh and subsequent commands carry the new binding generation', () => {
  const oldRead = deferred(); let reads = 0; let selected = false;
  return withHarness({ fetchPlan: request => {
    if (request.body.type === 'status') { if (++reads === 1) return oldRead.promise; return success(status(selected ? 'session-b' : 'session-a', selected ? 2 : 1)); }
    if (request.body.type === 'command' && request.body.command.type === 'select') { selected = true; return success(receipt('completed', { binding: { workspace: 'workspace-a', session: 'session-b', generation: 2 } })); }
    if (request.body.type === 'events' && selected) return success(page(request.body.after, [], 2));
    if (request.body.type === 'snapshot' && selected) return success({ generation: 2, frames: [], interactions: [] });
    return undefined;
  } }, async h => {
    h.hooks.seed(status()); const reading = h.hooks.refresh(); await pause();
    const selecting = h.get('sessions').onchange({ target: { value: JSON.stringify({ workspace: 'workspace-a', session: 'session-b' }) } }); await pause();
    assert.equal(h.hooks.state().generation, 1); oldRead.resolve(success(status())); await reading; await selecting;
    assert.equal(h.hooks.state().generation, 2); assert.equal(h.hooks.state().status.binding.session, 'session-b');
    await h.hooks.command({ type: 'cancel' }); assert.equal(h.requests.filter(r => r.body.type === 'command').at(-1).body.generation, 2);
  });
});

test('contiguous native events advance next-slot cursor and replace the loading placeholder', () => withHarness(async h => {
  h.hooks.seed(status()); h.hooks.setApi(async () => page(0, [event(0)])); await h.hooks.events();
  assert.equal(h.hooks.state().after, 1); assert.equal(h.get('timeline').textContent.includes('正在读取'), false); assert.equal(h.get('timeline').textContent.includes('native text'), true);
  h.get('timeline').replaceChildren(); h.hooks.setApi(async () => page(1)); await h.hooks.events(); assert.equal(h.get('timeline').textContent, '这个会话暂时没有消息。');
}));

test('malformed event cuts, counts, sequence, envelope and session are rejected before rendering', async () => {
  const valid = page(2, [event(2)]);
  const corruptions = [
    p => { p.page.start_seq = 1; }, p => { p.page.next_seq = 4; }, p => { p.page.head_seq = 2; },
    p => { p.page.events[0].payload.event.seq = 3; }, p => { p.page.events[0].payload.sessionId = 'other-private-session'; },
    p => { p.page.events[0].method = 'global/event'; }, p => { p.page.events[0].payload.type = 'global/event'; },
    p => { p.page.next_seq = Number.MAX_SAFE_INTEGER + 1; },
    p => { p.page.events = [event(2), event(2)]; p.page.next_seq = p.page.head_seq = 4; },
    p => { p.page.events = Array.from({ length: 129 }, (_, i) => event(i + 2)); p.page.next_seq = p.page.head_seq = 131; },
  ];
  for (const corrupt of corruptions) await withHarness(async h => {
    h.hooks.seed(status(), 2); const response = clone(valid); corrupt(response); h.hooks.setApi(async () => response);
    await assert.rejects(h.hooks.events(), /stream_gap|invalid_response/);
    assert.equal(h.hooks.state().after, 2); assert.equal(h.hooks.state().messageCount, 0);
    assert.equal(h.get('timeline').textContent, '正在读取原生会话记录…');
  });
});

test('superseded-generation event reply is discarded without cursor or DOM mutation', () => withHarness(async h => {
  h.hooks.seed(status(), 2); h.hooks.setApi(async () => page(2, [event(2)], 9)); await h.hooks.events();
  assert.equal(h.hooks.state().after, 2); assert.equal(h.hooks.state().messageCount, 0);
}));

test('nested tool text is displayed literally and all normal tool rows share the 500-item bound', () => withHarness(h => {
  const malicious = '<img src=x onerror=alert(1)>';
  assert.equal(h.hooks.bodyText([{ type: 'tool-result', content: [{ type: 'text', text: 'tool output' }, { type: 'tool-result', content: malicious }] }]), `tool output\n${malicious}`);
  h.hooks.seed(status()); h.get('timeline').replaceChildren();
  h.hooks.frame(event(0, 'tool/result', { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: malicious }] }] } }));
  assert.ok(h.get('timeline').textContent.includes(malicious)); assert.equal(h.get('timeline').querySelectorAll('img').length, 0);
  for (let seq = 1; seq <= 700; seq++) h.hooks.frame(event(seq, 'tool/call', { name: 'fixture tool', arguments: { text: malicious } }));
  assert.equal(h.hooks.state().messageCount, 500); assert.equal(h.get('timeline').children.length, 500);
}));

test('re-reading an original tool-call sequence is DOM-idempotent even after partial rendering', () => withHarness(h => {
  h.hooks.seed(status()); h.get('timeline').replaceChildren();
  const original = event(0, 'tool/call', { name: 'fixture tool', arguments: { text: 'same original intent' } });
  for (let i = 0; i < 1000; i++) h.hooks.frame(original);
  assert.equal(h.hooks.state().messageCount, 1); assert.equal(h.get('timeline').children.length, 1);
  assert.equal(h.get('timeline').querySelectorAll('details').length, 1);
}));

test('native question answers use labels, 8192-character custom fields and original scoped ticket', () => withHarness(async h => {
  h.hooks.seed(status()); const calls = []; h.hooks.setApi(async (_route, body) => { calls.push(body); return body.type === 'command' ? receipt('completed', { accepted: true }) : { generation: 1, frames: [], interactions: [] }; });
  h.hooks.interaction({ token: 'fixture-ticket', expires_at_ms: Date.now() + 10000, interaction: { frame: { method: 'question/requested', payload: { sessionId: 'session-a', questions: [{ id: 'target', question: 'Choose target', options: [{ label: 'Test workspace' }] }] } } } });
  const form = h.get('interactions').querySelector('form'); assert.equal(form.querySelector('input').maxLength, 8192); form.querySelector('select').value = 'Test workspace';
  await form.onsubmit({ preventDefault() {} });
  const action = calls.find(c => c.type === 'command'); assert.equal(action.command.ticket, 'fixture-ticket'); assert.equal(action.command.answer.type, 'question');
  assert.deepEqual(clone(action.command.answer.answers), [{ id: 'target', selected: 'Test workspace', custom: null }]);
}));

function questionTicket(token = 'fixture-ticket', expires = Date.now() + 60000, session = 'session-a') {
  return { token, expires_at_ms: expires, interaction: { frame: { method: 'question/requested', payload: { sessionId: session, questions: [{ id: 'target', question: 'Choose target', options: [{ label: 'Test workspace' }] }] } } } };
}

test('background snapshots preserve same original ticket DOM, selection and custom-answer draft', () => withHarness(async h => {
  h.hooks.seed(status()); const ticket = questionTicket(); const calls = [];
  h.hooks.setApi(async (_route, body) => { calls.push(body); return { generation: 1, frames: [], interactions: [clone(ticket)] }; });
  await h.hooks.snapshot(); const form = h.get('interactions').querySelector('form');
  form.querySelector('select').value = 'Test workspace'; form.querySelector('input').value = 'Unsubmitted answer kept across polls';
  for (let i = 0; i < 5; i++) { h.advanceTime(1000); await h.hooks.snapshot(); }
  assert.equal(h.get('interactions').querySelector('form'), form);
  assert.equal(form.querySelector('select').value, 'Test workspace'); assert.equal(form.querySelector('input').value, 'Unsubmitted answer kept across polls');
  assert.equal(h.hooks.state().interactionCount, 1); assert.equal(h.get('interactions').children.length, 1);
  assert.equal(calls.filter(c => c.type === 'command').length, 0);
}));

test('disappeared original ticket is removed and detached form cannot submit a stale answer', () => withHarness(async h => {
  h.hooks.seed(status()); const ticket = questionTicket(); let pendingTickets = [ticket]; const calls = [];
  h.hooks.setApi(async (_route, body) => { calls.push(body); return { generation: 1, interactions: clone(pendingTickets) }; });
  await h.hooks.snapshot(); const oldForm = h.get('interactions').querySelector('form'); oldForm.querySelector('select').value = 'Test workspace';
  pendingTickets = []; await h.hooks.snapshot(); assert.equal(h.get('interactions').children.length, 0); assert.equal(h.hooks.state().interactionCount, 0);
  await oldForm.onsubmit({ preventDefault() {} }); assert.equal(calls.filter(c => c.type === 'command').length, 0); assert.equal(h.hooks.state().pending, undefined);
}));

test('expired tickets are removed both by snapshot and by submission-time expiry guard', async () => {
  for (const snapshotFirst of [false, true]) await withHarness(async h => {
    h.hooks.seed(status()); const ticket = questionTicket('short-lived-ticket', Date.now() + 1000); const calls = [];
    h.hooks.setApi(async (_route, body) => { calls.push(body); return { generation: 1, interactions: [clone(ticket)] }; });
    await h.hooks.snapshot(); const oldForm = h.get('interactions').querySelector('form'); oldForm.querySelector('select').value = 'Test workspace';
    h.advanceTime(2000); if (snapshotFirst) await h.hooks.snapshot(); await oldForm.onsubmit({ preventDefault() {} });
    assert.equal(calls.filter(c => c.type === 'command').length, 0); assert.equal(h.get('interactions').children.length, 0); assert.equal(h.hooks.state().interactionCount, 0);
  });
});

test('authoritative binding change clears ticket views and fences a saved old submission handler', () => withHarness(async h => {
  h.hooks.seed(status()); const ticket = questionTicket(); h.hooks.interaction(ticket);
  const oldForm = h.get('interactions').querySelector('form'); oldForm.querySelector('select').value = 'Test workspace'; const calls = [];
  h.hooks.setApi(async (_route, body) => {
    calls.push(body);
    if (body.type === 'status') return status('session-b', 2);
    if (body.type === 'catalogue') return { catalogue: { workspaces: [{ id: 'workspace-a', title: 'Test workspace' }], sessions: [{ workspace: 'workspace-a', id: 'session-b', title: 'Other session' }], next: null } };
    if (body.type === 'events') return page(body.after, [], 2);
    return { generation: 2, interactions: [] };
  });
  await h.hooks.refresh(true); assert.equal(h.hooks.state().generation, 2); assert.equal(h.hooks.state().interactionCount, 0);
  await oldForm.onsubmit({ preventDefault() {} }); assert.equal(calls.filter(c => c.type === 'command').length, 0);
}));

test('a delayed old-generation snapshot cannot reintroduce a removed old scope ticket', () => withHarness(async h => {
  h.hooks.seed(status()); const waiting = deferred(); h.hooks.setApi(async () => waiting.promise);
  const reading = h.hooks.snapshot(); h.hooks.seed(status('session-b', 2)); waiting.resolve({ generation: 1, interactions: [questionTicket()] }); await reading;
  assert.equal(h.get('interactions').children.length, 0); assert.equal(h.hooks.state().interactionCount, 0);
}));

test('logout clears retained question views and prevents old handler submission', () => withHarness(async h => {
  h.hooks.seed(status()); h.hooks.interaction(questionTicket()); const form = h.get('interactions').querySelector('form'); form.querySelector('select').value = 'Test workspace';
  await h.get('logout').onclick(); assert.equal(h.hooks.state().interactionCount, 0); assert.equal(h.get('interactions').children.length, 0);
  await form.onsubmit({ preventDefault() {} }); assert.equal(h.requests.filter(r => r.body.type === 'command').length, 0);
}));

test('Host/device/revision change clears the old form even if session generation is unchanged', async () => {
  for (const changed of ['host', 'device', 'principal_revision']) await withHarness(async h => {
    h.hooks.seed(status()); h.hooks.interaction(questionTicket()); const form = h.get('interactions').querySelector('form'); form.querySelector('select').value = 'Test workspace'; const calls = [];
    const next = status(); next[changed] = changed === 'principal_revision' ? 2 : 'different-identity';
    h.hooks.setApi(async (_route, body) => {
      calls.push(body); if (body.type === 'status') return next;
      if (body.type === 'catalogue') return { catalogue: { workspaces: [], sessions: [], next: null } };
      if (body.type === 'events') return page(body.after);
      return { generation: 1, interactions: [] };
    });
    await h.hooks.refresh(true); assert.equal(h.hooks.state().interactionCount, 0); assert.equal(h.hooks.state().generation, 1);
    await form.onsubmit({ preventDefault() {} }); assert.equal(calls.filter(c => c.type === 'command').length, 0);
  });
});

test('late pre-logout snapshot cannot restore its ticket after another same-generation login', () => withHarness(async h => {
  h.hooks.seed(status()); const wait = deferred(); h.hooks.setApi(async (_route, body) => body?.type === 'snapshot' ? wait.promise : {});
  const reading = h.hooks.snapshot(); await h.get('logout').onclick(); h.hooks.seed(status());
  wait.resolve({ generation: 1, interactions: [questionTicket()] }); await reading;
  assert.equal(h.hooks.state().interactionCount, 0); assert.equal(h.get('interactions').children.length, 0);
}));

test('periodic unauthorized seals old scope/forms but preserves original unknown query metadata', () => withHarness({ fetchPlan: request => ['status', 'delivery'].includes(request.body.type) ? failure('unauthorized') : undefined }, async h => {
  h.hooks.seed(status()); h.get('control').hidden = false; h.get('pair').hidden = true; h.get('logout').hidden = false;
  h.hooks.interaction(questionTicket()); const form = h.get('interactions').querySelector('form'); form.querySelector('select').value = 'Test workspace';
  const original = { request_id: 'original-unknown', key: 'original-delivery-key', generation: 1, kind: 'prompt', unknown: true };
  h.hooks.remember(original); const persisted = h.storage.get('xh-mobile-pending');
  await h.intervals[0](); const sealed = h.hooks.state();
  assert.equal(sealed.active, false); assert.equal(sealed.status, undefined); assert.equal(sealed.generation, undefined); assert.equal(sealed.interactionCount, 0);
  assert.equal(h.get('pair').hidden, false); assert.equal(h.get('control').hidden, false); assert.equal(h.get('prompt').disabled, true); assert.equal(h.get('sessions').disabled, true);
  assert.deepEqual(clone(sealed.pending), original); assert.equal(h.storage.get('xh-mobile-pending'), persisted);
  const before = h.requests.length; await form.onsubmit({ preventDefault() {} }); await h.hooks.command({ type: 'cancel' }); await h.get('cancel').onclick();
  assert.equal(h.requests.length, before, 'old form/direct mutation hooks cannot request after seal');
  await h.intervals[0](); assert.equal(h.requests.length, before, 'sealed scope is not automatically retried');
  await h.get('inspect').onclick(); const queried = h.requests.at(-1); assert.equal(queried.body.type, 'delivery'); assert.equal(queried.body.key, original.key);
  assert.equal(h.storage.get('xh-mobile-pending'), persisted); assert.equal(h.requests.some(r => r.route === 'logout' || r.body.type === 'command'), false);
}));

test('unauthorized refresh displays pairing without clearing unrelated storage or performing logout', () => withHarness({ fetchPlan: request => request.body.type === 'status' ? failure('unauthorized') : undefined, stored: { 'fixture-unrelated-note': 'keep-existing-state' } }, async h => {
  h.hooks.seed(status()); h.hooks.interaction(questionTicket()); const form = h.get('interactions').querySelector('form'); form.querySelector('select').value = 'Test workspace';
  await h.hooks.refresh(true); assert.equal(h.get('pair').hidden, false); assert.equal(h.get('control').hidden, true); assert.equal(h.hooks.state().interactionCount, 0);
  await form.onsubmit({ preventDefault() {} }); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.type, 'status');
  assert.equal(h.storage.get('fixture-unrelated-note'), 'keep-existing-state'); assert.equal(typeof h.get('reconnect').onclick, 'function');
}));

test('fresh unauthenticated landing describes missing pairing as well as expired authorization', () => withHarness({ fetchPlan: request => request.body.type === 'status' ? failure('unauthorized') : undefined }, async h => {
  await h.hooks.refresh(); assert.equal(h.hooks.state().active, false); assert.equal(h.hooks.state().pending, undefined);
  assert.equal(h.get('pair').hidden, false); assert.equal(h.get('control').hidden, true);
  assert.ok(h.get('connection').textContent.startsWith('尚未配对或设备授权已失效'));
  assert.ok(h.get('error').textContent.includes('在电脑生成配对二维码')); assert.ok(h.get('error').textContent.includes('已配对可先尝试重新连接'));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.type, 'status'); assert.equal(h.storage.has('xh-mobile-pending'), false);
}));

test('post-admission unauthorized seals mutations while retaining request identity for later inspection', () => withHarness({ fetchPlan: request => request.body.type === 'command' ? failure('unauthorized') : undefined }, async h => {
  h.hooks.seed(status()); h.hooks.interaction(questionTicket()); const form = h.get('interactions').querySelector('form'); form.querySelector('select').value = 'Test workspace';
  await h.hooks.command({ type: 'cancel' }); const pending = clone(h.hooks.state().pending);
  assert.equal(pending.request_id, h.requests[0].body.request_id); assert.equal(pending.unknown, true); assert.equal(h.hooks.state().status, undefined);
  await form.onsubmit({ preventDefault() {} }); await h.hooks.command({ type: 'cancel' }); assert.equal(h.requests.length, 1);
  assert.deepEqual(clone(h.hooks.state().pending), pending); assert.equal(h.get('pair').hidden, false);
}));

test('explicit authoritative reconnect re-enables sealed controls without replaying unknown operations', () => {
  let unauthorized = true;
  return withHarness({ fetchPlan: request => request.body.type === 'status' && unauthorized ? failure('unauthorized') : undefined }, async h => {
    h.hooks.seed(status()); await h.hooks.refresh(true); assert.equal(h.get('prompt').disabled, true);
    unauthorized = false; await h.get('reconnect').onclick(); assert.equal(h.hooks.state().active, true); assert.equal(h.get('pair').hidden, true);
    assert.equal(h.get('prompt').disabled, false); assert.equal(h.get('sessions').disabled, false); assert.equal(h.requests.some(r => r.body.type === 'command'), false);
  });
});

test('approval acceptance is explicit once-only; declining confirmation sends nothing', () => withHarness({ confirm: () => false }, async h => {
  h.hooks.seed(status()); const calls = []; h.hooks.setApi(async (_route, body) => { calls.push(body); return body.type === 'command' ? receipt('completed', { accepted: true }) : { generation: 1, interactions: [] }; });
  h.hooks.interaction({ token: 'fixture-ticket', expires_at_ms: Date.now() + 10000, interaction: { frame: { method: 'approval/requested', payload: { sessionId: 'session-a', toolName: 'fixture-tool', reason: 'fixture operation' } } } });
  const buttons = h.get('interactions').querySelectorAll('button'); await buttons[0].onclick(); assert.equal(calls.length, 0);
  await buttons[1].onclick(); const request = calls.find(c => c.type === 'command'); assert.equal(request.command.answer.allowed, false); assert.equal(request.command.ticket, 'fixture-ticket');
}));

test('a newer draft typed while awaiting the original receipt is not erased', () => {
  const reply = deferred();
  return withHarness({ fetchPlan: request => request.body.type === 'command' ? reply.promise : undefined }, async h => {
    h.hooks.seed(status()); h.get('prompt').value = 'original submitted text'; const sending = h.submit('prompt-form'); await pause();
    assert.equal(h.hooks.state().working, true); h.get('prompt').value = 'new unsent draft';
    reply.resolve(success(receipt())); await sending; assert.equal(h.get('prompt').value, 'new unsent draft'); assert.equal(h.requests.filter(r => r.body.type === 'command').length, 1);
  });
});

test('an unchanged submitted draft is cleared only on a proved successful receipt', () => withHarness(async h => {
  h.hooks.seed(status()); h.get('prompt').value = 'original submitted text'; await h.submit('prompt-form'); assert.equal(h.get('prompt').value, '');
  assert.equal(h.requests[0].body.command.content[0].text, 'original submitted text');
}));

test('pairing nonce is accepted only from fragment, then scrubbed; credentials never enter JS storage or request URL', async () => {
  await withHarness({ href: 'https://relay.fixture/#host=fixture-host&code=fixture-fragment-nonce' }, async h => {
    assert.equal(h.get('pair-form').elements.host.value, 'fixture-host'); assert.equal(h.get('pair-form').elements.code.value, 'fixture-fragment-nonce'); assert.equal(h.location.hash, '');
    await h.submit('pair-form'); assert.equal(h.get('pair-form').elements.code.value, '');
    const pair = h.requests.find(r => r.route === 'pair'); assert.equal(pair.body.code, 'fixture-fragment-nonce');
    for (const request of h.requests) { assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.redirect, 'error'); assert.equal(new URL(request.url).search, ''); assert.equal(request.url.includes('fixture-fragment-nonce'), false); assert.equal('secret' in request.body, false); }
    assert.equal([...h.storage.values()].join().includes('fixture-fragment-nonce'), false);
  });
  await withHarness({ href: 'https://relay.fixture/?host=fixture-host&code=not-a-fragment-nonce' }, h => { assert.equal(h.get('pair-form').elements.code.value, ''); assert.equal(h.get('pair-form').elements.host.value, ''); });
});

test('restored pending metadata is explicitly unknown and blocks creating a second operation', () => withHarness({ stored: { 'xh-mobile-pending': JSON.stringify({ request_id: 'original-restore', generation: 1, kind: 'prompt' }) } }, async h => {
  h.hooks.seed(status()); assert.equal(h.hooks.state().pending.unknown, true); assert.equal(h.get('unknown').hidden, false);
  await h.hooks.command({ type: 'cancel' }); assert.equal(h.requests.length, 0);
}));

test('pending review is outside the chat scroller and uses a bounded top-layer dialog', () => {
  const conversation = html.slice(html.indexOf('id="conversation"'), html.indexOf('<dialog'));
  assert.doesNotMatch(conversation, /id="interactions"/);
  assert.match(html, /<button id="review-interactions" type="button" hidden>/);
  assert.match(html, /<dialog id="interaction-dialog" aria-labelledby="interaction-heading">/);
  assert.match(css, /#interaction-dialog\s*\{[^}]*max-height:\s*calc\(var\(--app-height\) - 24px\)/s);
  assert.match(css, /#interactions\s*\{[^}]*overflow:\s*auto/s);
});

test('review opens pending decisions explicitly without granting, moving history, or changing the draft', () => withHarness(async h => {
  h.hooks.seed(status()); h.get('conversation').scrollTop = 900; h.get('prompt').value = 'unsent draft';
  h.hooks.interaction(questionTicket());
  assert.equal(h.get('review-interactions').hidden, false);
  assert.equal(h.get('review-interactions').textContent, 'Review (1)');
  assert.equal(h.get('interactions').parentElement, h.get('interaction-dialog'));
  assert.notEqual(h.get('interaction-dialog').open, true);
  h.get('review-interactions').onclick(); assert.equal(h.get('interaction-dialog').open, true);
  assert.equal(h.requests.length, 0); assert.equal(h.get('conversation').scrollTop, 900); assert.equal(h.get('prompt').value, 'unsent draft');
  h.get('close-interactions').onclick(); assert.equal(h.get('interaction-dialog').open, false);
  assert.equal(h.hooks.state().interactionCount, 1); assert.equal(h.requests.length, 0);
}));

test('resolved snapshot closes review and hides its count without submitting a response', () => withHarness(async h => {
  h.hooks.seed(status()); h.hooks.interaction(questionTicket()); h.get('review-interactions').onclick();
  h.hooks.setApi(async () => ({generation: 1, interactions: []}));
  await h.hooks.snapshot();
  assert.equal(h.get('interaction-dialog').open, false); assert.equal(h.get('review-interactions').hidden, true);
  assert.equal(h.hooks.state().interactionCount, 0); assert.equal(h.requests.length, 0);
}));

test('scope sealing closes an open review and cannot restore an actionable stale form', () => withHarness({fetchPlan:r=>r.body.type==='status'?failure('unauthorized'):undefined}, async h => {
  h.hooks.seed(status()); h.hooks.interaction(questionTicket()); h.get('review-interactions').onclick();
  await h.hooks.refresh(true);
  assert.equal(h.get('interaction-dialog').open, false); assert.equal(h.get('review-interactions').hidden, true);
  assert.equal(h.hooks.state().interactionCount, 0); assert.equal(h.requests.some(r=>r.body.type==='command'), false);
}));

test('expired review handle is removed locally before any command', () => withHarness(async h => {
  h.hooks.seed(status()); const t=questionTicket();h.hooks.interaction(t);h.get('review-interactions').onclick();
  const form=h.get('interactions').querySelector('form');form.querySelector('select').value='Test workspace';
  h.advanceTime(700000); await form.onsubmit({preventDefault(){}});
  assert.equal(h.get('interaction-dialog').open, false);assert.equal(h.get('review-interactions').hidden,true);assert.equal(h.requests.length,0);
}));

test('one confirmed approval keeps its original ticket and cannot be sent twice', () => withHarness(async h => {
  h.hooks.seed(status());const calls=[];
  h.hooks.setApi(async (_route,body)=>{calls.push(body);return body.type==='command'?receipt('completed',{accepted:true}):{generation:1,interactions:[]};});
  h.hooks.interaction({token:'fixture-approval',expires_at_ms:Date.now()+10000,interaction:{frame:{method:'approval/requested',payload:{sessionId:'session-a',toolName:'write',reason:'Explicit approval required'}}}});
  h.get('review-interactions').onclick();const allow=h.get('interactions').querySelectorAll('button')[0];
  await allow.onclick();await allow.onclick();
  const writes=calls.filter(c=>c.type==='command');assert.equal(writes.length,1);
  assert.equal(writes[0].command.type,'answer_interaction');assert.equal(writes[0].command.ticket,'fixture-approval');assert.equal(writes[0].command.answer.allowed,true);
  assert.equal(h.get('interaction-dialog').open,false);assert.equal(h.get('review-interactions').hidden,true);
}));

let failed = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack ?? error}`); }
}
console.log(`Mobile UI VM contracts: ${cases.length - failed} passed, ${failed} failed. No native browser/account/model acceptance claimed.`);
if (failed) process.exitCode = 1;
