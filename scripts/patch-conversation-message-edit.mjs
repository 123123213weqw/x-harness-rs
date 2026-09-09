#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'ui/overrides/conversation-message-edit.js'), 'utf8').replaceAll('\r\n', '\n')
const begin = '// XHARNESS CONVERSATION MESSAGE EDIT BEGIN\n'
const end = '// XHARNESS CONVERSATION MESSAGE EDIT END\n'

function once(text, before, after) {
  if (text.split(before).length !== 2) {
    throw new Error(`upstream conversation message-edit signature changed: ${before.slice(0, 100)}`)
  }
  return text.replace(before, after)
}

export function patchConversationMessageEdit(bytes) {
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  if (text.includes(begin)) {
    const start = text.indexOf(begin)
    const finish = text.indexOf(end, start)
    if (finish < 0) throw new Error('unterminated conversation message-edit source')
    text = text.slice(0, start) + begin + source + end + text.slice(finish + end.length)
    return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd() + '\n')
  }

  text = once(
    text,
    '\t\tfunction MessageIconActions({ text, time, runMs, ttftMs, tokensPerSecond, clock, onBranch, branchUnavailable = false, className, extraActions, t }) {',
    `${begin}${source}${end}\t\tfunction MessageIconActions({ text, time, runMs, ttftMs, tokensPerSecond, clock, onBranch, branchUnavailable = false, className, extraActions, t }) {`,
  )
  text = once(
    text,
    'function UserMessageNodeView({ node, renderMessageImages, t }) {',
    'function UserMessageNodeView({ node, renderMessageImages, editMessage, editAvailable, t }) {',
  )
  text = once(
    text,
    '\t\t\t\t\tclassName: MessageItem_module_css_default.actions,\n\t\t\t\t\tt\n\t\t\t\t})\n\t\t\t});\n\t\t});\n\t\t/** Injected-context keyed Chat renderer. */',
    '\t\t\t\t\tclassName: MessageItem_module_css_default.actions,\n\t\t\t\t\textraActions: editAvailable && data.content.length > 0 ? (0, react_jsx_runtime.jsx)(XHarnessEditAction, { content: data.content, editMessage, t }) : null,\n\t\t\t\t\tt\n\t\t\t\t})\n\t\t\t});\n\t\t});\n\t\t/** Injected-context keyed Chat renderer. */',
  )
  text = once(
    text,
    'function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, useSession, renderSlot, t }) {',
    'function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, editAvailable, renderMessageImages, fileMentions, useSession, renderSlot, t }) {',
  )
  text = once(
    text,
    '\t\t\tconst owner = (0, react.useMemo)(() => node === void 0 ? null : {\n\t\t\t\tselectedCallId,\n\t\t\t\tcwd,\n\t\t\t\topenFile,\n\t\t\t\tinspectCall,\n\t\t\t\tforkAt,\n\t\t\t\trenderMessageImages,\n\t\t\t\tfileMentions\n\t\t\t}, [\n\t\t\t\tnode,\n\t\t\t\tselectedCallId,\n\t\t\t\tcwd,\n\t\t\t\topenFile,\n\t\t\t\tinspectCall,\n\t\t\t\tforkAt,\n\t\t\t\trenderMessageImages,\n\t\t\t\tfileMentions\n\t\t\t]);',
    '\t\t\tconst owner = (0, react.useMemo)(() => node === void 0 ? null : {\n\t\t\t\tselectedCallId,\n\t\t\t\tcwd,\n\t\t\t\topenFile,\n\t\t\t\tinspectCall,\n\t\t\t\tforkAt,\n\t\t\t\teditMessage,\n\t\t\t\teditAvailable,\n\t\t\t\trenderMessageImages,\n\t\t\t\tfileMentions\n\t\t\t}, [\n\t\t\t\tnode,\n\t\t\t\tselectedCallId,\n\t\t\t\tcwd,\n\t\t\t\topenFile,\n\t\t\t\tinspectCall,\n\t\t\t\tforkAt,\n\t\t\t\teditMessage,\n\t\t\t\teditAvailable,\n\t\t\t\trenderMessageImages,\n\t\t\t\tfileMentions\n\t\t\t]);',
  )
  text = once(
    text,
    'function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {',
    'function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, editMessage, fileMentions, t }) {',
  )
  text = once(text, '\t\t\t\t\t\t\t\tforkAt,\n\t\t\t\t\t\t\t\trenderMessageImages,', '\t\t\t\t\t\t\t\tforkAt,\n\t\t\t\t\t\t\t\teditMessage,\n\t\t\t\t\t\t\t\teditAvailable: !running,\n\t\t\t\t\t\t\t\trenderMessageImages,')
  text = once(text, '\t\t\t"message.stopped": "已停止",', '\t\t\t"message.stopped": "已停止",\n\t\t\t"message.edit": "编辑并重新发送",')
  text = once(text, '\t\t\t"message.stopped": "Stopped",', '\t\t\t"message.stopped": "Stopped",\n\t\t\t"message.edit": "Edit and resend",')
  text = once(
    text,
    '\t\t\t\t\t\tchatScroll: {',
    '\t\t\t\t\t\teditMessage: (content) => xhEditMessage(inputHub, sessionId, content),\n\t\t\t\t\t\tchatScroll: {',
  )
  text = once(text, '\t\texports.ConversationController = ConversationController;', '\t\texports.XHarnessMessageEditor = XHarnessMessageEditor;\n\t\texports.XHarnessEditableInputBar = XHarnessEditableInputBar;\n\t\texports.xhEditMessage = xhEditMessage;\n\t\texports.ConversationController = ConversationController;')
  text = once(text, '\t\t\t\tthis.shells.set(id, shell);', '\t\t\t\tthis.shells.set(id, shell);\n\t\t\t\txhAttachEditor(this, id, shell);');
  text = once(text, '}, InputBar);', '}, XHarnessEditableInputBar);');
  text = once(text, 'async sendSession(session, text, imageIds, mode, signal) {', 'async sendSession(session, text, imageIds, mode, signal, requireIdle = false) {');
  text = once(text, '...await this.serializeImages(attachments.map((attachment) => attachment.file))', '...await Promise.all(attachments.map(async attachment => attachment.historyRef ? {type:"image_ref",attachmentId:attachment.historyRef.attachmentId} : (await this.serializeImages([attachment.file]))[0]))');
  text = once(text, 'session.prompt(content, mode, signal)', 'session.prompt(content, mode, signal, {requireIdle})');
  text = once(text, 'return this.conversation().sendSession(session, text, imageIds, mode, signal);', 'return this.conversation().sendSession(session, text, imageIds, mode, signal, this.shell(session.sessionId).xhEditor?.state.editing === true);');
  // Do not release an image while a pending admission still owns it.
  text = once(text, 'conversation.releaseDraftImage(id);\n\t\t\t\t\t\t\tshell.removeImage(id);', 'shell.removeImage(id);\n\t\t\t\t\t\t\tif (!shell.snapshot.imageIds.includes(id)) conversation.releaseDraftImage(id);');
  text = once(text, 'if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;', 'if (this.imageSendInFlight || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;');
  text = once(text, 'if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return;', 'if (this.imageSendInFlight || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return;');
  const settled = 'if (outcome.kind === "success" && imageIds.length > 0) {';
  if (text.split(settled).length !== 3) throw new Error("upstream submit settlement signatures changed");
  text = text.replaceAll(settled, 'if (outcome.kind === "success") this.xhEditor?.sent();\n\t\t\t\t\t'+settled);
  const labels = {
    editReplace: ['替换当前草稿？原草稿会暂存，取消编辑可恢复。','Replace current draft? Cancel editing to restore it.'],
    editConfirm:['替换草稿','Replace draft'], editCancel:['取消编辑','Cancel editing'],
    editRecovered:['发现未完成的历史消息编辑','Unfinished message edit found'], editResume:['恢复编辑','Resume editing'],
    editActive:['正在编辑历史消息 · 发送后开启新一轮','Editing a historical message · sends a new turn'],
    editSaving:['正在保存原草稿…','Saving original draft…'], editLoading:['正在恢复附件…','Restoring attachment…'],
    editMissing:['附件未就绪或已丢失，请重试、重新上传或主动移除','Attachment missing or not ready: retry, reattach or remove it'],
    editRetry:['重试','Retry'],editRemove:['移除附件','Remove attachment'],
    editChanged:['草稿或任务状态已变化，未覆盖；请先处理当前草稿再重试','Draft or task changed; nothing overwritten. Resolve the current draft and retry.'],
    editRunning:['任务已经开始运行，请停止后再发送编辑消息','The agent is running; stop it before resending the edited message'],
    editFinish:['请先完成或取消当前编辑','Finish or cancel the current edit first'],
    editUnsupported:['此消息含不支持恢复的内容，未修改草稿','This message contains unsupported content; draft unchanged'],
    editStorage:['无法持久保存编辑草稿','Could not persist the edited draft']
  };
  for (const [locale, index] of [['已停止',0],['Stopped',1]]) {
    const anchor = '"message.stopped": '+JSON.stringify(locale)+',';
    text = once(text, anchor, anchor+'\n'+Object.entries(labels).map(([key,pair])=>'"message.'+key+'": '+JSON.stringify(pair[index])+',').join('\n'));
  }
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd() + '\n')
}

export function patchMessageEditConnection(bytes) {
  let text=bytes.toString('utf8').replaceAll('\r\n','\n');
  if (text.includes('// xharness-edit-reference-wire/v1')) return Buffer.from(text);
  text=once(text, 'const promptContentPartSchema = discriminatedUnion("type", [object({',
    '// xharness-edit-reference-wire/v1\nconst promptContentPartSchema = discriminatedUnion("type", [object({type:literal("image_ref"),attachmentId:string().min(1)}),object({');
  text=once(text, 'content: array(promptContentPartSchema),', 'content: array(promptContentPartSchema),\nrequireIdle: boolean().optional(),');
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd()+'\n');
}
export function patchMessageEditRuntime(bytes) {
  let text=bytes.toString('utf8').replaceAll('\r\n','\n');
  if(text.includes('// xharness-edit-admission/v1')) return Buffer.from(text);
  text=once(text, 'async prompt(content, mode, signal) {', '// xharness-edit-admission/v1\nasync prompt(content, mode, signal, options = {}) {');
  text=once(text, '\t\t\t\t\t\tcontent,\n\t\t\t\t\t\tclientTimeZone: resolvedClientTimeZone()', '\t\t\t\t\t\tcontent,\n\t\t\t\t\t\t...(options.requireIdle === true ? {requireIdle:true} : {}),\n\t\t\t\t\t\tclientTimeZone: resolvedClientTimeZone()');
  text=once(text, 'content.some((part) => part.type === "image")', 'content.some((part) => part.type === "image" || part.type === "image_ref")');
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd()+'\n');
}

export function refreshConversationMessageEdit(dist) {
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  for (const [id, patch] of [
    ['@deepseek-ai/dsh-client-ui-conversation', patchConversationMessageEdit],
    ['@deepseek-ai/dsh-client-connection', patchMessageEditConnection],
    ['@deepseek-ai/dsh-client-runtime', patchMessageEditRuntime],
  ]) {
    const path = resolve(dist, `plugins/${id}/client.js`);
    const bytes = patch(readFileSync(path));
    const entry = graph.entries.find(candidate => candidate.id === id);
    if (!entry) throw new Error(`missing graph entry: ${id}`);
    entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`;
    writeFileSync(path, bytes);
    try { unlinkSync(`${path}.map`) } catch(error) { if(error.code !== 'ENOENT') throw error }
  }
  graph.rev = hash(JSON.stringify(graph.entries))

  const indexPath = resolve(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  if (!/window\.__DSH_BOOT__ = .*?<\/script>/.test(html)) throw new Error('missing boot graph')
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(indexPath, html.replace(/window\.__DSH_BOOT__ = .*?<\/script>/, `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshConversationMessageEdit(resolve(process.argv[2] ?? resolve(root, 'ui/dist')))
}
