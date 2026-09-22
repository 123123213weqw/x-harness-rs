import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {generateWireContract} from './generate-session-terminal-contract.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
export function run(args){
 for(let i=0;i<args.length;i++){if(args[i]==='--check')continue;if(args[i]==='--from'&&args[i+1]){i++;continue}throw Error('usage: generate-file-display-contract.mjs [--from directory] [--check]')}
 const from=args.indexOf('--from'),source=from<0?resolve(root,'protocol'):resolve(args[from+1])
 const contract=JSON.parse(readFileSync(resolve(source,'file-display.schema.json'),'utf8'))
 if(contract.contract!=='xharness-file-display-v1')throw Error('unsupported file display contract')
 const outputs=[['ui/src/modules/shared/generated/file-display.ts',generateWireContract(contract,{source:'crates/xharness-api/src/display.rs',command:'scripts/generate-file-display-contract.mjs',prefix:'FILE_DISPLAY'})]]
 const scopes=contract.schemas.GitDiffScope.enum
 if(!Array.isArray(scopes)||!scopes.length||scopes.some(value=>typeof value!=='string'))throw Error('invalid Git diff scope enum')
 outputs.push(['ui/src/modules/shared/generated/file-display-options.ts',`// GENERATED from crates/xharness-api/src/display.rs; do not edit.\nimport type {GitDiffScope} from './file-display'\nexport const GIT_DIFF_SCOPES: readonly GitDiffScope[] = ${JSON.stringify(scopes)}\n`])
 if(from>=0){outputs.push(['protocol/file-display.schema.json',JSON.stringify(contract,null,2)+'\n']);outputs.push(['protocol/fixtures/file-display-v1.json',JSON.stringify(JSON.parse(readFileSync(resolve(source,'file-display.fixtures.json'),'utf8')),null,2)+'\n'])}
 for(const [path,expected]of outputs){const target=resolve(root,path);if(args.includes('--check')){if(readFileSync(target,'utf8')!==expected)throw Error('file display contract drift: '+path)}else{mkdirSync(dirname(target),{recursive:true});writeFileSync(target,expected)}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run(process.argv.slice(2))
