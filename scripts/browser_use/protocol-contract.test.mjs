import test from 'node:test';
import assert from 'node:assert/strict';
import { inputSchema, parseCommand } from '../../plugins/browser-use/dist/protocol.js';

// Independent, dependency-free JSON Schema subset evaluator. It deliberately does
// not import the parser's validator, so advertised-schema drift remains observable.
function valid(schema, value, root = inputSchema) {
  if (schema.$ref) {
    assert.ok(schema.$ref.startsWith('#/$defs/'), 'Only local definitions are used');
    const definition = root.$defs?.[schema.$ref.slice(8)];
    assert.ok(definition, 'Every advertised reference resolves');
    return valid(definition, value, root);
  }
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (schema.type === 'object' && !object) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === 'string' && schema.maxLength !== undefined && [...value].length > schema.maxLength) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (object) {
    if (schema.required?.some(name => !Object.hasOwn(value, name))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(name => !Object.hasOwn(schema.properties ?? {}, name))) return false;
    for (const [name, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, name) && !valid(child, value[name], root)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => valid(schema.items, item, root))) return false;
  }
  if (schema.oneOf && schema.oneOf.filter(branch => valid(branch, value, root)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(branch => valid(branch, value, root))) return false;
  if (schema.not && valid(schema.not, value, root)) return false;
  return true;
}
function accepts(value) {
  assert.equal(valid(inputSchema, value), true, 'Advertised schema accepts ' + JSON.stringify(value).slice(0, 250));
  assert.doesNotThrow(() => parseCommand(value));
}
function rejects(value, message) {
  assert.equal(valid(inputSchema, value), false, 'Advertised schema rejects ' + JSON.stringify(value).slice(0, 250));
  assert.throws(() => parseCommand(value), message);
}
const ref = { ref: 'r1', observationId: 'observation-1' };
const targets = [ref, { by: 'role', role: 'button' }, { by: 'role', role: 'button', name: 'Save', exact: true, frameId: 'frame-1' }, ...['text', 'label', 'placeholder', 'testId'].map(by => ({ by, value: 'Name', exact: false, frameId: 'frame-1' }))];
const canonical = [
  { action: 'tabs' }, { action: 'new' }, { action: 'new', url: 'https://example.test/' },
  { action: 'select', targetTabId: 'tab-2' }, { action: 'close', targetTabId: 'tab-2' },
  { action: 'navigate', url: 'https://example.test/', reuse: true },
  ...['back', 'forward', 'reload'].map(action => ({ action })),
  { action: 'observe' }, { action: 'observe', scope: 'main', nodeOffset: 2, textOffset: 20, frameOffset: 1, frameId: 'frame-1' },
  { action: 'press', key: 'Enter' },
  { action: 'drag', target: ref, destination: { by: 'label', value: 'Destination' } },
  { action: 'scroll', x: -30, y: 500 }, { action: 'scroll', y: 500, observationId: 'observation-1' },
  { action: 'wait' }, { action: 'wait', milliseconds: 10000 }, { action: 'wait', loadState: 'domcontentloaded' },
  { action: 'screenshot', fullPage: true },
  ...['click', 'move', 'down', 'up'].map(operation => ({ action: 'mouse', screenshotId: 'shot-1', operation, x: 3, y: 40, button: 'left' })),
  { action: 'dialog', accept: true, text: 'Confirm' }, { action: 'download', downloadId: 'download-1' },
  { action: 'console', after: 0 }, { action: 'network', after: Number.MAX_SAFE_INTEGER },
];
for (const target of targets) canonical.push(
  { action: 'click', target, button: 'middle', clickCount: 2 },
  { action: 'fill', target, text: 'replacement' }, { action: 'type', target, text: 'append' },
  { action: 'press', target, key: 'ControlOrMeta+A' }, { action: 'hover', target },
  { action: 'selectOption', target, values: ['option'] }, { action: 'check', target, checked: false },
  { action: 'scroll', target, y: 500 }, { action: 'wait', target, state: 'attached' }, { action: 'upload', target, files: ['staged.txt'] },
);
const legacy = [
  { action: 'select', frame_id: 'observation-1', ref: 'r1', value: 'option' },
  { action: 'observe', scope: 'dialog', node_offset: 1, text_offset: 3500 },
  ...['click', 'hover'].map(action => ({ action, frame_id: 'observation-1', ref: 'r1' })),
  ...['fill', 'type'].map(action => ({ action, frame_id: 'observation-1', ref: 'r1', text: 'value' })),
  { action: 'press', frame_id: 'observation-1', ref: 'r1', key: 'Enter' },
  { action: 'scroll', frame_id: 'observation-1', delta_y: 500 },
  { action: 'scroll', frame_id: 'observation-1', ref: 'r1', delta_y: 500, x: 20 },
  { action: 'scroll', frame_id: 'observation-1', ref: 'r1', y: -200 },
];
test('advertised action/target schema accepts every canonical and documented legacy form', () => {
  for (const sample of [...canonical, ...legacy]) {
    accepts(sample); accepts({ ...sample, tabId: 'tab-1' });
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), 'utf8');
  console.log(JSON.stringify({ schema: 'browser-action-contract', schemaBytes, canonicalForms: canonical.length, legacyForms: legacy.length }));
  assert.ok(schemaBytes <= 32768, 'MCP tool schema fits its 32KiB budget');
  assert.equal(inputSchema.type, 'object');
  assert.ok(inputSchema.properties.action.enum.includes('fill'));
  assert.equal(inputSchema.properties.script, undefined);
});
test('real A/B malformed calls have field paths and canonical repairs, with no value echo', () => {
  rejects({ action: 'fill', target: ref, value: 'SENSITIVE_SENTINEL' }, /arguments\.(text|value).*Use.*text/s);
  rejects({ action: 'click', target: { ref: 'r1' } }, /target\.observationId.*required/);
  rejects({ action: 'click', target: { ref: 'r1', observationId: 'observation-1', frameId: 'frame-1' } }, /target\.frameId.*not supported/);
  rejects({ action: 'observe', observationId: 'observation-1' }, /arguments\.observationId.*not supported/);
  rejects({ action: 'click', target: { role: 'button', name: 'Save' } }, /target\.by.*required/);
  try { parseCommand({ action: 'fill', target: ref, value: 'SENSITIVE_SENTINEL' }); } catch (error) { assert.ok(!error.message.includes('SENSITIVE_SENTINEL')); }
});
test('mutually exclusive targets, action fields, aliases and wait modes never silently guess', () => {
  const invalid = [
    { action: 'click' }, { action: 'fill', target: ref },
    { action: 'click', target: { ref: 'r1', observationId: 'observation-1', by: 'text', value: 'Save' } },
    { action: 'click', target: { by: 'text' } }, { action: 'click', target: { by: 'role', value: 'Save' } },
    { action: 'click', target: { by: 'role', role: 'not-a-role' } },
    { action: 'click', target: ref, frame_id: 'old', ref: 'r1' },
    { action: 'click', ref: 'r1' }, { action: 'click', frame_id: 'old' },
    { action: 'fill', target: ref, text: 'x', value: 'x' },
    { action: 'select', targetTabId: 'tab-2', frame_id: 'old', ref: 'r1', value: 'x' },
    { action: 'selectOption', target: ref, value: 'x' },
    { action: 'drag', target: ref }, { action: 'upload', target: ref },
    { action: 'observe', nodeOffset: 1, node_offset: 1 }, { action: 'observe', textOffset: 1, text_offset: 1 },
    { action: 'scroll', delta_y: 500 }, { action: 'scroll', frame_id: 'old', delta_y: 500, y: 500 },
    { action: 'scroll', target: ref, frame_id: 'old', y: 500 },
    { action: 'wait', state: 'visible' }, { action: 'wait', target: ref, milliseconds: 100 },
    { action: 'wait', loadState: 'load', milliseconds: 100 },
    { action: 'mouse', operation: 'click', x: 0, y: 0 },
    { action: 'dialog' }, { action: 'download' }, { action: 'navigate' }, { action: 'close' },
    { action: 'observe', scope: 'arbitrary css' }, { action: 'screenshot', target: ref },
    null, [], {}, { action: 'evaluate', expression: 'secret' },
    JSON.parse('{"action":"observe","__proto__":{}}'),
    { action: 'observe', constructor: 'unknown' }, { action: 'observe', toString: 'unknown' },
    JSON.parse('{"action":"click","target":{"ref":"r1","observationId":"obs","__proto__":{}}}'),
  ];
  for (const sample of invalid) rejects(sample);
});
test('numeric, identity, text and array limits match the parser including Unicode', () => {
  for (const [sample, okay] of [
    [{ action: 'tabs', tabId: 'x'.repeat(160) }, true], [{ action: 'tabs', tabId: 'x'.repeat(161) }, false],
    [{ action: 'fill', target: ref, text: '😀'.repeat(100000) }, true], [{ action: 'fill', target: ref, text: 'x'.repeat(100001) }, false],
    [{ action: 'dialog', accept: true, text: 'x'.repeat(4096) }, true], [{ action: 'dialog', accept: true, text: 'x'.repeat(4097) }, false],
    [{ action: 'press', key: 'x'.repeat(161) }, false],
    [{ action: 'click', target: { ref: 'x'.repeat(161), observationId: 'obs' } }, false],
    [{ action: 'click', target: { by: 'text', value: 'x', frameId: 'x'.repeat(161) } }, false],
    [{ action: 'wait', milliseconds: 10001 }, false], [{ action: 'wait', milliseconds: 0.5 }, false],
    [{ action: 'scroll', y: -100000 }, true], [{ action: 'scroll', y: -100001 }, false],
    [{ action: 'mouse', screenshotId: 'shot', operation: 'click', x: -1, y: 0 }, false],
    [{ action: 'observe', nodeOffset: 1e7, textOffset: 1e8, frameOffset: 1e5 }, true],
    [{ action: 'observe', node_offset: 1e7 + 1 }, false],
    [{ action: 'console', after: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ action: 'selectOption', target: ref, values: Array(100).fill('x') }, true],
    [{ action: 'selectOption', target: ref, values: Array(101).fill('x') }, false],
    [{ action: 'upload', target: ref, files: Array(21).fill('x') }, false],
  ]) (okay ? accepts : rejects)(sample);
});
test('aliases convert exactly once to canonical commands without changing their payload', () => {
  assert.deepEqual(parseCommand({ action: 'fill', frame_id: 'obs', ref: 'r', text: 'native' }), { command: { action: 'fill', target: { ref: 'r', observationId: 'obs' }, text: 'native' }, legacy: true });
  assert.deepEqual(parseCommand({ action: 'select', frame_id: 'obs', ref: 'r', value: 'option' }), { command: { action: 'selectOption', target: { ref: 'r', observationId: 'obs' }, values: ['option'] }, legacy: true });
  assert.deepEqual(parseCommand({ action: 'scroll', frame_id: 'obs', delta_y: 12 }).command, { action: 'scroll', y: 12, observationId: 'obs' });
  assert.deepEqual(parseCommand({ action: 'observe', node_offset: 3, text_offset: 4 }).command, { action: 'observe', nodeOffset: 3, textOffset: 4 });
});
test('schema and parser agree on unknown-field mutations of every valid action', () => {
  for (const sample of [...canonical, ...legacy]) rejects({ ...sample, unsupportedField: true });
});
