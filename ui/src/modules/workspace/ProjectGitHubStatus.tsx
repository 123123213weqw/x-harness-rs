import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {installStyles} from '../shared/foundation-styles'
import type {Translation} from '../shared/runtime-types'
import {ProjectStatusRequest} from './project-github'
import type {ProjectGitHub, ReadProjectStatus} from './project-github'
import source from './ProjectGitHubStatus.css'
installStyles('@xharness/dsh-client-ui-workspace/ProjectGitHubStatus.css', '@xharness/dsh-client-ui-workspace', source)
function checkedTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
export function ProjectGitHubStatus({workspaceId, path, generation, active, expanded, read, t, onOpenChange}: {
  workspaceId: string; path: string|undefined; generation: object|undefined; active: boolean; expanded: boolean
  read: ReadProjectStatus; t: Translation; onOpenChange(open: boolean): void
}) {
  const [entry, setEntry] = useState<{generation: object|undefined; id: string; path: string|undefined; value: ProjectGitHub|undefined; error: string|undefined; loading: boolean; checkedAt: string}>()
  const [position, setPosition] = useState<{left: number; top: number}>()
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const refresh = useRef<(() => void)|undefined>()
  useEffect(() => {
    setPosition(undefined)
    if (!generation) {setEntry(undefined); return}
    const request = new ProjectStatusRequest(read, workspaceId)
    const publish = (value: ProjectGitHub|undefined, error: string|undefined, loading: boolean): void => {
      setEntry({generation, id: workspaceId, path, value, error, loading, checkedAt: loading ? '' : checkedTime(new Date())})
    }
    const run = (): void => {if (!document.hidden) void request.refresh(publish)}
    refresh.current = run
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    run()
    return () => {request.dispose(); refresh.current = undefined; window.removeEventListener('focus', run); document.removeEventListener('visibilitychange', run)}
  }, [read, workspaceId, path, generation])
  useEffect(() => {if (active) refresh.current?.()}, [active])
  useEffect(() => {if (expanded) refresh.current?.()}, [expanded])
  useEffect(() => {onOpenChange(!!position); return () => onOpenChange(false)}, [position, onOpenChange])
  useEffect(() => {
    if (!position) return
    panel.current?.focus()
    const close = (event: Event): void => {if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setPosition(undefined)}
    const key = (event: KeyboardEvent): void => {if (event.key === 'Escape') {setPosition(undefined); trigger.current?.focus()}}
    const reposition = (event: Event): void => {if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) setPosition(undefined)}
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key)
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true)
    return () => {document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true)}
  }, [position])
  const current = entry && entry.generation === generation && entry.id === workspaceId && entry.path === path ? entry : undefined
  const value = current?.value, ready = value?.kind === 'ready' ? value : undefined
  const ci = ready?.ci ?? 'unknown'
  const state = ready ? t(ready.draft ? 'github.draft' : `github.${ready.state}`) : t(current?.loading ? 'github.loading' : current?.error ? 'github.error' : value?.kind === 'no_pr' ? 'github.no_pr' : value?.kind === 'ambiguous' ? 'github.ambiguous' : 'github.unsupported')
  return <span className="xhproject-github" onClick={e => e.stopPropagation()} onDragStart={e => e.stopPropagation()}>
    <button ref={trigger} type="button" className="xhproject-github-trigger" aria-label={`${t('github.label')}: ${state}${ready ? ` · ${t(`github.ci.${ci}`)}` : ''}`} aria-expanded={!!position} aria-haspopup="dialog" title={`${state} · ${t('github.on_demand')}`} data-pr={ready?.state} data-draft={ready?.draft} onClick={() => {
      if (position) {setPosition(undefined); return}
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return
      setPosition({left: Math.max(8, Math.min(rect.left, window.innerWidth - 318)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 280))})
    }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="4" cy="3" r="1.7"/><circle cx="4" cy="13" r="1.7"/><circle cx="12" cy="12" r="1.7"/><path d="M4 5v6M9 3h1a2 2 0 0 1 2 2v5M7 5l2-2-2-2"/></svg>
      <span className="xhproject-ci" data-ci={ci} aria-hidden="true">{current?.loading ? '…' : ready ? ci === 'passing' ? '✓' : ci === 'failing' ? '×' : ci === 'pending' ? '◷' : '·' : '?'}</span>
    </button>
    {position && createPortal(<div ref={panel} className="xhproject-github-panel" tabIndex={-1} role="dialog" aria-label={t('github.label')} style={position} onClick={e => e.stopPropagation()}>
      <strong>{ready ? `#${ready.number} · ${state}` : state}</strong>
      {ready && <><p>{ready.repository} · {ready.branch}</p><p>{t(`github.ci.${ci}`)}</p><p>HEAD {ready.localSha.slice(0,8)} · PR {ready.headSha.slice(0,8)}</p><p><a href={ready.url} target="_blank" rel="noreferrer noopener">{t('github.open')}</a></p></>}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.checkedAt && <p>{t('github.checked')} {current.checkedAt}</p>}
      <p>{t('github.on_demand')}</p>
      <button type="button" disabled={current?.loading || !generation} onClick={() => refresh.current?.()}>{t('github.refresh')}</button>
    </div>, document.body)}
  </span>
}
