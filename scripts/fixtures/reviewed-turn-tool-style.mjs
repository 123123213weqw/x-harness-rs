// Exact, reviewed appends only. The frozen UI reference is never rewritten.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const pins = {
 chat: {marker: '/* Flat keyed seats remain independent; visual grouping does not pin whole turns. */', sha: '01dc677c5815fdff9ed62375e00278cc96e76d7a3d0b9622e555645c3dba7efc'},
 tool: {marker: '/* Keep identity and state orthogonal, including failed and interrupted tools. */', sha: '00e8def1b6c7f2bcc1fa269a6376682f7d497b2fdd91386b941480394ae7ff1b'},
}
export function stripTurnStyle(source, kind, required = true) {
 const {marker,sha}=pins[kind],at=source.indexOf(marker)
 if(at<0){assert.equal(required,false,'reviewed turn style must be present');return source}
 assert.equal(source.lastIndexOf(marker),at,'one reviewed append, not duplicate CSS')
 assert.equal(createHash('sha256').update(source.slice(at)).digest('hex'),sha,'exact reviewed turn style, no unrelated tail changes')
 return source.slice(0,at)
}
export function stripTurnToolStyles(styles){
 const id='@xharness/dsh-client-ui-tool/ToolRow.module.css'
 assert.equal(styles.filter(s=>s.dataset.pluginCss===id).length,1)
 return styles.map(s=>s.dataset.pluginCss===id?{...s,textContent:stripTurnStyle(s.textContent,'tool')}:s)
}
