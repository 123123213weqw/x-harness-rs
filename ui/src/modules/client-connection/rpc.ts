/** Browser caller for generic Connection unary RPC channels. */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from './contracts/host/apiproxy/api/index'
import type { ClientConnectionRpc } from './rpc-contracts'
import { randomUuid } from './random-uuid'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Create the browser-backed generic RPC caller.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await globalThis.fetch(
        new URL(`${channel}/${endpoint}`, resolveBase()),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const raw: unknown = await response.json()
      const full = serverResponseSchema.parse(raw)
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

function resolveBase(): string {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  return pageLocation?.origin !== undefined && pageLocation.origin !== 'null' ? pageLocation.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
