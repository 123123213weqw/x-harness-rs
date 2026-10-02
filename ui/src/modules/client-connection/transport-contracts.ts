/** The controller consumes this validated transport slice; business payloads stay opaque here.
 * The future complete wire-schema module supplies concrete Host/Mux unions and description DTOs.
 */
export interface TypedFrame {type: string}
export type HostFrame = TypedFrame
export type MuxFrame = TypedFrame
export type HostDescription = Readonly<Record<string, unknown>>
export interface RpcRequest<T> {rpcId: string; payload: T}
export type RpcResult<T> = {ok: true; value: T} | {ok: false; error: {code: string; message: string; details?: unknown}}
export interface IApiClient {
  host: {describe(payload: Record<string, never>): Promise<{result: RpcResult<HostDescription>}>}
  events: {
    mux(payload: Record<string, never>, signal: AbortSignal, onOpen: () => void): AsyncIterable<RpcRequest<MuxFrame>, void, unknown>
    host(payload: Record<string, never>, signal: AbortSignal, onOpen: () => void): AsyncIterable<RpcRequest<HostFrame>, void, unknown>
  }
}
