import * as React from 'react'
import {errorText} from '../shared/runtime-types'
import {automationCatalog} from './automation-data'
import type {IWorkCatalog} from '../client-runtime/index'

export function AutomationPage({openSession, service}: {openSession(id: string): void; service: IWorkCatalog}) {
  const snapshot = React.useSyncExternalStore(service.subscribe, service.getSnapshot)
  const catalog = React.useMemo(() => automationCatalog({items: snapshot.sessions}), [snapshot.sessions])
  const zh = document.documentElement.lang.startsWith('zh')
  const title = zh ? '自动化' : 'Automations'
  const [refresh, setRefresh] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    const controller = new AbortController()
    let current = true
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    setLoading(true); setError(null)
    void service.refresh(controller.signal)
      .catch((failure: unknown) => {
        if (!current) return
        // Owner errors are live runtime state: a reconnect can clear them without a manual click.
        setError(controller.signal.aborted ? (zh ? '读取超时，请重试。' : 'Request timed out. Retry.')
          : service.getSnapshot().error === null ? errorText(failure) : null)
      })
      .finally(() => { window.clearTimeout(timeout); if (current) setLoading(false) })
    return () => { current = false; controller.abort(); window.clearTimeout(timeout) }
  }, [refresh, zh, service])

  React.useEffect(() => {
    // A timed-out page wait does not cancel the owner. Its eventual successful
    // baseline must clear the reader warning rather than leave a stale alert.
    if (!snapshot.loading && snapshot.phase === 'ready' && snapshot.error === null) setError(null)
  }, [snapshot.loading, snapshot.phase, snapshot.error])

  const failure = error ?? snapshot.error
  const pending = loading || snapshot.phase === 'pending' && failure === null
  return <section className="xhauto-page" aria-label={title}>
    <header className="xhauto-head"><h2>{title}</h2>
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)} aria-label={zh ? '刷新自动化' : 'Refresh automations'}>↻</button>
    </header>
    <div className="xhauto-body" aria-busy={pending}>
      {pending && <p role="status">{zh ? '读取中…' : 'Loading…'}</p>}
      {failure && <div role="alert"><p>{failure}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
      {!pending && !failure && catalog.entries.length === 0 && <p>{catalog.incompleteSessions ? (zh ? '暂无已加载的自动化任务' : 'No loaded automations') : (zh ? '暂无自动化任务' : 'No automations yet')}</p>}
      {!pending && !failure && catalog.incompleteSessions > 0 && <p className="xhauto-muted">{zh ? '部分会话的提醒尚未加载；打开原会话后刷新。' : 'Some chats have not loaded reminders yet. Open those chats, then refresh.'}</p>}
      {catalog.entries.map(({sessionId, sessionTitle, record}) => <article key={JSON.stringify([sessionId, record.id])} className="xhauto-row">
        <p>{record.prompt}</p><div className="xhauto-muted">
          {record.automation !== undefined && <span>{record.automation.mode === 'task' ? (zh ? '执行任务' : 'Task') : (zh ? '提醒' : 'Reminder')} · {record.automation.target === 'new_chat' ? (zh ? '独立聊天' : 'New chat') : (zh ? '原聊天' : 'Current chat')} · {record.automation.paused ? (zh ? '已暂停' : 'Paused') : (zh ? '已启用' : 'Active')} · </span>}{new Date(record.scheduledAt).toLocaleString(document.documentElement.lang)}{record.kind === 'every' ? (record.everySeconds ? ` · ${zh ? '每' : 'Every '}${record.everySeconds}${zh ? '秒' : 's'}` : (zh ? ' · 重复周期未知' : ' · Repeat interval unavailable')) : ''}</div>
        <button type="button" onClick={() => openSession(sessionId)}>{sessionTitle}</button>
      </article>)}
    </div>
  </section>
}
