/// <reference path="../shared/assets.d.ts" />
import CSS from './Schedule.css'
import type { PageContext, Translation, ConversationEvents, ConversationViews, ConversationEventDefinition, ProjectionContext, ViewNode } from '../shared/runtime-types'
import { objectValue } from '../shared/runtime-types'

interface ScheduleRecord { id: string; prompt: string; scheduledAt: string; kind: 'after' | 'at' | 'every'; everySeconds?: number }
interface ScheduleState { seq: number; time: number; change: unknown }
interface ScheduleSessionSnapshot { openState: string; views: ReadonlyMap<string, readonly ScheduleRecord[]> }
interface ScheduleProps { useSession<T>(selector: (snapshot: ScheduleSessionSnapshot) => T): T; useProjection(name: string): unknown; t: Translation }
interface ScheduleContext extends PageContext { conversationEvents: ConversationEvents; conversationViews: ConversationViews }


import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { IconChevronDownOutline14, useAnchoredPosition } from '@xharness/dsh-client-ui-primitives'
const { createElement: h, useEffect, useMemo, useRef, useState } = React

const NS = 'schedule.catalog'
const TARGET = 'xharness-schedule'
const STYLE_ID = 'xharness-schedule-catalog-style'
const EMPTY_RECORDS: readonly ScheduleRecord[] = Object.freeze([])
const SECOND_MS = 1_000
const UNIT_SECONDS = Object.freeze([
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
])

const zh = {
  'trigger.one': '{count} 个提醒',
  'trigger.other': '{count} 个提醒',
  'list.aria': '活动提醒',
  'status.scheduled': '等待中',
  'status.overdue': '已逾期',
  'frequency.once': '单次',
  'frequency.every': '{value}{unit}一次',
  'unit.day.one': '天',
  'unit.day.other': '天',
  'unit.hour.one': '小时',
  'unit.hour.other': '小时',
  'unit.minute.one': '分钟',
  'unit.minute.other': '分钟',
  'unit.second.one': '秒',
  'unit.second.other': '秒',
  'relative.now': '现在到期',
  'relative.future': '{value}{unit}后',
  'relative.overdue': '已逾期 {value}{unit}',
}
const en = {
  'trigger.one': '{count} reminder',
  'trigger.other': '{count} reminders',
  'list.aria': 'Active reminders',
  'status.scheduled': 'Scheduled',
  'status.overdue': 'Overdue',
  'frequency.once': 'Once',
  'frequency.every': 'Every {value} {unit}',
  'unit.day.one': 'day',
  'unit.day.other': 'days',
  'unit.hour.one': 'hour',
  'unit.hour.other': 'hours',
  'unit.minute.one': 'minute',
  'unit.minute.other': 'minutes',
  'unit.second.one': 'second',
  'unit.second.other': 'seconds',
  'relative.now': 'Due now',
  'relative.future': 'in {value} {unit}',
  'relative.overdue': '{value} {unit} overdue',
}

function validRecord(raw: unknown): raw is ScheduleRecord {
  const value = objectValue(raw)
  return value !== null
    && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.prompt === 'string'
    && typeof value.scheduledAt === 'string'
    && typeof value.kind === 'string' && ['after', 'at', 'every'].includes(value.kind)
    && Number.isFinite(Date.parse(value.scheduledAt))
}

function nextEveryTarget(record: ScheduleRecord, acceptedAt: string) {
  const target = Date.parse(record.scheduledAt)
  const accepted = Date.parse(acceptedAt)
  const interval = (record.everySeconds ?? 0) * SECOND_MS
  if (!Number.isFinite(target)
    || !Number.isFinite(accepted)
    || !Number.isSafeInteger(interval)
    || interval <= 0
    || accepted < target) return undefined
  const steps = Math.floor((accepted - target) / interval)
  const next = target + ((steps + 1) * interval)
  return Number.isFinite(next) ? new Date(next).toISOString() : undefined
}

/** Browser-local equivalent of the upstream read-only Schedule projection. */
function foldScheduleChanges(changes: readonly unknown[]): ScheduleRecord[] {
  const active = new Map<string, ScheduleRecord>()
  for (const rawChange of changes) {
    const change = objectValue(rawChange)
    if (change?.operation === 'create' && validRecord(change.schedule)) {
      if (!active.has(change.schedule.id)) active.set(change.schedule.id, { ...change.schedule })
      continue
    }
    if ((change?.operation !== 'delete' && change?.operation !== 'dispatch')
      || typeof change.id !== 'string') continue
    const current = active.get(change.id)
    if (current === undefined) continue
    if (change.operation === 'dispatch'
      && current.kind === 'every'
      && Number.isInteger(current.everySeconds)
      && typeof change.acceptedAt === 'string') {
      const scheduledAt = nextEveryTarget(current, change.acceptedAt)
      if (scheduledAt !== undefined) active.set(change.id, { ...current, scheduledAt })
      else active.delete(change.id)
    } else {
      active.delete(change.id)
    }
  }
  return [...active.values()]
}

function scheduleNode(context: ProjectionContext<ScheduleState>, state: ScheduleState) {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: TARGET,
    anchorSeq: state.seq,
    data: state,
  }
}

const scheduleEventDefinition: ConversationEventDefinition<ScheduleState> = {
  kind: 'xharness-schedule-change',
  target: TARGET,
  match: event => event.type === 'schedule/change'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({
    seq: match.event.seq,
    time: match.event.time,
    change: match.event.data,
  }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : scheduleNode(context, context.state),
}

class ScheduleSnapshotBuilder {
  readonly empty: readonly ScheduleRecord[]
  readonly nodes: Map<string, ViewNode<ScheduleState>>
  constructor() {
    this.empty = EMPTY_RECORDS
    this.nodes = new Map<string, ViewNode<ScheduleState>>()
  }

  replace({ nodes }: { nodes: ViewNode<ScheduleState>[] }) {
    this.nodes.clear()
    for (const node of nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply({ upserts }: { upserts: ViewNode<ScheduleState>[] }) {
    for (const node of upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  snapshot() {
    const changes = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
      .map(node => node.data.change)
    const records = foldScheduleChanges(changes)
    return records.length === 0 ? EMPTY_RECORDS : records
  }
}

const scheduleViewDefinition = {
  target: TARGET,
  create: () => new ScheduleSnapshotBuilder(),
}

function unitLabel(unit: string, value: number, t: Translation) {
  return t(`unit.${unit}.${value === 1 ? 'one' : 'other'}`, { count: value })
}

function formatScheduleFrequency(record: ScheduleRecord, t: Translation) {
  if (record.kind !== 'every') return t('frequency.once')
  const selected = UNIT_SECONDS.find(candidate => (record.everySeconds ?? 0) % candidate.seconds === 0)
    ?? { unit: 'second', seconds: 1 }
  const value = (record.everySeconds ?? 0) / selected.seconds
  return t('frequency.every', { value, unit: unitLabel(selected.unit, value, t) })
}

function formatScheduleLocalTime(scheduledAt: string, locale: string) {
  return new Intl.DateTimeFormat(locale || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(Date.parse(scheduledAt))
}

function formatScheduleRelative(scheduledAt: string, now: number, t: Translation) {
  const difference = Date.parse(scheduledAt) - now
  if (difference === 0) return t('relative.now')
  const absoluteSeconds = Math.abs(difference) / SECOND_MS
  const selected = UNIT_SECONDS.find(candidate => absoluteSeconds >= candidate.seconds)
    ?? { unit: 'second', seconds: 1 }
  const value = Math.max(1, difference > 0
    ? Math.ceil(absoluteSeconds / selected.seconds)
    : Math.floor(absoluteSeconds / selected.seconds))
  const unit = unitLabel(selected.unit, value, t)
  return t(difference > 0 ? 'relative.future' : 'relative.overdue', { value, unit })
}

function orderScheduleRecords(records: readonly ScheduleRecord[], now: number) {
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftTime = Date.parse(left.record.scheduledAt)
    const rightTime = Date.parse(right.record.scheduledAt)
    const leftOverdue = leftTime <= now
    const rightOverdue = rightTime <= now
    if (leftOverdue !== rightOverdue) return Number(rightOverdue) - Number(leftOverdue)
    return leftTime - rightTime || left.index - right.index
  }).map(({ record }) => record)
}

// The host's whole-log projection is authoritative. Event-window folding
// remains only as a compatibility fallback for an older backend.
function scheduleRecords(projection: unknown, legacyRecords: readonly ScheduleRecord[]): readonly ScheduleRecord[] {
  return Array.isArray(projection) ? (projection).filter(validRecord) : legacyRecords
}

function ClockIcon() {
  return h('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
  }, [
    h('circle', { key: 'face', cx: 8, cy: 8.5, r: 5.25, stroke: 'currentColor', strokeWidth: 1.25 }),
    h('path', { key: 'hands', d: 'M8 5.5v3.2l2.2 1.25M5.6 1.75h4.8M8 1.75v1.5', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])
}

function ScheduleCatalogAction({ useSession, useProjection, t }: ScheduleProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const projectedRecords = useProjection('schedules')
  const legacyRecords = useSession(snapshot => snapshot.views.get(TARGET) ?? EMPTY_RECORDS)
  const records = scheduleRecords(projectedRecords, legacyRecords)
  const visible = openState === 'open' && records.length > 0
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const catalogRef = useRef<HTMLUListElement>(null)
  const catalogPosition = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef: catalogRef,
    // The actual primitive always anchors below; main passed an ignored side.
    gap: 5,
    margin: 16,
  })

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) || catalogRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SECOND_MS)
    return () => { clearInterval(timer) }
  }, [open])

  useEffect(() => {
    if (visible || !open) return
    setOpen(false)
  }, [visible, open])

  const rows = useMemo(() => orderScheduleRecords(records, now), [records, now])
  if (!visible) return null

  const countLabel = t(records.length === 1 ? 'trigger.one' : 'trigger.other', { count: records.length })
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }
  const trigger = h('button', {
    ref: triggerRef,
    type: 'button',
    className: 'xhsch-trigger',
    'aria-expanded': open,
    'aria-label': countLabel,
    onClick: () => {
      setNow(Date.now())
      setOpen(current => !current)
    },
  }, [
    h(ClockIcon, { key: 'clock' }),
    h('span', { className: 'xhsch-count', key: 'count' }, countLabel),
    h(IconChevronDownOutline14, { className: open ? 'xhsch-trigger-open' : undefined, key: 'chevron' }),
  ])
  const menu = open
    ? ReactDOM.createPortal(h('ul', {
      ref: catalogRef,
      className: 'xhsch-menu',
      style: catalogPosition ?? { visibility: 'hidden', left: 0, top: 0 },
      'aria-label': t('list.aria'),
    }, rows.map(record => {
      const overdue = Date.parse(record.scheduledAt) <= now
      return h('li', {
        className: overdue ? 'xhsch-row xhsch-row-overdue' : 'xhsch-row',
        key: record.id,
      }, [
        h('span', { className: 'xhsch-status', key: 'status' }, [
          h('span', { className: 'xhsch-status-dot', 'aria-hidden': true, key: 'dot' }),
          h('span', { key: 'label' }, t(overdue ? 'status.overdue' : 'status.scheduled')),
        ]),
        h('span', { className: 'xhsch-prompt', key: 'prompt' }, record.prompt),
        h('span', { className: 'xhsch-metadata', key: 'metadata' }, [
          h('span', { key: 'frequency' }, formatScheduleFrequency(record, t)),
          h('span', { 'aria-hidden': true, key: 'separator-1' }, '·'),
          h('span', { key: 'time' }, formatScheduleLocalTime(record.scheduledAt, document.documentElement.lang)),
          h('span', { 'aria-hidden': true, key: 'separator-2' }, '·'),
          h('span', { className: overdue ? 'xhsch-relative-overdue' : undefined, key: 'relative' }, formatScheduleRelative(record.scheduledAt, now, t)),
        ]),
      ])
    })), document.body)
    : null

  return h('div', { ref: rootRef, className: 'xhsch-root', onKeyDown }, [trigger, menu])
}



const inject = ['slots', 'locale', 'conversationEvents', 'conversationViews']

function apply(ctx: ScheduleContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-ui-schedule: dictionaries')
  ctx.effect(() => {
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) return () => {}
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'xharness-ui-schedule: styles')
  ctx.conversationEvents.register(scheduleEventDefinition)
  ctx.conversationViews.register(scheduleViewDefinition)
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'schedule-catalog',
      order: 10,
      locale: NS,
    }, ScheduleCatalogAction),
  )
}


export { apply, inject, foldScheduleChanges, formatScheduleFrequency, formatScheduleRelative, orderScheduleRecords, scheduleRecords }
