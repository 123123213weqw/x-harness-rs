// Shared composer entry point. Picker ownership stays local to this InputBar.
function XHarnessComposerAddMenu({ className, canAttach, canCommands, onAddFiles, onCommands, onOpen, focusInput, t }) {
  const h = react.createElement;
  const { Menu, IconPlusOutline16, IconPaperclipOutline16, IconCodeOutline16 } = _deepseek_ai_dsh_client_ui_primitives;
  const [open, setOpen] = react.useState(false);
  const picker = react.useRef(null), trigger = react.useRef(null);
  const fileLabel = react.useRef(null), commandLabel = react.useRef(null);
  const lastFirst = react.useRef(false);
  const disabled = !canAttach && !canCommands;
  const buttons = () => [fileLabel.current, commandLabel.current]
    .map(label => label?.closest('[role="menuitem"]')).filter(button => button && !button.disabled);
  const close = () => {
    if (buttons().includes(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const show = (last = false) => {
    if (disabled) return;
    onOpen?.();
    lastFirst.current = last;
    setOpen(true);
  };
  react.useEffect(() => {
    if (!open || disabled) return;
    // The shared portal is initially hidden until Menu has measured it.
    const frame = requestAnimationFrame(() => {
      const items = buttons();
      (lastFirst.current ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, disabled]);
  react.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  react.useEffect(() => {
    const input = picker.current;
    const cancel = () => focusInput();
    input?.addEventListener('cancel', cancel);
    return () => input?.removeEventListener('cancel', cancel);
  }, [focusInput]);
  const select = id => {
    setOpen(false);
    if (id === 'attachment' && canAttach) picker.current?.click();
    if (id === 'commands' && canCommands) { focusInput(); onCommands(); }
  };
  const onKeyDown = event => {
    if (event.key === 'Tab' && open) { close(); return; }
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); close(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (!open && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); event.stopPropagation();
    if (!open) { show(event.key === 'ArrowUp'); return; }
    const items = buttons(), current = items.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  };
  return h('span', { 'data-composer-add-menu': true, onKeyDown, style: { display: 'inline-flex' } },
    h('style', null, '[role="menuitem"]:has([data-composer-add-label]):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}'),
    h(Menu, { open: open && !disabled, side: 'top', portal: true, compact: true, onClose: close, onSelect: select,
      items: [
        { id: 'attachment', disabled: !canAttach, icon: h(IconPaperclipOutline16, { size: 16 }),
          label: h('span', { ref: fileLabel, 'data-composer-add-label': true }, t('input.attachFiles')) },
        { type: 'separator', id: 'attachment-commands' },
        { id: 'commands', disabled: !canCommands, icon: h(IconCodeOutline16, { size: 16 }),
          label: h('span', { ref: commandLabel, 'data-composer-add-label': true }, t('input.commands')) },
      ],
      anchor: h('button', { ref: trigger, type: 'button', className, disabled,
        title: t('input.add'), 'aria-label': t('input.add'), 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
        onMouseDown: event => event.preventDefault(), onClick: () => open ? close() : show(),
        children: h(IconPlusOutline16, { size: 14 }) }),
    }),
    h('input', { ref: picker, type: 'file', multiple: true, hidden: true, disabled: !canAttach,
      'aria-label': t('input.attachFiles'), onChange: event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (canAttach && files.length) onAddFiles(files);
        focusInput();
      } }),
  );
}
