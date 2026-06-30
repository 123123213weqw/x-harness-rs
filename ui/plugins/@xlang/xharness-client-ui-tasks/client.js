// Task list organization panel: pinned section, timeline grouping, inline
// rename and archive. Archived-session recovery and deletion live in Settings.
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
    const { IconSearchOutline16, IconFolderClose16, IconTrashOutline16, IconEllipsisOutline16, IconChevronDownOutline14, IconChecklistOutline14 } = require('@xharness/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'xharness.ui.tasks'
    const STYLE_ID = 'xharness-tasks-panel-style'
    const PINNED_KEY = 'xharness.tasks.pinned.v1'
    const ARCHIVE_KEY = 'xharness.tasks.archive-snapshots.v1'
    const PANEL_WIDTH = 360

    function panelExitWatchdogMs() {
      const value = window.getComputedStyle?.(document.documentElement)
        ?.getPropertyValue('--xh-duration-panel-out')?.trim() ?? ''
      const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)$/.exec(value)
      const durationMs = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 180
      // Keep the watchdog beyond the CSS animation, including custom token values.
      return Math.max(1000, Math.ceil(durationMs + 500))
    }

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
      'settings.archive': '归档会话',
      'settings.subtitle': '恢复原会话，或永久删除不再需要的会话。',
      'settings.search': '搜索已归档会话',
      'settings.allChats': '全部会话',
      'settings.newest': '最新优先',
      'settings.oldest': '最早优先',
      'settings.allProjects': '全部项目',
      'settings.other': '其他会话',
      'settings.chats': '{count} 个会话',
      'settings.noMatches': '没有符合条件的归档会话。',
      'settings.deleteAll': '全部删除',
      'settings.deleteGroup': '删除此项目的归档会话',
      'settings.restoreGroup': '恢复此项目的归档会话',
      'settings.bulkConfirm': '永久删除 {count} 个归档会话？此操作无法撤销。',
      'settings.bulkFailed': '{count} 个会话删除失败：{message}',
      'settings.bulkRestoreFailed': '{count} 个会话恢复失败：{message}',
      'group.archived.hint': '归档仅隐藏会话。永久删除会清除会话、附件与工具归档；独立调试日志和共享审计快照不在此操作范围内。',
      'menu.pin': '置顶',
      'menu.unpin': '取消置顶',
      'menu.rename': '重命名',
      'menu.archive': '归档',
      'menu.restore': '恢复',
      'menu.delete': '永久删除',
      'delete.confirm': '永久删除「{title}」？此操作无法撤销。',
      'delete.cancel': '取消',
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
      'settings.archive': 'Archived chats',
      'settings.subtitle': 'Restore an original chat or permanently delete one you no longer need.',
      'settings.search': 'Search archived chats',
      'settings.allChats': 'All chats',
      'settings.newest': 'Newest first',
      'settings.oldest': 'Oldest first',
      'settings.allProjects': 'All projects',
      'settings.other': 'Other chats',
      'settings.chats': '{count} chats',
      'settings.noMatches': 'No archived chats match your filters.',
      'settings.deleteAll': 'Delete all',
      'settings.deleteGroup': 'Delete archived chats in this project',
      'settings.restoreGroup': 'Restore archived chats in this project',
      'settings.bulkConfirm': 'Permanently delete {count} archived chats? This cannot be undone.',
      'settings.bulkFailed': 'Could not delete {count} chats: {message}',
      'settings.bulkRestoreFailed': 'Could not restore {count} chats: {message}',
      'group.archived.hint': 'Archiving only hides a session. Permanent deletion removes its history, attachments and tool archives, but not separate debug logs or shared audit snapshots.',
      'menu.pin': 'Pin',
      'menu.unpin': 'Unpin',
      'menu.rename': 'Rename',
      'menu.archive': 'Archive',
      'menu.restore': 'Restore',
      'menu.delete': 'Delete permanently',
      'delete.confirm': 'Permanently delete “{title}”? This cannot be undone.',
      'delete.cancel': 'Cancel',
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

    function archiveDate(updatedAt, zhLang) {
      const stamp = normalizeTimestamp(updatedAt)
      if (!stamp) return ''
      return new Intl.DateTimeFormat(zhLang ? 'zh-CN' : 'en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
        hour12: false,
      }).format(new Date(stamp))
    }

    function groupArchived(ids, snapshots, workspaces, query = '', workspaceId = '', order = 'newest') {
      const normalizedQuery = query.trim().toLocaleLowerCase()
      const known = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
      const groups = new Map()
      for (const id of ids) {
        const snapshot = snapshots[id] ?? {}
        if (normalizedQuery && !String(snapshot.title ?? id).toLocaleLowerCase().includes(normalizedQuery)) continue
        const key = known.has(snapshot.workspaceId) ? snapshot.workspaceId : ''
        if (workspaceId && key !== (workspaceId === '__other__' ? '' : workspaceId)) continue
        if (!groups.has(key)) groups.set(key, { workspace: known.get(key) ?? null, ids: [] })
        groups.get(key).ids.push(id)
      }
      for (const group of groups.values()) {
        group.ids.sort((left, right) => {
          const difference = normalizeTimestamp(snapshots[right]?.updatedAt) - normalizeTimestamp(snapshots[left]?.updatedAt)
          return (order === 'oldest' ? -difference : difference) || left.localeCompare(right)
        })
      }
      return [...groups.values()].sort((left, right) => {
        const leftIndex = workspaces.findIndex((workspace) => workspace.workspaceId === left.workspace?.workspaceId)
        const rightIndex = workspaces.findIndex((workspace) => workspace.workspaceId === right.workspace?.workspaceId)
        return (leftIndex < 0 ? Infinity : leftIndex) - (rightIndex < 0 ? Infinity : rightIndex)
      })
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
      workspaces: [],
      snapshots: readJson(ARCHIVE_KEY, {}),
      pinned: readJson(PINNED_KEY, []),
      busyId: null,
      menuId: null,
      renameId: null,
      deleteConfirmId: null,
      version: 0,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        this.version += 1
        for (const listener of this.listeners) listener()
      },
      // animationend owns unmount; the timer only prevents a stuck panel when
      // the animation never fires (hidden tab, removed stylesheet, etc.).
      setOpen(open) {
        if (open) {
          window.clearTimeout(this.closeTimer)
          this.closeTimer = 0
          this.closing = false
          this.open = true
          void this.refresh()
        } else if (this.open && !this.closing) {
          if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
            this.open = false
            this.closing = false
            this.menuId = null
            this.renameId = null
            this.deleteConfirmId = null
            this.emit()
            return
          }
          this.closing = true
          this.closeTimer = window.setTimeout(() => this.finishClose(), panelExitWatchdogMs())
        }
        this.menuId = null
        this.renameId = null
        this.deleteConfirmId = null
        this.emit()
      },
      finishClose() {
        if (!this.closing) return
        window.clearTimeout(this.closeTimer)
        this.closeTimer = 0
        this.open = false
        this.closing = false
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
        const workspace = this.workspaces.find((item) => item.sessionIds?.includes(session.sessionId))
        this.snapshots[session.sessionId] = {
          title: sessionTitle(session, t),
          updatedAt: normalizeTimestamp(session.updatedAt),
          archivedAt: Date.now(),
          workspaceId: workspace?.workspaceId ?? null,
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
          this.workspaces = workspaces?.items ?? []
          const workspaceBySession = new Map()
          for (const workspace of this.workspaces) {
            for (const id of workspace.sessionIds ?? []) workspaceBySession.set(id, workspace.workspaceId)
          }
          for (const session of workspaces?.archivedSessions ?? []) {
            if (!this.archivedIds.includes(session.sessionId)) continue
            const previous = this.snapshots[session.sessionId] ?? {}
            this.snapshots[session.sessionId] = {
              ...previous,
              title: session.title || previous.title || session.sessionId,
              updatedAt: normalizeTimestamp(session.updatedAt),
              workspaceId: workspaceBySession.get(session.sessionId) ?? previous.workspaceId ?? null,
            }
          }
          writeJson(ARCHIVE_KEY, this.snapshots)
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
      async restore(id) {
        if (this.busyId !== null) return
        this.actionError = null
        this.busyId = id
        this.emit()
        try {
          await rpc('workspace.unarchiveSession', { sessionId: id })
          this.archivedIds = this.archivedIds.filter((candidate) => candidate !== id)
          delete this.snapshots[id]
          writeJson(ARCHIVE_KEY, this.snapshots)
          await this.refresh()
        } catch (error) {
          this.actionError = String(error?.message ?? error)
        } finally {
          this.busyId = null
          this.emit()
        }
      },
      async deleteArchived(id) {
        if (this.busyId !== null || this.deleteConfirmId !== id) return
        this.actionError = null
        this.busyId = id
        this.emit()
        try {
          await rpc('session.delete', { sessionId: id })
          this.archivedIds = this.archivedIds.filter((candidate) => candidate !== id)
          this.pinned = this.pinned.filter((candidate) => candidate !== id)
          delete this.snapshots[id]
          writeJson(ARCHIVE_KEY, this.snapshots)
          writeJson(PINNED_KEY, this.pinned)
          this.deleteConfirmId = null
          await this.refresh()
        } catch (error) {
          this.actionError = String(error?.message ?? error)
        } finally {
          this.busyId = null
          this.emit()
        }
      },
      async deleteArchivedBatch(ids) {
        if (this.busyId !== null || ids.length === 0 ||
            (this.deleteConfirmId !== 'all' && !this.deleteConfirmId?.startsWith('group:'))) return
        this.busyId = 'bulk'
        this.actionError = null
        this.emit()
        let pending = ids.filter((id) => this.archivedIds.includes(id))
        let failures = []
        try {
          // Children may need deleting before their archived parent. Retry only
          // after at least one successful deletion; stop on a no-progress pass.
          while (pending.length > 0) {
            const next = []
            failures = []
            for (const id of pending) {
              try {
                await rpc('session.delete', { sessionId: id })
                this.archivedIds = this.archivedIds.filter((candidate) => candidate !== id)
                this.pinned = this.pinned.filter((candidate) => candidate !== id)
                delete this.snapshots[id]
              } catch (error) {
                next.push(id)
                failures.push(String(error?.message ?? error))
              }
            }
            if (next.length === pending.length) break
            pending = next
          }
          writeJson(ARCHIVE_KEY, this.snapshots)
          writeJson(PINNED_KEY, this.pinned)
          this.deleteConfirmId = null
          await this.refresh()
          if (pending.length > 0) this.actionError = makeT()('settings.bulkFailed', { count: pending.length, message: failures[0] })
        } finally {
          this.busyId = null
          this.emit()
        }
      },
      async restoreArchivedBatch(ids) {
        if (this.busyId !== null || ids.length === 0) return
        this.busyId = 'bulk'
        this.actionError = null
        this.emit()
        const failures = []
        try {
          for (const id of ids.filter((candidate) => this.archivedIds.includes(candidate))) {
            try {
              await rpc('workspace.unarchiveSession', { sessionId: id })
              this.archivedIds = this.archivedIds.filter((candidate) => candidate !== id)
              delete this.snapshots[id]
            } catch (error) {
              failures.push(String(error?.message ?? error))
            }
          }
          writeJson(ARCHIVE_KEY, this.snapshots)
          await this.refresh()
          if (failures.length > 0) this.actionError = makeT()('settings.bulkRestoreFailed', { count: failures.length, message: failures[0] })
        } finally {
          this.busyId = null
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
      useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.version,
      )
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
      const busy = state.busyId !== null
      return h('div', { className: 'xhtask-archived-item' },
        h('div', { className: 'xhtask-archive-line' },
        h('div', { className: 'xhtask-archive-meta' },
          h('span', { className: 'xhtask-archive-title', title: id }, title),
          h('span', { className: 'xhtask-archive-date' }, archiveDate(snapshot?.updatedAt, document.documentElement.lang.startsWith('zh')) || t('unknown.archived')),
        ),
        h('button', {
          type: 'button', className: 'xhtask-archive-trash',
          title: t('menu.delete'), 'aria-label': `${t('menu.delete')}：${title}`,
          disabled: busy,
          onClick: () => { state.deleteConfirmId = id; state.emit() },
        }, h(IconTrashOutline16, { size: 18 })),
        h('button', {
          type: 'button',
          className: 'xhtask-archive-restore',
          disabled: busy,
          onClick: () => void state.restore(id),
        }, t('menu.restore')),
        ),
        state.deleteConfirmId === id
          ? h('div', { className: 'xhtask-delete-confirm', role: 'alertdialog', 'aria-label': t('menu.delete') },
              h('div', null, t('delete.confirm', { title })),
              h('div', { className: 'xhtask-delete-buttons' },
                h('button', { type: 'button', disabled: busy, onClick: () => { state.deleteConfirmId = null; state.emit() } }, t('delete.cancel')),
                h('button', { type: 'button', disabled: busy, className: 'xhtask-delete-final', onClick: () => void state.deleteArchived(id) }, t('menu.delete')),
              ),
            )
          : null,
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
      )
    }

    function ArchivedSettings() {
      const t = makeT()
      const state = useStore()
      const [query, setQuery] = useState('')
      const [order, setOrder] = useState('newest')
      const [projectId, setProjectId] = useState('')
      const [menuId, setMenuId] = useState(null)
      useEffect(() => {
        void store.refresh()
        return () => {
          store.deleteConfirmId = null
        }
      }, [])
      const groups = groupArchived(state.archivedIds, state.snapshots, state.workspaces, query, projectId, order)
      const bulkIds = state.deleteConfirmId === 'all'
        ? [...state.archivedIds]
        : state.deleteConfirmId?.startsWith('group:')
          ? groupArchived(state.archivedIds, state.snapshots, state.workspaces, '', state.deleteConfirmId.slice(6)).flatMap((group) => group.ids)
          : []
      return h('section', { className: 'xhtask-settings-root' },
        h('header', { className: 'xhtask-settings-head' },
          h('h2', null, t('settings.archive')),
          h('button', { type: 'button', className: 'xhtask-settings-delete-all', disabled: state.archivedIds.length === 0 || state.busyId !== null, onClick: () => { state.deleteConfirmId = 'all'; state.emit() } },
            h(IconTrashOutline16, { size: 18 }), t('settings.deleteAll')),
        ),
        h('div', { className: 'xhtask-settings-filters' },
          h('label', { className: 'xhtask-settings-search' },
            h(IconSearchOutline16, { size: 18 }),
            h('input', { type: 'search', value: query, placeholder: t('settings.search'), 'aria-label': t('settings.search'), onChange: (event) => setQuery(event.target.value) }),
          ),
          h('label', { className: 'xhtask-settings-select' },
            h(IconChecklistOutline14, { size: 16 }),
            h('select', { value: order, 'aria-label': t('settings.allChats'), onChange: (event) => setOrder(event.target.value) },
              h('option', { value: 'newest' }, t('settings.allChats')),
              h('option', { value: 'oldest' }, t('settings.oldest')),
            ),
            h(IconChevronDownOutline14, { size: 14 }),
          ),
          h('label', { className: 'xhtask-settings-select xhtask-settings-project-select' },
            h(IconFolderClose16, { size: 18 }),
            h('select', { value: projectId, 'aria-label': t('settings.allProjects'), onChange: (event) => setProjectId(event.target.value) },
              h('option', { value: '' }, t('settings.allProjects')),
              state.workspaces.map((workspace) => h('option', { key: workspace.workspaceId, value: workspace.workspaceId }, workspace.title)),
            ),
            h(IconChevronDownOutline14, { size: 14 }),
          ),
        ),
        bulkIds.length > 0
          ? h('div', { className: 'xhtask-delete-confirm xhtask-delete-confirm-bulk', role: 'alertdialog', 'aria-label': t(state.deleteConfirmId === 'all' ? 'settings.deleteAll' : 'settings.deleteGroup') },
              h('div', null, t('settings.bulkConfirm', { count: bulkIds.length })),
              h('p', null, t('group.archived.hint')),
              h('div', { className: 'xhtask-delete-buttons' },
                h('button', { type: 'button', disabled: state.busyId !== null, onClick: () => { state.deleteConfirmId = null; state.emit() } }, t('delete.cancel')),
                h('button', { type: 'button', disabled: state.busyId !== null, className: 'xhtask-delete-final', onClick: () => void state.deleteArchivedBatch(bulkIds) }, t(state.deleteConfirmId === 'all' ? 'settings.deleteAll' : 'settings.deleteGroup')),
              ),
            )
          : null,
        state.actionError !== null
          ? h('div', { className: 'xhtask-action-error', role: 'alert' }, t('action.failed', { message: state.actionError }))
          : null,
        state.error !== null
          ? h('div', { className: 'xhtask-action-error', role: 'alert' }, `${t('error')}: ${state.error}`)
          : null,
        state.loading && state.archivedIds.length === 0
          ? h('p', { className: 'xhtask-settings-empty' }, t('loading'))
          : state.archivedIds.length === 0
            ? h('p', { className: 'xhtask-settings-empty' }, t('empty.archived'))
            : groups.length === 0
              ? h('p', { className: 'xhtask-settings-empty' }, t('settings.noMatches'))
              : h('div', { className: 'xhtask-settings-groups' },
                  groups.map((group) => {
                    const key = group.workspace?.workspaceId ?? ''
                    return h('section', { className: 'xhtask-settings-group', key: key || 'other' },
                      h('header', { className: 'xhtask-settings-group-head' },
                        h('div', { className: 'xhtask-settings-group-name' }, h(IconFolderClose16, { size: 18 }), h('span', null, group.workspace?.title ?? t('settings.other'))),
                        h('span', { className: 'xhtask-settings-group-count' }, t('settings.chats', { count: group.ids.length })),
                        h('button', { type: 'button', className: 'xhtask-settings-group-menu-button', 'aria-label': `${group.workspace?.title ?? t('settings.other')} · ${t('settings.allChats')}`, onClick: () => setMenuId(menuId === key ? null : key) }, h(IconEllipsisOutline16, { size: 18 })),
                        menuId === key
                          ? h('div', { className: 'xhtask-settings-group-menu' },
                              h('button', { type: 'button', onClick: () => { setMenuId(null); void state.restoreArchivedBatch(group.ids) } }, t('settings.restoreGroup')),
                              h('button', { type: 'button', onClick: () => { setMenuId(null); state.deleteConfirmId = `group:${key || '__other__'}`; state.emit() } }, t('settings.deleteGroup')),
                            )
                          : null,
                      ),
                      h('div', { className: 'xhtask-settings-list' }, group.ids.map((id) => h(ArchivedRow, { key: id, id, t }))),
                    )
                  }),
                ),
        h('p', { className: 'xhtask-settings-hint' }, t('group.archived.hint')),
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
          onClick: () => state.setOpen(state.closing || !state.open),
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
                  onAnimationEnd: (event) => {
                    if (event.target === event.currentTarget && event.animationName === 'xhtask-panel-out') {
                      state.finishClose()
                    }
                  },
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
.xhtask-scrim{position:fixed;inset:0;z-index:95;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));animation:xhtask-scrim-in var(--xh-duration-overlay-in,200ms) var(--xh-ease-out,ease-out)}
.xhtask-scrim-closing{animation:xhtask-scrim-out var(--xh-duration-overlay-out,150ms) var(--xh-ease-in,ease-in) forwards}
@keyframes xhtask-scrim-in{from{opacity:0}}
@keyframes xhtask-scrim-out{to{opacity:0}}
.xhtask-panel-wrap{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-8px 0 24px rgba(0,0,0,.18);animation:xhtask-panel-in var(--xh-duration-panel-in,260ms) var(--xh-ease-panel,cubic-bezier(.23,1,.32,1))}
.xhtask-panel-wrap-closing{animation:xhtask-panel-out var(--xh-duration-panel-out,180ms) var(--xh-ease-panel,cubic-bezier(.23,1,.32,1)) forwards}
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
.xhtask-settings-root{padding:0 0 24px;color:var(--dsw-alias-label-primary);font-size:14px}
.xhtask-settings-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}
.xhtask-settings-head h2{margin:0;font-size:32px;font-weight:600;line-height:1.2;letter-spacing:-.035em}
.xhtask-settings-delete-all{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:7px 12px;border:0;border-radius:10px;background:#fff0f0;color:#e12626;font:inherit;white-space:nowrap;cursor:pointer}.xhtask-settings-delete-all:hover{background:#ffe4e4}.xhtask-settings-delete-all:disabled{opacity:.45;cursor:default}
.xhtask-settings-filters{display:grid;grid-template-columns:minmax(160px,1fr) minmax(145px,.35fr) minmax(160px,.4fr);gap:10px;margin-bottom:36px}
.xhtask-settings-search,.xhtask-settings-select{display:flex;align-items:center;gap:10px;min-height:42px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#717171)}
.xhtask-settings-search{border-radius:999px}.xhtask-settings-search:focus-within,.xhtask-settings-select:focus-within{outline:2px solid var(--dsw-alias-label-tertiary,#bcbcbc);outline-offset:1px}
.xhtask-settings-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit}.xhtask-settings-search input::placeholder{color:var(--dsw-alias-label-tertiary,#999)}
.xhtask-settings-select select{width:100%;min-width:0;flex:1;appearance:none;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.xhtask-settings-select svg:last-child{flex:none;pointer-events:none}
.xhtask-settings-groups{display:flex;flex-direction:column;gap:48px}
.xhtask-settings-group-head{position:relative;display:flex;align-items:center;gap:16px;margin-bottom:14px;min-height:27px}
.xhtask-settings-group-name{display:flex;align-items:center;gap:10px;min-width:0;font-size:16px;font-weight:600}.xhtask-settings-group-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xhtask-settings-group-count{margin-left:auto;color:var(--dsw-alias-label-tertiary,#777);white-space:nowrap}
.xhtask-settings-group-menu-button{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer}.xhtask-settings-group-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f4f4)}
.xhtask-settings-group-menu{position:absolute;right:0;top:30px;z-index:6;display:grid;min-width:215px;padding:5px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 28px rgba(0,0,0,.12)}
.xhtask-settings-group-menu button{padding:9px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.xhtask-settings-group-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}
.xhtask-settings-list{overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#e7e7e7);border-radius:18px;padding:0 20px}
.xhtask-archived-item+.xhtask-archived-item{border-top:1px solid var(--dsw-alias-border-l1,#ededed)}
.xhtask-archive-line{display:flex;align-items:center;gap:15px;min-height:76px;padding:10px 0}
.xhtask-archive-meta{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.xhtask-archive-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary)}.xhtask-archive-date{color:var(--dsw-alias-label-tertiary,#777);font-size:13px}
.xhtask-archive-trash{display:grid;flex:none;place-items:center;width:30px;height:32px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#909090);cursor:pointer}.xhtask-archive-trash:hover{background:#fff0f0;color:#d32828}
.xhtask-archive-restore{flex:none;min-height:37px;padding:5px 12px;border:0;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.xhtask-archive-restore:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}.xhtask-archive-restore:disabled,.xhtask-archive-trash:disabled{opacity:.45;cursor:default}
.xhtask-settings-hint{margin:24px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.xhtask-settings-empty{padding:36px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:14px}
[role="dialog"]:has(.xhtask-settings-root){width:min(1180px,calc(100vw - 32px));max-width:calc(100vw - 32px)}
.xhtask-delete-confirm{margin:8px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.xhtask-delete-confirm-bulk{margin:-18px 0 24px;padding:16px}.xhtask-delete-confirm-bulk p{margin:5px 0 0;color:var(--dsw-alias-label-secondary)}
.xhtask-delete-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}.xhtask-delete-buttons button{padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.xhtask-delete-buttons .xhtask-delete-final{background:var(--dsw-alias-state-danger,#b83a3a);border-color:transparent;color:#fff}
.xhtask-empty{padding:24px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
@media(max-width:760px){.xhtask-settings-head h2{font-size:26px}.xhtask-settings-filters{grid-template-columns:1fr 1fr}.xhtask-settings-search{grid-column:1/-1}.xhtask-settings-group-count{font-size:12px}.xhtask-settings-list{padding:0 12px}}
@media(max-width:480px){.xhtask-settings-filters{grid-template-columns:1fr}.xhtask-settings-search{grid-column:auto}.xhtask-archive-title{font-size:12px}.xhtask-archive-date{font-size:11px}.xhtask-archive-restore{font-size:12px;padding:5px 8px}}
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
      // Keep archive management reachable even when every session is archived
      // and the conversation header is not mounted.
      ctx.slots.inject(
        'sidebar.footer.action',
        () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'tasks-panel',
          order: 15,
          locale: NS,
        }, TasksRoot),
      )
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'archived-chats', order: 35,
        label: () => makeT()('settings.archive'),
      }, ArchivedSettings))
    }

    exports.apply = apply
    exports.inject = inject
    exports.rpc = rpc
    exports.store = store
    exports.groupSessions = groupSessions
    exports.normalizeTimestamp = normalizeTimestamp
    exports.sessionTitle = sessionTitle
    exports.relativeTime = relativeTime
    exports.groupArchived = groupArchived
    return module.exports
  },
})
