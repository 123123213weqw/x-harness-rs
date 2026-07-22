import { z } from 'zod'
import type { ChatStoreState } from './views'
const schema = z.looseObject({
 selection:z.looseObject({turnSeq:z.number(),stepSeq:z.number().optional(),callId:z.string().optional(),toolName:z.string().optional()}).nullable(),
 draft:z.string(), view:z.string().nullable().default(null),
 // Original consumers used ??null for pre-inspect persisted snapshots.
 inspect:z.looseObject({callId:z.string()}).nullable().default(null),
}) satisfies z.ZodType<ChatStoreState>
/** Admit original persisted drafts, retained unknown view ids and foreign fields. */
export function decodeChatStoreState(value: unknown): ChatStoreState { return schema.parse(value) }
