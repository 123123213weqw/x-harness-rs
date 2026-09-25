import type { RuntimeEnvironmentOwnerProps } from '../conversation/contract/slots'

/** No catalog/Gateway is installed yet. This is not a connection identity. */
export type EnvironmentPresentation = 'draft' | 'bound' | 'unknown'

/** Only a confirmed cold/open blank composer is eligible for a future pick. */
export function environmentPresentation(owner: Omit<RuntimeEnvironmentOwnerProps, 'appearance'>): EnvironmentPresentation {
  if (owner.sessionId === undefined) return 'draft'
  if (owner.summaryBlank === true && owner.composerPhase === 'blank'
    && (owner.openState === 'cold' || owner.openState === 'open')) return 'draft'
  if (owner.openState === 'open' && owner.composerPhase === 'active') return 'bound'
  return 'unknown'
}

/** Fail closed even if a disabled menu dispatches a forged/obsolete item ID. */
export function canAcknowledgeLocalPick(presentation: EnvironmentPresentation, id: string): boolean {
  return presentation === 'draft' && id === 'local'
}
