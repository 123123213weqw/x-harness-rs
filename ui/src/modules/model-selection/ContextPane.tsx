import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RefCallback } from 'react'
import { IconChevronRightOutline14 } from '@xharness/dsh-client-ui-primitives'
import { errorText } from '../shared/runtime-types'
import type { ModelDirectoryState, ModelSelection, ModelSelectInjected } from './contracts'
import { css } from './styles'

/** No client-owned maximum: only the exact selected model's reported limit. */
export function xhModelInfo(state: ModelDirectoryState) {
  const current = state.current
  const model = state.groups.find(group => group.id === current?.provider)?.models.find(entry => entry.id === current?.model)
  const maximum = model?.contextWindow !== undefined && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined
  return { current, model, maximum, effort: current?.reasoningEffort ?? model?.reasoning?.defaultEffort }
}
export function xhContextSelection(state: ModelDirectoryState, raw: string): ModelSelection {
  const { current, maximum } = xhModelInfo(state)
  if (!current || !maximum) throw new Error('当前模型未提供上下文上限，无法调整。')
  if (!/^\d+$/.test(raw.trim())) throw new Error('请输入正整数 Token 数量。')
  const tokens = Number(raw)
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > maximum) throw new Error(`请输入 1–${maximum.toLocaleString()} 之间的 Token 数量。`)
  return { ...current, contextWindowTokens: tokens }
}
function tokenLabel(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return '未知'
  return value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString()
}
export function xhReasoningStatus(state: ModelDirectoryState): string {
  const { model } = xhModelInfo(state)
  const capability = model?.reasoningCapability
  if (capability?.state === 'disabled') return '已禁用配置'
  if (!model?.reasoning) return '能力未知'
  if (capability?.stale) return '沿用上次能力 · 待刷新'
  const sources: Record<string, string> = { configured: '已配置', documented: '厂商文档', provider_reported: '服务端提供', last_known_good: '上次有效能力' }
  return sources[capability?.source ?? ''] ?? '已配置'
}
export function ReasoningStatus({ state, load, itemRef }: { state: ModelDirectoryState; load: ModelSelectInjected['load']; itemRef: RefCallback<HTMLButtonElement> }) {
  const busy = state.status === 'loading' || state.status === 'selecting'
  return <button type="button" role="menuitem" disabled={busy}
    style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 12px', width: '100%', fontSize: 12 }}
    ref={itemRef} aria-label="刷新模型能力" onClick={() => { void Promise.resolve(load(true)).catch(() => {}) }}>
    <span>思考能力：{xhReasoningStatus(state)}</span><span>{busy ? '获取中…' : '刷新'}</span>
  </button>
}
export function ContextRow({ state, itemRef, open }: { state: ModelDirectoryState; itemRef: RefCallback<HTMLButtonElement>; open(): void }) {
  const { current, maximum } = xhModelInfo(state)
  return <button ref={itemRef} type="button" role="menuitem" className={css.cell} onClick={open}>
    <span className={css.cellLabel}>上下文容量</span><span className={css.cellValue}>{tokenLabel(current?.contextWindowTokens ?? maximum)}</span>
    <IconChevronRightOutline14 className={css.cellChevron} />
  </button>
}
type ContextPaneProps = Pick<ModelSelectInjected, 'directory' | 'load' | 'select'> & { locked: boolean; back(): void; saved(): void }
export function ContextPane({ locked, directory, load, select, back, saved }: ContextPaneProps) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
  const { current, model, maximum } = xhModelInfo(state)
  const currentTokens = current?.contextWindowTokens ?? maximum
  const [draft, setDraft] = useState(String(currentTokens ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const version = useRef(0)
  const busy = saving || state.status === 'loading' || state.status === 'selecting'
  const identity = JSON.stringify([current, maximum])
  useEffect(() => { setDraft(String(currentTokens ?? '')); setError(null); setSaving(false) }, [identity])
  useEffect(() => { ++version.current }, [current?.provider, current?.model])
  useEffect(() => () => { ++version.current }, [])
  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (locked || busy || !maximum) return
    let selection: ModelSelection
    try { selection = xhContextSelection(directory.getSnapshot(), draft) }
    catch (cause: unknown) { setError(errorText(cause)); return }
    const generation = version.current
    setSaving(true); setError(null)
    try {
      const ok = await select(selection)
      if (generation !== version.current) return
      if (!ok) throw new Error(directory.getSnapshot().error ?? '保存失败，请重试。')
      const actual = directory.getSnapshot().current
      // A late save for another model must never close a newly edited form.
      const keys = ['provider', 'model', 'reasoningEffort', 'contextWindowTokens'] as const
      if (keys.every(key => actual?.[key] === selection[key])) saved()
    } catch (cause: unknown) {
      if (generation === version.current) setError(errorText(cause))
    } finally { if (generation === version.current) setSaving(false) }
  }
  return <form className="xh-context-form" onSubmit={event => { void submit(event) }}>
    <button type="button" onClick={back}>← 返回模型设置</button>
    <h3>上下文容量</h3><p>仅影响后续请求，不改变正在运行的请求。</p>
    <label>Token 数量<input autoFocus type="text" inputMode="numeric" aria-label="上下文 Token 数量" value={draft} readOnly={busy} disabled={locked} onChange={event => { setDraft(event.target.value); setError(null) }} /></label>
    <p>当前模型有效上限：{maximum?.toLocaleString() ?? '未知'} tokens（{model?.contextWindowSource ?? '来源未标注'}）</p>
    {!maximum && <p>当前模型未提供上限，暂时无法调整。</p>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
    {state.status === 'error' && <button type="button" onClick={() => { load() }}>重新获取</button>}
    <div className="xh-context-actions">
      <button type="button" disabled={busy || locked || !maximum} onClick={() => { setDraft(String(maximum)); setError(null) }}>填入上限</button>
      <button type="submit" disabled={busy || locked || !maximum}>{saving ? '保存中…' : '保存'}</button>
    </div>
  </form>
}
