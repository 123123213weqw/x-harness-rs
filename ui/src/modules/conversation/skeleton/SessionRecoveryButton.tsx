import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '../types/slots'

export interface SessionRecoveryInjected { recover(): Promise<void> }
type Props = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'conversation'> & InjectFace<SessionRecoveryInjected>

/** The Host owns recovery. This control never edits a draft or fabricates idle. */
export function SessionRecoveryButton({ sessionId, recover, t }: Props) {
  const running = useRef(false)
  const generation = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [complete, setComplete] = useState(false)
  useEffect(() => {
    generation.current++; running.current = false; setBusy(false); setError(''); setComplete(false)
    return () => { generation.current++ }
  }, [sessionId])
  const run = async (): Promise<void> => {
    if (running.current) return
    running.current = true
    const current = ++generation.current
    setBusy(true); setError(''); setComplete(false)
    try { await recover(); if (current === generation.current) setComplete(true) }
    catch (error: unknown) { if (current === generation.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (current === generation.current) { running.current = false; setBusy(false) } }
  }
  return <span data-session-recovery="" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
    <button type="button" disabled={busy} aria-busy={busy} title={t('session.recoverHint')}
      style={{ font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 8px', whiteSpace: 'nowrap', cursor: busy ? 'wait' : 'pointer' }}
      onClick={() => { void run() }}>
      {t(busy ? 'session.recovering' : 'session.recover')}
    </button>
    {complete && <span role="status">{t('session.recovered')}</span>}
    {error && <span role="alert" title={error} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{error}</span>}
  </span>
}
