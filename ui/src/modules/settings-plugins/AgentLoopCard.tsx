/** The agent loop's card: how many tool calls one step may run at once. */

import type { PropsLocale } from '../views-types'
import type {Selector} from './contracts'
import type {CardActions} from './card-form'
import { ValueField } from './fields'
import { PluginCard } from './PluginCard'
import type { AgentLoopCardState } from './agent-loop-card-controller'

/** Props the renderer binds for the agent-loop card. */
export type AgentLoopCardProps =
  PropsLocale<'settings.plugins'> & CardActions & {useAgentLoopCard: Selector<AgentLoopCardState>}

/**
 * Render the agent-loop card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AgentLoopCard(props: AgentLoopCardProps) {
  const { t } = props
  const state = props.useAgentLoopCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="agentLoopTitle"
      descriptionKey="agentLoopDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-agent-loop-parallel"
        label={t('agentLoopMaxParallel')}
        hint={t('agentLoopMaxParallelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.maxParallelToolCalls}
        onEdit={(text) => { props.edit('maxParallelToolCalls', text) }}
        onReset={() => { props.resetField('maxParallelToolCalls') }}
      />
    </PluginCard>
  )
}
