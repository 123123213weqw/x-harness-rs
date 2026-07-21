/** The assembly consumes only the typed mount seam, not a Host implementation. */
import type { TypertDisposer, TypertRemoteContribution } from '../typert-registry/protocol'
export interface Context {remote: {$mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>}}
