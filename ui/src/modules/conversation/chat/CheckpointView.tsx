import { memo } from 'react'
import type { ChatNodeViewProps } from '../contract/slots'
import css from './MessageItem.styles'
export const CheckpointView = memo(function CheckpointView({ node }: ChatNodeViewProps<'run-checkpoint'>) {
  const data = node.data
  const title = data.noticeKind === 'limit' ? '执行已停止：步骤硬上限' : data.noticeKind === 'continued' ? '已进入下一执行阶段' : '执行检查点'
  return <details className={css.contextRow} style={{ padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2, #d9dde5)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #525866)' }} open={data.noticeKind === 'limit'}>
    <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{title}</summary>
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{data.message}</div>
  </details>
})
