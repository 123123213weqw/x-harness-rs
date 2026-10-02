import type { ApiResult, ClientContext } from '../views-types'
import type { MessageFeedbackRemote } from './controller'
export type RemoteResult<T> = ApiResult<T>
export type MessageId = string
export type SessionId = string
export interface HostObservable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export type MessageFeedbackRating = 'positive' | 'negative'
export interface MessageFeedbackItem {
  readonly messageId: string; readonly rating: MessageFeedbackRating; readonly note?: string
  readonly version: string; readonly createdAt: number; readonly updatedAt: number
}
type Success<T> = { readonly ok: true; readonly value: T }
type Rejected<Failure> = { readonly ok: false; readonly error: Failure }
type SessionNotFound = { code: 'session-not-found'; sessionId: string }
type VersionConflict = { code: 'version-conflict'; current: MessageFeedbackItem | null }
export type MessageFeedbackListResult = Success<{ items: readonly MessageFeedbackItem[] }> | Rejected<SessionNotFound>
export type MessageFeedbackPutResult = Success<MessageFeedbackItem> | Rejected<
  SessionNotFound | VersionConflict | { code: 'target-not-found'; sessionId: string; messageId: string }
  | { code: 'note-blank' } | { code: 'note-too-large'; maxBytes: number; actualBytes: number }
>
export type MessageFeedbackDeleteResult = Success<{ absent: true }> | Rejected<SessionNotFound | VersionConflict>
export interface FeedbackContext extends Omit<ClientContext, 'remote'> {
  remote: ClientContext['remote'] & { messageFeedback: MessageFeedbackRemote }
}
