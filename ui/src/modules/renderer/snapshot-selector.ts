/**
 * Typed selector bridge preserving use-sync-external-store 1.2.0's selection
 * memoization: same snapshots retain identity and equal selections reuse the
 * previously committed value. React 18's native uSES is the current platform.
 */
import {useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore} from 'react'
export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const committed = useRef<{hasValue: false} | {hasValue: true; value: Selection}>({hasValue: false})
  const [getSelection, getServerSelection] = useMemo(() => {
    let memo: {snapshot: Snapshot; selection: Selection} | undefined
    const select = (snapshot: Snapshot): Selection => {
      if (memo === undefined) {
        const selected = selector(snapshot)
        const prior = committed.current
        const selection = isEqual !== undefined && prior.hasValue && isEqual(prior.value, selected) ? prior.value : selected
        memo = {snapshot, selection}
        return selection
      }
      if (Object.is(memo.snapshot, snapshot)) return memo.selection
      const selected = selector(snapshot)
      if (isEqual !== undefined && isEqual(memo.selection, selected)) return memo.selection
      memo = {snapshot, selection: selected}
      return selected
    }
    return [() => select(getSnapshot()), getServerSnapshot == null ? undefined : () => select(getServerSnapshot())] as const
  }, [getSnapshot, getServerSnapshot, selector, isEqual])
  const selected = useSyncExternalStore(subscribe, getSelection, getServerSelection)
  useEffect(() => {committed.current = {hasValue: true, value: selected}}, [selected])
  useDebugValue(selected)
  return selected
}
