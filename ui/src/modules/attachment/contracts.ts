import type { Translation } from '../shared/runtime-types'
/** Browser-owned drafts and Host-admitted history deliberately have different shapes. */
export interface DraftAttachment { id: string; kind?: 'image' | 'file'; file: File; previewUrl: string }
export interface DurableAttachment {
  attachmentId: string
  name?: string
  bytes: number
  width?: number
  height?: number
  mimeType?: string
  path?: string
}
export interface ImageAttachment extends DurableAttachment { width: number; height: number }
export type AttachmentLoader = (attachment: DurableAttachment) => Promise<string>
export interface RailItem { id: string; previewUrl: string; alt: string; removeLabel: string; attachment: DraftAttachment }
export interface RailLabels { group: string; open: string; scrollLeft: string; scrollRight: string }
export interface LightboxLabels { dialog: string; close: string }
export interface MessageImageLabels {
  image: string; open: string; openNamed(label: string): string; loading: string; loadFailed: string; lightbox: LightboxLabels
}
export interface ComposerAttachmentsProps {
  attachments: readonly DraftAttachment[]
  canAcceptDrop: boolean
  onAddImages(files: File[]): void
  onRemoveImage(id: string): void
  dropLimits?: unknown
  t: Translation
}
export interface HistoryAttachment { kind?: 'image' | 'file'; attachment: DurableAttachment }
export interface MessageImagesProps { images: readonly HistoryAttachment[]; loadImage: AttachmentLoader; align: 'start' | 'end'; t: Translation }
