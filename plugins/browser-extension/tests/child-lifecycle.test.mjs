import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {childLifecycle} from './child-lifecycle.mjs'
test('teardown observes a child that exited before cleanup was requested',async()=>{
 const child=spawn(process.execPath,['-e','process.exit(17)']),life=childLifecycle(child)
 const result=await life.exited;assert.equal(result.code,17)
 const after=await life.close();assert.deepEqual(after,result)
})
