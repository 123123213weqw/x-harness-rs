import type { ConnectionHandle } from './index'
/** Connection is a consumer-independent wire root; only provision crosses Cordis. */
export interface ConnectionContext {
  provide(name: 'connection', connection: ConnectionHandle): void
}
