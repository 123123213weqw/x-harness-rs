import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent, KeyboardEvent, RefCallback } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconCheckOutline16, IconWarningOutline16, Toast } from '@xharness/dsh-client-ui-primitives'
import type { ModelSelection, ModelSelectProps } from './contracts'
import { ContextPane, ContextRow, ReasoningStatus } from './ContextPane'
import { css } from './styles'
import contextStyles from './ContextPane.css'
import { isManagedModelProvider } from '../shared/managed-models'

type Pane = 'root' | 'model' | 'custom' | 'effort' | 'context'
type EffortChoice = { key: string; effort: string | undefined; label: string; description?: string }
function classes(...values: (string | false)[]): string { return values.filter(Boolean).join(' ') }

/** Adjacent composer controls; effort choices reuse the authoritative session RPC. */
function ModelSelect({ locked, available, directory, load, select, manageModels, t }: ModelSelectProps) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const openerRef = useRef<'model' | 'effort'>('model')
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null)
  const lastActionRef = useRef<'load' | 'select'>('load')
  useLayoutEffect(() => { setOpen(false); setPane('root') }, [state.current?.provider, state.current?.model])
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
  const visibleGroups = state.groups.filter(group => isManagedModelProvider(group.id) === (pane !== 'custom'))
  const customSelected = state.current !== null && !isManagedModelProvider(state.current.provider)
  const busy = state.status === 'selecting'
  const capability = currentChoice?.model.reasoningCapability
  const displayEffort = capability?.state === 'disabled' ? t('effort.disabled') : effortLabel ?? t('effort.unknown')
  const effortTriggerLabel = t('effort.trigger', { effort: displayEffort })
  const reload = () => { lastActionRef.current = 'load'; void Promise.resolve(load()).catch(() => {}) }
  const refreshCapabilities = () => { lastActionRef.current = 'load'; void Promise.resolve(load(true)).catch(() => {}) }
  const loadContext = (refresh?: boolean) => { lastActionRef.current = 'load'; return Promise.resolve(load(refresh)).catch(() => {}) }
  useEffect(() => { if (available) { lastActionRef.current = 'load'; load() } }, [available, load])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])
  useEffect(() => {
    if (open && pane !== 'root' && pane !== 'context') {
      const enabled = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
      // Retain navigation focus on metadata refresh unless that item disappeared.
      if (!enabled.some(item => item === document.activeElement)) (enabled.find(item => item.getAttribute('aria-checked') === 'true') ?? enabled[0])?.focus()
    }
  }, [open, pane, reasoning, effectiveEffort])
  if (!available) return null

  const close = (restoreFocus = false) => {
    setOpen(false); setPane('root')
    if (restoreFocus) queueMicrotask(() => { (openerRef.current === 'effort' ? effortTriggerRef : triggerRef).current?.focus() })
  }
  const show = (opener: 'model' | 'effort') => {
    openerRef.current = opener
    // WebKit does not necessarily focus a button on pointer activation.
    ;(opener === 'effort' ? effortTriggerRef : triggerRef).current?.focus()
    setPane(opener === 'effort' ? 'effort' : 'root'); setOpen(true)
    // A cached catalog is already authoritative. Opening a menu is not a refresh.
    if (state.status === 'idle') reload()
  }
  const moveFocus = (offset: number) => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    items[active < 0 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Escape' || (event.key === 'ArrowLeft' && pane !== 'root' && pane !== 'context')) && open) {
      event.preventDefault()
      if (openerRef.current === 'effort' || pane === 'root') close(true)
      else {
        setPane(pane === 'custom' ? 'model' : 'root')
        queueMicrotask(() => { itemRefs.current.find(item => item !== null)?.focus() })
      }
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
    if (locked || busy) return
    if (state.current?.provider === selection.provider && state.current.model === selection.model) { close(true); return }
    lastActionRef.current = 'select'; void select(selection).then(settleSelection)
  }
  const chooseEffort = (effort: string | undefined) => {
    if (locked || busy || state.current === null || capability?.state === 'disabled') return
    if (effectiveEffort === effort) { close(true); return }
    const selection = { provider: state.current.provider, model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(state.current.contextWindowTokens === undefined ? {} : { contextWindowTokens: state.current.contextWindowTokens }),
    }
    lastActionRef.current = 'select'; void select(selection).then(settleSelection)
  }
  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined ? t('trigger.selectAria') : t('trigger.aria', { model: modelLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = (): RefCallback<HTMLButtonElement> => { const at = itemIndex++; return node => { itemRefs.current[at] = node } }
  const loadError = (retryLabel: string, retry = reload) => state.error !== null && lastActionRef.current === 'load' && <div className={css.error}>
    <span>{t('error.action', { message: state.error })}</span><button type="button" className={css.retry} onClick={retry}>{t(retryLabel)}</button>
  </div>
  return <div ref={rootRef} className={css.root} onKeyDown={onKeyDown} onBlur={onBlur}>
    <button ref={triggerRef} data-xh-model-control="model" type="button" className={css.trigger} aria-label={triggerAria} aria-haspopup="menu" aria-expanded={open && openerRef.current === 'model'} aria-controls={open && openerRef.current === 'model' ? `${id}-menu` : undefined}
      title={triggerLabel} disabled={locked || busy} onClick={() => { if (open && openerRef.current === 'model') close(); else show('model') }}>
      <span className={css.triggerLabel}>{modelLabel}</span><IconChevronDownOutline14 className={classes(css.chevron, open && openerRef.current === 'model' && css.chevronOpen)} />
    </button>
    <button ref={effortTriggerRef} data-xh-model-control="effort" type="button" className={classes(css.trigger, css.triggerEffort)} aria-label={effortTriggerLabel}
      aria-haspopup="menu" aria-expanded={open && openerRef.current === 'effort'} aria-controls={open && openerRef.current === 'effort' ? `${id}-menu` : undefined}
      title={effortTriggerLabel} disabled={locked || busy || state.current === null}
      onClick={() => { if (open && openerRef.current === 'effort') close(); else show('effort') }}>
      <span className={css.triggerLabel}>{effortTriggerLabel}</span><IconChevronDownOutline14 className={classes(css.chevron, open && openerRef.current === 'effort' && css.chevronOpen)} />
    </button>
    {open && <div id={`${id}-menu`} className={css.menu} role={pane === 'context' ? 'dialog' : 'menu'} aria-label={pane === 'context' ? '调整上下文容量' : pane === 'effort' ? t('menu.effort') : t('menu.aria')} aria-busy={state.status === 'loading' || busy}>
      {pane === 'root' && <>
        <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
          <span className={css.cellLabel}>{t('menu.model')}</span><span className={css.cellValue}>{modelLabel}</span><IconChevronRightOutline14 className={css.cellChevron} />
        </button>
        <ContextRow state={state} itemRef={itemRef()} open={() => { setPane('context') }} />
      </>}
      {pane === 'context' && <ContextPane locked={locked} directory={directory} load={loadContext} select={select} back={() => { setPane('root') }} saved={() => { close(true) }} />}
      {(pane === 'model' || pane === 'custom') && <>
        {pane === 'custom' && <button ref={itemRef()} type="button" role="menuitem" className={css.cell} aria-label={t('menu.back')} onClick={() => { setPane('model') }}>
          <IconChevronRightOutline14 className={css.backChevron} /><span>{t('menu.custom')}</span>
        </button>}
        {state.status === 'loading' && <div className={css.status}>{t('status.loading')}</div>}
        {loadError('retry')}
        {state.failures.map(failure => <div className={css.warning} key={failure.id}>
          <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span><button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>)}
        <div className={classes(css.groups, 'scrollable')}>{visibleGroups.map(group => <section role="group" aria-labelledby={`${id}-${group.id}`} className={css.group} key={group.id}>
          <div className={css.groupTitle} id={`${id}-${group.id}`}><span>{isManagedModelProvider(group.id) ? 'XHarness' : group.name}</span>{isManagedModelProvider(group.id) && <span className={css.sourceBadge} title={t('source.accountHint')}>{t('source.account')}</span>}</div>
          {group.models.map(model => {
            const selected = state.current?.provider === group.id && state.current.model === model.id
            return <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected} className={classes(css.option, selected && css.selected)} title={model.name} disabled={locked || busy}
              onClick={() => { choose({ provider: group.id, model: model.id }) }} key={model.id}>
              <span className={css.optionCopy}><span className={css.modelName}>{model.name}</span>{model.description !== undefined && <span className={css.description}>{model.description}</span>}</span>
              <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
            </button>
          })}
        </section>)}</div>
        {state.status === 'ready' && pane === 'custom' && visibleGroups.every(group => group.models.length === 0) && <div className={css.empty}>{t('empty.custom')}</div>}
        {pane === 'model' && <>
          <div role="separator" className={css.separator} />
          <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('custom') }}>
            <span className={css.cellLabel}>{t('menu.custom')}</span><span className={css.cellValue} />{customSelected && <IconCheckOutline16 className={css.check} />}<IconChevronRightOutline14 className={css.cellChevron} />
          </button>
        </>}
        {manageModels !== undefined && <>
          <div role="separator" className={css.separator} />
          <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { close(true); queueMicrotask(manageModels) }}>{t('menu.manage')}</button>
        </>}
      </>}
      {pane === 'effort' && <>
        {loadError('action.reload', refreshCapabilities)}
        <div className={classes(css.groups, 'scrollable')}>
        {capability?.state === 'disabled' || effortChoices.length === 0 ? <div className={css.empty}>{t(capability?.state === 'disabled' ? 'effort.disabledHint' : 'effort.unknownHint')}</div> : effortChoices.map(level => <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={effectiveEffort === level.effort}
          className={classes(css.option, effectiveEffort === level.effort && css.selected)} disabled={locked || busy} onClick={() => { chooseEffort(level.effort) }} key={level.key}>
          <span className={css.optionCopy}><span className={css.modelName}>{level.label}</span>{level.description !== undefined && <span className={css.description}>{level.description}</span>}</span>
          <span className={css.check}>{effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}</span>
        </button>)}
        </div>
        <div role="separator" className={css.separator} />
        <ReasoningStatus state={state} load={refreshCapabilities} itemRef={itemRef()} t={t} />
        {manageModels !== undefined && (capability?.state === 'disabled' || reasoning === undefined) && <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { close(true); queueMicrotask(manageModels) }}>{t('menu.manage')}</button>}
      </>}
    </div>}
    {toast !== null && <Toast text={toast.text} icon={<IconWarningOutline16 />} anchor={rootRef.current?.closest('[data-composer-card]') ?? null} onDone={() => { setToast(null) }} key={toast.seq} />}
  </div>
}
export function XHarnessModelSelect(props: ModelSelectProps) { return <><style>{contextStyles}</style><ModelSelect {...props} /></> }
