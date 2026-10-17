// Generated from src/modules/api-remotes/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-api-remotes",
factory: (__externalRequire) => {
const __units = {
"src/modules/api-remotes/index.js": function(module, exports, require) {
// source: src/modules/api-remotes/index.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const commands_1 = __importDefault(require("./commands"));
const goals_1 = __importDefault(require("./goals"));
const dynamic_1 = __importDefault(require("./dynamic"));
const file_references_1 = __importDefault(require("./file-references"));
const plugin_inventory_1 = __importDefault(require("./plugin-inventory"));
const message_feedback_1 = __importDefault(require("./message-feedback"));
const session_references_1 = __importDefault(require("./session-references"));
/** Required service: the typed Client Remote contribution mount. */
exports.inject = ['remote'];
/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
async function apply(ctx) {
    const disposers = [];
    try {
        for (const contribution of [
            commands_1.default, goals_1.default, dynamic_1.default, file_references_1.default,
            plugin_inventory_1.default, message_feedback_1.default, session_references_1.default,
        ]) {
            disposers.push(await ctx.remote.$mount(contribution));
        }
    }
    catch (error) {
        for (const dispose of disposers.reverse())
            await dispose();
        throw error;
    }
    // Unwound in reverse mount order, so a namespace never outlives one mounted
    // after it.
    return async () => {
        for (const dispose of disposers.reverse())
            await dispose();
    };
}

},
"src/modules/api-remotes/commands.js": function(module, exports, require) {
// source: src/modules/api-remotes/commands.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed commands Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_commands_commands_execute_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_commands_commands_execute_parameter_1$schema = zod_1.z.string();
const _xharness_dsh_commands_commands_execute_parameter_2$schema = zod_1.z.array(zod_1.z.object({
    'mediaType': zod_1.z.union([zod_1.z.literal("image/png"), zod_1.z.literal("image/jpeg"), zod_1.z.literal("image/webp"), zod_1.z.literal("image/gif")]),
    'data': zod_1.z.string(),
    'name': zod_1.z.string().optional(),
}));
const _xharness_dsh_commands_commands_execute_result$schema = zod_1.z.union([zod_1.z.undefined(), zod_1.z.object({
        'commandId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
        'result': zod_1.z.union([zod_1.z.object({
                'kind': zod_1.z.literal("success").readonly(),
                'text': zod_1.z.string().readonly().optional(),
                'sourceEventSeq': zod_1.z.number().readonly().optional(),
            }), zod_1.z.object({
                'kind': zod_1.z.literal("error").readonly(),
                'text': zod_1.z.string().readonly(),
            })]).readonly(),
    })]);
const _xharness_dsh_commands_commands_list_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_commands_commands_list_result$schema = zod_1.z.array(zod_1.z.object({
    'name': zod_1.z.string().readonly(),
    'description': zod_1.z.string().readonly(),
    'input': zod_1.z.object({
        'hint': zod_1.z.string().readonly(),
        'images': zod_1.z.boolean().readonly().optional(),
    }).readonly().optional(),
}));
exports.TYPERT_REMOTE = {
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
            sourceLocation: { "file": "packages/interaction/commands/src/index.ts", "line": 329, "column": 9 },
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
            sourceLocation: { "file": "packages/interaction/commands/src/index.ts", "line": 285, "column": 3 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/goals.js": function(module, exports, require) {
// source: src/modules/api-remotes/goals.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed goals Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_goal_goals_clear_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_clear_parameter_1$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_clear_result$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_complete_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_complete_parameter_1$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_complete_result$schema = zod_1.z.object({
    'roundsStarted': zod_1.z.number().readonly(),
    'createdAt': zod_1.z.number().readonly(),
    'updatedAt': zod_1.z.number().readonly(),
    'activation': zod_1.z.union([zod_1.z.literal("armed"), zod_1.z.literal("disarmed")]).readonly(),
    'objective': zod_1.z.string().readonly(),
    'phase': zod_1.z.union([zod_1.z.literal("active"), zod_1.z.literal("paused"), zod_1.z.literal("blocked"), zod_1.z.literal("complete")]).readonly(),
    'blockedReason': zod_1.z.object({
        'code': zod_1.z.string().readonly(),
        'message': zod_1.z.string().readonly(),
    }).readonly().optional(),
    'maxGoalRounds': zod_1.z.number().readonly(),
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_create_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_create_parameter_1$schema = zod_1.z.object({
    'objective': zod_1.z.string().readonly(),
    'maxGoalRounds': zod_1.z.number().readonly().optional(),
});
const _xharness_dsh_goal_goals_create_result$schema = zod_1.z.object({
    'ref': zod_1.z.object({
        'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
        'revision': zod_1.z.number().readonly(),
    }).readonly(),
});
const _xharness_dsh_goal_goals_edit_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_edit_parameter_1$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_edit_parameter_2$schema = zod_1.z.object({
    'objective': zod_1.z.string().readonly().optional(),
    'maxGoalRounds': zod_1.z.number().readonly().optional(),
});
const _xharness_dsh_goal_goals_edit_result$schema = zod_1.z.object({
    'roundsStarted': zod_1.z.number().readonly(),
    'createdAt': zod_1.z.number().readonly(),
    'updatedAt': zod_1.z.number().readonly(),
    'activation': zod_1.z.union([zod_1.z.literal("armed"), zod_1.z.literal("disarmed")]).readonly(),
    'objective': zod_1.z.string().readonly(),
    'phase': zod_1.z.union([zod_1.z.literal("active"), zod_1.z.literal("paused"), zod_1.z.literal("blocked"), zod_1.z.literal("complete")]).readonly(),
    'blockedReason': zod_1.z.object({
        'code': zod_1.z.string().readonly(),
        'message': zod_1.z.string().readonly(),
    }).readonly().optional(),
    'maxGoalRounds': zod_1.z.number().readonly(),
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_pause_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_pause_parameter_1$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_pause_result$schema = zod_1.z.object({
    'roundsStarted': zod_1.z.number().readonly(),
    'createdAt': zod_1.z.number().readonly(),
    'updatedAt': zod_1.z.number().readonly(),
    'activation': zod_1.z.union([zod_1.z.literal("armed"), zod_1.z.literal("disarmed")]).readonly(),
    'objective': zod_1.z.string().readonly(),
    'phase': zod_1.z.union([zod_1.z.literal("active"), zod_1.z.literal("paused"), zod_1.z.literal("blocked"), zod_1.z.literal("complete")]).readonly(),
    'blockedReason': zod_1.z.object({
        'code': zod_1.z.string().readonly(),
        'message': zod_1.z.string().readonly(),
    }).readonly().optional(),
    'maxGoalRounds': zod_1.z.number().readonly(),
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_resume_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_goal_goals_resume_parameter_1$schema = zod_1.z.object({
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
const _xharness_dsh_goal_goals_resume_result$schema = zod_1.z.object({
    'roundsStarted': zod_1.z.number().readonly(),
    'createdAt': zod_1.z.number().readonly(),
    'updatedAt': zod_1.z.number().readonly(),
    'activation': zod_1.z.union([zod_1.z.literal("armed"), zod_1.z.literal("disarmed")]).readonly(),
    'objective': zod_1.z.string().readonly(),
    'phase': zod_1.z.union([zod_1.z.literal("active"), zod_1.z.literal("paused"), zod_1.z.literal("blocked"), zod_1.z.literal("complete")]).readonly(),
    'blockedReason': zod_1.z.object({
        'code': zod_1.z.string().readonly(),
        'message': zod_1.z.string().readonly(),
    }).readonly().optional(),
    'maxGoalRounds': zod_1.z.number().readonly(),
    'id': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'revision': zod_1.z.number().readonly(),
});
exports.TYPERT_REMOTE = {
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 377, "column": 3 },
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 337, "column": 3 },
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 586, "column": 3 },
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 277, "column": 3 },
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 299, "column": 3 },
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
            sourceLocation: { "file": "packages/goal/goal/src/index.ts", "line": 311, "column": 3 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/dynamic.js": function(module, exports, require) {
// source: src/modules/api-remotes/dynamic.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed dynamic Remote schema and invocation contribution. */
const zod_1 = require("zod");
const JsonValueRemoteCodec$schema = zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema))]);
const JsonValueRemoteCodec$schema2 = zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema2)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema2))]);
const JsonValueRemoteCodec$schema3 = zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema3)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema3))]);
const JsonValueRemoteCodec$schema4 = zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema4)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema4))]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_2$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_result$schema = zod_1.z.object({
    'code': zod_1.z.string(),
    'name': zod_1.z.string(),
    'pluginId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
});
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_inventory_result$schema = zod_1.z.array(zod_1.z.object({
    'pluginId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    'agentId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    'packages': zod_1.z.array(zod_1.z.object({
        'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'name': zod_1.z.string(),
        'purpose': zod_1.z.string(),
        'hasHostHalf': zod_1.z.boolean(),
        'hasClientHalf': zod_1.z.boolean(),
    })),
    'currentPackageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
    'nextPackageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
    'activeRun': zod_1.z.object({
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    }).optional(),
    'latestRun': zod_1.z.object({
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'mode': zod_1.z.union([zod_1.z.literal("run"), zod_1.z.literal("update")]),
        'status': zod_1.z.union([zod_1.z.literal("rejected"), zod_1.z.literal("awaiting-approval"), zod_1.z.literal("running"), zod_1.z.literal("cancelled"), zod_1.z.literal("starting-host"), zod_1.z.literal("client-pending"), zod_1.z.literal("waiting"), zod_1.z.literal("failed"), zod_1.z.literal("stopped")]),
        'approvalRequestId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
        'requiresApproval': zod_1.z.boolean().optional(),
        'host': zod_1.z.object({
            'status': zod_1.z.union([zod_1.z.literal("running"), zod_1.z.literal("waiting"), zod_1.z.literal("failed"), zod_1.z.literal("stopped"), zod_1.z.literal("absent"), zod_1.z.literal("pending")]),
            'waitingFor': zod_1.z.array(zod_1.z.string()),
            'error': zod_1.z.string().optional(),
        }),
        'client': zod_1.z.object({
            'status': zod_1.z.union([zod_1.z.literal("running"), zod_1.z.literal("waiting"), zod_1.z.literal("failed"), zod_1.z.literal("stopped"), zod_1.z.literal("absent"), zod_1.z.literal("pending")]),
            'waitingFor': zod_1.z.array(zod_1.z.string()),
            'error': zod_1.z.string().optional(),
        }),
        'error': zod_1.z.object({
            'phase': zod_1.z.union([zod_1.z.literal("approval"), zod_1.z.literal("host-load"), zod_1.z.literal("host-apply"), zod_1.z.literal("client-load"), zod_1.z.literal("client-apply"), zod_1.z.literal("client-render")]),
            'message': zod_1.z.string(),
            'stack': zod_1.z.string().optional(),
            'pluginId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
            'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
            'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        }).optional(),
    }).optional(),
}));
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_2$schema = zod_1.z.string();
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_3$schema = zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema3)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema3))]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'value': zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema4)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema4))]),
    }), zod_1.z.intersection(zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'code': zod_1.z.union([zod_1.z.literal("plugin-not-running"), zod_1.z.literal("stale-run"), zod_1.z.literal("method-not-found"), zod_1.z.literal("handler-error")]),
    }), zod_1.z.object({
        'message': zod_1.z.string(),
        'stack': zod_1.z.string().optional(),
    }))]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_2$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_3$schema = zod_1.z.object({
    'message': zod_1.z.string(),
    'stack': zod_1.z.string().optional(),
});
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_result$schema = zod_1.z.literal(null);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_2$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_3$schema = zod_1.z.object({
    'slot': zod_1.z.string(),
    'message': zod_1.z.string(),
    'stack': zod_1.z.string().optional(),
    'abdicated': zod_1.z.boolean(),
});
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_result$schema = zod_1.z.literal(null);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_2$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'data': zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema2)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema2))]),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.union([zod_1.z.literal("cancelled"), zod_1.z.literal("provider-missing"), zod_1.z.literal("method-missing"), zod_1.z.literal("invalid-input"), zod_1.z.literal("provider-error")]),
        'message': zod_1.z.string(),
    })]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_result$schema = zod_1.z.object({
    'accepted': zod_1.z.boolean(),
});
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_parameter_1$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'waitingFor': zod_1.z.array(zod_1.z.string()).optional(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.union([zod_1.z.literal("rejected"), zod_1.z.literal("host-half-failed"), zod_1.z.literal("client-half-failed")]),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
        'startedHere': zod_1.z.boolean().optional(),
        'message': zod_1.z.string().optional(),
        'stack': zod_1.z.string().optional(),
    })]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_result$schema = zod_1.z.object({
    'accepted': zod_1.z.boolean(),
});
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_2$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_3$schema = zod_1.z.union([zod_1.z.literal("run"), zod_1.z.literal("update")]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_4$schema = zod_1.z.union([zod_1.z.literal(null), zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown())]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_5$schema = zod_1.z.boolean();
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'pluginId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'waitingFor': zod_1.z.array(zod_1.z.string()),
        'startedHere': zod_1.z.boolean(),
    }), zod_1.z.intersection(zod_1.z.object({
        'ok': zod_1.z.literal(false),
    }), zod_1.z.object({
        'message': zod_1.z.string(),
        'stack': zod_1.z.string().optional(),
    }))]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_2$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'waitingFor': zod_1.z.array(zod_1.z.string()).optional(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.union([zod_1.z.literal("rejected"), zod_1.z.literal("host-half-failed"), zod_1.z.literal("client-half-failed")]),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
        'startedHere': zod_1.z.boolean().optional(),
        'message': zod_1.z.string().optional(),
        'stack': zod_1.z.string().optional(),
    })]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'status': zod_1.z.union([zod_1.z.literal("awaiting-approval"), zod_1.z.literal("starting"), zod_1.z.literal("running")]),
        'pluginId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'packageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'pluginRunId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
        'waitingFor': zod_1.z.array(zod_1.z.string()),
        'clientWaitingFor': zod_1.z.array(zod_1.z.string()).optional(),
        'currentPackageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
        'nextPackageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).optional(),
        'mode': zod_1.z.union([zod_1.z.literal("run"), zod_1.z.literal("update")]),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.union([zod_1.z.literal("plugin-missing"), zod_1.z.literal("rejected"), zod_1.z.literal("host-half-failed"), zod_1.z.literal("client-half-failed"), zod_1.z.literal("package-missing"), zod_1.z.literal("invalid-mode"), zod_1.z.literal("transition-in-flight"), zod_1.z.literal("cancelled"), zod_1.z.literal("not-running")]),
        'message': zod_1.z.string(),
        'stack': zod_1.z.string().optional(),
    })]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.union([zod_1.z.literal("plugin-missing"), zod_1.z.literal("not-running")]),
        'message': zod_1.z.string(),
    })]);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_syncInspectManifest_parameter_0$schema = zod_1.z.array(zod_1.z.object({
    'id': zod_1.z.string(),
    'description': zod_1.z.string(),
    'methods': zod_1.z.array(zod_1.z.object({
        'name': zod_1.z.string(),
        'description': zod_1.z.string(),
        'inputSchema': zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema))]),
        'outputSchema': zod_1.z.union([zod_1.z.literal(null), zod_1.z.string(), zod_1.z.number(), zod_1.z.literal(false), zod_1.z.literal(true), zod_1.z.array(zod_1.z.lazy(() => JsonValueRemoteCodec$schema)), zod_1.z.record(zod_1.z.string(), zod_1.z.lazy(() => JsonValueRemoteCodec$schema))]),
    })),
}));
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_syncInspectManifest_result$schema = zod_1.z.literal(null);
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_parameter_1$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true),
        'wasRunning': zod_1.z.boolean(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false),
        'reason': zod_1.z.literal("plugin-missing"),
        'message': zod_1.z.string(),
    })]);
exports.TYPERT_REMOTE = {
    package: '@xharness/dsh-cordis-host-runner',
    descriptors: [
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/getClientCode',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'getClientCode',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_1$schema,
                    },
                },
                {
                    name: 'pluginRunId',
                    wire: 'pluginRunId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginRunId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_parameter_2$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisClientSource',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_getClientCode_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 384, "column": 3 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/inventory',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'inventory',
            invocation: { kind: 'direct' },
            parameters: [],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/inventory:result',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_inventory_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 525, "column": 3 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/invoke',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'invoke',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginRunId',
                    wire: 'pluginRunId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginRunId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_1$schema,
                    },
                },
                {
                    name: 'method',
                    wire: 'method',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/invoke:method',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_2$schema,
                    },
                },
                {
                    name: 'args',
                    wire: 'args',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-session/types#JsonValue',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_parameter_3$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisInvokeResult',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_invoke_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 741, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/reportClientGuardFailure',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'reportClientGuardFailure',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_1$schema,
                    },
                },
                {
                    name: 'pluginRunId',
                    wire: 'pluginRunId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginRunId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_2$schema,
                    },
                },
                {
                    name: 'failure',
                    wire: 'failure',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisErrorDetails',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_parameter_3$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/reportClientGuardFailure:result',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportClientGuardFailure_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 718, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/reportRenderFailure',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'reportRenderFailure',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_1$schema,
                    },
                },
                {
                    name: 'pluginRunId',
                    wire: 'pluginRunId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginRunId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_2$schema,
                    },
                },
                {
                    name: 'failure',
                    wire: 'failure',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisRenderFailure',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_parameter_3$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/reportRenderFailure:result',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_reportRenderFailure_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 684, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/resolveInspectQuery',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'resolveInspectQuery',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_0$schema,
                    },
                },
                {
                    name: 'requestId',
                    wire: 'requestId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisInspectRequestId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_1$schema,
                    },
                },
                {
                    name: 'resolution',
                    wire: 'resolution',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisInspectQueryResolution',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_parameter_2$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisInspectResolveAck',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveInspectQuery_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 511, "column": 3 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/resolveRequestRun',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'resolveRequestRun',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'requestId',
                    wire: 'requestId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#ApprovalRequestId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_parameter_0$schema,
                    },
                },
                {
                    name: 'resolution',
                    wire: 'resolution',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisRunResolution',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_parameter_1$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisResolveAck',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_resolveRequestRun_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 413, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/runHostHalf',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'runHostHalf',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_1$schema,
                    },
                },
                {
                    name: 'packageId',
                    wire: 'packageId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPackageId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_2$schema,
                    },
                },
                {
                    name: 'mode',
                    wire: 'mode',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicRunMode',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_3$schema,
                    },
                },
                {
                    name: 'requestId',
                    wire: 'requestId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/runHostHalf:requestId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_4$schema,
                    },
                },
                {
                    name: 'approveFutureVersions',
                    wire: 'approveFutureVersions',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/runHostHalf:approveFutureVersions',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_parameter_5$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisHostHalfResult',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_runHostHalf_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 325, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/settleUserRun',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'settleUserRun',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_1$schema,
                    },
                },
                {
                    name: 'resolution',
                    wire: 'resolution',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisRunResolution',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_parameter_2$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisRunResponse',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_settleUserRun_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 438, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/stopFromPanel',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'stopFromPanel',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_parameter_1$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisStopResponse',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_stopFromPanel_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 480, "column": 9 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/syncInspectManifest',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'syncInspectManifest',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'providers',
                    wire: 'providers',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/syncInspectManifest:providers',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_syncInspectManifest_parameter_0$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/syncInspectManifest:result',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_syncInspectManifest_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 498, "column": 3 },
        },
        {
            id: '@xharness/dsh-cordis-host-runner#dynamicCordisRunner/undefineFromPanel',
            service: 'dynamicCordisRunner',
            namespace: 'dynamicCordisRunner',
            method: 'undefineFromPanel',
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
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_parameter_0$schema,
                    },
                },
                {
                    name: 'pluginId',
                    wire: 'pluginId',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-cordis-host-runner/types#CordisDynamicPluginId',
                        schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_parameter_1$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-cordis-host-runner/types#DynamicCordisUndefineReceipt',
                schema: _xharness_dsh_cordis_host_runner_dynamicCordisRunner_undefineFromPanel_result$schema,
            },
            sourceLocation: { "file": "packages/extensions/cordis-host-runner/src/index.ts", "line": 227, "column": 9 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/file-references.js": function(module, exports, require) {
// source: src/modules/api-remotes/file-references.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed file-references Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_file_reference_fileReferences_list_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_file_reference_fileReferences_list_parameter_1$schema = zod_1.z.string();
const _xharness_dsh_file_reference_fileReferences_list_result$schema = zod_1.z.array(zod_1.z.object({
    'path': zod_1.z.string(),
    'kind': zod_1.z.union([zod_1.z.literal("file"), zod_1.z.literal("directory")]),
}));
exports.TYPERT_REMOTE = {
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
            sourceLocation: { "file": "packages/context/file-reference/src/index.ts", "line": 54, "column": 3 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/plugin-inventory.js": function(module, exports, require) {
// source: src/modules/api-remotes/plugin-inventory.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed plugin-inventory Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_host_plugin_inventory_pluginInventory_list_result$schema = zod_1.z.object({
    'entries': zod_1.z.array(zod_1.z.object({
        'entryId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
        'moduleName': zod_1.z.string().readonly(),
        'enabled': zod_1.z.boolean().readonly(),
        'fiberPhase': zod_1.z.union([zod_1.z.literal(null), zod_1.z.literal("failed"), zod_1.z.literal("pending"), zod_1.z.literal("active"), zod_1.z.literal("loading"), zod_1.z.literal("unloading")]).readonly(),
    })).readonly(),
});
exports.TYPERT_REMOTE = {
    package: '@xharness/dsh-host-plugin-inventory',
    descriptors: [
        {
            id: '@xharness/dsh-host-plugin-inventory#pluginInventory/list',
            service: 'pluginInventory',
            namespace: 'pluginInventory',
            method: 'list',
            invocation: { kind: 'direct' },
            parameters: [],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-host-plugin-inventory/types#PluginInventorySnapshot',
                schema: _xharness_dsh_host_plugin_inventory_pluginInventory_list_result$schema,
            },
            sourceLocation: { "file": "packages/host/plugin-inventory/src/index.ts", "line": 57, "column": 3 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/message-feedback.js": function(module, exports, require) {
// source: src/modules/api-remotes/message-feedback.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed message-feedback Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_message_feedback_messageFeedback_delete_parameter_0$schema = zod_1.z.object({
    'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'ifVersion': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
});
const _xharness_dsh_message_feedback_messageFeedback_delete_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true).readonly(),
        'value': zod_1.z.object({
            'absent': zod_1.z.literal(true).readonly(),
        }).readonly(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false).readonly(),
        'error': zod_1.z.union([zod_1.z.object({
                'code': zod_1.z.literal("session-not-found").readonly(),
                'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
            }), zod_1.z.object({
                'code': zod_1.z.literal("version-conflict").readonly(),
                'current': zod_1.z.union([zod_1.z.literal(null), zod_1.z.object({
                        'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                        'rating': zod_1.z.union([zod_1.z.literal("positive"), zod_1.z.literal("negative")]).readonly(),
                        'note': zod_1.z.string().readonly().optional(),
                        'version': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                        'createdAt': zod_1.z.number().readonly(),
                        'updatedAt': zod_1.z.number().readonly(),
                    })]).readonly(),
            })]).readonly(),
    })]);
const _xharness_dsh_message_feedback_messageFeedback_list_parameter_0$schema = zod_1.z.object({
    'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
});
const _xharness_dsh_message_feedback_messageFeedback_list_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true).readonly(),
        'value': zod_1.z.object({
            'items': zod_1.z.array(zod_1.z.object({
                'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                'rating': zod_1.z.union([zod_1.z.literal("positive"), zod_1.z.literal("negative")]).readonly(),
                'note': zod_1.z.string().readonly().optional(),
                'version': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                'createdAt': zod_1.z.number().readonly(),
                'updatedAt': zod_1.z.number().readonly(),
            })).readonly(),
        }).readonly(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false).readonly(),
        'error': zod_1.z.object({
            'code': zod_1.z.literal("session-not-found").readonly(),
            'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
        }).readonly(),
    })]);
const _xharness_dsh_message_feedback_messageFeedback_put_parameter_0$schema = zod_1.z.object({
    'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
    'rating': zod_1.z.union([zod_1.z.literal("positive"), zod_1.z.literal("negative")]).readonly(),
    'note': zod_1.z.string().readonly().optional(),
    'ifVersion': zod_1.z.union([zod_1.z.literal(null), zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown())]).readonly(),
});
const _xharness_dsh_message_feedback_messageFeedback_put_result$schema = zod_1.z.union([zod_1.z.object({
        'ok': zod_1.z.literal(true).readonly(),
        'value': zod_1.z.object({
            'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
            'rating': zod_1.z.union([zod_1.z.literal("positive"), zod_1.z.literal("negative")]).readonly(),
            'note': zod_1.z.string().readonly().optional(),
            'version': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
            'createdAt': zod_1.z.number().readonly(),
            'updatedAt': zod_1.z.number().readonly(),
        }).readonly(),
    }), zod_1.z.object({
        'ok': zod_1.z.literal(false).readonly(),
        'error': zod_1.z.union([zod_1.z.object({
                'code': zod_1.z.literal("session-not-found").readonly(),
                'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
            }), zod_1.z.object({
                'code': zod_1.z.literal("target-not-found").readonly(),
                'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
            }), zod_1.z.object({
                'code': zod_1.z.literal("version-conflict").readonly(),
                'current': zod_1.z.union([zod_1.z.literal(null), zod_1.z.object({
                        'messageId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                        'rating': zod_1.z.union([zod_1.z.literal("positive"), zod_1.z.literal("negative")]).readonly(),
                        'note': zod_1.z.string().readonly().optional(),
                        'version': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()).readonly(),
                        'createdAt': zod_1.z.number().readonly(),
                        'updatedAt': zod_1.z.number().readonly(),
                    })]).readonly(),
            }), zod_1.z.object({
                'code': zod_1.z.literal("note-blank").readonly(),
            }), zod_1.z.object({
                'code': zod_1.z.literal("note-too-large").readonly(),
                'maxBytes': zod_1.z.number().readonly(),
                'actualBytes': zod_1.z.number().readonly(),
            })]).readonly(),
    })]);
exports.TYPERT_REMOTE = {
    package: '@xharness/dsh-message-feedback',
    descriptors: [
        {
            id: '@xharness/dsh-message-feedback#messageFeedback/delete',
            service: 'messageFeedback',
            namespace: 'messageFeedback',
            method: 'delete',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'request',
                    wire: 'request',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackDeleteRequest',
                        schema: _xharness_dsh_message_feedback_messageFeedback_delete_parameter_0$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackDeleteResult',
                schema: _xharness_dsh_message_feedback_messageFeedback_delete_result$schema,
            },
            sourceLocation: { "file": "packages/feedback/message-feedback/src/index.ts", "line": 272, "column": 3 },
        },
        {
            id: '@xharness/dsh-message-feedback#messageFeedback/list',
            service: 'messageFeedback',
            namespace: 'messageFeedback',
            method: 'list',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'request',
                    wire: 'request',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackListRequest',
                        schema: _xharness_dsh_message_feedback_messageFeedback_list_parameter_0$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackListResult',
                schema: _xharness_dsh_message_feedback_messageFeedback_list_result$schema,
            },
            sourceLocation: { "file": "packages/feedback/message-feedback/src/index.ts", "line": 190, "column": 9 },
        },
        {
            id: '@xharness/dsh-message-feedback#messageFeedback/put',
            service: 'messageFeedback',
            namespace: 'messageFeedback',
            method: 'put',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'request',
                    wire: 'request',
                    source: 'json',
                    codec: {
                        mode: 'strict',
                        typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackPutRequest',
                        schema: _xharness_dsh_message_feedback_messageFeedback_put_parameter_0$schema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: '@xharness/dsh-message-feedback/types#MessageFeedbackPutResult',
                schema: _xharness_dsh_message_feedback_messageFeedback_put_result$schema,
            },
            sourceLocation: { "file": "packages/feedback/message-feedback/src/index.ts", "line": 206, "column": 3 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

},
"src/modules/api-remotes/session-references.js": function(module, exports, require) {
// source: src/modules/api-remotes/session-references.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPERT_REMOTE = void 0;
/** Source-owned typed session-references Remote schema and invocation contribution. */
const zod_1 = require("zod");
const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_0$schema = zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown());
const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_parameter_1$schema = zod_1.z.string();
const _xharness_dsh_session_reference_sessionReferenceResolver_candidates_result$schema = zod_1.z.array(zod_1.z.object({
    'mention': zod_1.z.string(),
    'sessionId': zod_1.z.intersection(zod_1.z.string(), zod_1.z.unknown()),
    'label': zod_1.z.string(),
    'cwd': zod_1.z.string().optional(),
    'createdAt': zod_1.z.number(),
}));
exports.TYPERT_REMOTE = {
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
            sourceLocation: { "file": "packages/context/session-reference/src/index.ts", "line": 218, "column": 9 },
        },
    ],
};
exports.default = exports.TYPERT_REMOTE;

}
};
const __dependencies = {"src/modules/api-remotes/index.js":{"./commands":"src/modules/api-remotes/commands.js","./goals":"src/modules/api-remotes/goals.js","./dynamic":"src/modules/api-remotes/dynamic.js","./file-references":"src/modules/api-remotes/file-references.js","./plugin-inventory":"src/modules/api-remotes/plugin-inventory.js","./message-feedback":"src/modules/api-remotes/message-feedback.js","./session-references":"src/modules/api-remotes/session-references.js"},"src/modules/api-remotes/commands.js":{},"src/modules/api-remotes/goals.js":{},"src/modules/api-remotes/dynamic.js":{},"src/modules/api-remotes/file-references.js":{},"src/modules/api-remotes/plugin-inventory.js":{},"src/modules/api-remotes/message-feedback.js":{},"src/modules/api-remotes/session-references.js":{}};
const __cache = Object.create(null);
const __load = id => {
  if (__cache[id]) return __cache[id].exports;
  const unit = __units[id];
  if (!unit) throw Error('Unknown local UI module: ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  try {
    unit(module, module.exports, request => Object.prototype.hasOwnProperty.call(__dependencies[id], request)
      ? __load(__dependencies[id][request]) : __externalRequire(request));
  } catch (error) { delete __cache[id]; throw error; }
  return module.exports;
};
return __load("src/modules/api-remotes/index.js");
}
});
