// Pin the additive paging layer separately; never relax the existing footer bytes.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const marker='/* Live-tool summary: two decorative faces; real cards keep their action/privacy ownership. */'
const sha=text=>createHash('sha256').update(text).digest('hex')
export function checkedToolActivityStyle(source){
 const at=source.indexOf(marker)
 assert.ok(at>=0,'reviewed tool activity append is required')
 assert.equal(source.lastIndexOf(marker),at,'one tool activity append')
 assert.equal(sha(source.slice(0,at)),'63b80c2ea84b2f5ec971c70847052f55ed65a48bd79a1a3448da35010a1becb5','existing footer/header bytes are unchanged')
 assert.equal(sha(source.slice(at)),'8cd84cc984d8ebc0bad6a9c878db6d7b6245f6e809fe903851b3bd21ae44c098','exact reviewed tool activity append')
 return source
}
