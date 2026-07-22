import * as platform from '@xharness/dsh-client-runtime/client'
import type { AssistantBlock, EngineStoreHandle, SnapshotStore } from './types/runtime'
import type { SessionEvent, AssistantChunk, ContentBlock } from './types/wire'
import type { ContextProvenanceView, KnownContextForm } from './types/context-provenance'
export const { createSnapshotStore, defineStore, publishChatSnapshot, shallowEqual, isAppendSurfaceEvent, isReplacementSurfaceEvent, contextForm, contextProvenance, conversationContextKey, displayFailureMessage, sessionRecallLabels, resolveWorkspacePath, workspaceTitleOf } = platform

export { toAssistantBlock, toAssistantBlocks } from './types/model'
export { isTokenDelta, emptyAssistantBlock } from './chat/chunk-values'
