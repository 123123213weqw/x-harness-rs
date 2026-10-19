// Generated from src/modules/client-connection/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-connection",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-connection/index.js": function(module, exports, require) {
// source: src/modules/client-connection/index.ts

"use strict";
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const install_1 = require("./install");
const web_api_client_1 = require("./web-api-client");
const rpc_1 = require("./rpc");
__exportStar(require("./public"), exports);
exports.inject = [];
function apply(ctx) {
    (0, install_1.installConnection)(ctx, new web_api_client_1.WebApiClient(), (0, rpc_1.createWebConnectionRpc)());
}

},
"src/modules/client-connection/install.js": function(module, exports, require) {
// source: src/modules/client-connection/install.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installConnection = installConnection;
const controller_1 = require("./controller");
const loopback_hostname_1 = require("./loopback-hostname");
const client_1 = require("../jobs/client");
/** Install the shared connection lifetime without selecting a transport. */
function installConnection(ctx, api, rpc) {
    const pageLocation = typeof location === 'undefined' ? undefined : location;
    const jobs = new client_1.JobClient(rpc);
    let started = false;
    let description;
    const descriptionListeners = new Set();
    const publishDescription = (next) => {
        if (Object.is(description, next))
            return;
        description = next;
        jobs.reset(next !== undefined);
        for (const listener of [...descriptionListeners]) {
            try {
                listener();
            }
            catch (error) {
                console.error('[web-runtime] host-description listener threw:', error);
            }
        }
    };
    const handle = {
        api,
        isLoopback: pageLocation === undefined || (0, loopback_hostname_1.isLoopbackHostname)(pageLocation.hostname),
        hostDescription: {
            getSnapshot: () => description,
            subscribe: (listener) => {
                descriptionListeners.add(listener);
                return () => { descriptionListeners.delete(listener); };
            },
        },
        rpc,
        jobs,
        start(sinks, config) {
            if (started)
                throw new Error('connection: the stream loop is already owned by another consumer');
            started = true;
            const controller = new controller_1.ConnectionController(api, {
                ...sinks,
                onConnected: (next) => {
                    publishDescription(next);
                    // A description subscriber may synchronously stop the loop. In that
                    // case publishDescription(undefined) has already retracted this
                    // generation, so do not leak its stale connected notification to
                    // the consumer sink afterward.
                    if (!Object.is(description, next))
                        return;
                    sinks.onConnected?.(next);
                },
                onStateChange: (state) => {
                    if (state === 'reconnecting')
                        publishDescription(undefined);
                    sinks.onStateChange?.(state);
                },
            }, config ?? {});
            controller.start();
            return {
                stop: () => {
                    controller.stop();
                    publishDescription(undefined);
                },
            };
        },
    };
    ctx.provide('connection', handle);
}

},
"src/modules/client-connection/controller.js": function(module, exports, require) {
// source: src/modules/client-connection/controller.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionController = void 0;
const CONNECTION_DEFAULTS = {
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 10000,
    streamOpenTimeoutMs: 3000,
};
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        function done() {
            clearTimeout(t);
            signal.removeEventListener('abort', done);
            resolve();
        }
    });
}
/**
 * Opens both streams and keeps iterating (pull mode: nothing reads the socket and the tap
 * never fires unless someone for-awaits), reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * The pump body feeds each frame to a sink (sink exceptions must
 * not kill the pump — a broken business layer must not drag down the connection layer).
 */
class ConnectionController {
    constructor(api, sinks = {}, config = {}) {
        this.api = api;
        this.sinks = sinks;
        this.generation = 0;
        this.attempt = 0;
        this.current = null;
        this.running = false;
        this.lastState = null;
        this.config = { ...CONNECTION_DEFAULTS, ...config };
    }
    /** Idempotent: begin the connect/pump/reconnect loop. */
    start() {
        if (this.running)
            return;
        this.running = true;
        void this.loop();
    }
    /** Stop the loop and abort the current generation's streams. */
    stop() {
        this.running = false;
        this.current?.abort();
        this.current = null;
    }
    backoffDelay(attempt) {
        const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config;
        const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1));
        return cap / 2 + Math.random() * (cap / 2);
    }
    /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
    isRunning() {
        return this.running;
    }
    /** Re-read both mutable liveness guards after a potentially reentrant sink. */
    isGenerationActive(controller) {
        return this.isRunning() && !controller.signal.aborted;
    }
    async loop() {
        while (this.running) {
            const gen = ++this.generation;
            const ac = new AbortController();
            this.current = ac;
            /* v8 ignore next -- initializer placeholder: the Promise executor
             * below runs synchronously and replaces it before anyone can call it. */
            let muxOpened = () => { };
            /* v8 ignore next -- same placeholder pattern as muxOpened. */
            let hostOpened = () => { };
            const streamsOpen = Promise.all([
                new Promise((resolve) => { muxOpened = resolve; }),
                new Promise((resolve) => { hostOpened = resolve; }),
            ]);
            const failed = new Promise((resolve) => {
                const settle = () => {
                    if (gen === this.generation && !ac.signal.aborted)
                        ac.abort();
                    resolve();
                };
                void this.pumpStream(this.api.events.mux({}, ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle);
                void this.pumpStream(this.api.events.host({}, ac.signal, hostOpened), this.sinks.onHostEnvelope, settle);
            });
            try {
                // Strict readiness handshake: describe proves unary reachability, onOpen
                // proves each physical stream is established before any frame —
                // only then may onConnected fire, so the resync it triggers cannot outrun the
                // subscribed baseline. The timeout guards against a carrier that never fires onOpen
                // (see ConnectionConfig.streamOpenTimeoutMs).
                const timeout = new AbortController();
                const [description] = await Promise.all([
                    this.api.host.describe({}),
                    Promise.race([streamsOpen, sleep(this.config.streamOpenTimeoutMs, timeout.signal)]),
                ]);
                timeout.abort();
                const descriptionResult = description.result;
                if (!descriptionResult.ok) {
                    throw new Error(`host.describe failed: ${descriptionResult.error.code}: ${descriptionResult.error.message}`);
                }
                if (ac.signal.aborted)
                    throw new Error('generation aborted during readiness handshake');
                this.attempt = 0;
                this.emitState('connected');
                // A state sink may synchronously stop this controller. Do not publish
                // a description for a generation that no longer exists afterward.
                if (this.isGenerationActive(ac)) {
                    this.callSink(() => { this.sinks.onConnected?.(descriptionResult.value); });
                }
            }
            catch {
                // Transport failure: treat as generation failure, fall through to the shared backoff.
                if (!ac.signal.aborted)
                    ac.abort();
            }
            await failed;
            if (!this.isRunning())
                return;
            this.emitState('reconnecting');
            this.attempt += 1;
            console.warn(`[web-runtime] connection lost, retry #${this.attempt}`);
            const idle = new AbortController();
            await sleep(this.backoffDelay(this.attempt), idle.signal);
        }
    }
    /** Deduplicated state emission (sink isolation applies). */
    emitState(state) {
        if (this.lastState === state)
            return;
        this.lastState = state;
        this.callSink(() => this.sinks.onStateChange?.(state));
    }
    async pumpStream(stream, sink, onEnd) {
        try {
            for await (const envelope of stream) {
                if (envelope.payload.type === 'stream/error')
                    break;
                if (sink !== undefined)
                    this.callSink(() => { sink(envelope); });
            }
        }
        catch {
            // Stream loss: converge on onEnd, which triggers the shared reconnect.
        }
        onEnd();
    }
    /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
    callSink(fn) {
        try {
            fn();
        }
        catch (error) {
            console.error('[web-runtime] connection sink threw:', error);
        }
    }
}
exports.ConnectionController = ConnectionController;

},
"src/modules/client-connection/loopback-hostname.js": function(module, exports, require) {
// source: src/modules/client-connection/loopback-hostname.ts

"use strict";
/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate stays
 * package-internal; client plugins consume the derived state through Cordis.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLoopbackHostname = isLoopbackHostname;
/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

},
"src/modules/jobs/client.js": function(module, exports, require) {
// source: src/modules/jobs/client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobClient = void 0;
const model_1 = require("./model");
/** One owner per connection, one in-flight read per observed session. Polls are
 * transport reads, not model calls. Idle/unmounted/hidden scopes stop polling. */
class JobClient {
    constructor(rpc) {
        this.rpc = rpc;
        this.nodes = new Map();
        this.connected = true;
    }
    node(session) { let n = this.nodes.get(session); if (!n) {
        n = { snapshot: { loading: false }, listeners: new Set(), seq: 0 };
        this.nodes.set(session, n);
    } return n; }
    snapshot(session) { return this.node(session).snapshot; }
    publish(n, snapshot) { n.snapshot = snapshot; for (const listener of [...n.listeners]) {
        try {
            listener();
        }
        catch (error) {
            console.error('Job projection listener failed', error);
        }
    } }
    subscribe(session, listener) {
        const n = this.node(session);
        n.listeners.add(listener);
        if (n.listeners.size === 1)
            void this.refresh(session);
        const visible = () => { if (!document.hidden)
            void this.refresh(session); };
        if (typeof document !== 'undefined')
            document.addEventListener('visibilitychange', visible);
        return () => { n.listeners.delete(listener); if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', visible); if (!n.listeners.size) {
            clearTimeout(n.timer);
            n.controller?.abort();
            n.seq++;
            n.request = undefined;
            n.controller = undefined;
            n.snapshot = { loading: false };
        } };
    }
    reset(connected) {
        this.connected = connected;
        for (const [id, n] of this.nodes) {
            clearTimeout(n.timer);
            n.controller?.abort();
            n.seq++;
            n.request = undefined;
            n.controller = undefined;
            this.publish(n, { loading: false, ...(connected ? {} : { error: 'Host connection unavailable' }) });
            if (connected && n.listeners.size)
                void this.refresh(id);
        }
    }
    async call(session, command, signal) {
        const controller = new AbortController(), abort = () => controller.abort();
        if (signal?.aborted)
            controller.abort();
        else
            signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 15000);
        try {
            const result = await this.rpc.call('/api', 'job/manage', { sessionId: session, command }, controller.signal);
            if (!result.ok)
                throw Error(result.error.message);
            return result.value;
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    refresh(session) {
        const n = this.node(session);
        if (n.request)
            return n.request;
        if (!this.connected || typeof document !== 'undefined' && document.hidden)
            return Promise.resolve();
        clearTimeout(n.timer);
        const seq = ++n.seq, controller = new AbortController();
        n.controller = controller;
        const request = Promise.resolve().then(() => this.call(session, { action: 'list' }, controller.signal)).then(raw => {
            if (seq !== n.seq)
                return;
            const catalog = (0, model_1.parseCatalog)(raw, session);
            this.publish(n, { catalog, loading: false });
        }).catch((error) => { if (seq === n.seq)
            this.publish(n, { loading: false, error: error instanceof Error ? error.message : String(error) }); }).finally(() => {
            if (seq !== n.seq)
                return;
            n.request = undefined;
            n.controller = undefined;
            const c = n.snapshot.catalog;
            const delay = n.snapshot.error ? 15000 : c?.runs.some(r => model_1.ACTIVE.has(r.state)) ? 1500 : c?.plans.some(p => p.state === 'scheduled' || p.state === 'overdue') ? 15000 : undefined;
            if (delay !== undefined && n.listeners.size && this.connected)
                n.timer = setTimeout(() => void this.refresh(session), delay);
        });
        n.request = request;
        this.publish(n, { ...n.snapshot, loading: true });
        return request;
    }
    async control(session, command) {
        const receipt = await this.call(session, command);
        if (receipt === null || typeof receipt !== 'object' || !('version' in receipt) || receipt.version !== 1 || !('accepted' in receipt) || receipt.accepted !== true)
            throw Error('Invalid Job control receipt');
        const n = this.node(session);
        clearTimeout(n.timer);
        n.controller?.abort();
        n.seq++;
        n.request = undefined;
        if (n.listeners.size)
            await this.refresh(session);
        else
            n.snapshot = { loading: false };
    }
    async output(session, reference, signal, cursor) { return (0, model_1.parseOutput)(await this.call(session, { action: 'output', reference, ...(cursor ? { cursor } : {}) }, signal), session, reference); }
}
exports.JobClient = JobClient;

},
"src/modules/jobs/model.js": function(module, exports, require) {
// source: src/modules/jobs/model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVE = exports.PLAN_STATES = exports.RUN_STATES = void 0;
exports.parseRun = parseRun;
exports.parseCatalog = parseCatalog;
exports.parseOutput = parseOutput;
exports.processHint = processHint;
/** Version 1 execution contract. Tool results only supply lookup hints. */
exports.RUN_STATES = ['preparing', 'queued', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'incomplete', 'unavailable'];
exports.PLAN_STATES = ['scheduled', 'overdue', 'paused', 'finished', 'deleted', 'inherited', 'inactive'];
exports.ACTIVE = new Set(['preparing', 'queued', 'running', 'waiting', 'stopping']);
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function object(v) { return isObject(v) ? v : {}; }
function list(v) { return Array.isArray(v) ? v : []; }
function text(v) { return typeof v === 'string' && v.length > 0; }
function timestamp(v) { return v === null || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
function runState(v) { return exports.RUN_STATES.some(s => s === v); }
function planState(v) { return exports.PLAN_STATES.some(s => s === v); }
function parseRef(raw) {
    const r = object(raw);
    if (r.kind === 'process' && text(r.id))
        return { kind: 'process', id: r.id };
    if (r.kind === 'automation' && text(r.planId) && text(r.inputId))
        return { kind: 'automation', planId: r.planId, inputId: r.inputId };
    throw Error('Invalid Job execution reference');
}
function parseRun(raw, session) {
    const v = object(raw), reference = parseRef(v.reference), c = object(v.capabilities);
    if (!text(v.id) || !text(v.label) || v.sourceSessionId !== session || !text(v.targetSessionId)
        || !runState(v.state) || !(v.planId === null || text(v.planId))
        || typeof c.cancelRun !== 'boolean' || typeof c.readOutput !== 'boolean' || typeof c.openSession !== 'boolean'
        || !timestamp(v.startedAtMs) || !timestamp(v.scheduledAtMs) || !timestamp(v.finishedAtMs)
        || !(v.detail === null || typeof v.detail === 'string'))
        throw Error('Invalid Job execution projection');
    if (reference.kind === 'process' ? reference.id !== v.id : reference.inputId !== v.id || reference.planId !== v.planId)
        throw Error('Job reference identity mismatch');
    return { id: v.id, label: v.label, sourceSessionId: session, targetSessionId: v.targetSessionId, planId: v.planId, state: v.state, reference, capabilities: { cancelRun: c.cancelRun, readOutput: c.readOutput, openSession: c.openSession }, startedAtMs: v.startedAtMs, scheduledAtMs: v.scheduledAtMs, finishedAtMs: v.finishedAtMs, detail: v.detail };
}
function parseCatalog(raw, session) {
    const v = object(raw);
    if (v.version !== 1 || v.sessionId !== session || !Array.isArray(v.runs) || !Array.isArray(v.plans))
        throw Error('Unsupported or foreign Job contract');
    const runs = list(v.runs).map(run => parseRun(run, session)), plans = list(v.plans).map((raw) => {
        const p = object(raw);
        if (!text(p.id) || !text(p.label) || !planState(p.state) || !text(p.nextAt) || !Number.isFinite(Date.parse(p.nextAt)) || !(p.everySeconds === null || typeof p.everySeconds === 'number' && Number.isSafeInteger(p.everySeconds) && p.everySeconds > 0))
            throw Error('Invalid Job plan projection');
        return { id: p.id, label: p.label, state: p.state, nextAt: p.nextAt, everySeconds: p.everySeconds };
    });
    if (new Set(runs.map(r => r.id)).size !== runs.length || new Set(plans.map(p => p.id)).size !== plans.length)
        throw Error('Duplicate Job identity');
    return { version: 1, sessionId: session, runs, plans };
}
function parseOutput(raw, session, ref) {
    const v = object(raw), c = object(v.nextCursor);
    if (v.version !== 1 || ref.kind !== 'process' || typeof v.stdout !== 'string' || typeof v.stderr !== 'string' || typeof v.stdoutTruncated !== 'boolean' || typeof v.stderrTruncated !== 'boolean' || c.job_id !== ref.id || typeof c.stdout !== 'number' || !Number.isSafeInteger(c.stdout) || c.stdout < 0 || typeof c.stderr !== 'number' || !Number.isSafeInteger(c.stderr) || c.stderr < 0)
        throw Error('Invalid Job output projection');
    const run = parseRun(v.run, session);
    if (run.id !== ref.id)
        throw Error('Job output identity changed');
    return { stdout: v.stdout, stderr: v.stderr, stdoutTruncated: v.stdoutTruncated, stderrTruncated: v.stderrTruncated, nextCursor: { job_id: ref.id, stdout: c.stdout, stderr: c.stderr }, run };
}
/** Nested legacy envelopes are ID hints only, never executable instructions. */
function processHint(block) {
    const b = object(block), call = object(b.call);
    const parse = (value) => { if (typeof value !== 'string' || value.length > 1048576)
        return undefined; try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    } };
    const args = object(parse(call.argsRaw ?? b.argsRaw));
    if (text(args.job_id))
        return args.job_id;
    let out = object(parse(list(b.content).map(p => { const o = object(p); return o.type === 'text' && typeof o.text === 'string' ? o.text : ''; }).join('\n')));
    if (out.ok === false || b.isError === true)
        return undefined;
    if (typeof out.content === 'string')
        out = object(parse(out.content));
    const snapshot = object(out.snapshot);
    return text(out.job_id) ? out.job_id : text(snapshot.id) ? snapshot.id : undefined;
}

},
"src/modules/client-connection/web-api-client.js": function(module, exports, require) {
// source: src/modules/client-connection/web-api-client.ts

"use strict";
/** Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebApiClient = void 0;
const api_1 = require("./api");
const events_schema_1 = require("./contracts/host/apiproxy/api/events.schema");
const rpc_schema_1 = require("./contracts/host/apiproxy/api/rpc.schema");
const api_path_1 = require("./api-path");
/** Browser platform subclass: unary/respond use fetch; mux/host use downlink-only WebSockets. */
class WebApiClient extends api_1.AbstractApiClient {
    doFetch(input, init) {
        return globalThis.fetch(input, init);
    }
    openMux(_payload, signal, onOpen) {
        return this.readWebSocket(api_path_1.MUX_EVENTS_PATH, signal, events_schema_1.muxFrameSchema, onOpen);
    }
    openHost(_payload, signal, onOpen) {
        return this.readWebSocket(api_path_1.HOST_EVENTS_PATH, signal, events_schema_1.hostFrameSchema, onOpen);
    }
    async *readWebSocket(path, signal, frameSchema, onOpen) {
        const url = new URL(path, this.resolveBase());
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url);
        const inbox = [];
        let wake;
        const enqueue = (item) => {
            inbox.push(item);
            wake?.();
            wake = undefined;
        };
        const handleOpen = () => { onOpen?.(); };
        const handleMessage = (event) => {
            let full;
            let frame;
            try {
                if (typeof event.data !== 'string')
                    throw new Error('binary WebSocket frame');
                const raw = JSON.parse(event.data);
                full = rpc_schema_1.serverRequestSchema.parse(raw);
                frame = frameSchema.parse(full.payload);
            }
            catch (error) {
                console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error);
                return;
            }
            this.onEnvelope(full);
            enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } });
        };
        const handleClose = () => { enqueue({ kind: 'end' }); };
        const handleAbort = () => {
            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
                socket.close();
        };
        socket.addEventListener('open', handleOpen);
        socket.addEventListener('message', handleMessage);
        socket.addEventListener('close', handleClose, { once: true });
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted)
            handleAbort();
        try {
            while (true) {
                while (inbox.length > 0) {
                    const item = inbox.shift();
                    if (item === undefined)
                        continue;
                    if (item.kind === 'end')
                        return;
                    yield item.envelope;
                }
                await new Promise((resolve) => { wake = resolve; });
            }
        }
        finally {
            signal.removeEventListener('abort', handleAbort);
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('message', handleMessage);
            socket.removeEventListener('close', handleClose);
            handleAbort();
        }
    }
}
exports.WebApiClient = WebApiClient;

},
"src/modules/client-connection/api.js": function(module, exports, require) {
// source: src/modules/client-connection/api.ts

"use strict";
// Central contract re-export point: every contract import inside
// web-runtime goes through this single file.
// Types and runtime protocol helpers/bounds come from the apiproxy api/ layer
// (zero Node deps, browser-safe); AbstractApiClient is the client boundary.
// NEVER import the package root: it drags bootHost/cordis into the browser bundle.
// The ./api and ./client subpath exports are the browser-safe channels.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbstractApiClient = exports.transportError = exports.SESSION_SEARCH_RESULT_LIMIT = exports.RpcId = void 0;
exports.resultOf = resultOf;
// transportError lives in the apiproxy api layer (beside RpcResult, its
// subject); re-exported here so connection consumers keep one contract
// entry point.
var index_1 = require("./contracts/host/apiproxy/api/index");
Object.defineProperty(exports, "RpcId", { enumerable: true, get: function () { return index_1.RpcId; } });
Object.defineProperty(exports, "SESSION_SEARCH_RESULT_LIMIT", { enumerable: true, get: function () { return index_1.SESSION_SEARCH_RESULT_LIMIT; } });
Object.defineProperty(exports, "transportError", { enumerable: true, get: function () { return index_1.transportError; } });
var client_1 = require("./contracts/host/apiproxy/fetch/client");
Object.defineProperty(exports, "AbstractApiClient", { enumerable: true, get: function () { return client_1.AbstractApiClient; } });
/**
 * Unwrap a unary response: RpcResponse<T> -> RpcResult<T> (business code only
 * cares about the result slot).
 * @param response - the unary response.
 * @returns its result slot.
 */
function resultOf(response) {
    return response.result;
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/index.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/index.ts

"use strict";
/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TS interfaces are the authoritative contract, while HTTP,
 * WebSocket, and in-process SSE are merely physical channels (four-quadrant message model).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = exports.SESSION_SEARCH_RESULT_LIMIT = exports.serverResponseSchema = exports.serverRequestSchema = exports.clientRequestSchema = exports.transportError = exports.RpcId = void 0;
// ---- Errors and ids ----
var rpc_1 = require("./rpc");
Object.defineProperty(exports, "RpcId", { enumerable: true, get: function () { return rpc_1.RpcId; } });
Object.defineProperty(exports, "transportError", { enumerable: true, get: function () { return rpc_1.transportError; } });
var rpc_schema_1 = require("./rpc.schema");
Object.defineProperty(exports, "clientRequestSchema", { enumerable: true, get: function () { return rpc_schema_1.clientRequestSchema; } });
Object.defineProperty(exports, "serverRequestSchema", { enumerable: true, get: function () { return rpc_schema_1.serverRequestSchema; } });
Object.defineProperty(exports, "serverResponseSchema", { enumerable: true, get: function () { return rpc_schema_1.serverResponseSchema; } });
// ---- Fixed session-search product bounds ----
var session_search_1 = require("./session-search");
Object.defineProperty(exports, "SESSION_SEARCH_RESULT_LIMIT", { enumerable: true, get: function () { return session_search_1.SESSION_SEARCH_RESULT_LIMIT; } });
Object.defineProperty(exports, "SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS", { enumerable: true, get: function () { return session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS; } });

},
"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/rpc.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcId = RpcId;
exports.transportError = transportError;
const zod_1 = require("zod");
/**
 * Brands a string as RpcId (same precedent as core `SessionId()`). Minted by the initiator:
 * client-request → client mints; server-request → host mints (answerable frames get a stable
 * logical id, pure pushes mint a fresh one each time).
 * @param id - Raw id string (implementations mint UUIDs; tests may pass fixtures).
 * @returns The same string, branded (nominal string schema).
 */
function RpcId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Fold a transport exception into the RpcResult error branch (unified error
 * API; 'internal' as the catch-all code). Lives with RpcResult so every
 * carrier consumer folds the same way.
 * @param error - the thrown value from the carrier.
 * @returns the error branch of an RpcResult.
 */
function transportError(error) {
    return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    };
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.ts

"use strict";
/**
 * Message-layer zod schemas: the four wire full forms + error body +
 * carrier receipt. The payload slot is unknown in the full-form schemas — business payloads
 * get a second parse dispatched by method (two-level parse discipline).
 * Brand cast point: rpcIdSchema, and only there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcReceiptSchema = exports.rpcMessageSchema = exports.clientResponseSchema = exports.serverRequestSchema = exports.serverResponseSchema = exports.clientRequestSchema = exports.rpcErrorSchema = exports.rpcIdSchema = void 0;
exports.rpcResultSchema = rpcResultSchema;
const zod_1 = require("zod");
/**
 * RpcId: one brand cast after schema validation (the only cast point in this
 * file). No min-length: the id is an opaque echo token, and rejecting values
 * here would only turn a correlatable error report into a client-side parse
 * failure (the handler substitutes a sentinel when a request's id is unreadable).
 */
exports.rpcIdSchema = zod_1.z.string().brand().transform(value => value);
/** Error body: discriminated by code, per-branch details aligned to RpcErrorDetailsMap; details is required. */
exports.rpcErrorSchema = zod_1.z.discriminatedUnion('code', [
    zod_1.z.object({ code: zod_1.z.literal('bad-request'), message: zod_1.z.string(), details: zod_1.z.object({ issues: zod_1.z.array(zod_1.z.unknown()) }) }),
    zod_1.z.object({ code: zod_1.z.literal('cancelled'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('session-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('model-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ provider: zod_1.z.string(), model: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('session-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), requestedCwd: zod_1.z.string().optional(), existingCwd: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('invalid-time-zone'), message: zod_1.z.string(), details: zod_1.z.object({ value: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-attach-failed'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), workspaceId: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ workspaceId: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-invalid-path'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-name-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ name: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-move-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ workspaceId: zod_1.z.string(), sessionId: zod_1.z.string().brand().transform(value => value), beforeSessionId: zod_1.z.string().brand().transform(value => value).optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-unreadable'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-exists'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-create-failed'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-picker-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ capability: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-read-only'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-locked'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), agentPreset: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), requestedPreset: zod_1.z.string(), existingPreset: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), available: zod_1.z.array(zod_1.z.string()) }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-busy'), message: zod_1.z.string(), details: zod_1.z.object({ reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('attachment-error'), message: zod_1.z.string(), details: zod_1.z.object({ reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('queue-item-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ itemId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('steer-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ itemId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('command-error'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('unknown-command'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('settings-rejected'), message: zod_1.z.string(), details: zod_1.z.object({ ns: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('settings-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ ns: zod_1.z.string(), expected: zod_1.z.number(), actual: zod_1.z.number() }) }),
    zod_1.z.object({ code: zod_1.z.literal('credential-rejected'), message: zod_1.z.string(), details: zod_1.z.object({ ref: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('model-discovery-failed'), message: zod_1.z.string(), details: zod_1.z.object({ settingsNs: zod_1.z.string(), baseURL: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('title-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('fork-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-parent-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ parentSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ parentSessionId: zod_1.z.string().brand().transform(value => value), childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-catalog-diagnostic'), message: zod_1.z.string(), details: zod_1.z.object({
            parentSessionId: zod_1.z.string().brand().transform(value => value),
            childSessionId: zod_1.z.string().brand().transform(value => value),
            reason: zod_1.z.union([zod_1.z.literal('corrupt'), zod_1.z.literal('unsupported'), zod_1.z.literal('unavailable')]),
        }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-not-resumable'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-unauthorized'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-delivery-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('internal'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
]);
/**
 * Business success/failure result schema (generic, reusable).
 * @param value - Schema for the business value.
 * @returns Schema for RpcResult<T>.
 */
function rpcResultSchema(value) {
    return zod_1.z.union([
        zod_1.z.object({ ok: zod_1.z.literal(true), value }),
        zod_1.z.object({ ok: zod_1.z.literal(false), error: exports.rpcErrorSchema }),
    ]);
}
// ---- The four wire full-form schemas (payload/result.value slots stay wide — business layer does the second parse) ----
// The wide value slot is optional: a void business result serializes with no
// `value` field at all. Each endpoint's own second parse still requires its
// declared value, so absence never passes for a method that returns data.
/** ClientRequest full form (payload stays wide — the business layer runs the second parse). */
exports.clientRequestSchema = zod_1.z.object({
    type: zod_1.z.literal('client-request'),
    rpcId: exports.rpcIdSchema,
    method: zod_1.z.string(),
    payload: zod_1.z.unknown(),
});
/** ServerResponse full form (result.value stays wide). */
exports.serverResponseSchema = zod_1.z.object({
    type: zod_1.z.literal('server-response'),
    rpcId: exports.rpcIdSchema,
    result: rpcResultSchema(zod_1.z.unknown().optional()),
});
/** ServerRequest full form (payload stays wide). */
exports.serverRequestSchema = zod_1.z.object({
    type: zod_1.z.literal('server-request'),
    rpcId: exports.rpcIdSchema,
    method: zod_1.z.string(),
    payload: zod_1.z.unknown(),
});
/** ClientResponse full form (result.value stays wide). */
exports.clientResponseSchema = zod_1.z.object({
    type: zod_1.z.literal('client-response'),
    rpcId: exports.rpcIdSchema,
    result: rpcResultSchema(zod_1.z.unknown().optional()),
});
/** Wire full-form union (discriminated by type). */
exports.rpcMessageSchema = zod_1.z.discriminatedUnion('type', [
    exports.clientRequestSchema,
    exports.serverResponseSchema,
    exports.serverRequestSchema,
    exports.clientResponseSchema,
]);
/** Carrier receipt schema. */
exports.rpcReceiptSchema = zod_1.z.union([
    zod_1.z.object({ accepted: zod_1.z.literal(true) }),
    zod_1.z.object({ accepted: zod_1.z.literal(false), reason: zod_1.z.union([zod_1.z.literal('not-pending'), zod_1.z.literal('bad-response')]) }),
]);

},
"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/session-search.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = exports.SESSION_SEARCH_RESULT_LIMIT = void 0;
exports.truncateUnicodeCodePoints = truncateUnicodeCodePoints;
/** Maximum number of sessions returned by one sidebar search. */
exports.SESSION_SEARCH_RESULT_LIMIT = 20;
/** Maximum snippet length in Unicode code points. */
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - text to bound.
 * @param maximum - non-negative code-point limit.
 * @returns `value` unchanged when it fits, otherwise a code-point-safe prefix.
 */
function truncateUnicodeCodePoints(value, maximum) {
    let count = 0;
    let end = 0;
    for (const codePoint of value) {
        if (count === maximum)
            return value.slice(0, end);
        count++;
        end += codePoint.length;
    }
    return value;
}

},
"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/fetch/client.ts

"use strict";
/**
 * Client side of the fetch carrier. AbstractApiClient holds every protocol invariant: rpcId minting,
 * four-quadrant envelope wrap/unwrap, zod parsing, in-process SSE frame decoding, and the payload-direct
 * IApiClient domain methods (business code never mints). Platform differences ride two aspects:
 * abstract doFetch (transport) + overridable onEnvelope (tap). ApiProxy (the impl face) is untouched.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InProcessApiClient = exports.AbstractApiClient = exports.UNARY_VALUE_SCHEMAS = void 0;
const rpc_1 = require("../api/rpc");
const rpc_schema_1 = require("../api/rpc.schema");
const events_schema_1 = require("../api/events.schema");
const host_schema_1 = require("../api/host.schema");
const sessions_schema_1 = require("../api/sessions.schema");
const workspace_schema_1 = require("../api/workspace.schema");
const skills_schema_1 = require("../api/skills.schema");
const agent_presets_schema_1 = require("../api/agent-presets.schema");
const goals_schema_1 = require("../api/goals.schema");
const settings_schema_1 = require("../api/settings.schema");
const credentials_schema_1 = require("../api/credentials.schema");
const llm_schema_1 = require("../api/llm.schema");
const subagents_schema_1 = require("../api/subagents.schema");
/**
 * S→C second-level parse table: value schema by method (the response-path
 * mirror of the handler's request table; key coverage compiler-enforced against RpcMethodMap).
 */
exports.UNARY_VALUE_SCHEMAS = {
    'session.delete': sessions_schema_1.sessionDeleteValueSchema,
    'session.list': sessions_schema_1.sessionListValueSchema,
    'session.search': sessions_schema_1.sessionSearchValueSchema,
    'session.create': sessions_schema_1.sessionCreateValueSchema,
    'session.import': sessions_schema_1.sessionImportValueSchema,
    'session.history': sessions_schema_1.sessionHistoryValueSchema,
    'session.models': sessions_schema_1.sessionModelsValueSchema,
    'session.selectModel': sessions_schema_1.sessionSelectModelValueSchema,
    'session.rename': sessions_schema_1.sessionRenameValueSchema,
    'session.fork': sessions_schema_1.sessionForkValueSchema,
    'session.prompt': sessions_schema_1.sessionPromptValueSchema,
    'session.attachment': sessions_schema_1.sessionAttachmentValueSchema,
    'session.updateQueue': sessions_schema_1.sessionUpdateQueueValueSchema,
    'session.cancel': sessions_schema_1.sessionCancelValueSchema,
    'subagent.list': subagents_schema_1.subagentListValueSchema,
    'subagent.history': subagents_schema_1.subagentHistoryValueSchema,
    'subagent.prompt': subagents_schema_1.subagentPromptValueSchema,
    'subagent.interrupt': subagents_schema_1.subagentInterruptValueSchema,
    'host.describe': host_schema_1.hostDescribeValueSchema,
    'host.pickDirectory': host_schema_1.hostPickDirectoryValueSchema,
    'host.listDirectory': host_schema_1.hostListDirectoryValueSchema,
    'host.createDirectory': host_schema_1.hostCreateDirectoryValueSchema,
    'host.openPath': host_schema_1.hostOpenPathValueSchema,
    'workspace.list': workspace_schema_1.workspaceListValueSchema,
    'workspace.create': workspace_schema_1.workspaceCreateValueSchema,
    'workspace.rename': workspace_schema_1.workspaceRenameValueSchema,
    'workspace.delete': workspace_schema_1.workspaceDeleteValueSchema,
    'workspace.insertBefore': workspace_schema_1.workspaceInsertBeforeValueSchema,
    'workspace.insertSessionBefore': workspace_schema_1.workspaceInsertSessionBeforeValueSchema,
    'workspace.unarchiveSession': workspace_schema_1.workspaceUnarchiveSessionValueSchema,
    'workspace.archiveSession': workspace_schema_1.workspaceArchiveSessionValueSchema,
    'skill.list': skills_schema_1.skillListValueSchema,
    'agentPreset.list': agent_presets_schema_1.agentPresetListValueSchema,
    'agentPreset.select': agent_presets_schema_1.agentPresetSelectValueSchema,
    'agentPreset.read': agent_presets_schema_1.agentPresetReadValueSchema,
    'agentPreset.copy': agent_presets_schema_1.agentPresetCopyValueSchema,
    'agentPreset.openDocument': agent_presets_schema_1.agentPresetOpenDocumentValueSchema,
    'agentPreset.remove': agent_presets_schema_1.agentPresetRemoveValueSchema,
    'goal.create': goals_schema_1.goalCreateValueSchema,
    'goal.edit': goals_schema_1.goalEditValueSchema,
    'goal.pause': goals_schema_1.goalPauseValueSchema,
    'goal.resume': goals_schema_1.goalResumeValueSchema,
    'goal.complete': goals_schema_1.goalCompleteValueSchema,
    'goal.clear': goals_schema_1.goalClearValueSchema,
    'settings.describe': settings_schema_1.settingsDescribeValueSchema,
    'settings.openDocument': settings_schema_1.settingsOpenDocumentValueSchema,
    'settings.update': settings_schema_1.settingsUpdateValueSchema,
    'settings.replace': settings_schema_1.settingsReplaceValueSchema,
    'settings.mutate': settings_schema_1.settingsMutateValueSchema,
    'credentials.describe': credentials_schema_1.credentialsDescribeValueSchema,
    'credentials.set': credentials_schema_1.credentialsSetValueSchema,
    'credentials.unset': credentials_schema_1.credentialsUnsetValueSchema,
    'llm.providers': llm_schema_1.llmProvidersValueSchema,
    'llm.models': llm_schema_1.llmModelsValueSchema,
    'llm.discoverModels': llm_schema_1.llmDiscoverModelsValueSchema,
};
/** Default timeout for bounded unary calls (rpc-compare 2026-07-19: a hung host must not leave callers pending forever). */
const DEFAULT_TIMEOUT_MS = 30000;
/** URL base for in-process handler injection (fake authority, opencode precedent). */
const INTERNAL_BASE = 'http://dsh.internal';
/**
 * Abstract fetch-carrier client. Subclasses supply the transport (doFetch) and may refine the
 * per-message tap (onEnvelope) — platform aspects stay in subclasses, protocol invariants stay
 * here. Envelope observation is a first-class aspect of this data middle layer: the instance
 * owns a microtask-batched buffer (frame storms must not cost one consumer update per frame),
 * and observers subscribe via subscribeEnvelopes. The isomorphic point survives: an in-process
 * subclass whose doFetch is toFetchHandler(api).fetch never touches the network.
 */
class AbstractApiClient {
    /** @param timeoutMs - timeout for bounded unary calls; user-paced calls and streams do not use it. */
    constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
        /** Instance-owned observation buffer (module-level state would leak across instances/tests). */
        this.envelopeBatch = [];
        this.flushScheduled = false;
        this.envelopeListeners = new Set();
        // ---- IApiClient API (arrow properties so destructured/passed references stay bound) ----
        this.sessions = {
            delete: (payload, signal) => this.callUnary('session.delete', payload, signal),
            list: (payload, signal) => this.callUnary('session.list', payload, signal),
            search: (payload, signal) => this.callUnary('session.search', payload, signal),
            create: (payload, signal) => this.callUnary('session.create', payload, signal),
            importHistory: (payload, signal) => this.callUnary('session.import', payload, signal),
            history: (payload, signal) => this.callUnary('session.history', payload, signal),
            models: (payload, signal) => this.callUnary('session.models', payload, signal),
            selectModel: (payload, signal) => this.callUnary('session.selectModel', payload, signal),
            rename: (payload, signal) => this.callUnary('session.rename', payload, signal),
            fork: (payload, signal) => this.callUnary('session.fork', payload, signal),
            prompt: (payload, signal) => this.callUnary('session.prompt', payload, signal),
            attachment: (payload, signal) => this.callUnary('session.attachment', payload, signal),
            updateQueue: (payload, signal) => this.callUnary('session.updateQueue', payload, signal),
            cancel: (payload, signal) => this.callUnary('session.cancel', payload, signal),
        };
        this.subagents = {
            list: (payload, signal) => this.callUnary('subagent.list', payload, signal),
            history: (payload, signal) => this.callUnary('subagent.history', payload, signal),
            prompt: (payload, signal) => this.callUnary('subagent.prompt', payload, signal),
            interrupt: (payload, signal) => this.callUnary('subagent.interrupt', payload, signal),
        };
        this.host = {
            describe: (payload, signal) => this.callUnary('host.describe', payload, signal),
            // A native system dialog is user-paced and may legitimately stay open
            // longer than the normal unary deadline. Caller/connection aborts remain.
            pickDirectory: (payload, signal) => this.callUnary('host.pickDirectory', payload, signal, 'caller-signal-only'),
            listDirectory: (payload, signal) => this.callUnary('host.listDirectory', payload, signal),
            createDirectory: (payload, signal) => this.callUnary('host.createDirectory', payload, signal),
            openPath: (payload, signal) => this.callUnary('host.openPath', payload, signal),
        };
        this.workspace = {
            list: (payload, signal) => this.callUnary('workspace.list', payload, signal),
            create: (payload, signal) => this.callUnary('workspace.create', payload, signal),
            rename: (payload, signal) => this.callUnary('workspace.rename', payload, signal),
            delete: (payload, signal) => this.callUnary('workspace.delete', payload, signal),
            insertBefore: (payload, signal) => this.callUnary('workspace.insertBefore', payload, signal),
            insertSessionBefore: (payload, signal) => this.callUnary('workspace.insertSessionBefore', payload, signal),
            unarchiveSession: (payload, signal) => this.callUnary('workspace.unarchiveSession', payload, signal),
            archiveSession: (payload, signal) => this.callUnary('workspace.archiveSession', payload, signal),
        };
        this.skills = {
            list: (payload, signal) => this.callUnary('skill.list', payload, signal),
        };
        // Annotated like every sibling, and load-bearing rather than cosmetic:
        // inferring this member inlines `AgentPresetEntry` into the emitted
        // declaration by the specifier TS picks — the host `index.ts` — which drags
        // the whole gateway, and with it the host `Context` merges, into every
        // Client program that imports this carrier.
        this.agentPresets = {
            list: (payload, signal) => this.callUnary('agentPreset.list', payload, signal),
            select: (payload, signal) => this.callUnary('agentPreset.select', payload, signal),
            read: (payload, signal) => this.callUnary('agentPreset.read', payload, signal),
            copy: (payload, signal) => this.callUnary('agentPreset.copy', payload, signal),
            openDocument: (payload, signal) => this.callUnary('agentPreset.openDocument', payload, signal),
            remove: (payload, signal) => this.callUnary('agentPreset.remove', payload, signal),
        };
        this.goals = {
            create: (payload, signal) => this.callUnary('goal.create', payload, signal),
            edit: (payload, signal) => this.callUnary('goal.edit', payload, signal),
            pause: (payload, signal) => this.callUnary('goal.pause', payload, signal),
            resume: (payload, signal) => this.callUnary('goal.resume', payload, signal),
            complete: (payload, signal) => this.callUnary('goal.complete', payload, signal),
            clear: (payload, signal) => this.callUnary('goal.clear', payload, signal),
        };
        this.settings = {
            describe: (payload, signal) => this.callUnary('settings.describe', payload, signal),
            openDocument: (payload, signal) => this.callUnary('settings.openDocument', payload, signal),
            update: (payload, signal) => this.callUnary('settings.update', payload, signal),
            replace: (payload, signal) => this.callUnary('settings.replace', payload, signal),
            mutate: (payload, signal) => this.callUnary('settings.mutate', payload, signal),
        };
        this.credentials = {
            describe: (payload, signal) => this.callUnary('credentials.describe', payload, signal),
            set: (payload, signal) => this.callUnary('credentials.set', payload, signal),
            unset: (payload, signal) => this.callUnary('credentials.unset', payload, signal),
        };
        this.llm = {
            providers: (payload, signal) => this.callUnary('llm.providers', payload, signal),
            models: (payload, signal) => this.callUnary('llm.models', payload, signal),
            discoverModels: (payload, signal) => this.callUnary('llm.discoverModels', payload, signal),
        };
        this.events = {
            mux: (payload, signal, onOpen) => this.openMux(payload, signal, onOpen),
            host: (payload, signal, onOpen) => this.openHost(payload, signal, onOpen),
        };
    }
    /**
     * Subscribe to batched envelope observation (diagnostics/logging consumers).
     * Batches follow microtask boundaries; a listener throw is isolated (observation
     * must never break the carrier).
     * @param listener - receives each flushed batch in arrival order.
     * @returns unsubscribe function.
     */
    subscribeEnvelopes(listener) {
        this.envelopeListeners.add(listener);
        return () => {
            this.envelopeListeners.delete(listener);
        };
    }
    /** Per-message tap: feeds the instance buffer. Subclasses may override to observe unbatched (call super to keep batching). */
    onEnvelope(message) {
        if (this.envelopeListeners.size === 0)
            return;
        this.envelopeBatch.push(message);
        if (this.flushScheduled)
            return;
        this.flushScheduled = true;
        queueMicrotask(() => {
            this.flushScheduled = false;
            // Never empty here: a flush is only ever scheduled by the push above,
            // and this callback is the sole drain point.
            const batch = this.envelopeBatch;
            this.envelopeBatch = [];
            for (const notify of this.envelopeListeners) {
                try {
                    notify(batch);
                }
                catch (error) {
                    console.error('[apiproxy] envelope listener threw:', error);
                }
            }
        });
    }
    /** Browser = same-origin (a fake authority would fail DNS on real requests); no-location env (Node) = fake authority. */
    resolveBase() {
        const loc = typeof location === 'undefined' ? undefined : location;
        return loc?.origin !== undefined && loc.origin !== 'null' ? loc.origin : INTERNAL_BASE;
    }
    mintRpcId() {
        // crypto.randomUUID is a Web API (browser + Node ≥19): keeps this base platform-neutral.
        return (0, rpc_1.RpcId)(crypto.randomUUID());
    }
    /**
     * Shared POST leg of both C→S carriers (callUnary/respond): JSON body,
     * optional default timeout merged with the caller's external signal, non-2xx → transport throw.
     */
    async postJson(path, body, signal, timeoutPolicy = 'default') {
        const requestSignal = timeoutPolicy === 'default'
            ? signal === undefined
                ? AbortSignal.timeout(this.timeoutMs)
                : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
            : signal;
        const response = await this.doFetch(new URL(path, this.resolveBase()), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            ...requestSignal === undefined ? {} : { signal: requestSignal },
        });
        if (!response.ok)
            throw new Error(`transport failure for ${path}: HTTP ${response.status}`);
        return response;
    }
    /**
     * Unary protocol path: mint → tap → POST full form → envelope parse → verify
     * echo → value parse → tap → narrow. Virtual so a fake carrier (fixture) can
     * override transport at this layer.
     */
    async callUnary(method, payload, signal, timeoutPolicy = 'default') {
        const message = { type: 'client-request', rpcId: this.mintRpcId(), method, payload };
        this.onEnvelope(message);
        const response = await this.postJson(`/api/${method}`, message, signal, timeoutPolicy);
        const raw = await response.json();
        const full = rpc_schema_1.serverResponseSchema.parse(raw);
        this.onEnvelope(full);
        if (full.rpcId !== message.rpcId)
            throw new Error(`rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`);
        if (!full.result.ok)
            return { rpcId: full.rpcId, result: full.result };
        // Second-level S→C parse: the ok value must match the method's Value schema (mirror of the
        // handler's request-payload parse). The cast collapses the Wire<> widening, same as the handler side.
        const schema = exports.UNARY_VALUE_SCHEMAS[method];
        const value = schema.parse(full.result.value);
        return { rpcId: full.rpcId, result: { ok: true, value } };
    }
    /** Mux stream opener; virtual for the same override reason as callUnary. */
    openMux(_payload, signal, onOpen) {
        return this.readSse('/api/events.mux', signal, events_schema_1.muxFrameSchema, onOpen);
    }
    /** Host stream opener; virtual. */
    openHost(_payload, signal, onOpen) {
        return this.readSse('/api/events.host', signal, events_schema_1.hostFrameSchema, onOpen);
    }
    /**
     * SSE protocol path: streaming fetch (not EventSource), '\n\n' framing, ServerRequest envelope +
     * frame-schema parse, tap, narrow yield. onOpen fires once the response headers are in and the
     * body is readable — the stream-established signal, before any frame arrives. A frame that fails
     * either parse level is reported and skipped (one corrupt frame must not kill the stream; the
     * client's gap detection covers whatever the frame carried).
     */
    async *readSse(path, signal, frameSchema, onOpen) {
        const response = await this.doFetch(new URL(path, this.resolveBase()), { signal });
        if (!response.ok || response.body === null)
            throw new Error(`transport failure for ${path}: HTTP ${response.status}`);
        onOpen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    return;
                buffer += decoder.decode(value, { stream: true });
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    const chunk = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('');
                    if (data === '')
                        continue;
                    let full;
                    let frame;
                    try {
                        const raw = JSON.parse(data);
                        full = rpc_schema_1.serverRequestSchema.parse(raw);
                        frame = frameSchema.parse(full.payload);
                    }
                    catch (error) {
                        console.error(`[apiproxy] dropping malformed SSE frame on ${path}:`, error);
                        continue;
                    }
                    this.onEnvelope(full);
                    yield { rpcId: full.rpcId, payload: frame };
                }
            }
        }
        finally {
            await reader.cancel().catch(() => undefined);
        }
    }
    async respond(message, signal) {
        this.onEnvelope(message);
        const response = await this.postJson('/api/respond', message, signal);
        const raw = await response.json();
        return rpc_schema_1.rpcReceiptSchema.parse(raw);
    }
}
exports.AbstractApiClient = AbstractApiClient;
/**
 * In-process client over an injected fetch-shaped handler (the isomorphic point:
 * `new InProcessApiClient(toFetchHandler(api))` never touches the network). Lives here because
 * in-process injection is this package's own capability (handler and client are both local).
 */
class InProcessApiClient extends AbstractApiClient {
    constructor(handler, timeoutMs) {
        super(timeoutMs);
        this.handler = handler;
    }
    /**
     * Faithful to real fetch: reject on signal abort even when the in-process
     * handler ignores the signal (a hung impl must not defeat timeout/cancel).
     */
    doFetch(input, init) {
        const signal = init?.signal ?? undefined;
        if (signal === undefined)
            return this.handler.fetch(input, init);
        if (signal.aborted)
            return Promise.reject(abortError(signal));
        return new Promise((resolve, reject) => {
            const onAbort = () => { reject(abortError(signal)); };
            signal.addEventListener('abort', onAbort, { once: true });
            this.handler.fetch(input, init)
                .then(resolve, reject)
                .finally(() => { signal.removeEventListener('abort', onAbort); });
        });
    }
}
exports.InProcessApiClient = InProcessApiClient;
/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    if (typeof reason === 'string')
        return new Error(reason);
    return new Error('This operation was aborted');
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/events.schema.ts

"use strict";
/**
 * events domain zod schemas: MuxFrame / HostFrame unions (discriminatedUnion('type')).
 * A frame is the payload slot of the ServerRequest full form; the SessionEvent inside
 * a session/event frame reuses sessions.schema's strict-envelope + wide-data passthrough branch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostFrameSchema = exports.muxFrameSchema = exports.askUserQuestionItemSchema = void 0;
const zod_1 = require("zod");
const rpc_schema_1 = require("./rpc.schema");
const approvals_schema_1 = require("./approvals.schema");
const sessions_schema_1 = require("./sessions.schema");
const jobs_schema_1 = require("./jobs.schema");
const workspace_schema_1 = require("./workspace.schema");
/** Question fields validated strictly against core dsh-user-questions. */
exports.askUserQuestionItemSchema = zod_1.z.object({
    id: zod_1.z.string(),
    question: zod_1.z.string(),
    header: zod_1.z.string().optional(),
    detail: zod_1.z.string().optional(),
    options: zod_1.z.array(zod_1.z.object({ label: zod_1.z.string(), description: zod_1.z.string().optional() })).optional(),
    multiSelect: zod_1.z.boolean().optional(),
    // Presentation intent: a tagged union on the wire, so an unknown tag is a
    // rejected frame rather than a silently generic render.
    intent: zod_1.z.discriminatedUnion('kind', [
        zod_1.z.object({ kind: zod_1.z.literal('plan-review'), approve: zod_1.z.string() }),
    ]).optional(),
});
/** Unified message envelope carried by transient queue frames. */
const messageSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).brand().transform(value => value),
    role: zod_1.z.union([zod_1.z.literal('system'), zod_1.z.literal('user'), zod_1.z.literal('assistant')]),
    content: zod_1.z.array(sessions_schema_1.contentBlockSchema),
    source: zod_1.z.looseObject({ kind: zod_1.z.string() }),
});
/** MuxFrame union (payload slot of a mux-stream ServerRequest). */
exports.muxFrameSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('session/event'), sessionId: sessions_schema_1.sessionIdSchema, event: sessions_schema_1.sessionEventSchema, view: sessions_schema_1.toolEventViewSchema.optional() }),
    zod_1.z.object({ type: zod_1.z.literal('session/subscribed'), sessionId: sessions_schema_1.sessionIdSchema, lastSeq: zod_1.z.number().int() }),
    zod_1.z.object({ type: zod_1.z.literal('approval/requested'), sessionId: sessions_schema_1.sessionIdSchema, approvalId: approvals_schema_1.approvalRequestIdSchema, toolName: zod_1.z.string(), callId: zod_1.z.string().brand().transform(value => value).optional(), reason: zod_1.z.string().optional(), reviewing: zod_1.z.boolean().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('approval/resolved'), sessionId: sessions_schema_1.sessionIdSchema, approvalId: approvals_schema_1.approvalRequestIdSchema, outcome: zod_1.z.union([zod_1.z.literal('allowed-once'), zod_1.z.literal('rejected'), zod_1.z.literal('cancelled'), zod_1.z.literal('unavailable')]) }),
    // Non-empty by wire contract: the user-questions service rejects empty
    // batches at ask() (EMPTY_QUESTIONS), so an empty frame is host breakage
    // and must fail loud here, not reach the composer.
    zod_1.z.object({ type: zod_1.z.literal('question/requested'), sessionId: sessions_schema_1.sessionIdSchema, questions: zod_1.z.array(exports.askUserQuestionItemSchema).min(1) }),
    zod_1.z.object({ type: zod_1.z.literal('question/resolved'), sessionId: sessions_schema_1.sessionIdSchema, questionRpcId: rpc_schema_1.rpcIdSchema, outcome: zod_1.z.union([zod_1.z.literal('answered'), zod_1.z.literal('cancelled')]) }),
    zod_1.z.object({
        type: zod_1.z.literal('session/queue'),
        sessionId: sessions_schema_1.sessionIdSchema,
        items: zod_1.z.array(zod_1.z.object({
            id: sessions_schema_1.messageIdSchema,
            placement: zod_1.z.union([zod_1.z.literal('queued'), zod_1.z.literal('steering'), zod_1.z.literal('context')]),
            message: messageSchema,
        })),
    }),
    zod_1.z.object({ type: zod_1.z.literal('session/jobs'), sessionId: sessions_schema_1.sessionIdSchema, jobs: zod_1.z.array(jobs_schema_1.taskViewSchema) }),
    // value stays wide: it already passed its unit's own schema on the host,
    // and deep-validating here would import every domain's schema into the carrier.
    zod_1.z.object({ type: zod_1.z.literal('session/projection'), sessionId: sessions_schema_1.sessionIdSchema, key: zod_1.z.string().min(1), value: zod_1.z.unknown(), seq: zod_1.z.number().int().nonnegative() }),
    zod_1.z.object({ type: zod_1.z.literal('stream/error'), error: rpc_schema_1.rpcErrorSchema }),
]);
/** HostFrame union (payload slot of a host-stream ServerRequest). */
exports.hostFrameSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({
        type: zod_1.z.literal('host/session-added'),
        sessionId: sessions_schema_1.sessionIdSchema,
        blank: zod_1.z.boolean(),
        parentSessionId: sessions_schema_1.sessionIdSchema.optional(),
        origin: sessions_schema_1.sessionOriginSchema.optional(),
        cwd: zod_1.z.string().optional(),
        agentPreset: zod_1.z.string().optional(),
    }),
    zod_1.z.object({ type: zod_1.z.literal('host/session-removed'), sessionId: sessions_schema_1.sessionIdSchema, permanent: zod_1.z.boolean().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('host/session-status'), sessionId: sessions_schema_1.sessionIdSchema, running: zod_1.z.boolean() }),
    zod_1.z.object({ type: zod_1.z.literal('host/agent-error'), sessionId: sessions_schema_1.sessionIdSchema, message: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('host/workspace-changed'), workspace: workspace_schema_1.workspaceViewSchema }),
    zod_1.z.object({ type: zod_1.z.literal('host/workspace-removed'), workspaceId: workspace_schema_1.workspaceIdSchema }),
    zod_1.z.object({ type: zod_1.z.literal('host/workspace-order-changed'), workspaceIds: zod_1.z.array(workspace_schema_1.workspaceIdSchema) }),
    zod_1.z.object({ type: zod_1.z.literal('host/archived-sessions-changed'), archivedSessionIds: zod_1.z.array(sessions_schema_1.sessionIdSchema) }),
    // args stays wide, the same posture as session/projection's value: the frame
    // arrives from JSON.parse, so every element is already a JSON value, and the
    // structural contract belongs to the owner package's cordis `Events`
    // declaration — the host validated JSON-safety before forwarding.
    zod_1.z.object({ type: zod_1.z.literal('host/remote-event'), event: zod_1.z.string().min(1), args: zod_1.z.array(zod_1.z.unknown()) }),
    zod_1.z.object({ type: zod_1.z.literal('stream/error'), error: rpc_schema_1.rpcErrorSchema }),
]);

},
"src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.ts

"use strict";
/**
 * approvals domain zod schemas (respond is a client-response; the payload schema serves
 * the /api/respond endpoint's second parse after routing via the pending table).
 * ApprovalRequestId brand cast point: one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.approvalResponsePayloadSchema = exports.approvalRequestIdSchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
/** ApprovalRequestId: one brand cast after schema validation (the only cast point in this domain). */
exports.approvalRequestIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** Approval answer payload (the result.value slot of a client-response). */
exports.approvalResponsePayloadSchema = zod_1.z.object({
    sessionId: sessions_schema_1.sessionIdSchema,
    approvalId: exports.approvalRequestIdSchema,
    outcome: zod_1.z.union([zod_1.z.literal('allowed-once'), zod_1.z.literal('rejected')]),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.ts

"use strict";
/**
 * sessions domain zod schemas (names derived from map keys: sessionListRequestSchema /
 * sessionListValueSchema). SessionEvent passthrough = strict envelope (type/seq/time) + wide
 * data: the merge-extensible event API keeps an unknown-type branch at the union level,
 * with no field-level passthrough. SessionId brand cast point: sessionIdSchema, and only there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionImportRequestSchema = exports.sessionDeleteValueSchema = exports.sessionDeleteRequestSchema = exports.sessionCancelValueSchema = exports.sessionCancelRequestSchema = exports.sessionUpdateQueueValueSchema = exports.sessionUpdateQueueRequestSchema = exports.sessionAttachmentValueSchema = exports.sessionAttachmentRequestSchema = exports.imageAttachmentRefSchema = exports.attachmentIdSchema = exports.sessionPromptValueSchema = exports.sessionPromptRequestSchema = exports.promptContentPartSchema = exports.imageMediaTypeSchema = exports.contentBlockSchema = exports.sessionSelectModelValueSchema = exports.sessionSelectModelRequestSchema = exports.sessionModelsValueSchema = exports.sessionModelsRequestSchema = exports.sessionHistoryValueSchema = exports.imageLimitsProjectionSchema = exports.sessionListMetadataProjectionSchema = exports.sessionProjectionsBlockSchema = exports.historyEntrySchema = exports.toolEventViewSchema = exports.modelCatalogFailureSchema = exports.modelProviderGroupSchema = exports.modelCatalogModelSchema = exports.modelReasoningSchema = exports.modelReasoningEffortSchema = exports.modelSelectionSchema = exports.sessionHistoryRequestSchema = exports.sessionForkValueSchema = exports.sessionForkRequestSchema = exports.sessionRenameValueSchema = exports.sessionRenameRequestSchema = exports.sessionCreateValueSchema = exports.sessionCreateRequestSchema = exports.sessionSearchValueSchema = exports.sessionSearchItemSchema = exports.sessionSearchRequestSchema = exports.sessionListValueSchema = exports.sessionListRequestSchema = exports.sessionSummarySchema = exports.sessionOriginSchema = exports.sessionEventSchema = exports.workspaceIdSchema = exports.messageIdSchema = exports.sessionIdSchema = void 0;
exports.sessionImportValueSchema = void 0;
const zod_1 = require("zod");
const session_search_1 = require("./session-search");
/** SessionId: one brand cast after schema validation (the only cast point in this domain). */
exports.sessionIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** MessageId: one brand cast after non-empty string validation. */
exports.messageIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/**
 * WorkspaceId: the workspace domain's one brand cast. Hosted here rather
 * than in workspace.schema because session.create references it while
 * workspace.schema references sessionIdSchema — schema modules must stay a
 * DAG (both casts used at module top level; a cycle is a load-time TDZ).
 */
exports.workspaceIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** SessionEvent passthrough: strict envelope, wide data (the client fold handles unknown types via its documented default). */
exports.sessionEventSchema = zod_1.z.object({
    type: zod_1.z.string(),
    seq: zod_1.z.number().int().nonnegative(),
    time: zod_1.z.number(),
    data: zod_1.z.unknown(),
    sourceEventSeqs: zod_1.z.array(zod_1.z.number()).optional(),
    surfaceOp: zod_1.z.unknown().optional(),
    ignorable: zod_1.z.literal(true).optional(),
});
/** SessionSummary row of session.list (`projections` reuses the history block's shape and schema). */
exports.sessionOriginSchema = zod_1.z.enum(['subagent', 'fork', 'automation']);
exports.sessionSummarySchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    updatedAt: zod_1.z.number(),
    running: zod_1.z.boolean(),
    blank: zod_1.z.boolean(),
    parentSessionId: exports.sessionIdSchema.optional(),
    origin: exports.sessionOriginSchema.optional(),
    cwd: zod_1.z.string().optional(),
    agentPreset: zod_1.z.string().optional(),
    projections: zod_1.z.lazy(() => exports.sessionProjectionsBlockSchema).optional(),
});
/** session.list request payload (cursor is a reserved seat, unimplemented in v1). */
exports.sessionListRequestSchema = zod_1.z.object({
    cursor: zod_1.z.string().optional(),
});
/** session.list response value. */
exports.sessionListValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSummarySchema),
});
/** Fixed wire bound for one interactive sidebar query. */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500;
/** session.search request payload. */
exports.sessionSearchRequestSchema = zod_1.z.object({
    query: zod_1.z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS)
        .refine(query => !query.includes('\0'), { message: 'search query must not contain NUL' }),
});
/** One session.search result. */
exports.sessionSearchItemSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    snippet: zod_1.z.string().refine(snippet => (0, session_search_1.truncateUnicodeCodePoints)(snippet, session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS) === snippet, { message: `search snippet must contain at most ${session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS} Unicode code points` }),
});
/** session.search response value. */
exports.sessionSearchValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSearchItemSchema).max(session_search_1.SESSION_SEARCH_RESULT_LIMIT),
    hasMore: zod_1.z.boolean(),
});
/** session.create request payload (at most one of workspaceId / cwd). */
exports.sessionCreateRequestSchema = zod_1.z.object({
    workspaceId: exports.workspaceIdSchema.optional(),
    cwd: zod_1.z.string().optional(),
    sessionId: exports.sessionIdSchema.optional(),
    agentPreset: zod_1.z.string().optional(),
}).refine(payload => payload.workspaceId === undefined || payload.cwd === undefined, { message: 'session.create accepts workspaceId or cwd, not both' });
/** session.create response value. */
exports.sessionCreateValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    agentPreset: zod_1.z.string().optional(),
});
/** session.rename request payload (raw title; host-side normalization decides acceptance). */
exports.sessionRenameRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    title: zod_1.z.string(),
});
/** session.rename response value (the normalized accepted title and its event seq). */
exports.sessionRenameValueSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    seq: zod_1.z.number().int().nonnegative(),
});
/** session.fork request payload (atSeq anchors the completed-turn cut). */
exports.sessionForkRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    atSeq: zod_1.z.number().int().nonnegative().optional(),
    beforeUserSeq: zod_1.z.number().int().nonnegative().optional(),
});
/** session.fork response value (the child session id). */
exports.sessionForkValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.history request payload (beforeSeq/maxMessages page backwards from the window tail). */
exports.sessionHistoryRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    beforeSeq: zod_1.z.number().int().nonnegative().optional(),
    maxMessages: zod_1.z.number().int().positive().optional(),
});
/** Complete provider/model selection. */
// Production model capacity metadata is preserved rather than stripped.
exports.modelSelectionSchema = zod_1.z.object({
    contextWindowTokens: zod_1.z.number().int().positive().optional(),
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** One adapter-owned reasoning effort. */
exports.modelReasoningEffortSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
});
/** Exact-model reasoning metadata. */
exports.modelReasoningSchema = zod_1.z.object({
    efforts: zod_1.z.array(exports.modelReasoningEffortSchema).min(1),
    defaultEffort: zod_1.z.string().min(1).optional(),
});
/** One advisory model entry inside a provider group. */
exports.modelCatalogModelSchema = zod_1.z.object({
    imageInput: zod_1.z.boolean().optional(),
    imageInputCapability: zod_1.z.unknown().optional(),
    reasoningCapability: zod_1.z.unknown().optional(),
    contextWindow: zod_1.z.number().int().positive().optional(),
    contextWindowSource: zod_1.z.string().optional(),
    contextWindowCapability: zod_1.z.unknown().optional(),
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    reasoning: exports.modelReasoningSchema.optional(),
});
/** One successfully loaded provider group. */
exports.modelProviderGroupSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    models: zod_1.z.array(exports.modelCatalogModelSchema),
});
/** One provider-local catalog failure. */
exports.modelCatalogFailureSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    message: zod_1.z.string(),
});
/**
 * ToolEventView passthrough: lock only the `for` discriminant and the presence
 * of a card-tagged `view` object. The view interior is a host-computed product
 * the client reads without echoing back; deep-validating it would hand-copy
 * the dsh-tools vocabulary into this schema and drift with it.
 */
exports.toolEventViewSchema = zod_1.z.discriminatedUnion('for', [
    zod_1.z.object({ for: zod_1.z.literal('call'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('result'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('compaction'), view: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()) }),
]);
/** One session.history item: the session event plus its optional host-computed tool view. */
exports.historyEntrySchema = zod_1.z.object({
    event: exports.sessionEventSchema,
    view: exports.toolEventViewSchema.optional(),
});
/**
 * Projection baseline passthrough: `values` stays a wide record — each value
 * was already parsed by its provider's own schema on the host side, and
 * deep-validating here would import every domain's schema into the carrier.
 */
exports.sessionProjectionsBlockSchema = zod_1.z.object({
    // -1 = empty log (the lastSeq convention of session/subscribed).
    asOfSeq: zod_1.z.number().int().min(-1),
    values: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
});
/** Host-side validation for the persisted Session-list projection. */
exports.sessionListMetadataProjectionSchema = zod_1.z.object({
    blank: zod_1.z.boolean(),
    lastPromptAt: zod_1.z.number().nullable(),
});
/**
 * imageLimits projection unit schema (host-side view validation). zod widens
 * `readonly ImageMediaType[]` to `string[]`; on the JSON wire the two
 * serialize identically, so the cast records exactly that widening.
 */
exports.imageLimitsProjectionSchema = zod_1.z.object({
    maxImageBytes: zod_1.z.number().int().positive(),
    maxImagesPerMessage: zod_1.z.number().int().positive(),
    maxMessageImageBytes: zod_1.z.number().int().positive(),
    maxImagePixels: zod_1.z.number().int().positive(),
    maxImageDimension: zod_1.z.number().int().positive(),
    mediaTypes: zod_1.z.array(zod_1.z.string()),
});
/** session.history response value (projections rides the tail page only). */
exports.sessionHistoryValueSchema = zod_1.z.object({
    events: zod_1.z.array(exports.historyEntrySchema),
    hasMore: zod_1.z.boolean(),
    projections: exports.sessionProjectionsBlockSchema.optional(),
});
/** session.models request payload. */
exports.sessionModelsRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.models response value. */
exports.sessionModelsValueSchema = zod_1.z.object({
    current: exports.modelSelectionSchema,
    routable: zod_1.z.boolean(),
    groups: zod_1.z.array(exports.modelProviderGroupSchema),
    failures: zod_1.z.array(exports.modelCatalogFailureSchema),
});
/** session.selectModel request payload. */
exports.sessionSelectModelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** session.selectModel response value. */
exports.sessionSelectModelValueSchema = zod_1.z.object({
    selected: exports.modelSelectionSchema,
});
/** ContentBlock passthrough: core is merge-extensible — the type discriminant envelope is strict, the rest stays wide. */
exports.contentBlockSchema = zod_1.z.looseObject({ type: zod_1.z.string() });
/** Raster image media types accepted by the version-one browser wire. */
exports.imageMediaTypeSchema = zod_1.z.union([
    zod_1.z.literal('image/png'),
    zod_1.z.literal('image/jpeg'),
    zod_1.z.literal('image/webp'),
    zod_1.z.literal('image/gif'),
]);
/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
// Production xharness-edit-reference-wire/v1 and durable attachments boundary.
exports.promptContentPartSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('image_ref'), attachmentId: zod_1.z.string().min(1) }),
    zod_1.z.object({ type: zod_1.z.literal('file_ref'), attachmentId: zod_1.z.string().min(1), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('text'), text: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('image'), mediaType: exports.imageMediaTypeSchema, data: zod_1.z.string(), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('file'), mediaType: zod_1.z.string(), data: zod_1.z.string(), name: zod_1.z.string().optional() }),
]);
/** session.prompt request payload, including optional browser-local request provenance. */
exports.sessionPromptRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    mode: zod_1.z.union([zod_1.z.literal('queue'), zod_1.z.literal('steer')]),
    content: zod_1.z.array(exports.promptContentPartSchema),
    requireIdle: zod_1.z.boolean().optional(),
    clientTimeZone: zod_1.z.string().optional(),
});
/** session.prompt response value (the command slot appears only when the prompt dispatched a slash command). */
exports.sessionPromptValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
    command: zod_1.z.object({
        kind: zod_1.z.literal('success'),
        text: zod_1.z.string().optional(),
    }).optional(),
});
/** Opaque attachment id after string-shape validation. */
exports.attachmentIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** Durable image reference returned from the authenticated session lookup. */
exports.imageAttachmentRefSchema = zod_1.z.object({
    attachmentId: exports.attachmentIdSchema,
    mediaType: zod_1.z.string(),
    bytes: zod_1.z.number().int().nonnegative(),
    width: zod_1.z.number().int().positive().nullish(),
    height: zod_1.z.number().int().positive().nullish(),
    name: zod_1.z.string().optional(),
});
/** session.attachment request payload. */
exports.sessionAttachmentRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    attachmentId: exports.attachmentIdSchema,
});
/** session.attachment response value. */
exports.sessionAttachmentValueSchema = zod_1.z.object({
    attachment: exports.imageAttachmentRefSchema,
    data: zod_1.z.string(),
});
/** session.updateQueue request payload. */
exports.sessionUpdateQueueRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    itemId: exports.messageIdSchema,
    action: zod_1.z.discriminatedUnion('kind', [
        zod_1.z.object({ kind: zod_1.z.literal('edit'), content: zod_1.z.array(exports.contentBlockSchema) }),
        zod_1.z.object({ kind: zod_1.z.literal('remove') }),
        zod_1.z.object({ kind: zod_1.z.literal('steer') }),
    ]),
});
/** session.updateQueue response value. */
exports.sessionUpdateQueueValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
/** session.cancel request payload. */
exports.sessionCancelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.cancel response value. */
exports.sessionCancelValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
exports.sessionDeleteRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
exports.sessionDeleteValueSchema = zod_1.z.object({
    deleted: zod_1.z.boolean(),
    deletedSessionIds: zod_1.z.array(exports.sessionIdSchema).optional(),
});
/** External tools are history text only; this request never submits a prompt. */
exports.sessionImportRequestSchema = zod_1.z.object({
    source: zod_1.z.enum(['claude-code', 'codex']), jsonl: zod_1.z.string().max(8 * 1024 * 1024),
    preview: zod_1.z.boolean(), cwd: zod_1.z.string().optional(), workspaceId: exports.workspaceIdSchema.optional(),
}).strict().refine(p => p.cwd === undefined || p.workspaceId === undefined);
exports.sessionImportValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema.optional(), title: zod_1.z.string(), messages: zod_1.z.number().int().nonnegative(),
    tools: zod_1.z.number().int().nonnegative(), warnings: zod_1.z.array(zod_1.z.string()),
    preview: zod_1.z.array(zod_1.z.object({ role: zod_1.z.string(), content: zod_1.z.string() })),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.ts

"use strict";
/**
 * tasks domain zod schemas: the branded job id and the wire view carried by
 * `session/jobs` frames.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskViewSchema = exports.taskIdSchema = void 0;
const zod_1 = require("zod");
/** JobId: one brand cast after non-empty string validation. */
exports.taskIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/**
 * One wire task view. `kind` stays an open string because producer plugins
 * extend the registry's kind map by declaration merging, so the closed set is
 * not knowable at this boundary.
 */
exports.taskViewSchema = zod_1.z.object({
    id: exports.taskIdSchema,
    kind: zod_1.z.string().min(1),
    label: zod_1.z.string().min(1),
    status: zod_1.z.union([
        zod_1.z.literal('running'),
        zod_1.z.literal('stopping'),
        zod_1.z.literal('completed'),
        zod_1.z.literal('killed'),
        zod_1.z.literal('failed'),
    ]),
    detail: zod_1.z.string().optional(),
    startedAt: zod_1.z.number().int().nonnegative(),
    finishedAt: zod_1.z.number().int().nonnegative().optional(),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.ts

"use strict";
/**
 * workspace domain zod schemas (names derived from map keys). The
 * WorkspaceId brand cast lives in sessions.schema (see the note there) and
 * is re-exported here as the domain-local name.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceUnarchiveSessionValueSchema = exports.workspaceUnarchiveSessionRequestSchema = exports.workspaceArchiveSessionValueSchema = exports.workspaceArchiveSessionRequestSchema = exports.workspaceInsertSessionBeforeValueSchema = exports.workspaceInsertSessionBeforeRequestSchema = exports.workspaceInsertBeforeValueSchema = exports.workspaceInsertBeforeRequestSchema = exports.workspaceDeleteValueSchema = exports.workspaceDeleteRequestSchema = exports.workspaceRenameValueSchema = exports.workspaceRenameRequestSchema = exports.workspaceCreateValueSchema = exports.workspaceCreateRequestSchema = exports.workspaceListValueSchema = exports.workspaceListRequestSchema = exports.workspaceViewSchema = exports.workspaceIdSchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
var sessions_schema_2 = require("./sessions.schema");
Object.defineProperty(exports, "workspaceIdSchema", { enumerable: true, get: function () { return sessions_schema_2.workspaceIdSchema; } });
/** WorkspaceView row of every workspace.* response. */
exports.workspaceViewSchema = zod_1.z.object({
    workspaceId: sessions_schema_1.workspaceIdSchema,
    path: zod_1.z.string(),
    title: zod_1.z.string(),
    sessionIds: zod_1.z.array(sessions_schema_1.sessionIdSchema),
    createdAt: zod_1.z.string(),
    updatedAt: zod_1.z.string(),
});
/** workspace.list request payload (empty object literal). */
exports.workspaceListRequestSchema = zod_1.z.object({});
/** workspace.list response value. */
exports.workspaceListValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.workspaceViewSchema),
    archivedSessionIds: zod_1.z.array(sessions_schema_1.sessionIdSchema),
    archivedSessions: zod_1.z.array(zod_1.z.object({
        sessionId: sessions_schema_1.sessionIdSchema,
        title: zod_1.z.string().nullable(),
        updatedAt: zod_1.z.number(),
    })).optional(),
});
/** workspace.create request payload: the existing directory to adopt. */
exports.workspaceCreateRequestSchema = zod_1.z.object({
    path: zod_1.z.string(),
});
/** workspace.create response value. */
exports.workspaceCreateValueSchema = zod_1.z.object({
    workspace: exports.workspaceViewSchema,
    created: zod_1.z.boolean(),
});
/** workspace.rename request payload: the new title must be non-blank. */
exports.workspaceRenameRequestSchema = zod_1.z.object({
    workspaceId: sessions_schema_1.workspaceIdSchema,
    title: zod_1.z.string(),
}).refine(payload => payload.title.trim() !== '', { message: 'workspace.rename requires a non-blank title' });
/** workspace.rename response value. */
exports.workspaceRenameValueSchema = zod_1.z.object({
    workspace: exports.workspaceViewSchema,
});
/** workspace.delete request payload. */
exports.workspaceDeleteRequestSchema = zod_1.z.object({
    workspaceId: sessions_schema_1.workspaceIdSchema,
});
/** workspace.delete response value. */
exports.workspaceDeleteValueSchema = zod_1.z.object({
    deleted: zod_1.z.literal(true),
});
/** workspace.insertBefore request payload (anchor omitted = append to end). */
exports.workspaceInsertBeforeRequestSchema = zod_1.z.object({
    workspaceId: sessions_schema_1.workspaceIdSchema,
    beforeWorkspaceId: sessions_schema_1.workspaceIdSchema.optional(),
});
/** workspace.insertBefore response value: the complete durable display order. */
exports.workspaceInsertBeforeValueSchema = zod_1.z.object({
    workspaceIds: zod_1.z.array(sessions_schema_1.workspaceIdSchema),
});
/** workspace.insertSessionBefore request payload (anchor omitted = append to end). */
exports.workspaceInsertSessionBeforeRequestSchema = zod_1.z.object({
    workspaceId: sessions_schema_1.workspaceIdSchema,
    sessionId: sessions_schema_1.sessionIdSchema,
    beforeSessionId: sessions_schema_1.sessionIdSchema.optional(),
});
/** workspace.insertSessionBefore response value. */
exports.workspaceInsertSessionBeforeValueSchema = zod_1.z.object({
    workspace: exports.workspaceViewSchema,
});
/** workspace.archiveSession request payload. */
exports.workspaceArchiveSessionRequestSchema = zod_1.z.object({
    sessionId: sessions_schema_1.sessionIdSchema,
});
/** workspace.archiveSession response value: the full updated archive set. */
exports.workspaceArchiveSessionValueSchema = zod_1.z.object({
    archivedSessionIds: zod_1.z.array(sessions_schema_1.sessionIdSchema),
});
exports.workspaceUnarchiveSessionRequestSchema = zod_1.z.object({
    sessionId: sessions_schema_1.sessionIdSchema,
});
exports.workspaceUnarchiveSessionValueSchema = zod_1.z.object({
    archivedSessionIds: zod_1.z.array(sessions_schema_1.sessionIdSchema),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/host.schema.ts

"use strict";
/**
 * host domain zod schemas (names derived from map keys).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostOpenPathValueSchema = exports.hostOpenPathRequestSchema = exports.hostCreateDirectoryValueSchema = exports.hostCreateDirectoryRequestSchema = exports.hostListDirectoryValueSchema = exports.hostListDirectoryRequestSchema = exports.directoryEntrySchema = exports.hostPickDirectoryValueSchema = exports.hostPickDirectoryRequestSchema = exports.hostDescribeValueSchema = exports.hostDescribeRequestSchema = void 0;
const zod_1 = require("zod");
/** host.describe request payload (empty object literal). */
exports.hostDescribeRequestSchema = zod_1.z.object({});
/** host.describe response value. */
exports.hostDescribeValueSchema = zod_1.z.object({
    version: zod_1.z.string(),
    cwd: zod_1.z.string(),
    provider: zod_1.z.string().optional(),
    model: zod_1.z.string().optional(),
    attachedSessions: zod_1.z.number().int().nonnegative(),
    home: zod_1.z.string(),
    canOpenPath: zod_1.z.boolean(),
});
/** host.pickDirectory request payload (empty object literal). */
exports.hostPickDirectoryRequestSchema = zod_1.z.object({});
/** host.pickDirectory response value; null means the user cancelled. */
exports.hostPickDirectoryValueSchema = zod_1.z.object({
    path: zod_1.z.string().nullable(),
});
/** Directory row shared by listing entries and breadcrumb crumbs. */
exports.directoryEntrySchema = zod_1.z.object({
    name: zod_1.z.string(),
    path: zod_1.z.string(),
    hidden: zod_1.z.boolean(),
});
/** host.listDirectory request payload; an absent path lists the home directory. */
exports.hostListDirectoryRequestSchema = zod_1.z.object({
    path: zod_1.z.string().optional(),
});
/** host.listDirectory response value. */
exports.hostListDirectoryValueSchema = zod_1.z.object({
    path: zod_1.z.string(),
    home: zod_1.z.string(),
    crumbs: zod_1.z.array(exports.directoryEntrySchema),
    entries: zod_1.z.array(exports.directoryEntrySchema),
    truncated: zod_1.z.boolean(),
});
/** host.createDirectory request payload: name must be one plain path segment. */
exports.hostCreateDirectoryRequestSchema = zod_1.z.object({
    path: zod_1.z.string(),
    name: zod_1.z.string(),
}).refine(payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !/[/\\]/.test(payload.name), { message: 'host.createDirectory requires a single non-blank path segment name' });
/** host.createDirectory response value: the created directory's absolute path. */
exports.hostCreateDirectoryValueSchema = zod_1.z.object({
    path: zod_1.z.string(),
});
/** host.openPath request payload. */
exports.hostOpenPathRequestSchema = zod_1.z.object({
    path: zod_1.z.string().min(1),
});
/** host.openPath response value. */
exports.hostOpenPathValueSchema = zod_1.z.object({
    opened: zod_1.z.literal(true),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.ts

"use strict";
/**
 * skills domain zod schemas (names derived from map keys: skillListRequestSchema /
 * skillListValueSchema).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillListValueSchema = exports.skillListRequestSchema = exports.skillEntrySchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
/** SkillEntry row of skill.list. */
exports.skillEntrySchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    description: zod_1.z.string(),
    whenToUse: zod_1.z.string().optional(),
    modelInvocable: zod_1.z.boolean(),
});
/** skill.list request payload. */
exports.skillListRequestSchema = zod_1.z.object({
    sessionId: sessions_schema_1.sessionIdSchema,
});
/** skill.list response value. */
exports.skillListValueSchema = zod_1.z.object({
    skills: zod_1.z.array(exports.skillEntrySchema),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.ts

"use strict";
/**
 * agent-presets domain zod schemas (names derived from map keys:
 * agentPresetListRequestSchema / agentPresetListValueSchema).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentPresetRemoveValueSchema = exports.agentPresetRemoveRequestSchema = exports.agentPresetOpenDocumentValueSchema = exports.agentPresetOpenDocumentRequestSchema = exports.agentPresetCopyValueSchema = exports.agentPresetCopyRequestSchema = exports.agentPresetReadValueSchema = exports.agentPresetReadRequestSchema = exports.agentPresetSelectValueSchema = exports.agentPresetSelectRequestSchema = exports.agentPresetListValueSchema = exports.agentPresetListRequestSchema = exports.agentPresetEntrySchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
/** AgentPresetEntry row of agentPreset.list. */
exports.agentPresetEntrySchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    trust: zod_1.z.union([zod_1.z.literal('system'), zod_1.z.literal('user')]),
    isDefault: zod_1.z.boolean(),
    name: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
    broken: zod_1.z.string().min(1).optional(),
});
/** agentPreset.list request payload. */
exports.agentPresetListRequestSchema = zod_1.z.object({});
/** agentPreset.list response value. */
exports.agentPresetListValueSchema = zod_1.z.object({
    presets: zod_1.z.array(exports.agentPresetEntrySchema),
    authorable: zod_1.z.boolean(),
    hasDocument: zod_1.z.boolean(),
});
/** agentPreset.select request payload. */
exports.agentPresetSelectRequestSchema = zod_1.z.object({
    sessionId: sessions_schema_1.sessionIdSchema,
    agentPreset: zod_1.z.string().min(1),
});
/** agentPreset.select response value. */
exports.agentPresetSelectValueSchema = zod_1.z.object({
    agentPreset: zod_1.z.string(),
});
/** agentPreset.read request payload. */
exports.agentPresetReadRequestSchema = zod_1.z.object({
    agentPreset: zod_1.z.string().min(1),
});
/** agentPreset.read response value. */
exports.agentPresetReadValueSchema = zod_1.z.object({
    agentPreset: zod_1.z.string(),
    trust: zod_1.z.union([zod_1.z.literal('system'), zod_1.z.literal('user')]),
    content: zod_1.z.string(),
    name: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
});
/** agentPreset.copy request payload. */
exports.agentPresetCopyRequestSchema = zod_1.z.object({
    from: zod_1.z.string().min(1),
    agentPreset: zod_1.z.string().min(1),
    name: zod_1.z.string().optional(),
});
/** agentPreset.copy response value. */
exports.agentPresetCopyValueSchema = zod_1.z.object({
    agentPreset: zod_1.z.string(),
});
/** agentPreset.openDocument request payload. */
exports.agentPresetOpenDocumentRequestSchema = zod_1.z.object({
    agentPreset: zod_1.z.string().min(1),
});
/** agentPreset.openDocument response value. */
exports.agentPresetOpenDocumentValueSchema = zod_1.z.union([
    zod_1.z.object({ opened: zod_1.z.literal(true) }),
    zod_1.z.object({ opened: zod_1.z.literal(false), path: zod_1.z.string() }),
]);
/** agentPreset.remove request payload. */
exports.agentPresetRemoveRequestSchema = zod_1.z.object({
    agentPreset: zod_1.z.string().min(1),
});
/** agentPreset.remove response value. */
exports.agentPresetRemoveValueSchema = zod_1.z.object({});

},
"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.ts

"use strict";
/**
 * goals domain zod schemas. Mutation-only shapes: every value schema is a
 * `{ ref }` acknowledgement (clear: `{ cleared }`) — the current goal state
 * travels exclusively on the 'goal' session projection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.goalClearValueSchema = exports.goalClearRequestSchema = exports.goalCompleteValueSchema = exports.goalCompleteRequestSchema = exports.goalResumeValueSchema = exports.goalResumeRequestSchema = exports.goalPauseValueSchema = exports.goalPauseRequestSchema = exports.goalEditValueSchema = exports.goalEditRequestSchema = exports.goalCreateValueSchema = exports.goalCreateRequestSchema = exports.goalRefSchema = void 0;
const zod_1 = require("zod");
/** GoalRef schema. */
exports.goalRefSchema = zod_1.z.object({
    id: zod_1.z.string().brand().transform(value => value),
    revision: zod_1.z.number().int().positive(),
});
/** Shared `{ ref }` acknowledgement value of every non-clear mutation. */
const goalRefValueSchema = zod_1.z.object({ ref: exports.goalRefSchema });
/** goal.create request payload. */
exports.goalCreateRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    objective: zod_1.z.string().min(1),
    maxGoalRounds: zod_1.z.number().int().positive().optional(),
});
/** goal.create response value. */
exports.goalCreateValueSchema = goalRefValueSchema;
/** goal.edit request payload. */
exports.goalEditRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    ref: exports.goalRefSchema,
    objective: zod_1.z.string().min(1).optional(),
    maxGoalRounds: zod_1.z.number().int().positive().optional(),
}).refine(value => value.objective !== undefined || value.maxGoalRounds !== undefined, {
    message: 'goal.edit requires objective or maxGoalRounds',
});
/** goal.edit response value. */
exports.goalEditValueSchema = goalRefValueSchema;
/** goal.pause request payload. */
exports.goalPauseRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    ref: exports.goalRefSchema,
});
/** goal.pause response value. */
exports.goalPauseValueSchema = goalRefValueSchema;
/** goal.resume request payload. */
exports.goalResumeRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    ref: exports.goalRefSchema,
});
/** goal.resume response value. */
exports.goalResumeValueSchema = goalRefValueSchema;
/** goal.complete request payload. */
exports.goalCompleteRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    ref: exports.goalRefSchema,
});
/** goal.complete response value. */
exports.goalCompleteValueSchema = goalRefValueSchema;
/** goal.clear request payload. */
exports.goalClearRequestSchema = zod_1.z.object({
    sessionId: zod_1.z.string().brand().transform(value => value),
    ref: exports.goalRefSchema,
});
/** goal.clear response value. */
exports.goalClearValueSchema = zod_1.z.object({
    cleared: zod_1.z.literal(true),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.ts

"use strict";
/**
 * settings domain zod schemas (names derived from map keys: settingsDescribeRequestSchema /
 * settingsDescribeValueSchema / settingsUpdate* / settingsReplace*).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsReplaceValueSchema = exports.settingsMutateValueSchema = exports.settingsMutateRequestSchema = exports.settingsPathOpSchema = exports.settingsReplaceRequestSchema = exports.settingsUpdateValueSchema = exports.settingsUpdateRequestSchema = exports.settingsOpenDocumentValueSchema = exports.settingsOpenDocumentRequestSchema = exports.settingsDescribeValueSchema = exports.settingsDescribeRequestSchema = exports.settingsNamespaceViewSchema = exports.settingsSecretViewSchema = void 0;
const zod_1 = require("zod");
/** One redacted secret slot. */
exports.settingsSecretViewSchema = zod_1.z.object({
    path: zod_1.z.array(zod_1.z.string()),
    set: zod_1.z.boolean(),
});
/** SettingsNamespaceView row of settings.describe and the write responses. */
exports.settingsNamespaceViewSchema = zod_1.z.object({
    ns: zod_1.z.string().min(1),
    schema: zod_1.z.unknown(),
    value: zod_1.z.unknown(),
    base: zod_1.z.unknown().optional(),
    user: zod_1.z.unknown().optional(),
    applies: zod_1.z.union([zod_1.z.literal('live'), zod_1.z.literal('restart')]),
    secrets: zod_1.z.array(exports.settingsSecretViewSchema),
    revision: zod_1.z.number(),
});
/** settings.describe request payload. */
exports.settingsDescribeRequestSchema = zod_1.z.object({});
/** settings.describe response value. */
exports.settingsDescribeValueSchema = zod_1.z.object({
    writable: zod_1.z.boolean(),
    hasDocument: zod_1.z.boolean(),
    namespaces: zod_1.z.array(exports.settingsNamespaceViewSchema),
});
/** settings.openDocument request payload. */
exports.settingsOpenDocumentRequestSchema = zod_1.z.object({});
/** settings.openDocument response value. */
exports.settingsOpenDocumentValueSchema = zod_1.z.object({
    opened: zod_1.z.literal(true),
});
/** settings.update request payload. */
exports.settingsUpdateRequestSchema = zod_1.z.object({
    ns: zod_1.z.string().min(1),
    patch: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
    expectedRevision: zod_1.z.number().optional(),
});
/** settings.update response value: the namespace's new redacted view. */
exports.settingsUpdateValueSchema = exports.settingsNamespaceViewSchema;
/** settings.replace request payload. */
exports.settingsReplaceRequestSchema = zod_1.z.object({
    ns: zod_1.z.string().min(1),
    section: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
    expectedRevision: zod_1.z.number().optional(),
});
/** One path-addressed edit of settings.mutate. */
exports.settingsPathOpSchema = zod_1.z.discriminatedUnion('op', [
    zod_1.z.object({ op: zod_1.z.literal('set'), path: zod_1.z.array(zod_1.z.string()), value: zod_1.z.unknown() }),
    zod_1.z.object({ op: zod_1.z.literal('unset'), path: zod_1.z.array(zod_1.z.string()) }),
]);
/** settings.mutate request payload. */
exports.settingsMutateRequestSchema = zod_1.z.object({
    ns: zod_1.z.string().min(1),
    ops: zod_1.z.array(exports.settingsPathOpSchema),
    expectedRevision: zod_1.z.number().optional(),
});
/** settings.mutate response value: the namespace's new redacted view. */
exports.settingsMutateValueSchema = exports.settingsNamespaceViewSchema;
/** settings.replace response value. */
exports.settingsReplaceValueSchema = exports.settingsNamespaceViewSchema;

},
"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.ts

"use strict";
/**
 * credentials domain zod schemas (names derived from map keys:
 * credentialsDescribeRequestSchema / credentialsDescribeValueSchema / …).
 * The reference-name pattern mirrors the seam's `credentialRef` guard so an
 * invalid name fails as `bad-request` before reaching the service.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.credentialsUnsetValueSchema = exports.credentialsUnsetRequestSchema = exports.credentialsSetValueSchema = exports.credentialsSetRequestSchema = exports.credentialsDescribeValueSchema = exports.credentialsDescribeRequestSchema = exports.credentialViewSchema = exports.credentialRefNameSchema = void 0;
const zod_1 = require("zod");
/** POSIX-portable environment-variable name (the seam's `credentialRef` pattern). */
exports.credentialRefNameSchema = zod_1.z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** CredentialView entry of credentials.describe. */
exports.credentialViewSchema = zod_1.z.object({
    configured: zod_1.z.boolean(),
    source: zod_1.z.string().optional(),
    writable: zod_1.z.boolean(),
});
/** credentials.describe request payload. */
exports.credentialsDescribeRequestSchema = zod_1.z.object({
    refs: zod_1.z.array(exports.credentialRefNameSchema).max(64),
});
/** credentials.describe response value. */
exports.credentialsDescribeValueSchema = zod_1.z.object({
    credentials: zod_1.z.record(zod_1.z.string(), exports.credentialViewSchema),
});
/** credentials.set request payload: the one direction a value crosses this wire. */
exports.credentialsSetRequestSchema = zod_1.z.object({
    ref: exports.credentialRefNameSchema,
    value: zod_1.z.string().min(1),
});
/** credentials.set response value. */
exports.credentialsSetValueSchema = zod_1.z.object({});
/** credentials.unset request payload. */
exports.credentialsUnsetRequestSchema = zod_1.z.object({
    ref: exports.credentialRefNameSchema,
});
/** credentials.unset response value. */
exports.credentialsUnsetValueSchema = zod_1.z.object({});

},
"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.ts

"use strict";
/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmDiscoverModelsValueSchema = exports.llmDiscoverModelsRequestSchema = exports.discoveredModelViewSchema = exports.llmModelsValueSchema = exports.llmModelsRequestSchema = exports.llmProvidersValueSchema = exports.llmProvidersRequestSchema = exports.configurableProviderViewSchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
/** ConfigurableProviderView row of llm.providers. */
exports.configurableProviderViewSchema = zod_1.z.object({
    provider: zod_1.z.string().min(1),
    displayName: zod_1.z.string().min(1),
    settingsNs: zod_1.z.string(),
    settingsPath: zod_1.z.array(zod_1.z.string()),
    active: zod_1.z.boolean(),
    declared: zod_1.z.boolean().optional(),
});
/** llm.providers request payload. */
exports.llmProvidersRequestSchema = zod_1.z.object({});
/** llm.providers response value. */
exports.llmProvidersValueSchema = zod_1.z.object({
    providers: zod_1.z.array(exports.configurableProviderViewSchema),
});
/** llm.models request payload. */
exports.llmModelsRequestSchema = zod_1.z.object({});
/** llm.models response value. */
exports.llmModelsValueSchema = zod_1.z.object({
    groups: zod_1.z.array(sessions_schema_1.modelProviderGroupSchema),
    failures: zod_1.z.array(sessions_schema_1.modelCatalogFailureSchema),
});
/** DiscoveredModelView row of llm.discoverModels. */
exports.discoveredModelViewSchema = zod_1.z.object({
    imageInput: zod_1.z.boolean().optional(),
    imageInputCapability: zod_1.z.unknown().optional(),
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1).optional(),
    contextWindow: zod_1.z.number().int().positive().optional(),
    maxTokens: zod_1.z.number().int().positive().optional(),
});
/** llm.discoverModels request payload. */
exports.llmDiscoverModelsRequestSchema = zod_1.z.object({
    settingsNs: zod_1.z.string().min(1),
    provider: zod_1.z.string().min(1).optional(),
    baseURL: zod_1.z.string().min(1).optional(),
    api: zod_1.z.string().min(1).optional(),
    // Write-only at the host: used for this one interrogation, never stored and
    // never returned. It does ride the client's outgoing envelope like every
    // other secret-bearing payload (`credentials.set`, `settings.update`), which
    // `subscribeEnvelopes()` observers can see — redacting that tap is a
    // configuration-plane-wide change, not this method's to make alone.
    apiKey: zod_1.z.string().min(1).optional(),
});
/** llm.discoverModels response value. */
exports.llmDiscoverModelsValueSchema = zod_1.z.object({
    models: zod_1.z.array(exports.discoveredModelViewSchema),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.ts

"use strict";
/** Zod schemas for the browser-safe subagent domain. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.subagentPromptValueSchema = exports.subagentInterruptValueSchema = exports.subagentInterruptRequestSchema = exports.subagentPromptRequestSchema = exports.subagentHistoryValueSchema = exports.subagentHistoryRequestSchema = exports.subagentListValueSchema = exports.subagentListRequestSchema = exports.subagentListEntrySchema = void 0;
const zod_1 = require("zod");
const sessions_schema_1 = require("./sessions.schema");
/** Healthy and diagnostic durable catalog rows. */
exports.subagentListEntrySchema = zod_1.z.union([
    zod_1.z.object({
        kind: zod_1.z.literal('child'),
        id: sessions_schema_1.sessionIdSchema,
        mode: zod_1.z.literal('one-shot'),
        activity: zod_1.z.union([zod_1.z.literal('running'), zod_1.z.literal('inactive')]),
        hasChildren: zod_1.z.boolean(),
        label: zod_1.z.string().optional(),
    }),
    zod_1.z.object({
        kind: zod_1.z.literal('child'),
        id: sessions_schema_1.sessionIdSchema,
        mode: zod_1.z.literal('continuable'),
        activity: zod_1.z.union([zod_1.z.literal('running'), zod_1.z.literal('inactive')]),
        hasChildren: zod_1.z.boolean(),
        label: zod_1.z.string(),
    }),
    zod_1.z.object({
        kind: zod_1.z.literal('diagnostic'),
        id: sessions_schema_1.sessionIdSchema,
        reason: zod_1.z.union([zod_1.z.literal('corrupt'), zod_1.z.literal('unsupported'), zod_1.z.literal('unavailable')]),
    }),
]);
/** subagent.list request payload. */
exports.subagentListRequestSchema = zod_1.z.object({
    parentSessionId: sessions_schema_1.sessionIdSchema,
});
/** subagent.list response value. */
exports.subagentListValueSchema = zod_1.z.object({
    entries: zod_1.z.array(exports.subagentListEntrySchema),
    parentAvailable: zod_1.z.boolean(),
});
/** subagent.history request payload. */
exports.subagentHistoryRequestSchema = zod_1.z.object({
    parentSessionId: sessions_schema_1.sessionIdSchema,
    childSessionId: sessions_schema_1.sessionIdSchema,
    mode: zod_1.z.union([zod_1.z.literal('one-shot'), zod_1.z.literal('continuable')]),
    beforeSeq: zod_1.z.number().int().nonnegative().optional(),
    maxMessages: zod_1.z.number().int().positive().optional(),
});
/** subagent.history response value. */
exports.subagentHistoryValueSchema = zod_1.z.object({
    events: zod_1.z.array(sessions_schema_1.historyEntrySchema),
    hasMore: zod_1.z.boolean(),
    projections: sessions_schema_1.sessionProjectionsBlockSchema.optional(),
});
/** subagent.prompt request payload. */
exports.subagentPromptRequestSchema = zod_1.z.object({
    parentSessionId: sessions_schema_1.sessionIdSchema,
    childSessionId: sessions_schema_1.sessionIdSchema,
    mode: zod_1.z.literal('continuable'),
    content: zod_1.z.array(sessions_schema_1.contentBlockSchema),
    clientTimeZone: zod_1.z.string().optional(),
});
/** subagent.interrupt request payload. */
exports.subagentInterruptRequestSchema = zod_1.z.object({
    parentSessionId: sessions_schema_1.sessionIdSchema,
    childSessionId: sessions_schema_1.sessionIdSchema,
    mode: zod_1.z.literal('continuable'),
});
/** subagent.interrupt response value. */
exports.subagentInterruptValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
const messageIdSchema = zod_1.z.string().brand().transform(value => value);
/** subagent.prompt response value. */
exports.subagentPromptValueSchema = zod_1.z.object({
    messageId: messageIdSchema,
});

},
"src/modules/client-connection/api-path.js": function(module, exports, require) {
// source: src/modules/client-connection/api-path.ts

"use strict";
/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; both halves share the
 * event paths below for the browser WebSocket downlinks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_EVENTS_PATH = exports.MUX_EVENTS_PATH = exports.API_PATH = void 0;
/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
exports.API_PATH = '/api';
/** Browser mux-frame WebSocket pathname. */
exports.MUX_EVENTS_PATH = `${exports.API_PATH}/events.mux`;
/** Browser host-frame WebSocket pathname. */
exports.HOST_EVENTS_PATH = `${exports.API_PATH}/events.host`;

},
"src/modules/client-connection/rpc.js": function(module, exports, require) {
// source: src/modules/client-connection/rpc.ts

"use strict";
/** Browser caller for generic Connection unary RPC channels. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebConnectionRpc = createWebConnectionRpc;
const index_1 = require("./contracts/host/apiproxy/api/index");
const random_uuid_1 = require("./random-uuid");
const INTERNAL_BASE = 'http://dsh.internal';
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
 * Create the browser-backed generic RPC caller.
 * @returns caller that owns request correlation and response-envelope validation.
 */
function createWebConnectionRpc() {
    return {
        async call(channel, endpoint, payload, signal) {
            assertTarget(channel, endpoint);
            const rpcId = (0, index_1.RpcId)((0, random_uuid_1.randomUuid)());
            const message = {
                type: 'client-request',
                rpcId,
                method: endpoint,
                payload,
            };
            const response = await globalThis.fetch(new URL(`${channel}/${endpoint}`, resolveBase()), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(message),
                ...signal === undefined ? {} : { signal },
            });
            if (!response.ok) {
                throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
            }
            const raw = await response.json();
            const full = index_1.serverResponseSchema.parse(raw);
            if (full.rpcId !== rpcId) {
                throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
            }
            return full.result;
        },
    };
}
function resolveBase() {
    const pageLocation = typeof location === 'undefined' ? undefined : location;
    return pageLocation?.origin !== undefined && pageLocation.origin !== 'null' ? pageLocation.origin : INTERNAL_BASE;
}
function assertTarget(channel, endpoint) {
    const segments = endpoint.split('/');
    if (!CHANNEL_PATTERN.test(channel)
        || segments.some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`);
    }
}

},
"src/modules/client-connection/random-uuid.js": function(module, exports, require) {
// source: src/modules/client-connection/random-uuid.ts

"use strict";
/** Browser-safe UUID generation for client-side wire correlation. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomUuid = randomUuid;
/**
 * Generate an RFC 4122 version 4 UUID without requiring a secure context.
 * @returns a UUID backed by `crypto.getRandomValues()`, which browsers expose on insecure origins.
 */
function randomUuid() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
    view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

},
"src/modules/client-connection/public.js": function(module, exports, require) {
// source: src/modules/client-connection/public.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transportError = exports.AbstractApiClient = exports.RpcId = void 0;
var api_1 = require("./api");
Object.defineProperty(exports, "RpcId", { enumerable: true, get: function () { return api_1.RpcId; } });
Object.defineProperty(exports, "AbstractApiClient", { enumerable: true, get: function () { return api_1.AbstractApiClient; } });
Object.defineProperty(exports, "transportError", { enumerable: true, get: function () { return api_1.transportError; } });

}
};
const __dependencies = {"src/modules/client-connection/index.js":{"./install":"src/modules/client-connection/install.js","./web-api-client":"src/modules/client-connection/web-api-client.js","./rpc":"src/modules/client-connection/rpc.js","./public":"src/modules/client-connection/public.js"},"src/modules/client-connection/install.js":{"./controller":"src/modules/client-connection/controller.js","./loopback-hostname":"src/modules/client-connection/loopback-hostname.js","../jobs/client":"src/modules/jobs/client.js"},"src/modules/client-connection/controller.js":{},"src/modules/client-connection/loopback-hostname.js":{},"src/modules/jobs/client.js":{"./model":"src/modules/jobs/model.js"},"src/modules/jobs/model.js":{},"src/modules/client-connection/web-api-client.js":{"./api":"src/modules/client-connection/api.js","./contracts/host/apiproxy/api/events.schema":"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js","./contracts/host/apiproxy/api/rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./api-path":"src/modules/client-connection/api-path.js"},"src/modules/client-connection/api.js":{"./contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","./contracts/host/apiproxy/fetch/client":"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js"},"src/modules/client-connection/contracts/host/apiproxy/api/index.js":{"./rpc":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js","./rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js":{},"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js":{"../api/rpc":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js","../api/rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","../api/events.schema":"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js","../api/host.schema":"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js","../api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","../api/workspace.schema":"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js","../api/skills.schema":"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js","../api/agent-presets.schema":"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js","../api/goals.schema":"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js","../api/settings.schema":"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js","../api/credentials.schema":"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js","../api/llm.schema":"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js","../api/subagents.schema":"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js":{"./rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./approvals.schema":"src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.js","./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","./jobs.schema":"src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.js","./workspace.schema":"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js":{"./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/api-path.js":{},"src/modules/client-connection/rpc.js":{"./contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","./random-uuid":"src/modules/client-connection/random-uuid.js"},"src/modules/client-connection/random-uuid.js":{},"src/modules/client-connection/public.js":{"./api":"src/modules/client-connection/api.js"}};
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
return __load("src/modules/client-connection/index.js");
}
});
