/**
 * DeepSeek search preferences plus a write-only key. The switch uses settings;
 * only the key uses the credentials domain, so its literal never rides a response.
 */

import type { PropsLocale } from '../views-types'
import type {Selector} from './contracts'
import type {CardActions} from './card-form'
import { BooleanField, SecretField } from './fields'
import { PluginCard } from './PluginCard'
import type { WebSearchCardState } from './web-search-card-controller'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsLocale<'settings.plugins'> & CardActions & {useWebSearchCard: Selector<WebSearchCardState>}

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id="plugin-config-web-search-key"
        label={t('webSearchApiKey')}
        hint={t('webSearchApiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <BooleanField
        id="plugin-config-web-search-enabled"
        label={t('webSearchEnabled')}
        hint={t('webSearchEnabledHint')}
        disabled={disabled}
        text={state.enabled.text}
        onEdit={text => { props.edit('enabled', text) }}
      />
    </PluginCard>
  )
}
