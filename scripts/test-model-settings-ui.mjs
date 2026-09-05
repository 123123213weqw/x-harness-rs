// Exercise the actual bundled schema implementation against the Rust schema.
// No reimplementation of Schemastery and no generated UI bundle edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rust = fs.readFileSync(path.join(root, 'crates/xharness-host/src/model_settings.rs'), 'utf8');
const literal = rust.match(/pub fn model_settings_schema\(\) -> Value \{\s*json!\(([\s\S]*?)\)\s*\}/)?.[1];
assert.ok(literal, 'Rust must expose an inspectable serialized schema');
const serialized = JSON.parse(literal);
const bundle = fs.readFileSync(path.join(root, 'ui/dist/plugins/@deepseek-ai/dsh-client-ui-settings/client.js'), 'utf8');
let factory;
const context = vm.createContext({window:{__ModuleLoader__:{load(module){factory=module.factory;}}}, console});
vm.runInContext(bundle.replace('exports.apply = apply;', 'exports.testSchema = new SettingsSchemaService({}); exports.apply = apply;'), context);
const api = factory(name => {
  if(name === '@deepseek-ai/cordis') return {Service:class {}};
  if(name === '@deepseek-ai/dsh-client-runtime/client') return {};
  throw new Error(`Unexpected bundle dependency ${name}`);
});
const schema = api.testSchema;
const live = schema.rehydrate(serialized);
const protocols = schema.nodeAtPath(live, ['providers','test-route','api']);
assert.equal(protocols.type,'union');
assert.deepEqual(Array.from(protocols.list, node=>node.value), ['openai-completions','openai-responses']);
const profile = schema.nodeAtPath(live,['providers','test-route']);
assert.ok(profile,'custom provider path must resolve');
assert.equal(schema.validate(profile,{baseURL:'http://127.0.0.1:8080/v1',api:'openai-completions',models:[{id:'coder',contextWindow:32768,maxTokens:4096}]}),undefined);
assert.equal(schema.validate(live,{providers:{}}),undefined);
console.log('Bundled settings schema accepts new providers and exposes protocol choices.');
