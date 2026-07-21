import { isImageAttachmentRef } from '../wire-guards'
import { isObjectRecord } from '../../shared/runtime-types'
/** History is immutable. Editing is a session-scoped, recoverable draft transaction. */
import type { ComposerAttachment } from '../contract/slots'
import type { SessionInputShell } from '../input/facade'
import type { ConversationController } from '../service'
import type { ImageAttachmentRef, RpcResult } from '../types/wire'
import type { EditDraft, EditImage, EditRecord, EditStorage } from './persistence'
export interface EditorState { phase: 'idle' | 'confirm' | 'saving' | 'editing' | 'recover'; editing: boolean; error: string }
export interface EditorDependencies {
 id: string; shell: SessionInputShell; conversation: ConversationController; storage: EditStorage
 t(key: string): string; running(): boolean; focus(): void
 read(id: string): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
}
const recordOf = (value: unknown): Record<string, unknown> | undefined => isObjectRecord(value) ? value : undefined
export function editableDraft(content: readonly unknown[], prepared?: readonly EditImage[]): EditDraft | undefined {
 const blocks = content.map(recordOf)
 if (blocks.some(block => !block || !['text', 'image', 'file'].includes(String(block.type)))) return undefined
 const text = blocks.flatMap(block => block?.type === 'text' ? [typeof block.text === 'string' ? block.text : ''] : []).join('')
 const images: EditImage[] = []
 for (const block of blocks) {
  if (!block || (block.type !== 'image' && block.type !== 'file')) continue
  const ref = recordOf(block.attachment)
  if (!isImageAttachmentRef(ref) || !ref.attachmentId) return undefined
  images.push({ ref: ref, kind: block.type, name: typeof ref.name === 'string' ? ref.name : 'image', ...(typeof ref.mediaType === 'string' ? { type: ref.mediaType } : {}) })
 }
 return { text, images: prepared ?? images }
}
export class XHarnessMessageEditor {
 private readonly listeners = new Set<() => void>()
 state: EditorState = { phase: 'idle', editing: false, error: '' }
 private backup: EditDraft | null = null
 private pending: EditDraft | null = null
 private saved: EditRecord | null = null
 private ownChange = false
 private disposed = false
 private writes: Promise<void> = Promise.resolve()
 private readonly off: () => void
 readonly ready: Promise<void>
 constructor(readonly d: EditorDependencies) {
  this.off = d.shell.state.subscribe(() => { if (this.ownChange || this.disposed) return; if (this.state.editing && !this.busy()) void this.persist().catch(() => {}); this.set({}) })
  this.ready = d.storage.load(d.id).then(record => { if (record && !this.disposed && this.state.phase === 'idle') { this.saved = record; this.set({ phase: 'recover' }) } }).catch((error: unknown) => this.set({ error: String(error) }))
 }
 subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
 getSnapshot = (): EditorState => this.state
 set(next: Partial<EditorState>): void { if (this.disposed) return; this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener() }
 busy(): boolean { const shell = this.d.shell; return shell.disposed || shell.imageSendInFlight || shell.snapshot.phase === 'adjudicating' || shell.snapshot.phase === 'submitting' }
 private capture(): EditDraft {
  const snapshot = this.d.shell.snapshot, images = this.d.conversation.draftImages(snapshot.imageIds)
  if (images.length !== snapshot.imageIds.length) throw new Error(this.d.t('message.editMissing'))
  return { text: snapshot.draft, images: images.map(image => image.historyRef ? { ref: image.historyRef, ...(image.historyKind ? { kind: image.historyKind } : {}), name: image.file.name, type: image.file.type } : { file: image.file }) }
 }
 private persist(): Promise<void> {
  try {
   const record: EditRecord = { version: 1, backup: this.backup, draft: this.capture() }
   this.writes = this.writes.catch(() => {}).then(() => this.d.storage.save(this.d.id, record))
   void this.writes.catch((error: unknown) => this.set({ error: this.d.t('message.editStorage') + ': ' + String(error) }))
   return this.writes
  } catch (error) { this.set({ error: String(error) }); return Promise.reject(error) }
 }
 async request(content: readonly unknown[], preparedImages?: readonly EditImage[]): Promise<void> {
  await this.ready
  if (this.disposed || this.busy() || this.d.running()) return
  if (this.state.phase !== 'idle') { this.set({ error: this.d.t('message.editFinish') }); return }
  const draft = editableDraft(content, preparedImages)
  if (!draft) { this.set({ error: this.d.t('message.editUnsupported') }); return }
  this.pending = draft
  if (draft.images.some(image => !image.file && !image.ref.attachmentId)) { this.set({ error: this.d.t('message.editMissing') }); return }
  const before = this.capture()
  if (before.text || before.images.length) this.set({ phase: 'confirm', error: '' }); else await this.confirm()
 }
 async confirm(): Promise<void> {
  if (!this.pending || this.busy() || this.d.running() || this.state.editing || this.state.phase === 'saving') return
  this.set({ phase: 'saving', error: '' })
  const snapshot = this.d.shell.snapshot
  try {
   this.backup = this.capture()
   await this.d.storage.save(this.d.id, { version: 1, backup: this.backup, draft: this.pending })
   if (this.disposed) return
   if (snapshot !== this.d.shell.snapshot || this.busy() || this.d.running()) throw new Error(this.d.t('message.editChanged'))
   this.apply(this.pending); this.pending = null; this.set({ phase: 'editing', editing: true, error: '' }); this.d.focus()
  } catch (error) { await this.d.storage.remove(this.d.id).catch(() => {}); this.backup = null; this.set({ phase: 'idle', error: String(error) }) }
 }
 private apply(draft: EditDraft): void {
  const { shell, conversation } = this.d, old = [...shell.snapshot.imageIds], images: ComposerAttachment[] = []
  try {
   for (const descriptor of draft.images) {
    const file = descriptor.file ?? new File([], descriptor.name ?? 'image', { type: descriptor.type ?? 'image/png' })
    const image = conversation.createDraftImages([file])[0]; if (!image) throw new Error(this.d.t('message.editMissing'))
    if (descriptor.ref) { image.historyRef = descriptor.ref; image.historyKind = descriptor.kind ?? 'image'; image.loadState = 'loading' }
    images.push(image)
   }
  } catch (error) { for (const image of images) conversation.releaseDraftImage(image.id); throw error }
  this.ownChange = true
  try { for (const id of old) shell.removeImage(id); shell.addImages(images.map(image => image.id)); shell.setDraft(draft.text) } finally { this.ownChange = false }
  for (const id of old) conversation.releaseDraftImage(id)
  for (const image of images) if (image.historyRef) void this.hydrate(image)
 }
 async hydrate(image: ComposerAttachment): Promise<void> {
  const generation = image.generation = (image.generation ?? 0) + 1
  image.loadState = 'loading'; this.set({})
  try {
   if (!image.historyRef) throw new Error(this.d.t('message.editMissing'))
   const result = await this.d.read(image.historyRef.attachmentId)
   if (!result.ok) throw new Error(result.error.message)
   if (this.disposed || generation !== image.generation || !this.d.conversation.draftImages([image.id]).length) return
   const file = new File([Uint8Array.from(result.value.data).buffer], image.file.name, { type: result.value.attachment.mediaType })
   this.d.conversation.replaceDraftPreview(image, file)
  } catch (error) { if (generation !== image.generation) return; image.loadState = 'missing'; image.loadError = String(error) }
  if (!this.disposed) { this.ownChange = true; this.d.shell.publish(); this.ownChange = false; this.set({}) }
 }
 async recover(): Promise<void> {
  if (!this.saved || this.busy() || this.d.running()) return
  const snapshot = this.d.shell.snapshot
  if ((snapshot.draft && snapshot.draft !== this.saved.draft.text) || snapshot.imageIds.length) { this.set({ error: this.d.t('message.editChanged') }); return }
  this.backup = this.saved.backup; this.apply(this.saved.draft); this.saved = null; this.set({ phase: 'editing', editing: true, error: '' }); this.d.focus()
 }
 async cancel(): Promise<void> {
  if (this.busy() || this.state.phase === 'saving') return
  if (this.state.phase === 'confirm') { this.pending = null; this.set({ phase: 'idle', error: '' }); return }
  if (this.state.phase === 'recover' && this.saved) {
   const snapshot = this.d.shell.snapshot
   if ((snapshot.draft && snapshot.draft !== this.saved.draft.text) || snapshot.imageIds.length) { this.set({ error: this.d.t('message.editChanged') }); return }
   this.backup = this.saved.backup
  }
  if (this.backup) this.apply(this.backup)
  this.set({ phase: 'saving', editing: false, error: '' }); this.saved = null; this.backup = null
  await this.writes.catch(() => {}); await this.d.storage.remove(this.d.id).catch((error: unknown) => this.set({ error: String(error) })); this.set({ phase: 'idle' })
 }
 guardSubmit(): void {
  if (this.state.phase === 'confirm' || this.state.phase === 'recover' || this.state.phase === 'saving') throw new Error(this.d.t('message.editFinish'))
  if (this.state.editing && this.d.running()) throw new Error(this.d.t('message.editRunning'))
  for (const image of this.d.conversation.draftImages(this.d.shell.snapshot.imageIds)) if (image.historyRef && image.loadState !== 'ready') throw new Error(this.d.t('message.editMissing'))
 }
 async sent(): Promise<void> {
  if (!this.state.editing) return
  this.set({ phase: 'saving', editing: false, error: '' }); this.backup = null
  await this.writes.catch(() => {}); await this.d.storage.remove(this.d.id).catch((error: unknown) => this.set({ error: String(error) })); this.set({ phase: 'idle' })
 }
 dispose(): void { this.off(); this.disposed = true; this.listeners.clear() }
}
