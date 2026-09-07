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
    '\t\t\t\t\tclassName: MessageItem_module_css_default.actions,\n\t\t\t\t\textraActions: editAvailable && text.length > 0 ? (0, react_jsx_runtime.jsx)(XHarnessEditAction, { text, editMessage, t }) : null,\n\t\t\t\t\tt\n\t\t\t\t})\n\t\t\t});\n\t\t});\n\t\t/** Injected-context keyed Chat renderer. */',
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
    '\t\t\t\t\t\teditMessage: (text) => xhEditMessage(inputHub, sessionId, text),\n\t\t\t\t\t\tchatScroll: {',
  )
  text = once(text, '\t\texports.ConversationController = ConversationController;', '\t\texports.xhEditMessage = xhEditMessage;\n\t\texports.ConversationController = ConversationController;')
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd() + '\n')
}

export function refreshConversationMessageEdit(dist) {
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const id = '@deepseek-ai/dsh-client-ui-conversation'
  const path = resolve(dist, `plugins/${id}/client.js`)
  const bytes = patchConversationMessageEdit(readFileSync(path))
  const entry = graph.entries.find(candidate => candidate.id === id)
  if (!entry) throw new Error(`missing graph entry: ${id}`)
  entry.rev = hash(bytes)
  entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  graph.rev = hash(JSON.stringify(graph.entries))

  const indexPath = resolve(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  if (!/window\.__DSH_BOOT__ = .*?<\/script>/.test(html)) throw new Error('missing boot graph')
  writeFileSync(path, bytes)
  try { unlinkSync(`${path}.map`) } catch (error) { if (error.code !== 'ENOENT') throw error }
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(indexPath, html.replace(/window\.__DSH_BOOT__ = .*?<\/script>/, `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshConversationMessageEdit(resolve(process.argv[2] ?? resolve(root, 'ui/dist')))
}
