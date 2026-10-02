import { memo } from 'react'
import { MessageText } from '@xharness/dsh-client-ui-primitives'
import type { PropsLocale } from '../views-types'
import type { GoalCommandInputData } from './goal-command-input'
import css from './GoalCommandInputView.styles'

type GoalCommandInputViewProps = { node: { data: GoalCommandInputData } } & PropsLocale<'goal'>

/** Right-aligned `/goal` input bubble without ordinary message actions. */
export const GoalCommandInputView = memo(function GoalCommandInputView({
  node, t,
}: GoalCommandInputViewProps) {
  const data: GoalCommandInputData = node.data
  return (
    <div
      className={css.row}
      data-command-input=""
      role="group"
      aria-label={t('commandInput.aria')}
    >
      <div className={css.stack}>
        <div className={css.bubble}>
          <MessageText text={data.text} />
        </div>
      </div>
    </div>
  )
})
