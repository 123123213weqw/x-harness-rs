// Native participants own plans and all filesystem authority. This coordinator
// only moves opaque receipts and verified hash-named objects over owner SSH.
import assert from 'node:assert/strict';
const equal = (a, b) => assert.deepEqual(a, b, 'native participant binding/base mismatch');
const phase = (s, id) => s.round?.id === id ? s.phase : s.phase === null && s.receipt?.round === id && s.receipt.phase === 'complete' ? 'complete' : undefined;
export async function synchronize(local, cloud, transfer, observe = async () => {}) {
  let [l, c] = await Promise.all([local.call({ operation: 'status' }), cloud.call({ operation: 'status' })]);
  assert.equal(l.role, 'local'); assert.equal(c.role, 'cloud'); equal(l.binding, c.binding);
  const recovered = l.round !== null;
  let round = l.round;
  if (!round) {
    assert.equal(c.round, null, 'peer has an unresolved round: do not bootstrap/reset'); equal(l.base, c.base);
    const peer = await cloud.call({ operation: 'snapshot' });
    round = await local.call({ operation: 'plan', peer });
    await observe('intent');
    if (!round) return { generation: l.base.generation, applied_files: 0, recovered: false, unchanged: true };
  }
  const id = round.id;
  assert.match(id, /^[0-9a-f]{64}$/);
  if (c.round) equal(c.round, round);
  else if (c.base.generation === round.base.generation) await cloud.call({ operation: 'begin', round });
  else assert.equal(phase(c, id), 'complete', 'unexpected peer base or archive');
  await observe('both_intents');
  [l, c] = await Promise.all([local.call({ operation: 'status' }), cloud.call({ operation: 'status' })]);
  if (!l.decision) {
    assert.ok(['pending', 'prepared'].includes(phase(l, id))); assert.ok(['pending', 'prepared'].includes(phase(c, id)));
    const localObjects = await local.call({ operation: 'materialize', id });
    const cloudObjects = await cloud.call({ operation: 'materialize', id });
    const localNeeded = await local.call({ operation: 'need_objects', id });
    const cloudNeeded = await cloud.call({ operation: 'need_objects', id });
    assert.ok(cloudNeeded.every(h => localObjects.includes(h))); assert.ok(localNeeded.every(h => cloudObjects.includes(h)));
    await transfer('local', cloudNeeded); await transfer('cloud', localNeeded);
    await observe('objects');
    if (phase(l, id) === 'pending') await local.call({ operation: 'stage', id });
    if (phase(c, id) === 'pending') await cloud.call({ operation: 'stage', id });
    await observe('staged');
    await local.call({ operation: 'prepare', id });
    const peer = await cloud.call({ operation: 'prepare', id });
    await observe('prepared');
    const decision = await local.call({ operation: 'decide', id, peer });
    await observe('decision');
    await cloud.call({ operation: 'accept_decision', id, decision });
  } else if (!c.decision) {
    await cloud.call({ operation: 'accept_decision', id, decision: l.decision });
  } else equal(l.decision, c.decision);
  await observe('both_decisions');
  [l, c] = await Promise.all([local.call({ operation: 'status' }), cloud.call({ operation: 'status' })]);
  // A released peer's durable Complete receipt is stronger than Applied. Do
  // not manufacture an Applied receipt by editing a serialized phase value.
  const ca = c.round ? await cloud.call({ operation: 'apply', id }) : c.receipt;
  await observe('cloud_applied');
  const la = await local.call({ operation: 'apply', id });
  await observe('both_applied');
  const cc = c.round ? await cloud.call({ operation: 'finalize', id, peer: la }) : c.receipt;
  await observe('cloud_base');
  const lc = await local.call({ operation: 'finalize', id, peer: ca });
  await observe('both_bases');
  const released = await cloud.call({ operation: 'release', id, peer: lc });
  await observe('cloud_released');
  await local.call({ operation: 'release', id, peer: released });
  await observe('both_released');
  assert.equal(cc.phase, 'complete');
  return { generation: lc.generation, applied_files: round.operations.length, recovered, common_base_sha256: lc.manifest, round: id };
}
