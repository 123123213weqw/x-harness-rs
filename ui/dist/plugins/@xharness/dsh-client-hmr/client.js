// Generated from src/modules/client-hmr/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-hmr",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-hmr/index.js": function(module, exports, require) {
// source: src/modules/client-hmr/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = exports.EVENTS_ENDPOINT = void 0;
exports.apply = apply;
const events_1 = require("./events");
var events_2 = require("./events");
Object.defineProperty(exports, "EVENTS_ENDPOINT", { enumerable: true, get: function () { return events_2.EVENTS_ENDPOINT; } });
/** Cordis plugin name. */
exports.name = 'client-hmr';
/** Required services: the vendored Loader (entry governance) and the client module system (boot provide, service name `modules`). */
exports.inject = ['loader', 'modules'];
/** Find the loader entry whose module specifier is `id` (entry tree ids are random; the package name lives in `options.name`). */
function findEntry(loader, id) {
    for (const entry of loader.entries()) {
        if (entry.options.name === id)
            return entry;
    }
    return undefined;
}
/** Remove every `<style data-plugin>` tag owned by `id` (attribute compared verbatim — no CSS-selector escaping pitfalls). */
function removeOwnedStyles(id) {
    for (const el of document.querySelectorAll('style[data-plugin]')) {
        if (el.getAttribute('data-plugin') === id)
            el.remove();
    }
}
/**
 * Mount the HMR driver: subscribe to the system SSE channel and hot-swap
 * rebuilt entries.
 * @param ctx - plugin context with `loader` and `modules` available.
 */
function apply(ctx) {
    // Both are declared injections (typed Context merges: `modules` from the
    // client module loader package, `loader` from the vendored Loader).
    const modLoader = ctx.modules;
    const loader = ctx.loader;
    async function reload(id) {
        const entry = findEntry(loader, id);
        if (entry === undefined) {
            ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`);
            return;
        }
        // Invalidate first (drop stale factory + record — a live factory makes
        // prefetch a no-op and re-registration a loud duplicate), then run the
        // async half while the old fiber still serves: script loading registers
        // the fresh factory with zero side effects (lazy CJS — module bodies run
        // at materialization, not execution).
        modLoader.invalidate(id);
        await modLoader.prefetch(id);
        const oldFiber = entry.fiber;
        if (oldFiber !== undefined) {
            // Registry-first teardown (see module comment): the runtime record must
            // be gone before the fiber's disposer emits internal/plugin, or the
            // Loader flags the entry disabled.
            const runtime = oldFiber.runtime;
            if (runtime !== null)
                entry.ctx.registry.delete(runtime.callback);
            // Drain the unload: effect disposers (slots, subscriptions) must finish
            // before the new bundle executes and the new apply re-registers.
            while (oldFiber.inertia !== undefined)
                await oldFiber.inertia;
            delete entry.fiber;
        }
        // Old owned styles go before materialization re-injects them (the CSS
        // idempotency guard keys on stable tag ids).
        removeOwnedStyles(id);
        // Re-init through the entry: fiber cleared above, so refresh() re-imports
        // — materializing the prefetched factory (CSS injects here) — and
        // re-plugins under the entry context. Import failures are logged by
        // Entry._init and leave the entry fiberless (retryable).
        await entry.refresh();
        // Surface apply failures loudly (no rollback, FAILED state stays).
        await entry.fiber?.await();
    }
    // Serialize reloads: frames can arrive faster than a swap completes, and
    // interleaved dispose/execute chains would corrupt the single-slot handoff.
    let queue = Promise.resolve();
    const handle = (frame) => {
        switch (frame.type) {
            case 'rebuilt':
                queue = queue.then(() => reload(frame.id)).catch((error) => {
                    ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`);
                    ctx.logger.error(error);
                });
                break;
            case 'graph':
                // Connect-time snapshot, unused. The loader's cached graph rev
                // goes stale after rebuilds — harmless, since prefetch hits the
                // network anyway (host serves bundles no-cache); graph rev refresh
                // lands with the reconnect-handshake mechanism.
                break;
            default:
                // Merge-extensible frame union: unknown frame types from newer hosts
                // are ignored by design.
                break;
        }
    };
    ctx.effect(() => {
        const source = new EventSource(events_1.EVENTS_ENDPOINT);
        source.addEventListener('message', (event) => {
            let value;
            try {
                value = JSON.parse(event.data);
            }
            catch {
                // Wire boundary: a malformed dev-channel frame is dropped loudly.
                ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`);
                return;
            }
            const frame = (0, events_1.parsePluginsEventFrame)(value);
            if (frame === undefined) {
                ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`);
                return;
            }
            handle(frame);
        });
        return () => { source.close(); };
    }, 'client-hmr: event source');
}

},
"src/modules/client-hmr/events.js": function(module, exports, require) {
// source: src/modules/client-hmr/events.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENTS_ENDPOINT = void 0;
exports.parsePluginsEventFrame = parsePluginsEventFrame;
const value_guards_1 = require("../client-runtime/value-guards");
exports.EVENTS_ENDPOINT = '/plugins/events';
function parsePluginsEventFrame(value) {
    if (!(0, value_guards_1.isRecord)(value))
        return undefined;
    const frame = value;
    if (frame.type === 'graph')
        return { type: 'graph', graph: frame.graph };
    if (frame.type === 'rebuilt' && typeof frame.id === 'string' && typeof frame.rev === 'string') {
        return { type: 'rebuilt', id: frame.id, rev: frame.rev };
    }
    return undefined;
}

},
"src/modules/client-runtime/value-guards.js": function(module, exports, require) {
// source: src/modules/client-runtime/value-guards.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRecord = isRecord;
exports.isUnknownArray = isUnknownArray;
exports.isUnknownMap = isUnknownMap;
exports.isUnknownSet = isUnknownSet;
/** Open JSON/event boundaries stay unknown until their consumed shape is checked. */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isUnknownArray(value) { return Array.isArray(value); }
function isUnknownMap(value) { return value instanceof Map; }
function isUnknownSet(value) { return value instanceof Set; }

}
};
const __dependencies = {"src/modules/client-hmr/index.js":{"./events":"src/modules/client-hmr/events.js"},"src/modules/client-hmr/events.js":{"../client-runtime/value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/value-guards.js":{}};
const __cache = Object.create(null);
const __load = id => {
  if (__cache[id]) return __cache[id].exports;
  const unit = __units[id];
  if (!unit) throw Error('Unknown local UI module: ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  try {
    unit(module, module.exports, request => Object.prototype.hasOwnProperty.call(__dependencies[id], request)
      ? __load(__dependencies[id][request]) : __externalRequire(request));
  } catch (error) { delete __cache[id]; throw error; }
  return module.exports;
};
return __load("src/modules/client-hmr/index.js");
}
});
