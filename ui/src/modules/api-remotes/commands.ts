/** Source-owned typed commands Remote schema and invocation contribution. */
import { z } from 'zod'
import type { TypertRemoteContribution } from '../typert-registry/protocol'

const _xharness_dsh_commands_commands_execute_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_commands_commands_execute_parameter_1$schema = z.string()
const _xharness_dsh_commands_commands_execute_parameter_2$schema = z.array(z.object({
  'mediaType': z.union([z.literal("image/png"), z.literal("image/jpeg"), z.literal("image/webp"), z.literal("image/gif")]),
  'data': z.string(),
  'name': z.string().optional(),
}))
const _xharness_dsh_commands_commands_execute_result$schema = z.union([z.undefined(), z.object({
  'commandId': z.intersection(z.string(), z.unknown()).readonly(),
  'result': z.union([z.object({
  'kind': z.literal("success").readonly(),
  'text': z.string().readonly().optional(),
  'sourceEventSeq': z.number().readonly().optional(),
}), z.object({
  'kind': z.literal("error").readonly(),
  'text': z.string().readonly(),
})]).readonly(),
})])
const _xharness_dsh_commands_commands_list_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_commands_commands_list_result$schema = z.array(z.object({
  'name': z.string().readonly(),
  'description': z.string().readonly(),
  'input': z.object({
  'hint': z.string().readonly(),
  'images': z.boolean().readonly().optional(),
}).readonly().optional(),
}))

export const TYPERT_REMOTE = {
  package: '@xharness/dsh-commands',
  descriptors: [
    {
      id: '@xharness/dsh-commands#commands/execute',
      service: 'commands',
      namespace: 'commands',
      method: 'execute',
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
            schema: _xharness_dsh_commands_commands_execute_parameter_0$schema,
          },
        },
        {
          name: 'line',
          wire: 'line',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-commands#commands/execute:line',
            schema: _xharness_dsh_commands_commands_execute_parameter_1$schema,
          },
        },
        {
          name: 'images',
          wire: 'images',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-commands#commands/execute:images',
            schema: _xharness_dsh_commands_commands_execute_parameter_2$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-commands#commands/execute:result',
        schema: _xharness_dsh_commands_commands_execute_result$schema,
      },
      sourceLocation: {"file":"packages/interaction/commands/src/index.ts","line":329,"column":9},
    },
    {
      id: '@xharness/dsh-commands#commands/list',
      service: 'commands',
      namespace: 'commands',
      method: 'list',
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
            schema: _xharness_dsh_commands_commands_list_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-commands#commands/list:result',
        schema: _xharness_dsh_commands_commands_list_result$schema,
      },
      sourceLocation: {"file":"packages/interaction/commands/src/index.ts","line":285,"column":3},
    },
  ],
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
