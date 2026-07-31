/// <reference path="../shared/assets.d.ts" />
import * as React from "react"
import type { PageContext, Translation } from "../shared/runtime-types"
import CSS from "./Experience.css"
import { normalizeProcessMode, PROCESS_MODE_KEY, type ProcessMode } from '../shared/process-display'
const h = React.createElement
const { useEffect, useState } = React
const MODES = ['auto', 'expanded'] as const
function isMode(value: unknown): value is ProcessMode { return MODES.some(mode => mode === value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
const MODE_KEY = PROCESS_MODE_KEY
const SHORTCUT_KEY = 'xharness.ui.shortcuts.v1'
const DEFAULT_SHORTCUTS = Object.freeze({ cycleMode: 'Mod+Shift+J', focusComposer: 'Mod+Shift+L' })
const labels = {
  zh: { nav: '显示与快捷键', title: '显示与快捷键', subtitle: '只改变工作过程的呈现，不改变模型、工具或历史记录。',
    display: '工作步骤展示', auto: '自动', expanded: '全部展开',
    autoHint: '按空间折叠，保留运行与异常', expandedHint: '默认展开过程与详情，可手动收起',
    shortcut: '键盘快捷键', search: '搜索快捷键', cycleMode: '切换工作步骤展示', focusComposer: '聚焦输入框',
    record: '按下新组合键…', reset: '恢复默认', conflict: '该组合键已被其他操作使用', invalid: '请同时按修饰键',
    empty: '没有匹配的快捷键', local: '这些偏好只保存在当前设备。' },
  en: { nav: 'Display & shortcuts', title: 'Display & shortcuts', subtitle: 'Changes presentation only; model, tools and history remain intact.',
    display: 'Work process display', auto: 'Automatic', expanded: 'Expand all',
    autoHint: 'Fold by space; keep live and failed work', expandedHint: 'Expand work and details; allow manual collapse',
    shortcut: 'Keyboard shortcuts', search: 'Search shortcuts', cycleMode: 'Cycle process display', focusComposer: 'Focus composer',
    record: 'Press a new shortcut…', reset: 'Reset defaults', conflict: 'This shortcut is already in use', invalid: 'Include a modifier key',
    empty: 'No matching shortcuts', local: 'These preferences are stored on this device only.' },
}

function readStorage(key: string) { try { return localStorage.getItem(key) } catch { return null } }
function writeStorage(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* memory-only preference */ } }
function initialMode() { return normalizeProcessMode(readStorage(MODE_KEY)) }
function initialShortcuts(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(readStorage(SHORTCUT_KEY) || 'null')
    if (isRecord(saved)) {
      const result: Record<string, string> = { ...DEFAULT_SHORTCUTS }
      for (const key of Object.keys(result)) if (typeof saved[key] === 'string' && saved[key].length < 70) result[key] = saved[key]
      if (new Set(Object.values(result)).size === Object.values(result).length) return result
    }
  } catch { /* invalid/old settings fall back */ }
  return { ...DEFAULT_SHORTCUTS }
}
let mode = initialMode()
let shortcuts = initialShortcuts()
const listeners = new Set<() => void>()
function publish() { for (const listener of listeners) listener() }
function setMode(next: unknown) {
  if (!isMode(next)) return false
  mode = next
  document.documentElement.dataset.xhProcessMode = next
  writeStorage(MODE_KEY, next)
  window.dispatchEvent(new Event('xh-process-mode'))
  publish()
  return true
}
function setShortcuts(next: Record<string, unknown>) {
  if (Object.values(next).some(value => typeof value !== 'string') || new Set(Object.values(next)).size !== Object.values(next).length) return false
  const accepted: Record<string, string> = {}
  for (const [key, value] of Object.entries(next)) { if (typeof value !== 'string') return false; accepted[key] = value }
  shortcuts = accepted
  writeStorage(SHORTCUT_KEY, JSON.stringify(shortcuts))
  publish()
  return true
}
function chord(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return ''
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  return [event.metaKey || event.ctrlKey ? 'Mod' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+')
}
function handleShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.repeat || event.defaultPrevented) return
  const pressed = chord(event)
  if (pressed === shortcuts.cycleMode) {
    event.preventDefault()
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
  } else if (pressed === shortcuts.focusComposer) {
    const composer = document.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([readonly])')
    if (composer) { event.preventDefault(); composer.focus() }
  }
}
function useSnapshot() {
  const [, render] = useState(0)
  useEffect(() => { const listener = () => render(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener) } }, [])
  return { mode, shortcuts }
}
function Settings({ t }: { t: Translation }) {
  const state = useSnapshot()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (recording === null) return
    const capture = (event: KeyboardEvent) => {
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
      h('input', { className: 'xhe-search', type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), key: 'search' }),
      h('div', { className: 'xhe-shortcuts', key: 'list' }, visible.length ? visible.map(id => h('div', { className: 'xhe-shortcut', key: id }, [
        h('span', { key: 'label' }, t(id)), h('button', { className: 'xhe-key', type: 'button', 'data-recording': recording === id, onClick: () => { setRecording(id); setError('') }, key: 'key' }, recording === id ? t('record') : state.shortcuts[id]),
      ])) : h('p', { key: 'empty' }, t('empty'))),
      error && h('p', { className: 'xhe-note', role: 'alert', key: 'error' }, error),
      h('div', { className: 'xhe-footer', key: 'footer' }, h('button', { className: 'xhe-reset', type: 'button', onClick: () => { setShortcuts(DEFAULT_SHORTCUTS); setRecording(null); setError('') } }, t('reset'))),
      h('p', { key: 'local' }, t('local'))]),
  ])
}

export const inject = ['slots', 'locale']
export function apply(ctx: PageContext) {
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
export const _test = { chord, setMode, setShortcuts, initialMode, initialShortcuts, MODE_KEY, SHORTCUT_KEY }
