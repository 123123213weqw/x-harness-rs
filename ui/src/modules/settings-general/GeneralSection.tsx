/** The General section: one column rendering feature-owned item contributions. */
import type {RenderSlots} from './contracts'
import css from './GeneralSection.styles'

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps =
  RenderSlots

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot }: GeneralSectionComponentProps) {
  return (
    <div className={css.section}>
      {renderSlot('settings.general.item', {})}
    </div>
  )
}
