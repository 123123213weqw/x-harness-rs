import type { BrowserSpaces, WorkspaceItem } from './workspace-pane'

export const RETAINED_PAGE_LIMIT = 4
export const RETAINED_PAGE_IDLE_MS = 5 * 60_000
export interface RetainedPage { readonly key: string; readonly owner: string; readonly id: string; readonly usedAt: number; readonly visible: boolean }
export const pageKey = (owner: string, id: string): string => JSON.stringify([owner, id])

/** Only existing read-only file panes and settled browser tabs opt in. Tools
 * and provisional model rendezvous retain their original teardown contract. */
export function canRetainPage(item: WorkspaceItem): boolean {
  return item.kind === 'file' || item.kind === 'browser' && !item.modelRequestId
}

/** Presentation cache only: never invent tabs, persist content, grant browser
 * actions, or keep a closed item alive. Evict least recently viewed pages. */
export function planRetainedPages(previous: readonly RetainedPage[], spaces: BrowserSpaces,
  owner: string, activeId: string | null, open: boolean, now: number): readonly RetainedPage[] {
  const active = open ? spaces[owner]?.items.find(item => item.id === activeId && item.kind !== 'tool') : undefined
  const activeKey = active === undefined ? undefined : pageKey(owner, active.id)
  const kept = previous.filter(page => {
    const item = spaces[page.owner]?.items.find(item => item.id === page.id)
    return item !== undefined && (page.key === activeKey || canRetainPage(item)
      && (page.visible || now - page.usedAt < RETAINED_PAGE_IDLE_MS))
  }).map(page => {
    const visible = page.key === activeKey
    return visible === page.visible ? page : { ...page, visible, usedAt: now }
  })
  if (active !== undefined && !kept.some(page => page.key === activeKey)) {
    kept.push({ key: pageKey(owner, active.id), owner, id: active.id, usedAt: now, visible: true })
  }
  const evicted = new Set([...kept].filter(page => page.key !== activeKey)
    .sort((a, b) => b.usedAt - a.usedAt).slice(RETAINED_PAGE_LIMIT - (active === undefined ? 0 : 1)).map(page => page.key))
  const next = kept.filter(page => !evicted.has(page.key))
  return next.length === previous.length && next.every((page, index) => {
    const old = previous[index]
    return old?.key === page.key && old.usedAt === page.usedAt && old.visible === page.visible
  }) ? previous : next
}
