import type * as React from 'react'
import type { SessionLogDownloadController, SessionLogDownloadState } from './controller'
import type { SessionLogDownloadKey } from './locales'
export type SessionId = string
export interface ObservableSnapshot<T> {getSnapshot(): T; subscribe(listener: () => void): () => void}
export interface SnapshotStore<T> extends ObservableSnapshot<T> {update(edit: (draft: T) => void): void}
export interface SessionLogDownloadDialogProps {
  sessionId: SessionId
  useSessionLogDownload<T>(select: (state: SessionLogDownloadState) => T): T
  request(sessionId: SessionId): Promise<void>
  dismiss(sessionId: SessionId): void
  t(key: SessionLogDownloadKey): string
}
export interface LogExportContext {
  provide(name: 'sessionLogDownload', controller: SessionLogDownloadController): void
  effect(effect: () => (() => void) | (() => Promise<void>), label: string): unknown
  locale: {register(namespace: string, labels: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void}
  on(event: 'command/executed', listener: (sessionId: SessionId, commandName: string, result: {kind: string}) => void): unknown
  slots: {
    inject(name: 'conversation.session.header.utilities', install: () => void): void
    register(spec: {name: 'conversation.session.header.utilities'; id: string; locale: string; inject(): import('./Dialog').SessionLogDownloadDialogInjected}, component: React.ComponentType<SessionLogDownloadDialogProps>): void
  }
}
