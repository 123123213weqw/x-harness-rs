/** The shell plugin's card: the limits every command the agent runs is bound by. */

import type { PropsLocale } from '../views-types'
import type {Selector} from './contracts'
import type {CardActions} from './card-form'
import { ValueField } from './fields'
import { PluginCard } from './PluginCard'
import type { BashCardState } from './bash-card-controller'

/** Props the renderer binds for the shell card. */
export type BashCardProps =
  PropsLocale<'settings.plugins'> & CardActions & {useBashCard: Selector<BashCardState>}

/**
 * Render the shell card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function BashCard(props: BashCardProps) {
  const { t } = props
  const state = props.useBashCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="bashTitle"
      descriptionKey="bashDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-bash-timeout"
        label={t('bashTimeoutMs')}
        hint={t('bashTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <ValueField
        id="plugin-config-bash-output"
        label={t('bashMaxOutputBytes')}
        hint={t('bashMaxOutputBytesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxOutputBytes}
        onEdit={(text) => { props.edit('maxOutputBytes', text) }}
        onReset={() => { props.resetField('maxOutputBytes') }}
      />
    </PluginCard>
  )
}
