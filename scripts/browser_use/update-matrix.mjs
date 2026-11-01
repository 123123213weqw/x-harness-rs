#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCurrentProvenance } from './provenance.mjs';
import { validateReports, LEGACY_SOURCE_SHA256, REFERENCE_COMMIT } from './evidence-validator.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const matrixPath = resolve(repository, 'docs/evidence/browser-use-parity-matrix-20261022.json');
const paths = {
  engine: resolve(process.argv[2] ?? resolve(repository, 'docs/evidence/browser-use-parity-engine-20261022.json')),
  stdio: resolve(process.argv[3] ?? resolve(repository, 'docs/evidence/browser-use-parity-stdio-20261022.json')),
  legacy: resolve(process.argv[4] ?? resolve(repository, 'docs/evidence/browser-use-parity-legacy-20261022.json')),
};
const reports = {}, integrity = { engine: [], stdio: [], legacy: [] };
for (const kind of ['engine', 'stdio', 'legacy']) {
  try {
    reports[kind] = JSON.parse(await readFile(paths[kind], 'utf8'));
    await verifyCurrentProvenance(repository, reports[kind].provenance);
  } catch (error) {
    integrity[kind].push(`Content/evidence validation failed: ${error instanceof Error ? error.message.slice(0, 3000) : String(error)}`);
  }
}
const verdict = validateReports(reports.engine, reports.stdio, reports.legacy, integrity);
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
if (matrix.reference?.commit !== REFERENCE_COMMIT) {
  verdict.gates.engine.passed = false; verdict.gates.engine.validEvidence = false;
  verdict.gates.engine.errors.push('Matrix reference revision does not match the audited revision');
  verdict.passed = false;
}
const ids = new Map((Array.isArray(reports.engine?.cases) ? reports.engine.cases : []).filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
for (const row of matrix.matrix) {
  if (row.capability === 'Unchanged legacy Browser Use compatibility contracts') {
    row.expectedSourceSha256 = LEGACY_SOURCE_SHA256;
    row.status = verdict.gates.legacy.passed ? 'passed-original-legacy-gate' : 'test-failed';
    row.evidence = relative(repository, paths.legacy);
  } else if (row.capability === 'stdio MCP integration and image blocks') {
    row.cases = Array.isArray(reports.stdio?.cases) ? reports.stdio.cases.map(item => item?.id) : [];
    row.status = !verdict.gates.stdio.validEvidence ? 'invalid-evidence' : verdict.gates.stdio.passed ? 'passed-MCP-only-Host-separate-gate' : 'test-failed';
    row.evidence = relative(repository, paths.stdio);
  } else if (row.capability === 'Uncertain post-dispatch effects are never automatically replayed') {
    row.observedUncertainReceipt = ids.get('dialogs')?.facts?.initialReceipt?.outcome === 'possibly-applied';
    // Keep partial coverage: fixture uncertainty is not Host transport-failure proof.
  } else if (row.cases?.length && !['not-implemented-in-this-suite', 'not-tested'].includes(row.status)) {
    const cases = row.cases.map(id => ids.get(id));
    row.status = !verdict.gates.engine.validEvidence ? 'invalid-evidence'
      : cases.some(item => item?.status === 'failed') ? 'test-failed'
      : cases.every(item => item?.status === 'passed') ? 'passed-covered-cases' : 'missing-evidence';
    row.evidence = relative(repository, paths.engine);
  }
}
matrix.updatedFromEvidenceAt = new Date().toISOString();
matrix.acceptanceGates = verdict;
matrix.overall = verdict.passed ? 'covered-gates-passed-full-ZCode-parity-still-incomplete' : 'acceptance-gates-not-green';
await writeFile(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
console.log(JSON.stringify({ passed: verdict.passed, gates: verdict.gates, overall: matrix.overall }));
process.exitCode = verdict.passed ? 0 : 1;
