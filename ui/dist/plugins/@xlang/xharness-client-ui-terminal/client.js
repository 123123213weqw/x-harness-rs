window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-terminal',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const { createElement: h, useEffect, useRef, useState } = React

    // The dock layout, tab model and CSS-token theme resolution are adapted
    // from the Apache-2.0 zai-org/ZCode terminal pane; the transport is
    // XHarness's own /api/terminal/* extension routes.
    const NS = 'xharness.ui.terminal'
    const TARGET = 'xharness-terminal-dock'
    const STYLE_ID = 'xharness-terminal-dock-style'
    const VENDOR_BASE = '/plugins/@xlang/xharness-client-ui-terminal/vendor'
    const STORAGE_KEY = 'xharness.terminal.dock.v1'
    const ACTIVE_INTERVAL_MS = 45
    const ACTIVE_IDLE_MS = 250
    const BACKGROUND_INTERVAL_MS = 1500
    const RECONNECT_BASE_MS = 800
    const RECONNECT_MAX_MS = 6400

    const zh = {
      'dock.open': '终端',
      'dock.close': '关闭终端',
      'tab.new': '新建终端',
      'tab.close': '关闭',
      'status.running': '运行中',
      'status.exited': '已退出',
      'status.disconnected': '已断开，重连中…',
      'empty': '没有终端。点击 + 新建。',
      'resize.hint': '拖动调整高度',
    }
    const en = {
      'dock.open': 'Terminal',
      'dock.close': 'Close terminal',
      'tab.new': 'New terminal',
      'tab.close': 'Close',
      'status.running': 'running',
      'status.exited': 'exited',
      'status.disconnected': 'disconnected, reconnecting…',
      'empty': 'No terminals. Click + to create one.',
      'resize.hint': 'Drag to resize',
    }

    // ---------------------------------------------------------------- API --

    async function terminalCall(action, body) {
      const response = await fetch(`/api/terminal/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const message = payload?.error?.message ?? `terminal ${action} failed (${response.status})`
        throw new Error(message)
      }
      return payload
    }

    function terminalBytes(read) {
      const binary = atob(read.content_base64 || '')
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      return bytes
    }

    // ------------------------------------------------------------- xterm --

    let xtermPromise = null
    function loadXterm() {
      if (xtermPromise === null) {
        xtermPromise = new Promise((resolve, reject) => {
          const css = document.createElement('link')
          css.rel = 'stylesheet'
          css.href = `${VENDOR_BASE}/xterm.css`
          document.head.append(css)
          const script = document.createElement('script')
          script.src = `${VENDOR_BASE}/xterm.js`
          script.onload = () => {
            if (typeof window.Terminal !== 'function') {
              reject(new Error('xterm.js loaded without exposing window.Terminal'))
              return
            }
            resolve(window.Terminal)
          }
          script.onerror = () => reject(new Error('xterm.js failed to load'))
          document.head.append(script)
        })
      }
      return xtermPromise
    }

    // ------------------------------------------------------------ theme --
    // Resolved through a hidden element because xterm cannot parse var() or
    // modern color functions; canvas normalises to rgba() strings.

    const colorResolver = () => {
      const span = document.createElement('span')
      document.body.append(span)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d', { willReadFrequently: true })
      return {
        resolve(raw, fallback) {
          try {
            span.style.color = ''
            span.style.color = raw
            const computed = getComputedStyle(span).color
            if (!context) return fallback
            context.fillStyle = '#000'
            context.fillStyle = computed
            context.fillRect(0, 0, 1, 1)
            const [r = 0, g = 0, b = 0, a = 255] = context.getImageData(0, 0, 1, 1).data
            return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`
          } catch {
            return fallback
          }
        },
        done() {
          span.remove()
        },
      }
    }

    const THEME_TOKENS = {
      background: ['--dsw-alias-bg-base', '#1e1e1e'],
      foreground: ['--dsw-alias-label-primary', '#d4d4d4'],
      cursor: ['--dsw-alias-label-primary', '#d4d4d4'],
      cursorAccent: ['--dsw-alias-bg-base', '#1e1e1e'],
      selectionBackground: ['--dsw-alias-interactive-bg-active', 'rgba(125, 125, 125, 0.3)'],
      black: ['--dsw-alias-bg-layer-2', '#282828'],
      red: ['--dsw-alias-state-error-primary', '#ef4444'],
      green: ['--dsw-alias-state-success-primary', '#22c55e'],
      yellow: ['--dsw-alias-state-warn-label', '#eab308'],
      blue: ['--dsw-alias-state-business-primary', '#3b82f6'],
      white: ['--dsw-alias-label-secondary', '#e5e7eb'],
      brightBlack: ['--dsw-alias-label-tertiary', '#6b7280'],
      brightWhite: ['--dsw-alias-label-primary', '#f9fafb'],
    }

    function terminalTheme() {
      const style = getComputedStyle(document.documentElement)
      const resolver = colorResolver()
      try {
        return Object.fromEntries(
          Object.entries(THEME_TOKENS).map(([key, [token, fallback]]) => [
            key,
            resolver.resolve(style.getPropertyValue(token).trim() || fallback, fallback),
          ]),
        )
      } finally {
        resolver.done()
      }
    }

    // ------------------------------------------------------ session state --

    class TerminalTab {
      constructor(name, descriptor) {
        this.name = name
        this.running = descriptor?.running !== false
        this.cursor = 0
        this.term = null
        this.container = null
        this.generation = 0
        this.exitedNotified = false
        this.exitCode = null
        this.exitSignal = null
        this.disconnected = false
        this.lastOutputAt = 0
        this.sendChain = Promise.resolve()
        this.resizeTimer = 0
        this.onUpdate = null
      }

      notify() {
        if (this.onUpdate !== null) this.onUpdate()
      }

      ensureTerm() {
        if (this.container !== null) return Promise.resolve(this.term)
        return loadXterm().then((Terminal) => {
          if (this.container !== null) return this.term
          const container = document.createElement('div')
          container.className = 'xhterm-session'
          this.container = container
          this.term = new Terminal({
            convertEol: false,
            cursorBlink: true,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 12.5,
            lineHeight: 1.2,
            scrollback: 5000,
            theme: terminalTheme(),
          })
          this.term.open(container)
          this.term.onData((data) => this.send(data))
          this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows))
          return this.term
        })
      }

      async attach() {
        const term = await this.ensureTerm()
        if (term === null || term === undefined) return
        const generation = ++this.generation
        this.disconnected = false
        try {
          // First attach replays the whole scrollback (cursor starts at 0);
          // re-attaching after a tab switch resumes from the live cursor so
          // nothing is written twice.
          const { read } = await terminalCall('read', {
            name: this.name,
            cursor: this.cursor,
          })
          if (generation !== this.generation) return
          this.cursor = read.cursor
          this.running = read.running
          if (read.truncated_before_cursor) {
            term.write('\x1b[90m[早于滚动缓冲的输出已截断]\x1b[0m\r\n')
          }
          term.write(terminalBytes(read))
          this.lastOutputAt = Date.now()
        } catch (error) {
          this.handleFailure(error, generation)
        }
        this.notify()
        this.pollLoop(generation)
      }

      async pollLoop(generation) {
        let backoff = RECONNECT_BASE_MS
        while (generation === this.generation) {
          const active = this === dockStore.activeTab()
          const busy = Date.now() - this.lastOutputAt < 500
          const delay = this.disconnected
            ? backoff
            : this.running
              ? (active ? (busy ? ACTIVE_INTERVAL_MS : ACTIVE_IDLE_MS) : BACKGROUND_INTERVAL_MS)
              : 5000
          await sleep(delay)
          if (generation !== this.generation) return
          try {
            const { read } = await terminalCall('read', {
              name: this.name,
              cursor: this.cursor,
            })
            if (generation !== this.generation) return
            this.disconnected = false
            backoff = RECONNECT_BASE_MS
            this.running = read.running
            this.exitCode = read.exit_code ?? null
            this.exitSignal = read.exit_signal ?? null
            this.cursor = read.cursor
            if (read.truncated_before_cursor) {
              this.term?.write('\r\n\x1b[90m[早于滚动缓冲的输出已截断]\x1b[0m\r\n')
            }
            const bytes = terminalBytes(read)
            if (bytes.length > 0) {
              this.lastOutputAt = Date.now()
              this.term?.write(bytes)
            }
            if (!read.running && this.running === false && !this.exitedNotified) {
              this.exitedNotified = true
              this.term?.write(exitNotice(this))
            }
          } catch (error) {
            if (generation !== this.generation) return
            // "not found" is a real terminal removal, not a transport fault.
            if (String(error.message).includes('was not found')) {
              this.running = false
              this.exitedNotified = true
              this.disconnected = false
              this.term?.write('\r\n\x1b[90m[会话已被服务器关闭]\x1b[0m\r\n')
              this.notify()
              return
            }
            this.disconnected = true
            backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
          }
          this.notify()
        }
      }

      handleFailure(error, generation) {
        this.disconnected = true
        if (generation === this.generation) this.notify()
        void error
      }

      send(data) {
        this.sendChain = this.sendChain
          .then(() => terminalCall('send', { name: this.name, input: data }))
          .catch((error) => {
            this.term?.write(`\r\n\x1b[31m[发送失败: ${error.message}]\x1b[0m\r\n`)
          })
      }

      scheduleResize(cols, rows) {
        window.clearTimeout(this.resizeTimer)
        this.resizeTimer = window.setTimeout(() => {
          terminalCall('resize', { name: this.name, cols, rows }).catch(() => {
            // Sizes resync on the next attach; a failed resize is not fatal.
          })
        }, 200)
      }

      stopPolling() {
        this.generation += 1
      }

      dispose() {
        this.stopPolling()
        window.clearTimeout(this.resizeTimer)
        try {
          this.term?.dispose()
        } catch {
          // A disposed terminal during teardown is harmless.
        }
        this.term = null
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function exitNotice(tab) {
      const zhLang = document.documentElement.lang.startsWith('zh')
      let detail = ''
      if (tab.exitCode !== null && tab.exitCode !== undefined) {
        detail = zhLang ? `，退出码 ${tab.exitCode}` : `, exit code ${tab.exitCode}`
      } else if (tab.exitSignal) {
        detail = zhLang ? `，信号 ${tab.exitSignal}` : `, signal ${tab.exitSignal}`
      }
      const label = zhLang ? `进程已退出${detail}` : `process exited${detail}`
      return `\r\n\x1b[90m[${label}]\x1b[0m\r\n`
    }

    // -------------------------------------------------------- dock store --

    const dockStore = {
      open: false,
      height: 280,
      tabs: [],
      active: null,
      listeners: new Set(),
      load() {
        try {
          const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
          if (Number.isFinite(saved.height) && saved.height >= 160 && saved.height <= 640) {
            this.height = saved.height
          }
        } catch {
          // Corrupt local state falls back to defaults.
        }
      },
      save() {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ height: this.height }))
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of this.listeners) listener()
      },
      activeTab() {
        return this.tabs.find((tab) => tab.name === this.active) ?? null
      },
      setOpen(open) {
        this.open = open
        if (open) void this.refresh()
        this.emit()
      },
      setHeight(height) {
        this.height = Math.min(640, Math.max(160, Math.round(height)))
        this.save()
        this.emit()
      },
      async refresh() {
        try {
          const { terminals } = await terminalCall('list')
          const known = new Set(this.tabs.map((tab) => tab.name))
          for (const descriptor of terminals) {
            if (!known.has(descriptor.name)) {
              this.tabs.push(new TerminalTab(descriptor.name, descriptor))
            }
          }
          const live = new Set(terminals.map((descriptor) => descriptor.name))
          for (const tab of [...this.tabs]) {
            if (!live.has(tab.name)) {
              tab.dispose()
              this.tabs.splice(this.tabs.indexOf(tab), 1)
            }
          }
          if (this.active === null || !live.has(this.active)) {
            this.active = this.tabs[0]?.name ?? null
          }
          this.emit()
        } catch {
          // The dock surfaces transport failures per tab; list failing just
          // means no server-side terminals are restorable right now.
        }
      },
      select(name) {
        this.active = name
        this.emit()
      },
      async create() {
        let index = this.tabs.length + 1
        let name = `t${index}`
        const taken = new Set(this.tabs.map((tab) => tab.name))
        while (taken.has(name)) name = `t${++index}`
        const cols = this.activeTab()?.term?.cols ?? 80
        const rows = this.activeTab()?.term?.rows ?? 24
        try {
          const { terminal } = await terminalCall('open', { name, cols, rows })
          const tab = new TerminalTab(name, terminal)
          this.tabs.push(tab)
          this.active = name
          this.emit()
          return tab
        } catch (error) {
          window.alert(`新建终端失败: ${error.message}`)
          return null
        }
      },
      async close(name) {
        const tab = this.tabs.find((candidate) => candidate.name === name)
        if (tab === undefined) return
        tab.dispose()
        this.tabs.splice(this.tabs.indexOf(tab), 1)
        if (this.active === name) this.active = this.tabs[0]?.name ?? null
        this.emit()
        try {
          await terminalCall('close', { name })
        } catch {
          // Server-side teardown already happened on dispose for dead tabs.
        }
      },
    }
    dockStore.load()

    // ------------------------------------------------------- components --

    function useDockStore() {
      const [, forceUpdate] = useState(0)
      useEffect(() => dockStore.subscribe(() => forceUpdate((value) => value + 1)), [])
      return dockStore
    }

    function TerminalDockAction({ t }) {
      const store = useDockStore()
      return h(
        'button',
        {
          type: 'button',
          className: 'xhterm-trigger',
          onClick: () => store.setOpen(!store.open),
          title: store.open ? t('dock.close') : t('dock.open'),
        },
        h('svg', {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.4,
        },
          h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6 }),
          h('path', { d: 'M4.2 6.2 6.4 8 4.2 9.8' }),
          h('path', { d: 'M8.4 10h3.4' }),
        ),
        h('span', { className: 'xhterm-trigger-label' }, t('dock.open')),
      )
    }

    // The viewport only hosts the tab's persistent DOM node, so switching
    // tabs preserves scrollback and the xterm instance. Disposal happens on
    // tab close, not on unmount.
    function TerminalViewport({ tab }) {
      const containerRef = useRef(null)
      useEffect(() => {
        const host = containerRef.current
        if (tab === null || host === null) return undefined
        let cancelled = false
        tab.ensureTerm()
          .then(() => {
            if (cancelled || host === null) return
            host.append(tab.container)
            tab.attach()
          })
          .catch((error) => {
            if (!cancelled && host !== null) {
              const notice = document.createElement('div')
              notice.className = 'xhterm-empty'
              notice.textContent = `终端组件加载失败: ${error.message}`
              host.append(notice)
            }
          })
        return () => {
          cancelled = true
          tab.stopPolling()
          tab.container?.remove()
        }
      }, [tab])
      return h('div', { className: 'xhterm-viewport', ref: containerRef })
    }

    function dockInsets(viewportWidth, composerRect) {
      if (composerRect !== null && composerRect.width > 160) {
        return {
          left: Math.max(8, Math.round(composerRect.left)),
          right: Math.max(8, Math.round(viewportWidth - composerRect.right)),
        }
      }
      const inset = Math.max(16, Math.round((viewportWidth - 800) / 2))
      return { left: inset, right: inset }
    }

    function TerminalDock({ t }) {
      const store = useDockStore()
      const [height, setHeight] = useState(store.height)
      const [insets, setInsets] = useState(() => dockInsets(window.innerWidth, null))
      const draggingRef = useRef(false)
      const activeTab = store.activeTab()

      useEffect(() => {
        if (!draggingRef.current) setHeight(store.height)
      }, [store.height])

      useEffect(() => {
        let composer = null
        const observer = typeof ResizeObserver === 'function'
          ? new ResizeObserver(update)
          : null
        let scheduled = 0
        function update() {
          const next = document.querySelector('[data-composer-card="true"]')
          if (next !== composer) {
            observer?.disconnect()
            composer = next
            if (composer !== null) observer?.observe(composer)
          }
          const rect = composer?.getBoundingClientRect() ?? null
          const nextInsets = dockInsets(window.innerWidth, rect)
          setInsets((previous) => previous.left === nextInsets.left && previous.right === nextInsets.right
            ? previous
            : nextInsets)
        }
        function schedule() {
          if (scheduled !== 0) return
          scheduled = window.requestAnimationFrame(() => {
            scheduled = 0
            update()
          })
        }
        const mutations = typeof MutationObserver === 'function'
          ? new MutationObserver(() => {
            if (composer === null || !composer.isConnected) schedule()
          })
          : null
        mutations?.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        document.addEventListener('transitionend', schedule, true)
        update()
        return () => {
          observer?.disconnect()
          mutations?.disconnect()
          window.cancelAnimationFrame(scheduled)
          window.removeEventListener('resize', schedule)
          document.removeEventListener('transitionend', schedule, true)
        }
      }, [])

      useEffect(() => {
        const move = (event) => {
          if (!draggingRef.current) return
          event.preventDefault()
          store.setHeight(window.innerHeight - event.clientY)
        }
        const stop = () => {
          draggingRef.current = false
          document.body.classList.remove('xhterm-dragging')
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', stop)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', stop)
        }
      }, [])

      if (!store.open) return null

      return h('div', { className: 'xhterm-dock', style: { height, ...insets } },
        h('div', {
          className: 'xhterm-resize-handle',
          title: t('resize.hint'),
          onMouseDown: (event) => {
            event.preventDefault()
            draggingRef.current = true
            document.body.classList.add('xhterm-dragging')
          },
        }),
        h('div', { className: 'xhterm-tabbar' },
          store.tabs.map((tab) =>
            h('button', {
              type: 'button',
              key: tab.name,
              className:
                tab.name === store.active
                  ? 'xhterm-tab xhterm-tab-active'
                  : 'xhterm-tab',
              onClick: () => store.select(tab.name),
            },
              h('span', {
                className: `xhterm-tab-dot ${
                  tab.disconnected
                    ? 'xhterm-tab-dot-offline'
                    : tab.running
                      ? 'xhterm-tab-dot-running'
                      : 'xhterm-tab-dot-exited'
                }`,
                'aria-hidden': true,
              }),
              tab.name,
              h('span', {
                className: 'xhterm-tab-close',
                role: 'button',
                title: t('tab.close'),
                onClick: (event) => {
                  event.stopPropagation()
                  void store.close(tab.name)
                },
              }, '×'),
            ),
          ),
          h('button', {
            type: 'button',
            className: 'xhterm-newtab',
            title: t('tab.new'),
            onClick: () => void store.create(),
          }, '+'),
          h('span', { className: 'xhterm-status' },
            activeTab === null
              ? null
              : activeTab.disconnected
                ? t('status.disconnected')
                : activeTab.running
                  ? t('status.running')
                  : t('status.exited'),
          ),
        ),
        activeTab === null
          ? h('div', { className: 'xhterm-empty' }, t('empty'))
          : h(TerminalViewport, { key: activeTab.name, tab: activeTab }),
      )
    }

    function TerminalRoot() {
      const t = (key) => {
        const dict = document.documentElement.lang.startsWith('zh') ? zh : en
        return dict[key] ?? key
      }
      const store = useDockStore()
      return h(React.Fragment, null,
        h(TerminalDockAction, { t }),
        store.open ? ReactDOM.createPortal(h(TerminalDock, { t }), document.body) : null,
      )
    }

    // ---------------------------------------------------------------- CSS --

    const CSS = `
.xhterm-trigger{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}.xhterm-trigger:hover,.xhterm-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}
.xhterm-dock{position:fixed;bottom:0;z-index:90;display:flex;flex-direction:column;box-sizing:border-box;min-width:0;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-bottom:0;border-radius:10px 10px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,.18)}
.xhterm-resize-handle{height:4px;flex:none;cursor:row-resize}
.xhterm-dragging,.xhterm-dragging *{cursor:row-resize!important;user-select:none!important}
.xhterm-tabbar{display:flex;align-items:center;gap:2px;flex:none;padding:2px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.xhterm-tab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:0;border-radius:6px 6px 0 0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer}.xhterm-tab:hover{color:var(--dsw-alias-label-secondary)}.xhterm-tab-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.xhterm-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2f7cf6)}.xhterm-tab-dot-exited{background:var(--dsw-alias-label-tertiary)}.xhterm-tab-dot-offline{background:var(--dsw-alias-state-warn-primary,#dc8500)}
.xhterm-tab-close{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1}.xhterm-tab-close:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.xhterm-newtab{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:15px;cursor:pointer}.xhterm-newtab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.xhterm-status{margin-left:auto;padding-right:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.xhterm-viewport{flex:1;min-height:0;padding:4px 8px 8px}.xhterm-session{height:100%}
.xhterm-viewport .xterm{height:100%}
.xhterm-empty{flex:1;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
`

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-ui-terminal: dictionaries')
      ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'xharness-ui-terminal: styles')
      ctx.effect(() => {
        const shortcut = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === '`') {
            event.preventDefault()
            dockStore.setOpen(!dockStore.open)
          }
        }
        window.addEventListener('keydown', shortcut)
        return () => window.removeEventListener('keydown', shortcut)
      }, 'xharness-ui-terminal: shortcut')
      ctx.slots.inject(
        'conversation.session.header.actions',
        () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'terminal-dock',
          order: 20,
          locale: NS,
        }, TerminalRoot),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.TerminalTab = TerminalTab
    exports.terminalCall = terminalCall
    exports.terminalBytes = terminalBytes
    exports.dockInsets = dockInsets
    exports.terminalTheme = terminalTheme
    exports.exitNotice = exitNotice
    exports.dockStore = dockStore
    return module.exports
  },
})
