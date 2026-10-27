/** Yield event reduction to input/paint tasks without reordering durable events.
 * Control frames and mutation RPCs never wait behind this FIFO. */
export class CooperativeDelivery<T> {
  private pending: { value: T; bytes: number }[] = []
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private reset: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private spent = 0
  constructor(
    private readonly deliver: (value: T) => void,
    private readonly failure: (error?: unknown) => void,
    private readonly now: () => number = () => globalThis.performance?.now() ?? Date.now(),
  ) {}

  push(value: T, bytes: number): void {
    const now = this.now()
    // Reset only after a real task boundary, not merely after wall-clock
    // time: a stream of microtasks (including snapshot flushes) can otherwise
    // starve input forever while repeatedly appearing to be an idle producer.
    if (this.reset === undefined) {
      this.epoch = now
      this.spent = 0
      this.reset = setTimeout(() => { this.reset = undefined }, 0)
    }
    if (this.timer === undefined && this.spent < 4 && now - this.epoch < 4) {
      const started = this.now()
      this.deliverSafely(value)
      this.spent += this.now() - started
      return
    }
    if (this.pending.length >= 512 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.clear()
      this.failure()
      return
    }
    this.pending.push({ value, bytes })
    this.bytes += bytes
    if (this.timer === undefined) this.timer = setTimeout(() => this.drain(), 0)
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.reset !== undefined) clearTimeout(this.reset)
    this.reset = undefined
    this.timer = undefined
    this.pending = []
    this.bytes = 0
    this.spent = 0
  }

  private deliverSafely(value: T): boolean {
    try { this.deliver(value); return true }
    catch (error) {
      // Deferred callbacks no longer have the transport reader's catch scope.
      // Never leave a dead timer/FIFO that silently blocks future deliveries.
      this.clear()
      this.failure(error)
      return false
    }
  }

  private drain(): void {
    const started = this.now()
    do {
      const item = this.pending[0]
      if (item === undefined) break
      // Release references as they drain, not only when the producer goes idle.
      this.pending.shift()
      this.bytes -= item.bytes
      if (!this.deliverSafely(item.value)) return
    } while (this.pending.length > 0 && this.now() - started < 4)
    if (this.pending.length > 0) this.timer = setTimeout(() => this.drain(), 0)
    else { this.clear(); this.epoch = this.now() }
  }
}
