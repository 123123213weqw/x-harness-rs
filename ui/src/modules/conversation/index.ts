/// <reference path="./externals.d.ts" />
/**
 * Browser conversation plugin. `contract/` is the shared type boundary
 * between the independently implemented skeleton and chat domains; `apply.ts`
 * owns their slot assembly.
 */
export type {} from './conversation-nodes/assistant'
export type {} from './conversation-nodes/command'
export type {} from './conversation-nodes/compaction'
export type {} from './conversation-nodes/fallback'
export type {} from './conversation-nodes/message'
export type {} from './conversation-nodes/retry'
export type {} from './conversation-nodes/tool'
export type {} from './conversation-nodes/turn-error'
export type {} from './conversation-nodes/turn-max-tokens'
export type {} from './conversation-nodes/turn-tail'

export { apply, inject } from './apply'
export { ConversationController } from './service'
export type { IConversation } from './service'
export type { DraftAttachmentId } from './input/contract'

export type {
  CallId, ChatStoreState, SelectionTarget, ViewTab,
} from './contract/views'
export type { ConversationKey } from './locales'
export type {
  AssistantChatData, ChatNode, ChatNodeDataMap, ChatNodeKind, ManualCompactionChatData,
  RetryChatData, ToolChatData, TurnTailChatData,
} from './contract/chat-nodes'
export type {
  ChatFileMentions, ChatNodeOwnerProps, ChatNodeViewProps,
  ChatStore, ChatViewInjected, ChatViewSlotProps, CommandRowOwnerProps, CommandRowProps, ComposerBarInjected,
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps, ComposerChainProps, ConversationInjected,
  ConversationSessionHeaderInjected, ConversationSessionInjected, ConversationSlotProps, ConvViewOwnerProps,
  ConvViewProps, DetailsInjected, DetailsSlotProps, DetailsToolOwnerProps, EmptyWorkspaceOwnerProps, HeroBrandMarkOwnerProps,
  MessageImagesOwnerProps, MessageImagesProps, RenderMessageImages, TurnTailOwnerProps, UseChatNodeTurnData,
} from './contract/slots'
// Export discipline: packages/client/AGENTS.md.


export { XHarnessMessageEditor } from './edit/MessageEditor'
export { XHarnessEditableInputBar } from './edit/EditableInputBar'
export { xhEditMessage } from './edit/actions'
