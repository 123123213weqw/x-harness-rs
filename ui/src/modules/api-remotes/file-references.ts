/** Source-owned typed file-references Remote schema and invocation contribution. */
import { z } from 'zod'
import type { TypertRemoteContribution } from '../typert-registry/protocol'

const _xharness_dsh_file_reference_fileReferences_list_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_file_reference_fileReferences_list_parameter_1$schema = z.string()
const _xharness_dsh_file_reference_fileReferences_list_result$schema = z.array(z.object({
  'path': z.string(),
  'kind': z.union([z.literal("file"), z.literal("directory")]),
}))

export const TYPERT_REMOTE = {
  package: '@xharness/dsh-file-reference',
  descriptors: [
    {
      id: '@xharness/dsh-file-reference#fileReferences/list',
      service: 'fileReferences',
      namespace: 'fileReferences',
      method: 'list',
      implementation: 'remoteExportList',
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
            schema: _xharness_dsh_file_reference_fileReferences_list_parameter_0$schema,
          },
        },
        {
          name: 'query',
          wire: 'query',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-file-reference#fileReferences/list:query',
            schema: _xharness_dsh_file_reference_fileReferences_list_parameter_1$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-file-reference#fileReferences/list:result',
        schema: _xharness_dsh_file_reference_fileReferences_list_result$schema,
      },
      sourceLocation: {"file":"packages/context/file-reference/src/index.ts","line":54,"column":3},
    },
  ],
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
