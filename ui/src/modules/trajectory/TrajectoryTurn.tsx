// TrajectoryTurn: sticky Turn header plus the padded Message/Step body.

import type { ReactNode } from 'react'
import { TrajectoryTurnHeader } from './TrajectoryTurnHeader'
import css from './TrajectoryTurn.styles'

export interface TrajectoryTurnProps {
  /** 1-based turn index for the sticky header. */
  turn: number
  /** Message / Step headers and TrajectoryCell rows. */
  children?: ReactNode
}

/**
 * Render one turn section (sticky header + body).
 * @param props - turn index and body children.
 * @returns the turn section element.
 */
export function TrajectoryTurn({ turn, children }: TrajectoryTurnProps) {
  return (
    <section className={css.root} data-turn={turn}>
      <TrajectoryTurnHeader turn={turn} />
      <div className={css.body}>{children}</div>
    </section>
  )
}
