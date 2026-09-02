/** Goal dock, with XHarness execution status and inline budget/completion controls. */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconGoalOutline16,
  IconPauseOutline16, IconPlayOutline16, IconTrashOutline16, Tooltip,
} from '@xharness/dsh-client-ui-primitives'
import type { PropsLocale } from '../views-types'
import type { GoalActionResult, GoalBarActions, GoalProjection, GoalSnapshot } from './contracts'
import css from './GoalBar.styles'

const PHASE_LABELS = {active: 'phase.active', paused: 'phase.paused', blocked: 'phase.blocked', complete: 'phase.complete'} as const
const STATES: Readonly<Record<string, string>> = {
  disabled: '未启用自动推进', running: '正在执行', queued: '已排队', waiting: '等待依赖或用户输入',
  awaiting_approval: '等待工具审批', awaiting_answer: '等待回答', awaiting_confirmation: '等待你确认完成',
  network_backoff: '网络异常，等待自动重试', paused: '已暂停', blocked: '需要帮助', complete: '已完成',
}
const REASONS: Readonly<Record<string, string>> = {
  round_budget: '轮数预算已到', cancelled: '用户停止', execution_error: '执行失败', step_limit: '步骤上限',
  output_limit: '输出上限', outcome_unknown: '上轮结果未知，未自动重放', report_protocol_stalled: '连续缺少进展报告',
}
export function goalStatus(goal: GoalSnapshot, projection: GoalProjection | null | undefined, t: PropsLocale<'goal'>['t']): string {
  const execution = projection?.execution
  const label = execution ? STATES[execution.state] ?? execution.state : goal.phase === 'complete' ? '已完成' : t(PHASE_LABELS[goal.phase])
  return `${label} · ${execution?.roundsStarted ?? goal.roundsStarted ?? 0}/${execution?.maxGoalRounds ?? goal.maxGoalRounds} 轮`
}
export function goalTitle(goal: GoalSnapshot, projection: GoalProjection | null | undefined): string {
  const execution = projection?.execution; const report = execution?.report
  return [goal.objective, execution?.pauseReason && (REASONS[execution.pauseReason] ?? execution.pauseReason), execution?.pauseDetail,
    goal.blockedReason?.message, report?.summary, ...(report?.remaining ?? []),
    ...(report?.evidence ?? []).map(e => `${e.kind}: ${e.reference ?? e.execution_id}`),
  ].filter(Boolean).join('\n')
}
type RunAction = (action: () => Promise<GoalActionResult>) => Promise<GoalActionResult | undefined>
interface ControlsProps extends Pick<GoalBarActions, 'onComplete' | 'onResume' | 'onBudget'> {
  projection: GoalProjection | null | undefined; runAction: RunAction; pending: boolean
}
function GoalControls({projection, onComplete, onResume, onBudget, runAction, pending}: ControlsProps) {
  const [editing, setEditing] = useState(false); const [budget, setBudget] = useState('')
  const id = projection?.goal.id; const identity = useRef(id)
  useEffect(() => {identity.current = id; setEditing(false); setBudget(''); return () => {identity.current = undefined}}, [id])
  if (!projection?.goal) return null
  const execution = projection.execution
  const glyph: Readonly<Record<string, string>> = {'启用自动推进': '▶', '确认完成': '✓', '继续': '▶', '预算': '⋯', '取消预算修改': '×'}
  const button = (label: string, action: () => void) => <button type="button" className={css.iconBtn} disabled={pending}
    aria-label={label} title={label} onClick={action} style={{flexShrink: 0, whiteSpace: 'nowrap'}}>{glyph[label] ?? label}</button>
  return <span data-goal-runtime style={{display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
    {execution?.state === 'disabled' && button('启用自动推进', () => {void runAction(onResume)})}
    {execution?.state === 'awaiting_confirmation' && button('确认完成', () => {void runAction(onComplete)})}
    {execution?.state === 'awaiting_confirmation' && button('继续', () => {void runAction(onResume)})}
    {projection.goal.phase !== 'complete' && (editing ? <form style={{display: 'inline-flex', alignItems: 'center', gap: 4}}
      onSubmit={async event => {
        event.preventDefault(); const value = Number(budget)
        if (!Number.isSafeInteger(value) || value < 1) return
        const started = id; const result = await runAction(() => onBudget(value))
        if (result?.ok && identity.current === started) setEditing(false)
      }}>
      <input type="number" min={1} step={1} value={budget} disabled={pending} aria-label="轮数预算" title="保存后暂停自动推进"
        onChange={event => {setBudget(event.target.value)}} onKeyDown={event => {if (event.key === 'Escape') setEditing(false)}} style={{width: 64, minWidth: 0}} />
      <button type="submit" className={css.iconBtn} disabled={pending || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1}
        aria-label="保存轮数预算" title="保存预算并暂停自动推进">保存</button>
      {button('取消预算修改', () => {setEditing(false)})}
    </form> : button('预算', () => {setBudget(String(execution?.maxGoalRounds ?? projection.goal.maxGoalRounds)); setEditing(true)}))}
  </span>
}
export interface GoalBarProps extends GoalBarActions, PropsLocale<'goal'> {
  goal: GoalSnapshot | null | undefined; projection?: GoalProjection | null | undefined
}
export function GoalBar({goal, projection, onComplete, onBudget, onEdit, onPause, onResume, onClear, t}: GoalBarProps) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false); const [actionError, setActionError] = useState<string | null>(null)
  const [clearedGoalId, setClearedGoalId] = useState<string | null>(null)
  const pendingRef = useRef(false); const actionEpoch = useRef(0); const goalId = goal?.id
  useEffect(() => {
    setEditing(false); setActionError(null); setClearedGoalId(null)
    actionEpoch.current++; pendingRef.current = false; setPending(false)
  }, [goalId])
  const runAction = useCallback<RunAction>(async action => {
    if (pendingRef.current) return undefined
    pendingRef.current = true; const epoch = actionEpoch.current; setPending(true); setActionError(null)
    let result: GoalActionResult
    try {result = await action()} catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      result = {ok: false, error: {code: 'network', message}}
    }
    if (epoch !== actionEpoch.current) return undefined
    pendingRef.current = false; setPending(false)
    if (!result.ok) setActionError(`${result.error.message} (${result.error.code})`)
    return result
  }, [])
  const handleEdit = useCallback(async () => {
    const trimmed = draft.trim(); if (trimmed === '') return
    if ((await runAction(() => onEdit(trimmed)))?.ok) setEditing(false)
  }, [draft, onEdit, runAction])
  const handleClear = useCallback(async (clearedId: string) => {
    if ((await runAction(onClear))?.ok) setClearedGoalId(clearedId)
  }, [onClear, runAction])
  if (goal === undefined || goal === null || goal.id === clearedGoalId) return null
  if (editing) return <div className={css.dock} data-goal-bar><div className={css.bar}>
    <input className={css.objectiveInput} type="text" aria-label={t('objective.aria')} value={draft} autoFocus
      onChange={event => {setDraft(event.target.value)}} onKeyDown={event => {
        if (event.key === 'Enter') void handleEdit(); if (event.key === 'Escape') setEditing(false)
      }} />
    {actionError !== null && <span className={css.error} role="alert">{actionError}</span>}
    <div className={css.actions}>
      <Tooltip label={t('action.save')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn}
        onClick={() => {void handleEdit()}} disabled={pending || draft.trim() === ''} aria-label={t('action.save')}><IconCheckOutline16 size={14} /></button></Tooltip>
      <Tooltip label={t('action.cancel')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn}
        onClick={() => {setEditing(false)}} disabled={pending} aria-label={t('action.cancel')}><IconCloseOutline16 size={14} /></button></Tooltip>
    </div>
  </div></div>
  return <div className={css.dock} data-goal-bar><div className={css.bar} title={goalTitle(goal, projection)} style={{minHeight: 36, height: 'auto', flexWrap: 'wrap'}}>
    <span className={css.goalGlyph}><IconGoalOutline16 size={14} /></span><span className={css.label}>{goalStatus(goal, projection, t)}</span>
    <span className={css.objective}>{goal.objective}</span>
    {actionError !== null && <span className={css.error} role="alert">{actionError}</span>}
    <div className={css.actions}>
      {goal.phase === 'active' && projection?.execution?.state !== 'disabled' && <Tooltip label={t('action.pause')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn}
        disabled={pending} onClick={() => {void runAction(onPause)}} aria-label={t('action.pause')}><IconPauseOutline16 size={14} /></button></Tooltip>}
      {(goal.phase === 'paused' || goal.phase === 'blocked') && <Tooltip label={t('action.resume')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn}
        disabled={pending} onClick={() => {void runAction(onResume)}} aria-label={t('action.resume')}><IconPlayOutline16 size={14} /></button></Tooltip>}
      <Tooltip label={t('action.edit')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn} disabled={pending}
        onClick={() => {setDraft(goal.objective); setEditing(true)}} aria-label={t('action.edit')}><IconEditOutline16 size={14} /></button></Tooltip>
      <Tooltip label={t('action.clear')} side="bottom" delayMs={500}><button type="button" className={css.iconBtn} disabled={pending}
        onClick={() => {void handleClear(goal.id)}} aria-label={t('action.clear')}><IconTrashOutline16 size={14} /></button></Tooltip>
      <GoalControls projection={projection} onComplete={onComplete} onBudget={onBudget} onResume={onResume} runAction={runAction} pending={pending} />
    </div>
  </div></div>
}
export interface GoalDockProps extends GoalBarActions, PropsLocale<'goal'> {
  useProjection(name: 'goal'): GoalProjection | null | undefined
}
export function GoalDock({useProjection, onEdit, onPause, onResume, onClear, onComplete, onBudget, t}: GoalDockProps) {
  const projection = useProjection('goal')
  return <GoalBar goal={projection === undefined ? undefined : projection === null ? null : projection.goal} projection={projection} onEdit={onEdit} onPause={onPause}
    onResume={onResume} onClear={onClear} onComplete={onComplete} onBudget={onBudget} t={t} />
}
