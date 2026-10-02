/** Source-owned typed goals Remote schema and invocation contribution. */
import { z } from 'zod'
import type { TypertRemoteContribution } from '../typert-registry/protocol'

const _xharness_dsh_goal_goals_clear_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_clear_parameter_1$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_clear_result$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_complete_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_complete_parameter_1$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_complete_result$schema = z.object({
  'roundsStarted': z.number().readonly(),
  'createdAt': z.number().readonly(),
  'updatedAt': z.number().readonly(),
  'activation': z.union([z.literal("armed"), z.literal("disarmed")]).readonly(),
  'objective': z.string().readonly(),
  'phase': z.union([z.literal("active"), z.literal("paused"), z.literal("blocked"), z.literal("complete")]).readonly(),
  'blockedReason': z.object({
  'code': z.string().readonly(),
  'message': z.string().readonly(),
}).readonly().optional(),
  'maxGoalRounds': z.number().readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_create_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_create_parameter_1$schema = z.object({
  'objective': z.string().readonly(),
  'maxGoalRounds': z.number().readonly().optional(),
})
const _xharness_dsh_goal_goals_create_result$schema = z.object({
  'ref': z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
}).readonly(),
})
const _xharness_dsh_goal_goals_edit_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_edit_parameter_1$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_edit_parameter_2$schema = z.object({
  'objective': z.string().readonly().optional(),
  'maxGoalRounds': z.number().readonly().optional(),
})
const _xharness_dsh_goal_goals_edit_result$schema = z.object({
  'roundsStarted': z.number().readonly(),
  'createdAt': z.number().readonly(),
  'updatedAt': z.number().readonly(),
  'activation': z.union([z.literal("armed"), z.literal("disarmed")]).readonly(),
  'objective': z.string().readonly(),
  'phase': z.union([z.literal("active"), z.literal("paused"), z.literal("blocked"), z.literal("complete")]).readonly(),
  'blockedReason': z.object({
  'code': z.string().readonly(),
  'message': z.string().readonly(),
}).readonly().optional(),
  'maxGoalRounds': z.number().readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_pause_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_pause_parameter_1$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_pause_result$schema = z.object({
  'roundsStarted': z.number().readonly(),
  'createdAt': z.number().readonly(),
  'updatedAt': z.number().readonly(),
  'activation': z.union([z.literal("armed"), z.literal("disarmed")]).readonly(),
  'objective': z.string().readonly(),
  'phase': z.union([z.literal("active"), z.literal("paused"), z.literal("blocked"), z.literal("complete")]).readonly(),
  'blockedReason': z.object({
  'code': z.string().readonly(),
  'message': z.string().readonly(),
}).readonly().optional(),
  'maxGoalRounds': z.number().readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_resume_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _xharness_dsh_goal_goals_resume_parameter_1$schema = z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})
const _xharness_dsh_goal_goals_resume_result$schema = z.object({
  'roundsStarted': z.number().readonly(),
  'createdAt': z.number().readonly(),
  'updatedAt': z.number().readonly(),
  'activation': z.union([z.literal("armed"), z.literal("disarmed")]).readonly(),
  'objective': z.string().readonly(),
  'phase': z.union([z.literal("active"), z.literal("paused"), z.literal("blocked"), z.literal("complete")]).readonly(),
  'blockedReason': z.object({
  'code': z.string().readonly(),
  'message': z.string().readonly(),
}).readonly().optional(),
  'maxGoalRounds': z.number().readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
})

export const TYPERT_REMOTE = {
  package: '@xharness/dsh-goal',
  descriptors: [
    {
      id: '@xharness/dsh-goal#goals/clear',
      service: 'goals',
      namespace: 'goals',
      method: 'clear',
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
            schema: _xharness_dsh_goal_goals_clear_parameter_0$schema,
          },
        },
        {
          name: 'ref',
          wire: 'ref',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#GoalRef',
            schema: _xharness_dsh_goal_goals_clear_parameter_1$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#GoalRef',
        schema: _xharness_dsh_goal_goals_clear_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":377,"column":3},
    },
    {
      id: '@xharness/dsh-goal#goals/complete',
      service: 'goals',
      namespace: 'goals',
      method: 'complete',
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
            schema: _xharness_dsh_goal_goals_complete_parameter_0$schema,
          },
        },
        {
          name: 'ref',
          wire: 'ref',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#GoalRef',
            schema: _xharness_dsh_goal_goals_complete_parameter_1$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#GoalView',
        schema: _xharness_dsh_goal_goals_complete_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":337,"column":3},
    },
    {
      id: '@xharness/dsh-goal#goals/create',
      service: 'goals',
      namespace: 'goals',
      method: 'create',
      implementation: 'remoteExportCreate',
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
            schema: _xharness_dsh_goal_goals_create_parameter_0$schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#CreateGoalRequest',
            schema: _xharness_dsh_goal_goals_create_parameter_1$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#CreateGoalResult',
        schema: _xharness_dsh_goal_goals_create_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":586,"column":3},
    },
    {
      id: '@xharness/dsh-goal#goals/edit',
      service: 'goals',
      namespace: 'goals',
      method: 'edit',
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
            schema: _xharness_dsh_goal_goals_edit_parameter_0$schema,
          },
        },
        {
          name: 'ref',
          wire: 'ref',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#GoalRef',
            schema: _xharness_dsh_goal_goals_edit_parameter_1$schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#EditGoalRequest',
            schema: _xharness_dsh_goal_goals_edit_parameter_2$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#GoalView',
        schema: _xharness_dsh_goal_goals_edit_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":277,"column":3},
    },
    {
      id: '@xharness/dsh-goal#goals/pause',
      service: 'goals',
      namespace: 'goals',
      method: 'pause',
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
            schema: _xharness_dsh_goal_goals_pause_parameter_0$schema,
          },
        },
        {
          name: 'ref',
          wire: 'ref',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#GoalRef',
            schema: _xharness_dsh_goal_goals_pause_parameter_1$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#GoalView',
        schema: _xharness_dsh_goal_goals_pause_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":299,"column":3},
    },
    {
      id: '@xharness/dsh-goal#goals/resume',
      service: 'goals',
      namespace: 'goals',
      method: 'resume',
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
            schema: _xharness_dsh_goal_goals_resume_parameter_0$schema,
          },
        },
        {
          name: 'ref',
          wire: 'ref',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xharness/dsh-goal/client#GoalRef',
            schema: _xharness_dsh_goal_goals_resume_parameter_1$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xharness/dsh-goal/client#GoalView',
        schema: _xharness_dsh_goal_goals_resume_result$schema,
      },
      sourceLocation: {"file":"packages/goal/goal/src/index.ts","line":311,"column":3},
    },
  ],
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
