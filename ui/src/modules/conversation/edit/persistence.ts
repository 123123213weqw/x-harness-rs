import { isObjectRecord } from '../../shared/runtime-types'
import { isImageAttachmentRef, isUnknownArray } from '../wire-guards'
import type { ImageAttachmentRef } from '../types/wire'
export type EditImage = { file: File; ref?: never } | { file?: never; ref: ImageAttachmentRef; kind?: 'image' | 'file'; name?: string; type?: string }
export interface EditDraft { text: string; images: readonly EditImage[] }
export interface EditRecord { version: 1; backup: EditDraft | null; draft: EditDraft }
export interface EditStorage { load(id: string): Promise<EditRecord | undefined>; save(id: string, record: EditRecord): Promise<void>; remove(id: string): Promise<void> }
type StoredImage = Exclude<EditImage, { file: File }> | { blob: ArrayBuffer; name: string; type: string; lastModified: number }
interface StoredDraft { text: string; images: readonly StoredImage[] }
interface StoredRecord { version: 1; backup: StoredDraft | null; draft: StoredDraft }
/** Portable bytes, not File handles: WebKit may abort IndexedDB writes containing File blobs. */
export function xhEditStorage(): EditStorage {
 let database: Promise<IDBDatabase> | undefined
 const fileBytes = new WeakMap<File, Promise<ArrayBuffer>>()
 const encodeDraft = async (draft: EditDraft | null): Promise<StoredDraft | null> => draft === null ? null : { ...draft, images: await Promise.all(draft.images.map(async image => {
   if (!image.file) return image
   let bytes = fileBytes.get(image.file); if (!bytes) { bytes = image.file.arrayBuffer(); fileBytes.set(image.file, bytes) }
   return { blob: await bytes, name: image.file.name, type: image.file.type, lastModified: image.file.lastModified }
 })) }
 const decodeDraft = (draft: StoredDraft): EditDraft => ({ ...draft, images: draft.images.map(image => 'blob' in image ? { file: new File([image.blob], image.name, { type: image.type, lastModified: image.lastModified }) } : image) })
 const access = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  database ??= new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('xharness-message-edits-v1', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const db = await database
  return new Promise<T>((resolve, reject) => { const tx = db.transaction('drafts', mode), request = operation(tx.objectStore('drafts')); tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Draft storage failed')) })
 }
 return {
  load: async id => { const raw = await access<unknown>('readonly', store => { const request: IDBRequest<unknown> = store.get(id); return request }); if (raw !== undefined && !storedRecord(raw)) throw new Error('Stored draft is invalid'); const record = raw; return record ? { version: 1, backup: record.backup ? decodeDraft(record.backup) : null, draft: decodeDraft(record.draft) } : undefined },
  save: async (id, value) => { const draft = await encodeDraft(value.draft); if (!draft) throw Error('Draft unavailable'); const record: StoredRecord = { version: 1, backup: await encodeDraft(value.backup), draft }; await access<IDBValidKey>('readwrite', store => store.put(record, id)) },
  remove: async id => { await access<undefined>('readwrite', store => store.delete(id)) },
 }
}
export const xhEditPersistence = xhEditStorage()

function storedImage(value: unknown): value is StoredImage {
  if (!isObjectRecord(value)) return false
  if ('blob' in value) return value.blob instanceof ArrayBuffer && typeof value.name === 'string' && typeof value.type === 'string' && typeof value.lastModified === 'number'
  return isImageAttachmentRef(value.ref) && value.file === undefined
    && (value.kind === undefined || value.kind === 'image' || value.kind === 'file')
    && (value.name === undefined || typeof value.name === 'string') && (value.type === undefined || typeof value.type === 'string')
}
function storedDraft(value: unknown): value is StoredDraft {
  return isObjectRecord(value) && typeof value.text === 'string' && isUnknownArray(value.images) && value.images.every(storedImage)
}
function storedRecord(value: unknown): value is StoredRecord {
  return isObjectRecord(value) && value.version === 1 && (value.backup === null || storedDraft(value.backup)) && storedDraft(value.draft)
}
