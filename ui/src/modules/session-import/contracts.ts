import type {PageContext, Translation} from '../shared/runtime-types'
import type {ApiResult} from '../views-types'
export interface ImportInput {source: 'claude-code'|'codex'; jsonl: string; preview: boolean; cwd?: string}
export interface ImportReport {sessionId?: string; title: string; messages: number; tools: number; warnings: string[]; preview: {role: string; content: string}[]}
export interface ImportApi {sessions: {importHistory(input: ImportInput, signal?: AbortSignal): Promise<{result: ApiResult<ImportReport>}>}}
export interface ImportSessions {refresh(): Promise<void>; open(id: string): void}
export interface ImportContext extends PageContext {get(name: 'connection'): {api: ImportApi}; sessions: ImportSessions}
export interface ImportProps {api: ImportApi; sessions: ImportSessions; t: Translation; close(): void}
