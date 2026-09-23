// File framing is presentation-only; coordinates reuse Code Review's strict parser.
import {diffRows} from '../../shared/diff/hunks'
export interface DiffRow {kind:'hunk'|'context'|'added'|'removed'|'note';text:string;left?:number;right?:number}
export interface DiffFile {path:string;oldPath?:string;added:number;removed:number;binary:boolean;rename:boolean;mode?:string;rows:readonly DiffRow[]}
export interface ParsedDiff {files:readonly DiffFile[];error?:string}
const strip=(path:string|undefined)=>path?.replace(/^[ab]\//,'')
/** Decode Git's quoted filename bytes, without interpreting them as links. */
function filename(raw:string):string {
  if(!raw.startsWith('"'))return raw.split('\t')[0]??raw
  const bytes:number[]=[]
  for(let i=1;i<raw.length;i++){
    const ch=raw[i];if(ch==='"')return new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bytes))
    if(ch==='\\'){
      const next=raw[++i];if(next===undefined)break
      if(/[0-7]/.test(next)){const octal=raw.slice(i,i+3);if(!/^[0-7]{3}$/.test(octal))throw new Error('Invalid quoted Git filename');bytes.push(parseInt(octal,8));i+=2}
      else {const escaped:Readonly<Record<string,string>>={'a':'\x07','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t','v':'\v','"':'"','\\':'\\'};const value=escaped[next];if(value===undefined)throw new Error('Invalid quoted Git filename');bytes.push(...new TextEncoder().encode(value))}
    }else if(ch!==undefined){const cp=raw.codePointAt(i);const value=cp===undefined?ch:String.fromCodePoint(cp);bytes.push(...new TextEncoder().encode(value));if(value.length===2)i++}
  }
  throw new Error('Unterminated quoted Git filename')
}
function gitPath(header:string):string {
  const raw=header.slice(11),pair=/^("(?:\\.|[^"])*"|[^\s]+) ("(?:\\.|[^"])*"|[^\s]+)$/.exec(raw)
  if(pair?.[2])return strip(filename(pair[2]))??raw
  // Unquoted space-containing paths are unambiguous when both names match.
  for(let at=raw.indexOf(' b/');at>=0;at=raw.indexOf(' b/',at+1)){
    const old=strip(raw.slice(0,at)),next=strip(raw.slice(at+1));if(old===next&&next)return next
  }
  return raw // retain the original header rather than guess a filename
}
/** Frame multi-file unified patches without confusing removed ---/added +++
 * content with headers inside a hunk. Raw bytes are always retained by the owner. */
function fileChunks(lines:readonly string[]):readonly string[][] {
  const result:string[][]=[];let chunk:string[]=[],old=0,next=0,hasFileHeaders=false
  for(let i=0;i<lines.length;i++){
    const line=lines[i]??''
    const boundary=line.startsWith('diff --git ')||((old===0&&next===0)&&line.startsWith('--- ')&&lines[i+1]?.startsWith('+++ ')&&hasFileHeaders)
    if(boundary&&chunk.length){result.push(chunk);chunk=[];hasFileHeaders=false;old=0;next=0}
    if(line.startsWith('+++ ')&&old===0&&next===0)hasFileHeaders=true
    const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if(header){old=header[2]===undefined?1:Number(header[2]);next=header[4]===undefined?1:Number(header[4])}
    else if(old>0||next>0){if(line[0]===' '){old--;next--}else if(line[0]==='-')old--;else if(line[0]==='+')next--}
    chunk.push(line)
  }
  if(chunk.length)result.push(chunk)
  return result
}
export function inspectPatch(text:string):ParsedDiff {
  if(!text.trim())return {files:[]}
  let count=0
  for(let index=0;index<text.length;index++)if(text[index]==='\n'&&++count>20000)return {files:[],error:'Diff has too many lines; use source view or a narrower scope'}
  try {
    if(/^(?:@@@|GIT binary patch)/m.test(text))throw new Error('Combined/encoded binary patches require source view')
    const chunks=fileChunks(text.replaceAll('\r\n','\n').split('\n'))
    if(chunks.length>1024)throw new Error('Diff has too many files; use a narrower scope')
    const files:DiffFile[]=[]
    for(const chunk of chunks){
      const firstHunk=chunk.findIndex(line=>line.startsWith('@@ ')),metadata=firstHunk<0?chunk:chunk.slice(0,firstHunk)
      const oldLine=metadata.find(line=>line.startsWith('--- ')),newLine=metadata.find(line=>line.startsWith('+++ ')),git=metadata.find(line=>line.startsWith('diff --git '))
      const renameFrom=metadata.find(line=>line.startsWith('rename from ')),renameTo=metadata.find(line=>line.startsWith('rename to '))
      const old=oldLine?strip(filename(oldLine.slice(4))):renameFrom?filename(renameFrom.slice(12)):undefined
      const next=newLine?strip(filename(newLine.slice(4))):renameTo?filename(renameTo.slice(10)):undefined
      if(!!oldLine!==!!newLine)throw new Error('Missing unified file header')
      if(!git&&!oldLine&&firstHunk<0)continue
      const path=(next&&next!=='/dev/null'?next:old&&old!=='/dev/null'?old:undefined)??(git?gitPath(git):`Hunk ${files.length+1}`)
      const rows:DiffRow[]=[];let added=0,removed=0
      if(firstHunk>=0){
        const sections=chunk.slice(firstHunk).join('\n').split(/(?=^@@ )/m)
        for(const section of sections){
          const title=section.split('\n',1)[0]??'',parsed=diffRows(section)
          if(!parsed.length&&!(/^@@ -\d+,0 \+\d+,0 @@/.test(title)&&section.slice(title.length).trim()===''&&[...title.matchAll(/\d+/g)].every(match=>Number.isSafeInteger(Number(match[0])))))throw new Error('Incomplete or malformed hunk')
          rows.push({kind:'hunk',text:title})
          let cursor=0
          for(const line of section.split('\n').slice(1)){
            if(line==='\\ No newline at end of file'){rows.push({kind:'note',text:line});continue}
            const row=parsed[cursor];if(!row)continue;cursor++
            rows.push({kind:row.kind,text:row.text,...row.left===null?{}:{left:row.left},...row.right===null?{}:{right:row.right}});if(row.kind==='added')added++;if(row.kind==='removed')removed++
          }
        }
      }
      const oldMode=metadata.find(line=>line.startsWith('old mode ')||line.startsWith('deleted file mode ')),newMode=metadata.find(line=>line.startsWith('new mode ')||line.startsWith('new file mode '))
      const binary=metadata.some(line=>line.startsWith('Binary files '))
      if(firstHunk<0&&(!binary&&!oldMode&&!newMode&&!renameTo||chunk.some(line=>line.startsWith('@@'))))throw new Error('Missing or malformed diff hunks/change metadata')
      files.push({path,...old&&old!=='/dev/null'&&old!==path?{oldPath:old}:{},added,removed,binary,rename:!!renameTo,...oldMode||newMode?{mode:`${oldMode?.split(' ').at(-1)??'—'} → ${newMode?.split(' ').at(-1)??'—'}`}:{},rows})
    }
    if(!files.length)throw new Error('Not a supported unified diff; inspect source instead')
    return {files}
  }catch(error:unknown){return {files:[],error:error instanceof Error?error.message:String(error)}}
}
export interface SplitDiffRow {left?:DiffRow;right?:DiffRow;full?:DiffRow}
export function splitRows(rows:readonly DiffRow[]):readonly SplitDiffRow[]{
  const result:SplitDiffRow[]=[]
  for(let index=0;index<rows.length;){
    const row=rows[index];if(!row)break
    if(row.kind==='context'){result.push({left:row,right:row});index++}
    else if(row.kind==='hunk'||row.kind==='note'){result.push({full:row});index++}
    else {
      const left:DiffRow[]=[],right:DiffRow[]=[]
      while(index<rows.length){const change=rows[index];if(!change||(change.kind!=='added'&&change.kind!=='removed'))break;(change.kind==='removed'?left:right).push(change);index++}
      for(let n=0;n<Math.max(left.length,right.length);n++)result.push({...left[n]?{left:left[n]}:{},...right[n]?{right:right[n]}:{}})
    }
  }
  return result
}
