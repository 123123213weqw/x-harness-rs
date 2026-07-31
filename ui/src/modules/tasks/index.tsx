/// <reference path="../shared/assets.d.ts" />
import type {IWorkCatalog, WorkCatalogSnapshot} from '../client-runtime/index'
import type { PageContext, Translation } from '../shared/runtime-types'
import { objectValue, errorText } from '../shared/runtime-types'
import * as React from 'react'
import {IconSearchOutline16, IconFolderClose16, IconTrashOutline16, IconEllipsisOutline16, IconChevronDownOutline14, IconChecklistOutline14} from '@xharness/dsh-client-ui-primitives'
import CSS from './Tasks.css'
const {createElement: h, useEffect, useRef, useState, useSyncExternalStore} = React
interface TaskSession { readonly sessionId: string; readonly blank?: boolean; readonly cwd?: string; readonly updatedAt?: unknown; readonly running?: boolean; readonly projections?: { readonly values?: { readonly title?: string } } }
interface TaskWorkspace {readonly workspaceId: string; readonly title: string; readonly sessionIds?: readonly string[]}
interface ArchiveSnapshot {title: string; updatedAt: number; archivedAt?: number; workspaceId?: string | null}
interface ArchivedGroup {workspace: TaskWorkspace | null; ids: string[]}
type GroupKey = 'pinned' | 'today' | 'yesterday' | 'last7' | 'earlier'
interface TaskStore {
  loading: boolean; error: string | null; actionError: string | null
  readonly sessions: readonly TaskSession[]; readonly archivedIds: readonly string[]; readonly workspaces: readonly TaskWorkspace[]
  snapshots: Record<string, ArchiveSnapshot>; pinned: string[]
  busyId: string | null; menuId: string | null; renameId: string | null; deleteConfirmId: string | null; version: number; listeners: Set<() => void>
  subscribe(listener: () => void): () => void; emit(): void; togglePinned(id: string): void
  snapshot(session: TaskSession, t: Translation): void; refresh(signal?: AbortSignal): Promise<void>; rename(id: string, title: string): Promise<void>; archive(id: string): Promise<void>; fork(id: string): Promise<void>
  restore(id: string): Promise<void>; deleteArchived(id: string): Promise<void>; deleteArchivedBatch(ids: readonly string[]): Promise<void>; restoreArchivedBatch(ids: readonly string[]): Promise<void>
}
function stringList(value: unknown): string[] { return Array.isArray(value) ? (value).filter((item: unknown): item is string => typeof item === 'string') : [] }
function sessionList(value: unknown): TaskSession[] {
  if (!Array.isArray(value)) return []
  return (value).flatMap((item: unknown) => {
    const row = objectValue(item)
    if (typeof row.sessionId !== 'string') return []
    const title = objectValue(objectValue(row.projections).values).title
    return [Object.freeze({sessionId: row.sessionId, updatedAt: row.updatedAt,
      ...(typeof row.blank === 'boolean' ? {blank: row.blank} : {}),
      ...(typeof row.running === 'boolean' ? {running: row.running} : {}),
      ...(typeof row.cwd === 'string' ? {cwd: row.cwd} : {}),
      ...(typeof title === 'string' ? {projections: Object.freeze({values: Object.freeze({title})})} : {})})]
  })
}
function archiveSnapshots(value: unknown): Record<string, ArchiveSnapshot> {
  const result: Record<string, ArchiveSnapshot> = {}
  for (const [id, item] of Object.entries(objectValue(value))) {
    const row = objectValue(item)
    if (typeof row.title !== 'string' || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) continue
    const snapshot: ArchiveSnapshot = {title: row.title, updatedAt: row.updatedAt}
    if (typeof row.archivedAt === 'number' && Number.isFinite(row.archivedAt)) snapshot.archivedAt = row.archivedAt
    if (typeof row.workspaceId === 'string' || row.workspaceId === null) snapshot.workspaceId = row.workspaceId
    result[id] = snapshot
  }
  return result
}
function workspaceList(value: unknown): TaskWorkspace[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const row = objectValue(item)
    return typeof row.workspaceId === 'string' && typeof row.title === 'string'
      ? [Object.freeze({workspaceId: row.workspaceId, title: row.title, sessionIds: Object.freeze(stringList(row.sessionIds))})] : []
  })
}
function archivedSessionList(value: unknown): Array<{sessionId: string; title: string | null; updatedAt: unknown}> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const row = objectValue(item)
    return typeof row.sessionId === 'string' ? [{sessionId: row.sessionId, title: typeof row.title === 'string' ? row.title : null, updatedAt: row.updatedAt}] : []
  })
}

const NS = 'xharness.ui.tasks'
const STYLE_ID = 'xharness-tasks-panel-style'
const PINNED_KEY = 'xharness.tasks.pinned.v1'
const ARCHIVE_KEY = 'xharness.tasks.archive-snapshots.v1'

const zh = {
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

// ------------------------------------------------------ runtime service --

interface TasksContext extends PageContext {get(name: 'workCatalog'): IWorkCatalog | undefined}
let catalog: IWorkCatalog | undefined
let refreshGeneration = 0
let commandGeneration = 0
function workCatalog(): IWorkCatalog {
  if (catalog === undefined) throw Error('Work catalog service unavailable')
  return catalog
}

// ------------------------------------------------------------- storage --

function readJson(key: string, fallback: unknown): unknown {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    return value === null ? fallback : value
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    const serialized = JSON.stringify(value)
    if (window.localStorage.getItem(key) !== serialized) window.localStorage.setItem(key, serialized)
  } catch {
    // Private-mode storage may refuse writes; the panel keeps working
    // with in-memory state for this session.
  }
}

// -------------------------------------------------------------- model --

// The host reports updatedAt as epoch milliseconds (matching the frozen
// workspace createdAt wire format); the guard keeps ordering sane if the
// unit ever changes to seconds.
function normalizeTimestamp(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 1e12 ? numeric : numeric * 1000
}

function sessionTitle(item: TaskSession | null | undefined, t: Translation) {
  const title = item?.projections?.values?.title
  if (typeof title === 'string' && title.trim().length > 0) return title
  if (typeof item?.cwd === 'string' && item.cwd.length > 0) {
    const leaf = item.cwd.split(/[\\/]/).filter(Boolean).pop()
    if (leaf !== undefined && leaf.length > 0) return leaf
  }
  return t('untitled')
}

const GROUP_ORDER: readonly GroupKey[] = ['pinned', 'today', 'yesterday', 'last7', 'earlier']

// Timeline grouping adapted from ZCode's groupTaskTimelineItems: pinned
// first, then calendar-day buckets keyed off the local start of day.
function groupSessions(sessions: readonly TaskSession[], pinned: readonly string[], now = Date.now()) {
  const pinnedSet = new Set(pinned)
  const dayMs = 24 * 60 * 60 * 1000
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const today0 = startOfDay.getTime()
  const groups: Record<GroupKey, TaskSession[]> = { pinned: [], today: [], yesterday: [], last7: [], earlier: [] }
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
  const byRecency = (a: TaskSession, b: TaskSession) =>
    normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt)
  for (const key of GROUP_ORDER) groups[key].sort(byRecency)
  return groups
}

function relativeTime(updatedAt: unknown, now = Date.now(), zhLang = true) {
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

function archiveDate(updatedAt: unknown, zhLang: boolean) {
  const stamp = normalizeTimestamp(updatedAt)
  if (!stamp) return ''
  return new Intl.DateTimeFormat(zhLang ? 'zh-CN' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: false,
  }).format(new Date(stamp))
}

function groupArchived(ids: readonly string[], snapshots: Readonly<Record<string, ArchiveSnapshot>>, workspaces: readonly TaskWorkspace[], query = '', workspaceId = '', order = 'newest') {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const known = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace] as const))
  const groups = new Map<string, ArchivedGroup>()
  for (const id of ids) {
    const snapshot: Partial<ArchiveSnapshot> = snapshots[id] ?? {}
    if (normalizedQuery && !String(snapshot.title ?? id).toLocaleLowerCase().includes(normalizedQuery)) continue
    const key = typeof snapshot.workspaceId === 'string' && known.has(snapshot.workspaceId) ? snapshot.workspaceId : ''
    if (workspaceId && key !== (workspaceId === '__other__' ? '' : workspaceId)) continue
    if (!groups.has(key)) groups.set(key, { workspace: known.get(key) ?? null, ids: [] })
    groups.get(key)?.ids.push(id)
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

// Runtime is the only business-state writer. This immutable display projection
// is replaced only by adoptSnapshot; commands cannot optimistically patch it.
interface TaskProjection {
  readonly sessions: readonly TaskSession[]
  readonly archivedIds: readonly string[]
  readonly workspaces: readonly TaskWorkspace[]
}
let projection: TaskProjection = {sessions: [], archivedIds: [], workspaces: []}
// Transient UI operation label, never a source of archive membership. A live
// update can repair it while the command is pending, including older Hosts.
let pendingArchiveLabel: TaskSession | undefined
const store: TaskStore = {
  loading: false,
  error: null,
  actionError: null,
  get sessions() {return projection.sessions},
  get archivedIds() {return projection.archivedIds},
  get workspaces() {return projection.workspaces},
  snapshots: archiveSnapshots(readJson(ARCHIVE_KEY, {})),
  pinned: stringList(readJson(PINNED_KEY, [])),
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
  async refresh(signal) {
    const generation = ++refreshGeneration
    this.loading = true
    this.error = null
    this.emit()
    try {
      await workCatalog().refresh(signal)
      if (generation === refreshGeneration && !signal?.aborted) adoptSnapshot(workCatalog().getSnapshot())
    } catch (error) {
      if (generation === refreshGeneration && !signal?.aborted) this.error = errorText(error)
    } finally {
      if (generation === refreshGeneration) {this.loading = false; this.emit()}
    }
  },
  async rename(id, title) {
    if (this.busyId !== null) return
    const generation = commandGeneration
    this.actionError = null
    this.busyId = id
    this.emit()
    try {
      await workCatalog().rename(id, title)
      if (generation === commandGeneration && this.renameId === id) this.renameId = null
    } catch (error) {
      if (generation === commandGeneration) this.actionError = errorText(error)
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.emit()
      }
    }
  },
  async archive(id) {
    if (this.busyId !== null) return
    pendingArchiveLabel = this.sessions.find((session) => session.sessionId === id)
    const generation = commandGeneration
    this.actionError = null
    this.busyId = id
    this.emit()
    try {
      await workCatalog().archive(id)
    } catch (error) {
      if (generation === commandGeneration) this.actionError = errorText(error)
    } finally {
      if (generation === commandGeneration) {
        pendingArchiveLabel = undefined
        this.busyId = null
        this.menuId = null
        this.emit()
      }
    }
  },
  async fork(id) {
    if (this.busyId !== null) return
    const generation = commandGeneration
    this.actionError = null
    this.busyId = id
    this.emit()
    try {
      await workCatalog().fork(id)
    } catch (error) {
      if (generation === commandGeneration) this.actionError = errorText(error)
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.menuId = null
        this.emit()
      }
    }
  },
  async restore(id) {
    if (this.busyId !== null) return
    const generation = commandGeneration
    this.actionError = null
    this.busyId = id
    this.emit()
    try {
      await workCatalog().unarchive(id)
    } catch (error) {
      if (generation === commandGeneration) this.actionError = errorText(error)
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.emit()
      }
    }
  },
  async deleteArchived(id) {
    if (this.busyId !== null || this.deleteConfirmId !== id) return
    const generation = commandGeneration
    this.actionError = null
    this.busyId = id
    this.emit()
    try {
      await workCatalog().deleteArchived(id)
      if (generation === commandGeneration && this.deleteConfirmId === id) this.deleteConfirmId = null
    } catch (error) {
      if (generation === commandGeneration) this.actionError = errorText(error)
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.emit()
      }
    }
  },
  async deleteArchivedBatch(ids) {
    if (this.busyId !== null || ids.length === 0 ||
        (this.deleteConfirmId !== 'all' && !this.deleteConfirmId?.startsWith('group:'))) return
    const generation = commandGeneration
    this.busyId = 'bulk'
    this.actionError = null
    this.emit()
    const confirmation = this.deleteConfirmId
    let pending = ids.filter((id) => this.archivedIds.includes(id))
    let failures: string[] = []
    try {
      // Children may need deleting before their archived parent. Retry only
      // after at least one successful deletion; stop on a no-progress pass.
      while (pending.length > 0) {
        if (generation !== commandGeneration) return
        const next: string[] = []
        failures = []
        for (const id of pending) {
          if (generation !== commandGeneration) return
          if (!this.archivedIds.includes(id)) continue
          try {
            await workCatalog().deleteArchived(id)
          } catch (error) {
            next.push(id)
            failures.push(errorText(error))
          }
        }
        if (next.length === pending.length) break
        pending = next
      }
      if (generation !== commandGeneration) return
      if (this.deleteConfirmId === confirmation) this.deleteConfirmId = null
      if (pending.length > 0) this.actionError = makeT()('settings.bulkFailed', { count: pending.length, message: failures[0] ?? '' })
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.emit()
      }
    }
  },
  async restoreArchivedBatch(ids) {
    if (this.busyId !== null || ids.length === 0) return
    const generation = commandGeneration
    this.busyId = 'bulk'
    this.actionError = null
    this.emit()
    const failures: string[] = []
    try {
      for (const id of ids) {
        if (generation !== commandGeneration) return
        if (!this.archivedIds.includes(id)) continue
        try {
          await workCatalog().unarchive(id)
        } catch (error) {
          failures.push(errorText(error))
        }
      }
      if (generation !== commandGeneration) return
      if (failures.length > 0) this.actionError = makeT()('settings.bulkRestoreFailed', { count: failures.length, message: failures[0] ?? '' })
    } finally {
      if (generation === commandGeneration) {
        this.busyId = null
        this.emit()
      }
    }
  },
}

function makeT(): Translation {
  const dict: Readonly<Record<string, string>> = document.documentElement.lang.startsWith('zh') ? zh : en
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

function TaskRow({ session, t, pinned, openSession }: {session: TaskSession; t: Translation; pinned: boolean; openSession?: (id: string) => void}) {
  const state = useStore()
  const id = session.sessionId
  const isPinned = pinned
  const renaming = state.renameId === id
  const busy = state.busyId === id
  const title = sessionTitle(session, t)
  const inputRef = useRef<HTMLInputElement>(null)
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
    h('button', { type: 'button', className: 'xhtask-title xhwork-task-title', title: `${title} · ${id}`, disabled: busy, onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); openSession?.(id) } }, title),
    h('span', { className: 'xhtask-time' }, relativeTime(session.updatedAt, Date.now(), document.documentElement.lang.startsWith('zh'))),
    state.menuId === id
      ? h('div', { className: 'xhtask-menu', onClick: (event: React.MouseEvent<HTMLElement>) => event.stopPropagation() },
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

function menuItem(label: string, onClick: () => void) {
  return h('button', { type: 'button', className: 'xhtask-menu-item', onClick }, label)
}

function ArchivedRow({ id, t }: {id: string; t: Translation}) {
  const state = useStore()
  const snapshot: Partial<ArchiveSnapshot> | undefined = state.snapshots[id]
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

function TasksPanel({ t, openSession }: {t: Translation; openSession(id: string): void}) {
  const state = useStore()
  const groups = groupSessions(state.sessions, state.pinned)
  const visibleCount = Object.values(groups).reduce((count, rows) => count + rows.length, 0)

  return h('div', { className: 'xhtask-panel' },
    h('div', { className: 'xhtask-head' },
      h('span', { className: 'xhtask-head-title' }, t('panel.title')),
      h('span', { className: 'xhtask-head-count' }, String(visibleCount)),
      h('button', {
        type: 'button',
        className: 'xhtask-head-action',
        title: t('panel.refresh'),
        onClick: () => void state.refresh(),
      }, '⟳'),
    ),
    state.actionError !== null
      ? h('div', { className: 'xhtask-action-error', role: 'alert' },
          t('action.failed', { message: state.actionError }))
      : null,
    state.loading && visibleCount === 0
      ? h('div', { className: 'xhtask-empty' }, t('loading'))
      : state.error !== null && visibleCount === 0
        ? h('div', { className: 'xhtask-empty' },
            `${t('error')}: ${state.error}`,
            h('button', {
              type: 'button',
              className: 'xhtask-head-action',
              onClick: () => void state.refresh(),
            }, t('retry')),
          )
        : visibleCount === 0
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
                        t, openSession,
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
  const [menuId, setMenuId] = useState<string | null>(null)
  useTaskRefresh()
  useEffect(() => () => {store.deleteConfirmId = null}, [])
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
        h('input', { type: 'search', value: query, placeholder: t('settings.search'), 'aria-label': t('settings.search'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      ),
      h('label', { className: 'xhtask-settings-select' },
        h(IconChecklistOutline14, { size: 16 }),
        h('select', { value: order, 'aria-label': t('settings.allChats'), onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setOrder(event.target.value) },
          h('option', { value: 'newest' }, t('settings.allChats')),
          h('option', { value: 'oldest' }, t('settings.oldest')),
        ),
        h(IconChevronDownOutline14, { size: 14 }),
      ),
      h('label', { className: 'xhtask-settings-select xhtask-settings-project-select' },
        h(IconFolderClose16, { size: 18 }),
        h('select', { value: projectId, 'aria-label': t('settings.allProjects'), onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setProjectId(event.target.value) },
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

function adoptSnapshot(snapshot: WorkCatalogSnapshot): void {
  store.loading = snapshot.loading
  store.error = snapshot.error
  // A not-yet-arrived baseline must not erase local pin/archive preferences.
  if (snapshot.phase !== 'ready') {store.emit(); return}
  const previous = projection
  const sessions = sessionList(snapshot.sessions)
  const archivedIds = stringList(snapshot.archivedSessionIds)
  const archived = new Set(archivedIds)
  const workspaces = workspaceList(snapshot.workspaces)
  projection = Object.freeze({
    sessions: Object.freeze(sessions.filter(session => !archived.has(session.sessionId))),
    archivedIds: Object.freeze(archivedIds), workspaces: Object.freeze(workspaces),
  })
  // Cache only display labels; membership comes exclusively from the owner.
  // A command acknowledgement cannot recreate a restored/deleted archive row.
  if (pendingArchiveLabel !== undefined) {
    pendingArchiveLabel = sessions.find(session => session.sessionId === pendingArchiveLabel?.sessionId) ?? pendingArchiveLabel
    if (archived.has(pendingArchiveLabel.sessionId) && !previous.archivedIds.includes(pendingArchiveLabel.sessionId)) {
      store.snapshot(pendingArchiveLabel, makeT())
    }
  }
  for (const id of previous.archivedIds) {if (!archived.has(id)) delete store.snapshots[id]}
  const workspaceBySession = new Map<string, string>()
  for (const workspace of store.workspaces) {
    for (const id of workspace.sessionIds ?? []) workspaceBySession.set(id, workspace.workspaceId)
  }
  for (const session of archivedSessionList(snapshot.archivedSessions)) {
    if (!store.archivedIds.includes(session.sessionId)) continue
    const previous: Partial<ArchiveSnapshot> = store.snapshots[session.sessionId] ?? {}
    store.snapshots[session.sessionId] = {...previous,
      title: session.title || previous.title || session.sessionId,
      updatedAt: normalizeTimestamp(session.updatedAt),
      workspaceId: workspaceBySession.get(session.sessionId) ?? previous.workspaceId ?? null}
  }
  writeJson(ARCHIVE_KEY, store.snapshots)
  const live = new Set(store.sessions.map(session => session.sessionId))
  store.pinned = store.pinned.filter(id => live.has(id) && !archived.has(id))
  writeJson(PINNED_KEY, store.pinned)
  store.emit()
}
function useTaskRefresh(): void {
  useEffect(() => {
    const controller = new AbortController()
    void store.refresh(controller.signal)
    return () => {controller.abort(); store.menuId = null; store.renameId = null}
  }, [])
}

function TasksPage({openSession}: {openSession(id: string): void}) {
  const t = makeT()
  useTaskRefresh()
  return h(TasksPanel, {t, openSession})
}

// ---------------------------------------------------------------- CSS --


const inject = ['slots', 'locale', 'workCatalog']

function apply(ctx: TasksContext) {
  const service = ctx.get('workCatalog')
  if (service === undefined) throw Error('tasks: Work catalog service unavailable')
  ctx.effect(() => {
    catalog = service
    const unsubscribe = service.subscribe(() => adoptSnapshot(service.getSnapshot()))
    adoptSnapshot(service.getSnapshot())
    return () => {unsubscribe(); if (catalog === service) {catalog = undefined; pendingArchiveLabel = undefined; commandGeneration++; refreshGeneration++; store.busyId = null; store.menuId = null; store.renameId = null; store.deleteConfirmId = null}}
  }, 'xharness-ui-tasks: Work catalog subscription')
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
    'work.center.tasks',
    () => ctx.slots.register({
      name: 'work.center.tasks',
      id: 'tasks-panel',
      order: 15,
      locale: NS,
    }, TasksPage),
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'archived-chats', order: 35,
    label: () => makeT()('settings.archive'),
  }, ArchivedSettings))
}


export {apply, inject, store, groupSessions, normalizeTimestamp, sessionTitle, relativeTime, groupArchived}
