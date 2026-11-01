/** Pure evidence-contract validation. Does not launch a browser or trust green subsets. */
export const REFERENCE_COMMIT = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
export const LEGACY_SOURCE_SHA256 = '67b8d40ca5b0f7270e9083c3a4eac1159937ed76abb55b299c2aafe932c0e48e';
export const ENGINE_CASE_IDS = Object.freeze([
  'trusted', 'form', 'frames', 'ambiguous', 'overlay', 'delayed', 'scroll',
  'ref-replay', 'replaced', 'tabs', 'dialogs', 'screenshot', 'pointer-gesture',
  'raster-invalidated', 'raster-layout', 'upload', 'download', 'origin', 'logs',
  'bounded', 'bounded-small', 'bounded-cjk', 'cancel-fetch', 'navigation-ref',
]);
export const STDIO_CASE_IDS = Object.freeze([
  'initialize-and-schema', 'legacy-navigation-observation',
  'semantic-command-executes-trusted-input',
  'MCP-screenshot-is-real-image-block-not-text-base64',
  'invalid-command-is-rejected-without-browser-effect',
  'explicit-tab-create-and-close-through-MCP',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function casesGate(report, expected, schema, integrityErrors) {
  const errors = [...integrityErrors];
  if (!object(report) || report.schema !== schema) errors.push(`Expected schema ${schema}`);
  const cases = object(report) && Array.isArray(report.cases) ? report.cases : [];
  const ids = cases.map(item => object(item) ? item.id : undefined);
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string') { errors.push('Case has no string ID'); continue; }
    if (seen.has(id)) errors.push(`Duplicate case ID: ${id}`);
    seen.add(id);
    if (!expected.includes(id)) errors.push(`Unexpected case ID: ${id}`);
  }
  for (const id of expected) if (!seen.has(id)) errors.push(`Missing case ID: ${id}`);
  if (cases.length !== expected.length) errors.push(`Expected ${expected.length} cases, got ${cases.length}`);
  for (const item of cases) if (!object(item) || !['passed', 'failed'].includes(item.status)) errors.push(`Invalid status for case ${object(item) ? item.id : '<invalid>'}`);
  const passed = cases.filter(item => object(item) && item.status === 'passed').length;
  const failed = cases.filter(item => object(item) && item.status === 'failed').length;
  const totals = object(report) && object(report.totals) ? report.totals : {};
  if (totals.cases !== cases.length || totals.passed !== passed || totals.failed !== failed || passed + failed !== cases.length) errors.push('Declared totals do not match actual case statuses');
  const validEvidence = errors.length === 0;
  const failedIds = cases.filter(item => object(item) && item.status === 'failed').map(item => item.id);
  if (failedIds.length) errors.push(`Failed cases: ${failedIds.join(', ')}`);
  return { passed: validEvidence && failed === 0, validEvidence, errors, expectedCases: expected.length, actualCases: cases.length, totals: { cases: cases.length, passed, failed }, failedIds };
}
export function validateReports(engine, stdio, legacy, integrity = {}) {
  const engineGate = casesGate(engine, ENGINE_CASE_IDS, 'xharness.browser-use.acceptance.v1', integrity.engine ?? []);
  if (!object(engine) || engine.referenceCommit !== REFERENCE_COMMIT) {
    engineGate.errors.push('Reference commit does not match the audited ZCode revision');
    engineGate.passed = false; engineGate.validEvidence = false;
  }
  const stdioGate = casesGate(stdio, STDIO_CASE_IDS, 'xharness.browser-use.stdio-acceptance.v1', integrity.stdio ?? []);
  const legacyErrors = [...(integrity.legacy ?? [])];
  if (!object(legacy) || legacy.schema !== 'xharness.browser-use.legacy-acceptance.v1') legacyErrors.push('Invalid legacy evidence schema');
  if (!object(legacy) || legacy.source !== 'scripts/gui_bench/test_browser.mjs' || legacy.sourceSha256 !== LEGACY_SOURCE_SHA256) legacyErrors.push('Legacy acceptance source does not match the unchanged pinned test');
  if (!object(legacy) || legacy.checks !== 30) legacyErrors.push('Legacy gate requires exactly 30 completed contract checks');
  if (!object(legacy) || legacy.exitCode !== 0 || legacy.signal != null || legacy.status !== 'passed') legacyErrors.push('Legacy gate did not complete successfully');
  const legacyGate = { passed: legacyErrors.length === 0, validEvidence: legacyErrors.length === 0, errors: legacyErrors, expectedChecks: 30, actualChecks: object(legacy) ? legacy.checks : null };
  return { passed: engineGate.passed && stdioGate.passed && legacyGate.passed, gates: { engine: engineGate, stdio: stdioGate, legacy: legacyGate } };
}
