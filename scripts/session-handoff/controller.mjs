// Hash receipts are integrity evidence over an owner-authenticated transport,
// not credentials. The native peers own roots, locks, idle checks and epochs.
import assert from 'node:assert/strict';
export async function handoff(source, target, session, observe = async () => {}) {
  assert.match(session, /^[a-zA-Z0-9_-]{1,200}$/);
  const [from, to] = await Promise.all([source.call({operation:'describe'}), target.call({operation:'describe'})]);
  assert.notEqual(from.owner, to.owner);
  assert.deepEqual(from.workspace, to.workspace, 'sync and commit code before session handoff');
  const bundle = await source.call({operation:'freeze', session, destination:to});
  await observe('frozen');
  const prepared = await target.call({operation:'prepare', bundle});
  await observe('prepared');
  const released = await source.call({operation:'release', prepared});
  await observe('released');
  const active = await target.call({operation:'activate', released});
  assert.deepEqual(active, prepared);
  await observe('active');
  return {session:active.session, epoch:active.epoch, transfer:active.transfer, workspace:active.workspace, state:'active', historical_receipt:true};
}
