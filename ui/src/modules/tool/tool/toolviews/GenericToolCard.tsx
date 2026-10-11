// GenericToolCard: the default tool row — classifies the tool into a visual
// variant and renders the summary row. Supplied by the Tool call tree as the
// keyed atomic-view slot's render-site fallback (an
// unregistered tool name lands here); registrants may also compose it as a
// base, feeding the same owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
} from '../../primitives'
import type { ToolCallOwnerProps, ToolTreeProps } from '../../contract/slots'
import { readCardModel } from '../models/read-card-model'
import { diffCardModel } from '../models/diff-card-model'
import { searchCardModel } from '../models/search-card-model'
import { terminalCardModel, terminalFailed } from '../models/terminal-card-model'
import { webCardModel } from '../models/web-card-model'
import { toolRowModel, type ToolRowVariant } from '../models/tool-call-model'
import { ToolRow } from '../components/ToolRow'
import { agentCommunicationModel, agentCommunicationCopy } from '../models/agent-communication-model'

/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/** Card props: the owner payload plus the render site's locale seat (plain prop). */
export interface GenericToolCardProps extends ToolCallOwnerProps {
  t: ToolTreeProps['t']
}

export function GenericToolCard({ toolName, block, cwd, home, openFile, inspect, t }: GenericToolCardProps) {
  const communication = agentCommunicationModel(toolName, block)
  const communicationCopy = communication === null ? null
    : agentCommunicationCopy(communication, document.documentElement.lang.toLowerCase().startsWith('zh'))
  const model = toolRowModel(toolName, block, cwd, home)
  const terminal = terminalCardModel(block, cwd)
  const read = readCardModel(block, cwd, home)
  const diff = diffCardModel(block)
  const search = searchCardModel(block)
  const web = webCardModel(block)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced as the row's red state dot.
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal)
    ? 'error'
    : model.state
  const singleFile = model.filePath !== undefined
  return (
    <ToolRow
      stateKey={block.callId}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={communicationCopy?.title ?? model.title}
      // A terminal presenter's description is the contract's above-card text, so
      // it outranks the args-derived summary here exactly as it does in BashRow;
      // a search result view's replacement title outranks it the same way.
      summary={communicationCopy?.summary ?? terminal?.description ?? search?.title ?? model.summary}
      summarySuffix={communicationCopy?.status}
      // Single-file tools never expose an args body — the path link is the only
      // args interaction. A card is not an args body: a read/write/edit row is
      // single-file AND carries a card, so the card expands under the path link.
      body={communicationCopy?.body ?? (singleFile ? null : model.body)}
      output={communication?.output ?? model.output}
      errorSummary={communication === null ? model.errorSummary : null}
      terminal={terminal}
      diff={diff}
      read={read}
      search={search}
      web={web}
      state={communication?.state ?? state}
      filePath={model.filePath}
      onOpenFile={singleFile ? openFile : undefined}
      inspect={inspect}
    />
  )
}
