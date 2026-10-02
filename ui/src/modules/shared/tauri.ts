/** Desktop-provided bridge. Payloads cross a trust boundary and are decoded by
 * the consumer, never asserted to a wire result type. No bridge is synthesized. */
export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>
export interface NativeEvent { event: string; id: number; payload: unknown }
export type NativeUnlisten = () => void
/** SDK geometry DTOs: dimensions/positions are physical except LogicalSize. */
export interface NativeSize {width:number;height:number}
export interface NativePosition {x:number;y:number}
export interface NativeMonitor {workArea?:{position:NativePosition;size:NativeSize}}
export interface NativeLogicalSizeConstructor {new(width:number,height:number):NativeSize}
export interface NativeWindow {
  innerSize():Promise<NativeSize>
  outerSize():Promise<NativeSize>
  outerPosition():Promise<NativePosition>
  scaleFactor():Promise<number>
  isFullscreen():Promise<boolean>
  setSize(size:NativeSize):Promise<void>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  close(): Promise<void>
  startDragging(): Promise<void>
  onResized(listener: (event: NativeEvent) => void): Promise<NativeUnlisten>
}
export interface TauriBridge {
  core: { invoke: NativeInvoke }
  event: { listen(event: string, listener: (event: NativeEvent) => void): Promise<NativeUnlisten> }
  window?: { getCurrentWindow(): NativeWindow;currentMonitor?():Promise<NativeMonitor|null>;LogicalSize?:NativeLogicalSizeConstructor }
  dpi?: {LogicalSize?:NativeLogicalSizeConstructor}
}
declare global { interface Window { __TAURI__?: TauriBridge } }
