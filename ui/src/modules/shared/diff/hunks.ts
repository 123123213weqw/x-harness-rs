// Shared readonly hunk coordinates. Evidence validation and display use the same parser.
export interface DiffLine {side:'left'|'right';line:number;text:string}
/** Parse actual hunk coordinates, not patch-array offsets. Malformed/truncated
 * hunks have no trustworthy coordinates and fail closed. No full-file guesses. */
export function diffLines(patch:string|null):readonly DiffLine[]{
 if(patch===null||patch.length>4*1024*1024)return []
 const result:DiffLine[]=[]
 let old=0,next=0,oldRemaining=0,newRemaining=0,inHunk=false
 for(const row of patch.replaceAll('\r\n','\n').split('\n')){
  const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row)
  if(header){
   if(inHunk&&(oldRemaining!==0||newRemaining!==0))return []
   old=Number(header[1]);next=Number(header[3]);oldRemaining=header[2]===undefined?1:Number(header[2]);newRemaining=header[4]===undefined?1:Number(header[4]);inHunk=true
   if(![old,next,oldRemaining,newRemaining].every(Number.isSafeInteger)||oldRemaining<0||newRemaining<0||(oldRemaining>0&&old<1)||(newRemaining>0&&next<1))return []
   continue
  }
  if(!inHunk)continue
  if(row==='\\ No newline at end of file')continue
  if(row===''&&oldRemaining===0&&newRemaining===0)continue
  const marker=row[0],text=row.slice(1)
  if(marker===' '){if(oldRemaining<1||newRemaining<1)return [];result.push({side:'left',line:old++,text},{side:'right',line:next++,text});oldRemaining--;newRemaining--}
  else if(marker==='-'){if(oldRemaining<1)return [];result.push({side:'left',line:old++,text});oldRemaining--}
  else if(marker==='+'){if(newRemaining<1)return [];result.push({side:'right',line:next++,text});newRemaining--}
  else return []
 }
 return inHunk&&oldRemaining===0&&newRemaining===0?result:[]
}
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
