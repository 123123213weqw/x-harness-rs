import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@xharness/dsh-client-ui-primitives'
import { ImageLightboxCss as css } from './styles'
import type { LightboxLabels } from './contracts'
export function ImageLightbox({ src, alt, labels, onClose }: { src: string; alt: string; labels: LightboxLabels; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null), restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); restoreRef.current?.focus() }
  }, [onClose])
  return createPortal(<div className={css.backdrop} role="dialog" aria-modal="true" aria-label={labels.dialog}>
    <div className={css.mask} aria-hidden="true" onMouseDown={onClose} /><img className={css.image} src={src} alt={alt} />
    <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}><IconCloseOutline16 size={16} /></button>
  </div>, document.body)
}
