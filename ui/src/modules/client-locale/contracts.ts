import type * as React from 'react'
import type { LocaleId } from './locale-settings'
import type { CommonKey } from './locales'
import type { SettingsLocaleKey } from './locales/settings'
import type { LocaleRuntime, LocaleSnapshot } from './index'
import type { LanguageRowState, LanguageOptionRow, createLanguageRowStore } from './settings-store'
export type Translate = (key: string, params?: Readonly<Record<string, unknown>>) => string
export interface LocaleNamespaceMap {common: CommonKey; 'settings.locale': SettingsLocaleKey}
export type LocaleDictOf<N extends keyof LocaleNamespaceMap> = Record<LocaleNamespaceMap[N], string>
export type TranslateNS<N extends keyof LocaleNamespaceMap> = (key: LocaleNamespaceMap[N] | CommonKey, params?: Readonly<Record<string, unknown>>) => string
export interface SettingsScope<T> {
  getSnapshot(): {value: T | undefined}
  subscribe(listener: () => void): () => void
  set<K extends keyof T>(field: K, value: T[K]): Promise<unknown>
}
export interface LanguageBoundActions {sync(active: string, options: LanguageOptionRow[], revision: number): void}
export interface LanguageRowComponentProps {
  t(key: SettingsLocaleKey): string
  setLocale(id: string): void
  useStore<T>(select: (state: LanguageRowState) => T): T
}
export interface LocaleContext {
  effect(effect: () => () => void, label: string): unknown
  emit(event: 'locale/change', snapshot: LocaleSnapshot): unknown
  on(event: 'locale/change', listener: (snapshot: LocaleSnapshot) => void): unknown
  provide(name: 'locale', runtime: LocaleRuntime): void
  settingsScope: {bind<T>(options: {namespace: string}): SettingsScope<T>}
  slots: {
    installLocale(locale: LocaleRuntime): void
    inject(name: 'settings.general.item', install: () => void): void
    register(spec: {name: 'settings.general.item'; id: string; order: number; store: ReturnType<typeof createLanguageRowStore>; locale: string; inject(actions: LanguageBoundActions): {setLocale(id: string): void}}, component: React.ComponentType<LanguageRowComponentProps>): void
  }
}
