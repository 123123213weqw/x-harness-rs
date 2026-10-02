import assert from 'node:assert/strict'
import {test, after} from 'node:test'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve, relative} from 'node:path'
import vm from 'node:vm'
import {createHash} from 'node:crypto'
import {compileSourceModules,stripEmissionTrivia} from './build-source-modules.mjs'
const fixtures = []
after(() => {for (const root of fixtures) rmSync(root, {recursive: true, force: true})})
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'xh-source-builder-')); fixtures.push(root)
  mkdirSync(join(root, 'src/modules/test'), {recursive: true})
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'source-vendors.json'), JSON.stringify({schemaVersion:1,packages:{zod:{version:'4.4.3',license:'MIT'}}}))
  writeFileSync(join(root, 'tsconfig.sources.json'), JSON.stringify({compilerOptions:{target:'ES2020',module:'CommonJS',moduleResolution:'Node',types:[],strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,esModuleInterop:true,newLine:'lf',lib:['ES2020','DOM']},files:['src/modules/test/ambient.d.ts']}))
  writeFileSync(join(root, 'src/modules/test/ambient.d.ts'), "declare module '*.css' {const css:string;export default css} declare module 'react' {export function fixtureCount(): number}")
  for (const [name, source] of Object.entries(files)) {mkdirSync(join(root, 'src/modules/test', name, '..'), {recursive:true});writeFileSync(join(root, 'src/modules/test', name), source)}
  return root
}
function compile(root, source='src/modules/test/index.ts') {return compileSourceModules(root,[{id:'@xh/test',source}]).get('@xh/test')}
function load(built, external=()=>{throw Error('unexpected dependency')}) {let registration;vm.runInNewContext(built.bytes.toString(),{window:{__ModuleLoader__:{load:row=>{registration=row}}}});assert.equal(registration.id,'@xh/test');return registration.factory(external)}
test('owned policy reports violations across the complete admitted source closure', () => {
  const root=fixture({'index.ts': "export {value} from './bad'; export const missing=document.querySelector('button')!;", 'bad.ts': 'export const value={} as { id: string };'})
  assert.throws(()=>compile(root), error=>error instanceof Error
    && error.message.includes('bad.ts') && error.message.includes('type-assertion')
    && error.message.includes('index.ts') && error.message.includes('non-null-assertion'))
})
test('relative UI root, relative imports, directory entries, CSS and real external edges', () => {
  const root = fixture({'index.ts':"import css from './style.css';import {value} from './part';import {fixtureCount} from 'react';export const result = css+value+fixtureCount();",'part/index.ts':'export const value=7;','style.css':'body { color: red; }'})
  const built = compile(relative(process.cwd(),root))
  assert.deepEqual(built.external,['react'])
  assert.equal(load(built,()=>({fixtureCount:()=>9})).result,'body { color: red; }79')
  assert.deepEqual(built.sources.sort(),['src/modules/test/index.ts','src/modules/test/part/index.ts','src/modules/test/style.css'])
  assert.deepEqual(compile(root).bytes,built.bytes,'same inputs are byte deterministic')
})
test('local CJS cache preserves singleton identity and cycles without cross-factory retention', () => {
  const root=fixture({'index.ts':"export {counter} from './a';export {counter as second} from './b';",'a.ts':"import {observe} from './b';export const counter={n:1};export const seen=()=>observe();",'b.ts':"import {counter} from './a';export {counter};export const observe=()=>counter.n;"})
  const built=compile(root), one=load(built), two=load(built)
  assert.equal(one.counter,one.second);assert.notEqual(one.counter,two.counter)
  one.counter.n=8;assert.equal(two.counter.n,1)
})
test('failed source factory may be retried; no failed partial export is retained', () => {
  const root=fixture({'index.ts':"import {fixtureCount} from 'react';export const value=fixtureCount();"})
  const built=compile(root);assert.throws(()=>load(built,()=>{throw Error('arrival')}),/arrival/)
  assert.equal(load(built,()=>({fixtureCount:()=>12})).value,12)
})
for (const [label, code, pattern] of [
  ['invalid types','export const value:number="broken";',/not assignable/],
  ['any erasure','export const value:any=1;',/must not erase/],
  ['ordinary assertion', 'export const value = {} as { id: string };', /unvalidated type assertion/],
  ['double assertion', 'export const value = {} as unknown as { id: string };', /unvalidated type assertion/],
  ['angle assertion', 'export const value = <{ id: string }>{};', /unvalidated type assertion/],
  ['non-null assertion', 'export const value = document.querySelector("button")!;', /establish presence/],
  ['inferred any', 'export const value = JSON.parse("{}");', /must not infer any/],
  ['async any', 'export async function value() { return JSON.parse("{}"); }', /must not return any/],
  ['expect-error directive', '// @ts-expect-error\nexport const value:number="broken";', /Disabled source/],
  ['ignore directive','// @ts-ignore\nexport const value:number="broken";',/Disabled source/],
  ['nocheck directive','// @ts-nocheck\nexport const value:number="broken";',/Disabled source/],
  ['unresolved import',"import {missing} from './missing';export {missing};",/Cannot find module/],
]) test(`rejects ${label} before publication`,()=>assert.throws(()=>compile(fixture({'index.ts':code})),pattern))
test('entry path may not escape UI or reference dist',()=>{
  const root=fixture({'index.ts':'export const value=1;'});assert.throws(()=>compile(root,'../index.ts'),/Invalid source/);assert.throws(()=>compile(root,'dist/index.ts'),/Invalid source/)
})
test('shared config cannot add unadmitted source entry roots',()=>{
  const root=fixture({'index.ts':'export const value=1;'}),path=join(root,'tsconfig.sources.json'),config=JSON.parse(readFileSync(path));config.files.push('src/modules/test/index.ts');writeFileSync(path,JSON.stringify(config));assert.throws(()=>compile(root),/declaration roots/)
})
test('locked Zod is bundled internally, preserving validation/projection, not exposed as absent loader dependency',()=>{
  const root=fixture({'index.ts':"import {z} from 'zod';export const schema=z.object({n:z.number()});export const projection=z.toJSONSchema(schema);"})
  cpSync(resolve('ui/node_modules/zod'),join(root,'node_modules/zod'),{recursive:true})
  const built=compile(root), value=load(built)
  assert.deepEqual(built.external,[]);assert.ok(built.sources.includes('npm:zod@4.4.3'))
  assert.equal(value.schema.safeParse({n:'bad'}).success,false);assert.equal(value.schema.safeParse({n:1}).success,true)
  assert.equal(value.projection.properties.n.type,'number')
  const metadata=join(root,'node_modules/zod/package.json'),pkg=JSON.parse(readFileSync(metadata));pkg.version='wrong';writeFileSync(metadata,JSON.stringify(pkg))
  assert.throws(()=>compile(root),/Unpinned vendor/)
})

function addVendor(root, {defines={__DEV__:true}, code="declare const __DEV__:boolean;export const flavor=__DEV__?'development':'production';export const identity=(value:any)=>value;"}={}) {
  const folder='src/modules/test/vendor';mkdirSync(join(root,folder),{recursive:true})
  writeFileSync(join(root,folder,'index.ts'),code);writeFileSync(join(root,folder,'LICENSE'),'Fixture license')
  writeFileSync(join(root,folder,'PROVENANCE.json'),JSON.stringify({formatVersion:1,sourceRevision:'1'.repeat(40),files:[{path:'index.ts',sha256:createHash('sha256').update(code).digest('hex')}]}))
  const path=join(root,'source-vendors.json'),spec=JSON.parse(readFileSync(path));spec.sourceTrees=[{root:folder,licenses:['LICENSE'],defines}];writeFileSync(path,JSON.stringify(spec));return folder
}
test('pinned vendor source is strict checked, narrow build defines stay inside its own unit',()=>{
  const root=fixture({'index.ts':"declare const __DEV__:boolean;export {flavor,identity} from './vendor';export const ownerValue=()=>typeof __DEV__;"});addVendor(root)
  const api=load(compile(root));assert.equal(api.flavor,'development');assert.equal(api.identity(9),9);assert.equal(api.ownerValue(),'undefined')
  const specPath=join(root,'source-vendors.json'),spec=JSON.parse(readFileSync(specPath));spec.sourceTrees[0].defines.__DEV__=false;writeFileSync(specPath,JSON.stringify(spec));assert.equal(load(compile(root)).flavor,'production')
})
test('vendor pins reject edited source, unsafe defines and unchecked code before output',()=>{
  const root=fixture({'index.ts':"export {flavor} from './vendor';"});const folder=addVendor(root)
  writeFileSync(join(root,folder,'index.ts'),readFileSync(join(root,folder,'index.ts'),'utf8')+'\n');assert.throws(()=>compile(root),/hash|sha256|pin/i)
  const other=fixture({'index.ts':"export {flavor} from './vendor';"});addVendor(other,{defines:{__DEV__:'true'}});assert.throws(()=>compile(other),/build defines/)
  const ignored=fixture({'index.ts':"export {flavor} from './vendor';"});addVendor(ignored,{code:'// @ts-nocheck\nexport const flavor=1;'});assert.throws(()=>compile(ignored),/Disabled source/)
  const broken=fixture({'index.ts':"export {flavor} from './vendor';"});addVendor(broken,{code:'export const flavor:number="wrong";'});assert.throws(()=>compile(broken),/not assignable/)
})
test('dynamic imports cannot evade the generated dependency graph',()=>{
 const root=fixture({'index.ts':"declare function require(path:string):unknown;const moduleName='runtime-missing';export const value=require(moduleName);"});assert.throws(()=>compile(root),/static string/)
})

test('emitter cleanup removes only code trivia, preserving multiline literal data',()=>{
 const code='const plain = 1;  \nconst text = `one  \n two\t \n`;  \nconst tagged = String.raw`raw  \n ${plain}  \n`;  \nconst escaped = "before  '+String.fromCharCode(92)+'\n after";  \nconst pattern = /a b/;  \n';
 const cleaned=stripEmissionTrivia(code)
 assert.notEqual(cleaned,code)
 assert.equal(cleaned,stripEmissionTrivia(cleaned),'cleanup is deterministic and idempotent')
 assert.equal(JSON.stringify(vm.runInNewContext(code+';[plain,text,tagged,escaped,pattern.source]')),JSON.stringify(vm.runInNewContext(cleaned+';[plain,text,tagged,escaped,pattern.source]')))
 assert.ok(cleaned.includes('one  \n two\t \n'))
 assert.ok(cleaned.includes('${plain}  \n'))
 assert.ok(!cleaned.includes('const plain = 1;  \n'))
})

test('shared config cannot weaken the owned strict typing policy', () => {
  for (const [key, value] of [['strict', false], ['noUncheckedIndexedAccess', false],
    ['exactOptionalPropertyTypes', false], ['allowJs', true], ['skipLibCheck', true]]) {
    const root = fixture({'index.ts': 'export const value = 1;'})
    const file = join(root, 'tsconfig.sources.json'), config = JSON.parse(readFileSync(file))
    config.compilerOptions[key] = value
    writeFileSync(file, JSON.stringify(config))
    assert.throws(() => compile(root), /must enable|may not bypass/)
  }
})
test('safe unknown narrowing, const literals and import aliases are valid owned code', () => {
  const root = fixture({
    'part.ts': 'export const kind = "known" as const;',
    'index.ts': `import {kind as tag} from './part';
      export const body: unknown = JSON.parse('{"n":1}');
      export const shape = {kind: tag} satisfies {kind: 'known'};
      export function field(value: unknown): number | undefined {
        return typeof value === 'object' && value !== null && 'n' in value && typeof value.n === 'number' ? value.n : undefined;
      }`,
  })
  const value = load(compile(root))
  assert.equal(value.shape.kind, 'known'); assert.equal(value.field(value.body), 1)
  assert.equal(value.field(null), undefined); assert.equal(value.field({n: 'bad'}), undefined)
})
test('actual package exports declarations remain strict across CJS loader emission', () => {
  const root = fixture({'index.ts': 'import {read} from "export-only"; export const value: number = read().count;'})
  const folder = join(root, 'node_modules/export-only')
  mkdirSync(join(folder, 'types'), {recursive: true})
  writeFileSync(join(folder, 'package.json'), JSON.stringify({name:'export-only',version:'1.0.0',exports:{'.':{types:'./types/public.d.ts'}}}))
  writeFileSync(join(folder, 'types/public.d.ts'), 'export declare function read(): {count: number};')
  const built = compile(root)
  assert.deepEqual(built.external, ['export-only'])
  assert.equal(load(built, () => ({read: () => ({count: 5})})).value, 5)
  writeFileSync(join(root, 'src/modules/test/index.ts'), 'import {read} from "export-only"; export const value: string = read().count;')
  assert.throws(() => compile(root), /not assignable/)
  writeFileSync(join(folder, 'types/public.d.ts'), 'export declare function read(): {count: NotAType};')
  assert.throws(() => compile(root), /Cannot find name 'NotAType'/, 'dependency declarations are checked, never skipped')
})
test('pinned source-library runtime and original public SDK are distinct verified inputs', () => {
  const root = fixture({'index.ts': 'import {identity} from "fixturelib"; export const value = identity(7);'})
  const folder = 'src/modules/test/vendor'
  const files = {
    'index.ts':'export const identity = (value:any) => value;',
    'public.d.ts':'export declare function identity(value:number): number;',
    'package.json':JSON.stringify({name:'fixturelib',version:'1.0.0',license:'MIT'}),
  }
  mkdirSync(join(root,folder), {recursive:true})
  for (const [name, code] of Object.entries(files)) writeFileSync(join(root,folder,name),code)
  writeFileSync(join(root,folder,'LICENSE'),'Fixture license')
  writeFileSync(join(root,folder,'PROVENANCE.json'),JSON.stringify({formatVersion:1,sourceRevision:'1'.repeat(40),files:Object.entries(files).map(([path,code])=>({path,sha256:createHash('sha256').update(code).digest('hex')}))}))
  writeFileSync(join(root,'source-vendors.json'),JSON.stringify({schemaVersion:1,packages:{},sourceTrees:[{root:folder,licenses:['LICENSE']}],sourcePackages:{fixturelib:{root:folder,entry:'index.ts',sdk:'public.d.ts',metadata:'package.json',version:'1.0.0',license:'MIT'}}}))
  const configFile = join(root,'tsconfig.sources.json'), config = JSON.parse(readFileSync(configFile))
  config.compilerOptions.baseUrl='.';config.compilerOptions.paths={fixturelib:[`${folder}/public.d.ts`]}
  writeFileSync(configFile,JSON.stringify(config))
  const built = compile(root)
  assert.deepEqual(built.external,[])
  assert.ok(built.sources.includes('vendor:fixturelib@1.0.0'))
  assert.equal(load(built).value,7)
  writeFileSync(join(root,'src/modules/test/index.ts'),'import {identity} from "fixturelib"; export const value = identity("wrong");')
  assert.throws(()=>compile(root), /not assignable/,'the actual SDK, not raw untyped implementation, controls the owned call boundary')
  writeFileSync(join(root,'src/modules/test/index.ts'),'import {identity} from "fixturelib"; export const value = identity(7);')
  writeFileSync(join(root,folder,'index.ts'),files['index.ts']+'\nexport const changed = 1;')
  assert.throws(()=>compile(root), /Pinned input changed/,'runtime vendor drift cannot bypass SDK typechecking')
})
