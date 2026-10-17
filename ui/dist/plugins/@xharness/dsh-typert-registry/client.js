// Generated from src/modules/typert-registry/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-typert-registry",
factory: (__externalRequire) => {
const __units = {
"src/modules/typert-registry/index.js": function(module, exports, require) {
// source: src/modules/typert-registry/index.ts

"use strict";
/** Browser face of the shared Typert runtime registry. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const service_1 = require("./service");
/** Required services: none; this is the Client reflection root. */
exports.inject = [];
/**
 * Install the same registry implementation used by the Host face.
 * @param ctx - Client Cordis root.
 */
function apply(ctx) {
    new service_1.TypertRegistry(ctx);
}

},
"src/modules/typert-registry/service.js": function(module, exports, require) {
// source: src/modules/typert-registry/service.ts

"use strict";
/**
 * Runtime registry for generated Typert reflection, Remote invocations, and
 * dependency-inverted lookup/Context providers. It performs no TypeScript
 * analysis or schema generation.
 * @module @xharness/dsh-typert-registry
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypertRegistry = void 0;
exports.typertKey = typertKey;
exports.typertPackageKey = typertPackageKey;
exports.typertEndpoint = typertEndpoint;
const context_1 = require("./context");
const zod_1 = require("zod");
/**
 * Compose the global key of one generated schema.
 * @param packageName - contributing npm package.
 * @param name - schema export name.
 * @returns `<package>#<name>`.
 */
function typertKey(packageName, name) {
    return `${packageName}#${name}`;
}
/**
 * Compose the identity of one package-face model.
 * @param packageName - contributing npm package.
 * @param face - independently compiled face.
 * @returns `<package>#<face>`.
 */
function typertPackageKey(packageName, face) {
    return `${packageName}#${face}`;
}
/**
 * Compose the endpoint key used by local and Remote invocation registries.
 * @param descriptor - invocation whose namespace and method form the endpoint.
 * @returns `<namespace>/<method>`.
 */
function typertEndpoint(descriptor) {
    return `${descriptor.namespace}/${descriptor.method}`;
}
class ChangeSource {
    constructor(report) {
        this.report = report;
        this.listeners = new Set();
    }
    subscribe(ctx, listener) {
        const { listeners } = this;
        return ctx.effect(function* () {
            listeners.add(listener);
            yield () => { listeners.delete(listener); };
        }, 'typert registry subscription');
    }
    emit(change) {
        for (const listener of [...this.listeners]) {
            try {
                listener(change);
            }
            catch (error) {
                this.report(change, error);
            }
        }
    }
}
class DescriptorStore {
    constructor(kind, report) {
        this.kind = kind;
        this.entries = new Map();
        this.ids = new Map();
        this.history = new Set();
        this.changes = new ChangeSource(report);
    }
    validate(descriptors) {
        const endpoints = new Set();
        const ids = new Set();
        for (const descriptor of descriptors) {
            validateInvocation(descriptor);
            const endpoint = typertEndpoint(descriptor);
            if (endpoints.has(endpoint) || this.entries.has(endpoint)) {
                throw new Error(`typert: ${this.kind} endpoint "${endpoint}" is already registered`);
            }
            if (ids.has(descriptor.id) || this.ids.has(descriptor.id)) {
                throw new Error(`typert: ${this.kind} invocation id "${descriptor.id}" is already registered`);
            }
            endpoints.add(endpoint);
            ids.add(descriptor.id);
        }
    }
    commit(owner, descriptors) {
        for (const descriptor of descriptors) {
            const entry = { descriptor, owner };
            const endpoint = typertEndpoint(descriptor);
            this.entries.set(endpoint, entry);
            this.ids.set(descriptor.id, entry);
            this.history.add(endpoint);
        }
        for (const descriptor of descriptors) {
            this.changes.emit({ kind: this.kind, key: typertEndpoint(descriptor) });
        }
    }
    withdraw(owner, descriptors) {
        const removed = [];
        for (const descriptor of descriptors) {
            const endpoint = typertEndpoint(descriptor);
            const entry = this.entries.get(endpoint);
            /* v8 ignore next -- duplicate registration is rejected, so no later owner can replace this entry before its effect disposes. */
            if (entry?.owner !== owner)
                continue;
            this.entries.delete(endpoint);
            /* v8 ignore next -- ids and endpoints are committed and withdrawn together under the same unique owner. */
            if (this.ids.get(descriptor.id) === entry)
                this.ids.delete(descriptor.id);
            removed.push(endpoint);
        }
        for (const endpoint of removed)
            this.changes.emit({ kind: this.kind, key: endpoint });
    }
    get(endpoint) {
        return this.entries.get(endpoint)?.descriptor;
    }
    hasSeen(endpoint) {
        return this.history.has(endpoint);
    }
    list() {
        return [...this.entries.values()].map(entry => entry.descriptor);
    }
    subscribe(ctx, listener) {
        return this.changes.subscribe(ctx, listener);
    }
}
class RemoteStore {
    constructor(descriptors) {
        this.descriptors = descriptors;
        this.packages = new Map();
    }
    view(ctx) {
        return {
            register: contribution => this.register(ctx, contribution),
            get: endpoint => this.descriptors.get(endpoint),
            list: () => this.descriptors.list(),
            subscribe: listener => this.descriptors.subscribe(ctx, listener),
        };
    }
    register(ctx, contribution) {
        validateSegment('Remote package name', contribution.package);
        if (this.packages.has(contribution.package)) {
            throw new Error(`typert: Remote package "${contribution.package}" is already registered`);
        }
        this.descriptors.validate(contribution.descriptors);
        const owner = {};
        const { packages, descriptors } = this;
        return ctx.effect(function* () {
            packages.set(contribution.package, owner);
            descriptors.commit(owner, contribution.descriptors);
            yield () => {
                /* v8 ignore else -- duplicate package registration is rejected, so this effect remains the package's unique owner. */
                if (packages.get(contribution.package) === owner)
                    packages.delete(contribution.package);
                descriptors.withdraw(owner, contribution.descriptors);
            };
        }, `typert.remotes.register(${JSON.stringify(contribution.package)})`);
    }
}
class LookupStore {
    constructor(report) {
        this.providers = new Map();
        this.resolvers = new Map();
        this.definitions = new Map();
        this.changes = new ChangeSource(report);
    }
    view(ctx) {
        return {
            register: (key, provider) => this.register(ctx, key, provider),
            configure: (key, resolver) => this.configure(ctx, key, resolver),
            get: key => this.get(key),
            definitions: () => [...this.definitions.values()],
            keys: () => [...this.providers.keys()],
            subscribe: listener => this.changes.subscribe(ctx, listener),
        };
    }
    get(key) {
        const provider = this.providers.get(key)?.provider;
        if (provider === undefined)
            return undefined;
        const resolver = this.resolvers.get(key)?.provider;
        if (resolver === undefined)
            return provider;
        return {
            parameter: provider.parameter,
            wire: provider.wire,
            hostTypeSymbol: provider.hostTypeSymbol,
            wireTypeSymbol: provider.wireTypeSymbol,
            resolve: id => resolver.resolve(id),
        };
    }
    configure(ctx, key, resolver) {
        validateSegment('lookup key', key);
        if (this.resolvers.has(key))
            throw new Error(`typert: lookup "${key}" resolver is already configured`);
        const owner = {};
        // Each registration accepts its declared Wire input; after heterogeneous
        // storage the registry intentionally exposes the existing unknown ABI.
        const entry = {
            provider: { resolve: async (id) => {
                    // Registration is typed; the registry's raw ABI deliberately keeps the
                    // invocation value unknown. The caller's existing parameter codec owns
                    // wire validation, not this map or a wireTypeSymbol string.
                    const result = Reflect.apply(resolver, undefined, [id]);
                    return await result;
                } },
            owner,
        };
        const { resolvers, changes } = this;
        return ctx.effect(function* () {
            resolvers.set(key, entry);
            changes.emit({ kind: 'lookup', key });
            yield () => {
                /* v8 ignore next -- duplicate configuration is rejected, so this effect remains the key's unique owner. */
                if (resolvers.get(key) !== entry)
                    return;
                resolvers.delete(key);
                changes.emit({ kind: 'lookup', key });
            };
        }, `typert.lookups.configure(${JSON.stringify(key)})`);
    }
    register(ctx, key, provider) {
        validateSegment('lookup key', key);
        validateSegment('lookup parameter', provider.parameter);
        validateWireName('lookup wire field', provider.wire);
        validateNonempty('lookup Host type symbol', provider.hostTypeSymbol);
        validateNonempty('lookup wire type symbol', provider.wireTypeSymbol);
        if (this.providers.has(key))
            throw new Error(`typert: lookup "${key}" is already registered`);
        const definition = {
            key,
            parameter: provider.parameter,
            wire: provider.wire,
            hostTypeSymbol: provider.hostTypeSymbol,
            wireTypeSymbol: provider.wireTypeSymbol,
        };
        const known = this.definitions.get(key);
        if (known !== undefined && !lookupDefinitionEquals(known, definition)) {
            throw new Error(`typert: lookup "${key}" changed its wire declaration during this registry lifetime`);
        }
        const owner = {};
        const entry = { provider, owner };
        const { definitions, providers, changes } = this;
        return ctx.effect(function* () {
            definitions.set(key, definition);
            providers.set(key, entry);
            changes.emit({ kind: 'lookup', key });
            yield () => {
                /* v8 ignore next -- duplicate registration is rejected, so this effect remains the key's unique owner. */
                if (providers.get(key) !== entry)
                    return;
                providers.delete(key);
                changes.emit({ kind: 'lookup', key });
            };
        }, `typert.lookups.register(${JSON.stringify(key)})`);
    }
}
function lookupDefinitionEquals(left, right) {
    return left.parameter === right.parameter
        && left.wire === right.wire
        && left.hostTypeSymbol === right.hostTypeSymbol
        && left.wireTypeSymbol === right.wireTypeSymbol;
}
class ContextStore {
    constructor(report) {
        this.hosts = new Map();
        this.hostResolvers = new Map();
        this.clients = new Map();
        this.changes = new ChangeSource(report);
    }
    view(ctx) {
        return {
            registerHost: (key, provider) => this.registerHost(ctx, key, provider),
            configureHost: (key, resolver) => this.configureHost(ctx, key, resolver),
            registerClient: (key, binder) => this.registerClient(ctx, key, binder),
            getHost: key => this.getHost(key),
            getClient: key => this.clients.get(key)?.provider,
            subscribe: listener => this.changes.subscribe(ctx, listener),
        };
    }
    getHost(key) {
        const provider = this.hosts.get(key)?.provider;
        if (provider === undefined)
            return undefined;
        const resolver = this.hostResolvers.get(key)?.provider;
        if (resolver === undefined)
            return provider;
        return {
            wire: provider.wire,
            wireTypeSymbol: provider.wireTypeSymbol,
            resolve: id => resolver.resolve(id),
        };
    }
    configureHost(ctx, key, resolver) {
        validateSegment('Context key', key);
        if (this.hostResolvers.has(key))
            throw new Error(`typert: host-context "${key}" resolver is already configured`);
        const entry = {
            provider: { resolve: async (id) => {
                    const result = Reflect.apply(resolver, undefined, [id]);
                    const context = await result;
                    if (context === undefined)
                        return undefined;
                    if (!context_1.Context.is(context))
                        throw new Error('typert: Context resolver returned a non-Context');
                    return context;
                } },
            owner: {},
        };
        const { hostResolvers, changes } = this;
        return ctx.effect(function* () {
            hostResolvers.set(key, entry);
            changes.emit({ kind: 'host-context', key });
            yield () => {
                /* v8 ignore next -- duplicate configuration is rejected, so this effect remains the key's unique owner. */
                if (hostResolvers.get(key) !== entry)
                    return;
                hostResolvers.delete(key);
                changes.emit({ kind: 'host-context', key });
            };
        }, `typert.contexts.configureHost(${JSON.stringify(key)})`);
    }
    registerHost(ctx, key, provider) {
        validateSegment('Context key', key);
        validateWireName('Context wire field', provider.wire);
        validateNonempty('Context wire type symbol', provider.wireTypeSymbol);
        return this.registerProvider(ctx, this.hosts, 'host-context', key, provider);
    }
    registerClient(ctx, key, binder) {
        validateSegment('Context key', key);
        return this.registerProvider(ctx, this.clients, 'client-context', key, binder);
    }
    registerProvider(ctx, table, kind, key, provider) {
        if (table.has(key))
            throw new Error(`typert: ${kind} provider "${key}" is already registered`);
        const entry = { provider, owner: {} };
        const { changes } = this;
        return ctx.effect(function* () {
            table.set(key, entry);
            changes.emit({ kind, key });
            yield () => {
                /* v8 ignore next -- duplicate registration is rejected, so this effect remains the key's unique owner. */
                if (table.get(key) !== entry)
                    return;
                table.delete(key);
                changes.emit({ kind, key });
            };
        }, `typert.contexts.register(${JSON.stringify(key)})`);
    }
}
/**
 * Registry of generated schemas, package reflection, invocations, and Remote
 * dependency providers.
 * @typert service typert
 */
class TypertRegistry extends context_1.Service {
    constructor(ctx) {
        super(ctx, 'typert');
        this.schemas = new Map();
        this.packages = new Map();
        const report = (change, error) => {
            ctx.logger.warn(`typert: ${change.kind} observer for "${change.key}" failed`);
            ctx.logger.warn(error);
        };
        this.localStore = new DescriptorStore('local', report);
        this.remoteStore = new RemoteStore(new DescriptorStore('remote', report));
        this.lookupStore = new LookupStore(report);
        this.contextStore = new ContextStore(report);
    }
    /** Current-environment invocation definitions. */
    get local() {
        const ctx = this.ctx;
        return {
            get: endpoint => this.localStore.get(endpoint),
            hasSeen: endpoint => this.localStore.hasSeen(endpoint),
            list: () => this.localStore.list(),
            subscribe: listener => this.localStore.subscribe(ctx, listener),
        };
    }
    /** Consumer-selected Remote definitions. */
    get remotes() {
        return this.remoteStore.view(this.ctx);
    }
    /** Host object lookup providers. */
    get lookups() {
        return this.lookupStore.view(this.ctx);
    }
    /** Host Context providers and Client Context binders. */
    get contexts() {
        return this.contextStore.view(this.ctx);
    }
    /**
     * Register one generated contribution atomically for the calling fiber.
     * Duplicate package-face identities, schemas, invocation ids, or endpoints
     * reject the whole batch.
     * @param contribution - generated schemas, reflection, and Host invocations.
     * @returns the exact effect disposer that removes this contribution.
     */
    register(contribution) {
        const packageRecord = this.validatePackage(contribution);
        const schemaRecords = this.validateSchemas(contribution);
        const invocations = contribution.invocations;
        this.localStore.validate(invocations);
        const owner = {};
        const { schemas, packages, localStore } = this;
        return this.ctx.effect(function* () {
            packages.set(packageRecord.key, packageRecord);
            for (const record of schemaRecords)
                schemas.set(record.key, record);
            localStore.commit(owner, invocations);
            yield () => {
                /* v8 ignore else -- duplicate package-face registration is rejected, so this effect remains its unique owner. */
                if (packages.get(packageRecord.key) === packageRecord)
                    packages.delete(packageRecord.key);
                for (const record of schemaRecords) {
                    /* v8 ignore else -- duplicate schema registration is rejected, so this contribution remains each record's unique owner. */
                    if (schemas.get(record.key) === record)
                        schemas.delete(record.key);
                }
                localStore.withdraw(owner, invocations);
            };
        }, 'typert.register()');
    }
    /**
     * Look up one schema by `<package>#<name>`.
     * @param key - global schema key.
     * @returns the live schema record, or `undefined` when absent.
     */
    get(key) {
        return this.schemas.get(key);
    }
    /**
     * Resolve one required schema.
     * @param key - global schema key.
     * @returns the live schema record.
     * @throws when the key is malformed, the package face is absent, or the schema is not contributed.
     */
    resolve(key) {
        const record = this.schemas.get(key);
        if (record !== undefined)
            return record;
        const hash = key.indexOf('#');
        if (hash <= 0 || hash === key.length - 1) {
            throw new Error(`typert: invalid schema key "${key}" — expected "<package>#<name>"`);
        }
        const packageName = key.slice(0, hash);
        if ([...this.packages.values()].some(candidate => candidate.package === packageName)) {
            throw new Error(`typert: cannot resolve "${key}" — package "${packageName}" is registered but contributes no schema named "${key.slice(hash + 1)}"`);
        }
        throw new Error(`typert: cannot resolve "${key}" — package "${packageName}" has no registered contribution`);
    }
    /**
     * Enumerate live schemas in registration order.
     * @param filter - optional package and face restriction.
     * @returns matching schema records.
     */
    list(filter = {}) {
        return [...this.schemas.values()].filter(record => matches(record, filter));
    }
    /**
     * Look up generated reflection for one package face.
     * @param packageName - exact npm package name.
     * @param face - face to query; defaults to the host runtime.
     * @returns the live package record, or `undefined` when absent.
     */
    getPackage(packageName, face = 'host') {
        return this.packages.get(typertPackageKey(packageName, face));
    }
    /**
     * Enumerate generated package reflection in registration order.
     * @param filter - optional package and face restriction.
     * @returns matching package records.
     */
    listPackages(filter = {}) {
        return [...this.packages.values()].filter(record => matches(record, filter));
    }
    /**
     * Project a live Zod schema to JSON Schema without caching the result.
     * @param key - global schema key.
     * @param params - Zod projection parameters.
     * @returns a fresh JSON Schema document.
     */
    toJSONSchema(key, params) {
        return zod_1.z.toJSONSchema(this.resolve(key).schema, params);
    }
    validatePackage(contribution) {
        validateSegment('package name', contribution.package);
        const face = contribution.face;
        if (face !== 'host' && face !== 'client') {
            throw new Error(`typert: invalid face ${JSON.stringify(face)} — expected "host" or "client"`);
        }
        const key = typertPackageKey(contribution.package, contribution.face);
        if (this.packages.has(key)) {
            throw new Error(`typert: package face "${key}" is already registered`);
        }
        return {
            package: contribution.package,
            face,
            key,
            model: contribution.model,
        };
    }
    validateSchemas(contribution) {
        const records = [];
        const batch = new Set();
        for (const schema of contribution.schemas) {
            validateSegment('schema name', schema.name);
            const key = typertKey(contribution.package, schema.name);
            if (batch.has(key) || this.schemas.has(key)) {
                throw new Error(`typert: schema "${key}" is already registered`);
            }
            batch.add(key);
            records.push({
                ...schema,
                package: contribution.package,
                face: contribution.face,
                key,
            });
        }
        return records;
    }
}
exports.TypertRegistry = TypertRegistry;
function matches(record, filter) {
    return (filter.package === undefined || record.package === filter.package)
        && (filter.face === undefined || record.face === filter.face);
}
function validateInvocation(descriptor) {
    validateNonempty('invocation id', descriptor.id);
    validateSegment('invocation service key', descriptor.service);
    validateWireName('invocation namespace', descriptor.namespace);
    validateWireName('invocation method', descriptor.method);
    if (descriptor.implementation !== undefined) {
        validateWireName('invocation implementation method', descriptor.implementation);
    }
    validateCodec(descriptor.result, `${descriptor.id} result`);
    const wires = new Set();
    for (const parameter of descriptor.parameters) {
        validateWireName('parameter name', parameter.name);
        validateWireName('parameter wire field', parameter.wire);
        if (wires.has(parameter.wire)) {
            throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${parameter.wire}"`);
        }
        wires.add(parameter.wire);
        if (parameter.source === 'lookup') {
            if (parameter.acceptsUndefined !== undefined) {
                throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" cannot accept undefined`);
            }
            if (parameter.lookup === undefined) {
                throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" has no lookup key`);
            }
            validateSegment('lookup key', parameter.lookup);
        }
        else if (parameter.lookup !== undefined) {
            throw new Error(`typert: invocation "${descriptor.id}" JSON parameter "${parameter.name}" declares a lookup key`);
        }
        validateCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`);
    }
    const cancellation = descriptor.cancellation;
    if (cancellation !== undefined && cancellation.parameter !== 'signal') {
        throw new Error(`typert: invocation "${descriptor.id}" cancellation parameter must be "signal"`);
    }
    if (descriptor.scope !== undefined) {
        if (descriptor.invocation.kind !== 'direct') {
            throw new Error(`typert: invocation "${descriptor.id}" Context receiver cannot declare a direct scope projection`);
        }
        validateSegment('scope Context key', descriptor.scope.context);
        validateWireName('scope wire field', descriptor.scope.wire);
        const lookups = descriptor.parameters.filter(candidate => candidate.source === 'lookup');
        const parameter = lookups.length === 1 ? lookups[0] : undefined;
        if (parameter === undefined || parameter.wire !== descriptor.scope.wire
            || parameter.lookup !== descriptor.scope.context) {
            throw new Error(`typert: invocation "${descriptor.id}" scope wire "${descriptor.scope.wire}" must select its only lookup parameter`);
        }
    }
    if (descriptor.invocation.kind === 'context') {
        validateSegment('Context key', descriptor.invocation.context);
        validateWireName('Context wire field', descriptor.invocation.wire);
        if (wires.has(descriptor.invocation.wire)) {
            throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${descriptor.invocation.wire}"`);
        }
        validateCodec(descriptor.invocation.codec, `${descriptor.id} Context`);
    }
}
function validateCodec(codec, subject) {
    if (codec.mode === 'src-json')
        return;
    validateNonempty(`${subject} type symbol`, codec.typeSymbol);
    if (typeof codec.schema.parse !== 'function') {
        throw new Error(`typert: ${subject} strict codec has no parse() method`);
    }
}
function validateWireName(subject, value) {
    if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
        throw new Error(`typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`);
    }
}
function validateSegment(subject, value) {
    if (value.length === 0 || value.includes('#')) {
        throw new Error(`typert: invalid ${subject} "${value}" — must be nonempty and must not contain "#"`);
    }
}
function validateNonempty(subject, value) {
    if (value.length === 0)
        throw new Error(`typert: invalid ${subject} — must be nonempty`);
}
exports.default = TypertRegistry;

},
"src/modules/typert-registry/context.js": function(module, exports, require) {
// source: src/modules/typert-registry/context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Service = exports.Context = void 0;
/** SDK authority: tracker, logger, and effect lifetime are the actual Core contracts. */
var cordis_1 = require("@xharness/cordis");
Object.defineProperty(exports, "Context", { enumerable: true, get: function () { return cordis_1.Context; } });
Object.defineProperty(exports, "Service", { enumerable: true, get: function () { return cordis_1.Service; } });

}
};
const __dependencies = {"src/modules/typert-registry/index.js":{"./service":"src/modules/typert-registry/service.js"},"src/modules/typert-registry/service.js":{"./context":"src/modules/typert-registry/context.js"},"src/modules/typert-registry/context.js":{}};
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
return __load("src/modules/typert-registry/index.js");
}
});
