// Pin the additive paging layer separately; never relax the existing footer bytes.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const marker='/* Recent-tool paging: only two decorative faces; real cards and their actions never move. */'
const sha=text=>createHash('sha256').update(text).digest('hex')
export function checkedToolActivityStyle(source){
 const at=source.indexOf(marker)
 assert.ok(at>=0,'reviewed tool activity append is required')
 assert.equal(source.lastIndexOf(marker),at,'one tool activity append')
 assert.equal(sha(source.slice(0,at)),'5d753f1d086744361761e3918686c2095d02f019db4c42c6d27b27006ceb57b8','existing footer/header bytes are unchanged')
 assert.equal(sha(source.slice(at)),'30e9dc83b7fb4d36030ae4c5e066e1495ec487f6ad087f8ab5e51826a2f6f65c','exact reviewed tool activity append')
 return source
}
