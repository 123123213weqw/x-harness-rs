import test from 'node:test'
import assert from 'node:assert/strict'
import {projectionArtifacts} from './projection-artifact-test.mjs'

// Actual shipped factory: source, graph hash and preload freshness are checked.
const {conversation: c} = projectionArtifacts(['toolArgumentPreview','boundedToolArgumentText','formatToolArgumentBytes','TOOL_ARGUMENT_PREVIEW_LIMIT','updateChunk'])
const plain = value => JSON.parse(JSON.stringify(value))
test('readable text fields preserve escapes, Unicode and the authoritative raw input', () => {
  const text = '# README\n中文 😀 "quote" \\ path\tend'
  for (const field of ['command','cmd','content','file_text','patch','patchText','new_string','newString','code']) {
    const raw = JSON.stringify({[field]:text})
    assert.deepEqual(plain(c.toolArgumentPreview(raw)),{field,text,truncated:false})
    // Every network prefix is safe to display, including incomplete escapes.
    for (let n=0;n<=raw.length;n++) {
      const preview = c.toolArgumentPreview(raw.slice(0,n))
      assert.ok(preview.text.length <= c.TOOL_ARGUMENT_PREVIEW_LIMIT)
      if (preview.field) assert.ok(text.startsWith(preview.text))
    }
    assert.equal(raw,JSON.stringify({[field]:text}))
  }
})
test('partial escaped Unicode, newlines and backslashes do not invent characters', () => {
  assert.equal(c.toolArgumentPreview('{"command":"line\\nnext\\').text,'line\nnext')
  assert.equal(c.toolArgumentPreview('{"command":"\\u4e2d\\u6587').text,'中文')
  assert.equal(c.toolArgumentPreview('{"command":"\\uD83D').text,'')
  assert.equal(c.toolArgumentPreview('{"command":"\\uD83D\\uDE00').text,'😀')
  assert.equal(c.toolArgumentPreview('{"command":"\\u4e').text,'')
})
test('nested keys and text resembling keys cannot become executable-looking previews', () => {
  for (const raw of ['{"nested":{"command":"nested"}}','{"notes":"\\\"command\\\":\\\"fake\\\""}','{"paths":["command","file.ts"]}']) {
    assert.deepEqual(plain(c.toolArgumentPreview(raw)),{text:raw,field:null,truncated:false})
  }
  assert.equal(c.toolArgumentPreview('{"nested":{"command":"nested"},"content":"real"}').text,'real')
})
test('preview cap never changes raw arguments and does not split a surrogate pair', () => {
  const text = 'x'.repeat(c.TOOL_ARGUMENT_PREVIEW_LIMIT-1)+'😀'+'z'.repeat(100)
  const raw = JSON.stringify({content:text})
  const preview = c.toolArgumentPreview(raw)
  assert.equal(preview.text,'x'.repeat(c.TOOL_ARGUMENT_PREVIEW_LIMIT-1))
  assert.equal(preview.truncated,true)
  assert.equal(JSON.parse(raw).content,text)
  assert.equal(c.boundedToolArgumentText(text).text,preview.text)
})
test('received size is UTF-8 bytes, not characters, tokens or a completion percentage', () => {
  assert.equal(new TextEncoder().encode('中文😀').byteLength,10)
  assert.equal(c.formatToolArgumentBytes(10),'10 B')
  assert.equal(c.formatToolArgumentBytes(1024),'1.0 KiB')
})
test('each call retains its first normalized delta timestamp without mutating history', () => {
  const event = (time,index,id,name,argumentsDelta) => ({event:{type:'assistant/chunk',time,seq:time,data:{turn:1,step:1,chunk:{type:'tool-call-delta',index,id,name,argumentsDelta}}}})
  let state = {blocks:[],turn:1,step:1}
  state = c.updateChunk(state,event(1000,0,'a','bash','{"command":"'))
  const before = plain(state)
  state = c.updateChunk(state,event(2000,0,'a','','echo hello'))
  assert.equal(state.blocks[0].startedAt,1000)
  assert.equal(state.blocks[0].name,'bash')
  assert.deepEqual(before.blocks[0].argsRaw,'{"command":"')
  state = c.updateChunk(state,event(3000,1,'b','write','{"content":"'))
  assert.equal(state.blocks[1].startedAt,3000)
})
