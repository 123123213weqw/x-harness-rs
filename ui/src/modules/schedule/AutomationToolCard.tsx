import * as React from 'react'
import type {ToolCallBlock} from '../client-runtime/index'
import type {Translation} from '../shared/runtime-types'
import {automationCardModel, latestRunState, refreshDelay, type AutomationView} from './automation-card-model'
import type {AutomationCardClient} from './automation-card-client'

interface Props {sessionId: string; block: ToolCallBlock; t: Translation; useProjection(name: string): unknown; inspect?: (() => void) | undefined; client: AutomationCardClient}
function Clock() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> }
function SavedAutomation({id, initial, sessionId, client, projection, t}: {id: string; initial: AutomationView | undefined; sessionId: string; client: AutomationCardClient; projection: unknown; t: Translation}) {
  const [view, setView] = React.useState<AutomationView>(), [loadError, setLoadError] = React.useState('')
  const [pending, setPending] = React.useState(false), [actionError, setActionError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const mutationPending = React.useRef(false)
  const [revision, invalidate] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => client.subscribe(sessionId, invalidate), [client, sessionId])
  React.useEffect(() => {
    let stopped = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined
    async function refresh() {
      if (stopped || document.hidden || inFlight) return
      inFlight = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 15_000)
      let delay: number | undefined = 15_000
      try {
        const current = await client.execute(sessionId, id, 'view', controller.signal)
        if (stopped) return
        if (!current) throw Error(t('card.unavailable'))
        setView(current); setLoadError(''); delay = refreshDelay(current)
      } catch (error) { if (!stopped) { setLoadError(error instanceof Error ? error.message : String(error)); setView(undefined) } }
      finally { clearTimeout(timeout); inFlight = false }
      if (!stopped && delay !== undefined) timer = setTimeout(refresh, delay)
    }
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void refresh() } }
    void refresh(); document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible) }
  }, [client, sessionId, id, projection, revision, t])
  const current = view ?? initial, state = view?.state
  const run = view && latestRunState(view)
  const manageable = state === 'scheduled' || state === 'overdue' || state === 'paused'
  async function mutate(action: 'pause'|'resume'|'delete') {
    if (mutationPending.current) return
    mutationPending.current = true
    setPending(true); setActionError('')
    try { await client.execute(sessionId, id, action); if (mounted.current) setConfirmDelete(false) }
    catch (error) { if (mounted.current) { setActionError(error instanceof Error ? error.message : String(error)); invalidate() } }
    finally { mutationPending.current = false; if (mounted.current) setPending(false) }
  }
  return <div className="xhauto-card-task">
    <div className="xhauto-card-title">{current?.prompt ?? t('card.savedTask')}</div>
    <div className="xhauto-card-meta">
      <span>{current?.automation?.mode === 'task' ? t('card.task') : t('card.reminder')}</span>
      <span>{current?.automation?.target === 'new_chat' ? t('card.newChat') : t('card.currentChat')}</span>
      {current && <span>{current.kind === 'every' ? t('card.every', {minutes: (current.everySeconds ?? 0) / 60}) : t('card.once')} · {new Date(current.scheduledAt).toLocaleString(t('card.locale'))}</span>}
    </div>
    <div className="xhauto-card-bottom">
      <span className="xhauto-card-state">{state ? t(`card.state.${state}`) : t('card.record')}{run ? ` · ${t(`card.run.${run}`)}` : ''}</span>
      {manageable && <div className="xhauto-card-actions">
        {confirmDelete ? <><span>{t('card.confirmDelete')}</span><button disabled={pending} onClick={() => void mutate('delete')}>{t('card.delete')}</button><button disabled={pending} onClick={() => setConfirmDelete(false)}>{t('card.cancel')}</button></>
          : <><button disabled={pending} onClick={() => void mutate(state === 'paused' ? 'resume' : 'pause')}>{pending ? t('card.saving') : t(state === 'paused' ? 'card.resume' : 'card.pause')}</button><button disabled={pending} onClick={() => setConfirmDelete(true)}>{t('card.delete')}</button></>}
      </div>}
    </div>
    {loadError && <div className="xhauto-card-muted">{t('card.syncFailed')} · {loadError}</div>}
    {actionError && <div className="xhauto-card-error" role="alert">{actionError}</div>}
  </div>
}
export function AutomationToolCard({block, sessionId, useProjection, client, inspect, t}: Props) {
  const model = React.useMemo(() => automationCardModel(block), [block])
  const projection = useProjection('schedules')
  return <section className="xhauto-card" aria-label={t('card.title')}>
    <header><Clock/><span>{t(`card.action.${model.action}`)}</span><span className="xhauto-card-muted">{!model.settled ? t('card.working') : model.error ? t('card.failed') : model.recognized ? t('card.receipt') : t('card.unknownResult')}</span></header>
    {model.error ? <div className="xhauto-card-error" role="alert">{model.error}</div> : model.ids.slice(0,20).map(id => <SavedAutomation key={`${sessionId}:${id}`} id={id} initial={model.values.find(v => v.id === id)} sessionId={sessionId} client={client} projection={projection} t={t}/>)}
    {model.action === 'list' && model.settled && model.recognized && !model.error && model.ids.length === 0 && <div className="xhauto-card-muted">{t('card.empty')}</div>}
    {model.ids.length > 20 && <div className="xhauto-card-muted">{t('card.more', {count: model.ids.length - 20})}</div>}
    <details><summary>{t('card.details')}</summary><pre>{model.argsRaw}{model.raw ? `\n\n${model.raw}` : ''}</pre>{inspect && <button onClick={inspect}>{t('card.inspect')}</button>}</details>
  </section>
}
