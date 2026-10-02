/**
 * The browser twin of the tool-cordis context facade: a whitelist of
 * lifecycle-safe verbs plus optional `ctx.get()` lookup and declared-service
 * property access, with
 * framework internals withheld and Context-valued returns denied. Two seats
 * carry extra machinery: `slots`, where the register proxy assigns the
 * shadowing priority and ledgers the registration — invoking the service with
 * the traced receiver so the effect lands on the CALLING plugin's fiber
 * (SlotRegistry.register must stay a prototype method for exactly that
 * reason) — and `theme`, whose override source is pinned to the package id.
 *
 * This is API discipline, not a security boundary: a dynamic package's code is
 * as trusted as the host process that accepted its definition.
 */

import { Context } from '@xharness/cordis'
import { isRecord } from '../client-runtime/value-guards'
import type { DynamicCordisPackage } from './wire'

/** Facade verbs beyond declared services (host CTX_VERBS twin). */
const CTX_VERBS = new Set([
  'effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/** One package's slot-registration ledger row (contribution projection source). */
export interface DynamicCordisSlotLedgerRow {
  /** Target slot name. */
  slot: string
  /** The assigned shadowing priority (globally unique — how winners are matched back to packages). */
  priority: number | undefined
}

/** What the facade needs beyond the real ctx to govern one package. */
export interface DynamicCordisGuardEnv {
  /** The dispatched Package row. */
  pkg: DynamicCordisPackage
  /** Ledger sink: every slot registration this package makes. */
  ledger: DynamicCordisSlotLedgerRow[]
  /**
   * Ownership index sink: the component object seated in a slot, so a later
   * render crash reported against the stored entry can be attributed back to
   * this package. Identity is the key — the registry stores the component
   * verbatim — which is why nothing else has to be remembered about the entry.
   * @param component - whatever the package passed as its component.
   */
  claim(component: unknown): void
  /** Allocate one page-local shadowing rank; later registrations sort first. */
  allocatePriority(): number
  /** Report one post-activation guard rejection to the owning Agent. */
  reportFailure(error: Error): void
}

/** Reject any service return that is a cordis Context (host guard twin). */
function denyContext(value: unknown, service: string, env: DynamicCordisGuardEnv): unknown {
  if (value instanceof Context) {
    return rejectGuard(env,
      `service "${service}" returned a cordis Context, which the dynamic facade does not expose. `
      + 'Operate through your own plugin ctx and the services you declared — never another context.',
    )
  }
  return value
}

/**
 * Forward service methods with the traced service as receiver — `this.ctx`
 * inside prototype methods (slots.register) must stay the CALLER's ctx so
 * effects land on the calling plugin's fiber — while denying Context returns.
 */
function guardedService(service: object, name: string, env: DynamicCordisGuardEnv): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return denyContext(value, name, env)
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args)
        if (result instanceof Promise) return result.then((resolved: unknown) => denyContext(resolved, name, env))
        return denyContext(result, name, env)
      }
    },
  })
}

/** Erased register options as this facade reads and rewrites them. */
interface ErasedSlotOptions {
  name?: string
  priority?: number
  [key: string]: unknown
}

/**
 * The slots seat: automatic shadowing priority and ledger recording around the
 * traced service's own register.
 */
function guardedSlots(slots: object, env: DynamicCordisGuardEnv): unknown {
  return new Proxy(slots, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (prop !== 'register') {
        if (typeof value !== 'function') return denyContext(value, 'slots', env)
        return (...args: unknown[]): unknown => denyContext(Reflect.apply(value, target, args), 'slots', env)
      }
      return (rawOptions: unknown, component: unknown): unknown => {
        if (!isRecord(rawOptions)) {
          return rejectGuard(env, 'slots.register(options, component) needs an options object with a `name`')
        }
        const options = { ...rawOptions }
        const slot = options.name
        if (typeof slot !== 'string' || slot.length === 0) {
          return rejectGuard(env, 'slots.register options need a string `name` (the target slot key)')
        }
        if (slot === 'tool.view.cordis') {
          if (options.key !== 'self') {
            return rejectGuard(env, 'tool.view.cordis only accepts key "self"; the runtime binds it to this Package')
          }
          options.key = `${env.pkg.pluginId}.${env.pkg.packageId}`
        }
        // Shadowing kinds get a page-local rank. Later registrations sort first;
        // chain slots keep their own election (select order) untouched.
        const spec = invoke(slots, 'spec', [slot])
        let priority = typeof options.priority === 'number' ? options.priority : undefined
        if (!isRecord(spec) || spec.kind !== 'chain') {
          priority = env.allocatePriority()
          options.priority = priority
        }
        const dispose = invoke(target, 'register', [options, component])
        if (typeof dispose !== 'function') throw new Error('slots.register did not return a disposer')
        env.ledger.push({ slot, priority })
        // After the registry accepted it: a rejected registration seats no entry,
        // so claiming one would index a component no crash can ever name.
        env.claim(component)
        return dispose
      }
    },
  })
}

/**
 * The theme seat: `overrideTokens`' source is FORCED to the package id — a
 * dynamic package can never impersonate (or evict) another source's layer, and
 * its own layers converge under one identity unload can reason about. The
 * layer's disposer is additionally hung on the calling fiber, because the
 * documented contract is "unload restores" and model code cannot be trusted to
 * keep the returned handle (slots parity — register hangs its own cleanup).
 * Everything else forwards through the generic guard.
 */
function guardedTheme(theme: object, env: DynamicCordisGuardEnv, ctx: Context): unknown {
  return new Proxy(theme, {
    get(target, prop) {
      if (prop !== 'overrideTokens') {
        const value: unknown = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return denyContext(value, 'theme', env)
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args)
          if (result instanceof Promise) return result.then((resolved: unknown) => denyContext(resolved, 'theme', env))
          return denyContext(result, 'theme', env)
        }
      }
      return (source: unknown, tokens: unknown): unknown => {
        // Two-argument shape preserved so the facade matches the documented
        // service signature; the source VALUE is replaced, never trusted.
        if (tokens === undefined && typeof source === 'object' && source !== null) {
          return rejectGuard(env,
            'theme.overrideTokens(source, tokens) takes two arguments; source is replaced with your package id, '
            + 'so pass any string first and the token map second: overrideTokens(\'mine\', { \'--dsw-alias-…\': { light: \'…\', dark: \'…\' } })',
          )
        }
        const dispose = invoke(target, 'overrideTokens', [`${env.pkg.pluginId}.${env.pkg.packageId}`, tokens])
        if (typeof dispose !== 'function') throw new Error('theme.overrideTokens did not return a disposer')
        // Fiber-owned lifetime; the returned handle stays valid for early
        // removal (the service disposer is idempotent per layer identity).
        ctx.effect(() => () => { Reflect.apply(dispose, undefined, []) }, 'cordis-client-runner: dynamic theme override layer')
        return dispose
      }
    },
  })
}

/**
 * Build the facade one dynamic plugin's `apply` receives (host sandboxContext
 * twin, browser seats). `ctx.get(name)` performs optional lookup; direct
 * `ctx.serviceName` access is gated by the fiber's `inject` declaration.
 * @param ctx - the plugin's real fiber ctx (loader-created).
 * @param env - package row + ledger sink.
 * @returns the whitelisting proxy standing in for ctx.
 */
export interface DynamicCordisContext {
  readonly [name: string]: unknown
}

export function dynamicCordisContext(ctx: Context, env: DynamicCordisGuardEnv): DynamicCordisContext {
  const declared = new Set(Object.keys(ctx.fiber.inject))
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(env,
        `service "${prop}" is not declared by your plugin. Declare it on the plugin you return: `
        + `{ inject: ['${prop}', …], apply(ctx) { … } } — a plain \`function\` has no declaration site, `
        + 'so use the object form. The runtime then parks the package if the provider unloads.',
      )
    }
    return rejectGuard(env,
      `dynamic ctx does not expose "${prop}". Available: ctx.on / ctx.provide / timer helpers after injecting timer, and any service your `
      + 'returned plugin declared in inject (slots and theme are the usual UI seats). Framework internals are withheld '
      + 'by design.',
    )
  }
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const raw: unknown = ctx.get(name)
    const service = denyContext(raw, name, env)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    if (name === 'slots') return guardedSlots(service, env)
    if (name === 'theme') return guardedTheme(service, env, ctx)
    return guardedService(service, name, env)
  }
  return new Proxy<DynamicCordisContext>({}, {
    get(_target, prop) {
      if (prop === 'get') return (name: string): unknown => readService(name, false)
      if (typeof prop !== 'string') return undefined
      // Lazy verb forwarder (host twin): resolve ctx[verb] only when called.
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          return invoke(ctx, prop, args)
        }
      }
      return readService(prop, true)
    },
    set(_target, prop) {
      return rejectGuard(env, `dynamic ctx is read-only; cannot assign "${String(prop)}"`)
    },
    has: (_target, prop) => prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  })
}

function rejectGuard(env: DynamicCordisGuardEnv, message: string): never {
  const error = new Error(message)
  env.reportFailure(error)
  throw error
}

function invoke(receiver: object, name: string, args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(receiver, name, receiver)
  if (typeof method !== 'function') throw new Error(`dynamic service method ${name} is not callable`)
  const result: unknown = Reflect.apply(method, receiver, args)
  return result
}
