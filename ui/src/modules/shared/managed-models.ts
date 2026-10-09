/** Stable route reserved by account connection; presentation provenance, not authorization. */
export const MANAGED_MODEL_ROUTE = 'xharness-managed'
export const MANAGED_MODEL_NAMESPACE = 'llm-pi-ai'
export const MANAGED_MODEL_CREDENTIAL = 'XHARNESS_MANAGED_API_TOKEN'
export function isManagedModelProvider(provider: string): boolean { return provider === MANAGED_MODEL_ROUTE }
export function isManagedModelProfile(namespace: string, path: readonly string[]): boolean {
  return namespace === MANAGED_MODEL_NAMESPACE && path.length === 2 && path[0] === 'providers' && path[1] === MANAGED_MODEL_ROUTE
}
