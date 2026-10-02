/** Browser plugin owning Session export download state and its shared modal. */

import type { LogExportContext as ClientContext, SessionId } from './contracts'
import { SessionLogDownloadController } from './controller'
import type { SessionLogDownloadDialogInjected } from './Dialog'
import { SessionLogDownloadHeaderAction } from './HeaderAction'
import { en, NS, zh, type SessionLogDownloadKey } from './locales'

export type { SessionLogDownloadEntry, SessionLogDownloadState } from './controller'

export const inject = ['slots', 'locale']

/**
 * Provide the download controller and mount its modal into the Session Header.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionLogDownloadController()
  ctx.provide('sessionLogDownload', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-log-download: browser download lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-log-download: browser dictionaries')
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogDownloadDialogInjected => ({
      hooks: { sessionLogDownload: controller.store },
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
    }),
  }, SessionLogDownloadHeaderAction))
}

export type { SessionLogDownloadDialogInjected, SessionLogDownloadDialogProps } from './Dialog'
