// Generated from src/modules/client-modules/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-modules",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-modules/index.js": function(module, exports, require) {
// source: src/modules/client-modules/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripClientSuffix = exports.parseBootManifest = exports.ClientModuleSystem = void 0;
exports.createClientModuleSystem = createClientModuleSystem;
exports.apply = apply;
const system_1 = require("./system");
Object.defineProperty(exports, "ClientModuleSystem", { enumerable: true, get: function () { return system_1.ClientModuleSystem; } });
const manifest_1 = require("./manifest");
var manifest_2 = require("./manifest");
Object.defineProperty(exports, "parseBootManifest", { enumerable: true, get: function () { return manifest_2.parseBootManifest; } });
Object.defineProperty(exports, "stripClientSuffix", { enumerable: true, get: function () { return manifest_2.stripClientSuffix; } });
let moduleSystem;
/**
 * Build the live module system from the HTML facade's materialized modules bundle.
 * @param target - Stable registration facade whose pending queue becomes the live sink.
 * @param bootstrapModule - This bundle's id and already-materialized exports.
 * @param options - Raw boot graph, platform seed, and optional bundle transport.
 * @returns The created module system, also published for this package's Cordis plugin face.
 */
function createClientModuleSystem(target, bootstrapModule, options) {
    moduleSystem = new system_1.ClientModuleSystem({
        manifest: (0, manifest_1.parseBootManifest)(options.boot),
        staticModules: options.staticModules,
        registrationTarget: target,
        bootstrapModule,
        ...(options.loadBundle === undefined ? {} : { loadBundle: options.loadBundle }),
    });
    return moduleSystem;
}
/**
 * Enroll the kernel-built module system as `ctx.modules`.
 * @param ctx - client root context.
 */
function apply(ctx) {
    if (moduleSystem === undefined) {
        throw new Error('client-modules: createClientModuleSystem must run before plugin boot');
    }
    ctx.reflect.provide('modules', moduleSystem);
}

},
"src/modules/client-modules/system.js": function(module, exports, require) {
// source: src/modules/client-modules/system.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientModuleSystem = void 0;
/**
 * ClientModuleSystem — the implementation behind the {@link ClientModuleLoader}
 * contract. The conceptual contract (lazy CJS model, resolution branch order) is
 * documented on the public interfaces in `./manifest`; this file owns the
 * state tables and the load/materialize machinery.
 */
const manifest_1 = require("./manifest");
/** Default bundle-load hook: same-origin external classic script. */
const defaultLoadBundle = (url) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.async = true;
    el.src = url;
    el.addEventListener('load', () => {
        el.remove();
        resolve();
    }, { once: true });
    el.addEventListener('error', () => {
        el.remove();
        reject(new Error(`client-modules: bundle script ${url} failed to load`));
    }, { once: true });
    document.head.append(el);
});
/**
 * Claim and inventory the <style> tags a factory injected during
 * materialization: preset-emitted tags arrive pre-tagged with data-plugin;
 * any untagged tag is claimed for the materializing plugin (HMR bookkeeping).
 */
const claimStyles = (id) => {
    if (typeof document === 'undefined')
        return [];
    for (const el of document.querySelectorAll('style:not([data-plugin])')) {
        el.setAttribute('data-plugin', id);
    }
    const owned = [];
    for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
        owned.push(el.getAttribute('data-plugin-css') ?? id);
    }
    return owned;
};
/**
 * The client module system: state tables plus the arrival/materialization
 * machinery implementing {@link ClientModuleLoader} (whose members carry the
 * contract documentation). Construction indexes the boot rows, retains the
 * already-materialized bootstrap module, and switches the HTML-installed
 * loader facade from its pending queue to live registration.
 */
class ClientModuleSystem {
    /**
     * Build the module system over the parsed boot rows.
     * @param options - Parsed graph, platform seed, bootstrap module, registration facade, and transport.
     */
    constructor(options) {
        this.version = 'client';
        this.loadCache = new Map();
        this.factories = new Map();
        this.bootstrapIds = new Set();
        /** In-flight prefetch (script load) per id; concurrent callers share it. */
        this.pendingArrival = new Map();
        /** Materialization re-entrancy guard: factory-form CJS cannot deliver partial exports, so a cycle is fatal. */
        this.materializing = new Set();
        this.graphRows = new Map();
        this.manifest = options.manifest;
        this.seed = new Map(Object.entries(options.staticModules));
        this.loadBundle = options.loadBundle ?? defaultLoadBundle;
        for (const row of options.manifest.modules) {
            if (this.graphRows.has(row.id))
                throw new Error(`client-modules: duplicate graph entry "${row.id}"`);
            this.graphRows.set(row.id, row);
        }
        const bootstrapId = (0, manifest_1.stripClientSuffix)(options.bootstrapModule.id);
        this.bootstrapIds.add(bootstrapId);
        this.loadCache.set(bootstrapId, {
            id: bootstrapId,
            exports: options.bootstrapModule.exports,
            styles: [],
            edges: new Set(),
        });
        const target = options.registrationTarget;
        if (target.mode !== 'queue') {
            throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot');
        }
        const pending = target.pendingQueue.splice(0);
        // Switch first: a bundle that executes while pending registrations drain
        // must register live rather than append behind the drain.
        target.mode = 'live';
        target.load = (registration) => { this.register(registration); };
        for (const registration of pending)
            target.load(registration);
    }
    /** Register one bundle factory, rejecting a script that executes twice without invalidation. */
    register(registration) {
        const id = (0, manifest_1.stripClientSuffix)(registration.id);
        if (this.bootstrapIds.has(id) || this.factories.has(id)) {
            throw new Error(`client-modules: duplicate factory registration for "${registration.id}" (bundle executed twice without invalidate?)`);
        }
        this.factories.set(id, registration.factory);
    }
    /** Load one graph row so its factory is registered (idempotent per in-flight arrival). */
    arrive(row) {
        const { id, url } = row;
        const pending = this.pendingArrival.get(id);
        if (pending !== undefined)
            return pending;
        if (this.loadCache.has(id) || this.factories.has(id))
            return Promise.resolve();
        const task = this.loadBundle(url).then(() => {
            if (!this.factories.has(id)) {
                throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
            }
        }).finally(() => { this.pendingArrival.delete(id); });
        this.pendingArrival.set(id, task);
        return task;
    }
    /** Register each unresolved dynamic request before registering its consumer. */
    async arriveGraphRow(row, open = []) {
        const cycleStart = open.indexOf(row.id);
        if (cycleStart !== -1) {
            throw new Error(`client-modules: module arrival cycle ${[...open.slice(cycleStart), row.id].join(' -> ')} `
                + '(the host must reject this graph before serving it)');
        }
        const next = [...open, row.id];
        for (const request of row.external) {
            const id = (0, manifest_1.stripClientSuffix)(request);
            if (this.seed.has(request) || this.loadCache.has(id))
                continue;
            const dependency = this.graphRows.get(id);
            if (dependency !== undefined)
                await this.arriveGraphRow(dependency, next);
        }
        await this.arrive(row);
    }
    /** Materialize a registered factory (synchronous; memoized in loadCache). */
    materialize(id) {
        const existing = this.loadCache.get(id);
        if (existing !== undefined)
            return existing;
        const registered = this.factories.get(id);
        /* v8 ignore next -- callers check the factory branch before dispatching here. */
        if (registered === undefined)
            throw new Error(`client-modules: no registered factory for "${id}"`);
        if (this.materializing.has(id)) {
            throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`);
        }
        this.materializing.add(id);
        try {
            const edges = new Set();
            const exports = registered(this.makeRequire(edges));
            const record = { id, exports, styles: claimStyles(id), edges };
            this.loadCache.set(id, record);
            return record;
        }
        finally {
            this.materializing.delete(id);
        }
    }
    /**
     * The synchronous require answered to factories: seed → memoized record →
     * registered factory. Fetching is async and therefore unreachable
     * from here; an external dynamic package must have arrived before its
     * consumer materializes.
     */
    makeRequire(edges) {
        return (spec) => {
            edges.add(spec);
            if (this.seed.has(spec))
                return this.seed.get(spec);
            const id = (0, manifest_1.stripClientSuffix)(spec);
            const record = this.loadCache.get(id);
            if (record !== undefined)
                return record.exports;
            if (this.factories.has(id))
                return this.materialize(id).exports;
            throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, `
                + 'and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)');
        };
    }
    async import(specifier) {
        if (this.seed.has(specifier))
            return this.seed.get(specifier);
        const id = (0, manifest_1.stripClientSuffix)(specifier);
        const existing = this.loadCache.get(id);
        if (existing !== undefined)
            return existing.exports;
        const row = this.graphRows.get(id);
        if (row !== undefined) {
            await this.arriveGraphRow(row);
        }
        else if (!this.factories.has(id)) {
            throw new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, `
                + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)');
        }
        return this.materialize(id).exports;
    }
    async prefetch(id) {
        const normalized = (0, manifest_1.stripClientSuffix)(id);
        if (this.loadCache.has(normalized))
            return;
        const row = this.graphRows.get(normalized);
        if (row === undefined)
            throw new Error(`client-modules: prefetch("${id}") — not a graph entry`);
        await this.arriveGraphRow(row);
    }
    invalidate(id) {
        const normalized = (0, manifest_1.stripClientSuffix)(id);
        if (this.bootstrapIds.has(normalized))
            return;
        this.factories.delete(normalized);
        this.loadCache.delete(normalized);
    }
}
exports.ClientModuleSystem = ClientModuleSystem;

},
"src/modules/client-modules/manifest.js": function(module, exports, require) {
// source: src/modules/client-modules/manifest.ts

"use strict";
/**
 * Client module system: the browser peer of Node's internal ESM loader, built
 * as a lazy CJS table. The vendored cordis Loader consumes this object
 * through its `internal` contract (the only call site is `EntryTree.import` →
 * `internal.import`), which keeps entry governance (fiber lifecycle, inject
 * waiting, update/refresh) entirely on the vendored side while this package
 * owns code arrival.
 *
 * Lazy CJS model: executing a plugin bundle only REGISTERS its
 * factory (`window.__ModuleLoader__.load({id, factory})`); every module body
 * side effect — including CSS injection — lives inside the factory closure
 * and runs at materialization, not at script execution. Materialization
 * (factory(require) → exports) happens on first import/require and is
 * memoized in {@link ClientModuleLoader.loadCache}; a factory that requires
 * another registered-but-unmaterialized module materializes it recursively,
 * so load order needs no external sequencing.
 *
 * Resolution branch order (import): seed word → shell instance; memoized
 * record → exports; graph row → register its dependency factories and own
 * factory; registered factory → materialize; anything else → throw (loud —
 * the runtime mirror of the build-time bundle purity gate).
 * The synchronous `require` handed to factories walks the same order minus
 * the load branch. Loading is async, so a requested dynamic package must have
 * registered its factory before a consumer materializes.
 *
 * This file is the browser-safe contract face (zero node imports): the
 * `__DSH_BOOT__` wire types, the boot-manifest parser, and the boundaries around
 * {@link ClientModuleSystem}. The package root is the host-side service that
 * composes the wire.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalStringArray = optionalStringArray;
exports.stripClientSuffix = stripClientSuffix;
exports.parseBootManifest = parseBootManifest;
/** Structural guards keep untrusted Host wire values unknown until checked. */
function isObjectRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isUnknownArray(value) { return Array.isArray(value); }
function isStringArray(value) {
    return isUnknownArray(value) && value.every(item => typeof item === 'string');
}
/**
 * Validate an optional string-array field read from a `dsh.client` declaration
 * or from the boot wire.
 * @param subject - diagnostic prefix naming the package or the wire row.
 * @param field - field name as it appears in the diagnostic.
 * @param value - the raw field value.
 * @returns the validated array, or undefined when the field is absent.
 * @throws {Error} when the value is present but is not an array of strings.
 */
function optionalStringArray(subject, field, value) {
    if (value === undefined)
        return undefined;
    if (!isStringArray(value)) {
        throw new Error(`client-modules: ${subject} ${field} must be a string array`);
    }
    return value;
}
/**
 * Normalize a module specifier onto the graph row that owns it: a plugin bundle
 * IS its package's client half, so `<id>/client` (the exports subpath external
 * bundles emit) and the bare package name resolve to the same exports. Both the
 * require path and graph composition normalize here, which is what lets each
 * importing package request the subpath its own code imports.
 * @param spec - module specifier as a bundle requires it or a declaration spells it.
 * @returns the specifier with a trailing `/client` removed.
 */
function stripClientSuffix(spec) {
    return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec;
}
/**
 * Parse `window.__DSH_BOOT__` into the two consumer views. Wire boundary:
 * a missing or malformed graph throws (the shell shows the loud failure —
 * a page without a valid manifest cannot boot anything).
 * @param wire - the raw `window.__DSH_BOOT__` value.
 * @returns the manifest with optional plugin-view fields normalized.
 */
function parseBootManifest(wire) {
    if (!isObjectRecord(wire)) {
        throw new Error('client-modules: window.__DSH_BOOT__ is missing or not an object');
    }
    const graph = wire;
    if (typeof graph.rev !== 'string') {
        throw new Error('client-modules: boot manifest rev must be a string');
    }
    if (!isUnknownArray(graph.entries)) {
        throw new Error('client-modules: boot manifest entries must be an array');
    }
    const modules = [];
    const plugins = [];
    for (const value of graph.entries) {
        if (!isObjectRecord(value)) {
            throw new Error('client-modules: boot manifest entry is not an object');
        }
        const row = value;
        const where = typeof row.id === 'string' ? `"${row.id}"` : JSON.stringify(row);
        if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
            throw new Error(`client-modules: boot manifest entry ${where} must carry string id/url/rev`);
        }
        const subject = `boot manifest entry ${where}`;
        const inject = optionalStringArray(subject, 'inject', row.inject);
        const external = optionalStringArray(subject, 'external', row.external);
        if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
            throw new Error(`client-modules: boot manifest entry ${where} immediately must be a boolean`);
        }
        modules.push({
            id: row.id,
            url: row.url,
            rev: row.rev,
            external: external === undefined ? [] : [...external],
        });
        plugins.push({
            id: row.id,
            inject: inject === undefined ? [] : [...inject],
            immediately: row.immediately === true,
        });
    }
    return { rev: graph.rev, modules, plugins };
}

}
};
const __dependencies = {"src/modules/client-modules/index.js":{"./system":"src/modules/client-modules/system.js","./manifest":"src/modules/client-modules/manifest.js"},"src/modules/client-modules/system.js":{"./manifest":"src/modules/client-modules/manifest.js"},"src/modules/client-modules/manifest.js":{}};
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
return __load("src/modules/client-modules/index.js");
}
});
