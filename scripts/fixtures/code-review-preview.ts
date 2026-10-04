/** Sample records only. Never interpreted as actual PR or CI evidence. */
export interface ReviewCheck {name: string; status: 'passed' | 'failed'; log: string}
export interface ReviewFile {path: string; patch: string}
export interface ReviewRecord {id: number; repository: string; title: string; author: string; age: string; branch: string; additions: number; deletions: number; summary: string; checks: readonly ReviewCheck[]; files: readonly ReviewFile[]}
export type ReviewFilter = 'all' | 'attention'
const first: ReviewRecord = {id:4467,repository:'anolisa/zcode',title:'fix(chore): tolerate invalid session timestamps',author:'123123213weqw',age:'5m',branch:'fix-converter-invalid-timestamps',additions:118,deletions:6,
summary:'Keep trace conversion working when a session contains a missing, empty, or malformed timestamp. A single invalid event should not discard the remaining session.\n\nNormalize timestamps before sorting events. Preserve valid timestamps and use a consistent fallback for invalid values.\n\nCover null, numeric, empty, and missing values with regression tests.',
checks:[{name:'Auto Label',status:'passed',log:'Preview check: label rules matched.'},{name:'DingTalk Notification',status:'passed',log:'Preview check: notification workflow completed.'}],
files:[{path:'session_trace_converter.py',patch:'@@ -61,3 +61,5 @@\n def normalize_timestamp(value):\n-    return value.rstrip("Z")\n+    if not isinstance(value, str) or not value.strip():\n+        return now_iso()\n+    return value.rstrip("Z")'}]}
const titles = ['feat(cloud): migrate durable runtime foundation to public repository','docs: resume open-source development','fix(ckpt): validate legacy snapshot ids','fix(memory): floor get_context max_tokens at one','fix(memory): filter derivable facts before budget','fix(memory): dedup identical lessons in rule_lesson','fix(memory): supersede only after fact persists','fix(skillfs): sync store on skill dir renames']
export const records: readonly ReviewRecord[] = [first,...titles.map((title,index): ReviewRecord => ({id:201+index,repository:'123123213weqw/x-harness-rs',title,author:'123123213weqw',age:`${15+index*6}m`,branch:`preview/change-${index+1}`,additions:28+index*7,deletions:12+index,summary:`${title}\n\nThis sample shows the pull request summary in the shared review workspace.`,checks:index===7?[{name:'Windows desktop tests',status:'failed',log:'Preview failure\nExpected installed path to match the renamed directory.\nObserved stale source path after rename.'}]:[],files:[]}))]
export function recordKey(record: ReviewRecord): string {return `${record.repository}#${record.id}`}
export function filterRecords(list: readonly ReviewRecord[],query: string,filter: ReviewFilter): readonly ReviewRecord[] {
 const text=query.trim().toLowerCase(),link=/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i.exec(text)
 return list.filter(record=>{
  if(filter==='attention'&&!record.checks.some(check=>check.status==='failed'))return false
  if(text.startsWith('https://')||text.startsWith('http://'))return link!==null&&record.repository.toLowerCase()===link[1]&&String(record.id)===link[2]
  return `${record.title} ${record.repository} #${record.id}`.toLowerCase().includes(text)
 })
}
