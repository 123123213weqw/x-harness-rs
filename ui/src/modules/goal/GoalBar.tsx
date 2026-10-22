/** Compact Goal dock; user controls reuse the existing authoritative RPCs. */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, Menu, Modal, IconCheckOutline16, IconCloseOutline16, IconEditOutline16,
  IconEllipsisOutline16, IconGoalOutline16, IconPauseOutline16, IconPlayOutline16, IconTrashOutline16,
} from '@xharness/dsh-client-ui-primitives'
import type { MenuEntry } from '@xharness/dsh-client-ui-primitives'
import type { PropsLocale } from '../views-types'
import type { GoalKey } from './locales'
import type { GoalActionResult, GoalBarActions, GoalProjection, GoalSnapshot } from './contracts'
import css from './GoalBar.styles'

const PHASE_LABELS = {active: 'phase.active', paused: 'phase.paused', blocked: 'phase.blocked', complete: 'phase.complete'} as const
const STATES: Readonly<Record<string, GoalKey>> = {
  disabled: 'state.disabled', running: 'state.running', queued: 'state.queued', waiting: 'state.waiting',
  awaiting_approval: 'state.awaitingApproval', awaiting_answer: 'state.awaitingAnswer', awaiting_confirmation: 'state.awaitingConfirmation',
  network_backoff: 'state.networkBackoff', paused: 'state.paused', blocked: 'state.blocked', complete: 'phase.complete',
}
const REASONS: Readonly<Record<string, string>> = {
  round_budget: '轮数预算已到', cancelled: '用户停止', execution_error: '执行失败', step_limit: '步骤上限',
  output_limit: '输出上限', outcome_unknown: '上轮结果未知，未自动重放', report_protocol_stalled: '连续缺少进展报告',
}
function stateLabel(goal: GoalSnapshot, projection: GoalProjection | null | undefined, t: PropsLocale<'goal'>['t']): string {
  const state = projection?.execution?.state
  if (state === undefined) return t(PHASE_LABELS[goal.phase])
  const key = STATES[state]
  return key === undefined ? state : t(key)
}
export function goalStatus(goal: GoalSnapshot, projection: GoalProjection | null | undefined, t: PropsLocale<'goal'>['t']): string {
  const execution = projection?.execution
  return `${stateLabel(goal, projection, t)} · ${execution?.roundsStarted ?? goal.roundsStarted ?? 0}/${execution?.maxGoalRounds ?? goal.maxGoalRounds} ${t('rounds.unit')}`
}
export function goalTitle(goal: GoalSnapshot, projection: GoalProjection | null | undefined): string {
  const execution = projection?.execution; const report = execution?.report
  return [goal.objective, execution?.pauseReason && (REASONS[execution.pauseReason] ?? execution.pauseReason), execution?.pauseDetail,
    goal.blockedReason?.message, report?.summary, ...(report?.remaining ?? []),
    ...(report?.evidence ?? []).map(e => `${e.kind}: ${e.reference ?? e.execution_id}`),
  ].filter(Boolean).join('\n')
}
type RunAction = (action: () => Promise<GoalActionResult>) => Promise<GoalActionResult | undefined>
interface ControlsProps extends Omit<GoalBarActions, 'onEdit' | 'onClear'>, PropsLocale<'goal'> {
  goal: GoalSnapshot; projection: GoalProjection | null | undefined
  runAction: RunAction; pending: boolean; actionError: string | null; beginEdit(): void; clearGoal(): Promise<void>
}
function GoalControls({goal, projection, onComplete, onResume, onPause, onBudget, clearGoal, runAction, pending, actionError, beginEdit, t}: ControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [surface, setSurface] = useState<'none' | 'budget' | 'clear'>('none')
  const [budget, setBudget] = useState('')
  const identity = useRef(goal.id)
  const moreRef = useRef<HTMLButtonElement>(null)
  const budgetRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    identity.current = goal.id; setMenuOpen(false); setSurface('none'); setBudget('')
    return () => {identity.current = ''}
  }, [goal.id, goal.revision])
  const execution = projection?.execution
  const complete = goal.phase === 'complete'
  const confirmation = !complete && execution?.state === 'awaiting_confirmation'
  const resume = complete || goal.phase === 'paused' || goal.phase === 'blocked' || execution?.state === 'disabled' || confirmation
  const resumeLabel = complete ? t('action.reopen') : execution?.state === 'disabled' ? t('action.enable') : confirmation ? t('action.continue') : t('action.resume')
  const openBudget = () => {
    setMenuOpen(false); setBudget(String(execution?.maxGoalRounds ?? goal.maxGoalRounds)); setSurface('budget')
  }
  const closeSurface = () => {
    if (pending) return
    const previous = surface; setSurface('none')
    if (previous === 'budget') budgetRef.current?.focus()
    else moreRef.current?.focus()
  }
  const items: MenuEntry[] = [
    {id: 'edit', label: t('action.edit'), icon: <IconEditOutline16 />, disabled: pending},
    ...(!complete ? [
      {id: 'budget', label: t('action.budget'), disabled: pending},
      {id: 'complete', label: t('action.complete'), icon: <IconCheckOutline16 />, disabled: pending},
    ] : []),
    {id: 'separator', type: 'separator'},
    {id: 'clear', label: t('action.clear'), icon: <IconTrashOutline16 />, danger: true, disabled: pending},
  ]
  const validBudget = Number.isSafeInteger(Number(budget)) && Number(budget) >= 1
  return <span className={css.controls} data-goal-runtime>
    <span className={css.label} title={goalStatus(goal, projection, t)}>{stateLabel(goal, projection, t)}</span>
    <button ref={budgetRef} type="button" className={css.rounds} disabled={pending || complete} aria-label={t('action.budget')}
      title={complete ? goalStatus(goal, projection, t) : t('action.budget')} onClick={openBudget}>
      {execution?.roundsStarted ?? goal.roundsStarted ?? 0}/{execution?.maxGoalRounds ?? goal.maxGoalRounds} {t('rounds.unit')}
    </button>
    {confirmation && <button type="button" className={css.iconBtn} disabled={pending} aria-label={t('action.confirm')} title={t('action.confirm')}
      onClick={() => {void runAction(onComplete)}}><IconCheckOutline16 size={16} /></button>}
    {resume ? <button type="button" className={css.iconBtn} disabled={pending} aria-label={resumeLabel} title={resumeLabel}
      onClick={() => {void runAction(onResume)}}><IconPlayOutline16 size={16} /></button>
      : <button type="button" className={css.iconBtn} disabled={pending} aria-label={t('action.pause')} title={t('action.pauseHint')}
        onClick={() => {void runAction(onPause)}}><IconPauseOutline16 size={16} /></button>}
    <Menu open={menuOpen} onClose={() => {setMenuOpen(false)}} items={items} portal side="top" align="end" compact
      onSelect={id => {
        if (pending) return
        setMenuOpen(false)
        if (id === 'edit') beginEdit()
        else if (id === 'budget') openBudget()
        else if (id === 'complete') {moreRef.current?.focus(); void runAction(onComplete)}
        else if (id === 'clear') setSurface('clear')
      }}
      anchor={<button ref={moreRef} type="button" className={css.iconBtn} disabled={pending} aria-label={t('action.more')}
        title={t('action.more')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => {setMenuOpen(value => !value)}}>
        <IconEllipsisOutline16 size={16} />
      </button>} />
    <Modal open={surface === 'budget'} onClose={closeSurface} title={t('budget.title')} closeLabel={t('action.close')}
      description={t('budget.hint')} className={css.dialog}>
      <form onSubmit={async event => {
        event.preventDefault()
        if (!validBudget || pending) return
        const started = goal.id; const result = await runAction(() => onBudget(Number(budget)))
        if (result?.ok && identity.current === started) {setSurface('none'); budgetRef.current?.focus()}
      }}>
        <label className={css.budgetLabel}>{t('budget.label')}
          <input className={css.budgetInput} type="number" min={1} step={1} value={budget} disabled={pending} autoFocus
            onChange={event => {setBudget(event.target.value)}} />
        </label>
        {actionError !== null && <p className={css.error} role="alert">{actionError}</p>}
        <div className={css.dialogActions}>
          <Button size="sm" disabled={pending} onClick={closeSurface}>{t('action.cancelDialog')}</Button>
          <Button size="sm" variant="primary" type="submit" disabled={pending || !validBudget}>{t('budget.save')}</Button>
        </div>
      </form>
    </Modal>
    <Modal open={surface === 'clear'} onClose={closeSurface} title={t('clear.title')} closeLabel={t('action.close')}
      description={t('clear.hint')} className={css.dialog}
      footer={<>
        <Button size="sm" disabled={pending} onClick={closeSurface}>{t('action.cancelDialog')}</Button>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => {void clearGoal()}}>{t('action.clear')}</Button>
      </>}>
      {actionError !== null && <p className={css.error} role="alert">{actionError}</p>}
    </Modal>
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
    return () => {actionEpoch.current++; pendingRef.current = false}
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
  if (goal === undefined || goal === null || goal.id === clearedGoalId) return null
  const beginEdit = () => {setDraft(goal.objective); setEditing(true)}
  return <div className={css.dock} data-goal-bar>
    <div className={css.bar} title={goalTitle(goal, projection)}>
      <span className={css.goalGlyph}><IconGoalOutline16 size={16} /></span>
      {editing ? <form className={css.editForm} onSubmit={event => {event.preventDefault(); void handleEdit()}}>
        <input className={css.objectiveInput} type="text" aria-label={t('objective.aria')} value={draft} autoFocus disabled={pending}
          onChange={event => {setDraft(event.target.value)}} onKeyDown={event => {if (event.key === 'Escape' && !pending) setEditing(false)}} />
        <button type="submit" className={css.iconBtn} disabled={pending || draft.trim() === ''} aria-label={t('action.save')} title={t('action.save')}><IconCheckOutline16 size={16} /></button>
        <button type="button" className={css.iconBtn} disabled={pending} onClick={() => {setEditing(false)}} aria-label={t('action.cancel')} title={t('action.cancel')}><IconCloseOutline16 size={16} /></button>
      </form> : <>
        <button type="button" className={css.objective} title={t('action.edit')} aria-label={`${t('action.edit')}: ${goal.objective}`} disabled={pending} onClick={beginEdit}>{goal.objective}</button>
        <GoalControls key={goal.id} goal={goal} projection={projection} onComplete={onComplete} onBudget={onBudget} onPause={onPause} onResume={onResume}
          clearGoal={async () => {
            if ((await runAction(onClear))?.ok) setClearedGoalId(goal.id)
          }} runAction={runAction} beginEdit={beginEdit} pending={pending} actionError={actionError} t={t} />
      </>}
    </div>
    {actionError !== null && <div className={css.error} role="status">{actionError}</div>}
  </div>
}
export interface GoalDockProps extends GoalBarActions, PropsLocale<'goal'> {
  useProjection(name: 'goal'): GoalProjection | null | undefined
}
export function GoalDock({useProjection, onEdit, onPause, onResume, onClear, onComplete, onBudget, t}: GoalDockProps) {
  const projection = useProjection('goal')
  return <GoalBar goal={projection === undefined ? undefined : projection === null ? null : projection.goal} projection={projection} onEdit={onEdit} onPause={onPause}
    onResume={onResume} onClear={onClear} onComplete={onComplete} onBudget={onBudget} t={t} />
}
