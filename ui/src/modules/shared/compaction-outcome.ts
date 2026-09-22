import { z } from 'zod'

/** Additive durable terminal outcome. Absence retains legacy error semantics. */
export const CompactionEndOutcomeSchema = z.enum(['applied', 'no_benefit', 'no_eligible_source', 'interrupted', 'failed'])
export type CompactionEndOutcome = z.infer<typeof CompactionEndOutcomeSchema>
export type CompactionTerminalPhase = 'succeeded' | 'skipped' | 'cancelled' | 'failed'

export function isCompactionEndOutcome(value: unknown): value is CompactionEndOutcome {
  return CompactionEndOutcomeSchema.safeParse(value).success
}

export function compactionTerminalPhase(outcome: CompactionEndOutcome | undefined, error: string | null | undefined): CompactionTerminalPhase {
  switch (outcome) {
    case 'applied': return 'succeeded'
    case 'no_benefit':
    case 'no_eligible_source': return 'skipped'
    case 'interrupted': return 'cancelled'
    case 'failed': return 'failed'
    case undefined: return error == null ? 'succeeded' : 'failed'
  }
}

/** Validate explicit outcome/error consistency; legacy payloads remain accepted. */
export function validCompactionTerminalData(value: { outcome?: CompactionEndOutcome | undefined; error?: string | null | undefined }): boolean {
  switch (value.outcome) {
    case 'applied':
    case 'no_benefit':
    case 'no_eligible_source': return value.error == null
    case 'interrupted':
    case 'failed': return typeof value.error === 'string' && value.error.trim() !== ''
    case undefined: return true
  }
}
