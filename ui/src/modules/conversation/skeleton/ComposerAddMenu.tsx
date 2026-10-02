/** One shared plus menu owns native attachment selection and command launching. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Menu, IconPlusOutline16, IconPaperclipOutline16, IconCodeOutline16 } from '../primitives'
import type { ComposerBarProps } from '../contract/slots'
export function ComposerAddMenu({ className, canAttach, canCommands, onAddFiles, onCommands, onOpen, focusInput, t }: {
  className: string; canAttach: boolean; canCommands: boolean; onAddFiles(files: readonly File[]): void; onCommands(): void; onOpen?(): void; focusInput(): void; t: ComposerBarProps['t']
}) {
  const [open, setOpen] = useState(false)
  const picker = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const fileLabel = useRef<HTMLSpanElement>(null), commandLabel = useRef<HTMLSpanElement>(null), lastFirst = useRef(false)
  const disabled = !canAttach && !canCommands
  const buttons = (): HTMLButtonElement[] => [fileLabel.current, commandLabel.current].map(label => label?.closest<HTMLButtonElement>('[role="menuitem"]')).filter((button): button is HTMLButtonElement => button != null && !button.disabled)
  const close = (): void => { if (buttons().some(button => button === document.activeElement)) trigger.current?.focus({ preventScroll: true }); setOpen(false) }
  const show = (last = false): void => { if (disabled) return; onOpen?.(); lastFirst.current = last; setOpen(true) }
  useEffect(() => {
    if (!open || disabled) return
    const frame = requestAnimationFrame(() => { const items = buttons(); (lastFirst.current ? items.at(-1) : items[0])?.focus({ preventScroll: true }) })
    return () => cancelAnimationFrame(frame)
  }, [open, disabled])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { const input = picker.current; input?.addEventListener('cancel', focusInput); return () => input?.removeEventListener('cancel', focusInput) }, [focusInput])
  const select = (id: string): void => { setOpen(false); if (id === 'attachment' && canAttach) picker.current?.click(); if (id === 'commands' && canCommands) { focusInput(); onCommands() } }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab' && open) { close(); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (!open && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault(); event.stopPropagation()
    if (!open) { show(event.key === 'ArrowUp'); return }
    const items = buttons(), current = items.findIndex(button => button === document.activeElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[index]?.focus({ preventScroll: true })
  }
  return <span data-composer-add-menu="true" onKeyDown={onKeyDown} style={{ display: 'inline-flex' }}>
    <style>{'[role="menuitem"]:has([data-composer-add-label]):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}'}</style>
    <Menu open={open && !disabled} side="top" portal compact onClose={close} onSelect={select}
      items={[
        { id: 'attachment', disabled: !canAttach, icon: <IconPaperclipOutline16 size={16} />, label: <span ref={fileLabel} data-composer-add-label="true">{t('input.attachFiles')}</span> },
        { type: 'separator', id: 'attachment-commands' },
        { id: 'commands', disabled: !canCommands, icon: <IconCodeOutline16 size={16} />, label: <span ref={commandLabel} data-composer-add-label="true">{t('input.commands')}</span> },
      ]} anchor={<button ref={trigger} type="button" className={className} disabled={disabled} title={t('input.add')} aria-label={t('input.add')} aria-haspopup="menu" aria-expanded={open && !disabled} onMouseDown={event => event.preventDefault()} onClick={() => open ? close() : show()}><IconPlusOutline16 size={14} /></button>} />
    <input ref={picker} type="file" multiple hidden disabled={!canAttach} aria-label={t('input.attachFiles')} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (canAttach && files.length) onAddFiles(files); focusInput() }} />
  </span>
}
