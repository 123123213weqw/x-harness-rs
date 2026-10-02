// Generated from src/modules/api-gateway/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-api-gateway",
factory: (__externalRequire) => {
const __units = {
"src/modules/api-gateway/index.js": function(module, exports, require) {
// source: src/modules/api-gateway/index.ts

"use strict";
/**
 * Client projection of generated Typert Remote descriptors. Contributions
 * install traced `remote.<namespace>` services; no JavaScript Proxy
 * participates in method lookup, invocation, or type exposure.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const context_1 = require("./context");
const Cordis = __importStar(require("@xharness/cordis"));
// Cordis traces the context dynamically on service reads. No proxy replacement or parallel service implementation.
const Service = Cordis.Service;
/** Required Client services: the Typert registry and the existing Connection carrier. */
exports.inject = ['typert', 'connection'];
/**
 * Install the typed Client Remote service.
 * @param ctx - Client Cordis root.
 */
function apply(ctx) {
    new ClientRemoteService(ctx);
}
class ClientRemoteService extends Service {
    constructor(ctx) {
        super((0, context_1.cordisGatewayContext)(ctx), 'remote');
        this.namespaces = new Map();
        this.subscriptions = new Map();
        this.mutations = Promise.resolve();
        this.ownerCtx = ctx;
        ctx.effect(() => () => { this.subscriptions.clear(); }, 'api-gateway.client.subscriptions');
    }
    async $mount(contribution) {
        const traced = this.ctx;
        const callerCtx = (0, context_1.gatewayContext)(traced);
        const owned = callerCtx.effect(async () => {
            const dispose = await this.enqueue(() => this.mountContribution(callerCtx, contribution));
            return () => this.enqueue(dispose);
        }, `api-gateway.client.$mount(${JSON.stringify(contribution.package)})`);
        await owned;
        return async () => { await owned(); };
    }
    $on(event, listener) {
        // The table is keyed by the runtime event name, so the argument list this
        // signature pins per event cannot survive in it; `$deliver` restores it
        // from the frame the Host emitted for that same name.
        const subscription = { listener };
        const traced = this.ctx;
        const owned = (0, context_1.gatewayContext)(traced).effect(() => {
            const listeners = this.listeners(event);
            listeners.push(subscription);
            return () => {
                const at = listeners.indexOf(subscription);
                /* v8 ignore next -- listener */
                if (at >= 0)
                    listeners.splice(at, 1);
            };
        }, `api-gateway.client.$on(${JSON.stringify(event)})`);
        return () => { void owned(); };
    }
    /**
     * Deliver one forwarded event in registration order, isolating a listener
     * that fails either synchronously or by rejecting a returned promise; see
     * {@link TypertClientRemote.$dispatch} for the caller contract.
     */
    $dispatch(event, args) {
        const listeners = this.subscriptions.get(event);
        if (listeners === undefined)
            return;
        // Snapshot: a listener may subscribe or dispose during delivery, and this
        // round's recipients are the ones registered when the frame arrived.
        for (const { listener } of [...listeners]) {
            const report = (error) => {
                console.error(`client api: Remote event ${JSON.stringify(event)} listener threw:`, error);
            };
            try {
                /* oxlint-disable-next-line typescript/no-confusing-void-expression --
                 * The declared return is void, so nobody awaits an async listener; the
                 * runtime value is still a promise, and reading it is the only way to
                 * keep its rejection inside this containment instead of surfacing as an
                 * unhandled one. */
                const settled = listener(...args);
                if (settled instanceof Promise)
                    settled.catch(report);
            }
            catch (error) {
                report(error);
            }
        }
    }
    /** Subscriptions for one event name; empty arrays are retained, bounded by the Host's selection. */
    listeners(event) {
        let listeners = this.subscriptions.get(event);
        if (listeners === undefined) {
            listeners = [];
            this.subscriptions.set(event, listeners);
        }
        return listeners;
    }
    enqueue(operation) {
        const result = this.mutations.then(operation, operation);
        this.mutations = result.then(() => undefined, () => undefined);
        return result;
    }
    async mountContribution(callerCtx, contribution) {
        this.validateContribution(contribution);
        const disposeRemote = callerCtx.typert.remotes.register(contribution);
        const installed = [];
        try {
            for (const descriptor of contribution.descriptors)
                installed.push(await this.install(descriptor));
        }
        catch (error) {
            for (const dispose of installed.reverse())
                await dispose();
            await disposeRemote();
            throw error;
        }
        return async () => {
            for (const dispose of installed.reverse())
                await dispose();
            await disposeRemote();
        };
    }
    validateContribution(contribution) {
        const direct = new Map();
        const scoped = new Map();
        const add = (table, descriptor, kind) => {
            const methods = table.get(descriptor.namespace) ?? new Set();
            if (methods.has(descriptor.method)) {
                throw new Error(`client api: contribution repeats ${kind} method ${endpointOf(descriptor)}`);
            }
            methods.add(descriptor.method);
            table.set(descriptor.namespace, methods);
            const namespace = this.namespaces.get(descriptor.namespace)?.service;
            if (namespace?.has(kind, descriptor.method) === true) {
                throw new Error(`client api: ${kind} method ${endpointOf(descriptor)} is already mounted`);
            }
        };
        for (const descriptor of contribution.descriptors) {
            requireStrictDescriptor(descriptor);
            if (descriptor.invocation.kind === 'direct')
                add(direct, descriptor, 'direct');
            if (scopedProjection(descriptor) !== undefined)
                add(scoped, descriptor, 'scoped');
        }
        const namespaces = new Set([...direct.keys(), ...scoped.keys()]);
        for (const namespace of namespaces) {
            const service = this.namespaces.get(namespace)?.service;
            if (service === undefined) {
                if (namespace in this) {
                    throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with the Remote service`);
                }
                const serviceKey = remoteServiceKey(namespace);
                const property = this.ownerCtx.reflect.props[serviceKey];
                if (property?.type === 'accessor' || this.ownerCtx.get(serviceKey) !== undefined) {
                    throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with an existing Remote namespace`);
                }
            }
            for (const method of new Set([...(direct.get(namespace) ?? []), ...(scoped.get(namespace) ?? [])])) {
                if (service === undefined)
                    RemoteNamespaceService.assertMethodAvailable(namespace, method);
                else
                    service.assertMethodAvailable(method);
            }
        }
    }
    async install(descriptor) {
        const token = { active: true, abort: new AbortController() };
        const installed = [];
        try {
            if (descriptor.invocation.kind === 'direct') {
                installed.push(await this.installDirect(descriptor, token));
            }
            const projection = scopedProjection(descriptor);
            if (projection !== undefined)
                installed.push(await this.installScoped(descriptor, projection, token));
        }
        catch (error) {
            token.active = false;
            token.abort.abort();
            for (const dispose of installed.reverse())
                await dispose();
            throw error;
        }
        return async () => {
            /* v8 ignore next -- Cordis effect disposers are idempotent and invoke this cleanup at most once. */
            if (!token.active)
                return;
            token.active = false;
            token.abort.abort();
            for (const dispose of installed.reverse())
                await dispose();
        };
    }
    async installDirect(descriptor, token) {
        const namespace = await this.namespace(descriptor.namespace);
        try {
            namespace.service.installDirect(descriptor, token);
        }
        catch (error) {
            await this.disposeNamespace(descriptor.namespace, namespace);
            throw error;
        }
        return async () => {
            namespace.service.remove('direct', descriptor.method, token);
            await this.disposeNamespace(descriptor.namespace, namespace);
        };
    }
    async installScoped(descriptor, projection, token) {
        const namespace = await this.namespace(descriptor.namespace);
        try {
            namespace.service.installScoped(descriptor, projection, token);
        }
        catch (error) {
            await this.disposeNamespace(descriptor.namespace, namespace);
            throw error;
        }
        return async () => {
            namespace.service.remove('scoped', descriptor.method, token);
            await this.disposeNamespace(descriptor.namespace, namespace);
        };
    }
    async namespace(name) {
        let namespace = this.namespaces.get(name);
        if (namespace !== undefined)
            return namespace;
        let service;
        const fiber = this.ownerCtx.plugin({
            name: remoteServiceKey(name),
            apply: (ctx) => {
                service = new RemoteNamespaceService(ctx, name, (direct, scoped, caller, args) => this.invokeMethod(direct, scoped, caller, args));
            },
        });
        try {
            await fiber;
        }
        catch (error) {
            await fiber.dispose();
            throw error;
        }
        /* v8 ignore next -- a settled namespace fiber synchronously constructs its Service. */
        if (service === undefined)
            throw new Error(`client api: namespace ${JSON.stringify(name)} did not start`);
        namespace = { service, dispose: fiber.dispose };
        this.namespaces.set(name, namespace);
        return namespace;
    }
    async disposeNamespace(name, namespace) {
        if (!namespace.service.empty || this.namespaces.get(name) !== namespace)
            return;
        this.namespaces.delete(name);
        await namespace.dispose();
    }
    invokeMethod(direct, scoped, callerCtx, values) {
        if (scoped !== undefined) {
            const binder = this.ownerCtx.typert.contexts.getClient(scoped.projection.context);
            const identity = binder?.identity(callerCtx);
            if (identity !== undefined) {
                return this.invoke(scoped.descriptor, scoped.projection, scoped.token, callerCtx, values, { value: identity });
            }
        }
        if (direct !== undefined) {
            return this.invoke(direct.descriptor, undefined, direct.token, callerCtx, values);
        }
        if (scoped !== undefined) {
            return this.invoke(scoped.descriptor, scoped.projection, scoped.token, callerCtx, values);
        }
        throw new Error('client api: Remote method is no longer mounted');
    }
    async invoke(descriptor, projection, token, callerCtx, values, boundIdentity) {
        const endpoint = endpointOf(descriptor);
        if (!token.active)
            return withdrawn(endpoint);
        const expected = descriptor.parameters.length - (projection?.parameterIndex === undefined ? 0 : 1);
        const hasCallerSignal = descriptor.cancellation !== undefined && values.length === expected + 1;
        if (values.length !== expected && !hasCallerSignal) {
            const contract = descriptor.cancellation === undefined
                ? `${String(expected)} argument(s)`
                : `${String(expected)} business argument(s) plus an optional AbortSignal`;
            throw new Error(`client api: ${endpoint} expected ${contract}, got ${String(values.length)}`);
        }
        const args = Object.create(null);
        if (projection !== undefined) {
            const binder = boundIdentity === undefined
                ? this.ownerCtx.typert.contexts.getClient(projection.context)
                : undefined;
            if (boundIdentity === undefined && binder === undefined) {
                throw new Error(`client api: ${endpoint} has no Client Context binder for ${JSON.stringify(projection.context)}`);
            }
            const identity = boundIdentity === undefined
                ? binder?.identity(callerCtx)
                : boundIdentity.value;
            if (identity === undefined) {
                throw new Error(`client api: ${endpoint} requires a ${JSON.stringify(projection.context)} Context`);
            }
            args[projection.wire] = parse(projection.codec, identity, endpoint, projection.wire);
        }
        let valueIndex = 0;
        descriptor.parameters.forEach((parameter, parameterIndex) => {
            if (parameterIndex === projection?.parameterIndex)
                return;
            const value = parse(parameter.codec, values[valueIndex], endpoint, parameter.wire);
            if (value !== undefined)
                args[parameter.wire] = value;
            valueIndex += 1;
        });
        const connection = this.ownerCtx.get('connection');
        if (connection === undefined)
            throw new Error(`client api: ${endpoint} has no active Connection`);
        const callerSignal = hasCallerSignal ? values[expected] : undefined;
        if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))
            throw new TypeError('caller cancellation must be an AbortSignal');
        const signal = callerSignal === undefined
            ? token.abort.signal
            : AbortSignal.any([token.abort.signal, callerSignal]);
        try {
            const result = await connection.rpc.call('/api', endpoint, { args }, signal);
            if (!mountActive(token))
                return withdrawn(endpoint);
            if (!result.ok)
                return { ok: false, error: result.error };
            return { ok: true, value: parse(descriptor.result, result.value, endpoint, 'result') };
        }
        catch (error) {
            // Carrier throws (offline, abort, a rejected result payload) are outcomes
            // of the call, not assembly faults, so they join the same error branch.
            return carrierFailure(endpoint, error);
        }
    }
}
class RemoteNamespaceService extends Service {
    static assertMethodAvailable(namespace, method) {
        if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
            throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`);
        }
    }
    constructor(ctx, name, invokeRemote) {
        super((0, context_1.cordisGatewayContext)(ctx), remoteServiceKey(name));
        this.invokeRemote = invokeRemote;
        this.methods = new Map();
        this.namespace = name;
    }
    assertMethodAvailable(method) {
        RemoteNamespaceService.assertMethodAvailable(this.namespace, method);
        if (method in this && !this.methods.has(method)) {
            throw new Error(`client api: method ${JSON.stringify(`${this.namespace}/${method}`)} conflicts with its namespace service`);
        }
    }
    get empty() {
        return this.methods.size === 0;
    }
    has(kind, method) {
        return this.methods.get(method)?.[kind] !== undefined;
    }
    installDirect(descriptor, token) {
        this.install(descriptor.method, 'direct', { descriptor, token });
    }
    installScoped(descriptor, projection, token) {
        this.install(descriptor.method, 'scoped', { descriptor, projection, token });
    }
    install(method, kind, value) {
        this.assertMethodAvailable(method);
        let record = this.methods.get(method);
        const fresh = record === undefined;
        record ?? (record = {});
        if (fresh) {
            Object.defineProperty(this, method, {
                configurable: true,
                enumerable: true,
                get: function () {
                    const traced = this.ctx;
                    const callerCtx = (0, context_1.gatewayContext)(traced);
                    const current = this.methods.get(method);
                    const direct = current?.direct;
                    const scoped = current?.scoped;
                    return (...args) => {
                        return this.invokeRemote(direct, scoped, callerCtx, args);
                    };
                },
            });
            this.methods.set(method, record);
        }
        if (kind === 'direct')
            record.direct = value;
        else if ('projection' in value)
            record.scoped = value;
        else
            throw new TypeError('scoped remote method requires a Context projection');
    }
    remove(kind, method, token) {
        const record = this.methods.get(method);
        const current = record?.[kind];
        /* v8 ignore next -- duplicate live variants are rejected before installation, so no newer token can replace this one. */
        if (record === undefined || current?.token !== token)
            return;
        if (kind === 'direct')
            delete record.direct;
        else
            delete record.scoped;
        if (record.direct !== undefined || record.scoped !== undefined)
            return;
        this.methods.delete(method);
        Reflect.deleteProperty(this, method);
    }
}
const REMOTE_NAMESPACE_FIELDS = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace']);
function remoteServiceKey(namespace) {
    return `remote.${namespace}`;
}
function endpointOf(descriptor) {
    return `${descriptor.namespace}/${descriptor.method}`;
}
function mountActive(token) {
    return token.active;
}
function scopedProjection(descriptor) {
    if (descriptor.invocation.kind === 'context') {
        return {
            context: descriptor.invocation.context,
            wire: descriptor.invocation.wire,
            codec: descriptor.invocation.codec,
        };
    }
    if (descriptor.scope === undefined)
        return undefined;
    const lookupParameters = descriptor.parameters
        .map((parameter, index) => ({ parameter, index }))
        .filter(candidate => candidate.parameter.source === 'lookup');
    const selected = lookupParameters.length === 1 ? lookupParameters[0] : undefined;
    if (selected === undefined
        || selected.parameter.wire !== descriptor.scope.wire
        || selected.parameter.lookup !== descriptor.scope.context) {
        throw new Error(`client api: generated Remote ${endpointOf(descriptor)} scope must select its only lookup parameter`);
    }
    return {
        context: descriptor.scope.context,
        wire: descriptor.scope.wire,
        codec: selected.parameter.codec,
        parameterIndex: selected.index,
    };
}
function requireStrictDescriptor(descriptor) {
    const endpoint = endpointOf(descriptor);
    requireStrictCodec(descriptor.result, endpoint, 'result');
    for (const parameter of descriptor.parameters) {
        requireStrictCodec(parameter.codec, endpoint, parameter.wire);
    }
    if (descriptor.invocation.kind === 'context') {
        requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire);
    }
}
function requireStrictCodec(codec, endpoint, field) {
    if (codec.mode !== 'strict') {
        throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`);
    }
}
function parse(codec, value, endpoint, field) {
    if (codec.mode !== 'strict') {
        throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`);
    }
    try {
        return codec.schema.parse(value);
    }
    catch (cause) {
        throw new Error(`client api: ${endpoint} rejected ${JSON.stringify(field)}`, { cause });
    }
}
/** The namespace retired before or during the call, so no request outcome exists. */
function withdrawn(endpoint) {
    return internalFailure(`client api: Remote method ${endpoint} is no longer mounted`);
}
function carrierFailure(endpoint, error) {
    return internalFailure(`client api: ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
}
function internalFailure(message) {
    return { ok: false, error: { code: 'internal', message, details: {} } };
}

},
"src/modules/api-gateway/context.js": function(module, exports, require) {
// source: src/modules/api-gateway/context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cordisGatewayContext = cordisGatewayContext;
exports.gatewayContext = gatewayContext;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
function cordisGatewayContext(value) {
    if (!cordis_1.Context.is(value))
        throw new TypeError('api-gateway: expected a Cordis context');
    return value;
}
function isGatewayContext(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value) || !cordis_1.Context.is(value))
        return false;
    const typert = value.typert;
    const reflect = value.reflect;
    if (!(0, runtime_types_1.isObjectRecord)(typert) || !(0, runtime_types_1.isObjectRecord)(reflect) || !(0, runtime_types_1.isObjectRecord)(reflect.props))
        return false;
    const remotes = typert.remotes;
    const contexts = typert.contexts;
    return typeof value.effect === 'function' && typeof value.get === 'function' && typeof value.plugin === 'function'
        && (0, runtime_types_1.isObjectRecord)(remotes) && typeof remotes.register === 'function'
        && (0, runtime_types_1.isObjectRecord)(contexts) && typeof contexts.getClient === 'function';
}
function gatewayContext(value) {
    if (!isGatewayContext(value))
        throw new TypeError('api-gateway: missing injected Gateway Context');
    return value;
}

},
"src/modules/shared/runtime-types.js": function(module, exports, require) {
// source: src/modules/shared/runtime-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isObjectRecord = isObjectRecord;
exports.objectValue = objectValue;
exports.errorText = errorText;
exports.textValue = textValue;
exports.numberValue = numberValue;
function isObjectRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function objectValue(value) {
    return isObjectRecord(value) ? value : {};
}
function errorText(error) {
    const record = objectValue(error);
    const rpc = objectValue(record.rpcError);
    return typeof rpc.message === 'string' ? rpc.message : typeof record.message === 'string' ? record.message : String(error);
}
function textValue(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function numberValue(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

}
};
const __dependencies = {"src/modules/api-gateway/index.js":{"./context":"src/modules/api-gateway/context.js"},"src/modules/api-gateway/context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{}};
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
return __load("src/modules/api-gateway/index.js");
}
});
