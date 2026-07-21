import type { ThemeRuntime, ThemeSnapshot } from './index'
import type { SlotsService, Translation } from '../views-types'
export interface SettingsScope<State extends object> {
  getSnapshot(): { value: Readonly<State> | undefined }
  subscribe(listener: () => void): () => void
  set<Key extends keyof State>(field: Key, value: State[Key]): Promise<void>
}
/** Theme transport and registry boundaries; no upstream Context augmentation. */
export interface ThemeContext {
  effect(effect: () => void | (() => void), label: string): void
  emit(name: 'theme/change', snapshot: ThemeSnapshot): void
  on(name: 'theme/change', listener: (snapshot: ThemeSnapshot) => void): () => void
  provide(name: 'theme', value: ThemeRuntime): void
  settingsScope: { bind<State extends object>(spec: {namespace: string; decode(section: unknown): State | undefined}): SettingsScope<State> }
  locale: {
    register(namespace: string, translations: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void
    bind(namespace: string): Translation
  }
  slots: SlotsService
}
