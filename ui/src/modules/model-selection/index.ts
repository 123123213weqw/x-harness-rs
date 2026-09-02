/// <reference path="./external.d.ts" />
import { ModelDirectoryResolver } from './service'
import { XHarnessModelSelect } from './ModelSelect'
import { zh, en } from './locales'
import type { ModelClientContext, ModelDirectoryState, ModelSelection, PopupOption, SessionModelsResponse } from './contracts'
import type { Translation } from '../shared/runtime-types'
export { ModelDirectory } from './directory'
export { ModelDirectoryResolver } from './service'
export { XHarnessModelSelect } from './ModelSelect'
export { xhModelInfo, xhContextSelection, xhReasoningStatus } from './ContextPane'

import { OPEN_SETTINGS_SECTION } from '../shared/settings-navigation'
const NS = 'model'
function rowId(provider: string, model: string): string { return `${provider}/${model}` }
function optionsOf(directory: SessionModelsResponse, t: Translation): PopupOption[] {
  const rows: PopupOption[] = []
  for (const group of directory.groups) for (const model of group.models) rows.push({
    id: rowId(group.id, model.id), label: model.name,
    detail: model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
    ...(directory.current.provider === group.id && directory.current.model === model.id ? { active: true } : {}),
  })
  for (const failure of directory.failures) rows.push({ id: `failure/${failure.id}`, label: failure.name, detail: t('option.loadError', { message: failure.message }) })
  return rows
}
function selectionOf(state: ModelDirectoryState, id: string): ModelSelection | undefined {
  for (const group of state.groups) for (const model of group.models) {
    if (rowId(group.id, model.id) !== id) continue
    const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort
    return { provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }
  return undefined
}
export const inject = ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote']
export function apply(ctx: ModelClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-selection: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.plugin(ModelDirectoryResolver, { blockReason: () => t('blocked.composer') })
  ctx.inject(['commandUi', 'modelDirectories'], scope => {
    const command = scope.get('commandUi'), models = scope.modelDirectories, sessions = scope.sessions
    scope.effect(() => command.register({
      name: 'model', description: t('command.description'), available: session => sessions.subagentAddress(session.sessionId) === undefined,
      ui: { kind: 'popupSelect', options: async session => {
        if (sessions.subagentAddress(session.sessionId) !== undefined) throw new Error('model selection is unavailable for addressed subagent sessions')
        return optionsOf(await models.directoryFor(session.sessionId).load(), t)
      }, onSelect: async (option, session) => {
        if (sessions.subagentAddress(session.sessionId) !== undefined) throw new Error('model selection is unavailable for addressed subagent sessions')
        const directory = models.directoryFor(session.sessionId)
        const selection = selectionOf(directory.store.getSnapshot(), option.id)
        if (selection === undefined) throw new Error("this provider's catalog failed to load — pick a model from a loaded group")
        await directory.select(selection)
      } },
    }), 'ui-model-selection: /model contribution')
  })
  ctx.inject(['slots', 'modelDirectories'], scope => {
    const models = scope.modelDirectories, sessions = scope.sessions
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model', locale: NS, inject: (sessionId: string) => {
        const directory = models.directoryFor(sessionId), available = sessions.subagentAddress(sessionId) === undefined
        return { available, directory: directory.store, manageModels: () => { ctx.emit(OPEN_SETTINGS_SECTION, 'models') },
          load: (refreshCapabilities = false) => { if (available) return directory.load(refreshCapabilities).catch(() => {}) },
          select: (selection: ModelSelection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
        }
      },
    }, XHarnessModelSelect))
  })
}
