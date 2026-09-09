// Deterministic adaptation of the pinned upstream shared composer. No native UI fork.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marker = '// XHARNESS DURABLE ATTACHMENTS v1\n'
function once(text, before, after) {
  if (text.split(before).length !== 2) throw Error('Attachment UI signature changed: ' + before.slice(0, 100))
  return text.replace(before, after)
}
export function patchAttachments(id, bytes) {
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  if (text.includes(marker)) return Buffer.from(text)
  if (id === '@deepseek-ai/dsh-client-connection') {
    text = once(text, "name: string().optional()\n\t\t})]);\n\t\tobject({\n\t\t\tsessionId: sessionIdSchema,\n\t\t\tmode:", "name: string().optional()\n\t\t}), object({type:literal(\"file\"),mediaType:string(),data:string(),name:string().optional()})]);\n\t\tobject({\n\t\t\tsessionId: sessionIdSchema,\n\t\t\tmode:");
    text = once(text, "attachmentId: attachmentIdSchema,\n\t\t\tmediaType: imageMediaTypeSchema,\n\t\t\tbytes: number().int().positive(),\n\t\t\twidth: number().int().positive(),\n\t\t\theight: number().int().positive(),", "attachmentId: attachmentIdSchema,\n\t\t\tmediaType: string(),\n\t\t\tbytes: number().int().nonnegative(),\n\t\t\twidth: number().int().positive().nullish(),\n\t\t\theight: number().int().positive().nullish(),");
    text = once(text, 'object({type:literal("image_ref"),attachmentId:string().min(1)})', 'object({type:literal("image_ref"),attachmentId:string().min(1)}),object({type:literal("file_ref"),attachmentId:string().min(1),name:string().optional()})');
    text += '\n' + marker;
  } else if (id === '@deepseek-ai/dsh-client-ui-conversation') {
    text = once(text, 'function browserDraftAttachment(file) {', `function attachmentMediaType(file) {
      if (file.type) return file.type;
      return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'})[file.name.split('.').pop().toLowerCase()] || 'application/octet-stream';
    }
    function attachmentKind(file) { return ['image/png','image/jpeg','image/webp','image/gif'].includes(attachmentMediaType(file)) ? 'image' : 'file'; }
    function validateAttachments(files) {
      if (files.length > 128) throw Error('最多同时添加 128 个附件');
      const images = files.filter(file => attachmentKind(file) === 'image');
      if (images.length > 16) throw Error('每条消息最多 16 张图片');
      for (const file of files) {
        const limit = attachmentKind(file) === 'image' ? 20 : 32;
        if (file.size > limit * 1024 * 1024) throw Error(file.name + ' 超过 ' + limit + ' MiB 上传限制');
      }
      if (files.reduce((sum,file) => sum + file.size,0) > 96 * 1024 * 1024) throw Error('本次附件合计不能超过 96 MiB');
    }
    function browserDraftAttachment(file) {`)
    text = once(text, '{type:"image_ref",attachmentId:attachment.historyRef.attachmentId}', '{type:attachment.historyKind === "file" ? "file_ref" : "image_ref",attachmentId:attachment.historyRef.attachmentId,...attachment.historyKind === "file" ? {name:attachment.file.name} : {}}');
    text = once(text, 'kind: "image",\n\t\t\t\tid: crypto.randomUUID(),', 'kind: attachmentKind(file),\n\t\t\t\tid: crypto.randomUUID(),')
    text = once(text, 'for (const file of files) imageMediaType(file.type);', 'validateAttachments(files);')
    text = once(text, 'type: "image",\n\t\t\t\t\t...await this.encodeImage(file)', 'type: attachmentKind(file),\n\t\t\t\t\t...await this.encodeImage(file)')
    text = once(text, 'mediaType: imageMediaType(file.type),', 'mediaType: attachmentMediaType(file),')
    text = once(text, 'return Promise.all(attachments.map((attachment) => this.encodeImage(attachment.file)));', 'if (attachments.some(a => a.kind === "file" || a.historyKind === "file")) throw Error("斜杠命令暂不支持普通文件附件，请作为普通消息发送；草稿已保留。");\n return Promise.all(attachments.map((attachment) => this.encodeImage(attachment.file)));')
    const begin = text.indexOf('\t\t\t\tconst rejected = (() => {', text.indexOf('const intakeImages ='))
    const end = text.indexOf('\n\t\t\t\tif (rejected !== null)', begin)
    if (begin < 0 || end < 0) throw Error('Missing upstream intake validation')
    text = text.slice(0,begin) + `\t\t\t\tconst rejected = (() => {
      try { validateAttachments([...attachments.map(a => a.file), ...files]); }
      catch (error) { return error.message; }
      return addImages(files);
    })();` + text.slice(end)
    text = once(text, 'else if (b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });', 'else if ((b.type === "image" || b.type === "file") && b.attachment !== void 0) images.push({ attachment: b.attachment, kind: b.type });')
    text += '\n' + marker
  } else if (id === '@deepseek-ai/dsh-client-ui-attachment') {
    const helper = readFileSync(resolve(root,'ui/overrides/attachment-cards.js'),'utf8')
    text = once(text, '\t\tfunction ComposerAttachments(', helper + '\n\t\tfunction ComposerAttachments(')
    text = once(text, 'children: items.map((item) => (0, react_jsx_runtime.jsxs)("div", {', `children: items.map((item) => item.attachment.kind === 'file' ? (0,react_jsx_runtime.jsx)(XHarnessFileCard,{name:item.attachment.file.name,bytes:item.attachment.file.size,onRemove:()=>onRemove(item),removeLabel:item.removeLabel},item.id) : (0, react_jsx_runtime.jsxs)("div", {`)
    text = once(text, 'const railItems = (0, react.useMemo)', 'const picker = (0, react.useRef)(null);\n\t\t\tconst railItems = (0, react.useMemo)')
    text = once(text, 'dragActive && (0, react_jsx_runtime.jsx)(DropOverlay, {', `(0,react_jsx_runtime.jsxs)('div',{className:'xh-attachment-toolbar',children:[
      (0,react_jsx_runtime.jsx)('button',{type:'button',disabled:!canAcceptDrop,onClick:()=>picker.current?.click(),children:'＋ 添加附件',title:'拖入、粘贴或选择图片及文件'}),
      (0,react_jsx_runtime.jsx)('input',{ref:picker,type:'file',multiple:true,hidden:true,'aria-label':'添加附件',onChange:event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(canAcceptDrop&&files.length)onAddImages(files);}})
    ]}),
    dragActive && (0, react_jsx_runtime.jsx)(DropOverlay, {`)
    text = once(text, 'title: t("image.dropTitle"),', 'title: "拖入图片或文件",')
    text = once(text, 'desc: limits === void 0 ? void 0 : t("image.dropDesc", limits)', 'desc: "图片 ≤ 20 MiB / 张，普通文件 ≤ 32 MiB；本次合计 ≤ 96 MiB"')
    text = once(text, 'children: images.map((image, index) => (0, react_jsx_runtime.jsx)(MessageImage, {', `children: images.map((image, index) => image.kind === 'file' || image.attachment.width == null ? (0,react_jsx_runtime.jsx)(XHarnessHistoryFile,{attachment:image.attachment,load},image.attachment.attachmentId+':'+index) : (0, react_jsx_runtime.jsx)(MessageImage, {`)
    text += '\n' + marker
  } else if (id === '@deepseek-ai/dsh-client-runtime') {
    text=once(text, 'part.type === "image" || part.type === "image_ref"', 'part.type === "image" || part.type === "image_ref" || part.type === "file" || part.type === "file_ref"');
    text += '\n' + marker;
  } else if (id === '@deepseek-ai/dsh-client-ui-settings-models') {
    text=once(text, '...candidate.name === void 0 ? {} : { name: candidate.name },', '...candidate.name === void 0 ? {} : { name: candidate.name },\n ...typeof candidate.imageInput === "boolean" ? {imageInput:candidate.imageInput} : {},');
    text = once(text, 'className: ModelsSection_module_css_default["modelAdvanced"],\n\t\t\t\t\t\t\tchildren: [', `className: ModelsSection_module_css_default["modelAdvanced"],
      children: [(0,react_jsx_runtime.jsxs)('label',{className:ModelsSection_module_css_default['modelField'],children:[
        (0,react_jsx_runtime.jsx)('span',{children:'支持图片输入'}),
        (0,react_jsx_runtime.jsx)('input',{type:'checkbox',disabled,checked:model.imageInput===true,'aria-label':'支持图片输入 '+(index+1),onChange:event=>patch(index,{imageInput:event.target.checked})}),
        (0,react_jsx_runtime.jsx)('small',{children:model.imageInput===undefined?'视觉能力未声明；请确认模型 API 支持后启用。':'不支持视觉时明确报错，不自动丢弃图片。'})
      ]}),`);
    text += '\n' + marker;
  }
  return Buffer.from(text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] || resolve(root,'ui/dist'))
  const graphPath = resolve(dist,'client-graph.json'), graph = JSON.parse(readFileSync(graphPath,'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0,16)
  for (const entry of graph.entries) {
    if (!['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-attachment','@deepseek-ai/dsh-client-ui-settings-models','@deepseek-ai/dsh-client-runtime'].includes(entry.id)) continue
    const path = resolve(dist,'plugins',entry.id,'client.js')
    const bytes = patchAttachments(entry.id,readFileSync(path));writeFileSync(path,bytes)
    try { unlinkSync(path+'.map') } catch(error) { if(error.code !== 'ENOENT') throw error }
    entry.rev=hash(bytes);entry.url='/plugins/'+entry.id+'/client.js?rev='+entry.rev
  }
  graph.rev=hash(JSON.stringify(graph.entries));writeFileSync(graphPath,JSON.stringify(graph,null,2)+'\n')
  const index=resolve(dist,'index.html'),html=readFileSync(index,'utf8')
  if(!/window\.__DSH_BOOT__ = .*?<\/script>/.test(html))throw Error('missing boot graph')
  writeFileSync(index,html.replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
  console.log('Shared attachment UI synchronized: '+graph.rev)
}
