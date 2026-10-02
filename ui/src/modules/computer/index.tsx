/// <reference path="../shared/assets.d.ts" />
import css from './Computer.css'
import type {} from '../shared/tauri'
import type { PageContext, Translation } from '../shared/runtime-types'
import { objectValue } from '../shared/runtime-types'
import { useTranscriptState } from '../tool/transcript-state'

interface ActivityDescriptor { mode: string; text: string }
interface ActivityEntry extends ActivityDescriptor { updatedAt: number; timer: ReturnType<typeof setTimeout> }
interface SharedActivity { calls: Map<string, ActivityEntry>; element: HTMLDivElement | null; nativeTail: Promise<unknown> }
declare global { interface Window { __XHARNESS_COMPUTER_ACTIVITY_V1__?: SharedActivity } }
interface ComputerBlock { kind?: string; call?: { argsRaw?: string }; argsRaw?: string; content?: unknown[]; error?: { code?: string }; isError?: boolean }
interface ActionDescriptor { action: string; mode: string; activity: string; summary: string }
interface ComputerProps { callId: string; block: ComputerBlock; inspect?: () => void; t: Translation }


import * as React from 'react'
const h = React.createElement
const NS = 'xharness-computer'
const GLOBAL_KEY = '__XHARNESS_COMPUTER_ACTIVITY_V1__'

const zh = {
  title: '电脑操作',
  inspect: '查看详情',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
  action: '动作',
  target: '目标',
  frame: '观察帧',
  nodes: '{count} 个控件',
  windows: '{count} 个窗口',
  screenshot: '含屏幕截图',
  preparing: '正在准备电脑操作',
  observeScreen: 'XHarness 正在查看屏幕',
  observeStructure: 'XHarness 正在读取界面结构',
  control: 'XHarness 正在控制鼠标和键盘',
  window: 'XHarness 正在操作窗口',
  wait: 'XHarness 正在等待界面稳定',
  observe: '查看屏幕',
  semantic: '读取界面结构',
  move: '移动指针',
  click: '点击控件',
  drag: '拖动',
  scroll: '滚动',
  type: '输入文字',
  keypress: '按下按键',
  windowAction: '操作窗口',
  waitAction: '等待界面',
  unknown: '电脑操作',
}
const en = {
  title: 'Computer',
  inspect: 'Inspect details',
  running: 'Running',
  done: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  action: 'Action',
  target: 'Target',
  frame: 'Observation frame',
  nodes: '{count} controls',
  windows: '{count} windows',
  screenshot: 'Screen capture included',
  preparing: 'Preparing computer action',
  observeScreen: 'XHarness is viewing your screen',
  observeStructure: 'XHarness is reading the interface structure',
  control: 'XHarness is controlling mouse and keyboard',
  window: 'XHarness is managing a window',
  wait: 'XHarness is waiting for the interface',
  observe: 'View screen',
  semantic: 'Read interface structure',
  move: 'Move pointer',
  click: 'Click control',
  drag: 'Drag',
  scroll: 'Scroll',
  type: 'Type text',
  keypress: 'Press key',
  windowAction: 'Manage window',
  waitAction: 'Wait for interface',
  unknown: 'Computer action',
}



function installStyle() {
  if (typeof document === 'undefined' || document.querySelector('style[data-xharness-computer-ui]')) return
  const style = document.createElement('style')
  style.dataset.xharnessComputerUi = 'true'
  style.textContent = css
  document.head.appendChild(style)
}

function sharedActivity(): SharedActivity {
  if (typeof window === 'undefined') return { calls: new Map(), element: null, nativeTail: Promise.resolve() }
  return window[GLOBAL_KEY] ?? (window[GLOBAL_KEY] = { calls: new Map(), element: null, nativeTail: Promise.resolve() })
}

function desktopInvoke() {
  const invoke = typeof window === 'undefined' ? null : window.__TAURI__?.core?.invoke
  return typeof invoke === 'function' ? invoke : null
}

function syncDesktopActivity(activity: SharedActivity, callId: string, descriptor: ActivityDescriptor | null) {
  const invoke = desktopInvoke()
  if (!invoke) return false
  const request = descriptor ? {
    callId,
    active: true,
    mode: descriptor.mode,
    text: descriptor.text,
  } : {
    callId,
    active: false,
    mode: '',
    text: '',
  }
  // Preserve start/stop ordering even if native IPC latency changes. A
  // rejected bridge call must not break later activity updates.
  activity.nativeTail = (activity.nativeTail ?? Promise.resolve())
    .catch(() => {})
    .then(() => invoke('desktop_set_computer_activity', { request }))
    .catch(() => {})
  return true
}

function ensureIndicator(activity: SharedActivity) {
  if (activity.element?.isConnected) return activity.element
  const element = document.createElement('div')
  element.className = 'xh-computer-privacy'
  element.hidden = true
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'assertive')
  const dot = document.createElement('span')
  dot.className = 'xh-computer-privacy-dot'
  dot.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.className = 'xh-computer-privacy-text'
  element.append(dot, text)
  document.body.appendChild(element)
  activity.element = element
  return element
}

function refreshIndicator(activity: SharedActivity) {
  if (typeof document === 'undefined') return
  const element = ensureIndicator(activity)
  const current = [...activity.calls.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  // The desktop shell projects the same state into a native, cross-app
  // panel. Keep this DOM pill as the browser fallback, not a duplicate.
  if (desktopInvoke()) {
    element.hidden = true
    element.removeAttribute('data-mode')
    const text = element.querySelector('.xh-computer-privacy-text'); if (text) text.textContent = ''
    return
  }
  if (!current) {
    element.hidden = true
    element.removeAttribute('data-mode')
    const text = element.querySelector('.xh-computer-privacy-text'); if (text) text.textContent = ''
    return
  }
  element.hidden = false
  element.dataset.mode = current.mode
  const text = element.querySelector('.xh-computer-privacy-text'); if (text) text.textContent = current.text
}

function activate(callId: string, descriptor: ActivityDescriptor) {
  if (typeof document === 'undefined') return
  installStyle()
  const activity = sharedActivity()
  const previous = activity.calls.get(callId)
  if (previous?.timer) clearTimeout(previous.timer)
  const entry: ActivityEntry = { ...descriptor, updatedAt: Date.now(), timer: setTimeout(() => {
    activity.calls.delete(callId)
    syncDesktopActivity(activity, callId, null)
    refreshIndicator(activity)
  }, 70_000) }
  activity.calls.set(callId, entry)
  syncDesktopActivity(activity, callId, entry)
  refreshIndicator(activity)
}

function deactivate(callId: string) {
  if (typeof document === 'undefined') return
  const activity = sharedActivity()
  const previous = activity.calls.get(callId)
  if (previous?.timer) clearTimeout(previous.timer)
  activity.calls.delete(callId)
  syncDesktopActivity(activity, callId, null)
  refreshIndicator(activity)
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? objectValue(parsed) : null
  } catch {
    return null
  }
}

function callArguments(block: ComputerBlock) {
  return parseJson(('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '') ?? {}
}

function resultValue(block: ComputerBlock) {
  if (!('kind' in block) || !Array.isArray(block.content)) return null
  for (const rawPart of block.content) {
    const part = objectValue(rawPart)
    if (part?.type !== 'text') continue
    const parsed = parseJson(part.text)
    if (parsed) return parsed
  }
  return null
}

const actionKey: Readonly<Record<string, string>> = {
  observe: 'observe',
  move: 'move',
  click: 'click',
  drag: 'drag',
  scroll: 'scroll',
  type: 'type',
  keypress: 'keypress',
  wait: 'waitAction',
  window: 'windowAction',
}

function actionDescriptor(args: Record<string, unknown>, t: Translation): ActionDescriptor {
  const action = typeof args.action === 'string' ? args.action : ''
  if (action === 'observe') {
    const semantic = args.detail === 'semantic' || args.include_screenshot === false
    return {
      action,
      mode: 'view',
      activity: t(semantic ? 'observeStructure' : 'observeScreen'),
      summary: t(semantic ? 'semantic' : 'observe'),
    }
  }
  if (action === 'window') {
    const listing = args.operation === 'list'
    return {
      action,
      mode: listing ? 'view' : 'control',
      activity: t(listing ? 'observeStructure' : 'window'),
      summary: t('windowAction'),
    }
  }
  if (action === 'wait') return { action, mode: 'view', activity: t('wait'), summary: t('waitAction') }
  if (action) return { action, mode: 'control', activity: t('control'), summary: t(actionKey[action] ?? 'unknown') }
  return { action: '', mode: 'view', activity: t('preparing'), summary: t('unknown') }
}

function settledState(block: ComputerBlock) {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

function resultSummary(value: Record<string, unknown> | null, descriptor: ActionDescriptor, t: Translation) {
  if (!value || descriptor.action !== 'observe' && value.action !== 'observe') return descriptor.summary
  const nodes = objectValue(value.accessibility).nodes
  const surfaces = value.surfaces
  const parts: string[] = []
  if (Array.isArray(nodes)) parts.push(t('nodes', { count: nodes.length }))
  if (Array.isArray(surfaces)) parts.push(t('windows', { count: surfaces.length }))
  if (value.screenshot_included === true) parts.push(t('screenshot'))
  return parts.length > 0 ? parts.join(' · ') : descriptor.summary
}

function targetSummary(args: Record<string, unknown>) {
  if (typeof args.node_id === 'string') return args.node_id
  if (typeof args.surface_id === 'string') return args.surface_id
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) return `${args.x}, ${args.y}`
  return null
}

function ComputerRow({ callId, block, inspect, t }: ComputerProps) {
  const [expanded, setExpanded] = useTranscriptState('computer:' + callId, false)
  const args = React.useMemo(() => callArguments(block), [block])
  const descriptor = React.useMemo(() => actionDescriptor(args, t), [args, t])
  const state = settledState(block)
  const result = React.useMemo(() => resultValue(block), [block])
  const summary = state === 'error' ? t('failed') : state === 'stopped' ? t('stopped') : state === 'running' ? descriptor.activity : resultSummary(result, descriptor, t)

  React.useEffect(() => {
    if (state === 'running' && descriptor.action) activate(callId, { mode: descriptor.mode, text: descriptor.activity })
    else deactivate(callId)
    return () => {
      // A running tool may continue after navigation unmounts its row. Keep the
      // privacy indicator until the settled event or the 70 s hard watchdog.
      if (state !== 'running') deactivate(callId)
    }
  }, [callId, descriptor.action, descriptor.activity, descriptor.mode, state])

  const stateLabel = state === 'running' ? t('running') : state === 'error' ? t('failed') : state === 'stopped' ? t('stopped') : t('done')
  const details = [
    [t('action'), descriptor.summary],
    [t('target'), targetSummary(args)],
    [t('frame'), typeof args.frame_id === 'string' ? args.frame_id : null],
  ].filter(([, value]) => value)

  return h('div', { className: 'xh-computer-card', 'data-state': state, 'data-computer-action': descriptor.action || 'unknown' },
    h('div', { className: 'xh-computer-row' },
      h('button', {
        type: 'button',
        className: 'xh-computer-main',
        'aria-expanded': expanded,
        onClick: () => setExpanded(value => !value),
      },
      h('span', { className: 'xh-computer-icon', 'aria-hidden': 'true' }, h('span', { className: 'xh-computer-screen' })),
      h('span', { className: 'xh-computer-title' }, t('title')),
      h('span', { className: 'xh-computer-sep', 'aria-hidden': 'true' }),
      h('span', { className: 'xh-computer-summary' }, summary),
      h('span', { className: 'xh-computer-state' },
        h('span', { className: 'xh-computer-dot', 'aria-hidden': 'true' }),
        h('span', null, stateLabel))),
      typeof inspect === 'function' ? h('button', {
        type: 'button',
        className: 'xh-computer-inspect',
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); inspect() },
      }, t('inspect')) : null),
    expanded && details.length > 0 ? h('dl', { className: 'xh-computer-detail' },
      details.flatMap(([label, value]) => [
        h('dt', { key: `${label}-term` }, label),
        h('dd', { key: `${label}-value` }, value),
      ])) : null)
}

const inject = ['slots', 'locale']
function apply(ctx: PageContext) {
  installStyle()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-computer: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'computer',
    locale: NS,
  }, ComputerRow))
}


export { inject, apply, actionDescriptor, resultSummary, settledState }
