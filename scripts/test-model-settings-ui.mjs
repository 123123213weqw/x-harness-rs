// Exercise the actual bundled schema implementation against the Rust schema.
// No reimplementation of Schemastery and no generated UI bundle edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyArtifact } from './fixtures/shipped-source-values.mjs';
import { exposeModuleUnit } from './fixtures/module-unit-scope.mjs';
import { loadOwnedCordisRuntime, loadOwnedSnapshotRuntime } from './fixtures/owned-view-cordis-runtime.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rust = fs.readFileSync(path.join(root, 'crates/xharness-host/src/model_settings.rs'), 'utf8');
const literal = rust.match(/pub fn model_settings_schema\(\) -> Value \{\s*json!\(([\s\S]*?)\)\s*\}/)?.[1];
assert.ok(literal, 'Rust must expose an inspectable serialized schema');
const serialized = JSON.parse(literal);
const id = '@xharness/dsh-client-ui-settings';
const implementation = process.env.UI_TEST_IMPL;
assert.ok(implementation === undefined || ['source', 'native', 'frozen', 'legacy'].includes(implementation), 'known model-settings implementation');
const implementations = implementation === undefined ? ['frozen', 'source'] : [implementation === 'legacy' ? 'frozen' : implementation === 'native' ? 'source' : implementation];
const Core = loadOwnedCordisRuntime(), snapshot = loadOwnedSnapshotRuntime();
for (const mode of implementations) {
const bundle = mode === 'source' ? verifyArtifact(id) : fs.readFileSync(path.join(root, 'ui/reference/master-a613970/plugins', id, 'client.js'), 'utf8');
let factory;
const context = vm.createContext({window:{__ModuleLoader__:{load(module){factory=module.factory;}}}, console, Error, TypeError, Promise, queueMicrotask, setTimeout, clearTimeout});
// The acceptance assignment is inside schema.js's actual lexical closure;
// neither its imports nor the production public export table is changed.
vm.runInContext(exposeModuleUnit(bundle, 'settings', 'schema', 'SettingsSchemaService'), context);
assert.equal(typeof factory, 'function', 'actual ModuleLoader factory');
const api = factory(name => {
  if(name === '@xharness/cordis') return Core;
  if(name === '@xharness/dsh-client-runtime/client') return snapshot;
  throw new Error(`Unexpected bundle dependency ${name}`);
});
const owner = new Core.Context();
try {
new api.SettingsSchemaService(owner);
// Cordis returns its dynamically traced receiver, not the constructor object.
// Exercise consumers through that real service getter as in production.
const schema = owner.get('settingsSchema');
assert.ok(schema instanceof Core.Service, 'real Cordis Service, not a fake inheritance fixture');
assert.ok(schema instanceof api.SettingsSchemaService, 'real named SettingsSchemaService registration');
const live = schema.rehydrate(serialized);
const protocols = schema.nodeAtPath(live, ['providers','test-route','api']);
assert.equal(protocols.type,'union');
assert.deepEqual(Array.from(protocols.list, node=>node.value), ['openai-completions','openai-responses']);
const profile = schema.nodeAtPath(live,['providers','test-route']);
assert.ok(profile,'custom provider path must resolve');
assert.equal(schema.validate(profile,{baseURL:'http://127.0.0.1:8080/v1',api:'openai-completions',models:[{id:'coder',contextWindow:32768,maxTokens:4096}]}),undefined);
assert.equal(schema.validate(live,{providers:{}}),undefined);
assert.equal(typeof schema.validate(profile,{baseURL:'http://127.0.0.1:8080/v1',api:'unknown-protocol',models:[]}), 'string', 'real protocol union rejects unsupported wire values');
if (mode === 'source') {
  for (const invalid of [null, [], {uid:1,refs:{}}, {uid:1,refs:{1:{type:'object',meta:{},dict:{models:9}}}}]) {
    assert.throws(() => schema.rehydrate(invalid), undefined, 'unknown serialized input must not claim a live schema');
  }
}
console.log(mode+': bundled settings schema accepts new providers and exposes protocol choices; actual Cordis registration, invalid protocol and consumed schema boundary passed.');
} finally {
  await owner.fiber.dispose();
  assert.equal(owner.get('settingsSchema'), undefined, 'service removed with its true owning fiber');
}
}
