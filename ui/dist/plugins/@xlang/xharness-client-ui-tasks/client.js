// Task list organization panel: pinned section, timeline grouping, inline
// rename, archive (with client-side metadata snapshots) and fork-to-restore.
// Interaction model adapted from the Apache-2.0 zai-org/ZCode task list;
// navigation stays with the upstream sidebar, this panel manages organization.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-tasks',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const { createElement: h, useEffect, useRef, useState } = React

    const NS = 'xharness.ui.tasks'
    const STYLE_ID = 'xharness-tasks-panel-style'
    const PINNED_KEY = 'xharness.tasks.pinned.v1'
    const ARCHIVE_KEY = 'xharness.tasks.archive-snapshots.v1'
    const PANEL_WIDTH = 360

    const zh = {
      'panel.open': '任务',
      'panel.close': '关闭任务面板',
      'panel.title': '任务',
      'panel.refresh': '刷新',
      'group.pinned': '置顶',
      'group.today': '今天',
      'group.yesterday': '昨天',
      'group.last7': '最近 7 天',
      'group.earlier': '更早',
      'group.archived': '已归档',
      'group.archived.hint': '归档的会话不再出现在对话列表；「复刻恢复」会基于它创建新会话。',
      'menu.pin': '置顶',
      'menu.unpin': '取消置顶',
      'menu.rename': '重命名',
      'menu.archive': '归档',
      'menu.fork': '复刻恢复',
      'menu.fork.live': '复刻新会话',
      'menu.copy': '复制会话 ID',
      'rename.save': '保存',
      'rename.cancel': '取消',
      'empty': '没有会话。',
      'empty.archived': '没有已归档的会话。',
      'loading': '加载中…',
      'error': '加载失败',
      'retry': '重试',
      'copied': '已复制',
      'action.failed': '操作失败：{message}',
      'untitled': '（未命名会话）',
      'running': '运行中',
      'unknown.archived': '较早前归档',
    }
    const en = {
      'panel.open': 'Tasks',
      'panel.close': 'Close tasks panel',
      'panel.title': 'Tasks',
      'panel.refresh': 'Refresh',
      'group.pinned': 'Pinned',
      'group.today': 'Today',
      'group.yesterday': 'Yesterday',
      'group.last7': 'Last 7 days',
      'group.earlier': 'Earlier',
      'group.archived': 'Archived',
      'group.archived.hint': 'Archived sessions no longer appear in the conversation list. "Fork to restore" creates a new session from one.',
      'menu.pin': 'Pin',
      'menu.unpin': 'Unpin',
      'menu.rename': 'Rename',
      'menu.archive': 'Archive',
      'menu.fork': 'Fork to restore',
      'menu.fork.live': 'Fork new session',
      'menu.copy': 'Copy session ID',
      'rename.save': 'Save',
      'rename.cancel': 'Cancel',
      'empty': 'No sessions.',
      'empty.archived': 'No archived sessions.',
      'loading': 'Loading…',
      'error': 'Failed to load',
      'retry': 'Retry',
      'copied': 'Copied',
      'action.failed': 'Action failed: {message}',
      'untitled': '(untitled session)',
      'running': 'running',
      'unknown.archived': 'archived earlier',
    }

    // ----------------------------------------------------------------- RPC --

    let rpcCounter = 0
    async function rpc(method, payload) {
      const rpcId = `xharness-tasks-${++rpcCounter}`
      const response = await fetch(`/api/${method}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      const result = body?.result
      if (result?.ok !== true) {
        throw new Error(result?.error?.message ?? `${method} failed (${response.status})`)
      }
      return result.value ?? null
    }

    // ------------------------------------------------------------- storage --

    function readJson(key, fallback) {
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? 'null')
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Private-mode storage may refuse writes; the panel keeps working
        // with in-memory state for this session.
      }
    }

    // -------------------------------------------------------------- model --

    // The host reports updatedAt as epoch milliseconds (matching the frozen
    // workspace createdAt wire format); the guard keeps ordering sane if the
    // unit ever changes to seconds.
    function normalizeTimestamp(value) {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) return 0
      return numeric > 1e12 ? numeric : numeric * 1000
    }

    function sessionTitle(item, t) {
      const title = item?.projections?.values?.title
      if (typeof title === 'string' && title.trim().length > 0) return title
      if (typeof item?.cwd === 'string' && item.cwd.length > 0) {
        const leaf = item.cwd.split(/[\\/]/).filter(Boolean).pop()
        if (leaf !== undefined && leaf.length > 0) return leaf
      }
      return t('untitled')
    }

    const GROUP_ORDER = ['pinned', 'today', 'yesterday', 'last7', 'earlier']

    // Timeline grouping adapted from ZCode's groupTaskTimelineItems: pinned
    // first, then calendar-day buckets keyed off the local start of day.
    function groupSessions(sessions, pinned, now = Date.now()) {
      const pinnedSet = new Set(pinned)
      const dayMs = 24 * 60 * 60 * 1000
      const startOfDay = new Date(now)
      startOfDay.setHours(0, 0, 0, 0)
      const today0 = startOfDay.getTime()
      const groups = { pinned: [], today: [], yesterday: [], last7: [], earlier: [] }
      for (const session of sessions) {
        if (session.blank === true) continue
        if (pinnedSet.has(session.sessionId)) {
          groups.pinned.push(session)
          continue
        }
        const updated = normalizeTimestamp(session.updatedAt)
        if (updated >= today0) groups.today.push(session)
        else if (updated >= today0 - dayMs) groups.yesterday.push(session)
        else if (updated >= today0 - 7 * dayMs) groups.last7.push(session)
        else groups.earlier.push(session)
      }
      const byRecency = (a, b) =>
        normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt)
      for (const key of GROUP_ORDER) groups[key].sort(byRecency)
      return groups
    }

    function relativeTime(updatedAt, now = Date.now(), zhLang = true) {
      const updated = normalizeTimestamp(updatedAt)
      if (updated <= 0) return ''
      const delta = Math.max(0, now - updated)
      const minute = 60 * 1000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return zhLang ? '刚刚' : 'just now'
      if (delta < hour) return zhLang ? `${Math.floor(delta / minute)} 分钟前` : `${Math.floor(delta / minute)}m ago`
      if (delta < day) return zhLang ? `${Math.floor(delta / hour)} 小时前` : `${Math.floor(delta / hour)}h ago`
      if (delta < 7 * day) return zhLang ? `${Math.floor(delta / day)} 天前` : `${Math.floor(delta / day)}d ago`
      return new Date(updated).toLocaleDateString(zhLang ? 'zh-CN' : 'en-US')
    }

    // ------------------------------------------------------------ store --

    const store = {
      open: false,
      closing: false,
      closeTimer: 0,
      loading: false,
      error: null,
      actionError: null,
      sessions: [],
      archivedIds: [],
      snapshots: readJson(ARCHIVE_KEY, {}),
      pinned: readJson(PINNED_KEY, []),
      archivedExpanded: false,
      busyId: null,
      menuId: null,
      renameId: null,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of this.listeners) listener()
      },
      // A short exit-animation phase slides the panel out before unmount;
      // timing pairs with the .18s panel-out animation.
      setOpen(open) {
        if (open) {
          window.clearTimeout(this.closeTimer)
          this.closing = false
          this.open = true
          void this.refresh()
        } else if (this.open && !this.closing) {
          this.closing = true
          this.closeTimer = window.setTimeout(() => {
            this.open = false
            this.closing = false
            this.emit()
          }, 190)
        }
        this.menuId = null
        this.renameId = null
        this.emit()
      },
      togglePinned(id) {
        this.pinned = this.pinned.includes(id)
          ? this.pinned.filter((candidate) => candidate !== id)
          : [...this.pinned, id]
        writeJson(PINNED_KEY, this.pinned)
        this.emit()
      },
      snapshot(session, t) {
        this.snapshots[session.sessionId] = {
          title: sessionTitle(session, t),
          updatedAt: normalizeTimestamp(session.updatedAt),
          archivedAt: Date.now(),
        }
        writeJson(ARCHIVE_KEY, this.snapshots)
      },
      async refresh() {
        this.loading = true
        this.error = null
        this.emit()
        try {
          const [list, workspaces] = await Promise.all([
            rpc('session.list', {}),
            rpc('workspace.list', {}),
          ])
          this.sessions = list?.items ?? []
          this.archivedIds = workspaces?.archivedSessionIds ?? []
          const live = new Set(this.sessions.map((session) => session.sessionId))
          this.archivedIds = this.archivedIds.filter((id) => !live.has(id))
          this.pinned = this.pinned.filter((id) => live.has(id))
          writeJson(PINNED_KEY, this.pinned)
        } catch (error) {
          this.error = String(error?.message ?? error)
        } finally {
          this.loading = false
          this.emit()
        }
      },
      async rename(id, title) {
        if (this.busyId !== null) return
        this.actionError = null
        this.busyId = id
        this.emit()
        try {
          await rpc('session.rename', { sessionId: id, title })
          const target = this.sessions.find((session) => session.sessionId === id)
          if (target?.projections?.values) {
            target.projections.values.title = title
          }
          this.renameId = null
          this.emit()
        } catch (error) {
          this.actionError = String(error?.message ?? error)
        } finally {
          this.busyId = null
          this.emit()
        }
      },
      async archive(id) {
        if (this.busyId !== null) return
        const target = this.sessions.find((session) => session.sessionId === id)
        this.actionError = null
        this.busyId = id
        this.emit()
        try {
          await rpc('workspace.archiveSession', { sessionId: id })
          // Persist the label only after the archive succeeded; failed RPCs
          // must not leave a phantom archived snapshot behind.
          if (target !== undefined) this.snapshot(target, makeT())
          this.sessions = this.sessions.filter((session) => session.sessionId !== id)
          this.archivedIds = [...this.archivedIds, id]
          this.pinned = this.pinned.filter((candidate) => candidate !== id)
          writeJson(PINNED_KEY, this.pinned)
        } catch (error) {
          this.actionError = String(error?.message ?? error)
        } finally {
          this.busyId = null
          this.menuId = null
          this.emit()
        }
      },
      async fork(id) {
        if (this.busyId !== null) return
        this.actionError = null
        this.busyId = id
        this.emit()
        try {
          await rpc('session.fork', { sessionId: id })
          await this.refresh()
        } catch (error) {
          this.actionError = String(error?.message ?? error)
        } finally {
          this.busyId = null
          this.menuId = null
          this.emit()
        }
      },
    }

    function makeT() {
      const dict = document.documentElement.lang.startsWith('zh') ? zh : en
      return (key, values) => {
        let text = dict[key] ?? key
        if (values !== undefined) {
          for (const [name, value] of Object.entries(values)) {
            text = text.replaceAll(`{${name}}`, String(value))
          }
        }
        return text
      }
    }

    // ------------------------------------------------------- components --

    function useStore() {
      const [, forceUpdate] = useState(0)
      useEffect(() => store.subscribe(() => forceUpdate((value) => value + 1)), [])
      return store
    }

    function TaskRow({ session, t, pinned }) {
      const state = useStore()
      const id = session.sessionId
      const isPinned = pinned
      const renaming = state.renameId === id
      const busy = state.busyId === id
      const title = sessionTitle(session, t)
      const inputRef = useRef(null)
      useEffect(() => {
        if (renaming) inputRef.current?.select()
      }, [renaming])

      if (renaming) {
        return h('div', { className: 'xhtask-row xhtask-row-renaming' },
          h('input', {
            ref: inputRef,
            className: 'xhtask-rename',
            defaultValue: title,
            autoFocus: true,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                const value = event.currentTarget.value.trim()
                if (value.length > 0) void state.rename(id, value)
              } else if (event.key === 'Escape') {
                state.renameId = null
                state.emit()
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'xhtask-row-action',
            onClick: () => {
              const value = inputRef.current?.value.trim()
              if (value !== undefined && value.length > 0) void state.rename(id, value)
            },
          }, t('rename.save')),
          h('button', {
            type: 'button',
            className: 'xhtask-row-action',
            onClick: () => { state.renameId = null; state.emit() },
          }, t('rename.cancel')),
        )
      }

      return h('div', {
        className: `xhtask-row ${busy ? 'xhtask-row-busy' : ''}`,
        onClick: () => { state.menuId = state.menuId === id ? null : id; state.emit() },
      },
        h('span', {
          className: `xhtask-dot ${session.running ? 'xhtask-dot-running' : ''}`,
          'aria-hidden': true,
        }),
        h('span', { className: 'xhtask-title', title: `${title} · ${id}` }, title),
        h('span', { className: 'xhtask-time' }, relativeTime(session.updatedAt, Date.now(), document.documentElement.lang.startsWith('zh'))),
        state.menuId === id
          ? h('div', { className: 'xhtask-menu', onClick: (event) => event.stopPropagation() },
              menuItem(t(isPinned ? 'menu.unpin' : 'menu.pin'), () => state.togglePinned(id)),
              menuItem(t('menu.rename'), () => { state.renameId = id; state.menuId = null; state.emit() }),
              menuItem(t('menu.archive'), () => void state.archive(id)),
              menuItem(t('menu.fork.live'), () => void state.fork(id)),
              menuItem(t('menu.copy'), () => {
                void navigator.clipboard?.writeText(id)
                state.menuId = null
                state.emit()
              }),
            )
          : null,
      )
    }

    function menuItem(label, onClick) {
      return h('button', { type: 'button', className: 'xhtask-menu-item', onClick }, label)
    }

    function ArchivedRow({ id, t }) {
      const state = useStore()
      const snapshot = state.snapshots[id]
      const title = snapshot?.title ?? id.slice(0, 12)
      return h('div', { className: 'xhtask-row xhtask-row-archived' },
        h('span', { className: 'xhtask-title', title: id }, title),
        h('span', { className: 'xhtask-time' },
          snapshot ? relativeTime(snapshot.updatedAt) : t('unknown.archived')),
        h('button', {
          type: 'button',
          className: 'xhtask-row-action',
          disabled: state.busyId === id,
          onClick: () => void state.fork(id),
        }, t('menu.fork')),
      )
    }

    function TasksPanel({ t }) {
      const state = useStore()
      const groups = groupSessions(state.sessions, state.pinned)

      return h('div', { className: 'xhtask-panel' },
        h('div', { className: 'xhtask-head' },
          h('span', { className: 'xhtask-head-title' }, t('panel.title')),
          h('span', { className: 'xhtask-head-count' }, String(state.sessions.length)),
          h('button', {
            type: 'button',
            className: 'xhtask-head-action',
            title: t('panel.refresh'),
            onClick: () => void state.refresh(),
          }, '⟳'),
          h('button', {
            type: 'button',
            className: 'xhtask-head-action',
            title: t('panel.close'),
            onClick: () => state.setOpen(false),
          }, '×'),
        ),
        state.actionError !== null
          ? h('div', { className: 'xhtask-action-error', role: 'alert' },
              t('action.failed', { message: state.actionError }))
          : null,
        state.loading && state.sessions.length === 0
          ? h('div', { className: 'xhtask-empty' }, t('loading'))
          : state.error !== null && state.sessions.length === 0
            ? h('div', { className: 'xhtask-empty' },
                `${t('error')}: ${state.error}`,
                h('button', {
                  type: 'button',
                  className: 'xhtask-head-action',
                  onClick: () => void state.refresh(),
                }, t('retry')),
              )
            : state.sessions.length === 0
              ? h('div', { className: 'xhtask-empty' }, t('empty'))
              : h('div', { className: 'xhtask-body' },
                  GROUP_ORDER
                    .filter((key) => groups[key].length > 0)
                    .map((key) =>
                      h('section', { className: 'xhtask-group', key },
                        h('div', { className: 'xhtask-group-label' },
                          t(`group.${key}`),
                          h('span', { className: 'xhtask-head-count' }, String(groups[key].length)),
                        ),
                        groups[key].map((session) =>
                          h(TaskRow, {
                            key: session.sessionId,
                            session,
                            t,
                            pinned: key === 'pinned',
                          }),
                        ),
                      ),
                    ),
                ),
        h('button', {
          type: 'button',
          className: 'xhtask-archived-toggle',
          onClick: () => { state.archivedExpanded = !state.archivedExpanded; state.emit() },
        },
          `${t('group.archived')} (${state.archivedIds.length})`,
          h('span', { className: `xhtask-caret ${state.archivedExpanded ? 'xhtask-caret-open' : ''}`, 'aria-hidden': true }, '▸'),
        ),
        state.archivedExpanded
          ? state.archivedIds.length === 0
            ? h('div', { className: 'xhtask-empty' }, t('empty.archived'))
            : h('div', { className: 'xhtask-archived' },
                h('div', { className: 'xhtask-archived-hint' }, t('group.archived.hint')),
                state.archivedIds.map((id) => h(ArchivedRow, { key: id, id, t })),
              )
          : null,
      )
    }

    function TasksRoot() {
      const t = makeT()
      const state = useStore()
      useEffect(() => {
        const escape = (event) => {
          if (event.key === 'Escape' && state.open) state.setOpen(false)
        }
        window.addEventListener('keydown', escape)
        return () => window.removeEventListener('keydown', escape)
      }, [])
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'xhtask-trigger',
          title: state.open ? t('panel.close') : t('panel.open'),
          onClick: () => state.setOpen(!state.open),
        },
          h('svg', {
            viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
            fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
          },
            h('path', { d: 'M2.5 3.5h8M2.5 8h11M2.5 12.5h6' }),
          ),
          h('span', { className: 'xhtask-trigger-label' }, t('panel.open')),
        ),
        state.open || state.closing
          ? ReactDOM.createPortal(
              h('div', {
                className: state.closing ? 'xhtask-scrim xhtask-scrim-closing' : 'xhtask-scrim',
                onClick: () => state.setOpen(false),
              },
                h('div', {
                  className: state.closing
                    ? 'xhtask-panel-wrap xhtask-panel-wrap-closing'
                    : 'xhtask-panel-wrap',
                  style: { width: PANEL_WIDTH },
                  onClick: (event) => event.stopPropagation(),
                }, h(TasksPanel, { t })),
              ),
              document.body,
            )
          : null,
      )
    }

    // ---------------------------------------------------------------- CSS --

    const CSS = `
.xhtask-trigger{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}.xhtask-trigger:hover,.xhtask-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}
.xhtask-scrim{position:fixed;inset:0;z-index:95;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));animation:xhtask-scrim-in .2s ease-out}
.xhtask-scrim-closing{animation:xhtask-scrim-out .15s ease-in forwards}
@keyframes xhtask-scrim-in{from{opacity:0}}
@keyframes xhtask-scrim-out{to{opacity:0}}
.xhtask-panel-wrap{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-8px 0 24px rgba(0,0,0,.18);animation:xhtask-panel-in .26s cubic-bezier(.23,1,.32,1)}
.xhtask-panel-wrap-closing{animation:xhtask-panel-out .18s cubic-bezier(.23,1,.32,1) forwards}
@keyframes xhtask-panel-in{from{opacity:0;transform:translate3d(24px,0,0) scale(.98)}to{opacity:1;transform:translate3d(0,0,0) scale(1)}}
@keyframes xhtask-panel-out{to{opacity:0;transform:translate3d(24px,0,0) scale(.98)}}
@media (prefers-reduced-motion:reduce){.xhtask-scrim,.xhtask-scrim-closing,.xhtask-panel-wrap,.xhtask-panel-wrap-closing{animation:none}}
.xhtask-panel{display:flex;flex-direction:column;flex:1;min-height:0;width:100%}
.xhtask-head{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.xhtask-head-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.xhtask-head-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
.xhtask-head-action{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;cursor:pointer}.xhtask-head-action:first-of-type{margin-left:auto}.xhtask-head-action+.xhtask-head-action{margin-left:0}.xhtask-head-action:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.xhtask-action-error{flex:none;margin:8px 12px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;overflow-wrap:anywhere}
.xhtask-body{flex:1;min-height:0;overflow:auto;padding:6px}
.xhtask-group{margin-bottom:8px}
.xhtask-group-label{display:flex;align-items:center;gap:6px;padding:6px 6px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.xhtask-row{position:relative;display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 8px;border-radius:8px;cursor:pointer}.xhtask-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhtask-row-busy{opacity:.55}.xhtask-row-archived{cursor:default}
.xhtask-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.xhtask-dot-running{background:var(--dsw-alias-state-business-primary,#2f7cf6);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover)}
.xhtask-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.xhtask-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.xhtask-row-action{flex:none;padding:2px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}.xhtask-row-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.xhtask-menu{position:absolute;right:8px;top:calc(100% - 4px);z-index:5;display:flex;flex-direction:column;min-width:140px;padding:4px;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18))}
.xhtask-menu-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer}.xhtask-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.xhtask-rename{flex:1;min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-state-business-primary,#2f7cf6);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}
.xhtask-archived-toggle{display:flex;align-items:center;gap:6px;flex:none;margin:0;padding:10px 14px;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}.xhtask-archived-toggle:hover{color:var(--dsw-alias-label-primary)}
.xhtask-caret{transition:transform 120ms ease}.xhtask-caret-open{transform:rotate(90deg)}
.xhtask-archived{flex:none;max-height:35%;overflow:auto;padding:0 6px 8px}
.xhtask-archived-hint{padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.xhtask-empty{padding:24px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
`

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-ui-tasks: dictionaries')
      ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'xharness-ui-tasks: styles')
      ctx.slots.inject(
        'conversation.session.header.actions',
        () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'tasks-panel',
          order: 15,
          locale: NS,
        }, TasksRoot),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.rpc = rpc
    exports.store = store
    exports.groupSessions = groupSessions
    exports.normalizeTimestamp = normalizeTimestamp
    exports.sessionTitle = sessionTitle
    exports.relativeTime = relativeTime
    return module.exports
  },
})
