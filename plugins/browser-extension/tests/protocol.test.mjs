import test from 'node:test'
import assert from 'node:assert/strict'
import{PassThrough}from'node:stream'
import{command,httpOrigin,mayMutate,MAX_WIRE}from'../dist/protocol.js'
import{framed,lines}from'../dist/native/common.js'
import{registrationTarget,install}from'../scripts/install-native.mjs'
test('closed command union rejects raw CDP, eval, tab overrides and malformed fields',()=>{
 for(const value of [{action:'eval',script:'document.cookie'},{action:'click',tabId:1,observationId:'a',ref:'b',code:'x'},{action:'tabs',tabId:1},{action:'navigate',tabId:1,url:'javascript:alert(1)'},{action:'navigate',tabId:1,url:'https://a:b@example.com'},{action:'press',tabId:1,key:'LaunchApplication1'},{action:'fill',tabId:1,observationId:'a',ref:'b',text:'x'.repeat(8193)},{action:'observe',tabId:-1},{action:'observe',tabId:1.1},{action:'observe',tabId:1,cursor:''},{action:'observe',tabId:1,cursor:32},{action:'screenshot',tabId:1,cursor:'x'}])assert.throws(()=>command(value))
 assert.deepEqual(command({action:'fill',tabId:1,observationId:'a',ref:'n0',text:'中文 😀'}),{action:'fill',tabId:1,observationId:'a',ref:'n0',text:'中文 😀'})
 assert.equal(httpOrigin('https://example.com/path?secret=x'),'https://example.com')
 assert.equal(mayMutate(command({action:'observe',tabId:1})),false)
 assert.equal(mayMutate(command({action:'click',tabId:1,observationId:'a',ref:'b'})),true)
})
test('native frames survive arbitrary fragmentation, multiple messages and Unicode',()=>{
 const input=new PassThrough(),messages=[],errors=[];framed(input,value=>messages.push(value),error=>errors.push(error))
 const values=[{type:'hello',version:1},{name:'中文 😀'}],bytes=Buffer.concat(values.map(value=>{const body=Buffer.from(JSON.stringify(value)),size=Buffer.alloc(4);size.writeUInt32LE(body.length);return Buffer.concat([size,body])}))
 for(const byte of bytes)input.write(Buffer.from([byte]));input.end()
 assert.deepEqual(messages,values);assert.deepEqual(errors,[])
})
for(const length of[0,MAX_WIRE+1,0xffffffff])test('native length rejected before allocation: '+length,()=>{
 const input=new PassThrough(),errors=[];framed(input,()=>assert.fail('unexpected message'),error=>errors.push(error));const size=Buffer.alloc(4);size.writeUInt32LE(length);input.write(size);assert.equal(errors.length,1)
})
test('native truncated or invalid JSON frames and bounded lines fail closed',async()=>{
 for(const data of[Buffer.from([5,0,0,0,123]),Buffer.from([1,0,0,0,33]),Buffer.from([3,0,0,0,34,255,34])]){
  const input=new PassThrough(),errors=[];framed(input,()=>assert.fail('unexpected message'),error=>errors.push(error));input.end(data);await new Promise(resolve=>setImmediate(resolve));assert.equal(errors.length,1)
 }
 const input=new PassThrough(),errors=[];lines(input,()=>assert.fail('unexpected line'),error=>errors.push(error));input.write(Buffer.alloc(MAX_WIRE+1,65));assert.equal(errors.length,1)
})
test('Chrome/Edge native registration is per user on all three platforms',()=>{
 assert.match(registrationTarget('darwin','chrome','/test').manifest,/Library\/Application Support\/Google\/Chrome\/NativeMessagingHosts/)
 assert.match(registrationTarget('darwin','edge','/test').manifest,/Microsoft Edge\/NativeMessagingHosts/)
 assert.match(registrationTarget('linux','chromium','/test','/xdg').manifest,/^\/xdg\/chromium\//)
 assert.match(registrationTarget('linux','edge','/test').manifest,/microsoft-edge/)
 assert.match(registrationTarget('win32','chrome','C:\\test').registry,/^HKCU\\Software\\Google\\Chrome/)
 assert.match(registrationTarget('win32','edge','C:\\test').registry,/Microsoft\\Edge/)
 assert.throws(()=>registrationTarget('freebsd','chrome','/test'))
 assert.throws(()=>registrationTarget('linux','other','/test'))
})
test('installer defaults to a read-only plan with an exact extension identity',async()=>{
 const result=await install({home:'/never-create-this-directory',os:'linux',browser:'chromium'})
 assert.equal(result.installed,undefined);assert.match(result.extensionId,/^[a-p]{32}$/)
 assert.deepEqual(result.manifest.allowed_origins,[`chrome-extension://${result.extensionId}/`])
 assert.equal(result.manifest.type,'stdio')
})
