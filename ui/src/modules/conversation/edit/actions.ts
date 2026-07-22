import type { InputHub } from '../input/hub'
import type { ISessions } from '../types/runtime'
import type { EditImage } from './persistence'
import { editableDraft } from './MessageEditor'
export function xhEditMessage(hub: InputHub, id: string, content: readonly unknown[]): Promise<void> {
 const shell = hub.shell(id), editor = shell.xhEditor
 if (!editor) return Promise.reject(new Error('Message editor unavailable'))
 return editor.request(content).catch((error: unknown) => shell.notify('error', String(error)))
}
/** Resolve source-owned attachment bytes before forking; excluded history cannot authorize child references. */
export async function xhForkMessage(hub: InputHub, sessions: ISessions, id: string, seq: number, content: readonly unknown[]): Promise<string> {
 const draft = editableDraft(content)
 if (!Number.isSafeInteger(seq) || seq < 0 || !draft) throw new Error('Unsupported fork message')
 const source = sessions.binding(id)?.session; if (!source) throw new Error('Source session is unavailable')
 const images: EditImage[] = await Promise.all(draft.images.map(async image => {
  if (!image.ref?.attachmentId) throw new Error('Attachment reference is missing')
  const result = await source.readAttachment(image.ref.attachmentId); if (!result.ok) throw new Error(result.error.message || 'Attachment could not be read')
  return { file: new File([Uint8Array.from(result.value.data).buffer], image.ref.name || 'attachment', { type: result.value.attachment.mediaType || image.ref.mediaType }) }
 }))
 const childId = await sessions.fork({ sessionId: id, beforeUserSeq: seq, increaseTitle: true }), shell = hub.shell(childId)
 const editor = shell.xhEditor; if (!editor) throw new Error('Message editor unavailable')
 await editor.request(content, images); sessions.open(childId)
 if (!editor.state.editing) shell.notify('error', editor.state.error || 'Could not prepare fork draft')
 return childId
}
