import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { CdpPolicyBridge } from '../../plugins/browser-use/dist/cdp-policy-bridge.js';

// Public transport stubs exercise the compiled bridge's real decision branches.
// They do not instantiate Chromium and do not replace the real browser/legacy gates.
class Session extends EventEmitter {
  commands = [];
  injectedError;
  async send(method, params = {}) {
    this.commands.push({ method, params });
    if (method === 'Target.attachToTarget') return { sessionId: 'nested-session' };
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'target', type: 'page' }] };
    if (method === 'Target.sendMessageToTarget') {
      const message = JSON.parse(params.message);
      const error = this.injectedError?.method === message.method ? { message: this.injectedError.message } : undefined;
      queueMicrotask(() => this.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify({ id: message.id, ...(error ? { error } : { result: {} }) }) }));
    }
    return {};
  }
  async detach() {}
  pause(url, requestId = 'request') {
    this.emit('Target.receivedMessageFromTarget', { sessionId: 'nested-session', message: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId, request: { url } } }) });
  }
  sent(method) {
    return this.commands.filter(command => command.method === 'Target.sendMessageToTarget').map(command => JSON.parse(command.params.message)).filter(message => message.method === method);
  }
}
class Browser extends EventEmitter {
  session = new Session();
  closes = 0;
  async newBrowserCDPSession() { return this.session; }
  async close() { this.closes++; this.emit('disconnected'); }
}
async function setup(t) {
  const browser = new Browser();
  const bridge = await CdpPolicyBridge.create(browser, ['https://allowed.test']);
  t.after(() => bridge.close());
  browser.session.emit('Target.attachedToTarget', { sessionId: 'startup-guard', targetInfo: { targetId: 'target', type: 'page' } });
  await bridge.ensureTarget('target');
  return { browser, bridge, session: browser.session };
}
async function settle() { await immediate(); await immediate(); }
test('only an exact expired allowed continuation is tolerated, with no replay', async t => {
  const { browser, bridge, session } = await setup(t);
  session.injectedError = { method: 'Fetch.continueRequest', message: 'Invalid InterceptionId.' };
  session.pause('https://allowed.test/unfinished'); await settle();
  assert.equal(browser.closes, 0); assert.equal(bridge.failure, undefined);
  assert.equal(session.sent('Fetch.continueRequest').length, 1, 'Expired native IDs must never be retried');
  assert.deepEqual(bridge.drainDenials('target'), []);
  session.injectedError = undefined;
  session.pause('https://allowed.test/later', 'later'); await settle();
  await bridge.ensureTarget('target');
  assert.equal(browser.closes, 0); assert.equal(session.sent('Fetch.continueRequest').length, 2);
});
for (const [name, url, method, message] of [
  ['an exact expired denial still fails closed', 'https://forbidden.test/no', 'Fetch.failRequest', 'Invalid InterceptionId.'],
  ['an unknown allowed continuation error fails closed', 'https://allowed.test/yes', 'Fetch.continueRequest', 'Unknown native failure'],
  ['a missing-period near match fails closed', 'https://allowed.test/yes', 'Fetch.continueRequest', 'Invalid InterceptionId'],
  ['a trailing-space near match fails closed', 'https://allowed.test/yes', 'Fetch.continueRequest', 'Invalid InterceptionId. '],
  ['a different-case near match fails closed', 'https://allowed.test/yes', 'Fetch.continueRequest', 'invalid InterceptionId.'],
]) {
  test(name, async t => {
    const { browser, bridge, session } = await setup(t);
    session.injectedError = { method, message };
    session.pause(url); await settle();
    assert.equal(session.sent(method).length, 1);
    assert.equal(browser.closes, 1, 'Failed enforcement must close the dedicated browser');
    assert.match(bridge.failure, new RegExp(method.replace('.', '\\.')));
    await assert.rejects(() => bridge.ensureTarget('target'));
  });
}
test('a successful native denial is recorded only after acknowledgment', async t => {
  const { browser, bridge, session } = await setup(t);
  session.pause('https://forbidden.test/no?secret=redacted');
  assert.deepEqual(bridge.drainDenials('target'), []);
  await settle();
  assert.equal(browser.closes, 0);
  assert.deepEqual(bridge.drainDenials('target'), [{ url: 'https://forbidden.test/no' }]);
});
