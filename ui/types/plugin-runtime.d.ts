import type * as React from 'react'
import type { PluginCall, RpcTransport, InstalledPlugin, PackageSource } from '../src/plugin-api/contracts'

export interface DescriptionItem { name: string; description: string; version: string }
// UI-only merged view. Never used to validate or weaken a wire response.
export type PluginCard = DescriptionItem & Partial<InstalledPlugin> & { source?: PackageSource | undefined; icon?: string | null | undefined }
export interface PluginHubProps { t(key: string): string; call: PluginCall }
export interface PluginHubContext {
  effect(effect: () => void | (() => void), label: string): void
  locale: { register(namespace: string, translations: { zh: Record<string, string>; en: Record<string, string> }): void }
  get(name: 'connection'): { rpc: RpcTransport }
  slots: {
    inject(name: 'plugins.center', effect: () => void): void
    register(spec: { name: string; id: string; order: number; locale: string; inject: () => { call: PluginCall } }, component: (props: PluginHubProps) => React.ReactElement): void
  }
}
export interface HubModule { apply(context: PluginHubContext): void; inject: string[] }
