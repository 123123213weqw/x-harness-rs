import { useMemo } from 'react'
import type { ChatViewSlotProps } from '../contract/slots'
import { ToolGlyph } from '../../shared/ToolGlyph'
import { decodeToolActivity, selectToolActivity } from './tool-activity'

/** Decorative recent activity only. The real keyed cards remain the sole action/approval/privacy owner. */
export function ToolActivitySummary({ turn, enabled, useSession, t, fallback }: { turn: number; enabled: boolean; useSession: ChatViewSlotProps['useSession']; t: ChatViewSlotProps['t']; fallback: string }) {
  const value = useSession(snapshot => {
    if (!enabled || !snapshot.running || snapshot.stopRequested || snapshot.openState !== 'open' || (snapshot.pending?.length ?? 0) > 0
      || snapshot.chat.timeline.turns.get(turn)?.status !== 'open') return ''
    let latest = snapshot.chat.timeline.turnOrder?.at(-1)
    if (latest === undefined) for (const id of snapshot.chat.timeline.turns.keys()) latest = id
    if (latest !== turn) return ''
    return selectToolActivity(snapshot.chat.locations.getTurn(turn), key => snapshot.chat.nodes.get(key))
  })
  const input = useMemo(() => decodeToolActivity(value), [value])
  // Static latest-activity face: the newest tool is shown in place with no
  // paging carousel and no sliding transition — updates swap text only.
  const current = input.items.at(-1)
  return <><span className="xh-live-tool-counts" hidden={current !== undefined}>{fallback}</span><span className="xh-tool-activity" data-tool-activity={turn} hidden={current === undefined} aria-hidden="true">
    <span className="xh-tool-activity-pages" data-tool-activity-pages="">
      {current !== undefined && <span className="xh-tool-activity-page" data-tool-activity-current={current.key}>
        <span className="xh-tool-activity-face">
          <ToolGlyph name={current.name} argsRaw={current.glyphArgs} size={14} /><span className="xh-tool-activity-name">{current.title}</span>
        </span>
      </span>}
    </span>
    {input.parallel > 1 && <span className="xh-tool-activity-parallel" data-tool-activity-parallel={input.parallel}>{t('message.parallelTools', { count: input.parallel })}</span>}
  </span></>
}
