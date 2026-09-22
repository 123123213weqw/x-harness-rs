window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-computer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
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

    const css = `
.xh-computer-card{display:flex;flex-direction:column;min-width:0;margin:2px 0;color:var(--dsw-alias-label-secondary)}
.xh-computer-row{display:flex;align-items:center;min-width:0;min-height:28px;border-radius:7px}
.xh-computer-main{display:flex;align-items:center;min-width:0;flex:1;border:0;background:transparent;color:inherit;padding:2px 4px;cursor:pointer;text-align:left}
.xh-computer-icon{display:grid;place-items:center;width:18px;height:18px;flex:none;margin-right:6px;color:var(--dsw-alias-label-tertiary)}
.xh-computer-screen{width:14px;height:10px;border:1.5px solid currentColor;border-radius:2px;position:relative;box-sizing:border-box}
.xh-computer-screen:after{content:"";position:absolute;left:4px;right:4px;bottom:-4px;height:1.5px;background:currentColor;border-radius:2px}
.xh-computer-title{font-size:14px;line-height:24px;white-space:nowrap}
.xh-computer-sep{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-caption);margin:0 8px;flex:none}
.xh-computer-summary{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px}
.xh-computer-state{display:flex;align-items:center;gap:5px;flex:none;margin-left:8px;color:var(--dsw-alias-label-caption);font-size:11px}
.xh-computer-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.xh-computer-card[data-state="running"] .xh-computer-dot{background:#f59e0b;box-shadow:0 0 0 0 rgba(245,158,11,.45);animation:xh-computer-pulse 1.5s ease-out infinite}
.xh-computer-card[data-state="error"] .xh-computer-dot{background:var(--dsw-alias-state-error-primary)}
.xh-computer-card[data-state="stopped"] .xh-computer-dot{background:#f59e0b}
.xh-computer-inspect{border:0;background:transparent;color:var(--dsw-alias-label-caption);padding:4px 6px;cursor:pointer;font-size:11px;opacity:0;transition:opacity .12s}
.xh-computer-row:hover .xh-computer-inspect,.xh-computer-inspect:focus-visible{opacity:1}
.xh-computer-detail{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 12px;margin:4px 0 6px 28px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-markdown-code-block);font-size:12px;line-height:18px}
.xh-computer-detail dt{color:var(--dsw-alias-label-caption)}.xh-computer-detail dd{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.xh-computer-privacy{position:fixed;z-index:2147483000;top:max(12px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:9px;max-width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:8px 13px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(24,24,27,.94);box-shadow:0 8px 28px rgba(0,0,0,.28);color:#fff;font:600 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.01em;pointer-events:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.xh-computer-privacy[hidden]{display:none}.xh-computer-privacy-dot{width:8px;height:8px;flex:none;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 0 rgba(245,158,11,.55);animation:xh-computer-pulse 1.5s ease-out infinite}
.xh-computer-privacy[data-mode="control"] .xh-computer-privacy-dot{background:#fb7185;box-shadow:0 0 0 0 rgba(251,113,133,.55)}
.xh-computer-privacy-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes xh-computer-pulse{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media(prefers-reduced-motion:reduce){.xh-computer-dot,.xh-computer-privacy-dot{animation:none}}
@media(max-width:640px){.xh-computer-state span:last-child{display:none}.xh-computer-privacy{top:max(8px,env(safe-area-inset-top));max-width:calc(100vw - 20px)}}
`

    function installStyle() {
      if (typeof document === 'undefined' || document.querySelector('style[data-xharness-computer-ui]')) return
      const style = document.createElement('style')
      style.dataset.xharnessComputerUi = 'true'
      style.textContent = css
      document.head.appendChild(style)
    }

    function sharedActivity() {
      if (typeof window === 'undefined') return { calls: new Map(), element: null }
      if (!window[GLOBAL_KEY]) window[GLOBAL_KEY] = { calls: new Map(), element: null }
      return window[GLOBAL_KEY]
    }

    function ensureIndicator(activity) {
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

    function refreshIndicator(activity) {
      if (typeof document === 'undefined') return
      const element = ensureIndicator(activity)
      const current = [...activity.calls.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (!current) {
        element.hidden = true
        element.removeAttribute('data-mode')
        element.querySelector('.xh-computer-privacy-text').textContent = ''
        return
      }
      element.hidden = false
      element.dataset.mode = current.mode
      element.querySelector('.xh-computer-privacy-text').textContent = current.text
    }

    function activate(callId, descriptor) {
      if (typeof document === 'undefined') return
      installStyle()
      const activity = sharedActivity()
      const previous = activity.calls.get(callId)
      if (previous?.timer) clearTimeout(previous.timer)
      const entry = { ...descriptor, updatedAt: Date.now() }
      entry.timer = setTimeout(() => {
        activity.calls.delete(callId)
        refreshIndicator(activity)
      }, 70_000)
      activity.calls.set(callId, entry)
      refreshIndicator(activity)
    }

    function deactivate(callId) {
      if (typeof document === 'undefined') return
      const activity = sharedActivity()
      const previous = activity.calls.get(callId)
      if (previous?.timer) clearTimeout(previous.timer)
      activity.calls.delete(callId)
      refreshIndicator(activity)
    }

    function parseJson(value) {
      if (typeof value !== 'string' || value === '') return null
      try {
        const parsed = JSON.parse(value)
        return typeof parsed === 'object' && parsed !== null ? parsed : null
      } catch {
        return null
      }
    }

    function callArguments(block) {
      return parseJson(('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '') ?? {}
    }

    function resultValue(block) {
      if (!('kind' in block) || !Array.isArray(block.content)) return null
      for (const part of block.content) {
        if (part?.type !== 'text') continue
        const parsed = parseJson(part.text)
        if (parsed) return parsed
      }
      return null
    }

    const actionKey = {
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

    function actionDescriptor(args, t) {
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

    function settledState(block) {
      if (!('kind' in block)) return 'running'
      if (block.error?.code === 'interrupted') return 'stopped'
      return block.isError ? 'error' : 'ok'
    }

    function resultSummary(value, descriptor, t) {
      if (!value || descriptor.action !== 'observe' && value.action !== 'observe') return descriptor.summary
      const nodes = value.accessibility?.nodes
      const surfaces = value.surfaces
      const parts = []
      if (Array.isArray(nodes)) parts.push(t('nodes', { count: nodes.length }))
      if (Array.isArray(surfaces)) parts.push(t('windows', { count: surfaces.length }))
      if (value.screenshot_included === true) parts.push(t('screenshot'))
      return parts.length > 0 ? parts.join(' · ') : descriptor.summary
    }

    function targetSummary(args) {
      if (typeof args.node_id === 'string') return args.node_id
      if (typeof args.surface_id === 'string') return args.surface_id
      if (Number.isFinite(args.x) && Number.isFinite(args.y)) return `${args.x}, ${args.y}`
      return null
    }

    function ComputerRow({ callId, block, inspect, t }) {
      const [expanded, setExpanded] = React.useState(false)
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
            onClick: event => { event.stopPropagation(); inspect() },
          }, t('inspect')) : null),
        expanded && details.length > 0 ? h('dl', { className: 'xh-computer-detail' },
          details.flatMap(([label, value]) => [
            h('dt', { key: `${label}-term` }, label),
            h('dd', { key: `${label}-value` }, value),
          ])) : null)
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      installStyle()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-computer: dictionaries')
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'computer',
        locale: NS,
      }, ComputerRow))
    }

    exports.inject = inject
    exports.apply = apply
    exports.actionDescriptor = actionDescriptor
    exports.resultSummary = resultSummary
    exports.settledState = settledState
    return module.exports
  },
})
