// GENERATED from crates/xharness-api/src/display.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-file-display-contract.mjs.
import { z } from 'zod'

export const FILE_DISPLAY_CONTRACT = "xharness-file-display-v1"
export const FILE_DISPLAY_SCHEMA_SHA256 = "2f335d9cac83757318e1101dee9ba03d3d2c8668cefd8aac2a981e5544e6d278"

export type DisplayDiffSource = "patch" | "working" | "staged" | "head"
export type DisplayFile = ({ readonly "kind": "markdown"; readonly "path": string; readonly "text": string } | { readonly "kind": "text"; readonly "path": string; readonly "text": string } | { readonly "kind": "diff"; readonly "path": string; readonly "source": DisplayDiffSource; readonly "text": string } | { readonly "dataBase64": string; readonly "height": number; readonly "kind": "image"; readonly "mediaType": string; readonly "path": string; readonly "width": number })
export type DisplayOpen = { readonly "gitDiff"?: (GitDiffScope | null) | undefined; readonly "path": string; readonly "sessionId": string }
export type DisplayRead = { readonly "gitDiff"?: (GitDiffScope | null) | undefined; readonly "path": string; readonly "relativeTo"?: (string | null) | undefined; readonly "sessionId": string }
export type GitDiffScope = "working" | "staged" | "head"

export const DisplayDiffSourceSchema: z.ZodType<DisplayDiffSource> = z.lazy(() => z.union([z.literal("patch"), z.literal("working"), z.literal("staged"), z.literal("head")]))
export const DisplayFileSchema: z.ZodType<DisplayFile> = z.lazy(() => z.union([z.strictObject({"kind": z.literal("markdown"), "path": z.string(), "text": z.string()}), z.strictObject({"kind": z.literal("text"), "path": z.string(), "text": z.string()}), z.strictObject({"kind": z.literal("diff"), "path": z.string(), "source": DisplayDiffSourceSchema, "text": z.string()}), z.strictObject({"dataBase64": z.string(), "height": z.number().int().min(0).max(4294967295).min(0), "kind": z.literal("image"), "mediaType": z.string(), "path": z.string(), "width": z.number().int().min(0).max(4294967295).min(0)})]))
export const DisplayOpenSchema: z.ZodType<DisplayOpen> = z.lazy(() => z.strictObject({"gitDiff": z.union([GitDiffScopeSchema, z.null()]).optional(), "path": z.string(), "sessionId": z.string()}))
export const DisplayReadSchema: z.ZodType<DisplayRead> = z.lazy(() => z.strictObject({"gitDiff": z.union([GitDiffScopeSchema, z.null()]).optional(), "path": z.string(), "relativeTo": z.union([z.string(), z.null()]).optional(), "sessionId": z.string()}))
export const GitDiffScopeSchema: z.ZodType<GitDiffScope> = z.lazy(() => z.union([z.literal("working"), z.literal("staged"), z.literal("head")]))
