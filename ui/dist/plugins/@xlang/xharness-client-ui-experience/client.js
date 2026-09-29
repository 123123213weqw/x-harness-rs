// XHarness-owned presentation controls.  This stays separate from upstream's
// shortcut service because the shipped static UI still uses the older Host RPC.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-experience',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React
    const MODES = ['compact', 'standard', 'detailed', 'verbose']
    const MODE_KEY = 'xharness.ui.process-mode.v1'
    const SHORTCUT_KEY = 'xharness.ui.shortcuts.v1'
    const DEFAULT_SHORTCUTS = Object.freeze({ cycleMode: 'Mod+Shift+J', focusComposer: 'Mod+Shift+L' })
    const CSS = `
.xhe-root{display:grid;gap:25px;padding:5px 0 24px;color:var(--dsw-alias-label-primary)}
.xhe-root h2{margin:0;font-size:23px;font-weight:600;letter-spacing:-.03em}
.xhe-root h3{margin:0 0 9px;font-size:14px;font-weight:600}
.xhe-root p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.xhe-root section{min-width:0}.xhe-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.xhe-option{min-height:66px;text-align:left;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.xhe-option:hover,.xhe-option:focus-visible{border-color:var(--dsw-alias-label-secondary);outline:none}
.xhe-option[aria-pressed=true]{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.xhe-option strong{display:block;font-size:13px}.xhe-option span{display:block;margin-top:4px;font-size:11px;opacity:.7}
.xhe-search{box-sizing:border-box;width:100%;height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.xhe-search:focus-visible,.xhe-key:focus-visible,.xhe-reset:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.xhe-shortcuts{display:grid;gap:0;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;overflow:hidden}
.xhe-shortcut{display:flex;align-items:center;gap:12px;min-height:46px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}.xhe-shortcut:last-child{border-bottom:0}
.xhe-shortcut span{flex:1;min-width:0;font-size:12px}.xhe-key,.xhe-reset{font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px}
.xhe-key[data-recording=true]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.xhe-note{color:var(--dsw-alias-state-error-primary)!important}.xhe-footer{display:flex;justify-content:flex-end;margin-top:9px}
html[data-xh-process-mode=compact] [data-variant=think] .U8JO7q_summary{display:none}
@media(max-width:700px){.xhe-options{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
    const labels = {
      zh: { nav: '显示与快捷键', title: '显示与快捷键', subtitle: '只改变工作过程的呈现，不改变模型、工具或历史记录。',
        display: '工作步骤展示', compact: '简洁', standard: '标准', detailed: '详细', verbose: '完全展开',
        compactHint: '最少预览', standardHint: '默认密度', detailedHint: '展开运行项', verboseHint: '展开全部项',
        shortcut: '键盘快捷键', search: '搜索快捷键', cycleMode: '切换工作步骤展示', focusComposer: '聚焦输入框',
        record: '按下新组合键…', reset: '恢复默认', conflict: '该组合键已被其他操作使用', invalid: '请同时按修饰键',
        empty: '没有匹配的快捷键', local: '这些偏好只保存在当前设备。' },
      en: { nav: 'Display & shortcuts', title: 'Display & shortcuts', subtitle: 'Changes presentation only; model, tools and history remain intact.',
        display: 'Work process display', compact: 'Compact', standard: 'Standard', detailed: 'Detailed', verbose: 'Fully expanded',
        compactHint: 'Minimal preview', standardHint: 'Default density', detailedHint: 'Expand live items', verboseHint: 'Expand all items',
        shortcut: 'Keyboard shortcuts', search: 'Search shortcuts', cycleMode: 'Cycle process display', focusComposer: 'Focus composer',
        record: 'Press a new shortcut…', reset: 'Reset defaults', conflict: 'This shortcut is already in use', invalid: 'Include a modifier key',
        empty: 'No matching shortcuts', local: 'These preferences are stored on this device only.' },
    }

    function readStorage(key) { try { return localStorage.getItem(key) } catch { return null } }
    function writeStorage(key, value) { try { localStorage.setItem(key, value) } catch { /* memory-only preference */ } }
    function initialMode() { const mode = readStorage(MODE_KEY); return MODES.includes(mode) ? mode : 'standard' }
    function initialShortcuts() {
      try {
        const saved = JSON.parse(readStorage(SHORTCUT_KEY) || 'null')
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          const result = { ...DEFAULT_SHORTCUTS }
          for (const key of Object.keys(result)) if (typeof saved[key] === 'string' && saved[key].length < 70) result[key] = saved[key]
          if (new Set(Object.values(result)).size === Object.values(result).length) return result
        }
      } catch { /* invalid/old settings fall back */ }
      return { ...DEFAULT_SHORTCUTS }
    }
    let mode = initialMode()
    let shortcuts = initialShortcuts()
    const listeners = new Set()
    function publish() { for (const listener of listeners) listener() }
    function setMode(next) {
      if (!MODES.includes(next)) return false
      mode = next
      document.documentElement.dataset.xhProcessMode = next
      writeStorage(MODE_KEY, next)
      window.dispatchEvent(new Event('xh-process-mode'))
      publish()
      return true
    }
    function setShortcuts(next) {
      if (Object.values(next).some(value => typeof value !== 'string') || new Set(Object.values(next)).size !== Object.values(next).length) return false
      shortcuts = { ...next }
      writeStorage(SHORTCUT_KEY, JSON.stringify(shortcuts))
      publish()
      return true
    }
    function chord(event) {
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return ''
      const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
      return [event.metaKey || event.ctrlKey ? 'Mod' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+')
    }
    function handleShortcut(event) {
      if (event.isComposing || event.repeat || event.defaultPrevented) return
      const pressed = chord(event)
      if (pressed === shortcuts.cycleMode) {
        event.preventDefault()
        setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
      } else if (pressed === shortcuts.focusComposer) {
        const composer = document.querySelector('[contenteditable="true"], textarea:not([readonly])')
        if (composer) { event.preventDefault(); composer.focus() }
      }
    }
    function useSnapshot() {
      const [, render] = useState(0)
      useEffect(() => { const listener = () => render(value => value + 1); listeners.add(listener); return () => listeners.delete(listener) }, [])
      return { mode, shortcuts }
    }
    function Settings({ t }) {
      const state = useSnapshot()
      const [query, setQuery] = useState('')
      const [recording, setRecording] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        if (recording === null) return
        const capture = (event) => {
          event.preventDefault(); event.stopPropagation()
          if (event.key === 'Escape') { setRecording(null); setError(''); return }
          const pressed = chord(event)
          if (!pressed) return
          if (!pressed.includes('Mod') && !pressed.includes('Alt')) { setError(t('invalid')); return }
          if (Object.entries(shortcuts).some(([id, value]) => id !== recording && value === pressed)) { setError(t('conflict')); return }
          setShortcuts({ ...shortcuts, [recording]: pressed }); setRecording(null); setError('')
        }
        window.addEventListener('keydown', capture, true)
        return () => window.removeEventListener('keydown', capture, true)
      }, [recording, t])
      const visible = Object.keys(DEFAULT_SHORTCUTS).filter(id => `${t(id)} ${state.shortcuts[id]}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      return h('div', { className: 'xhe-root' }, [
        h('header', { key: 'header' }, [h('h2', { key: 'title' }, t('title')), h('p', { key: 'subtitle' }, t('subtitle'))]),
        h('section', { key: 'display' }, [h('h3', { key: 'title' }, t('display')),
          h('div', { className: 'xhe-options', role: 'group', 'aria-label': t('display'), key: 'options' }, MODES.map(id => h('button', {
            type: 'button', className: 'xhe-option', 'aria-pressed': state.mode === id, onClick: () => setMode(id), key: id,
          }, [h('strong', { key: 'name' }, t(id)), h('span', { key: 'hint' }, t(`${id}Hint`))])))]),
        h('section', { key: 'shortcuts' }, [h('h3', { key: 'title' }, t('shortcut')),
          h('input', { className: 'xhe-search', type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: event => setQuery(event.target.value), key: 'search' }),
          h('div', { className: 'xhe-shortcuts', key: 'list' }, visible.length ? visible.map(id => h('div', { className: 'xhe-shortcut', key: id }, [
            h('span', { key: 'label' }, t(id)), h('button', { className: 'xhe-key', type: 'button', 'data-recording': recording === id, onClick: () => { setRecording(id); setError('') }, key: 'key' }, recording === id ? t('record') : state.shortcuts[id]),
          ])) : h('p', { key: 'empty' }, t('empty'))),
          error && h('p', { className: 'xhe-note', role: 'alert', key: 'error' }, error),
          h('div', { className: 'xhe-footer', key: 'footer' }, h('button', { className: 'xhe-reset', type: 'button', onClick: () => { setShortcuts(DEFAULT_SHORTCUTS); setRecording(null); setError('') } }, t('reset'))),
          h('p', { key: 'local' }, t('local'))]),
      ])
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('xharness-experience', labels), 'xharness-experience: locale')
      ctx.effect(() => {
        if (document.getElementById('xharness-experience-css')) return () => {}
        const style = document.createElement('style'); style.id = 'xharness-experience-css'; style.textContent = CSS; document.head.append(style)
        return () => style.remove()
      }, 'xharness-experience: styles')
      ctx.effect(() => {
        setMode(mode)
        window.addEventListener('keydown', handleShortcut)
        return () => window.removeEventListener('keydown', handleShortcut)
      }, 'xharness-experience: shortcuts')
      const t = ctx.locale.bind('xharness-experience')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'experience', order: 35, label: () => t('nav'), inject: () => ({ t }),
      }, Settings))
    }
    module.exports = { apply, inject, _test: { chord, setMode, setShortcuts, initialMode, initialShortcuts, MODE_KEY, SHORTCUT_KEY } }
    return module.exports
  },
})
