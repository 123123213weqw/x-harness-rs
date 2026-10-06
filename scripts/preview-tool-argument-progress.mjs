import {createServer} from 'node:http'
import {toolArgumentPreviewFiles,serveToolArgumentPreview} from './fixtures/tool-argument-progress-page.mjs'
const files=toolArgumentPreviewFiles()
const server=createServer((request,response)=>serveToolArgumentPreview(files,request,response))
server.listen(Number(process.env.PORT??4186),'127.0.0.1',()=>console.log(`Isolated tool input preview: http://127.0.0.1:${server.address().port}/ (no Host/model/command execution)`))
