// Run after durable attachment adaptation, for both existing bundles and rebuilds.
import { readFileSync } from 'node:fs'
const marker = '// XHARNESS COMPOSER ADD MENU v1'
function once(text, before, after) {
  if (text.split(before).length !== 2) throw Error('Composer add menu signature changed: ' + before.slice(0, 90))
  return text.replace(before, after)
}
export function patchComposerAddMenu(id, bytes) {
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  if (text.includes(marker)) return Buffer.from(text)
  if (id === '@deepseek-ai/dsh-client-ui-conversation') {
    const helper = readFileSync(new URL('../ui/overrides/composer-add-menu.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    text = once(text, '\t\tfunction InputBar(', helper + '\n\t\tfunction InputBar(')
    const plus = /\(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Tooltip, \{\s*label: t\("input\.commands"\),[\s\S]*?children: \(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.IconPlusOutline16, \{ size: 14 \}\)\s*\}\)\s*\}\)/g
    const matches = [...text.matchAll(plus)]
    if (matches.length !== 1) throw Error('Composer plus trigger signature changed')
    text = once(text, matches[0][0], `(0, react_jsx_runtime.jsx)(XHarnessComposerAddMenu, {
      key: sessionId,
      className: InputBar_module_css_default.add,
      canAttach: canAcceptDrop,
      canCommands: !locked && !machineBusy && toggleCommandMenu !== void 0,
      onAddFiles: intakeImages,
      onCommands: onToggleCommandMenu,
      onOpen: () => { if (commandMenuOpen) onToggleCommandMenu(); },
      focusInput: () => inputRef.current?.focus({ preventScroll: true }),
      t
    })`)
    for (const [commands, add, attach] of [['命令', '添加附件或命令', '添加图片或文件'], ['Commands', 'Add attachments or commands', 'Add images or files']]) {
      const anchor = '"input.commands": ' + JSON.stringify(commands) + ','
      text = once(text, anchor, anchor + '\n"input.add": ' + JSON.stringify(add) + ',\n"input.attachFiles": ' + JSON.stringify(attach) + ',')
    }
  } else if (id === '@deepseek-ai/dsh-client-ui-attachment') {
    text = once(text, 'const picker = (0, react.useRef)(null);\n\t\t\t', '')
    const toolbar = /\(0,react_jsx_runtime\.jsxs\)\('div',\{className:'xh-attachment-toolbar',children:\[[\s\S]*?\]\}\),\s*(?=dragActive &&)/g
    const matches = [...text.matchAll(toolbar)]
    if (matches.length !== 1) throw Error('Legacy attachment toolbar signature changed')
    text = once(text, matches[0][0], '')
    // Remove only obsolete toolbar selectors, retaining card focus styles.
    text = text.replace('.xh-file-card :focus-visible,.xh-attachment-toolbar :focus-visible', '.xh-file-card :focus-visible')
      .replaceAll(/\.xh-attachment-toolbar[^{}]*\{[^{}]*\}/g, '')
  } else return bytes
  return Buffer.from(text.trimEnd() + '\n' + marker + '\n')
}
