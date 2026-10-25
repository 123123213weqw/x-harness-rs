// GENERATED from crates/xharness-api/src/display.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-file-display-contract.mjs.
import { z } from 'zod'

export const FILE_DISPLAY_CONTRACT = "xharness-file-display-v1"
export const FILE_DISPLAY_SCHEMA_SHA256 = "b4c98a1027088c93e600b3b31461bcf4ca51d376159be93bbe1d227edc9cbd5d"

export type DisplayDiffSource = "patch" | "working" | "staged" | "head"
export type DisplayFile = ({ readonly "kind": "markdown"; readonly "path": string; readonly "text": string } | { readonly "kind": "text"; readonly "path": string; readonly "text": string } | { readonly "kind": "diff"; readonly "path": string; readonly "source": DisplayDiffSource; readonly "text": string } | { readonly "dataBase64": string; readonly "kind": "pdf"; readonly "path": string } | { readonly "dataBase64": string; readonly "height": number; readonly "kind": "image"; readonly "mediaType": string; readonly "path": string; readonly "width": number })
export type DisplayInspect = { readonly "path": string; readonly "sessionId": string; readonly "thumbnail"?: boolean | undefined }
export type DisplayInspection = { readonly "bytes": number; readonly "height"?: (number | null) | undefined; readonly "modifiedMs"?: (number | null) | undefined; readonly "path": string; readonly "preview": DisplayPreviewKind; readonly "thumbnail"?: (DisplayThumbnail | null) | undefined; readonly "width"?: (number | null) | undefined }
export type DisplayOpen = { readonly "gitDiff"?: (GitDiffScope | null) | undefined; readonly "path": string; readonly "sessionId": string }
export type DisplayPreviewKind = "text" | "markdown" | "image" | "pdf" | "unsupported" | "tooLarge"
export type DisplayRead = { readonly "gitDiff"?: (GitDiffScope | null) | undefined; readonly "path": string; readonly "relativeTo"?: (string | null) | undefined; readonly "sessionId": string }
export type DisplayThumbnail = { readonly "dataBase64": string; readonly "height": number; readonly "width": number }
export type GitDiffScope = "working" | "staged" | "head"

export const DisplayDiffSourceSchema: z.ZodType<DisplayDiffSource> = z.lazy(() => z.union([z.literal("patch"), z.literal("working"), z.literal("staged"), z.literal("head")]))
export const DisplayFileSchema: z.ZodType<DisplayFile> = z.lazy(() => z.union([z.strictObject({"kind": z.literal("markdown"), "path": z.string(), "text": z.string()}), z.strictObject({"kind": z.literal("text"), "path": z.string(), "text": z.string()}), z.strictObject({"kind": z.literal("diff"), "path": z.string(), "source": DisplayDiffSourceSchema, "text": z.string()}), z.strictObject({"dataBase64": z.string(), "kind": z.literal("pdf"), "path": z.string()}), z.strictObject({"dataBase64": z.string(), "height": z.number().int().min(0).max(4294967295).min(0), "kind": z.literal("image"), "mediaType": z.string(), "path": z.string(), "width": z.number().int().min(0).max(4294967295).min(0)})]))
export const DisplayInspectSchema: z.ZodType<DisplayInspect> = z.lazy(() => z.strictObject({"path": z.string(), "sessionId": z.string(), "thumbnail": z.boolean().optional()}))
export const DisplayInspectionSchema: z.ZodType<DisplayInspection> = z.lazy(() => z.strictObject({"bytes": z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).min(0), "height": z.union([z.number().int().min(0).max(4294967295).min(0), z.null()]).optional(), "modifiedMs": z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).min(0), z.null()]).optional(), "path": z.string(), "preview": DisplayPreviewKindSchema, "thumbnail": z.union([DisplayThumbnailSchema, z.null()]).optional(), "width": z.union([z.number().int().min(0).max(4294967295).min(0), z.null()]).optional()}))
export const DisplayOpenSchema: z.ZodType<DisplayOpen> = z.lazy(() => z.strictObject({"gitDiff": z.union([GitDiffScopeSchema, z.null()]).optional(), "path": z.string(), "sessionId": z.string()}))
export const DisplayPreviewKindSchema: z.ZodType<DisplayPreviewKind> = z.lazy(() => z.union([z.literal("text"), z.literal("markdown"), z.literal("image"), z.literal("pdf"), z.literal("unsupported"), z.literal("tooLarge")]))
export const DisplayReadSchema: z.ZodType<DisplayRead> = z.lazy(() => z.strictObject({"gitDiff": z.union([GitDiffScopeSchema, z.null()]).optional(), "path": z.string(), "relativeTo": z.union([z.string(), z.null()]).optional(), "sessionId": z.string()}))
export const DisplayThumbnailSchema: z.ZodType<DisplayThumbnail> = z.lazy(() => z.strictObject({"dataBase64": z.string(), "height": z.number().int().min(0).max(4294967295).min(0), "width": z.number().int().min(0).max(4294967295).min(0)}))
export const GitDiffScopeSchema: z.ZodType<GitDiffScope> = z.lazy(() => z.union([z.literal("working"), z.literal("staged"), z.literal("head")]))
