/** Injected faces and the Package-owned `tool.view.cordis` slot declaration. */

import type { SessionId } from './contracts'
import type { HostObservable } from './contracts'
import type {
  CordisRunActivity, CordisRunFailure, CordisUserRunRequest, DynamicCordisLivePackage,
  DynamicCordisRenderFailure,
} from './contracts'
import type { CordisActionResult } from './dynamic-port'
import type { CordisInventory } from './inventory'
import type { CordisRunCardPointer, CordisRunCardStore } from './run-card-index'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from './events'

/** Owner currency delivered to a dynamic Package's business view. */
export interface CordisToolViewOwnerProps {
  readonly pluginId: CordisDynamicPluginId
  readonly packageId: CordisDynamicPackageId
  readonly pluginRunId: CordisDynamicPluginRunId
}



/** Live facts used by the read-only Define card. */
export interface CordisCardFace {
  hooks: {
    inventory: CordisInventory
    loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  }
}

/** Live facts used by the Run card and its business-view ownership index. */
export interface CordisRunCardFace extends CordisCardFace {
  hooks: CordisCardFace['hooks'] & {
    runCards: CordisRunCardStore
    activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
  }
  /** Publish this successful result into the session's latest-card index. */
  onObserveRunCard(pointer: CordisRunCardPointer): void
}

/** Frame-wide panel state and lifecycle verbs. */
export interface CordisPanelFace {
  hooks: {
    inventory: CordisInventory
    activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
    runErrors: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunFailure>>
    renderFailures: HostObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>>
    loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  }
  onApprove(requestId: ApprovalRequestId, approveFutureVersions: boolean): Promise<void>
  onDecline(requestId: ApprovalRequestId): Promise<void>
  onRun(request: CordisUserRunRequest): Promise<void>
  onStop(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  onRemove(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  onRefresh(): void
}
