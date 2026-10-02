import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttachmentLoader, DurableAttachment, ImageAttachment, MessageImageLabels, MessageImagesProps } from './contracts'
import { MessageImageCss as css } from './styles'
import { HistoryFile } from './FileCard'
import { ImageLightbox } from './ImageLightbox'
import { messageImageLabels } from './labels'
function isImageAttachment(attachment: ImageAttachment | DurableAttachment): attachment is ImageAttachment {
  return typeof attachment.width === 'number' && typeof attachment.height === 'number'
}
/** Clamp aspect ratio while never upscaling beyond the admitted image. */
function singleFit(attachment: ImageAttachment) {
  const natural = attachment.width / attachment.height, ratio = Math.min(4, Math.max(.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height)
  return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)), objectPosition: natural < .25 ? 'center top' : natural > 4 ? 'left center' : 'center' }
}
function MessageImage({ attachment, load, variant, labels }: { attachment: ImageAttachment; load: AttachmentLoader; variant: 'single' | 'tile'; labels: MessageImageLabels }) {
  const [src, setSrc] = useState<string | null>(null), [error, setError] = useState(false), [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0)
  const request = useCallback(() => { setAttempt(value => value + 1) }, []), close = useCallback(() => { setOpen(false) }, [])
  const fit = useMemo(() => variant === 'single' ? singleFit(attachment) : undefined, [attachment, variant])
  useEffect(() => {
    let live = true; setError(false); setSrc(null)
    void load(attachment).then(url => { if (live) setSrc(url) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load, attempt])
  const label = attachment.name ?? labels.image
  if (error) return <button type="button" className={css.error} data-variant={variant} onClick={request}>{labels.loadFailed}</button>
  return <>
    <button type="button" className={css.frame} data-variant={variant} style={fit === undefined ? undefined : { width: fit.width, height: fit.height }} title={labels.open} aria-label={labels.openNamed(label)} onClick={() => { if (src !== null) setOpen(true) }}>
      {src === null ? <span className={css.loading}>{labels.loading}</span> : <img src={src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} />}
    </button>
    {open && src !== null && <ImageLightbox src={src} alt={label} labels={labels.lightbox} onClose={close} />}
  </>
}
export function MessageImages({ images, loadImage, align, t }: MessageImagesProps) {
  if (images.length === 0) return null
  const labels = messageImageLabels(t), variant = images.length === 1 ? 'single' : 'tile'
  return <div className={css.gallery} data-align={align}>{images.map((image, index) => {
    const attachment = image.attachment, key = `${attachment.attachmentId}:${index}`
    if (image.kind === 'file' || !isImageAttachment(attachment)) return <HistoryFile attachment={attachment} load={loadImage} key={key} />
    // Host image admission requires both dimensions. Keep the durable reference
    // intact: loadImage performs session authorization and URL resolution.
    return <MessageImage attachment={attachment} load={loadImage} variant={variant} labels={labels} key={key} />
  })}</div>
}
