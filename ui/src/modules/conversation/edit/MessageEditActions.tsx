import { Tooltip } from '../primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots'
import css from '../chat/MessageIconActions.styles'
export function MessageEditActions({ content, seq, editMessage, forkMessage, t }: Pick<ChatNodeOwnerProps, 'editMessage' | 'forkMessage'> & { content: readonly unknown[]; seq: number; t: ChatViewSlotProps['t'] }) {
  return <>
    <Tooltip label={t('message.edit')} side="bottom"><button type="button" className={css.action} data-message-edit="" aria-label={t('message.edit')} onClick={() => { void editMessage(content) }}>✎</button></Tooltip>
    <Tooltip label={t('message.editFork')} side="bottom"><button type="button" className={css.action} data-message-edit-fork="" aria-label={t('message.editFork')} onClick={() => { void forkMessage(seq, content) }}>⑂</button></Tooltip>
  </>
}
