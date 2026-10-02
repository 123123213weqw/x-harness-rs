/** Source-owned typed session-references Remote schema and invocation contribution. */
import { z } from 'zod'
import type { TypertRemoteContribution } from '../typert-registry/protocol'

const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_1$schema = z.string()
const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_result$schema = z.array(z.object({
  'mention': z.string(),
  'sessionId': z.intersection(z.string(), z.unknown()),
  'label': z.string(),
  'cwd': z.string().optional(),
  'createdAt': z.number(),
}))

export const TYPERT_REMOTE = {
  package: '@xharness/dsh-session-reference',
  descriptors: [
    {
      id: '@xharness/dsh-session-reference#sessionReferenceResolver/candidates',
      service: 'sessionReferenceResolver',
      namespace: 'sessionReferenceResolver',
      method: 'candidates',
      implementation: 'remoteExportCandidates',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-session/types#SessionId',
            schema: _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_0$schema,
          },
        },
        {
          name: 'query',
          wire: 'query',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-session-reference#sessionReferenceResolver/candidates:query',
            schema: _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_1$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-session-reference#sessionReferenceResolver/candidates:result',
        schema: _xharness_dsh_session_reference_sessionReferenceResolver_candidates_result$schema,
      },
      sourceLocation: {"file":"packages/context/session-reference/src/index.ts","line":218,"column":9},
    },
  ],
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
