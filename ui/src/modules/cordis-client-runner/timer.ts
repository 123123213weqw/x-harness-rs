/** Browser implementation of the Cordis timer Service. */

import { Service, Context } from '@xharness/cordis'

type WithDispose<T> = T & { dispose: () => void }
interface Deferred<T> {promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => { throw new Error('Promise executor did not initialize resolve') }
  let reject: (reason: unknown) => void = () => { throw new Error('Promise executor did not initialize reject') }
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})
  return {promise, resolve, reject}
}

/** Browser timer Service with the same public API as the Host Cordis TimerService. */
export class ClientTimerService extends Service {
  /** Register the Service and mix its lifecycle-safe helpers onto Context. */
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', {timeout:'timeout', interval:'interval', throttle:'throttle', debounce:'debounce', setTimeout:'setTimeout', setInterval:'setInterval'})
  }

  /**
   * Run a callback once through {@link timeout}.
   * @param callback - Work to run after the delay.
   * @param delay - Delay in milliseconds.
   * @returns Disposer that cancels the pending callback early.
   * @deprecated Use `ctx.timeout()` instead.
   */
  setTimeout(callback: () => void, delay: number): () => void {
    return this.timeout(callback, delay)
  }

  /**
   * Run a callback repeatedly through {@link interval}.
   * @param callback - Work to run on each tick.
   * @param delay - Interval in milliseconds.
   * @returns Disposer that stops the interval early.
   * @deprecated Use `ctx.interval()` instead.
   */
  setInterval(callback: () => void, delay: number): () => void {
    return this.interval(callback, delay)
  }

  /**
   * Run a callback once after a delay.
   * @param callback - work to run.
   * @param delay - delay in milliseconds.
   * @returns disposer that cancels the callback.
   */
  timeout(callback: () => void, delay: number): () => void
  /**
   * Wait for a delay.
   * @param delay - delay in milliseconds.
   * @returns promise resolved after the delay.
   */
  timeout(delay: number): Promise<void>
  timeout(...args: unknown[]): (() => void) | Promise<void> {
    const first = args[0]
    const callback = typeof first === 'function' ? () => { Reflect.apply(first, undefined, []) } : undefined
    const delay = callback === undefined ? first : args[1]
    if (typeof delay !== 'number') throw new TypeError('timer delay must be a number')
    if (callback !== undefined) {
      const dispose = this.ctx.effect(() => {
        const timer = globalThis.setTimeout(() => {
          void dispose()
          callback()
        }, delay)
        return () => { globalThis.clearTimeout(timer) }
      }, 'ctx.timeout()')
      return dispose
    }

    const { promise, resolve, reject } = deferred<void>()
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setTimeout(() => resolve(undefined), delay)
      return () => {
        globalThis.clearTimeout(timer)
        reject(new Error('Context has been disposed'))
      }
    }, 'ctx.timeout()')
    return promise.finally(() => { void dispose() })
  }

  /**
   * Run a callback repeatedly.
   * @param callback - work to run on each tick.
   * @param delay - interval in milliseconds.
   * @returns disposer that stops the interval.
   */
  interval(callback: () => void, delay: number): () => void
  /**
   * Iterate over timer ticks.
   * @param delay - interval in milliseconds.
   * @returns async iterator of ticks.
   */
  interval(delay: number): AsyncIterableIterator<void, unknown, void>
  interval(...args: unknown[]): (() => void) | AsyncIterableIterator<void, unknown, void> {
    const first = args[0]
    const callback = typeof first === 'function' ? () => { Reflect.apply(first, undefined, []) } : undefined
    const delay = callback === undefined ? first : args[1]
    if (typeof delay !== 'number') throw new TypeError('timer delay must be a number')
    if (callback !== undefined) {
      return this.ctx.effect(() => {
        const timer = globalThis.setInterval(callback, delay)
        return () => { globalThis.clearInterval(timer) }
      }, 'ctx.interval()')
    }

    let done: { kind: 'return'; value: unknown } | { kind: 'throw'; reason: unknown } | undefined
    let nextTask: Deferred<IteratorResult<void, unknown>> | undefined
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setInterval(() => {
        nextTask?.resolve({ done: false, value: undefined })
      }, delay)
      return () => {
        globalThis.clearInterval(timer)
        if (done !== undefined) return
        done = { kind: 'throw', reason: new Error('Context has been disposed') }
        nextTask?.reject(done.reason)
      }
    }, 'ctx.interval()')
    return {
      next: () => {
        if (done === undefined) return (nextTask = deferred<IteratorResult<void, unknown>>()).promise
        if (done.kind === 'return') return Promise.resolve({ done: true, value: done.value })
        return Promise.reject(done.reason)
      },
      return: (value: unknown) => {
        if (done === undefined) done = { kind: 'return', value }
        nextTask?.resolve({ done: true, value })
        void dispose()
        return Promise.resolve({ done: true, value })
      },
      throw: (reason: unknown) => {
        if (done === undefined) done = { kind: 'throw', reason }
        nextTask?.reject(reason)
        void dispose()
        return Promise.resolve({ done: true, value: undefined })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    } satisfies AsyncIterableIterator<void, unknown, void>
  }

  /** Build a delayed wrapper whose pending callback belongs to the calling Fiber. */
  private schedule<Args extends unknown[]>(label: string, trigger: (args: Args, disposed: boolean) => number | undefined, disposed = false): WithDispose<(...args: Args) => void> {
    let timer: number | undefined
    const dispose = this.ctx.effect(() => () => {
      disposed = true
      globalThis.clearTimeout(timer)
    }, label)
    const wrapper = (...args: Args): void => {
      globalThis.clearTimeout(timer)
      timer = trigger(args, disposed)
    }
    wrapper.dispose = dispose
    return wrapper
  }

  /**
   * Return a throttled function whose timer is disposed with the calling Fiber.
   * @param callback - Function to throttle.
   * @param delay - Minimum interval between calls in milliseconds.
   * @param noTrailing - Whether to suppress a delayed trailing call.
   * @returns Throttled function with an early disposer.
   */
  throttle<Args extends unknown[]>(callback: (...args: Args) => void, delay: number, noTrailing?: boolean): WithDispose<typeof callback> {
    let lastCall = -Infinity
    const execute = (...args: Args): void => {
      lastCall = Date.now()
      callback(...args)
    }
    return this.schedule('ctx.throttle()', (args, disposed) => {
      const remaining = delay - Date.now() + lastCall
      if (remaining <= 0) {
        execute(...args)
      } else if (!disposed) {
        return globalThis.setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  /**
   * Return a debounced function whose timer is disposed with the calling Fiber.
   * @param callback - Function to debounce.
   * @param delay - Quiet period in milliseconds.
   * @returns Debounced function with an early disposer.
   */
  debounce<Args extends unknown[]>(callback: (...args: Args) => void, delay: number): WithDispose<typeof callback> {
    return this.schedule('ctx.debounce()', (args, disposed) => {
      if (disposed) return
      return globalThis.setTimeout(callback, delay, ...args)
    })
  }
}

/**
 * Install the browser timer Service on one Client composition.
 * @param ctx - Client context that owns the Service and mixed-in helpers.
 * @returns Nothing after registering the Service.
 */
export function provideClientTimer(ctx: Context): void {
  new ClientTimerService(ctx)
}
