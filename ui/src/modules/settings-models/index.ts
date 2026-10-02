/// <reference path="./external.d.ts" />
import { ModelsSection } from './ModelsSection'
import type { ModelsSectionInjected } from './ModelsSection'
import { ModelsSettingsStore } from './store'
import { createSettingsSchemaOperations } from './schema-operations'
import { decodeWelcomeSection, WelcomeNoticeStore } from './welcome-store'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from './onboarding-copy'
import { en, zh } from './locales'
import type { ModelsClientContext } from './contracts'
const NS = 'settings.models'
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema']
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}
export function apply(ctx: ModelsClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-models: copy dictionaries')
  const connection = ctx.get('connection'), schema = createSettingsSchemaOperations(ctx.settingsSchema)
  const controller = new ModelsSettingsStore(connection.api, schema, ctx.settingsScope.describe())
  const t = ctx.locale.bind(NS)
  const injected = (): ModelsSectionInjected => ({ controller, hooks: { snapshot: controller.store }, api: connection.api, schema, t })
  // Retain the current bound scope's lifecycle, but do not reinstall removed
  // vendor welcome/onboarding dialogs during this source migration.
  const welcomeController = new WelcomeNoticeStore(ctx.settingsScope.bind({ namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: decodeWelcomeSection }))
  ctx.effect(() => {
    const refreshModels = () => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refreshModels), ctx.remote.$on('credentials/updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels), ctx.on('connection/reset', refreshModels),
    ]
    return () => { welcomeController.dispose(); for (const dispose of disposers) dispose() }
  }, 'ui-settings-models: pushed invalidations')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'models', order: 10, label: () => t('nav'), inject: injected }, ModelsSection))
}
