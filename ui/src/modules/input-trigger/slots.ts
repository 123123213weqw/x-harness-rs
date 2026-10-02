/**
 * Overlay-slot contract surface of the slash plugin. The
 * 'conversation.input.overlay' slot is OWNED by the ui-conversation composer
 * entry (declaring is claiming: anchor, children declaration, lifecycle),
 * but the SlotMap type merge lives here: the owner package depends on this
 * one, so the dependency direction admits no reverse type import, and a
 * type-erased registration is ruled out. The owner's
 * program picks this merge up transitively through its ui-input-trigger imports.
 */
// Type-only edge: the SlotMap augmentation below merges into this package's interface.
import type { SnapshotStore } from './contracts'
import type { MenuState } from './core/contract'



/** Injected business face of the MenuView overlay entry (copy rides the standard locale seat, not this face). */
export interface MenuViewInjected {
  /** The service's menu state store (read-only here; MenuView subscribes). */
  menu: SnapshotStore<MenuState>
  /**
   * Pointer pick routed back through the service pipeline.
   * @param source - source (group) name.
   * @param index - candidate index within the group.
   */
  onPick: (source: string, index: number) => void
  /** Dismiss the menu (external pointer outside the composer area). */
  onDismiss: () => void
}
