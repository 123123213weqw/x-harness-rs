/** Render primitives remain platform-owned; only consumed props are described here. */
import * as platform from '@xharness/dsh-client-ui-primitives'
import type * as React from 'react'
export interface MarkdownFileMentions { resolve(token: string): { label: string; title: string; open(): void } | undefined }
export type MenuEntry = { id: string; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean } | { type: 'separator'; id: string }
type Icon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number | undefined }>
export const { Button, Modal, JsonBlock, CodeBlock, MarkdownText, MessageText, DisclosureRow, Tooltip, Menu, StateDot, Toast, RiskConfirmation, FishLogo, IconPaperclipOutline16, IconCodeOutline16, IconApiOutline14, IconBranchOutline16, IconBrowseOutline16, IconCheckOutline16, IconChecklistOutline14, IconChevronDownOutline14, IconChevronRightOutline14, IconChevronUpOutline14, IconCloseOutline16, IconCopyOutline16, IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, IconQueueOutline14, IconSendOutline14, IconThinkOutline14, IconTrashOutline16, IconWarningOutline16, writeClipboard } = platform
