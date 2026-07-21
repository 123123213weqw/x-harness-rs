/** Minimal retained list slice consumed by the pure descendant indexer.
 * Full runtime summaries will implement this shape without flattening their projection data.
 */
export type SessionId = string
export interface SubagentLineageRow {readonly id: SessionId; readonly origin?: string; readonly parentId?: SessionId; readonly running: boolean}
