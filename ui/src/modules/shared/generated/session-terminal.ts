// GENERATED from crates/xharness-projection/src/wire.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-session-terminal-contract.mjs.
import { z } from 'zod'

export const SESSION_TERMINAL_CONTRACT = "xharness-session-terminal-v1"
export const SESSION_TERMINAL_SCHEMA_SHA256 = "746b83b5db83d153180eb2c7b3dcc476302b2efc1346b496cb47edc1692cc2c9"

export type LegacyTurnEndReason = ({ readonly "kind": "aborted" } | { readonly "kind": "stop" } | { readonly "error"?: (LegacyTurnFailure | null) | undefined; readonly "failure"?: (LegacyTurnFailure | null) | undefined; readonly "kind": "error" })
export type LegacyTurnFailure = { readonly "code": string; readonly "details"?: (Readonly<Record<string, unknown>> | null) | undefined; readonly "message": string }
export type TurnEndData = { readonly "reason": TurnEndReasonWire; readonly "turn": number }
export type TurnEndDataInput = { readonly "reason": TurnEndReasonInput; readonly "turn": number }
export type TurnEndReasonInput = (TurnEndReasonWire | LegacyTurnEndReason)
export type TurnEndReasonWire = ({ readonly "kind": "completed" } | { readonly "kind": "max-tokens" } | { readonly "kind": "cancelled" } | { readonly "kind": "max-steps" } | { readonly "error": TurnFailure; readonly "kind": "error" })
export type TurnFailure = { readonly "code": string; readonly "message": string }

export const LegacyTurnEndReasonSchema: z.ZodType<LegacyTurnEndReason> = z.lazy(() => z.union([z.looseObject({"kind": z.literal("aborted")}), z.looseObject({"kind": z.literal("stop")}), z.looseObject({"error": z.union([LegacyTurnFailureSchema, z.null()]).optional(), "failure": z.union([LegacyTurnFailureSchema, z.null()]).optional(), "kind": z.literal("error")})]))
export const LegacyTurnFailureSchema: z.ZodType<LegacyTurnFailure> = z.lazy(() => z.looseObject({"code": z.string(), "details": z.union([z.record(z.string(), z.unknown()), z.null()]).optional(), "message": z.string()}))
export const TurnEndDataSchema: z.ZodType<TurnEndData> = z.lazy(() => z.looseObject({"reason": TurnEndReasonWireSchema, "turn": z.number().int().min(0).max(4294967295).min(0)}))
export const TurnEndDataInputSchema: z.ZodType<TurnEndDataInput> = z.lazy(() => z.looseObject({"reason": TurnEndReasonInputSchema, "turn": z.number().int().min(0).max(4294967295).min(0)}))
export const TurnEndReasonInputSchema: z.ZodType<TurnEndReasonInput> = z.lazy(() => z.union([TurnEndReasonWireSchema, LegacyTurnEndReasonSchema]))
export const TurnEndReasonWireSchema: z.ZodType<TurnEndReasonWire> = z.lazy(() => z.union([z.looseObject({"kind": z.literal("completed")}), z.looseObject({"kind": z.literal("max-tokens")}), z.looseObject({"kind": z.literal("cancelled")}), z.looseObject({"kind": z.literal("max-steps")}), z.looseObject({"error": TurnFailureSchema, "kind": z.literal("error")})]))
export const TurnFailureSchema: z.ZodType<TurnFailure> = z.lazy(() => z.looseObject({"code": z.string(), "message": z.string()}))
