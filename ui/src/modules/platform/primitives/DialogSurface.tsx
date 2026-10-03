import { useLayoutEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import css from './DialogSurface.module.css'

/** Native top-layer ownership supplies focus containment and background inertness.
 * The inner card/mask remain owned by each feature; do not emulate modality with
 * z-index or document-wide Escape listeners. Menus portal inside this surface.
 */
export function DialogSurface({ children, className, label, labelledBy, onClose, initialFocus }: {
  children: ReactNode
  className?: string
  label?: string
  labelledBy?: string
  onClose: () => void
  initialFocus?: RefObject<HTMLElement>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    initialFocus?.current?.focus()
    return () => {
      dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [initialFocus])

  return createPortal(<dialog ref={ref} className={`${css.surface} ${className ?? ''}`}
    role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy}
    onKeyDown={event => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const dialog = event.currentTarget
      const controls = [...dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
          && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      const first = controls[0]
      const last = controls.at(-1)
      if (first === undefined || last === undefined) { event.preventDefault(); dialog.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus()
      }
    }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}>
    {children}
  </dialog>, document.body)
}
