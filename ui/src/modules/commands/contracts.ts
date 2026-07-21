import type {SlotsService, Translation, ApiResult} from '../views-types'
import type {InputTriggerServiceContract} from '../input-trigger/contract'
import type {ConsumeTokenRequest, SubmitImageAttachment} from '../input-trigger/types'
import type {CommandUiRuntime} from './service'
export interface SnapshotStore<Value> {getSnapshot(): Value; subscribe(listener: () => void): () => void; set(value: Value): void; update(edit: (draft: Value) => void): void}
export interface CommandDescriptor {name: string; description: string; input?: {hint: string; images?: boolean}}
export type CommandResult = {kind: 'success'; text?: string} | {kind: 'error'; text: string}
export interface CommandSessions {scope(id: string): CommandContext | undefined; scopeOf(context: CommandContext): string | undefined; subagentAddress(id: string): unknown | undefined}
export interface CommandLocale {register(namespace: string, values: {zh: Readonly<Record<string,string>>; en: Readonly<Record<string,string>>}): () => void; bind(namespace: string): Translation}
/** The command contributor owns only dispatch, source registration and popup state. */
export interface CommandContext {
  effect(effect: () => void | (() => void), label: string): () => void
  slots: SlotsService
  locale: CommandLocale
  sessions: CommandSessions
  commandUi: CommandUiRuntime
  inputTriggers: InputTriggerServiceContract
  get(name: 'sessions'): CommandSessions | undefined
  get(name: 'locale'): CommandLocale | undefined
  get(name: 'inputTriggers'): InputTriggerServiceContract | undefined
  get(name: 'conversation'): {input: {for(context: CommandContext): {notify(level: 'info' | 'error', text: string): void}}} | undefined
  plugin(service: typeof CommandUiRuntime): void
  inject(names: readonly string[], callback: (scope: CommandContext) => void): void
  on(name: 'connection/reset', listener: () => void): () => void
  bail(subject: CommandContext, name: 'slash/input-consume-token', request: ConsumeTokenRequest): true | undefined
  remote: {
    $on(name: 'commands/change', listener: () => void): () => void
    $on(name: 'agent-preset/selected', listener: (sessionId: string) => void): () => void
    commands: {
      list(sessionId: string): Promise<ApiResult<readonly CommandDescriptor[]>>
      execute(sessionId: string, line: string, images: readonly SubmitImageAttachment[]): Promise<ApiResult<{result: CommandResult} | undefined>>
    }
  }
  events: {dispatch(mode: 'emit', args: readonly unknown[]): Array<(...args: unknown[]) => unknown>}
  logger: {warn(...args: readonly unknown[]): void}
}
