import type { Translation } from '../shared/runtime-types'
import type { LightboxLabels, MessageImageLabels, RailLabels } from './contracts'
export function lightboxLabels(t: Translation): LightboxLabels { return { dialog: t('image.preview'), close: t('image.closePreview') } }
export function messageImageLabels(t: Translation): MessageImageLabels {
  return { image: t('image.label'), open: t('image.openOriginal'), openNamed: label => t('image.openOriginalLabel', { label }), loading: t('image.loading'), loadFailed: t('image.loadFailed'), lightbox: lightboxLabels(t) }
}
export function dropOverlayLabels(t: Translation, accepting: boolean, _limits: unknown) {
  return accepting ? { title: '拖入图片或文件', desc: '图片 ≤ 20 MiB / 张，普通文件 ≤ 32 MiB；本次合计 ≤ 96 MiB' } : { title: t('image.dropBlocked') }
}
export function attachmentRailLabels(t: Translation): RailLabels {
  return { group: t('image.pending'), open: t('image.openOriginal'), scrollLeft: t('image.scrollLeft'), scrollRight: t('image.scrollRight') }
}
