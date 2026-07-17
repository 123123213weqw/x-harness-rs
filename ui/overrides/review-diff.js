// XHarness selective backport of the upstream diff review affordance.  The
// existing DiffBlock remains the inline renderer; this adds side-by-side
// review without changing the Host's diff render-intent wire shape.
const XH_DIFF_STYLE = `
.xh-review{min-width:0;margin:4px 0;color:var(--dsw-alias-label-primary)}
.xh-review-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 4px}
.xh-review-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.xh-review-actions{display:flex;gap:3px;align-items:center}
.xh-review-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.xh-review-actions button:hover,.xh-review-actions button:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);outline:none}
.xh-review-actions button[aria-pressed=true]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.xh-review-file{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin:4px 0 9px;background:var(--dsw-alias-markdown-code-block)}
.xh-review-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font:600 11px/17px ui-monospace,SFMono-Regular,Menlo,monospace}
.xh-review-panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.xh-review-pane{min-width:0;max-height:400px;overflow:auto;scrollbar-gutter:stable;font:11px/19px ui-monospace,SFMono-Regular,Menlo,monospace}
.xh-review-pane:first-child{border-right:1px solid var(--dsw-alias-border-l2)}
.xh-review-pane-heading{position:sticky;top:0;z-index:1;display:block;padding:4px 8px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:600 10px/16px system-ui,sans-serif}
.xh-review-line{display:flex;white-space:pre;min-height:19px;padding-right:8px}.xh-review-line[data-changed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.xh-review-line-number{position:sticky;left:0;flex:none;box-sizing:border-box;width:35px;text-align:right;padding-right:7px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-markdown-code-block);user-select:none}
.xh-review-line-code{display:block}.xh-review-truncated{padding:7px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l2)}
@media(max-width:650px){.xh-review-panes{grid-template-columns:minmax(0,1fr)}.xh-review-pane:first-child{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}}
`
if (typeof document !== 'undefined' && !document.getElementById('xh-review-diff-style')) {
  const style = document.createElement('style')
  style.id = 'xh-review-diff-style'
  style.textContent = XH_DIFF_STYLE
  document.head.appendChild(style)
}

function xhDiffLines(text) {
  if (typeof text !== 'string' || text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}
function XHReviewDiffBlock({ diffs, maxLines, className, stateKey = "" }) {
  const [layout, setLayout] = react.useState(() => {
    try { return localStorage.getItem('xharness.ui.diff-layout.v1') === 'split' ? 'split' : 'inline' } catch { return 'inline' }
  })
  const [expanded, setExpanded] = globalThis.__xhTranscriptState?.get(react.createElement) ? globalThis.__xhTranscriptState.get(react.createElement).useState("diff:" + stateKey, false) : react.useState(false)
  const [copied, setCopied] = react.useState(false)
  const translate = (zh, en) => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? zh : en
  const changeLayout = value => {
    setLayout(value)
    try { localStorage.setItem('xharness.ui.diff-layout.v1', value) } catch { /* memory only */ }
  }
  const copy = async () => {
    const text = diffs.map(({ path, oldText, newText }) => `${path}\n--- before\n${oldText ?? ''}\n+++ after\n${newText}`).join('\n\n')
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200) } catch { /* no clipboard permission */ }
  }
  const maxPreview = 500
  const panes = layout === 'split' ? diffs.map((diff, index) => {
    const oldLines = xhDiffLines(diff.oldText)
    const newLines = xhDiffLines(diff.newText)
    const length = Math.max(oldLines.length, newLines.length)
    const absoluteCap = 3000 // never mount an unbounded number of DOM rows
    const shown = Math.min(length, expanded ? absoluteCap : maxPreview)
    const left = react.createRef(), right = react.createRef()
    const syncing = { active: false }
    const sync = (from, to) => {
      if (syncing.active || !from || !to) return
      syncing.active = true
      to.scrollTop = from.scrollTop; to.scrollLeft = from.scrollLeft
      requestAnimationFrame(() => { syncing.active = false })
    }
    const side = (lines, other, title, ref, otherRef) => react.createElement('div', {
      className: 'xh-review-pane', ref, onScroll: event => sync(event.currentTarget, otherRef.current), key: title,
    }, [react.createElement('span', { className: 'xh-review-pane-heading', key: 'heading' }, title),
      ...Array.from({ length: shown }, (_, lineIndex) => react.createElement('div', {
        className: 'xh-review-line', 'data-changed': lines[lineIndex] !== other[lineIndex], key: lineIndex,
      }, [react.createElement('span', { className: 'xh-review-line-number', key: 'number' }, lineIndex < lines.length ? lineIndex + 1 : ''),
        react.createElement('span', { className: 'xh-review-line-code', key: 'code' }, lines[lineIndex] ?? ' ')]))])
    return react.createElement('div', { className: 'xh-review-file', key: `${diff.path}:${index}` }, [
      react.createElement('div', { className: 'xh-review-path', title: diff.path, key: 'path' }, diff.path),
      react.createElement('div', { className: 'xh-review-panes', key: 'panes' }, [
        side(oldLines, newLines, translate('修改前', 'Before'), left, right),
        side(newLines, oldLines, translate('修改后', 'After'), right, left),
      ]),
      length > maxPreview && react.createElement('button', { type: 'button', className: 'xh-review-truncated', onClick: () => setExpanded(value => !value), key: 'more' },
        expanded ? translate(length > absoluteCap ? `仅预览前 ${absoluteCap} 行 · 点击收起，完整内容可复制` : '收起', length > absoluteCap ? `Preview capped at ${absoluteCap} lines · full diff can be copied` : 'Show less')
          : translate(`展开预览（${length} 行）`, `Expand preview (${length} lines)`)),
    ])
  }) : null
  return react.createElement('div', { className: `xh-review ${className || ''}`, 'data-xh-diff-layout': layout }, [
    react.createElement('div', { className: 'xh-review-toolbar', key: 'toolbar' }, [
      react.createElement('span', { className: 'xh-review-title', key: 'title' }, translate('文件差异', 'File diff')),
      react.createElement('div', { className: 'xh-review-actions', role: 'group', 'aria-label': translate('差异布局', 'Diff layout'), key: 'actions' }, [
        ...['inline', 'split'].map(value => react.createElement('button', { type: 'button', 'aria-pressed': layout === value, onClick: () => changeLayout(value), key: value },
          value === 'inline' ? translate('行内', 'Inline') : translate('并排', 'Side by side'))),
        layout === 'split' && react.createElement('button', { type: 'button', onClick: copy, key: 'copy' }, copied ? translate('已复制', 'Copied') : translate('复制', 'Copy')),
      ]),
    ]),
    layout === 'inline'
      ? react.createElement(_xharness_dsh_client_ui_primitives.DiffBlock, { diffs, maxLines, className, key: 'inline' })
      : react.createElement('div', { key: 'split' }, panes),
  ])
}
