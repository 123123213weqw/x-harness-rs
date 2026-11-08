import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttachmentLoader, DurableAttachment, ImageAttachment, MessageImageLabels, MessageImagesProps } from './contracts'
import { MessageImageCss as css } from './styles'
import { HistoryFile } from './FileCard'
import { ImageLightbox } from './ImageLightbox'
import { messageImageLabels } from './labels'
import { historyImageBudget, historyThumbnailBudget, thumbnailQueue } from './image-budget'
function isImageAttachment(attachment: ImageAttachment | DurableAttachment): attachment is ImageAttachment {
  return typeof attachment.width === 'number' && typeof attachment.height === 'number'
}
/** Clamp aspect ratio while never upscaling beyond the admitted image. */
function singleFit(attachment: Pick<ImageAttachment, 'width' | 'height'>) {
  const natural = attachment.width / attachment.height, ratio = Math.min(4, Math.max(.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height)
  return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)), objectPosition: natural < .25 ? 'center top' : natural > 4 ? 'left center' : 'center' }
}
function MessageImage({ attachment, load, variant, labels }: { attachment: ImageAttachment; load: AttachmentLoader; variant: 'single' | 'tile'; labels: MessageImageLabels }) {
  const [src, setSrc] = useState<string | null>(null), [error, setError] = useState(false), [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>(), [budgetExceeded, setBudgetExceeded] = useState(false)
  const request = useCallback(() => { setAttempt(value => value + 1) }, []), close = useCallback(() => { setOpen(false) }, [])
  const fit = useMemo(() => variant === 'single' ? singleFit(dimensions ?? attachment) : undefined, [attachment, dimensions, variant])
  useEffect(() => {
    let live = true; setError(false); setBudgetExceeded(false); setSrc(null); setDimensions(undefined)
    // Every accepted thumbnail is physically <=480px, independent of the CSS
    // tile size. Reserve the worst case before any asynchronous load starts.
    const thumbnail = historyThumbnailBudget.reserve(480, 480)
    const lease = thumbnail && historyImageBudget.reserve(480, 480), abort = new AbortController()
    const release = () => { lease?.release(); thumbnail?.release() }
    if (!lease) { release(); setError(true); setBudgetExceeded(true); return }
    void thumbnailQueue.run(() => load(attachment, true), abort.signal)
      .then(url => { if (live) setSrc(url) })
      .catch(() => { release(); if (live) setError(true) })
    return () => { live = false; abort.abort(); release() }
  }, [attachment, load, attempt])
  const label = attachment.name ?? labels.image
  return <>
    <button type="button" className={css.frame} data-variant={variant} style={fit === undefined ? undefined : { width: fit.width, height: fit.height }} title={labels.open} aria-label={labels.openNamed(label)} onClick={() => { setOpen(true) }}>
      {src === null ? <span className={css.loading}>{error ? labels.open : labels.loading}</span> : <img src={src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} onLoad={event => { setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} onError={() => { setSrc(null); setError(true) }} />}
    </button>
    {error && <button type="button" className={css.error} data-variant={variant} onClick={request}>{budgetExceeded ? labels.budgetExceeded : labels.loadFailed}</button>}
    {open && <HistoricalOriginal attachment={attachment} load={load} labels={labels} onClose={close} />}
  </>
}

/** Original bytes/decoder are never mounted just to draw a gallery tile. Closing
 * a pending load cannot reopen it; reservations are idempotent under StrictMode. */
function HistoricalOriginal({ attachment, load, labels, onClose }: { attachment: ImageAttachment; load: AttachmentLoader; labels: MessageImageLabels; onClose(): void }) {
  const [src, setSrc] = useState<string>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true; const abort = new AbortController()
    setSrc(undefined); setError('')
    const lease = historyImageBudget.reserve(attachment.width, attachment.height)
    if (!lease) { setError(labels.budgetExceeded); return }
    void thumbnailQueue.run(() => load(attachment), abort.signal, true)
      .then(url => { if (live && url !== undefined) setSrc(url) }).catch(() => {
      lease.release(); if (live) setError(labels.loadFailed)
    })
    return () => { live = false; abort.abort(); lease.release() }
  }, [attachment, load, attempt, labels.budgetExceeded, labels.loadFailed])
  return <ImageLightbox src={src} alt={attachment.name ?? labels.image} labels={labels.lightbox} onClose={onClose} onError={() => { setSrc(undefined); setError(labels.loadFailed) }}>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{labels.loadFailed}</button></div> : <span role="status">{labels.loading}</span>}
  </ImageLightbox>
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
