/**
 * Deliverables plugin, browser half: registers the produced-files row into
 * the chat view's turn-tail chain, and provides the `chatFileMentions`
 * service that links inline-code mentions of produced files in the closing
 * prose. All policy lives here — the derivation from the mutation tools'
 * `locations`, the mention matching, the bounded file cards, and the copy — so
 * composing this plugin out of cordis.yml removes both surfaces entirely;
 * the owning view renders an empty chain and inert prose at zero cost.
 */
import { resolveWorkspacePath } from '../client-runtime/workspaces/path'
import type { ClientContext } from '../views-types'
import type { ChatFileMentions } from '../views-types'
import { ProducedFiles } from './ProducedFiles'
import {FileInspectionCache} from '../shared/file-inspection'
import { en, NS, zh, type DeliverablesKey } from './locales'
import {
  deliverablesDefinition, producedFileMentions, selectProducedFiles,
} from './turn-deliverables'



export { ProducedFiles, type ProducedFilesProps } from './ProducedFiles'
export { producedForClosing } from './turn-deliverables'

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'conversationEvents', 'connection', 'sessions']

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection')
  const sessions = ctx.get('sessions')
  const inspections=new FileInspectionCache(connection.rpc)
  ctx.conversationEvents.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: selectProducedFiles,
      locale: NS,
      inject: (sessionId: string) => {
        const resolveFilePath=(path:string):string=>{
          const row=sessions.list.getSnapshot().byId[sessionId]
          const cwd=typeof row==='object'&&row!==null&&'cwd' in row&&typeof row.cwd==='string'?row.cwd:undefined
          return resolveWorkspacePath(cwd,path)
        }
        return ({
        resolveFilePath,
        inspectFile:(path:string,revision:number,thumbnail:boolean,signal:AbortSignal)=>inspections.read(sessionId,path,revision,thumbnail,signal),
        isLoopback: connection.isLoopback,
        hooks: { hostDescription: connection.hostDescription },
        openNativeFile: async (path: string, mode: 'open' | 'reveal'): Promise<void> => {
          const capability = connection.hostDescription.getSnapshot()
          if (!connection.isLoopback || capability?.canOpenPath !== true
            || (mode === 'reveal' && capability.canRevealPath !== true)) {
            throw new Error('Native file opening is unavailable on this connection')
          }
          const row = sessions.list.getSnapshot().byId[sessionId]
          const cwd = typeof row === 'object' && row !== null && 'cwd' in row
            && typeof row.cwd === 'string' ? row.cwd : undefined
          const resolved = resolveWorkspacePath(cwd, path)
          if (!(resolved.startsWith('/') || /^[a-z]:[\\/]/i.test(resolved) || resolved.startsWith('\\\\')) || resolved.includes('\0')) {
            throw new Error('Native file opening requires a resolved absolute path')
          }
          const reply = await connection.api.host.openPath({path: resolved, ...(mode === 'reveal' ? {mode} : {})})
          if (!reply.result.ok) throw new Error(reply.result.error.message)
        },
      })},
    }, ProducedFiles),
  )
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const t = ctx.locale.bind(NS)
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      // Same claim test the turn-tail chain entry runs: no produced files,
      // no vocabulary — the two surfaces agree by construction.
      const paths = selectProducedFiles(owner)
      if (paths === null) return undefined
      return producedFileMentions(paths, owner.openFile, path => t('produced.open', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}
