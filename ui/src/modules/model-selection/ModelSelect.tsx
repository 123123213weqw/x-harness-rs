import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent, KeyboardEvent, RefCallback } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconCheckOutline16, IconWarningOutline16, Toast } from '@xharness/dsh-client-ui-primitives'
import type { ModelSelection, ModelSelectProps } from './contracts'
import { ContextPane, ContextRow, ReasoningStatus } from './ContextPane'
import { css } from './styles'
import contextStyles from './ContextPane.css'

type Pane = 'root' | 'model' | 'effort' | 'context'
type EffortChoice = { key: string; effort: string | undefined; label: string; description?: string }
function classes(...values: (string | false)[]): string { return values.filter(Boolean).join(' ') }

/** One composer trigger; model, effort and context live in its nested menu. */
function ModelSelect({ locked, available, directory, load, select, t }: ModelSelectProps) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const lastActionRef = useRef<'load' | 'select'>('load')
  useEffect(() => { setPane('root') }, [state.current?.provider, state.current?.model])
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const choices = useMemo(() => state.groups.flatMap(group => group.models.map(model => ({ group, model }))), [state.groups])
  const currentChoice = choices.find(choice => choice.group.id === state.current?.provider && choice.model.id === state.current?.model)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined ? undefined : effectiveEffort === undefined ? t('effort.providerDefault') : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined ? [] : [
    ...(reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }] : []),
    ...reasoning.efforts.map(effort => ({ key: `effort:${effort.id}`, effort: effort.id, label: effort.name, ...(effort.description === undefined ? {} : { description: effort.description }) })),
  ], [reasoning, t])
  const busy = state.status === 'selecting'
  const reload = () => { lastActionRef.current = 'load'; load() }
  useEffect(() => { if (available) { lastActionRef.current = 'load'; load() } }, [available, load])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])
  if (!available) return null

  const close = (restoreFocus = false) => {
    setOpen(false); setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  const show = () => { setPane('root'); setOpen(true); reload() }
  const moveFocus = (offset: number) => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') setPane('root'); else close(true)
      return
    }
    if (!open || pane === 'context') return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveFocus(event.key === 'ArrowDown' ? 1 : -1) }
  }
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // WebKit may report null before a nonfocusable menu button's click.
    // Outside pointer handling is authoritative in that case.
    if (event.relatedTarget === null) return
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }
  const settleSelection = (accepted: boolean) => {
    if (accepted) { if (rootRef.current !== null) close(true); return }
    const message = directory.getSnapshot().error
    if (message !== null) { ++toastSeq.current; setToast({ seq: toastSeq.current, text: t('error.action', { message }) }) }
  }
  const choose = (selection: ModelSelection) => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) { close(true); return }
    lastActionRef.current = 'select'; void select(selection).then(settleSelection)
  }
  const chooseEffort = (effort: string | undefined) => {
    if (state.current === null) return
    if (effectiveEffort === effort) { close(true); return }
    const selection = { provider: state.current.provider, model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(state.current.contextWindowTokens === undefined ? {} : { contextWindowTokens: state.current.contextWindowTokens }),
    }
    lastActionRef.current = 'select'; void select(selection).then(settleSelection)
  }
  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined ? t('trigger.selectAria') : effortLabel === undefined ? t('trigger.aria', { model: modelLabel }) : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = (): RefCallback<HTMLButtonElement> => { const at = itemIndex++; return node => { itemRefs.current[at] = node } }
  const loadError = (retryLabel: string) => state.error !== null && lastActionRef.current === 'load' && <div className={css.error}>
    <span>{t('error.action', { message: state.error })}</span><button type="button" className={css.retry} onClick={reload}>{t(retryLabel)}</button>
  </div>
  return <div ref={rootRef} className={css.root} onKeyDown={onKeyDown} onBlur={onBlur}>
    <button ref={triggerRef} type="button" className={css.trigger} aria-label={triggerAria} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
      title={triggerLabel} disabled={locked} onClick={() => { if (open) close(); else show() }}>
      <span className={css.triggerLabel}>{modelLabel}</span><IconChevronDownOutline14 className={classes(css.chevron, open && css.chevronOpen)} />
    </button>
    {open && <div id={`${id}-menu`} className={css.menu} role={pane === 'context' ? 'dialog' : 'menu'} aria-label={pane === 'context' ? '调整上下文容量' : t('menu.aria')} aria-busy={state.status === 'loading' || busy}>
      {pane === 'root' && <>
        <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
          <span className={css.cellLabel}>{t('menu.model')}</span><span className={css.cellValue}>{modelLabel}</span><IconChevronRightOutline14 className={css.cellChevron} />
        </button>
        {reasoning !== undefined && <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
          <span className={css.cellLabel}>{t('menu.effort')}</span><span className={css.cellValue}>{effortLabel}</span><IconChevronRightOutline14 className={css.cellChevron} />
        </button>}
        <ReasoningStatus state={state} load={load} itemRef={itemRef()} />
        <ContextRow state={state} itemRef={itemRef()} open={() => { setPane('context') }} />
      </>}
      {pane === 'context' && <ContextPane locked={locked} directory={directory} load={reload} select={select} back={() => { setPane('root') }} saved={() => { close(true) }} />}
      {pane === 'model' && <>
        {state.status === 'loading' && <div className={css.status}>{t('status.loading')}</div>}
        {loadError('retry')}
        {state.failures.map(failure => <div className={css.warning} key={failure.id}>
          <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span><button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>)}
        <div className={classes(css.groups, 'scrollable')}>{state.groups.map(group => <section role="group" aria-labelledby={`${id}-${group.id}`} className={css.group} key={group.id}>
          <div className={css.groupTitle} id={`${id}-${group.id}`}>{group.name}</div>
          {group.models.map(model => {
            const selected = state.current?.provider === group.id && state.current.model === model.id
            return <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected} className={classes(css.option, selected && css.selected)} title={model.name} disabled={busy}
              onClick={() => { choose({ provider: group.id, model: model.id }) }} key={model.id}>
              <span className={css.optionCopy}><span className={css.modelName}>{model.name}</span>{model.description !== undefined && <span className={css.description}>{model.description}</span>}</span>
              <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
            </button>
          })}
        </section>)}</div>
        {state.status === 'ready' && choices.length === 0 && <div className={css.empty}>{t('empty.models')}</div>}
      </>}
      {pane === 'effort' && <>
        {loadError('action.reload')}
        {effortChoices.length === 0 ? <div className={css.empty}>{t('empty.efforts')}</div> : effortChoices.map(level => <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={effectiveEffort === level.effort}
          className={classes(css.option, effectiveEffort === level.effort && css.selected)} disabled={busy} onClick={() => { chooseEffort(level.effort) }} key={level.key}>
          <span className={css.optionCopy}><span className={css.modelName}>{level.label}</span>{level.description !== undefined && <span className={css.description}>{level.description}</span>}</span>
          <span className={css.check}>{effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}</span>
        </button>)}
      </>}
    </div>}
    {toast !== null && <Toast text={toast.text} icon={<IconWarningOutline16 />} anchor={rootRef.current?.closest('[data-composer-card]') ?? null} onDone={() => { setToast(null) }} key={toast.seq} />}
  </div>
}
export function XHarnessModelSelect(props: ModelSelectProps) { return <><style>{contextStyles}</style><ModelSelect {...props} /></> }
