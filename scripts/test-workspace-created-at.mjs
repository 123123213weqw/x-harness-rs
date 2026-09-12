import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {patchWorkspaceCreatedAt} from './patch-workspace-created-at.mjs';
const root=new URL('..',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const WORKSPACE='@deepseek-ai/dsh-client-ui-workspace',RUNTIME='@deepseek-ai/dsh-client-runtime',T='\t';

// The product-owned helper must accept the Host's decimal millisecond string and
// still tolerate ISO-8601, because the shipped wire format is milliseconds.
const helper=read('ui/overrides/workspace-created-at.js');
const xhEpochMs=new Function(`${helper}; return xhEpochMs;`)();
const ms=1789192051593;
assert.equal(xhEpochMs(String(ms)),ms,'decimal millisecond string must parse');
assert.equal(xhEpochMs(ms),ms,'numeric milliseconds must pass through');
assert.equal(xhEpochMs(`  ${ms}  `),ms,'surrounding whitespace is tolerated');
assert.equal(xhEpochMs('2026-09-12T04:42:19.123Z'),Date.parse('2026-09-12T04:42:19.123Z'),'ISO-8601 must still parse');
for(const bad of ['',undefined,null,'not-a-date','1e3',{},'99999999999999999999'])
  assert.ok(Number.isNaN(xhEpochMs(bad)),`${JSON.stringify(bad)} must not parse as a timestamp`);
assert.equal(xhEpochMs('0'),0);
// The ISO branch deliberately inherits `Date.parse` leniency (it accepts loose
// date-like text such as "12.5"); only the decimal-millisecond branch is strict.
assert.equal(xhEpochMs('12.5'),Date.parse('12.5'),'ISO branch delegates to Date.parse');
// A last sanity check on the exact defect: the old expression yields NaN.
assert.ok(Number.isNaN(Date.parse(String(ms))),'regression guard: raw Date.parse of the wire value is NaN');

// Fail-closed anchors, module targeting, and idempotency on synthetic fixtures.
const anchor=T+T+'var module = { exports: {} };';
const fixture=(id,body)=>Buffer.from(`window.__ModuleLoader__.load({\n\tid: "${id}",\n\tfactory: (require) => {\n${anchor}\n${body}\n\t}\n});\n`);
const workspaceFixture=fixture(WORKSPACE,[
  `${T.repeat(2)}groups.push(buildGroup(w, w, w.path, Date.parse(workspace.createdAt), w.title, m, "account"));`,
  `${T.repeat(3)}const d = new Date(createdAt);`,
  `${T.repeat(5)}(0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(6)}className: Rows_module_css_default.hoverTime,`,
  `${T.repeat(6)}children: createdLabel(createdAt, t)`,
  `${T.repeat(5)}})`
].join('\n'));
const runtimeFixture=fixture(RUNTIME,`${T.repeat(4)}latest = Date.parse(workspace.createdAt);`);
assert.throws(()=>patchWorkspaceCreatedAt(WORKSPACE,fixture(WORKSPACE,'// nothing patched here')),/anchor changed/);
const other=patchWorkspaceCreatedAt('@deepseek-ai/dsh-client-ui-settings',workspaceFixture);
assert.deepEqual(other,workspaceFixture,'unrelated modules stay byte-identical');
const patchedWorkspace=patchWorkspaceCreatedAt(WORKSPACE,workspaceFixture);
assert.deepEqual(patchWorkspaceCreatedAt(WORKSPACE,patchedWorkspace),patchedWorkspace,'patching is idempotent');
const workspaceText=patchedWorkspace.toString();
assert.equal(workspaceText.includes('Date.parse(workspace.createdAt)'),false,'ordering key uses the helper');
assert.ok(workspaceText.includes('new Date(xhEpochMs(createdAt))'),'hover label parses through the helper');
assert.ok(workspaceText.includes('if (!Number.isFinite(d.getTime())) return void 0;'),'unparsable value yields no label');
assert.ok(workspaceText.includes('createdLabel(createdAt, t) === void 0 ? null : '),'unparsable value renders no time row');
new Script(workspaceText);
const runtimeText=patchWorkspaceCreatedAt(RUNTIME,runtimeFixture).toString();
assert.ok(runtimeText.includes('latest = xhEpochMs(workspace.createdAt)'),'recency fallback parses through the helper');
assert.equal(runtimeText.includes('Date.parse(workspace.createdAt)'),false);
new Script(runtimeText);

// The shipped bundle must already be refreshed, and stay syntactically valid.
for(const id of [WORKSPACE,RUNTIME]){
  const bytes=readFileSync(new URL(`ui/dist/plugins/${id}/client.js`,root));
  assert.deepEqual(patchWorkspaceCreatedAt(id,bytes),bytes,'shipped UI must be refreshed and patch idempotent');
  const text=bytes.toString();
  assert.ok(text.includes('function xhEpochMs(value)'),`${id} must carry the helper`);
  assert.equal(text.includes('Date.parse(workspace.createdAt)'),false,`${id} must not parse the wire value as a date`);
  new Script(text);
}
const graph=JSON.parse(read('ui/dist/client-graph.json'));
for(const id of [WORKSPACE,RUNTIME]){
  const bytes=readFileSync(new URL(`ui/dist/plugins/${id}/client.js`,root));
  const entry=graph.entries.find(candidate=>candidate.id===id);
  assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16),`${id} revision must match shipped bytes`);
  assert.ok(read('ui/dist/index.html').includes(entry.url),`${id} boot graph must carry the refreshed revision`);
}
console.log('Workspace timestamp patch: millisecond+ISO parsing, fail-closed anchors, refreshed graph/hash passed');
