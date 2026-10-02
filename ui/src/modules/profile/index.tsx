/// <reference path="../shared/assets.d.ts" />
import CSS from './Profile.css'
import type { PageContext, Translation, ObservableStore } from '../shared/runtime-types'
import { objectValue } from '../shared/runtime-types'

type Bucket = 'input' | 'cacheRead' | 'cacheWrite' | 'output'
const BUCKETS: readonly Bucket[] = ['input', 'cacheRead', 'cacheWrite', 'output']
interface CalendarDay { date: Date; key: string; future: boolean }
interface SessionListSnapshot { byId: Readonly<Record<string, unknown>> }
interface ProfileProps { list: ObservableStore<SessionListSnapshot>; t: Translation }
interface ProfileContext extends PageContext { sessions: { list: ObservableStore<SessionListSnapshot> } }

import * as React from 'react'
const { createElement: h, useMemo, useState, useSyncExternalStore } = React
const NS = 'xharness.profile'
const STYLE_ID = 'xharness-profile-style'
// A full year inside the settings dialog makes individual days too small.
// Keep the history available in navigable, half-year windows instead.
const WEEKS = 26

const zh = {
  nav: '使用档案', title: '使用档案', subtitle: '本机可见会话的每日 Token 用量（UTC）',
  total: '累计 Token', peak: '单日峰值', active: '活跃天数', chats: '会话数',
  activity: 'Token 活跃度', daily: '每日', weekly: '每周', cumulative: '累计',
  previousPeriod: '前半年', nextPeriod: '后半年', noData: '还没有可统计的 Token 用量。',
  breakdown: '用量构成', input: '未缓存输入', cacheRead: '缓存读取',
  cacheWrite: '缓存写入', output: '可见输出', measured: '已报告用量的会话',
  restoring: '正在后台恢复历史用量', partial: '当前为部分统计',
}
const en = {
  nav: 'Profile', title: 'Usage profile', subtitle: 'Daily token usage across visible local chats (UTC)',
  total: 'Total tokens', peak: 'Peak day', active: 'Active days', chats: 'Chats',
  activity: 'Token activity', daily: 'Daily', weekly: 'Weekly', cumulative: 'Cumulative',
  previousPeriod: 'Previous six months', nextPeriod: 'Next six months', noData: 'No reported token usage yet.',
  breakdown: 'Usage breakdown', input: 'Uncached input', cacheRead: 'Cache read',
  cacheWrite: 'Cache write', output: 'Visible output', measured: 'Chats with usage',
  restoring: 'Restoring historical usage in the background', partial: 'Partial totals',
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function dayKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}
function fmt(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}
function summarize(rows: readonly unknown[]) {
  const daily = new Map<string, number>()
  const buckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let chats = 0, measured = 0, pending = 0
  for (const rawRow of rows) {
    const row = objectValue(rawRow)
    if (row?.blank || !(row?.id ?? row?.sessionId)) continue
    chats++
    const metadata = objectValue(objectValue(row.projectionValues).sessionListMetadata ?? objectValue(objectValue(row.projections).values).sessionListMetadata)
    if (metadata.metricsPending === true) pending++
    const days = objectValue(row.projectionValues).dailyTokenUsage ?? objectValue(objectValue(row.projections).values).dailyTokenUsage
    if (!Array.isArray(days)) continue
    let chatMeasured = false
    const samples: unknown[] = days
    for (const rawSample of samples) {
      const sample = objectValue(rawSample)
      if (typeof sample.dayStartMs !== 'number') continue
      const date = new Date(sample.dayStartMs)
      if (!Number.isSafeInteger(sample?.dayStartMs) || sample.dayStartMs < 0 ||
          !Number.isFinite(date.getTime()) || sample.dayStartMs % 86400000 !== 0) continue
      const values = {
        input: safeNumber(sample.uncachedInputTokens),
        cacheRead: safeNumber(sample.cacheReadTokens),
        cacheWrite: safeNumber(sample.cacheWriteTokens),
        output: safeNumber(sample.outputTokens),
      }
      const total = Object.values(values).reduce((sum, value) => sum + value, 0)
      if (!total) continue
      chatMeasured = true
      for (const key of BUCKETS) buckets[key] += values[key]
      const key = dayKey(date)
      daily.set(key, (daily.get(key) ?? 0) + total)
    }
    if (chatMeasured) measured++
  }
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0)
  const peak = [...daily.values()].reduce((max, value) => Math.max(max, value), 0)
  return { daily, buckets, total, peak, activeDays: daily.size, chats, measured, pending }
}
function calendar(today: Date, page = 0): CalendarDay[][] {
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  last.setUTCDate(last.getUTCDate() + 6 - last.getUTCDay() - Math.max(0, page) * WEEKS * 7)
  const first = new Date(last)
  first.setUTCDate(first.getUTCDate() - (WEEKS * 7 - 1))
  return Array.from({ length: WEEKS }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = new Date(first)
    date.setUTCDate(first.getUTCDate() + week * 7 + day)
    return { date, key: dayKey(date), future: date > today }
  }))
}
/** calendar() constructs 26 nonempty seven-day weeks. Check this invariant
 * at the boundary rather than promising array elements with a type assertion. */
function calendarBounds(weeks: readonly (readonly CalendarDay[])[]): {first: Date; last: Date} {
  const first = weeks[0]?.[0]
  const last = weeks.at(-1)?.at(-1)
  if (first === undefined || last === undefined) throw new RangeError('Profile calendar must contain days')
  return {first: first.date, last: last.date}
}
function level(value: number, peak: number) {
  return value <= 0 || peak <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(Math.log1p(value) / Math.log1p(peak) * 4)))
}
function Cell({ entry, value, peak, locale }: { entry: CalendarDay; value: number; peak: number; locale: string }) {
  const title = `${entry.date.toLocaleDateString(locale, { timeZone: 'UTC' })} · ${fmt(value)} tokens`
  return h('span', {
    className: `xhp-cell xhp-level-${entry.future ? 0 : level(value, peak)}${entry.future ? ' xhp-future' : ''}`,
    title, 'aria-label': title,
  })
}
function ProfileSettings({ list, t }: ProfileProps) {
  const snapshot = useSyncExternalStore(
    listener => list.subscribe(listener),
    () => list.getSnapshot(),
  )
  const [mode, setMode] = useState('daily')
  const [page, setPage] = useState(0)
  const rows = Object.values(snapshot?.byId ?? {})
  const data = useMemo(() => summarize(rows), [snapshot?.byId])
  const today = new Date()
  const earliest = [...data.daily.keys()].sort()[0]
  const firstCurrentDay = calendarBounds(calendar(today)).first
  const firstCurrentUtc = firstCurrentDay.getTime()
  const [year, month, day] = earliest ? earliest.split('-').map(Number) : [0, 0, 0]
  const earliestUtc = earliest ? Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) : firstCurrentUtc
  const maxPage = Math.min(20, Math.max(0, Math.ceil((firstCurrentUtc - earliestUtc) / (WEEKS * 7 * 86400000))))
  const visiblePage = Math.min(page, maxPage)
  const weeks = useMemo(() => calendar(today, visiblePage), [visiblePage])
  const locale = t('nav') === zh.nav ? 'zh-CN' : 'en-US'
  const weekly = weeks.map(week => week.reduce((sum, entry) => sum + (entry.future ? 0 : data.daily.get(entry.key) ?? 0), 0))
  const weeklyPeak = Math.max(1, ...weekly)
  const periodTotal = weekly.reduce((sum, value) => sum + value, 0)
  let cumulative = 0
  const cumulativePoints = weekly.map((value, index) => {
    cumulative += value
    return `${index * 520 / (WEEKS - 1)},${130 - (periodTotal > 0 ? cumulative / periodTotal * 120 : 0)}`
  }).join(' ')
  const bounds = calendarBounds(weeks)
  const periodStart = bounds.first.toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const periodLast = bounds.last
  const periodEnd = (periodLast > today ? today : periodLast).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const stat = (label: string, value: string, key: string) => h('div', { className: 'xhp-stat', key }, [
    h('strong', { key: 'value' }, value), h('span', { key: 'label' }, label),
  ])
  const monthLabels = weeks.flatMap((week, index) => {
    const firstDay = week[0]
    if (firstDay === undefined) throw new RangeError('Profile calendar week must contain days')
    const start = firstDay.date
    const previous = index > 0 ? weeks[index - 1]?.[0]?.date ?? null : null
    return index === 0 || start.getUTCMonth() !== previous?.getUTCMonth()
      ? [h('span', { style: { gridColumn: String(index + 1) }, key: `${index}` }, start.toLocaleDateString(locale, { month: 'short' }))]
      : []
  })

  return h('div', { className: 'xhp-root' }, [
    h('header', { className: 'xhp-heading', key: 'heading' }, [
      h('p', { className: 'xhp-kicker', key: 'kicker' }, 'XHARNESS / PROFILE'),
      h('h2', { key: 'title' }, t('title')),
      h('p', { key: 'subtitle' }, t('subtitle')),
    ]),
    data.pending > 0 ? h('p', { className: 'xhp-pending', role: 'status', key: 'pending' },
      `${t('restoring')} · ${data.pending} ${t('chats')} · ${t('partial')}`) : null,
    h('div', { className: 'xhp-stats', key: 'stats' }, [
      stat(t('total'), data.measured ? fmt(data.total) : '—', 'total'),
      stat(t('peak'), data.activeDays ? fmt(data.peak) : '—', 'peak'),
      stat(t('active'), String(data.activeDays), 'active'),
      stat(t('chats'), String(data.chats), 'chats'),
    ]),
    h('section', { className: 'xhp-activity', key: 'activity' }, [
      h('div', { className: 'xhp-section-head', key: 'head' }, [
        h('h3', { key: 'title' }, t('activity')),
        h('div', { className: 'xhp-modes', role: 'group', 'aria-label': t('activity'), key: 'modes' },
          ['daily', 'weekly', 'cumulative'].map(key => h('button', {
            type: 'button', 'aria-pressed': mode === key,
            className: mode === key ? 'xhp-mode xhp-selected' : 'xhp-mode',
            onClick: () => setMode(key), key,
          }, t(key)))),
      ]),
      h('div', { className: 'xhp-period', key: 'period' }, [
        h('button', { type: 'button', onClick: () => setPage(visiblePage + 1), disabled: visiblePage >= maxPage,
          'aria-label': t('previousPeriod'), title: t('previousPeriod'), key: 'previous' }, '‹'),
        h('span', { key: 'label' }, `${periodStart} — ${periodEnd}`),
        h('button', { type: 'button', onClick: () => setPage(Math.max(0, visiblePage - 1)), disabled: visiblePage === 0,
          'aria-label': t('nextPeriod'), title: t('nextPeriod'), key: 'next' }, '›'),
      ]),
      data.measured === 0 ? h('p', { className: 'xhp-empty', key: 'empty' }, t(data.pending ? 'restoring' : 'noData')) :
        mode === 'daily' ? h('div', { className: 'xhp-calendar', key: 'calendar' }, [
          h('div', { className: 'xhp-weeks', key: 'weeks' }, weeks.map((week, index) => h('div', { className: 'xhp-week', key: index },
            week.map(entry => h(Cell, { entry, value: data.daily.get(entry.key) ?? 0, peak: data.peak, locale, key: entry.key }))))),
          h('div', { className: 'xhp-months', key: 'months' }, monthLabels),
        ]) : mode === 'weekly' ? h('div', { className: 'xhp-bars', role: 'img', 'aria-label': t('weekly'), key: 'bars' }, weekly.map((value, index) =>
          h('span', { className: 'xhp-week-bar', style: { height: `${Math.max(2, value / weeklyPeak * 100)}%` }, title: `${fmt(value)} tokens`, key: index }))) :
          h('svg', { className: 'xhp-line', viewBox: '0 0 520 140', role: 'img', 'aria-label': t('cumulative'), key: 'line' }, [
            h('line', { x1: 0, x2: 520, y1: 130, y2: 130, key: 'axis' }),
            h('polyline', { points: cumulativePoints, key: 'trace' }),
          ]),
    ]),
    h('section', { className: 'xhp-breakdown', key: 'breakdown' }, [
      h('div', { className: 'xhp-section-head', key: 'head' }, [h('h3', { key: 'title' }, t('breakdown')), h('small', { key: 'measured' }, `${data.measured} / ${data.chats} ${t('measured')}`)]),
      h('div', { className: 'xhp-buckets', key: 'buckets' }, ([
        ['input', 'input'], ['cacheRead', 'cacheRead'], ['cacheWrite', 'cacheWrite'], ['output', 'output'],
      ] as const).map(([key, label]) => h('div', { className: 'xhp-bucket', key }, [h('span', { key: 'label' }, t(label)), h('strong', { key: 'value' }, fmt(data.buckets[key]))]))),
    ]),
  ])
}



const inject = ['slots', 'sessions', 'locale']
function apply(ctx: ProfileContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-profile: labels')
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID)) return () => {}
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'xharness-profile: styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'profile', order: 30, label: () => t('nav'),
    inject: () => ({ list: ctx.sessions.list, t }),
  }, ProfileSettings))
}


export { apply, inject, summarize, calendar }
