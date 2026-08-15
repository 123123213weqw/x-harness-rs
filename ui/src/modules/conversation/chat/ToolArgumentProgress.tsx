import { useEffect, useId, useMemo, useState } from 'react'
import type { AssistantBlock } from '../types/runtime'
import type { ChatViewSlotProps } from '../contract/slots'
import { boundedToolArgumentText, formatToolArgumentBytes, TOOL_ARGUMENT_PREVIEW_LIMIT, toolArgumentPreview } from './tool-argument-view'

import { useTranscriptState } from './transcript-state'

/** All providers use normalized tool deltas; this card performs no tool execution. */
export function ToolArgumentProgress({ block, t }: {
  block: Extract<AssistantBlock, { kind: 'tool-call' }>
  t: ChatViewSlotProps['t']
}) {
  const stateKey = `tool-arguments:${block.callId}:${block.startedAt ?? ''}`
  const [open, setOpen] = useTranscriptState(`${stateKey}:open`, false)
  const [rawMode, setRawMode] = useTranscriptState(`${stateKey}:raw`, false)
  const [now, setNow] = useState(Date.now)
  const bodyId = useId()
  const bytes = useMemo(() => new TextEncoder().encode(block.argsRaw).byteLength, [block.argsRaw])
  // Closed cards count bytes but do not decode or render the potentially long input.
  const preview = useMemo(() => open && !rawMode ? toolArgumentPreview(block.argsRaw) : null, [open, rawMode, block.argsRaw])
  useEffect(() => {
    if (block.startedAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [block.startedAt])
  const text = rawMode ? boundedToolArgumentText(block.argsRaw).text : preview?.text ?? ''
  const truncated = rawMode ? block.argsRaw.length > TOOL_ARGUMENT_PREVIEW_LIMIT : preview?.truncated === true
  return (
    <div className="xh-tool-preparing" data-tool-phase="generating" data-tool-name={block.name}>
      <button type="button" className="xh-tool-preparing-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        <span className="xh-tool-preparing-dot" aria-hidden="true" />
        <span className="xh-tool-preparing-title">{t('tool.arguments.generating')} <code>{block.name}</code></span>
        <span className="xh-tool-preparing-metrics" aria-live="off">
          {t('tool.arguments.received', { size: formatToolArgumentBytes(bytes) })}
          {block.startedAt !== undefined && <> · {t('tool.arguments.elapsed', { seconds: Math.max(0, Math.floor((now - block.startedAt) / 1000)) })}</>}
        </span>
        <span className="xh-tool-preparing-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <div id={bodyId} className="xh-tool-preparing-body">
        <p className="xh-tool-preparing-notice">{t('tool.arguments.notExecuted')}</p>
        <div className="xh-tool-preparing-preview-head">
          <span>{rawMode || !preview?.field ? t('tool.arguments.raw') : `${t('tool.arguments.preview')} · ${preview.field}`}</span>
          <button type="button" aria-pressed={rawMode} onClick={() => setRawMode(value => !value)}>{rawMode ? t('tool.arguments.showPreview') : t('tool.arguments.showRaw')}</button>
        </div>
        <pre className="xh-tool-preparing-input">{text || t('tool.arguments.waiting')}</pre>
        {truncated && <p className="xh-tool-preparing-limit">{t('tool.arguments.truncated', { count: TOOL_ARGUMENT_PREVIEW_LIMIT })}</p>}
      </div>}
    </div>
  )
}
