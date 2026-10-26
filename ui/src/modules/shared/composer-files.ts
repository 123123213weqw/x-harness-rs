import {objectValue} from './runtime-types'
/** Same-document, session-scoped draft intake. Never sends a prompt. The visible
 * composer admits the complete batch synchronously or returns an explicit error. */
const EVENT = 'xharness:composer-files'
interface Intake { sessionId: string; files: readonly File[]; result: string | null | undefined }
export function attachComposerFiles(sessionId: string, files: readonly File[]): void {
  const detail: Intake = { sessionId, files, result: undefined }
  window.dispatchEvent(new CustomEvent<Intake>(EVENT, { detail }))
  if (detail.result !== null) throw Error(detail.result ?? '当前聊天没有可用的附件输入框，选取未加入草稿')
}
export function listenComposerFiles(sessionId: string | undefined, accept: (files: readonly File[]) => string | null | undefined): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return
    const detail = objectValue(event.detail)
    const rawFiles: readonly unknown[] = Array.isArray(detail.files) ? detail.files : []
    const files = rawFiles.filter((file): file is File => file instanceof File)
    if (!detail || !sessionId || detail.sessionId !== sessionId || detail.result !== undefined
      || !files.length || files.length !== rawFiles.length) return
    detail.result = accept(files)
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
