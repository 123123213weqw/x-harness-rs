// Product-owned usage profile. Daily usage comes from durable timestamped
// Session events; this read-only view never fetches chat bodies.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-profile',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
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
      restoring: '正在后台恢复历史用量', partial: '当前为部分统计',
      breakdown: '用量构成', input: '未缓存输入', cacheRead: '缓存读取',
      cacheWrite: '缓存写入', output: '可见输出', measured: '已报告用量的会话',
    }
    const en = {
      nav: 'Profile', title: 'Usage profile', subtitle: 'Daily token usage across visible local chats (UTC)',
      total: 'Total tokens', peak: 'Peak day', active: 'Active days', chats: 'Chats',
      activity: 'Token activity', daily: 'Daily', weekly: 'Weekly', cumulative: 'Cumulative',
      previousPeriod: 'Previous six months', nextPeriod: 'Next six months', noData: 'No reported token usage yet.',
      restoring: 'Restoring historical usage in the background', partial: 'Partial totals',
      breakdown: 'Usage breakdown', input: 'Uncached input', cacheRead: 'Cache read',
      cacheWrite: 'Cache write', output: 'Visible output', measured: 'Chats with usage',
    }

    function safeNumber(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value : 0
    }
    function dayKey(date) {
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    }
    function fmt(value) {
      if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
      return String(value)
    }
    function summarize(rows) {
      const daily = new Map()
      const buckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      let chats = 0, measured = 0, pending = 0
      for (const row of rows) {
        if (row?.blank || !(row?.id ?? row?.sessionId)) continue
        chats++
        const metadata = row.projectionValues?.sessionListMetadata ?? row.projections?.values?.sessionListMetadata
        if (metadata?.metricsPending === true) pending++
        const days = row.projectionValues?.dailyTokenUsage ?? row.projections?.values?.dailyTokenUsage
        if (!Array.isArray(days)) continue
        let chatMeasured = false
        for (const sample of days) {
          const date = new Date(sample?.dayStartMs)
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
          for (const key of Object.keys(buckets)) buckets[key] += values[key]
          const key = dayKey(date)
          daily.set(key, (daily.get(key) ?? 0) + total)
        }
        if (chatMeasured) measured++
      }
      const total = Object.values(buckets).reduce((sum, value) => sum + value, 0)
      const peak = [...daily.values()].reduce((max, value) => Math.max(max, value), 0)
      return { daily, buckets, total, peak, activeDays: daily.size, chats, measured, pending }
    }
    function calendar(today, page = 0) {
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
    function level(value, peak) {
      return value <= 0 || peak <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(Math.log1p(value) / Math.log1p(peak) * 4)))
    }
    function Cell({ entry, value, peak, locale }) {
      const title = `${entry.date.toLocaleDateString(locale, { timeZone: 'UTC' })} · ${fmt(value)} tokens`
      return h('span', {
        className: `xhp-cell xhp-level-${entry.future ? 0 : level(value, peak)}${entry.future ? ' xhp-future' : ''}`,
        title, 'aria-label': title,
      })
    }
    function ProfileSettings({ list, t }) {
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
      const firstCurrentDay = calendar(today)[0][0].date
      const firstCurrentUtc = firstCurrentDay.getTime()
      const [year, month, day] = earliest ? earliest.split('-').map(Number) : [0, 0, 0]
      const earliestUtc = earliest ? Date.UTC(year, month - 1, day) : firstCurrentUtc
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
      const periodStart = weeks[0][0].date.toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
      const periodLast = weeks.at(-1).at(-1).date
      const periodEnd = (periodLast > today ? today : periodLast).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
      const stat = (label, value, key) => h('div', { className: 'xhp-stat', key }, [
        h('strong', { key: 'value' }, value), h('span', { key: 'label' }, label),
      ])
      const monthLabels = weeks.flatMap((week, index) => {
        const start = week[0].date
        const previous = index > 0 ? weeks[index - 1][0].date : null
        return index === 0 || start.getUTCMonth() !== previous.getUTCMonth()
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
          h('div', { className: 'xhp-buckets', key: 'buckets' }, [
            ['input', 'input'], ['cacheRead', 'cacheRead'], ['cacheWrite', 'cacheWrite'], ['output', 'output'],
          ].map(([key, label]) => h('div', { className: 'xhp-bucket', key }, [h('span', { key: 'label' }, t(label)), h('strong', { key: 'value' }, fmt(data.buckets[key]))]))),
        ]),
      ])
    }

    const CSS = `
.xhp-pending{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#f3f3f4);font-size:12px;color:var(--dsw-alias-label-secondary,#777)}.xhp-root{display:grid;gap:24px;padding:5px 0 22px;color:var(--dsw-alias-label-primary,#24272c)}.xhp-heading{padding:0 2px}.xhp-kicker{margin:0 0 11px;color:var(--dsw-alias-label-tertiary,#999);font:700 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em}.xhp-heading h2{margin:0;font-size:23px;font-weight:600;letter-spacing:-.035em}.xhp-heading p:last-child{margin:7px 0 0;color:var(--dsw-alias-label-secondary,#777);font-size:12px}.xhp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--dsw-alias-border-l2,#e8e8ea);border-radius:15px;padding:18px 4px}.xhp-stat{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;border-right:1px solid var(--dsw-alias-border-l2,#e8e8ea)}.xhp-stat:last-child{border-right:0}.xhp-stat strong{font-size:20px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.xhp-stat span{font-size:10px;color:var(--dsw-alias-label-secondary,#777)}.xhp-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px}.xhp-section-head h3{font-size:14px;font-weight:600;margin:0}.xhp-section-head small{font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}.xhp-modes{display:flex;gap:1px}.xhp-mode{border:0;background:none;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:11px;cursor:pointer;border-radius:6px;padding:4px 6px}.xhp-mode:hover{color:var(--dsw-alias-label-primary,#24272c)}.xhp-selected{background:var(--dsw-alias-interactive-bg-hover,#f3f3f4);color:var(--dsw-alias-label-primary,#24272c);font-weight:600}.xhp-weeks{display:grid;grid-template-columns:repeat(26,minmax(0,1fr));gap:4px}.xhp-week{display:grid;grid-template-rows:repeat(7,1fr);gap:4px;min-width:0}.xhp-cell{display:block;aspect-ratio:1;border-radius:4px;background:var(--dsw-alias-border-l2,#f0f0f2)}.xhp-future{opacity:.35}.xhp-level-1{background:#d7dce3}.xhp-level-2{background:#a9b2bf}.xhp-level-3{background:#626d7e}.xhp-level-4{background:#20252e}.xhp-months{display:grid;grid-template-columns:repeat(26,minmax(0,1fr));gap:4px;margin-top:7px;min-height:14px;color:var(--dsw-alias-label-tertiary,#999);font-size:9px}.xhp-months span{white-space:nowrap}.xhp-bars{height:132px;display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd)}.xhp-week-bar{flex:1;min-width:1px;background:#48515e;border-radius:2px 2px 0 0}.xhp-line{display:block;width:100%;height:132px;overflow:visible}.xhp-line line{stroke:var(--dsw-alias-border-l2,#ddd)}.xhp-line polyline{fill:none;stroke:#303846;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.xhp-buckets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 20px}.xhp-bucket{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);padding:4px 0 9px;font-size:11px}.xhp-bucket span{color:var(--dsw-alias-label-secondary,#777)}.xhp-bucket strong{font-variant-numeric:tabular-nums;font-weight:600}.xhp-empty{padding:25px 0;color:var(--dsw-alias-label-secondary,#777);font-size:12px}@media(max-width:640px){.xhp-root{gap:19px}.xhp-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 0}.xhp-stat:nth-child(2){border-right:0}.xhp-stat strong{font-size:18px}.xhp-weeks,.xhp-months{gap:2px}.xhp-cell{border-radius:2px}.xhp-modes{gap:0}}
[role="dialog"]:has(.xhp-root){width:min(1040px,calc(100vw - 32px));max-width:calc(100vw - 32px)}
.xhp-period{display:flex;align-items:center;justify-content:center;gap:14px;margin:-3px 0 13px;color:var(--dsw-alias-label-secondary,#777);font-size:11px;font-variant-numeric:tabular-nums}.xhp-period button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l2,#e8e8ea);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#24272c);font:18px/1 system-ui;cursor:pointer}.xhp-period button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f3f4)}.xhp-period button:disabled{opacity:.3;cursor:default}
@media(max-width:640px){.xhp-weeks,.xhp-months,.xhp-week{gap:2px}.xhp-cell{border-radius:2px}}
`

    const inject = ['slots', 'sessions', 'locale']
    function apply(ctx) {
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

    exports.apply = apply
    exports.inject = inject
    exports.summarize = summarize
    exports.calendar = calendar
    return module.exports
  },
})
