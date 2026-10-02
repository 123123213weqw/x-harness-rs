import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerAttachmentsProps, DraftAttachment } from './contracts'
import { AttachmentRail } from './AttachmentRail'
import { DropOverlay } from './DropOverlay'
import { ImageLightbox } from './ImageLightbox'
import { lightboxLabels, dropOverlayLabels, attachmentRailLabels } from './labels'
import { ComposerAttachmentsCss as css } from './styles'
export function ComposerAttachments({ attachments, canAcceptDrop, onAddImages, onRemoveImage, dropLimits, t }: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<DraftAttachment | null>(null), [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])
  useEffect(() => { if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null) }, [attachments, preview])
  useEffect(() => {
    const fileTransfer = (event: DragEvent) => { const transfer = event.dataTransfer; return transfer === null || !transfer.types.includes('Files') ? null : transfer }
    const reset = () => { dragDepth.current = 0; setDragActive(false) }
    const onDragEnter = (event: DragEvent) => {
      if (fileTransfer(event) === null) return
      event.preventDefault(); ++dragDepth.current; setDragActive(true)
    }
    const onDragOver = (event: DragEvent) => { const transfer = fileTransfer(event); if (transfer !== null) { event.preventDefault(); transfer.dropEffect = canAcceptDrop ? 'copy' : 'none' } }
    const onDragLeave = (event: DragEvent) => {
      if (fileTransfer(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    const onDrop = (event: DragEvent) => { const transfer = fileTransfer(event); if (transfer === null) return; event.preventDefault(); reset(); if (canAcceptDrop) onAddImages([...transfer.files]) }
    document.addEventListener('dragenter', onDragEnter); document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave); document.addEventListener('drop', onDrop); window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter); document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave); document.removeEventListener('drop', onDrop); window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddImages])
  const railItems = useMemo(() => attachments.map(attachment => ({ id: attachment.id, previewUrl: attachment.previewUrl, alt: attachment.file.name || t('image.pending'), removeLabel: t('image.remove', { name: attachment.file.name }), attachment })), [attachments, t])
  return <>
    {dragActive && <DropOverlay disabled={!canAcceptDrop} labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)} />}
    {railItems.length > 0 && <div className={css.rail}><AttachmentRail items={railItems} labels={attachmentRailLabels(t)} onOpen={item => { setPreview(item.attachment) }} onRemove={item => { onRemoveImage(item.attachment.id) }} /></div>}
    {preview !== null && <ImageLightbox src={preview.previewUrl} alt={preview.file.name || t('image.original')} labels={lightboxLabels(t)} onClose={closePreview} />}
  </>
}
