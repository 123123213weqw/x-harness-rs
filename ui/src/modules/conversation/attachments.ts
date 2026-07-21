import type { ComposerAttachment } from './contract/slots'
import { DraftAttachmentId } from './input/contract'
/** Local intake UX matches the durable Host limits, including ordinary files. */
export function attachmentMediaType(file: File): string {
 if (file.type) return file.type
 const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
 const types: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
 return types[extension] ?? 'application/octet-stream'
}
export function attachmentKind(file: File): 'image' | 'file' { return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachmentMediaType(file)) ? 'image' : 'file' }
export function validateAttachments(files: readonly File[]): void {
 if (files.length > 128) throw Error('最多同时添加 128 个附件')
 if (files.filter(file => attachmentKind(file) === 'image').length > 16) throw Error('每条消息最多 16 张图片')
 for (const file of files) { const limit = attachmentKind(file) === 'image' ? 20 : 32; if (file.size > limit * 1024 * 1024) throw Error(file.name + ' 超过 ' + limit + ' MiB 上传限制') }
 if (files.reduce((sum, file) => sum + file.size, 0) > 96 * 1024 * 1024) throw Error('本次附件合计不能超过 96 MiB')
}
export function browserDraftAttachment(file: File): ComposerAttachment { return { kind: attachmentKind(file), id: DraftAttachmentId(crypto.randomUUID()), previewUrl: URL.createObjectURL(file), file } }
