import type {ReviewFile} from './client'

/** Identity is supplied by the authenticated Host, never accepted from model JSON. */
export interface ReviewTarget {account:string;repository:string;number:number;headSha:string}
export interface ReviewSnapshot extends ReviewTarget {files:readonly ReviewFile[];filesHasMore:boolean;changedFiles:number}
export interface DiffLine {side:'left'|'right';line:number;text:string}
export interface ReviewFinding {
 id:string;priority:0|1|2|3;title:string;explanation:string
 path:string;side:'left'|'right';startLine:number;endLine:number;evidence:string
 /** Location/quote validation is not independent proof that the claimed defect exists. */
 validation:'evidence-linked';disposition:'needs-confirmation'
}
export interface ReviewReport {
 target:ReviewTarget;findings:readonly ReviewFinding[];rejected:readonly {index:number;reason:string}[]
 suppliedFiles:readonly string[];unavailableFiles:readonly string[];scopeIncomplete:boolean
 outcome:'findings'|'no-findings-in-supplied-scope'|'invalid-findings'
}
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max
const lineNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const safePath=(value:unknown):value is string=>bounded(value,2048)&&!value.startsWith('/')&&!value.includes('\\')&&!/[\u0000-\u001f]/.test(value)&&value.split('/').every(part=>part!=='.'&&part!=='..'&&part.length>0)
const priority=(value:unknown):value is 0|1|2|3=>value===0||value===1||value===2||value===3
const side=(value:unknown):value is 'left'|'right'=>value==='left'||value==='right'

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
function finding(raw:unknown,snapshot:ReviewSnapshot,index:number):ReviewFinding{
 if(!object(raw)||!priority(raw.priority)||!bounded(raw.title,160)||!bounded(raw.explanation,4000)||!safePath(raw.path)||!side(raw.side)||!lineNumber(raw.startLine)||!lineNumber(raw.endLine)||raw.endLine<raw.startLine||raw.endLine-raw.startLine>39||!bounded(raw.evidence,8000))throw Error('Invalid finding fields')
 const {path,side:whichSide,startLine,endLine}=raw
 const file=snapshot.files.find(file=>file.path===path)
 if(!file)throw Error('File was not supplied to this review')
 const lines=diffLines(file.patch).filter(line=>line.side===whichSide&&line.line>=startLine&&line.line<=endLine)
 if(lines.length!==endLine-startLine+1||lines.some((line,offset)=>line.line!==startLine+offset))throw Error('Location is outside the supplied diff')
 if(raw.evidence.replaceAll('\r\n','\n')!==lines.map(line=>line.text).join('\n'))throw Error('Evidence does not match the supplied code')
 return {id:`finding-${index+1}`,priority:raw.priority,title:raw.title,explanation:raw.explanation,path:raw.path,side:raw.side,startLine:raw.startLine,endLine:raw.endLine,evidence:raw.evidence,validation:'evidence-linked',disposition:'needs-confirmation'}
}
/** Complete JSON only; partial streaming JSON is never promoted to a report.
 * Metadata, coverage and display identities are derived from the trusted snapshot. */
export function decodeReviewReport(raw:string,snapshot:ReviewSnapshot):ReviewReport{
 if(raw.length>1024*1024)throw Error('Review report exceeds the response bound')
 const value:unknown=JSON.parse(raw)
 if(!object(value)||value.version!==1||!Array.isArray(value.findings)||value.findings.length>100)throw Error('Invalid review report')
 const items:unknown[]=value.findings
 const findings:ReviewFinding[]=[],rejected:{index:number;reason:string}[]=[],seen=new Set<string>()
 const suppliedFiles=snapshot.files.filter(file=>diffLines(file.patch).length>0).map(file=>file.path)
 const unavailableFiles=snapshot.files.filter(file=>!suppliedFiles.includes(file.path)).map(file=>file.path)
 for(const [index,item] of items.entries()){
  try{const next=finding(item,snapshot,index),key=JSON.stringify([next.path,next.side,next.startLine,next.endLine,next.title,next.explanation]);if(seen.has(key)){rejected.push({index,reason:'Duplicate finding'});continue}seen.add(key);findings.push(next)}
  catch(error:unknown){rejected.push({index,reason:error instanceof Error?error.message:'Invalid finding'})}
 }
 return {target:{account:snapshot.account,repository:snapshot.repository,number:snapshot.number,headSha:snapshot.headSha},findings,rejected,suppliedFiles,unavailableFiles,scopeIncomplete:snapshot.filesHasMore||snapshot.files.length<snapshot.changedFiles||unavailableFiles.length>0,outcome:findings.length?'findings':rejected.length?'invalid-findings':'no-findings-in-supplied-scope'}
}
export function reportIsStale(report:ReviewReport,target:ReviewTarget):boolean{
 return report.target.account!==target.account||report.target.repository.toLowerCase()!==target.repository.toLowerCase()||report.target.number!==target.number||report.target.headSha!==target.headSha
}
