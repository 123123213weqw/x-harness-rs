import {diffLines} from './structured'
export interface DiffRow {left:number|null;right:number|null;text:string;kind:'context'|'added'|'removed'}
/** Rendering uses the same validated coordinates as evidence validation. */
export function diffRows(patch:string|null):readonly DiffRow[]{
 const lines=diffLines(patch);if(!lines.length||patch===null)return []
 const rows:DiffRow[]=[];let index=0,inHunk=false
 for(const row of patch.replaceAll('\r\n','\n').split('\n')){
  if(row.startsWith('@@ ')){inHunk=true;continue}if(!inHunk)continue
  const line=lines[index];if(!line)continue
  if(row[0]===' '){const right=lines[index+1];if(!right)return [];rows.push({left:line.line,right:right.line,text:line.text,kind:'context'});index+=2}
  else if(row[0]==='-'){rows.push({left:line.line,right:null,text:line.text,kind:'removed'});index++}
  else if(row[0]==='+'){rows.push({left:null,right:line.line,text:line.text,kind:'added'});index++}
 }
 return rows
}
