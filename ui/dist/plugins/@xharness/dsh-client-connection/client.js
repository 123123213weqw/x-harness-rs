// Generated from src/modules/client-connection/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-connection",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-connection/index.js": function(module, exports, require) {
// source: src/modules/client-connection/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.transportError = exports.AbstractApiClient = exports.RpcId = void 0;
exports.apply = apply;
const controller_1 = require("./controller");
const fixture_1 = require("./fixture");
const web_api_client_1 = require("./web-api-client");
const rpc_1 = require("./rpc");
const loopback_hostname_1 = require("./loopback-hostname");
const client_1 = require("../jobs/client");
var api_1 = require("./api");
Object.defineProperty(exports, "RpcId", { enumerable: true, get: function () { return api_1.RpcId; } });
Object.defineProperty(exports, "AbstractApiClient", { enumerable: true, get: function () { return api_1.AbstractApiClient; } });
Object.defineProperty(exports, "transportError", { enumerable: true, get: function () { return api_1.transportError; } });
/** Required services (none — this is the wire root). */
exports.inject = [];
/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
function apply(ctx) {
    const pageLocation = typeof location === 'undefined' ? undefined : location;
    const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture');
    const fixtureClient = fixture ? new fixture_1.FixtureApiClient() : undefined;
    const api = fixtureClient ?? new web_api_client_1.WebApiClient();
    const rpc = fixtureClient?.rpc ?? (0, rpc_1.createWebConnectionRpc)();
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
"src/modules/client-connection/fixture.js": function(module, exports, require) {
// source: src/modules/client-connection/fixture.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FixtureApiClient = void 0;
exports.createFixtureApi = createFixtureApi;
exports.createFixtureFaces = createFixtureFaces;
const sessions_schema_1 = require("./contracts/host/apiproxy/api/sessions.schema");
const subagents_schema_1 = require("./contracts/host/apiproxy/api/subagents.schema");
const host_schema_1 = require("./contracts/host/apiproxy/api/host.schema");
const workspace_schema_1 = require("./contracts/host/apiproxy/api/workspace.schema");
const skills_schema_1 = require("./contracts/host/apiproxy/api/skills.schema");
const agent_presets_schema_1 = require("./contracts/host/apiproxy/api/agent-presets.schema");
const goals_schema_1 = require("./contracts/host/apiproxy/api/goals.schema");
const settings_schema_1 = require("./contracts/host/apiproxy/api/settings.schema");
const credentials_schema_1 = require("./contracts/host/apiproxy/api/credentials.schema");
const llm_schema_1 = require("./contracts/host/apiproxy/api/llm.schema");
const client_1 = require("./contracts/host/apiproxy/fetch/client");
const zod_1 = require("zod");
const runtime_types_1 = require("../shared/runtime-types");
const types_1 = require("./contracts/core/session/types");
const brand_1 = require("./contracts/attachment/attachment/brand");
const types_2 = require("./contracts/interaction/user-approval/types");
const brand_2 = require("./contracts/llm/llm/brand");
const sessions_schema_2 = require("./contracts/host/apiproxy/api/sessions.schema");
const goals_schema_2 = require("./contracts/host/apiproxy/api/goals.schema");
// FixtureApi: standalone UI development without a server. Real contract shape: unary takes
// RpcRequest<P> and returns RpcResponse<T> (echoing the rpcId); streams yield RpcRequest<frame>
// (the fixture IS the fake server, so it mints frame rpcIds); root respond takes ClientResponse
// and returns RpcReceipt. fx-alpha carries a hand-built history script (74 turns, pageable);
// prompt triggers a chunked streaming replay; cancel stops the replay; resident pending
// approval/question requests exercise replay and composer takeover with stable rpcIds.
const message_1 = require("./contracts/llm/llm/message");
const brand_3 = require("./contracts/llm/llm/brand");
// Type-only: the brand constructor is host-side; the fixture casts at its
// wire-fabrication boundary (the schema layer's one-cast-point posture).
const brand_4 = require("./contracts/interaction/commands/brand");
const surface_1 = require("./contracts/core/session/surface");
const api_1 = require("./api");
const random_uuid_1 = require("./random-uuid");
/** The in-process fixture publishes fork lineage independently of the frozen
 * HTTP summary schema, which historically admits only subagent origins. Keep
 * that carrier difference explicit; do not drop fork fields or weaken HTTP.
 */
const FIXTURE_UNARY_VALUE_SCHEMAS = {
    ...client_1.UNARY_VALUE_SCHEMAS,
    'session.list': zod_1.z.object({ items: zod_1.z.array(sessions_schema_1.sessionSummarySchema.extend({ origin: zod_1.z.enum(['subagent', 'fork']).optional() })) }),
};
/** The fake carrier mints like a real one (business code never mints). */
function rpcRequest(payload) {
    return { rpcId: (0, api_1.RpcId)((0, random_uuid_1.randomUuid)()), payload };
}
function text(t) {
    return [{ type: 'text', text: t }];
}
function userMessage(content, source = { kind: 'user' }) {
    return (0, message_1.createUserMessage)({ content, source });
}
function assistantMessage(content, model = 'fx-1') {
    return (0, message_1.createAssistantMessage)({
        content,
        source: { provider: 'fixture', model },
    });
}
function toolResultMessage(callId, content, isError) {
    return (0, message_1.createToolResultMessage)({ callId: (0, brand_3.CallId)(callId), content, isError });
}
const MARKDOWN_FIXTURE = [
    '# Markdown fixture',
    '',
    'Assistant output renders **strong text**, *emphasis*, and `inline code`.',
    '',
    '- first item',
    '  - nested item',
    '',
    '| Area | State |',
    '| --- | --- |',
    '| history | rendered |',
    '| streaming | stable |',
    '',
    '[DeepSeek](https://www.deepseek.com)',
    '',
    '```ts',
    'const markdown = true',
    '```',
].join('\n');
const USER_MARKDOWN_LITERAL = '用户字面量：# 不渲染 `code` [link](https://example.com)';
/**
 * SGR wrapper for the terminal output sample below: authoring the escapes as
 * `\u001b` keeps literal control bytes out of this source file.
 * @param code - the SGR parameter (an ANSI color or attribute number).
 * @param body - the text the attribute applies to.
 * @returns the body wrapped in the attribute and a reset.
 */
function sgr(code, body) {
    return `\u001b[${code}m${body}\u001b[0m`;
}
/**
 * Terminal output sample for fixture turn 66, authored to carry every feature
 * the terminal card draws that turn 60's two prompt rows cannot reach:
 * basic-16 SGR foreground runs (green, red, bright-black) that must resolve to
 * `--dsw-*` tokens, a bold run, column-aligned table rows that must scroll
 * rather than fold, more than DEFAULT_TERMINAL_MAX_LINES (16) lines so the
 * height cap collapses the middle. The exit status is authored separately in
 * TERMINAL_EXIT_STATUS and deliberately absent from this text: the real bash
 * presenter CONSUMES its `[exit code: N]` marker out of the body, because a
 * terminal card shows the exit as its own pill and leaving the marker in would
 * render it twice (packages/shell/tool-bash/src/render.ts).
 */
const TERMINAL_OUTPUT_FIXTURE = [
    sgr(1, 'Running 4 checks'),
    `${sgr(32, '\u2713')} typecheck                                          1.82s`,
    `${sgr(32, '\u2713')} lint                                               0.94s`,
    `${sgr(32, '\u2713')} duplication                                        2.10s`,
    `${sgr(31, '\u2717')} unit                                               8.41s`,
    '',
    sgr(90, 'packages/client/ui-primitives/tests/terminal-block.client.spec.tsx'),
    `  ${sgr(31, 'FAIL')} caps output at the configured line budget`,
    '    expected 16 lines, received 24',
    '',
    'NAME                        LINES    BRANCHES    FUNCTIONS    UNCOVERED',
    'TerminalBlock.tsx           100%     100%        100%         -',
    'ansi.ts                     100%     100%        100%         -',
    'clipboard.ts                100%     100%        100%         -',
    'CodeBlock.tsx               98.4%    96.2%       100%         41-43',
    'highlight.ts                100%     100%        100%         -',
    'Pill.tsx                    100%     100%        100%         -',
    'StateDot.tsx                100%     100%        100%         -',
    'markdown/Markdown.tsx       100%     100%        100%         -',
    '',
    sgr(31, '1 of 4 checks failed'),
].join('\n');
/**
 * Exit status for each terminal sample, keyed by its output text. Authored
 * alongside the sample rather than parsed back out of its trailing marker,
 * which is the bash tool's own job and not something to reimplement here.
 */
const TERMINAL_EXIT_STATUS = {
    [TERMINAL_OUTPUT_FIXTURE]: { exitCode: 1 },
};
/**
 * Structured grep result for the search sample (turn 67): matches grouped by
 * file, authored inline because the client-side fixture cannot import the tool
 * that produces the canonical value. `truncated` with a larger `total` than the
 * retained match count exercises the search card's capped indicator; the file
 * with more than CHAT_SEARCH_MAX_LINES rows exercises its head/tail height cap.
 */
const SEARCH_MATCHES_FIXTURE = [
    {
        path: 'packages/client/ui-primitives/src/SearchBlock.tsx',
        matches: [
            { lineNumber: 16, line: 'export const DEFAULT_SEARCH_MAX_LINES = 16' },
            { lineNumber: 138, line: 'export function SearchBlock(props: SearchBlockProps) {' },
            { lineNumber: 141, line: '  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())' },
        ],
    },
    {
        path: 'packages/client/ui-tool/src/client/tool/models/search-card-model.ts',
        matches: [
            { lineNumber: 45, line: 'export const CHAT_SEARCH_MAX_LINES = 8' },
            { lineNumber: 130, line: 'export function searchCardModel(block: ToolCallBlock): SearchCardModel | null {' },
        ],
    },
    {
        path: 'packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx',
        matches: [
            { lineNumber: 34, line: 'export function SearchRow({ toolName, block, inspect, t }: SearchRowProps) {' },
            { lineNumber: 36, line: '  const search = searchCardModel(block)' },
            { lineNumber: 56, line: '      search={search}' },
            { lineNumber: 78, line: "      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'grep', locale: NS }, SearchRow)" },
        ],
    },
];
/**
 * The model-facing grep render text for the sample — what a UI without a search
 * card shows, attached as the view's `content`. Mirrors the real grep
 * presenter's shape (see formatGrepOutput in dsh-tool-fs-search): a
 * `Found X of Y matches` header, the matches grouped under file headers with
 * `Line N:` rows, then a spill-recovery footer.
 */
const SEARCH_MATCHES_TEXT = [
    'Found 9 of 42 matches',
    '',
    ...SEARCH_MATCHES_FIXTURE.map(file => [file.path, ...file.matches.map(m => `Line ${m.lineNumber}: ${m.line}`)].join('\n')),
    '',
    '(Full grep result stored at: fixture://spill/grep-66. Read it to see every match.)',
].join('\n');
/**
 * Structured glob result for the search sample (turn 68): a flat path list,
 * truncated with a larger `total` so the path card shows its capped indicator.
 */
const SEARCH_PATHS_FIXTURE = [
    'packages/client/ui-primitives/src/SearchBlock.tsx',
    'packages/client/ui-primitives/src/SearchBlock.module.css',
    'packages/client/ui-tool/src/client/tool/models/search-card-model.ts',
    'packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx',
    'packages/client/ui-tool/tests/search-card.client.spec.tsx',
];
/**
 * The model-facing glob render text — the newline-joined path list plus a
 * spill-recovery footer, mirroring the real glob presenter's shape (see
 * formatGlobOutput in dsh-tool-fs-search).
 */
const SEARCH_PATHS_TEXT = [
    ...SEARCH_PATHS_FIXTURE,
    '',
    '(Showing 5 of 23 paths. Full sorted result stored at: fixture://spill/glob-67. Read it to see every path.)',
].join('\n');
/**
 * Read-card sample for the read turn: a WINDOW past an offset, so the line
 * numbers start above 1 (the card's gutter keeps the file's own numbering) and
 * `totalLines` exceeds the window (the card shows a "showing N of M" note). The
 * fixture is client-side and cannot import the read tool, so the structured
 * window is authored inline exactly as the tool would project it through
 * `presentationMeta`. `lang` is a `ts` hint so the shiki path highlights it.
 */
const READ_SAMPLE_FIRST_LINE = 41;
const READ_SAMPLE_SOURCE = [
    'export interface ReadBlockProps {',
    '  label?: string | undefined',
    '  lines: readonly ReadBlockLine[]',
    '  totalLines: number',
    '  lang?: string | undefined',
    '  maxLines?: number | undefined',
    '  className?: string | undefined',
    '}',
    '',
    '// A windowed read keeps the file line numbers in the gutter.',
    'const marker = "fixture read sample"',
];
const READ_SAMPLE_LINES = READ_SAMPLE_SOURCE.map((text, index) => ({ number: READ_SAMPLE_FIRST_LINE + index, text }));
const READ_SAMPLE_PATH = 'packages/client/ui-primitives/src/ReadBlock.tsx';
const READ_SAMPLE_TOTAL = 180;
const READ_SAMPLE_TEXT = READ_SAMPLE_SOURCE.map((text, index) => `${READ_SAMPLE_FIRST_LINE + index}: ${text}`).join('\n');
/**
 * The structured `web_search` result view for the web-search turn, authored inline
 * because this client-side fixture cannot import the web tool that projects it.
 * The sources exercise the citation list's features: a titled source with a
 * snippet and a date, a source with no title (its hostname labels the link) and
 * a snippet but no date, and a source with a title and a date but no snippet.
 * `truncated` marks the capped indicator. The shape is the contract's own
 * search view minus its wire discriminants.
 */
const WEB_SEARCH_RESULT = {
    answer: 'DeepSeek Harness is a plugin-based agent harness on vendored Cordis where **every capability is a plugin**.',
    sources: [
        {
            url: 'https://github.com/deepseek-ai/deepseek-harness',
            title: 'DeepSeek Harness — plugin-based agent harness',
            snippet: 'Everything is a plugin: session, tools, agent-loop, and LLM adapters all mount on the same Cordis context.',
            publishedAt: '2026-07-01',
        },
        {
            url: 'https://www.deepseek.com/blog/harness-architecture',
            snippet: 'The capability-seam pattern splits each capability into interface, implementation, and consumer packages.',
        },
        {
            url: 'https://docs.deepseek.com/harness/plugins',
            title: 'Writing a harness plugin',
            publishedAt: '2026-06-15',
        },
    ],
    truncated: true,
};
/** The `web_fetch` result view for the web-fetch turn, authored inline for the same reason. */
const WEB_FETCH_RESULT = {
    url: 'https://www.deepseek.com/blog/harness-architecture',
    statusCode: 200,
    truncated: false,
};
const DEEPSEEK_REASONING = {
    efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
};
const OPENAI_REASONING = {
    efforts: [
        { id: 'off', name: 'Off' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'medium',
};
/** Catalog served by `session.models` and `llm.models` alike (fresh copies per call). */
function fixtureModelGroups() {
    return [
        {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
                {
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek-V4-Flash',
                    description: '快速响应',
                    reasoning: DEEPSEEK_REASONING,
                },
                {
                    id: 'deepseek-v4-pro',
                    name: 'DeepSeek-V4-Pro',
                    description: '复杂任务',
                    reasoning: DEEPSEEK_REASONING,
                },
            ],
        },
        {
            id: 'openai',
            name: 'OpenAI',
            models: [{ id: 'gpt-5', name: 'GPT-5', reasoning: OPENAI_REASONING }],
        },
    ];
}
function sid(id) { return (0, types_1.SessionId)(id); }
const FIXTURE_IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAAvklEQVR42u3SMQ0AAAjAMIyhELM4AAe8PD1qYFlk9cCXEAEDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGxIBCYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIAYEAyIAcGAGBAMiAHBgBgQDIgBwYAYEAyIAcGAGBAMiAHBgBgQDIgB4bYWLb6pnOb1xAAAAABJRU5ErkJggg==';
const FIXTURE_IMAGE_REF = {
    attachmentId: (0, brand_1.AttachmentId)('fixture:image'),
    mediaType: 'image/png',
    bytes: 247,
    width: 160,
    height: 90,
    name: 'fixture-image.png',
};
/** Deterministic provider billing attached to fixture assistant messages. */
function fixtureUsage(turn, step) {
    return {
        inputTokens: 20 + turn % 5,
        outputTokens: 8 + step,
        cacheReadTokens: turn === 0 ? 0 : 80,
        cacheWriteTokens: turn % 10 === 0 ? 4 : 0,
    };
}
/** fx-alpha history script: 75 turns (~150+ messages -> 4 pages at PAGE_MESSAGES=50),
 *  mixing reasoning blocks / tool call+result / context. */
function buildAlphaLog() {
    const events = [];
    let time = Date.now() - 3600000;
    const push = (e) => {
        const seq = events.length;
        const authored = e.type === 'assistant/message' ? { ...e, data: { ...e.data, usage: fixtureUsage(e.data.turn, e.data.step) } } : e;
        events.push({ seq, time: (time += 800), ...authored });
        return seq;
    };
    // This resident history represents completed model requests, so retain the
    // route capacity that accompanied them just as the live prompt path does.
    push({
        type: 'request/context',
        data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 128000 },
    });
    for (let turn = 0; turn < 60; turn++) {
        push({ type: 'turn/start', data: { turn } });
        const userSeq = push({
            type: 'user/message', surfaceOp: 'append',
            data: userMessage(text(turn === 59 ? USER_MARKDOWN_LITERAL : `问题 ${turn}：fixture 历史消息，用于翻页与渲染验收。`)),
        });
        if (turn === 0) {
            push({
                type: 'session/title',
                data: { title: 'Fixture 历史会话', messageSeqs: [userSeq], source: { kind: 'fallback' } },
            });
        }
        if (turn % 9 === 4) {
            push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`[fixture] 上下文注入（turn ${turn}）`), { kind: 'plugin', plugin: 'fixture' }) });
        }
        push({ type: 'step/start', data: { turn, step: 0 } });
        const withTool = turn % 5 === 2;
        const withReasoning = turn % 3 === 1;
        const blocks = [];
        if (withReasoning)
            blocks.push({ type: 'reasoning', text: `思考过程 ${turn}：这是一段可折叠的 reasoning 内容。` });
        blocks.push({ type: 'text', text: turn === 59 ? MARKDOWN_FIXTURE : `回答 ${turn}：这是 fixture 生成的历史回复正文。` });
        if (withTool) {
            const callId = `fx-call-${turn}`;
            blocks.push({ type: 'tool-call', id: (0, brand_3.CallId)(callId), name: 'echo', arguments: `{"text":"turn ${turn}"}` });
            push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, message: assistantMessage(blocks) } });
            push({ type: 'tool/call', data: { turn, step: 0, callId: (0, brand_3.CallId)(callId), name: 'echo', arguments: `{"text":"turn ${turn}"}` } });
            push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 0, message: toolResultMessage(callId, text(`ECHO: TURN ${turn}`), turn % 25 === 12) } });
            push({ type: 'step/end', data: { turn, step: 0 } });
            push({ type: 'step/start', data: { turn, step: 1 } });
            push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: assistantMessage(text(`工具结果已消化（turn ${turn}）。`)) } });
            push({ type: 'step/end', data: { turn, step: 1 } });
        }
        else {
            push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, message: assistantMessage(blocks) } });
            push({ type: 'step/end', data: { turn, step: 0 } });
        }
        push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    }
    // Three view-sample turns (60-62) cover the built-in card types. The real filesystem names in
    // turns 62-63 also exercise their dedicated generic-row icon/title/path summaries. `echo` above
    // stays presenter-less as the unknown fallback.
    const toolTurn = (turn, name, args, resultText) => {
        const callId = `fx-call-${turn}`;
        push({ type: 'turn/start', data: { turn } });
        push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`问题 ${turn}：${name} 样本。`)) });
        push({ type: 'step/start', data: { turn, step: 0 } });
        push({
            type: 'assistant/message', surfaceOp: 'append',
            data: { turn, step: 0, message: assistantMessage([{ type: 'tool-call', id: (0, brand_3.CallId)(callId), name, arguments: args }]) },
        });
        push({ type: 'tool/call', data: { turn, step: 0, callId: (0, brand_3.CallId)(callId), name, arguments: args } });
        push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 0, message: toolResultMessage(callId, text(resultText), false) } });
        push({ type: 'step/end', data: { turn, step: 0 } });
        push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    };
    // A two-line command, so the fixture covers the terminal card's one-row-per-
    // command-line prompt (and that the card still marks the call exactly once).
    toolTurn(60, 'fx-bash', '{"command":"ls -la\\necho done","cwd":"/tmp/fixture"}', 'total 2\ndrwxr-xr-x fixture\n-rw-r--r-- demo.txt');
    toolTurn(61, 'fx-write', '{"path":"notes/demo.txt","content":"hello fixture\\n"}', 'wrote notes/demo.txt');
    toolTurn(62, 'edit', '{"file_path":"notes/demo.txt","old_string":"hello","new_string":"hello fixture"}', '已编辑');
    toolTurn(63, 'write', '{"file_path":"notes/new-demo.txt","content":"hello fixture\\n"}', '已写入');
    // Turn 64: a multi-hunk edit — two scattered replacements in one file. Named
    // `edit` so it lands on the keyed FileMutationRow (the resident diff card the
    // single-hunk turn 62 also uses), and file_path `src/config.ts` is the marker
    // the presenter reads to emit the two-hunk sample: the card draws one path
    // header, the first hunk, a `⋯` gap, then the second (the same-file
    // second-hunk arm turns 62/63 cannot reach).
    toolTurn(64, 'edit', '{"file_path":"src/config.ts","old_string":"const timeout = 30","new_string":"const timeout = 60"}', '已编辑');
    // Turn 65: one run_code turn with three logged sub-dispatches — the Code
    // Mode acceptance surface (parent code row + nested native-identical rows,
    // including an isError sub-call and a bash sub-call that must hit the same
    // keyed registration a top-level bash row uses).
    {
        const turn = 65;
        const callId = `fx-call-${turn}`;
        const program = 'const listing = await tools.bash({ command: "ls notes", description: "List notes" })\n'
            + 'const demo = await tools.read({ file_path: "notes/demo.txt" })\n'
            + 'await tools.read({ file_path: "notes/missing.txt" }).catch(() => "tolerated")\n'
            + 'return { listing, demo }';
        const args = JSON.stringify({ code: program, description: 'Read the notes files and summarize' });
        push({ type: 'turn/start', data: { turn } });
        push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`问题 ${turn}：run_code 样本。`)) });
        push({ type: 'step/start', data: { turn, step: 0 } });
        push({
            type: 'assistant/message', surfaceOp: 'append',
            data: { turn, step: 0, message: assistantMessage([{ type: 'tool-call', id: (0, brand_3.CallId)(callId), name: 'run_code', arguments: args }]) },
        });
        push({ type: 'tool/call', data: { turn, step: 0, callId: (0, brand_3.CallId)(callId), name: 'run_code', arguments: args } });
        const dispatchPair = (n, name, dispatchArgs, resultText, isError = false) => {
            push({
                type: 'tool/code-dispatch-start',
                data: { rootCallId: callId, parentCallId: callId, subCallId: `${callId}:code:${n}`, name, arguments: dispatchArgs },
            });
            push({
                type: 'tool/code-dispatch',
                data: {
                    rootCallId: callId, parentCallId: callId, subCallId: `${callId}:code:${n}`, name,
                    arguments: dispatchArgs, isError, content: [{ type: 'text', text: resultText }],
                },
            });
        };
        dispatchPair(1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt\nnew-demo.txt');
        dispatchPair(2, 'read', { file_path: 'notes/demo.txt' }, 'hello fixture\n');
        dispatchPair(3, 'read', { file_path: 'notes/missing.txt' }, 'Error: ENOENT: notes/missing.txt not found', true);
        push({
            type: 'tool/result', surfaceOp: 'append',
            data: { turn, step: 0, message: toolResultMessage(callId, text('{"listing":"demo.txt\\nnew-demo.txt","demo":"hello fixture\\n"}'), false) },
        });
        push({ type: 'step/end', data: { turn, step: 0 } });
        push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    }
    // Turn 74: todo_write sample — the TodoRow toolview in the flow plus the
    // todo/write snapshot event feeding the TodoPanel plan strip. Two items are
    // in_progress: this fixture chooses the parallel policy, so both surfaces
    // must render a parallel plan rather than the first active item alone.
    const fixtureTodos = [
        { content: '梳理需求', status: 'completed' },
        { content: '实现 fixture 样本', status: 'in_progress' },
        { content: '跑后台构建', status: 'in_progress' },
        { content: '浏览器验收', status: 'pending' },
    ];
    // Turn 66: the terminal sample turn 60's two clean prompt rows cannot cover —
    // ANSI SGR coloring, output past the terminal card's height cap, a nested cwd
    // whose prompt label is its last segment, and a non-zero exit authored beside
    // the sample in TERMINAL_EXIT_STATUS — its body deliberately carries no
    // `[exit code: N]` marker, since the real presenter consumes that one out of
    // the body. Named `bash`, so it also covers
    // the keyed toolview row (turn 60's `fx-bash` covers the render-site fallback
    // row) — the two chat-row shapes the terminal card renders in.
    //
    // Ordered BEFORE the todo turn deliberately: the standing plan retires at the
    // next `turn/start`, so a turn appended after it would leave the dock's plan
    // strip empty and take the todo surfaces' own coverage with it.
    toolTurn(66, 'bash', '{"command":"pnpm run check","cwd":"/tmp/fixture/deep/nested"}', TERMINAL_OUTPUT_FIXTURE);
    // Turns 67-68: the search card's two shapes. `grep` emits a `card: 'search'`
    // `shape: 'matches'` result view (grouped-by-file matches, truncated with a
    // larger `total`), `glob` emits `shape: 'paths'` (a flat path list, likewise
    // truncated). Both ride the keyed SearchRow registration under their own
    // names; the render-site fallback row is covered by the model derivation
    // tests, since every fixture search tool has a keyed row. Ordered before the
    // todo turn for the same standing-plan reason the bash turn is.
    toolTurn(67, 'grep', '{"pattern":"SEARCH_MAX_LINES","path":"packages/client"}', SEARCH_MATCHES_TEXT);
    toolTurn(68, 'glob', '{"pattern":"**/SearchBlock*","path":"packages/client"}', SEARCH_PATHS_TEXT);
    // Turn 69: the read sample — a WINDOW past an offset so the card draws file
    // line numbers starting above 1 and a "showing N of M" note (the window is
    // shorter than READ_SAMPLE_TOTAL), with a `ts` language hint the shiki path
    // highlights. Named `read`, so it exercises the keyed ReadRow registration.
    // The render-site fallback ROW SHAPE (a read call on the generic flattened
    // path) is covered by the turn 65 run_code read sub-dispatches, which
    // session.ts folds with resultView: null; the fallback-row + read-CARD
    // combination is pinned by the web_fetch case in read-card.spec.tsx, not by
    // this fixture. The read render intent is result-side only, so its pending
    // call stays a generic `kind: 'read'` card; presentResult carries the
    // structured window.
    toolTurn(69, 'read', `{"file_path":${JSON.stringify(READ_SAMPLE_PATH)},"offset":${READ_SAMPLE_FIRST_LINE}}`, READ_SAMPLE_TEXT);
    // Turns 70-71: the web render intent — a web_search whose result view carries
    // structured sources plus an answer (the citation list, one source lacking a
    // title so its hostname labels the link, the capped indicator on), and a
    // web_fetch whose result view carries the fetched URL and its HTTP status.
    // Both keep a generic pending call view and add the `web` card only at
    // result time, which is the contract's result-only web shape. Named after
    // the real tools so they hit the keyed WebRow registration. Ordered BEFORE
    // the todo turn for the same reason turn 66 is: the standing plan retires at
    // the next turn/start, so a turn after it would empty the dock's plan strip.
    toolTurn(70, 'web_search', '{"queries":["deepseek harness architecture"]}', 'Search results for deepseek harness architecture.');
    toolTurn(71, 'web_fetch', '{"url":"https://www.deepseek.com/blog/harness-architecture"}', '# Harness architecture\n\nEverything is a plugin.');
    // Turn 72: max-tokens sample — the provider ends the turn at its output cap
    // mid-sentence, so the chat flow must render the turn-max-tokens notice
    // instead of ending silently. Ordered before the todo turn for the same
    // standing-plan reason the bash turn is.
    push({ type: 'turn/start', data: { turn: 72 } });
    push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text('问题 72：请完整列出全部一百条条目。')) });
    push({ type: 'step/start', data: { turn: 72, step: 0 } });
    push({
        type: 'assistant/message',
        surfaceOp: 'append',
        data: { turn: 72, step: 0, message: assistantMessage(text('条目 1：第一条。条目 2：第二条。条目 3：这一条写到一半被')) },
    });
    push({ type: 'step/end', data: { turn: 72, step: 0 } });
    push({ type: 'turn/end', data: { turn: 72, reason: { kind: 'max-tokens' } } });
    // Turn 73: user and assistant images share one durable fixture object.
    // The todo turn remains last so its standing projection stays visible.
    push({ type: 'turn/start', data: { turn: 73 } });
    push({
        type: 'user/message',
        surfaceOp: 'append',
        data: userMessage([{ type: 'image', attachment: FIXTURE_IMAGE_REF }, ...text('历史用户图片')]),
    });
    push({ type: 'step/start', data: { turn: 73, step: 0 } });
    push({
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
            turn: 73,
            step: 0,
            message: assistantMessage([...text('结构化模型图片：'), { type: 'image', attachment: FIXTURE_IMAGE_REF }], 'fx-vision'),
        },
    });
    push({ type: 'step/end', data: { turn: 73, step: 0 } });
    push({ type: 'turn/end', data: { turn: 73, reason: { kind: 'completed' } } });
    const todoArgs = JSON.stringify({ todos: fixtureTodos });
    toolTurn(74, 'todo_write', todoArgs, 'Updated todo list: 1 pending, 2 in progress, 1 completed.');
    // The real tool appends the snapshot mid-execution — between tool/call and
    // tool/result — so the fixture reproduces that exact ordering (the last
    // toolTurn events run ... tool/call, tool/result, step/end, turn/end).
    const callIndex = events.length - 4;
    const callTime = events[callIndex]?.time;
    if (callTime === undefined)
        throw new Error('fixture todo turn has no tool call');
    events.splice(callIndex + 1, 0, { type: 'todo/write', seq: callIndex + 1, time: callTime + 400, data: { todos: fixtureTodos } });
    events.forEach((e, i) => { e.seq = i; });
    return events;
}
/** Narrows a parsed-JSON field to string; fixture args are authored in-file, so non-strings only mean a typo here. */
/* v8 ignore next -- the fallback arm is the same in-file-typo guard as the JSON.parse catch above. */
const str = (value, fallback = '') => typeof value === 'string' ? value : fallback;
/** Fixture presenter registry (mirrors host viewFor): pure derivation, undefined = no view. */
function presentCall(name, argsRaw) {
    let args;
    try {
        const raw = JSON.parse(argsRaw);
        if (!(0, runtime_types_1.isObjectRecord)(raw))
            return undefined;
        args = raw;
    }
    catch {
        /* v8 ignore next 2 -- defensive: fixture args are authored in-file as valid JSON; only an in-file typo could reach the catch. */
        return undefined;
    }
    switch (name) {
        // Both names present the same terminal card: `fx-bash` lands on the
        // render-site fallback row, `bash` on the keyed BashRow registration.
        case 'fx-bash':
        case 'bash':
            return { card: 'terminal', title: str(args.command), cwd: str(args.cwd, '/tmp/fixture'), description: 'fixture 终端样本' };
        case 'fx-write':
            return {
                card: 'diff', title: `Write ${str(args.path)}`,
                diffs: [{ path: str(args.path), oldText: null, newText: str(args.content) }],
            };
        // A read pending call is a GENERIC card (kind: 'read', a follow-along
        // location): the read render intent is result-side only, because a call
        // carries no file content until execute returns. The rich read card arrives
        // in presentResult.
        case 'read':
            return { card: 'generic', title: `Read ${str(args.file_path)}`, kind: 'read', locations: [{ path: str(args.file_path) }] };
        case 'edit':
            // The multi-hunk sample (turn 64) is keyed on its file_path, so the two
            // scattered hunks share one path header and the card draws the `⋯` gap.
            if (str(args.file_path) === 'src/config.ts') {
                return {
                    card: 'diff', title: `Edit ${str(args.file_path)}`,
                    diffs: [
                        { path: str(args.file_path), oldText: 'const timeout = 30', newText: 'const timeout = 60' },
                        { path: str(args.file_path), oldText: 'retries: 1', newText: 'retries: 3' },
                    ],
                };
            }
            return {
                card: 'diff', title: `Edit ${str(args.file_path)}`,
                diffs: [{ path: str(args.file_path), oldText: str(args.old_string), newText: str(args.new_string) }],
            };
        case 'write':
            return {
                card: 'diff', title: `Write ${str(args.file_path)}`,
                diffs: [{ path: str(args.file_path), oldText: null, newText: str(args.content) }],
            };
        // A search call stays a generic card (kind: 'search'): the structured
        // matches/paths exist only after execute, so the search card is result-time
        // only (presentResult builds it). This mirrors the real grep/glob presenters.
        case 'grep':
            return { card: 'generic', title: `Grep ${str(args.pattern)}`, kind: 'search', rawInput: args };
        case 'glob':
            return { card: 'generic', title: `Glob ${str(args.pattern)}`, kind: 'search', rawInput: args };
        // The web tools keep a GENERIC pending card and add the `web` result card
        // only at result time (the contract's result-only web shape); their pending
        // kind matches the result kind so a call and its result read as one category.
        case 'web_search': {
            const queries = isUnknownArray(args.queries) ? args.queries.filter((query) => typeof query === 'string' && query !== '') : [];
            const title = queries.join(', ');
            return { card: 'generic', title: `Search ${title}`, kind: 'search', rawInput: args };
        }
        case 'web_fetch':
            return { card: 'generic', title: `Fetch ${str(args.url)}`, kind: 'fetch', rawInput: args };
        default:
            return undefined; // echo et al: the documented no-view fallback path
    }
}
function presentResult(name, argsRaw, resultText) {
    const call = presentCall(name, argsRaw);
    if (call === undefined)
        return undefined;
    // Search is result-time only: the call stays a generic search card, and the
    // result view carries the structured shape the card renders. The view holds no
    // result text — a UI without a search card falls back to the raw tool/result
    // content — so the truncation recovery footer rides that raw content (the
    // `toolTurn` message text), not the view. `total` exceeds the retained count so
    // the card shows its capped indicator.
    if (name === 'grep') {
        return { card: 'search', shape: 'matches', files: SEARCH_MATCHES_FIXTURE, truncated: true, total: 42 };
    }
    if (name === 'glob') {
        return { card: 'search', shape: 'paths', paths: SEARCH_PATHS_FIXTURE, truncated: true, total: 23 };
    }
    // The read result is the structured window the tool projects through
    // `presentationMeta`; the fixture authors it inline (it cannot import the
    // tool). Keyed on the name because the read pending call is a generic card,
    // so `call.card` alone does not distinguish it from edit/write.
    if (name === 'read') {
        return {
            card: 'read', path: READ_SAMPLE_PATH, offset: READ_SAMPLE_FIRST_LINE, lines: READ_SAMPLE_LINES,
            totalLines: READ_SAMPLE_TOTAL, lang: 'ts', content: text(resultText),
        };
    }
    // The web tools keep a generic pending card, so their result card is chosen
    // by tool name rather than by the pending card tag: the structured `web` card
    // the frontend consumes. The view carries no `content` copy (per the contract
    // and the web-result-card note); a capability-less UI falls back to the raw
    // `tool/result` content, which this fixture emits from `resultText`.
    if (name === 'web_search') {
        return { card: 'web', kind: 'search', ...WEB_SEARCH_RESULT };
    }
    if (name === 'web_fetch') {
        return { card: 'web', kind: 'fetch', ...WEB_FETCH_RESULT };
    }
    switch (call.card) {
        case 'terminal':
            // The sample's own exit status, authored beside it: re-parsing the
            // trailing marker here would duplicate the bash tool's `parseExitStatus`,
            // which this client-side fixture cannot import.
            return { card: 'terminal', output: resultText, ...(TERMINAL_EXIT_STATUS[resultText] ?? { exitCode: 0 }) };
        case 'diff':
            return { card: 'diff', diffs: call.diffs };
        case 'generic':
            return { card: 'generic', content: text(resultText) };
    }
}
/** Host-side viewFor mirror: tool/call presents from its own args; tool/result back-scans the log for the paired call. */
function viewFor(event, log) {
    if (event.type === 'tool/call') {
        const view = presentCall(event.data.name, event.data.arguments);
        return view === undefined ? undefined : { for: 'call', view };
    }
    if (event.type === 'tool/result') {
        const callId = String(event.data.message.source.callId);
        for (let i = log.length - 1; i >= 0; i--) {
            const candidate = log[i];
            /* v8 ignore next -- dense-array guard: i stays within [0, log.length),
            so the undefined arm needs a sparse log no code path builds. */
            if (candidate !== undefined && candidate.type === 'tool/call' && String(candidate.data.callId) === callId) {
                const resultText = event.data.message.content[0].content.map(b => (b.type === 'text' ? b.text : '')).join('');
                const view = presentResult(candidate.data.name, candidate.data.arguments, resultText);
                return view === undefined ? undefined : { for: 'result', view };
            }
        }
        return undefined; // cross-page unpaired: documented default
    }
    return undefined;
}
/**
 * Fixture parallel of the plan unit's lifecycle fold. The paired
 * `command/done` retains successful plan selections and drops failures;
 * `plan/mode` commits one. `wanted` is exposed for the prompt boundary (the
 * fixture's step/start parallel).
 */
function foldPlan(log) {
    let active = false;
    let wanted = null;
    let running = null;
    for (const event of log) {
        const item = event;
        if (item.type === 'command/run' && item.data?.['name'] === 'plan') {
            const args = item.data['args'];
            if (typeof args !== 'string')
                continue;
            running = { commandId: item.data['commandId'], wanted: args.trim() !== 'off' };
        }
        else if (item.type === 'command/done'
            && item.data !== undefined
            && running !== null
            && item.data['commandId'] === running.commandId) {
            wanted = item.data['kind'] === 'success' && running.wanted !== active ? running.wanted : null;
            running = null;
        }
        else if (item.type === 'plan/mode') {
            active = item.data?.['active'] === true;
            wanted = null;
        }
    }
    const selected = running?.wanted ?? wanted;
    return { active, pending: selected !== null && selected !== active, wanted: selected };
}
/** The plan projection's wire view over the full log. */
function planViewOf(log) {
    const plan = foldPlan(log);
    return { active: plan.active, pending: plan.pending };
}
/** Fixture parallel of the host's projection units: whole current values per key over the full log. */
/** Fixture preset table (the host PermissionPresetService defaults). */
const PERMISSION_PRESETS = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', description: 'Full file access without approval prompts.' },
};
/** Host permissions-unit parallel: fold the three knob events, derive the select over the fixture defaults. */
function permissionSelectOf(log) {
    let preset = null;
    let sandbox = 'workspace-write';
    let approval = 'ask';
    for (const event of log) {
        const item = event;
        if (item.type === 'permission/preset')
            preset = item.data.preset;
        else if (item.type === 'sandbox/mode')
            sandbox = item.data.mode;
        else if (item.type === 'approval/policy')
            approval = item.data.policy;
    }
    const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
    let currentValue = 'custom';
    const folded = preset === null ? undefined : PERMISSION_PRESETS[preset];
    if (preset !== null && folded !== undefined && matches(folded)) {
        currentValue = preset;
    }
    else {
        for (const [name, spec] of Object.entries(PERMISSION_PRESETS)) {
            if (matches(spec)) {
                currentValue = name;
                break;
            }
        }
    }
    return {
        options: [
            ...Object.entries(PERMISSION_PRESETS).map(([value, spec]) => ({ value, name: value, description: spec.description })),
            ...currentValue === 'custom' ? [{ value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }] : [],
        ],
        currentValue,
    };
}
/** Read one provider usage sample from either durable carrier. */
function usageSampleOf(event) {
    const item = event;
    const usage = item.type === 'assistant/chunk' && item.data.chunk?.type === 'usage'
        ? item.data.chunk.usage
        : item.type === 'assistant/message'
            ? item.data.usage
            : undefined;
    return usage === undefined || (item.type !== 'assistant/chunk' && item.type !== 'assistant/message')
        ? undefined
        : { turn: item.data.turn, step: item.data.step, usage };
}
/** Fixture parallel of token-meter's last-sample-replacing usage projection. */
function tokenUsageOf(log) {
    const totals = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    let last = null;
    for (const event of log) {
        const sample = usageSampleOf(event);
        if (sample === undefined)
            continue;
        const buckets = {
            uncachedInputTokens: sample.usage.inputTokens,
            outputTokens: sample.usage.outputTokens,
            cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0,
        };
        const previous = last?.turn === sample.turn && last.step === sample.step
            ? last.buckets
            : undefined;
        totals.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0);
        totals.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0);
        totals.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0);
        totals.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0);
        last = { turn: sample.turn, step: sample.step, buckets };
    }
    return totals;
}
/** Fixture parallel of session-stats' whole-log counting and wall-time fold. */
function sessionStatsOf(log) {
    const value = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
    let lastTurn = null;
    let openStep = null;
    const pendingCalls = new Map();
    for (const event of log) {
        switch (event.type) {
            case 'step/start':
                openStep = { turn: event.data.turn, step: event.data.step, startTime: event.time, firstTokenTime: null };
                break;
            case 'assistant/chunk':
                if (openStep !== null && openStep.turn === event.data.turn && openStep.step === event.data.step
                    && openStep.firstTokenTime === null && (0, message_1.isTokenDelta)(event.data.chunk)) {
                    openStep.firstTokenTime = event.time;
                }
                break;
            case 'assistant/message': {
                if (openStep === null || openStep.turn !== event.data.turn || openStep.step !== event.data.step)
                    break;
                value.llmMs += Math.max(0, event.time - openStep.startTime);
                if (openStep.firstTokenTime !== null) {
                    value.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime);
                    value.ttftSteps += 1;
                    const outputTokens = event.data.usage?.outputTokens;
                    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
                        value.decodeMs += Math.max(0, event.time - openStep.firstTokenTime);
                        value.decodeTokens += outputTokens;
                    }
                }
                openStep = null;
                break;
            }
            case 'tool/call':
                pendingCalls.set(event.data.callId, event.time);
                break;
            case 'tool/result': {
                const callId = event.data.message.source.callId;
                const dispatched = pendingCalls.get(callId);
                if (dispatched === undefined)
                    break;
                pendingCalls.delete(callId);
                value.toolMs += Math.max(0, event.time - dispatched);
                break;
            }
            case 'step/end':
                if (event.data.turn !== lastTurn) {
                    value.turns += 1;
                    lastTurn = event.data.turn;
                }
                value.steps += 1;
                openStep = null;
                break;
            case 'turn/end':
                pendingCalls.clear();
                break;
            default:
                break;
        }
    }
    return value;
}
/** Fixed token-meter heuristic constants mirrored by this client-only fixture. */
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
/** Price fixture content with token-meter's fixed-density heuristic. */
function estimateFixtureContent(blocks) {
    const densityPrice = (value) => Math.ceil(value.length / CHARS_PER_TOKEN);
    return blocks.reduce((tokens, block) => {
        if ((0, runtime_types_1.isObjectRecord)(block)) {
            if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string')
                return tokens + densityPrice(block.text) + BLOCK_OVERHEAD;
            if (block.type === 'tool-call' && typeof block.name === 'string' && typeof block.arguments === 'string')
                return tokens + densityPrice(block.name) + densityPrice(block.arguments) + BLOCK_OVERHEAD;
            if (block.type === 'tool-result' && isUnknownArray(block.content))
                return tokens + estimateFixtureContent(block.content) + BLOCK_OVERHEAD;
        }
        return tokens + densityPrice(JSON.stringify(block) ?? '') + BLOCK_OVERHEAD;
    }, 0);
}
/** Fixture parallel of token-meter's heuristic context-composition projection. */
function contextBreakdownOf(log) {
    const headerEvent = log.findLast(event => event.type === 'request/header');
    const header = headerEvent === undefined
        ? undefined
        : headerEvent.data.header;
    let messageTokens = 0;
    for (const seq of (0, surface_1.foldSurface)(log).nodes) {
        const event = log[seq];
        if (event === undefined)
            continue;
        const message = (0, surface_1.deriveEventMessage)(event);
        if (message !== null)
            messageTokens += estimateFixtureContent(message.content) + ROLE_OVERHEAD;
    }
    return {
        systemTokens: header?.system === undefined
            ? 0
            : Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD,
        toolsTokens: header?.tools === undefined || header.tools.length === 0
            ? 0
            : Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD,
        messageTokens,
    };
}
/** Latest log-only route context, or undefined before any request ran. */
function lastRequestContext(log) {
    const event = log.findLast(item => item.type === 'request/context');
    return event?.type === 'request/context' ? event.data : undefined;
}
/**
 * Fixture parallel of token-meter's request-pressure projection: the last
 * provider-reported prompt size paired with the last recorded capacity. The
 * two need not come from one request — see the token-meter README. The host's
 * `projectedTokens` is deliberately absent: reproducing it would mean
 * reimplementing the estimator client-side, and every consumer falls back to
 * the bare sample, so a fixture-driven view simply lags a compaction the way
 * the projection did before that field existed.
 */
/** Production xharness-context-replay/v2 and composition replay, from durable events. */
function contextPressureOf(log) {
    const record = (value) => (0, runtime_types_1.isObjectRecord)(value) ? value : {};
    let value = {};
    let active;
    let waiting = false;
    let contextSeen = false;
    for (const event of log) {
        const data = record(event.data);
        const type = event.type;
        if (type === 'session/model-selected') {
            value = {};
            active = undefined;
            waiting = true;
            contextSeen = false;
        }
        if (type === 'step/start') {
            active = [data['turn'], data['step']];
            waiting = false;
            value = { contextWindow: value['contextWindow'], phase: 'preparing' };
        }
        if (type === 'request/header') {
            const options = record(record(data['header'])['options']);
            const budget = record(options['tokenBudget']);
            const estimate = record(budget['estimate']);
            waiting = false;
            value = {
                contextWindow: contextSeen ? value['contextWindow'] : budget['contextWindowTokens'] ?? budget['context_window_tokens'],
                projectedTokens: estimate['totalInputTokens'] ?? estimate['total_input_tokens'],
                projectedAccuracy: budget['accuracy'] ?? 'estimated',
                accuracy: budget['accuracy'] ?? 'estimated', phase: 'in_flight',
                measurement: options['measurement'] ?? { turn: active?.[0] ?? null, step: active?.[1] ?? null, source: 'legacy_request' },
                composition: options['contextComposition'],
            };
        }
        if (type === 'request/context') {
            contextSeen = true;
            value['contextWindow'] = data['contextWindow'] ?? data['context_window'];
        }
        const sample = usageSampleOf(event);
        if (!waiting && sample !== undefined && (active === undefined || (active[0] === sample.turn && active[1] === sample.step))) {
            const tokens = sample.usage.inputTokens + (sample.usage.cacheReadTokens ?? 0) + (sample.usage.cacheWriteTokens ?? 0);
            if (Number.isSafeInteger(tokens) && tokens >= 0)
                Object.assign(value, {
                    pressureTokens: tokens, pressureAccuracy: 'provider_reported', accuracy: 'provider_reported',
                    phase: value['phase'] === 'history_changed' ? 'history_changed' : 'measured',
                });
        }
        if (['user/message', 'tool/result', 'compaction/summary'].includes(type))
            value['phase'] = 'history_changed';
        if (type === 'turn/end' && value['pressureTokens'] === undefined)
            value['phase'] = 'unmeasured';
    }
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function projectionValuesOf(log) {
    const values = {};
    const titleEvent = log.findLast(item => item.type === 'session/title');
    if (titleEvent?.type === 'session/title') {
        values['title'] = titleEvent.data.title;
    }
    // Always present (tool-todo unit composed): null when no plan stands.
    values['todos'] = backscanTodos(log) ?? null;
    // Always present (permission service composed): the whole select.
    values['permissions'] = permissionSelectOf(log);
    // Always present (plan-mode unit composed): the {active, pending} view.
    values['plan'] = planViewOf(log);
    // Always present (GoalService unit composed): null before create / after clear.
    values['goal'] = backscanGoal(log);
    // Always present (token-meter composed): full-log provider billing.
    values['tokenUsage'] = tokenUsageOf(log);
    // Always present (token-meter composed): last request pressure and capacity.
    values['contextPressure'] = contextPressureOf(log);
    // Always present (token-meter composed): heuristic request composition.
    values['contextBreakdown'] = contextBreakdownOf(log);
    // Always present (session-stats unit composed): whole-log turn/step counts.
    values['sessionStats'] = sessionStatsOf(log);
    // Always present (attachment service composed): the deployment image
    // limits, constant per boot (mirrors the attachment-local defaults).
    // Deliberate host divergence: the real gateway never pushes an imageLimits
    // change frame (constant unit), but the fixture's uniform baseline replay
    // frames every key here, incidentally exercising higher-seq-wins.
    values['imageLimits'] = {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40000000,
        maxImageDimension: 2000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    };
    return values;
}
/** Host push-frame parallel: emit one session/projection frame per key the given event advanced. */
function projectionFramesOf(id, log, event) {
    const type = event.type;
    const frames = [];
    // One usage sample advances both token-meter units.
    if (usageSampleOf(event) !== undefined) {
        frames.push({ type: 'session/projection', sessionId: id, key: 'tokenUsage', value: tokenUsageOf(log), seq: event.seq }, { type: 'session/projection', sessionId: id, key: 'contextPressure', value: contextPressureOf(log), seq: event.seq });
    }
    if (type === 'request/context') {
        frames.push({
            type: 'session/projection',
            sessionId: id,
            key: 'contextPressure',
            value: contextPressureOf(log),
            seq: event.seq,
        });
    }
    if (type === 'request/header'
        || type === 'user/message'
        || type === 'assistant/message'
        || type === 'tool/result') {
        frames.push({
            type: 'session/projection',
            sessionId: id,
            key: 'contextBreakdown',
            value: contextBreakdownOf(log),
            seq: event.seq,
        });
    }
    // The stats fold's view advances on message assembly and tool settlement
    // (wall times) and on step close (counts).
    if (type === 'assistant/message' || type === 'tool/result' || type === 'step/end') {
        frames.push({
            type: 'session/projection',
            sessionId: id,
            key: 'sessionStats',
            value: sessionStatsOf(log),
            seq: event.seq,
        });
    }
    if (frames.length > 0)
        return frames;
    if (type === 'session/title') {
        const values = projectionValuesOf(log);
        /* v8 ignore next -- the advancing title event is in the log, so the key is present. */
        if (!Object.hasOwn(values, 'title'))
            return [];
        return [{ type: 'session/projection', sessionId: id, key: 'title', value: values['title'], seq: event.seq }];
    }
    // The goal domain's own durable change advances its projection.
    if (type === 'goal/change') {
        return [{ type: 'session/projection', sessionId: id, key: 'goal', value: backscanGoal(log), seq: event.seq }];
    }
    // Standing-plan fold: writes replace the list; turn/start clears it (null).
    if (type === 'todo/write' || type === 'turn/start') {
        return [{
                type: 'session/projection',
                sessionId: id,
                key: 'todos',
                value: backscanTodos(log) ?? null,
                seq: event.seq,
            }];
    }
    // Knob fold: any of the three whole-value knob events advances the select.
    if (type === 'permission/preset' || type === 'sandbox/mode' || type === 'approval/policy') {
        return [{
                type: 'session/projection',
                sessionId: id,
                key: 'permissions',
                value: permissionSelectOf(log),
                seq: event.seq,
            }];
    }
    // The plan unit advances on its two folded event kinds when the command
    // lifecycle contains the input that represents a plan selection.
    if (type === 'plan/mode' || (type === 'command/run'
        && event.type === 'command/run' && event.data.name === 'plan' && typeof event.data.args === 'string')) {
        return [{
                type: 'session/projection',
                sessionId: id,
                key: 'plan',
                value: planViewOf(log),
                seq: event.seq,
            }];
    }
    return [];
}
/**
 * Message-boundary paging (mirrors the host's paging contract): count
 * maxMessages messages
 *  backwards from end, cut at a turn/start boundary.
 Entries carry pagination-time views
 *  (the host analogue computes viewFor per entry at page time). */
function pageOf(log, beforeSeq, maxMessages) {
    const end = beforeSeq === undefined ? log.length : Math.max(0, Math.min(beforeSeq, log.length));
    let start = 0;
    let messages = 0;
    for (let i = end - 1; i >= 0; i--) {
        const event = log[i];
        /* v8 ignore next -- dense-array guard: log seqs are array indexes, i stays within [0, end). */
        if (event === undefined)
            break;
        if (event.type === 'user/message' || event.type === 'assistant/message')
            messages++;
        if (event.type === 'turn/start' && messages >= maxMessages) {
            start = i;
            break;
        }
    }
    const events = log.slice(start, end).map((event) => {
        const view = viewFor(event, log);
        return view === undefined ? { event } : { event, view };
    });
    return { events, hasMore: start > 0 };
}
/** Fixture mirror of host session-scoped attachment authorization. */
function logReferencesAttachment(log, attachmentId) {
    const visit = (value) => {
        if (Array.isArray(value))
            return value.some(visit);
        if (!(0, runtime_types_1.isObjectRecord)(value))
            return false;
        const record = value;
        if (record.attachmentId === attachmentId)
            return true;
        return Object.values(record).some(visit);
    };
    return log.some(event => visit(event.data));
}
/** Fixture mirror of first-party message extraction used by session-query. */
function searchBlockText(block) {
    switch (block.type) {
        case 'text':
            return [block.text];
        case 'reasoning':
            return [];
        case 'tool-call':
            return [block.name, block.arguments];
        case 'tool-result':
            return block.content.flatMap(searchBlockText);
        default:
            return [];
    }
}
/** One current-surface user/assistant document, if searchable. */
function searchEventText(event) {
    const content = event.type === 'user/message'
        ? event.data.content
        : event.type === 'assistant/message'
            ? event.data.message.content
            : undefined;
    if (content === undefined)
        return '';
    return content.flatMap(searchBlockText).map(part => part.trim()).filter(Boolean).join('\n');
}
/**
 * Browser-safe approximation of SQLite FTS5 unicode61 token boundaries.
 * Keeping phrase matching token-based prevents the development fixture from
 * promising arbitrary within-token substring behavior that production lacks.
 */
function searchTokenSpans(value) {
    const text = value.replace(/\s+/gu, ' ').trim();
    const characters = Array.from(text);
    const tokens = [];
    let start;
    let raw = '';
    const flush = (end) => {
        if (start !== undefined) {
            const folded = raw.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
            if (folded !== '')
                tokens.push({ value: folded, start, end });
        }
        start = undefined;
        raw = '';
    };
    for (let index = 0; index < characters.length; index++) {
        const character = characters[index];
        if (character === undefined)
            continue;
        const tokenBase = character.normalize('NFD').replace(/\p{M}+/gu, '');
        if (tokenBase === '') {
            if (start !== undefined)
                raw += character;
            continue;
        }
        if (/^[\p{L}\p{N}\p{Co}]+$/u.test(tokenBase)) {
            start ?? (start = index);
            raw += character;
        }
        else {
            flush(index);
        }
    }
    flush(characters.length);
    return { text, tokens };
}
/** Count exact contiguous token-phrase occurrences and retain the first display span. */
function phraseMatch(document, phrase) {
    if (phrase.length === 0 || phrase.length > document.length)
        return { count: 0, start: 0, end: 0 };
    let count = 0;
    let firstStart = 0;
    let firstEnd = 0;
    for (let start = 0; start <= document.length - phrase.length; start++) {
        if (!phrase.every((token, offset) => document[start + offset]?.value === token))
            continue;
        count++;
        if (count === 1) {
            firstStart = document[start]?.start ?? 0;
            firstEnd = document[start + phrase.length - 1]?.end ?? firstStart;
        }
    }
    return { count, start: firstStart, end: firstEnd };
}
/** Match-centered fixture excerpt, bounded by Unicode code points for the sidebar. */
function searchSnippet(value, matchStart, matchEnd) {
    const characters = Array.from(value);
    if (characters.length <= 120)
        return value;
    const boundedStart = Math.min(Math.max(0, matchStart), characters.length - 1);
    const boundedEnd = Math.min(characters.length, Math.max(boundedStart + 1, matchEnd));
    const center = Math.floor((boundedStart + boundedEnd) / 2);
    let start = Math.min(characters.length - 118, Math.max(0, center - Math.floor(118 / 2)));
    let end = start + 118;
    if (start === 0) {
        end = 119;
    }
    else if (end === characters.length) {
        start = characters.length - 119;
    }
    return `${start > 0 ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`;
}
/** Mirrors `packages/session-query/session-query-sqlite/src/index.ts`; update both together. */
function compareSearchCandidates(a, b) {
    if (a.matchCount !== b.matchCount)
        return b.matchCount - a.matchCount;
    if (a.documentLength !== b.documentLength)
        return a.documentLength - b.documentLength;
    if (a.time !== b.time)
        return b.time - a.time;
    if (a.sessionId !== b.sessionId)
        return a.sessionId < b.sessionId ? -1 : 1;
    return b.seq - a.seq;
}
/**
 * Current plan projection over the full log (host parallel: latest todo/write
 * with no later turn/start; a new turn retires the previous plan).
 */
function backscanTodos(log) {
    for (let i = log.length - 1; i >= 0; i--) {
        const event = log[i];
        if (event === undefined)
            continue;
        if (event.type === 'turn/start')
            return undefined;
        if (event.type === 'todo/write')
            return event.data.todos;
    }
    return undefined;
}
/**
 * Current goal projection over the full log (host parallel: the GoalService
 * unit's last-wins fold of goal/change whole values; clear returns null).
 */
function backscanGoal(log) {
    for (let i = log.length - 1; i >= 0; i--) {
        const event = log[i];
        if (event === undefined || event.type !== 'goal/change' || event.data === undefined)
            continue;
        const change = event.data;
        if (change.operation === 'clear')
            return null;
        return { goal: change.goal, roundsStarted: change.roundsStarted, createdAt: change.createdAt, updatedAt: change.updatedAt };
    }
    return null;
}
/** Inbox pump shared by both stream generators (FrameQueue pattern: ONE abort listener hung
 *  outside the loop — a per-iteration {once:true} listener never fires for non-final rounds and
 *  piles up for the stream's lifetime). breakNow force-ends the stream without the
 *  client's signal (timing hook: simulated connection loss). */
class FxInbox {
    constructor() {
        this.inbox = [];
        this.wake = null;
        this.broken = false;
    }
    push(envelope) {
        this.inbox.push(envelope);
        this.wake?.();
    }
    breakNow() {
        this.broken = true;
        this.wake?.();
    }
    /** Read through a method: breakNow()/abort flip state across yields, so narrowing from the loop condition must not stick. */
    isLive(signal) {
        return !signal.aborted && !this.broken;
    }
    async *drain(signal) {
        const onAbort = () => this.wake?.();
        signal.addEventListener('abort', onAbort);
        try {
            while (this.isLive(signal)) {
                while (this.inbox.length > 0) {
                    const next = this.inbox.shift();
                    if (next !== undefined)
                        yield next;
                }
                if (!this.isLive(signal))
                    break;
                await new Promise((resolve) => {
                    this.wake = resolve;
                });
                this.wake = null;
            }
        }
        finally {
            signal.removeEventListener('abort', onAbort);
        }
    }
}
/**
 * In-memory fake host: fx-alpha carries history and replay scripts; fx-beta is fx-alpha's child session (lineage indent material).
 * @param options - fixture branches for empty state and failure timing.
 * @returns an ApiProxy backed entirely by in-memory state — no host process, no network.
 */
function createFixtureApi(options = {}) {
    return createFixtureWorld(options).api;
}
/**
 * Build both fixture faces so a caller can drive the Remote endpoints and the
 * legacy API against one in-memory state graph.
 * @param options - fixture branches for empty state and failure timing.
 * @returns the legacy API face and the Remote RPC face.
 */
function createFixtureFaces(options = {}) {
    return createFixtureWorld(options);
}
/** Build the fixture's legacy API and Remote RPC faces over one state graph. */
function createFixtureWorld(options) {
    // The resident fixture sessions all carry history, so none of them is blank.
    const sessions = options.empty ? [] : [
        { sessionId: sid('fx-alpha'), updatedAt: Date.now(), running: true, blank: false, cwd: '/tmp/fixture' },
        { sessionId: sid('fx-beta'), updatedAt: Date.now() - 60000, running: false, blank: false, parentSessionId: sid('fx-alpha'), cwd: '/tmp/fixture' },
        { sessionId: sid('fx-gamma'), updatedAt: Date.now() - 120000, running: false, blank: false, cwd: '/tmp/fixture' },
    ];
    const logs = new Map([[sid('fx-alpha'), buildAlphaLog()]]);
    const modelSelections = new Map(sessions.map(session => [
        session.sessionId,
        { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    ]));
    const attachments = new Map([[
            String(FIXTURE_IMAGE_REF.attachmentId),
            { attachment: FIXTURE_IMAGE_REF, data: FIXTURE_IMAGE_DATA },
        ]]);
    /** Credential store double: set/unset flip the describe badge, values never read back. */
    const fixtureCredentials = new Map([
        // The assembled fixture represents an already-configured shipped
        // DeepSeek route so unrelated GUI journeys do not enter first-run setup.
        ['DEEPSEEK_API_KEY', true],
    ]);
    /**
     * Preset compositions the fixture serves. Held as state rather than
     * constants so the settings editor's save and delete are exercisable: the
     * roster a GUI journey sees after writing is the text it wrote.
     */
    const fixturePresets = new Map([
        ['standard', { trust: 'system', content: "- id: tool-bash\n  name: '@xharness/dsh-tool-bash'\n" }],
        ['minimal', { trust: 'system', content: "- id: tool-web-search\n  name: '@xharness/dsh-tool-web-search'\n" }],
        ['my-agent', { trust: 'user', content: "- id: tool-read\n  name: '@xharness/dsh-tool-read'\n" }],
    ]);
    let fixtureDefaultPreset = 'standard';
    const nextTurn = new Map([[sid('fx-alpha'), 75]]);
    let nextSession = 1;
    let nextRpc = 1;
    let attachedSessions = options.empty ? 0 : 1;
    // Workspace entities mirroring the host registry: the fixture sessions all
    // live under one workspace, whose account carries them in attach order.
    const wid = (raw) => sessions_schema_2.workspaceIdSchema.parse(raw);
    const fixtureEpoch = new Date(Date.now() - 300000).toISOString();
    const FIXTURE_HOME = '/home/fixture';
    const workspaces = options.empty ? [] : [{
            workspaceId: wid('fx-ws-fixture'),
            path: '/tmp/fixture',
            title: 'fixture',
            sessionIds: [sid('fx-alpha'), sid('fx-beta'), sid('fx-gamma')],
            createdAt: fixtureEpoch,
            updatedAt: fixtureEpoch,
        }, {
            workspaceId: wid('fx-ws-home'),
            path: `${FIXTURE_HOME}/Documents/project`,
            title: 'project',
            sessionIds: [],
            createdAt: fixtureEpoch,
            updatedAt: fixtureEpoch,
        }];
    let nextWorkspace = 1;
    // Registry-global archive set mirroring the host: archived sessions keep
    // their workspace accounting slot and only grouping surfaces hide them.
    const archivedSessionIds = [];
    // In-memory browse tree behind the fixture's `browse` picker capability —
    // deterministic content mirroring the design mock so assembled Web tests
    // and snapshots can walk it. Leaves are materialized lazily: a child listed
    // by its parent lists as empty until something is created inside it.
    const directoryTree = new Map([
        ['/', ['home']],
        ['/home', ['fixture']],
        [FIXTURE_HOME, ['Documents', 'Downloads', '.config']],
        [`${FIXTURE_HOME}/Documents`, [
                'project', 'deepseek-iOS', 'deepseek-android', 'deepseek-platform',
                'deepseek-web', 'deepseek-harness', 'deepseek-app', 'deepseek-landing-blog',
            ]],
    ]);
    const childrenOf = (path) => {
        const known = directoryTree.get(path);
        if (known !== undefined)
            return known;
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        const name = path.slice(path.lastIndexOf('/') + 1);
        return directoryTree.get(parent)?.includes(name) === true ? [] : undefined;
    };
    const crumbsOf = (path) => {
        const crumbs = [{ name: '/', path: '/', hidden: false }];
        let acc = '';
        for (const segment of path.split('/').filter(Boolean)) {
            acc += `/${segment}`;
            crumbs.push({ name: segment, path: acc, hidden: false });
        }
        return crumbs;
    };
    const mint = () => (0, api_1.RpcId)(`fx-rpc-${nextRpc++}`);
    /** Resident pending approval (stable rpcId: every mux open replays the same id while unanswered, matching host replay semantics). */
    const pendingApprovalRpcId = mint();
    const pendingApprovalId = (0, types_2.ApprovalRequestId)('fx-approval-1');
    /** Cleared once answered through respond; replay stops and approval/resolved is broadcast. */
    let approvalPending = true;
    const pendingQuestionRpcId = mint();
    let questionPending = true;
    const fixtureQuestions = [
        {
            id: 'harness-profile',
            header: '偏好',
            question: '你现在更想招哪类 Agent/Harness 候选人？',
            options: [
                { label: '工程落地型 (Recommended)', description: '更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。' },
                { label: '研究潜力型', description: '更看重 Agent 理解、训练评测思路和长期成长空间。' },
                { label: '均衡型', description: '同时要求工程能力和 Agent 认知，但可能筛选门槛更高。' },
            ],
        },
        {
            id: 'work-mode',
            header: '方式',
            question: '你希望候选人优先展示哪种工作方式？',
            options: [
                { label: '先做小型原型 (Recommended)', description: '用可运行结果尽快验证关键假设。' },
                { label: '先写完整设计', description: '先收敛边界、协议和风险，再开始实现。' },
            ],
        },
        {
            id: 'signals',
            header: '信号',
            question: '哪些面试信号最重要？',
            detail: '按当前招聘目标选择；跳过则视为不设偏好。',
            multiSelect: true,
            options: [
                { label: '系统设计' },
                { label: '代码质量' },
                { label: 'Agent 产品判断' },
            ],
        },
    ];
    const muxConns = new Set();
    const hostConns = new Set();
    const emitMux = (frame) => {
        for (const conn of muxConns)
            conn.push({ rpcId: mint(), payload: frame });
    };
    const emitHost = (frame) => {
        for (const conn of hostConns)
            conn.push({ rpcId: mint(), payload: frame });
    };
    /** OK response echoing the caller's rpcId (contract: responses always backfill, never mint). */
    function ok(request, value) {
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } });
    }
    function err(request, error) {
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: false, error } });
    }
    const summaryOf = (id) => sessions.find(s => s.sessionId === id);
    /** Shared session guard for sessionId-addressed catalog routes: the error
     *  response when the session is unknown, undefined when it exists. */
    const requireSession = (request) => {
        if (summaryOf(request.payload.sessionId) !== undefined)
            return undefined;
        return err(request, {
            code: 'session-not-found',
            message: `no session ${request.payload.sessionId}`,
            details: { sessionId: request.payload.sessionId },
        });
    };
    const setRunning = (id, running) => {
        const summary = summaryOf(id);
        if (summary === undefined || summary.running === running)
            return;
        summary.running = running;
        emitHost({ type: 'host/session-status', sessionId: id, running });
    };
    const logOf = (id) => {
        let log = logs.get(id);
        if (log === undefined) {
            log = [];
            logs.set(id, log);
        }
        return log;
    };
    const append = (id, e) => {
        const log = logOf(id);
        const event = { seq: log.length, time: Date.now(), ...e };
        log.push(event);
        // Emission-time view derivation (mirrors the host's live path).
        const view = viewFor(event, log);
        /* v8 ignore next 3 -- the view-present arm needs a live tool/call emission,
        but the fixture replay produces text-only turns; view vocabulary is
        exercised through the history samples (turns 60-62). */
        emitMux(view === undefined
            ? { type: 'session/event', sessionId: id, event }
            : { type: 'session/event', sessionId: id, event, view });
        // Host eager-drive parallel: a unit-advancing event pushes its finished value.
        for (const frame of projectionFramesOf(id, log, event))
            emitMux(frame);
    };
    /** Append one durable goal/change (host GoalService parallel). */
    const appendGoalChange = (id, change) => {
        const log = logOf(id);
        append(id, {
            type: 'goal/change',
            data: change,
        });
        const goal = backscanGoal(log);
        if (goal === null)
            throw new Error('goal mutation produced no goal');
        return goal;
    };
    const goalFailure = (message) => ({
        ok: false,
        error: { code: 'internal', message, details: {} },
    });
    const requireGoalSession = (id) => (summaryOf(id) === undefined
        ? { ok: false, error: { code: 'session-not-found', message: `no session ${id}`, details: { sessionId: id } } }
        : undefined);
    /** Canonical fixture implementation of the generated Commands Remote contract. */
    const commandRemotes = {
        list(id) {
            const missing = requireGoalSession(id);
            if (missing !== undefined)
                return missing;
            return {
                ok: true,
                value: [
                    { name: 'compact', description: 'fixture：压缩当前会话上下文' },
                    { name: 'echo', description: 'fixture：回显参数', input: { hint: 'text to echo' } },
                    { name: 'goal', description: 'set or view the goal for a long-running task', input: { hint: '<objective>', images: true } },
                    { name: 'permission', description: 'Switch the permission preset (sandbox mode + approval policy)', input: { hint: '<preset>' } },
                    { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]', images: true } },
                ],
            };
        },
        execute(id, line, images = []) {
            const missing = requireGoalSession(id);
            if (missing !== undefined)
                return missing;
            // Structured split mirroring the Host parser: name + verbatim rawInput
            // (separator whitespace included) — the run payload carries no line.
            const match = /^\/(\S+)((?:\s.*)?)$/.exec(line.trim());
            const name = match?.[1];
            const args = match?.[2] ?? '';
            // Mirror the Host image policy AFTER command resolution, matching the
            // executor's order (an unknown name answers undefined and logs no
            // lifecycle): the declaration rejection covers every known command
            // without `input.images`, and the two producer grammar rejections cover
            // the declaring commands' control-only lines. The fixture stores no
            // bytes, so an accepted batch is acknowledged and dropped.
            const known = ['permission', 'goal', 'compact', 'echo', 'plan'];
            if (images.length > 0 && name !== undefined && known.includes(name)) {
                const rejection = name !== 'goal' && name !== 'plan'
                    ? `/${name} does not accept image attachments`
                    : name === 'goal' && args.trim() === ''
                        ? 'Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.'
                        : name === 'plan' && args.trim() === 'off'
                            ? 'Image attachments cannot accompany /plan off.'
                            : undefined;
                if (rejection !== undefined) {
                    const commandId = (0, brand_4.CommandId)(`fx-cmd-${logOf(id).length}`);
                    append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } });
                    const result = { kind: 'error', text: rejection };
                    append(id, { type: 'command/done', data: { commandId, ...result } });
                    return { ok: true, value: { commandId, result } };
                }
            }
            if (name === 'permission') {
                const preset = args.trim();
                const commandId = (0, brand_4.CommandId)(`fx-cmd-${logOf(id).length}`);
                append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } });
                const spec = PERMISSION_PRESETS[preset];
                let result;
                if (preset === '') {
                    const current = permissionSelectOf(logOf(id)).currentValue;
                    result = { kind: 'success', text: `current preset ${current} (available: ${Object.keys(PERMISSION_PRESETS).join(', ')})` };
                }
                else if (spec === undefined) {
                    result = { kind: 'error', text: `unknown preset "${preset}" (available: ${Object.keys(PERMISSION_PRESETS).join(', ')})` };
                }
                else {
                    if (permissionSelectOf(logOf(id)).currentValue !== preset)
                        append(id, { type: 'permission/preset', data: { preset } });
                    append(id, { type: 'sandbox/mode', data: { mode: spec.sandbox } });
                    append(id, { type: 'approval/policy', data: { policy: spec.approval } });
                    result = { kind: 'success', text: `preset ${preset}` };
                }
                append(id, { type: 'command/done', data: { commandId, ...result } });
                return { ok: true, value: { commandId, result } };
            }
            if (name === 'goal') {
                const commandId = (0, brand_4.CommandId)(`fx-cmd-${logOf(id).length}`);
                append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } });
                const objective = args.trim();
                const current = backscanGoal(logOf(id));
                let text;
                if (objective === '') {
                    text = current === null ? 'No goal is set. Usage: /goal <objective>' : `Current goal: ${current.goal.objective}`;
                }
                else if (current !== null && current.goal.phase !== 'complete') {
                    text = `A goal already exists (${current.goal.objective}). Clear it first.`;
                }
                else {
                    const created = appendGoalChange(id, {
                        kind: 'goal/change', version: 1, operation: 'create',
                        goal: { id: `fx-goal-${logOf(id).length}`, revision: 1, objective, phase: 'active', maxGoalRounds: 256 },
                        roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(),
                    });
                    text = `Goal created: ${created.goal.objective}`;
                }
                const result = { kind: 'success', text };
                append(id, { type: 'command/done', data: { commandId, ...result } });
                return { ok: true, value: { commandId, result } };
            }
            const running = summaryOf(id)?.running === true;
            const outcomes = {
                compact: 'fixture：已压缩（假动作）',
                echo: args.trim(),
                plan: args.trim() === 'off'
                    ? (running ? 'Leaving plan mode (applies from the next step).' : 'Plan mode off.')
                    : (running
                        ? 'Entering plan mode (applies from the next step). Use /plan off to leave.'
                        : 'Plan mode on. Use /plan off to leave.'),
            };
            const text = name === undefined ? undefined : outcomes[name];
            if (name === undefined || text === undefined)
                return { ok: true, value: undefined };
            const commandId = (0, brand_4.CommandId)(`fx-cmd-${logOf(id).length}`);
            append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } });
            if (name === 'plan' && !running) {
                const plan = foldPlan(logOf(id));
                if (plan.wanted !== null && plan.wanted !== plan.active) {
                    append(id, { type: 'plan/mode', data: { active: plan.wanted } });
                }
            }
            const result = { kind: 'success', ...text === '' ? {} : { text } };
            append(id, { type: 'command/done', data: { commandId, ...result } });
            return { ok: true, value: { commandId, result } };
        },
    };
    const goalView = (projection) => ({
        ...projection.goal,
        roundsStarted: projection.roundsStarted,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        activation: projection.goal.phase === 'active' ? 'armed' : 'disarmed',
    });
    /** Canonical fixture implementation of the generated Goal Remote contract. */
    /** Canonical fixture implementation of the generated reference-discovery Remote contracts. */
    const referenceRemotes = {
        files(id, query) {
            const missing = requireGoalSession(id);
            if (missing !== undefined)
                return missing;
            const needle = query.toLocaleLowerCase();
            const items = [
                { path: 'notes', kind: 'directory' },
                { path: 'README.md', kind: 'file' },
                { path: 'notes/demo.txt', kind: 'file' },
            ].filter(item => item.path.toLocaleLowerCase().includes(needle));
            return { ok: true, value: items };
        },
        sessions(id, query) {
            const missing = requireGoalSession(id);
            if (missing !== undefined)
                return missing;
            const needle = query.toLocaleLowerCase();
            const value = sessions
                .filter(item => item.sessionId !== id)
                .filter(item => String(item.sessionId).toLocaleLowerCase().includes(needle)
                || item.cwd?.toLocaleLowerCase().includes(needle) === true)
                .map((item) => {
                const label = item.sessionId === sid('fx-beta') ? 'Fixture child session' : String(item.sessionId);
                const encoded = btoa(JSON.stringify(item.sessionId))
                    .replaceAll('+', '-')
                    .replaceAll('/', '_')
                    .replace(/=+$/u, '');
                return {
                    sessionId: item.sessionId,
                    label,
                    ...item.cwd === undefined ? {} : { cwd: item.cwd },
                    createdAt: item.updatedAt,
                    mention: `@[${label}](dsh-session:${encoded})`,
                };
            });
            return { ok: true, value };
        },
    };
    const goalRemotes = {
        create(id, request) {
            const missing = requireGoalSession(id);
            if (missing !== undefined)
                return missing;
            const current = backscanGoal(logOf(id));
            if (current !== null && current.goal.phase !== 'complete') {
                return goalFailure(`goal "${current.goal.id}" already exists`);
            }
            const now = Date.now();
            const projection = appendGoalChange(id, {
                kind: 'goal/change', version: 1, operation: 'create',
                goal: {
                    id: `fx-goal-${logOf(id).length}`,
                    revision: 1,
                    objective: request.objective,
                    phase: 'active',
                    maxGoalRounds: request.maxGoalRounds ?? 256,
                },
                roundsStarted: 0, createdAt: now, updatedAt: now,
            });
            return { ok: true, value: { ref: { id: projection.goal.id, revision: projection.goal.revision } } };
        },
        edit(id, ref, request) {
            return mutateGoal(id, ref, current => ({
                ...current.goal,
                revision: current.goal.revision + 1,
                ...request.objective === undefined ? {} : { objective: request.objective },
                ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
            }));
        },
        pause(id, ref) {
            return mutateGoal(id, ref, current => (current.goal.phase === 'active'
                ? { ...current.goal, revision: current.goal.revision + 1, phase: 'paused' }
                : undefined));
        },
        resume(id, ref) {
            return mutateGoal(id, ref, current => (current.goal.phase === 'paused' || current.goal.phase === 'blocked' || current.goal.phase === 'active'
                ? { ...current.goal, revision: current.goal.revision + 1, phase: 'active' }
                : undefined));
        },
        complete(id, ref) {
            return mutateGoal(id, ref, current => (current.goal.phase === 'complete'
                ? undefined
                : { ...current.goal, revision: current.goal.revision + 1, phase: 'complete' }));
        },
        clear(id, ref) {
            const resolved = resolveGoal(id, ref);
            if (!resolved.ok)
                return resolved;
            const current = resolved.value;
            const tombstone = { id: current.goal.id, revision: current.goal.revision + 1 };
            appendGoalChange(id, {
                kind: 'goal/change', version: 1, operation: 'clear', cleared: tombstone, clearedAt: Date.now(),
            });
            return { ok: true, value: tombstone };
        },
    };
    /** Resolve one current goal revision for a canonical Remote mutation. */
    function resolveGoal(id, ref) {
        const missing = requireGoalSession(id);
        if (missing !== undefined)
            return missing;
        const current = backscanGoal(logOf(id));
        if (current === null || current.goal.id !== ref.id || current.goal.revision !== ref.revision) {
            return goalFailure('stale or missing goal revision');
        }
        return { ok: true, value: current };
    }
    /** Shared CAS mutation path behind the canonical Remote verbs. */
    function mutateGoal(id, ref, next) {
        const resolved = resolveGoal(id, ref);
        if (!resolved.ok)
            return resolved;
        const current = resolved.value;
        const goal = next(current);
        if (goal === undefined) {
            return goalFailure(`invalid goal transition from "${current.goal.phase}"`);
        }
        const projection = appendGoalChange(id, {
            kind: 'goal/change', version: 1,
            operation: goal.phase === current.goal.phase ? 'edit' : goal.phase === 'paused' ? 'pause' : goal.phase === 'active' ? 'resume' : 'complete',
            goal, roundsStarted: current.roundsStarted, createdAt: current.createdAt, updatedAt: Date.now(),
        });
        return { ok: true, value: goalView(projection) };
    }
    const mapGoalResult = (result, map) => (result.ok ? { ok: true, value: map(result.value) } : result);
    const goalRefResult = (result) => (mapGoalResult(result, view => ({ ref: { id: goals_schema_2.goalRefSchema.shape.id.parse(view.id), revision: view.revision } })));
    const legacyGoalResponse = (request, result) => (Promise.resolve({ rpcId: request.rpcId, result }));
    /** At most one in-flight replay per session; cancel clears it. */
    const replays = new Map();
    /** history transit delay (timing hooks below); the page snapshot is taken at request time, like a real host. */
    let historyDelayMs = 0;
    /** One-shot history failure (timing hook: a pre-disconnect history request already doomed when reconnect lands). */
    let failNextHistory = false;
    /** Force-enders for currently open stream generators (timing hook: simulated connection loss). */
    const streamBreakers = new Set();
    /** Retry scenarios opened by timing hooks and completed in a later browser assertion phase. */
    const retryScenarios = new Map();
    /** The single opt-in browser stress producer; normal fixture journeys never start it. */
    let activeReasoningChunkStorm = null;
    // Timing-acceptance hooks (browser test backdoor): the in-memory fixture is
    // ideally timed. These let
    // browser acceptance runs create slow-history, lost-frame, and reconnect
    // windows a real host produces naturally.
    const timingHooks = {
        setHistoryDelay(ms) {
            historyDelayMs = ms;
        },
        /** Fail the NEXT history call (after its transit delay) with a transport-level throw. */
        failNextHistory() {
            failNextHistory = true;
        },
        /** Log append + mux emit (the normal live path). */
        appendUser(id, msg) {
            append(sid(id), { type: 'user/message', surfaceOp: 'append', data: userMessage(text(msg)) });
        },
        /** Append a later durable title revision through the normal raw-event + control-frame path. */
        appendTitle(id, title) {
            const log = logOf(sid(id));
            const messageSeqs = log.filter(event => event.type === 'user/message').map(event => event.seq);
            append(sid(id), { type: 'session/title', data: { title, messageSeqs, source: { kind: 'provider', provider: 'fixture' } } });
        },
        /** Start an externally paced reasoning stream for the opt-in browser stress lane. */
        startReasoningChunkStorm(id, chunkCount, chunksPerInterval, intervalMs) {
            if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) {
                throw new Error('fixture: reasoning chunk count must be a positive safe integer');
            }
            if (!Number.isSafeInteger(chunksPerInterval) || chunksPerInterval < 1) {
                throw new Error('fixture: reasoning chunks per interval must be a positive safe integer');
            }
            if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
                throw new Error('fixture: reasoning interval must be a positive safe integer');
            }
            if (activeReasoningChunkStorm?.emitting === true) {
                throw new Error('fixture: reasoning chunk storm already running');
            }
            const sessionId = sid(id);
            const log = logOf(sessionId);
            let turn = nextTurn.get(sessionId) ?? 0;
            for (const event of log) {
                const candidate = 'turn' in event.data ? event.data.turn : undefined;
                if (typeof candidate === 'number')
                    turn = Math.max(turn, candidate + 1);
            }
            nextTurn.set(sessionId, turn + 1);
            const marker = `REASONING_STRESS_COMPLETE:${String(turn)}:${String(chunkCount)}`;
            const state = {
                sessionId: id,
                chunkCount,
                chunksPerInterval,
                intervalMs,
                emitted: 0,
                marker,
                emitting: true,
            };
            activeReasoningChunkStorm = state;
            setRunning(sessionId, true);
            append(sessionId, { type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } });
            append(sessionId, {
                type: 'user/message', surfaceOp: 'append',
                data: userMessage(text(`Reasoning chunk stress: ${String(chunkCount)} chunks.`)),
            });
            append(sessionId, { type: 'step/start', data: { turn, step: 0 } });
            append(sessionId, {
                type: 'assistant/chunk',
                data: { turn, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
            });
            const startedAt = Date.now();
            const pump = () => {
                const elapsedIntervals = Math.floor((Date.now() - startedAt) / intervalMs) + 1;
                const due = Math.max(state.emitted + chunksPerInterval, elapsedIntervals * chunksPerInterval);
                const end = Math.min(due, chunkCount);
                for (let index = state.emitted; index < end; index++) {
                    const chunkText = index === chunkCount - 1
                        ? `\n${marker}`
                        : index % 64 === 63 ? '推理\n' : '推理';
                    append(sessionId, {
                        type: 'assistant/chunk',
                        data: { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: chunkText } },
                    });
                }
                state.emitted = end;
                if (end < chunkCount) {
                    setTimeout(pump, intervalMs);
                }
                else {
                    state.emitting = false;
                }
            };
            setTimeout(pump, 0);
            return marker;
        },
        /** Return a copy so browser probes cannot mutate the active producer. */
        reasoningChunkStormState() {
            return activeReasoningChunkStorm === null ? null : { ...activeReasoningChunkStorm };
        },
        /** Open one failed model step whose partial remains visible until llm/retry arrives. */
        beginModelRetry(id) {
            const sessionId = sid(id);
            const turn = nextTurn.get(sessionId) ?? 0;
            nextTurn.set(sessionId, turn + 1);
            retryScenarios.set(sessionId, { turn, stepStarted: true });
            setRunning(sessionId, true);
            append(sessionId, { type: 'turn/start', data: { turn } });
            append(sessionId, { type: 'user/message', surfaceOp: 'append', data: userMessage(text('请重试这个请求')) });
            append(sessionId, { type: 'step/start', data: { turn, step: 1 } });
            append(sessionId, { type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
            append(sessionId, { type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: '应撤回的半截回复' } } });
        },
        /** Record one retry decision; the next attempt remains in the same step. */
        scheduleModelRetry(id, retry = 1, delayMs = 450) {
            const sessionId = sid(id);
            const scenario = retryScenarios.get(sessionId);
            if (scenario === undefined)
                throw new Error(`fixture: no model retry scenario for ${id}`);
            if (!scenario.stepStarted) {
                append(sessionId, { type: 'assistant/chunk', data: { turn: scenario.turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
                append(sessionId, { type: 'assistant/chunk', data: { turn: scenario.turn, step: 1, chunk: { type: 'text-delta', index: 0, text: `第 ${String(retry)} 次应撤回的回复` } } });
                scenario.stepStarted = true;
            }
            const failure = { code: 'TRANSPORT', message: '连接被重置' };
            append(sessionId, {
                type: 'llm/retry',
                data: {
                    turn: scenario.turn, step: 1,
                    provider: 'fixture', mode: 'normal', policyKey: 'fixture-normal',
                    retry, maxRetries: 2, delayMs, failure,
                },
            });
            scenario.stepStarted = false;
        },
        /** Record one retry decision, then cancel its source turn before the retry starts. */
        cancelModelRetryDuringBackoff(id, delayMs = 450) {
            const sessionId = sid(id);
            const scenario = retryScenarios.get(sessionId);
            if (scenario === undefined)
                throw new Error(`fixture: no model retry scenario for ${id}`);
            const failure = { code: 'TRANSPORT', message: '连接被重置' };
            append(sessionId, {
                type: 'llm/retry',
                data: {
                    turn: scenario.turn, step: 1,
                    provider: 'fixture', mode: 'normal', policyKey: 'fixture-normal',
                    retry: 1, maxRetries: 2, delayMs, failure,
                },
            });
            append(sessionId, { type: 'step/end', data: { turn: scenario.turn, step: 1 } });
            append(sessionId, { type: 'turn/end', data: { turn: scenario.turn, reason: { kind: 'aborted', reason: { kind: 'user' } },
                } });
            retryScenarios.delete(sessionId);
            setRunning(sessionId, false);
        },
        /** Finish the timing-hook retry with a finalized response in the open step. */
        completeModelRetry(id) {
            const sessionId = sid(id);
            const scenario = retryScenarios.get(sessionId);
            if (scenario === undefined)
                throw new Error(`fixture: no model retry scenario for ${id}`);
            retryScenarios.delete(sessionId);
            append(sessionId, { type: 'assistant/chunk', data: {
                    turn: scenario.turn,
                    step: 1,
                    chunk: { type: 'block-start', index: 0, blockType: 'text' },
                } });
            append(sessionId, {
                type: 'assistant/message',
                surfaceOp: 'append',
                data: {
                    turn: scenario.turn,
                    step: 1,
                    message: assistantMessage(text('重试后的完整回复')),
                },
            });
            append(sessionId, { type: 'step/end', data: { turn: scenario.turn, step: 1 } });
            append(sessionId, { type: 'turn/end', data: { turn: scenario.turn, reason: { kind: 'completed' } } });
            setRunning(sessionId, false);
        },
        /** Log append WITHOUT the mux emit: a frame lost in transit — history still serves it, the client must repull. */
        appendSilent(id, msg) {
            const log = logOf(sid(id));
            log.push({ type: 'user/message', surfaceOp: 'append', seq: log.length, time: Date.now(), data: userMessage(text(msg)) });
        },
        /** End every open stream generator (client sees both streams close -> reconnect + resync path). */
        breakStreams() {
            for (const breakNow of [...streamBreakers])
                breakNow();
        },
    };
    Reflect.set(globalThis, '__fxTiming', timingHooks);
    /** Prompt replay: chunk typewriter (80ms/frame) -> assistant/message finalize -> turn/end + running flip. */
    const startReply = (id, turn, replyText) => {
        const step = 0;
        append(id, { type: 'step/start', data: { turn, step } });
        append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
        /* v8 ignore next -- the ?? arm needs a null match, but every fixture reply is non-empty. */
        const pieces = replyText.match(/[\s\S]{1,6}/gu) ?? [replyText];
        let i = 0;
        const finish = (aborted) => {
            replays.delete(id);
            const done = pieces.slice(0, i).join('');
            append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: done } } } });
            append(id, {
                type: 'assistant/message',
                surfaceOp: 'append',
                data: {
                    turn,
                    step,
                    message: assistantMessage(text(aborted ? `${done}（已中断）` : done)),
                    usage: fixtureUsage(turn, step),
                },
            });
            append(id, { type: 'step/end', data: { turn, step } });
            append(id, { type: 'turn/end', data: { turn, reason: { kind: aborted ? 'cancelled' : 'completed' } } });
            setRunning(id, false);
        };
        const tick = () => {
            const piece = pieces[i];
            if (piece === undefined) {
                finish(false);
                return;
            }
            i++;
            append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index: 0, text: piece } } });
            replays.set(id, { timer: setTimeout(tick, 80), finish });
        };
        replays.set(id, { timer: setTimeout(tick, 80), finish });
    };
    const api = {
        sessions: {
            // This preview fixture deliberately does not pretend to parse or import
            // external history. Real import acceptance uses the Rust Host.
            importHistory: request => err(request, { code: 'bad-request', message: 'External history import requires a real XHarness Host, not fixture mode', details: { issues: [] } }),
            delete: request => {
                const id = request.payload.sessionId, summary = summaryOf(id);
                if (!summary)
                    return err(request, { code: 'session-not-found', message: `no session ${id}`, details: { sessionId: id } });
                if (!archivedSessionIds.includes(id))
                    return err(request, { code: 'bad-request', message: 'archive the session before permanent deletion', details: { issues: [] } });
                if (summary.running || sessions.some(child => child.parentSessionId === id))
                    return err(request, { code: 'session-conflict', message: 'session still has running work or children', details: { sessionId: id, requestedCwd: summary.cwd ?? '' } });
                sessions.splice(sessions.indexOf(summary), 1);
                logs.delete(id);
                const archived = archivedSessionIds.indexOf(id);
                if (archived >= 0)
                    archivedSessionIds.splice(archived, 1);
                for (const workspace of workspaces)
                    workspace.sessionIds = workspace.sessionIds.filter(candidate => candidate !== id);
                emitHost({ type: 'host/session-removed', sessionId: id });
                emitHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...archivedSessionIds] });
                return ok(request, { deleted: true });
            },
            list: request => ok(request, { items: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) }),
            search: (request, signal) => {
                if (signal.aborted) {
                    return err(request, {
                        code: 'cancelled',
                        message: 'fixture session search was aborted',
                        details: {},
                    });
                }
                const query = searchTokenSpans(request.payload.query).tokens.map(token => token.value);
                const matches = sessions.flatMap((summary) => {
                    const log = logs.get(summary.sessionId) ?? [];
                    const current = new Set((0, surface_1.foldSurface)(log).nodes);
                    const best = log.flatMap((event) => {
                        if (!current.has(event.seq))
                            return [];
                        const eventText = searchEventText(event);
                        const document = searchTokenSpans(eventText);
                        const match = phraseMatch(document.tokens, query);
                        if (match.count === 0)
                            return [];
                        return [{
                                sessionId: summary.sessionId,
                                seq: event.seq,
                                time: event.time,
                                text: document.text,
                                matchCount: match.count,
                                matchStart: match.start,
                                matchEnd: match.end,
                                documentLength: Array.from(eventText).length,
                            }];
                    }).sort(compareSearchCandidates)[0];
                    return best === undefined ? [] : [best];
                }).sort(compareSearchCandidates);
                return ok(request, {
                    items: matches.slice(0, api_1.SESSION_SEARCH_RESULT_LIMIT).map(match => ({
                        sessionId: match.sessionId,
                        snippet: searchSnippet(match.text, match.matchStart, match.matchEnd),
                    })),
                    hasMore: matches.length > api_1.SESSION_SEARCH_RESULT_LIMIT,
                });
            },
            create: async (request) => {
                const workspace = request.payload.workspaceId === undefined
                    ? undefined
                    : workspaces.find(w => w.workspaceId === request.payload.workspaceId);
                if (request.payload.workspaceId !== undefined && workspace === undefined) {
                    return err(request, {
                        code: 'workspace-not-found',
                        message: `no workspace ${request.payload.workspaceId}`,
                        details: { workspaceId: request.payload.workspaceId },
                    });
                }
                const cwd = workspace?.path ?? request.payload.cwd ?? '/tmp/fixture';
                const requestedId = request.payload.sessionId;
                const attachWorkspace = (sessionId) => {
                    /* v8 ignore next -- callers enter only when a target Workspace exists. */
                    if (workspace === undefined || workspace.sessionIds.includes(sessionId))
                        return;
                    workspace.sessionIds = [sessionId, ...workspace.sessionIds];
                    workspace.updatedAt = new Date().toISOString();
                    emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } });
                };
                const attachFailure = (sessionId, workspaceId) => err(request, {
                    code: 'workspace-attach-failed',
                    message: `fixture rejected Workspace attachment for ${sessionId}`,
                    details: { sessionId, workspaceId },
                });
                if (requestedId !== undefined) {
                    const existing = summaryOf(requestedId);
                    if (existing !== undefined) {
                        if (existing.cwd !== cwd) {
                            return err(request, {
                                code: 'session-conflict',
                                message: `session ${requestedId} already uses ${existing.cwd ?? 'no cwd'}`,
                                details: { sessionId: requestedId, requestedCwd: cwd, ...existing.cwd === undefined ? {} : { existingCwd: existing.cwd } },
                            });
                        }
                        if (workspace !== undefined && !workspace.sessionIds.includes(requestedId)) {
                            if (options.failWorkspaceAttach)
                                return attachFailure(requestedId, workspace.workspaceId);
                            attachWorkspace(requestedId);
                        }
                        return ok(request, { sessionId: requestedId });
                    }
                }
                const created = {
                    sessionId: requestedId ?? sid(`fx-${nextSession++}`), updatedAt: Date.now(), running: false, blank: true, cwd,
                };
                sessions.push(created);
                modelSelections.set(created.sessionId, { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
                attachedSessions += 1;
                const emitSession = () => {
                    // Mirrors the host: the frame fires at creation, so blank is constantly true.
                    emitHost({ type: 'host/session-added', sessionId: created.sessionId, blank: true, cwd });
                };
                if (workspace !== undefined && options.failWorkspaceAttach) {
                    emitSession();
                    return attachFailure(created.sessionId, workspace.workspaceId);
                }
                if (workspace !== undefined && options.createFrameOrder === 'workspace-first') {
                    attachWorkspace(created.sessionId);
                    emitSession();
                }
                else {
                    emitSession();
                    if (workspace !== undefined)
                        attachWorkspace(created.sessionId);
                }
                if (options.dropSessionCreateResponse)
                    throw new Error('fixture: dropped session.create response after publication');
                return ok(request, { sessionId: created.sessionId });
            },
            rename: (request) => {
                const missing = requireSession(request);
                if (missing !== undefined)
                    return missing;
                const { sessionId, title } = request.payload;
                const normalized = title.trim().replace(/\s+/g, ' ');
                if (normalized.length === 0) {
                    return err(request, {
                        code: 'title-invalid',
                        message: 'session title must contain visible characters',
                        details: { sessionId },
                    });
                }
                // The append emits the session/event and its session/projection frame
                // (host parallel); the unary response settles the caller first.
                append(sessionId, {
                    type: 'session/title',
                    data: { title: normalized, messageSeqs: [], source: { kind: 'user' } },
                });
                const appended = logOf(sessionId).at(-1);
                if (appended === undefined)
                    throw new Error('title append produced no event');
                return ok(request, { title: normalized, seq: appended.seq });
            },
            fork: (request) => {
                const { sessionId, atSeq, beforeUserSeq } = request.payload;
                const source = summaryOf(sessionId);
                if (source === undefined) {
                    return err(request, {
                        code: 'session-not-found',
                        message: `no session ${sessionId}`,
                        details: { sessionId },
                    });
                }
                const log = logs.get(sessionId) ?? [];
                const lastSeq = log.at(-1)?.seq ?? -1;
                const targetIndex = beforeUserSeq === undefined ? -1 : log.findIndex(event => event.seq === beforeUserSeq && event.type === 'user/message' && event.data.source.kind === 'user');
                if (beforeUserSeq !== undefined && targetIndex < 0)
                    return err(request, {
                        code: 'fork-unavailable', message: 'user message not found', details: { sessionId },
                    });
                const anchoredBoundary = atSeq === undefined
                    ? undefined
                    : log.find(e => e.type === 'turn/end' && e.seq >= atSeq);
                const boundary = beforeUserSeq !== undefined
                    ? { seq: log.slice(0, targetIndex).findLast(event => event.type === 'turn/end')?.seq ?? -1 }
                    : anchoredBoundary
                        ?? (atSeq === undefined || atSeq > lastSeq
                            ? log.findLast(e => e.type === 'turn/end')
                            : undefined);
                if (boundary === undefined) {
                    return err(request, {
                        code: 'fork-unavailable',
                        message: atSeq !== undefined && atSeq <= lastSeq
                            ? `session ${sessionId} has not completed the turn containing event ${String(atSeq)}`
                            : `session ${sessionId} has no completed turn`,
                        details: { sessionId },
                    });
                }
                let cut = boundary.seq + 1;
                if (beforeUserSeq === undefined)
                    while (cut < log.length && log[cut]?.type !== 'turn/start')
                        cut++;
                const child = {
                    sessionId: sid(`fx-${nextSession++}`), updatedAt: Date.now(), running: false, blank: !log.slice(0, cut).some(event => event.type === 'user/message'),
                    parentSessionId: sessionId,
                    origin: 'fork',
                    ...source.cwd === undefined ? {} : { cwd: source.cwd },
                };
                logs.set(child.sessionId, log.slice(0, cut));
                sessions.push(child);
                emitHost({
                    type: 'host/session-added', sessionId: child.sessionId, blank: !log.slice(0, cut).some(event => event.type === 'user/message'),
                    parentSessionId: sessionId,
                    origin: 'fork',
                    ...source.cwd === undefined ? {} : { cwd: source.cwd },
                });
                const workspace = workspaces.find(w => w.sessionIds.includes(sessionId));
                if (workspace !== undefined) {
                    workspace.sessionIds = [child.sessionId, ...workspace.sessionIds];
                    workspace.updatedAt = new Date().toISOString();
                    emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } });
                }
                return ok(request, { sessionId: child.sessionId });
            },
            history: async (request) => {
                const log = logs.get(request.payload.sessionId) ?? [];
                // Snapshot at request time, deliver after the transit delay (mirrors a real host under latency).
                const page = pageOf(log, request.payload.beforeSeq, request.payload.maxMessages ?? 50);
                // Tail page carries the projections block (host parallel: one consistent
                // cut over the registered units; asOfSeq = window tail seq, -1 on an
                // empty log — the host's session.seq-1 convention).
                const projections = request.payload.beforeSeq === undefined
                    ? { asOfSeq: log.length - 1, values: projectionValuesOf(log) }
                    : undefined;
                const doomed = failNextHistory;
                failNextHistory = false;
                const delay = historyDelayMs;
                if (delay > 0)
                    await new Promise(resolve => setTimeout(resolve, delay));
                if (doomed)
                    throw new Error('fixture: simulated history transport failure');
                return ok(request, { ...page, ...projections === undefined ? {} : { projections } });
            },
            models: request => ok(request, {
                current: modelSelections.get(request.payload.sessionId)
                    ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
                // The fixture's routes all serve; a surface exercising the blocked
                // posture drives it through its own stub.
                routable: true,
                groups: fixtureModelGroups(),
                failures: [],
            }),
            selectModel: (request) => {
                const selected = {
                    provider: request.payload.provider,
                    model: request.payload.model,
                    ...request.payload.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: request.payload.reasoningEffort },
                };
                modelSelections.set(request.payload.sessionId, selected);
                return ok(request, { selected });
            },
            prompt: (request) => {
                const { sessionId: id, mode, content } = request.payload;
                const summary = summaryOf(id);
                if (summary === undefined) {
                    return err(request, { code: 'session-not-found', message: `no session ${id}`, details: { sessionId: id } });
                }
                if (options.rejectPrompt) {
                    if (content.some(block => block.type === 'image')) {
                        return err(request, {
                            code: 'attachment-error',
                            message: 'fixture: image side exceeds the deployment limit',
                            details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
                        });
                    }
                    return err(request, {
                        code: 'agent-busy',
                        message: 'fixture: prompt rejected before acceptance',
                        details: { reason: 'fixture-prompt-rejection' },
                    });
                }
                summary.updatedAt = Date.now();
                // First accepted prompt appends events: the summary stops being blank.
                summary.blank = false;
                const userText = content.map(b => (b.type === 'text' ? b.text : '')).join('');
                const durable = content.map((block) => {
                    if (block.type === 'text')
                        return block;
                    // The frozen development fixture fabricates inline raster payloads only.
                    // Keep its legacy behavior for the widened production wire variants
                    // at this fake-server fabrication boundary (refs have no inline data).
                    if (block.type === 'image_ref' || block.type === 'file_ref') {
                        const saved = attachments.get(block.attachmentId);
                        if (!saved)
                            throw new Error('fixture attachment reference is unavailable');
                        return { type: 'image', attachment: saved.attachment };
                    }
                    const encoded = block;
                    const attachment = {
                        attachmentId: (0, brand_1.AttachmentId)(`fixture:${(0, random_uuid_1.randomUuid)()}`),
                        mediaType: encoded.mediaType,
                        bytes: Math.max(1, Math.floor(encoded.data.length * 3 / 4)
                            - (encoded.data.endsWith('==') ? 2 : encoded.data.endsWith('=') ? 1 : 0)),
                        width: 160,
                        height: 90,
                        ...encoded.name === undefined ? {} : { name: encoded.name },
                    };
                    attachments.set(String(attachment.attachmentId), { attachment, data: encoded.data });
                    return { type: 'image', attachment };
                });
                if (mode === 'steer' && replays.has(id)) {
                    // Steering: the durable user/message lands inside the current turn; the replay continues.
                    append(id, { type: 'user/message', surfaceOp: 'append', data: userMessage(durable) });
                    return ok(request, { accepted: true });
                }
                const turn = nextTurn.get(id) ?? 0;
                nextTurn.set(id, turn + 1);
                setRunning(id, true);
                append(id, { type: 'turn/start', data: { turn } });
                // Boundary flush parallel (the host's step/start observer): an outstanding
                // /plan selection commits as plan/mode inside the opened turn.
                const plan = foldPlan(logOf(id));
                if (plan.wanted !== null && plan.wanted !== plan.active) {
                    append(id, { type: 'plan/mode', data: { active: plan.wanted } });
                }
                append(id, { type: 'user/message', surfaceOp: 'append', data: userMessage(durable) });
                // Capacity parallel of the host token-meter's request/context record:
                // log-only, appended inside the open turn, and deduplicated against the
                // route already recorded (the fixture never varies contextWindow).
                const selection = modelSelections.get(id) ?? { provider: 'deepseek', model: 'deepseek-v4-flash' };
                if (lastRequestContext(logOf(id))?.model !== selection.model) {
                    append(id, {
                        type: 'request/context',
                        data: { provider: selection.provider, model: selection.model, contextWindow: 128000 },
                    });
                }
                startReply(id, turn, userText === 'render markdown'
                    ? MARKDOWN_FIXTURE
                    : userText === 'report model'
                        ? (() => {
                            const selection = modelSelections.get(id);
                            return `当前模型：${selection?.provider ?? 'unknown'}/${selection?.model ?? 'unknown'}`
                                + (selection?.reasoningEffort === undefined ? '' : ` · 推理等级：${selection.reasoningEffort}`);
                        })()
                        : `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`);
                return ok(request, { accepted: true });
            },
            attachment: (request) => {
                const stored = attachments.get(String(request.payload.attachmentId));
                if (stored === undefined) {
                    return err(request, {
                        code: 'attachment-error',
                        message: 'fixture attachment missing',
                        details: { reason: 'ATTACHMENT_NOT_FOUND' },
                    });
                }
                if (!logReferencesAttachment(logs.get(request.payload.sessionId) ?? [], String(request.payload.attachmentId))) {
                    return err(request, {
                        code: 'attachment-error',
                        message: 'fixture attachment is not referenced by this session',
                        details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
                    });
                }
                return ok(request, stored);
            },
            updateQueue: request => err(request, {
                code: 'queue-item-not-found',
                message: 'fixture has no pending queue item',
                details: { itemId: request.payload.itemId },
            }),
            cancel: (request) => {
                const replay = replays.get(request.payload.sessionId);
                if (replay !== undefined) {
                    clearTimeout(replay.timer);
                    replay.finish(true);
                }
                else {
                    setRunning(request.payload.sessionId, false);
                }
                return ok(request, { accepted: true });
            },
        },
        subagents: {
            list: request => ok(request, { entries: [], parentAvailable: true }),
            history: (request) => {
                const log = logs.get(request.payload.childSessionId) ?? [];
                return Promise.resolve(ok(request, pageOf(log, request.payload.beforeSeq, request.payload.maxMessages ?? 50)));
            },
            prompt: request => Promise.resolve(ok(request, {
                messageId: (0, brand_2.MessageId)(`fixture-message-${request.payload.childSessionId}`),
            })),
            interrupt: request => Promise.resolve(ok(request, { accepted: true })),
        },
        host: {
            describe: request => ok(request, {
                version: '0.0.0-fixture', cwd: '/tmp/fixture', attachedSessions, home: FIXTURE_HOME, canOpenPath: true,
            }),
            // Deterministic native pick: the keyless lanes drive the full
            // pick-then-adopt path without an OS chooser (design-mock content,
            // same tree the browse primitives serve).
            pickDirectory: request => ok(request, { path: `${FIXTURE_HOME}/Documents/project` }),
            listDirectory: (request) => {
                const target = request.payload.path ?? FIXTURE_HOME;
                const children = childrenOf(target);
                if (children === undefined) {
                    return err(request, { code: 'directory-unreadable', message: `cannot list ${target}: not in the fixture tree`, details: { path: target } });
                }
                return ok(request, {
                    path: target,
                    home: FIXTURE_HOME,
                    crumbs: crumbsOf(target),
                    entries: [...children].sort((a, b) => a.localeCompare(b))
                        .map(name => ({ name, path: target === '/' ? `/${name}` : `${target}/${name}`, hidden: name.startsWith('.') })),
                    // The fixture tree is tiny; no level ever reaches a backend bound.
                    truncated: false,
                });
            },
            createDirectory: (request) => {
                const parent = request.payload.path;
                const children = childrenOf(parent);
                if (children === undefined) {
                    return err(request, { code: 'directory-create-failed', message: `missing parent ${parent}`, details: { path: parent } });
                }
                // Same root special case as listDirectory's entry paths: a plain join
                // under '/' would mint '//name' and fork the tree's identity.
                const target = parent === '/' ? `/${request.payload.name}` : `${parent}/${request.payload.name}`;
                if (children.includes(request.payload.name)) {
                    return err(request, { code: 'directory-exists', message: `${target} already exists`, details: { path: target } });
                }
                directoryTree.set(parent, [...children, request.payload.name]);
                directoryTree.set(target, []);
                return ok(request, { path: target });
            },
            openPath: request => ok(request, { opened: true }),
        },
        workspace: {
            list: request => ok(request, {
                items: workspaces.map(w => ({ ...w })),
                archivedSessionIds: [...archivedSessionIds],
            }),
            create: (request) => {
                const { path } = request.payload;
                const existing = workspaces.find(w => w.path === path);
                if (existing !== undefined)
                    return ok(request, { workspace: { ...existing }, created: false });
                const now = new Date().toISOString();
                const created = {
                    workspaceId: wid(`fx-ws-${nextWorkspace++}`),
                    path,
                    title: path.split('/').filter(Boolean).at(-1) ?? path,
                    sessionIds: [],
                    createdAt: now,
                    updatedAt: now,
                };
                workspaces.unshift(created);
                emitHost({ type: 'host/workspace-changed', workspace: { ...created } });
                return ok(request, { workspace: { ...created }, created: true });
            },
            rename: (request) => {
                const { workspaceId, title } = request.payload;
                const workspace = workspaces.find(w => w.workspaceId === workspaceId);
                if (workspace === undefined) {
                    return err(request, {
                        code: 'workspace-not-found',
                        message: `no workspace ${workspaceId}`,
                        details: { workspaceId },
                    });
                }
                const trimmed = title.trim();
                if (trimmed !== workspace.title) {
                    if (workspaces.some(w => w.workspaceId !== workspaceId && w.title === trimmed)) {
                        return err(request, {
                            code: 'workspace-name-conflict',
                            message: `workspace name '${trimmed}' is already in use`,
                            details: { name: trimmed },
                        });
                    }
                    workspace.title = trimmed;
                    workspace.updatedAt = new Date().toISOString();
                    emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } });
                }
                return ok(request, { workspace: { ...workspace } });
            },
            delete: (request) => {
                const { workspaceId } = request.payload;
                const index = workspaces.findIndex(workspace => workspace.workspaceId === workspaceId);
                if (index === -1) {
                    return err(request, {
                        code: 'workspace-not-found',
                        message: `no workspace ${workspaceId}`,
                        details: { workspaceId },
                    });
                }
                workspaces.splice(index, 1);
                emitHost({ type: 'host/workspace-removed', workspaceId });
                return ok(request, { deleted: true });
            },
            insertBefore: (request) => {
                const { workspaceId, beforeWorkspaceId } = request.payload;
                const source = workspaces.findIndex(workspace => workspace.workspaceId === workspaceId);
                const anchor = beforeWorkspaceId === undefined
                    ? workspaces.length
                    : workspaces.findIndex(workspace => workspace.workspaceId === beforeWorkspaceId);
                const missing = source === -1 ? workspaceId : anchor === -1 ? beforeWorkspaceId : undefined;
                if (missing !== undefined) {
                    return err(request, {
                        code: 'workspace-not-found',
                        message: `no workspace ${missing}`,
                        details: { workspaceId: missing },
                    });
                }
                if (beforeWorkspaceId !== workspaceId) {
                    const previousOrder = workspaces.map(candidate => candidate.workspaceId);
                    const [workspace] = workspaces.splice(source, 1);
                    /* v8 ignore next -- source was resolved from the same array immediately above. */
                    if (workspace === undefined)
                        throw new Error(`fixture lost workspace ${workspaceId}`);
                    const at = beforeWorkspaceId === undefined
                        ? workspaces.length
                        : workspaces.findIndex(candidate => candidate.workspaceId === beforeWorkspaceId);
                    workspaces.splice(at, 0, workspace);
                    if (workspaces.some((candidate, index) => candidate.workspaceId !== previousOrder[index])) {
                        emitHost({
                            type: 'host/workspace-order-changed',
                            workspaceIds: workspaces.map(candidate => candidate.workspaceId),
                        });
                    }
                }
                return ok(request, { workspaceIds: workspaces.map(candidate => candidate.workspaceId) });
            },
            insertSessionBefore: (request) => {
                const { workspaceId, sessionId, beforeSessionId } = request.payload;
                const workspace = workspaces.find(w => w.workspaceId === workspaceId);
                if (workspace === undefined) {
                    return err(request, {
                        code: 'workspace-not-found',
                        message: `no workspace ${workspaceId}`,
                        details: { workspaceId },
                    });
                }
                if (!workspace.sessionIds.includes(sessionId)
                    || (beforeSessionId !== undefined && !workspace.sessionIds.includes(beforeSessionId))) {
                    return err(request, {
                        code: 'workspace-move-invalid',
                        message: `session or anchor is not accounted by workspace ${workspaceId}`,
                        details: { workspaceId, sessionId, ...beforeSessionId === undefined ? {} : { beforeSessionId } },
                    });
                }
                const without = workspace.sessionIds.filter(id => id !== sessionId);
                const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId);
                const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)];
                if (!sessionIds.every((id, index) => id === workspace.sessionIds[index])) {
                    workspace.sessionIds = sessionIds;
                    workspace.updatedAt = new Date().toISOString();
                    emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } });
                }
                return ok(request, { workspace: { ...workspace } });
            },
            unarchiveSession: request => {
                const missing = requireSession(request);
                if (missing !== undefined)
                    return missing;
                const at = archivedSessionIds.indexOf(request.payload.sessionId);
                if (at >= 0) {
                    archivedSessionIds.splice(at, 1);
                    emitHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...archivedSessionIds] });
                }
                return ok(request, { archivedSessionIds: [...archivedSessionIds] });
            },
            archiveSession: (request) => {
                const missing = requireSession(request);
                if (missing !== undefined)
                    return missing;
                const { sessionId } = request.payload;
                if (!archivedSessionIds.includes(sessionId)) {
                    archivedSessionIds.push(sessionId);
                    emitHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...archivedSessionIds] });
                }
                return ok(request, { archivedSessionIds: [...archivedSessionIds] });
            },
        },
        agentPresets: {
            // Both trusts appear, because a surface must present a locally authored
            // preset differently from one the deployment vetted.
            list: request => ok(request, {
                presets: [...fixturePresets].map(([id, preset]) => ({
                    id,
                    trust: preset.trust,
                    isDefault: id === fixtureDefaultPreset,
                })),
                authorable: true,
                hasDocument: true,
            }),
            select: (request) => {
                fixtureDefaultPreset = request.payload.agentPreset;
                return ok(request, { agentPreset: request.payload.agentPreset });
            },
            read: (request) => {
                const { agentPreset } = request.payload;
                const preset = fixturePresets.get(agentPreset);
                if (preset === undefined) {
                    return err(request, {
                        code: 'agent-preset-not-found',
                        message: `unknown agent preset "${agentPreset}"`,
                        details: { agentPreset, available: [...fixturePresets.keys()] },
                    });
                }
                return ok(request, {
                    agentPreset,
                    trust: preset.trust,
                    content: preset.content,
                });
            },
            copy: (request) => {
                const { from, agentPreset } = request.payload;
                const source = fixturePresets.get(from);
                if (source === undefined) {
                    return err(request, {
                        code: 'agent-preset-not-found',
                        message: `unknown agent preset "${from}"`,
                        details: { agentPreset: from, available: [...fixturePresets.keys()] },
                    });
                }
                if (fixturePresets.has(agentPreset)) {
                    return err(request, {
                        code: 'agent-preset-invalid',
                        message: `agent preset "${agentPreset}" already exists`,
                        details: { agentPreset, reason: 'already exists' },
                    });
                }
                fixturePresets.set(agentPreset, { trust: 'user', content: source.content });
                return ok(request, { agentPreset });
            },
            // Native opens are deterministic no-op successes in this fixture, so the
            // open-directory affordance renders and the path-text fallback stays a
            // component-test concern.
            openDocument: (request) => {
                const { agentPreset } = request.payload;
                const existing = fixturePresets.get(agentPreset);
                if (existing === undefined || existing.trust === 'system') {
                    return err(request, {
                        code: 'agent-preset-read-only',
                        message: `agent preset "${agentPreset}" ships with the deployment`,
                        details: { agentPreset, reason: 'it ships with the deployment' },
                    });
                }
                return ok(request, { opened: true });
            },
            remove: (request) => {
                const { agentPreset } = request.payload;
                const existing = fixturePresets.get(agentPreset);
                if (existing?.trust === 'system') {
                    return err(request, {
                        code: 'agent-preset-read-only',
                        message: `agent preset "${agentPreset}" ships with the deployment`,
                        details: { agentPreset, reason: 'it ships with the deployment' },
                    });
                }
                fixturePresets.delete(agentPreset);
                return ok(request, {});
            },
        },
        skills: {
            list: (request) => {
                const missing = requireSession(request);
                if (missing !== undefined)
                    return missing;
                return ok(request, {
                    skills: [
                        { name: 'fixture-demo', description: 'fixture 技能样本', whenToUse: '仅供 UI 目录渲染验收', modelInvocable: true },
                        { name: 'fixture-user-only', description: 'fixture 仅用户技能样本', modelInvocable: false },
                    ],
                });
            },
        },
        goals: {
            // Compatibility face only: old API Proxy payloads and acknowledgements
            // adapt to the canonical fixture Remote implementation above.
            create: request => legacyGoalResponse(request, mapGoalResult(goalRemotes.create(request.payload.sessionId, {
                objective: request.payload.objective,
                ...request.payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.payload.maxGoalRounds },
            }), value => ({ ref: { id: goals_schema_2.goalRefSchema.shape.id.parse(value.ref.id), revision: value.ref.revision } }))),
            edit: request => legacyGoalResponse(request, goalRefResult(goalRemotes.edit(request.payload.sessionId, request.payload.ref, {
                ...request.payload.objective === undefined ? {} : { objective: request.payload.objective },
                ...request.payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.payload.maxGoalRounds },
            }))),
            pause: request => legacyGoalResponse(request, goalRefResult(goalRemotes.pause(request.payload.sessionId, request.payload.ref))),
            resume: request => legacyGoalResponse(request, goalRefResult(goalRemotes.resume(request.payload.sessionId, request.payload.ref))),
            complete: request => legacyGoalResponse(request, goalRefResult(goalRemotes.complete(request.payload.sessionId, request.payload.ref))),
            clear: request => legacyGoalResponse(request, mapGoalResult(goalRemotes.clear(request.payload.sessionId, request.payload.ref), () => ({ cleared: true }))),
        },
        events: {
            async *mux(_request, signal) {
                const conn = new FxInbox();
                muxConns.add(conn);
                const breakNow = () => { conn.breakNow(); };
                streamBreakers.add(breakNow);
                // Open baseline: subscribed sessions + pending interactions replayed with stable rpcIds.
                for (const s of sessions) {
                    if (!s.running)
                        continue;
                    const log = logs.get(s.sessionId) ?? [];
                    conn.push({ rpcId: mint(), payload: { type: 'session/subscribed', sessionId: s.sessionId, lastSeq: log.length - 1 } });
                    // Post-subscribe projection baseline (host parallel: recomputed unit values ride push frames).
                    const values = projectionValuesOf(log);
                    for (const key of Object.keys(values)) {
                        conn.push({ rpcId: mint(), payload: { type: 'session/projection', sessionId: s.sessionId, key, value: values[key], seq: log.length - 1 } });
                    }
                }
                if (approvalPending) {
                    conn.push({
                        rpcId: pendingApprovalRpcId,
                        payload: {
                            type: 'approval/requested', sessionId: sid('fx-alpha'),
                            approvalId: pendingApprovalId,
                            toolName: 'dangerous_tool', reason: 'fixture 常驻审批（可答：批准/拒绝后消失）',
                        },
                    });
                }
                if (questionPending) {
                    conn.push({
                        rpcId: pendingQuestionRpcId,
                        payload: {
                            type: 'question/requested', sessionId: sid('fx-alpha'), questions: fixtureQuestions,
                        },
                    });
                }
                try {
                    yield* conn.drain(signal);
                }
                finally {
                    streamBreakers.delete(breakNow);
                    muxConns.delete(conn);
                }
            },
            async *host(_request, signal) {
                const conn = new FxInbox();
                hostConns.add(conn);
                const breakNow = () => { conn.breakNow(); };
                streamBreakers.add(breakNow);
                // Periodic material (the RPC-panel acceptance's clear-then-new-frames step depends on it): flip fx-gamma every 5s.
                // fx-gamma only: never touch fx-alpha's running semantics (the conversation replay drives that).
                const timer = setInterval(() => {
                    const gamma = summaryOf(sid('fx-gamma'));
                    /* v8 ignore next -- the undefined arm needs fx-gamma deleted, but the fixture never removes sessions. */
                    if (gamma !== undefined)
                        setRunning(gamma.sessionId, !gamma.running);
                }, 5000);
                try {
                    yield* conn.drain(signal);
                }
                finally {
                    clearInterval(timer);
                    streamBreakers.delete(breakNow);
                    hostConns.delete(conn);
                }
            },
        },
        settings: {
            // Only the resolved DeepSeek address needed by first-run readiness is
            // represented here. Fixture-backed journeys do not open its Models
            // editor; real schema-driven forms ride the HTTP transport.
            describe: request => ok(request, {
                writable: true,
                hasDocument: true,
                namespaces: [{
                        ns: 'llm-deepseek',
                        schema: {},
                        value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
                        applies: 'live',
                        secrets: [{ path: ['apiKey'], set: false }],
                        revision: 0,
                    }],
            }),
            // Native opens are deterministic no-op successes in this fixture, as is host.openPath.
            openDocument: request => ok(request, { opened: true }),
            update: request => err(request, {
                code: 'settings-rejected',
                message: 'fixture: the minimal readiness settings descriptor is read-only',
                details: { ns: request.payload.ns },
            }),
            replace: request => err(request, {
                code: 'settings-rejected',
                message: 'fixture: the minimal readiness settings descriptor is read-only',
                details: { ns: request.payload.ns },
            }),
            mutate: request => err(request, {
                code: 'settings-rejected',
                message: 'fixture: no settings namespaces are registered',
                details: { ns: request.payload.ns },
            }),
        },
        credentials: {
            describe: request => ok(request, {
                credentials: Object.fromEntries(request.payload.refs.map(ref => [ref, {
                        configured: fixtureCredentials.has(ref),
                        ...fixtureCredentials.has(ref) ? { source: 'file' } : {},
                        writable: true,
                    }])),
            }),
            set: (request) => {
                fixtureCredentials.set(request.payload.ref, true);
                return ok(request, {});
            },
            unset: (request) => {
                fixtureCredentials.delete(request.payload.ref);
                return ok(request, {});
            },
        },
        llm: {
            providers: request => ok(request, {
                providers: [
                    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
                    { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true, declared: false },
                    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false, declared: false },
                    // One hand-declared route, so a surface reading this fixture meets
                    // the tagged shape rather than only the shipped one.
                    { provider: 'acme-gateway', displayName: 'Acme Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme-gateway'], active: true, declared: true },
                ],
            }),
            models: request => ok(request, { groups: fixtureModelGroups(), failures: [] }),
            // The fixture endpoint is imaginary, so the interrogation answers the
            // catalog it already serves — enough for a surface to exercise adopting
            // candidates without a reachable provider.
            discoverModels: request => ok(request, {
                models: fixtureModelGroups().flatMap(group => group.models.map(model => ({ id: model.id, name: model.name }))),
            }),
        },
        respond(message) {
            // Same routing discipline as the host: rpcId first, then the payload's
            // audit correlation; a settled or unknown id is not-pending.
            if (message.rpcId === pendingApprovalRpcId) {
                if (!approvalPending)
                    return Promise.resolve({ accepted: false, reason: 'not-pending' });
                if (!message.result.ok)
                    return Promise.resolve({ accepted: false, reason: 'bad-response' });
                const value = (0, runtime_types_1.objectValue)(message.result.value);
                if (value.approvalId !== pendingApprovalId || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) {
                    return Promise.resolve({ accepted: false, reason: 'bad-response' });
                }
                approvalPending = false;
                emitMux({ type: 'approval/resolved', sessionId: sid('fx-alpha'), approvalId: pendingApprovalId, outcome: value.outcome });
                return Promise.resolve({ accepted: true });
            }
            if (!questionPending || message.rpcId !== pendingQuestionRpcId) {
                return Promise.resolve({ accepted: false, reason: 'not-pending' });
            }
            questionPending = false;
            emitMux({
                type: 'question/resolved', sessionId: sid('fx-alpha'),
                questionRpcId: pendingQuestionRpcId,
                outcome: message.result.ok ? 'answered' : 'cancelled',
            });
            return Promise.resolve({ accepted: true });
        },
        // Satisfies the ApiProxy contract type only: the browser export button
        // hands GET /api/session.export to the native download manager, so this
        // stub is never reached through the fixture's dispatch.
        downloads: {
            sessionLog: () => Promise.resolve(new Response('fixture mode does not serve session export', { status: 404 })),
        },
    };
    const rpc = {
        call(channel, endpoint, payload) {
            if (channel !== '/api') {
                return Promise.reject(new Error(`fixture connection RPC channel ${JSON.stringify(channel)} is unavailable`));
            }
            // Generic Remote namespaces do not all carry an agentId: for example
            // syncInspectManifest is a root capability. Only a handler that owns an
            // endpoint may interpret its args. An unsupported endpoint must retain
            // the frozen fixture's explicit unavailable rejection, not be mistaken
            // for a malformed session request (or acknowledged as a fake success).
            switch (endpoint) {
                case 'commands/list': {
                    const args = zod_1.z.object({ args: zod_1.z.object({ agentId: sessions_schema_2.sessionIdSchema }) }).parse(payload).args;
                    return Promise.resolve(commandRemotes.list(args.agentId));
                }
                case 'commands/execute': {
                    const args = zod_1.z.object({ args: zod_1.z.object({
                            agentId: sessions_schema_2.sessionIdSchema, line: zod_1.z.string(), images: zod_1.z.array(zod_1.z.unknown()).nullish(),
                        }) }).parse(payload).args;
                    return Promise.resolve(commandRemotes.execute(args.agentId, args.line, args.images ?? []));
                }
                case 'fileReferences/list':
                case 'sessionReferenceResolver/candidates': {
                    const args = zod_1.z.object({ args: zod_1.z.object({ agentId: sessions_schema_2.sessionIdSchema, query: zod_1.z.string().nullish() }) }).parse(payload).args;
                    return Promise.resolve(endpoint === 'fileReferences/list'
                        ? referenceRemotes.files(args.agentId, args.query ?? '')
                        : referenceRemotes.sessions(args.agentId, args.query ?? ''));
                }
                case 'goals/create': {
                    const args = zod_1.z.object({ args: zod_1.z.object({
                            agentId: sessions_schema_2.sessionIdSchema,
                            request: zod_1.z.object({ objective: zod_1.z.string(), maxGoalRounds: zod_1.z.number().optional() }),
                        }) }).parse(payload).args;
                    return Promise.resolve(goalRemotes.create(args.agentId, {
                        objective: args.request.objective,
                        ...args.request.maxGoalRounds === undefined ? {} : { maxGoalRounds: args.request.maxGoalRounds },
                    }));
                }
                case 'goals/edit': {
                    const args = zod_1.z.object({ args: zod_1.z.object({
                            agentId: sessions_schema_2.sessionIdSchema, ref: goals_schema_2.goalRefSchema,
                            request: zod_1.z.object({ objective: zod_1.z.string().optional(), maxGoalRounds: zod_1.z.number().optional() }).nullish(),
                        }) }).parse(payload).args;
                    return Promise.resolve(goalRemotes.edit(args.agentId, args.ref, args.request ?? {}));
                }
                case 'goals/pause':
                case 'goals/resume':
                case 'goals/complete':
                case 'goals/clear': {
                    const args = zod_1.z.object({ args: zod_1.z.object({ agentId: sessions_schema_2.sessionIdSchema, ref: goals_schema_2.goalRefSchema }) }).parse(payload).args;
                    switch (endpoint) {
                        case 'goals/pause': return Promise.resolve(goalRemotes.pause(args.agentId, args.ref));
                        case 'goals/resume': return Promise.resolve(goalRemotes.resume(args.agentId, args.ref));
                        case 'goals/complete': return Promise.resolve(goalRemotes.complete(args.agentId, args.ref));
                        case 'goals/clear': return Promise.resolve(goalRemotes.clear(args.agentId, args.ref));
                    }
                }
                default:
                    return Promise.reject(new Error(`fixture connection RPC endpoint ${JSON.stringify(endpoint)} is unavailable`));
            }
        },
    };
    return { api, rpc };
}
/**
 * Fixture platform subclass: there is no HTTP at all, so instead of a doFetch transport it
 * overrides the protocol-level virtuals (callUnary/openMux/openHost/respond) to dispatch
 * straight into the in-memory ApiProxy — while still minting rpcIds, fabricating the four
 * named full forms, and feeding the same tap as a real carrier. TODO: delete when the fixture
 * moves to the isomorphic pipeline (InProcessApiClient over toFetchHandler(fixtureImpl)).
 */
class FixtureApiClient extends api_1.AbstractApiClient {
    constructor() {
        super();
        const world = createFixtureWorld(fixtureOptionsFromLocation());
        this.api = world.api;
        this.rpc = world.rpc;
    }
    doFetch() {
        throw new Error('FixtureApiClient overrides all protocol paths; doFetch must be unreachable');
    }
    async callUnary(method, payload, signal) {
        const request = rpcRequest(payload);
        const full = { type: 'client-request', rpcId: request.rpcId, method, payload };
        this.onEnvelope(full);
        const response = await this.dispatch(method, request, signal ?? new AbortController().signal);
        const fullResponse = { type: 'server-response', rpcId: response.rpcId, result: response.result };
        this.onEnvelope(fullResponse);
        if (!response.result.ok)
            return { rpcId: response.rpcId, result: response.result };
        const schema = FIXTURE_UNARY_VALUE_SCHEMAS[method];
        return { rpcId: response.rpcId, result: { ok: true, value: schema.parse(response.result.value) } };
    }
    /** Method-key dispatch into the in-memory contract impl (a real carrier routes by URL path instead). */
    dispatch(method, request, signal) {
        switch (method) {
            case 'session.delete': return this.api.sessions.delete({ rpcId: request.rpcId, payload: sessions_schema_1.sessionDeleteRequestSchema.parse(request.payload) });
            case 'workspace.unarchiveSession': return this.api.workspace.unarchiveSession({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceUnarchiveSessionRequestSchema.parse(request.payload) });
            case 'session.list': return this.api.sessions.list({ rpcId: request.rpcId, payload: sessions_schema_1.sessionListRequestSchema.parse(request.payload) });
            case 'session.search': return this.api.sessions.search({ rpcId: request.rpcId, payload: sessions_schema_1.sessionSearchRequestSchema.parse(request.payload) }, signal);
            case 'session.import': return this.api.sessions.importHistory({ rpcId: request.rpcId, payload: sessions_schema_1.sessionImportRequestSchema.parse(request.payload) });
            case 'session.create': return this.api.sessions.create({ rpcId: request.rpcId, payload: sessions_schema_1.sessionCreateRequestSchema.parse(request.payload) });
            case 'session.history': return this.api.sessions.history({ rpcId: request.rpcId, payload: sessions_schema_1.sessionHistoryRequestSchema.parse(request.payload) });
            case 'session.models': return this.api.sessions.models({ rpcId: request.rpcId, payload: sessions_schema_1.sessionModelsRequestSchema.parse(request.payload) });
            case 'session.selectModel': return this.api.sessions.selectModel({ rpcId: request.rpcId, payload: sessions_schema_1.sessionSelectModelRequestSchema.parse(request.payload) });
            case 'session.rename': return this.api.sessions.rename({ rpcId: request.rpcId, payload: sessions_schema_1.sessionRenameRequestSchema.parse(request.payload) });
            case 'session.fork': return this.api.sessions.fork({ rpcId: request.rpcId, payload: sessions_schema_1.sessionForkRequestSchema.parse(request.payload) });
            case 'session.prompt': return this.api.sessions.prompt({ rpcId: request.rpcId, payload: sessions_schema_1.sessionPromptRequestSchema.parse(request.payload) });
            case 'session.attachment': return this.api.sessions.attachment({ rpcId: request.rpcId, payload: sessions_schema_1.sessionAttachmentRequestSchema.parse(request.payload) });
            case 'session.updateQueue': return this.api.sessions.updateQueue({ rpcId: request.rpcId, payload: sessions_schema_1.sessionUpdateQueueRequestSchema.parse(request.payload) });
            case 'session.cancel': return this.api.sessions.cancel({ rpcId: request.rpcId, payload: sessions_schema_1.sessionCancelRequestSchema.parse(request.payload) });
            case 'subagent.list': return this.api.subagents.list({ rpcId: request.rpcId, payload: subagents_schema_1.subagentListRequestSchema.parse(request.payload) });
            case 'subagent.history': return this.api.subagents.history({ rpcId: request.rpcId, payload: subagents_schema_1.subagentHistoryRequestSchema.parse(request.payload) });
            case 'subagent.prompt': return this.api.subagents.prompt({ rpcId: request.rpcId, payload: subagents_schema_1.subagentPromptRequestSchema.parse(request.payload) }, signal);
            case 'subagent.interrupt': return this.api.subagents.interrupt({ rpcId: request.rpcId, payload: subagents_schema_1.subagentInterruptRequestSchema.parse(request.payload) });
            case 'host.describe': return this.api.host.describe({ rpcId: request.rpcId, payload: host_schema_1.hostDescribeRequestSchema.parse(request.payload) });
            case 'host.pickDirectory': return this.api.host.pickDirectory({ rpcId: request.rpcId, payload: host_schema_1.hostPickDirectoryRequestSchema.parse(request.payload) }, new AbortController().signal);
            case 'host.listDirectory': return this.api.host.listDirectory({ rpcId: request.rpcId, payload: host_schema_1.hostListDirectoryRequestSchema.parse(request.payload) }, new AbortController().signal);
            case 'host.createDirectory': return this.api.host.createDirectory({ rpcId: request.rpcId, payload: host_schema_1.hostCreateDirectoryRequestSchema.parse(request.payload) });
            case 'host.openPath': return this.api.host.openPath({ rpcId: request.rpcId, payload: host_schema_1.hostOpenPathRequestSchema.parse(request.payload) }, new AbortController().signal);
            case 'workspace.list': return this.api.workspace.list({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceListRequestSchema.parse(request.payload) });
            case 'workspace.create': return this.api.workspace.create({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceCreateRequestSchema.parse(request.payload) });
            case 'workspace.rename': return this.api.workspace.rename({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceRenameRequestSchema.parse(request.payload) });
            case 'workspace.delete': return this.api.workspace.delete({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceDeleteRequestSchema.parse(request.payload) });
            case 'workspace.insertBefore': return this.api.workspace.insertBefore({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceInsertBeforeRequestSchema.parse(request.payload) });
            case 'workspace.insertSessionBefore': return this.api.workspace.insertSessionBefore({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceInsertSessionBeforeRequestSchema.parse(request.payload) });
            case 'workspace.archiveSession': return this.api.workspace.archiveSession({ rpcId: request.rpcId, payload: workspace_schema_1.workspaceArchiveSessionRequestSchema.parse(request.payload) });
            case 'skill.list': return this.api.skills.list({ rpcId: request.rpcId, payload: skills_schema_1.skillListRequestSchema.parse(request.payload) });
            case 'agentPreset.list': return this.api.agentPresets.list({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetListRequestSchema.parse(request.payload) });
            case 'agentPreset.select': return this.api.agentPresets.select({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetSelectRequestSchema.parse(request.payload) });
            case 'agentPreset.read': return this.api.agentPresets.read({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetReadRequestSchema.parse(request.payload) });
            case 'agentPreset.copy': return this.api.agentPresets.copy({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetCopyRequestSchema.parse(request.payload) });
            case 'agentPreset.openDocument': return this.api.agentPresets.openDocument({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetOpenDocumentRequestSchema.parse(request.payload) }, new AbortController().signal);
            case 'agentPreset.remove': return this.api.agentPresets.remove({ rpcId: request.rpcId, payload: agent_presets_schema_1.agentPresetRemoveRequestSchema.parse(request.payload) });
            case 'goal.create': return this.api.goals.create({ rpcId: request.rpcId, payload: goals_schema_1.goalCreateRequestSchema.parse(request.payload) });
            case 'goal.edit': return this.api.goals.edit({ rpcId: request.rpcId, payload: goals_schema_1.goalEditRequestSchema.parse(request.payload) });
            case 'goal.pause': return this.api.goals.pause({ rpcId: request.rpcId, payload: goals_schema_1.goalPauseRequestSchema.parse(request.payload) });
            case 'goal.resume': return this.api.goals.resume({ rpcId: request.rpcId, payload: goals_schema_1.goalResumeRequestSchema.parse(request.payload) });
            case 'goal.complete': return this.api.goals.complete({ rpcId: request.rpcId, payload: goals_schema_1.goalCompleteRequestSchema.parse(request.payload) });
            case 'goal.clear': return this.api.goals.clear({ rpcId: request.rpcId, payload: goals_schema_1.goalClearRequestSchema.parse(request.payload) });
            case 'settings.describe': return this.api.settings.describe({ rpcId: request.rpcId, payload: settings_schema_1.settingsDescribeRequestSchema.parse(request.payload) });
            case 'settings.openDocument': return this.api.settings.openDocument({ rpcId: request.rpcId, payload: settings_schema_1.settingsOpenDocumentRequestSchema.parse(request.payload) }, signal);
            case 'settings.update': return this.api.settings.update({ rpcId: request.rpcId, payload: settings_schema_1.settingsUpdateRequestSchema.parse(request.payload) });
            case 'settings.replace': return this.api.settings.replace({ rpcId: request.rpcId, payload: settings_schema_1.settingsReplaceRequestSchema.parse(request.payload) });
            case 'settings.mutate': return this.api.settings.mutate({ rpcId: request.rpcId, payload: settings_schema_1.settingsMutateRequestSchema.parse(request.payload) });
            case 'credentials.describe': return this.api.credentials.describe({ rpcId: request.rpcId, payload: credentials_schema_1.credentialsDescribeRequestSchema.parse(request.payload) });
            case 'credentials.set': return this.api.credentials.set({ rpcId: request.rpcId, payload: credentials_schema_1.credentialsSetRequestSchema.parse(request.payload) });
            case 'credentials.unset': return this.api.credentials.unset({ rpcId: request.rpcId, payload: credentials_schema_1.credentialsUnsetRequestSchema.parse(request.payload) });
            case 'llm.providers': return this.api.llm.providers({ rpcId: request.rpcId, payload: llm_schema_1.llmProvidersRequestSchema.parse(request.payload) });
            case 'llm.models': return this.api.llm.models({ rpcId: request.rpcId, payload: llm_schema_1.llmModelsRequestSchema.parse(request.payload) });
            case 'llm.discoverModels': return this.api.llm.discoverModels({ rpcId: request.rpcId, payload: llm_schema_1.llmDiscoverModelsRequestSchema.parse(request.payload) }, signal);
        }
    }
    openMux(payload, signal, onOpen) {
        return this.tapStream(this.api.events.mux(rpcRequest(payload), signal), onOpen);
    }
    openHost(payload, signal, onOpen) {
        return this.tapStream(this.api.events.host(rpcRequest(payload), signal), onOpen);
    }
    async *tapStream(stream, onOpen) {
        // No HTTP here: the in-memory stream is established the moment iteration starts (mirrors
        // readSse firing onOpen after response headers, before any frame).
        onOpen?.();
        for await (const envelope of stream) {
            const full = { type: 'server-request', rpcId: envelope.rpcId, method: envelope.payload.type, payload: envelope.payload };
            this.onEnvelope(full);
            yield envelope;
        }
    }
    /**
     * Deliver a client response to the in-memory contract impl (no HTTP POST),
     * echoing the envelope to the observation tap like every other path.
     * @param message - the client-response envelope answering a server request.
     * @returns the carrier receipt from the fixture impl.
     */
    async respond(message) {
        this.onEnvelope(message);
        return this.api.respond(message);
    }
}
exports.FixtureApiClient = FixtureApiClient;
/** Browser query mapping; direct unit callers pass FixtureOptions explicitly. */
function fixtureOptionsFromLocation() {
    if (typeof location === 'undefined')
        return {};
    const query = new URLSearchParams(location.search);
    return {
        empty: query.get('fixture') === 'empty',
        rejectPrompt: query.get('fixturePrompt') === 'reject',
        failWorkspaceAttach: query.get('fixtureAttach') === 'fail',
        dropSessionCreateResponse: query.get('fixtureSessionCreate') === 'drop-response',
        createFrameOrder: query.get('fixtureFrames') === 'workspace-first' ? 'workspace-first' : 'session-first',
    };
}
function isUnknownArray(value) { return Array.isArray(value); }

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

},
"src/modules/client-connection/contracts/core/session/types.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/core/session/types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_FORMAT_VERSION = void 0;
exports.SessionId = SessionId;
const zod_1 = require("zod");
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a nominal string schema).
 */
function SessionId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * The on-disk session format version, stamped into every newly-written {@link SessionHeader}
 * and enforced by every persistence backend on load. The single source of truth for the
 * version — write sites and the load-time check all read it.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided.
 *
 * The version is a single monotonic integer with no major/minor split. Whether
 * a bump is needed is decided by what the WRITER emits, never by what a newer
 * reader can accept: bump exactly when an older runtime could no longer handle
 * a new log with full semantic correctness ("parses without error" is not
 * correctness — silently skipping content that shapes reconstruction is a
 * wrong read). Only structural changes reach that bar: the header shape, the
 * {@link SessionEvent} envelope, core event semantics, or the surface
 * mechanism (the {@link SurfaceEventType} set and {@link SurfaceOp} variants).
 * Adding an ordinary event type does not bump — the per-event
 * {@link SessionEvent.ignorable} guard covers vocabulary growth instead. When
 * in doubt, bump: a near-identity upgrade step is almost free, a missed bump
 * makes older runtimes read new logs wrong silently. The full mechanism
 * (upgrade-step chain, in-memory view conversion, migrate-on-continue) is
 * recorded in the session-log-version-mechanism Agent Note
 * (`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`).
 */
exports.SESSION_FORMAT_VERSION = 0;

},
"src/modules/client-connection/contracts/attachment/attachment/brand.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/attachment/attachment/brand.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentId = AttachmentId;
const zod_1 = require("zod");
/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
function AttachmentId(value) {
    return zod_1.z.string().brand().parse(value);
}

},
"src/modules/client-connection/contracts/interaction/user-approval/types.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/interaction/user-approval/types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalRequestId = ApprovalRequestId;
const zod_1 = require("zod");
/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
function ApprovalRequestId(id) {
    return zod_1.z.string().brand().parse(id);
}

},
"src/modules/client-connection/contracts/llm/llm/brand.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/llm/llm/brand.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageId = MessageId;
exports.CallId = CallId;
exports.ProviderRequestId = ProviderRequestId;
exports.ReasoningEffortId = ReasoningEffortId;
const zod_1 = require("zod");
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function MessageId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function CallId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function ProviderRequestId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function ReasoningEffortId(id) {
    return zod_1.z.string().brand().parse(id);
}

},
"src/modules/client-connection/contracts/llm/llm/message.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/llm/llm/message.ts

"use strict";
/** Message value types, identity, and immutable construction helpers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTEXT_SUMMARY_MAX_CHARS = void 0;
exports.boundContextSummary = boundContextSummary;
exports.freezeMessage = freezeMessage;
exports.createMessage = createMessage;
exports.createUserMessage = createUserMessage;
exports.createAssistantMessage = createAssistantMessage;
exports.createToolResultMessage = createToolResultMessage;
exports.isTokenDelta = isTokenDelta;
const brand_1 = require("./brand");
const call_config_1 = require("./call-config");
/**
 * Bound for a `notice` summary. The account rides a collapsed transcript row
 * and is committed to the durable log, while its inputs — task labels, goal
 * objectives, tool arguments — are caller text with no length of their own.
 */
exports.CONTEXT_SUMMARY_MAX_CHARS = 120;
/**
 * Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
function boundContextSummary(summary) {
    return summary.length <= exports.CONTEXT_SUMMARY_MAX_CHARS
        ? summary
        : `${summary.slice(0, exports.CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}
/**
 * Detach and deep-freeze a message whose identity already exists.
 * @param message - complete message, including its stable identity.
 * @returns an immutable snapshot that preserves the identity.
 */
function freezeMessage(message) {
    return (0, call_config_1.deepFreeze)(structuredClone(message));
}
/**
 * Create one identified message and freeze it before publication.
 * @param input - complete role, content, and source for a new message.
 * @returns an immutable message with a fresh stable identity.
 */
function createMessage(input) {
    return freezeMessage({
        ...input,
        id: (0, brand_1.MessageId)(crypto.randomUUID()),
    });
}
/**
 * Create one identified user-role message and freeze it before publication.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
function createUserMessage(input) {
    return createMessage({
        ...input,
        role: 'user',
    });
}
/**
 * Create one identified model-produced assistant message and freeze it before publication.
 * @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
 * @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
 */
function createAssistantMessage(input) {
    return createMessage({
        role: 'assistant',
        content: input.content,
        source: {
            ...input.source,
            kind: 'model',
        },
    });
}
/**
 * Create and freeze one identified tool-result message.
 * @param input - call identity, raw result blocks, and outcome.
 * @returns an immutable user-role tool-result message.
 */
function createToolResultMessage(input) {
    return createUserMessage({
        source: { kind: 'tool', callId: input.callId },
        content: [{
                type: 'tool-result',
                toolCallId: input.callId,
                content: input.content,
                isError: input.isError,
            }],
    });
}
/**
 * Whether a stream chunk carries visible model output (the first-token
 * boundary shared by client step timing and the whole-log sessionStats
 * projection). Empty deltas (heartbeats, empty tool-call frames) do not count
 * as a first token.
 * @param chunk - the stream chunk to test.
 * @returns true when the chunk contains a non-empty text/reasoning/tool delta.
 */
function isTokenDelta(chunk) {
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
            return chunk.text !== '';
        case 'tool-call-delta':
            return chunk.argumentsDelta !== '' || chunk.name !== undefined;
        default:
            return false;
    }
}

},
"src/modules/client-connection/contracts/llm/llm/call-config.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/llm/llm/call-config.ts

"use strict";
/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.callConfigEquals = callConfigEquals;
exports.markAgentLoopRequest = markAgentLoopRequest;
exports.isAgentLoopRequest = isAgentLoopRequest;
exports.deepFreeze = deepFreeze;
/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = new WeakSet();
/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
function callConfigEquals(a, b) {
    if (a.provider !== b.provider
        || a.model !== b.model
        || a.reasoningEffort !== b.reasoningEffort
        || a.temperature !== b.temperature
        || a.maxTokens !== b.maxTokens)
        return false;
    if (a.stop === undefined || b.stop === undefined)
        return a.stop === b.stop;
    return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
/**
 * Mark one exact request object as assembled by dsh-agent-loop.
 * @param request - loop-owned request envelope before LLM dispatch.
 * @returns the same request object marked as created by the process-local agent loop.
 */
function markAgentLoopRequest(request) {
    AGENT_LOOP_REQUESTS.add(request);
    return request;
}
/**
 * Test whether the exact request object was assembled by dsh-agent-loop.
 * @param request - request envelope observed at the LLM waterfall.
 * @returns whether {@link markAgentLoopRequest} recorded this object.
 */
function isAgentLoopRequest(request) {
    return AGENT_LOOP_REQUESTS.has(request);
}
/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles,
 * so later mutation throws without imposing a JavaScript call-stack depth cap.
 * {@link AbortSignal} objects are deliberately skipped because they are the
 * request's live cancellation channel and freezing them breaks abort.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
function deepFreeze(value) {
    const seen = new WeakSet();
    const pending = [{ kind: 'visit', node: value }];
    while (pending.length > 0) {
        const task = pending.pop();
        /* v8 ignore next -- the loop condition guarantees one pending task. */
        if (task === undefined)
            continue;
        if (task.kind === 'property') {
            pending.push({ kind: 'visit', node: task.source[task.key] });
            continue;
        }
        const node = task.node;
        if (!isIndexable(node))
            continue;
        if (node instanceof AbortSignal)
            continue;
        if (seen.has(node))
            continue;
        seen.add(node);
        Object.freeze(node);
        const keys = Object.keys(node);
        for (let index = keys.length - 1; index >= 0; index--) {
            const key = keys[index];
            /* v8 ignore next -- the loop is bounded by the captured key count. */
            if (key === undefined)
                continue;
            pending.push({ kind: 'property', source: node, key });
        }
    }
    return value;
}
function isIndexable(value) {
    return typeof value === 'object' && value !== null;
}

},
"src/modules/client-connection/contracts/interaction/commands/brand.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/interaction/commands/brand.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandId = CommandId;
const zod_1 = require("zod");
/**
 * Brand a string as a {@link CommandId}.
 * @param id - the executor-minted pairing id.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function CommandId(id) {
    return zod_1.z.string().brand().parse(id);
}

},
"src/modules/client-connection/contracts/core/session/surface.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/core/session/surface.ts

"use strict";
/**
 * Surface layer on top of the session event log: an ordered view of events
 * that produce LLM messages. The append-only log remains the source of truth.
 *
 * Browser-safe: web clients consume this subpath export, so it must stay free
 * of `node:` imports (they break the vite bundle).
 *
 * @module @xharness/dsh-client-connection/contracts/core/session/surface
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SurfaceManager = void 0;
exports.isSurfaceEligibleType = isSurfaceEligibleType;
exports.isSurfaceEvent = isSurfaceEvent;
exports.isAppendSurfaceEvent = isAppendSurfaceEvent;
exports.isReplacementSurfaceEvent = isReplacementSurfaceEvent;
exports.deriveEventMessage = deriveEventMessage;
exports.foldSurface = foldSurface;
/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = new Set([
    'user/message',
    'assistant/message',
    'tool/result',
]);
/**
 * Whether an event type can join the model-visible surface.
 * @param type - event type to test.
 * @returns true for one of the three message-producing event types.
 */
function isSurfaceEligibleType(type) {
    return SURFACE_EVENT_TYPES.has(type);
}
function isSurfaceEvent(event) {
    return (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
        && event.surfaceOp !== undefined;
}
function isAppendSurfaceEvent(event) {
    return isSurfaceEvent(event) && event.surfaceOp === 'append';
}
function isReplacementSurfaceEvent(event) {
    return isSurfaceEvent(event) && event.surfaceOp !== 'append';
}
function deriveEventMessage(event) {
    if (event.type === 'user/message')
        return isWireMessage(event.data) ? event.data : null;
    if ((event.type === 'assistant/message' || event.type === 'tool/result') && isRecord(event.data)) {
        const message = event.data.message;
        if (!isWireMessage(message))
            return null;
        if (event.type === 'assistant/message' && message.content.length === 0)
            return null;
        return message;
    }
    return null;
}
function isWireMessage(value) {
    return isRecord(value) && typeof value.id === 'string'
        && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
        && isRecord(value.source) && typeof value.source.kind === 'string'
        && isUnknownArray(value.content) && value.content.every(block => isRecord(block) && typeof block.type === 'string');
}
/** Create an empty surface fold state. */
function createFoldState() {
    return { nodes: [], replaceGeneration: 0 };
}
/** Whether a runtime value is a non-negative safe event sequence. */
function isEventSeq(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value) {
    return Object.keys(value).length === 3
        && Object.hasOwn(value, 'op')
        && Object.hasOwn(value, 'start')
        && Object.hasOwn(value, 'end')
        && 'op' in value && value.op === 'replace'
        && 'start' in value && isEventSeq(value.start)
        && 'end' in value && isEventSeq(value.end);
}
/** Validate event-local surface eligibility and return its operation. */
function surfaceOpOf(event) {
    const surfaceOp = 'surfaceOp' in event ? event.surfaceOp : undefined;
    const sourceEventSeqs = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined;
    if (!isSurfaceEligibleType(event.type)) {
        if (surfaceOp !== undefined) {
            throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
        }
        if (sourceEventSeqs !== undefined) {
            throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
        }
        return;
    }
    const op = surfaceOp;
    if (op === undefined) {
        throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
    }
    if (op === 'append')
        return op;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
        throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
    }
    if (!isReplaceOp(op)) {
        throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
    }
    return op;
}
/** Validate cited source-event seqs against prior log entries and the replacement range. */
function assertProvenance(event, shadowedSeqs) {
    const raw = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined;
    const sources = new Set();
    if (raw !== undefined) {
        if (!isUnknownArray(raw)) {
            throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`);
        }
        if (raw.length === 0 && event.type !== 'assistant/message') {
            throw new Error('sourceEventSeqs must not be empty except on assistant/message');
        }
        let nonEarlierSource;
        for (const source of raw) {
            if (!isEventSeq(source)) {
                throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`);
            }
            sources.add(source);
            if (nonEarlierSource === undefined && source >= event.seq)
                nonEarlierSource = source;
        }
        if (sources.size !== raw.length) {
            throw new Error('sourceEventSeqs must not contain duplicates');
        }
        if (nonEarlierSource !== undefined) {
            throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`);
        }
    }
    const missing = shadowedSeqs.filter(seq => !sources.has(seq));
    if (missing.length > 0) {
        throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
    }
}
/** Locate one replacement range without mutating the current fold state. */
function replacementRange(state, op) {
    const startIdx = state.nodes.indexOf(op.start);
    if (startIdx === -1) {
        throw new Error(`surface replace: start seq ${op.start} not found in surface`);
    }
    const endIdx = state.nodes.indexOf(op.end);
    if (endIdx === -1) {
        throw new Error(`surface replace: end seq ${op.end} not found in surface`);
    }
    if (startIdx > endIdx) {
        throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`);
    }
    return {
        startIdx,
        endIdx,
        shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
    };
}
/**
 * Deep structural equality over the session-event JSON value domain
 * (null/boolean/number/string, arrays, plain objects). Replaces
 * `node:util`'s isDeepStrictEqual to keep this module browser-safe.
 */
function isDeepEqualJson(a, b) {
    if (a === b)
        return true;
    if (isUnknownArray(a) || isUnknownArray(b)) {
        if (!isUnknownArray(a) || !isUnknownArray(b) || a.length !== b.length)
            return false;
        return a.every((item, i) => isDeepEqualJson(item, b[i]));
    }
    if (!isRecord(a) || !isRecord(b))
        return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length)
        return false;
    return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson(a[key], b[key]));
}
/** Restrict a tool-result replacement to one current result's content. */
function assertToolResultRewrite(event, shadowedSeqs, events, baseSeq) {
    if (event.type !== 'tool/result')
        return;
    if (!isRewriteData(event.data))
        throw new Error('tool/result surface replacement has invalid message data');
    if (shadowedSeqs.length !== 1) {
        throw new Error('tool/result surface replacement must rewrite exactly one current node');
    }
    for (const originalSeq of shadowedSeqs) {
        const original = events[originalSeq - baseSeq];
        if (original?.type !== 'tool/result' || !isRewriteData(original.data)) {
            throw new Error('tool/result surface replacement must target a current tool/result');
        }
        const originalRest = { ...original.data };
        const replacementRest = { ...event.data };
        const originalResult = original.data.message.content[0];
        const replacementResult = event.data.message.content[0];
        originalRest['message'] = {
            ...original.data.message,
            content: [{ ...originalResult, content: null }],
        };
        replacementRest['message'] = {
            ...event.data.message,
            content: [{ ...replacementResult, content: null }],
        };
        if (!isDeepEqualJson(originalRest, replacementRest)) {
            throw new Error('tool/result surface replacement may change only content');
        }
    }
}
/** Validate one event at its replay boundary and prepare its atomic fold transition. */
function planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {
    if (event.seq !== expectedSeq) {
        throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
    }
    const surfaceOp = surfaceOpOf(event);
    if (surfaceOp === undefined)
        return;
    if (surfaceOp === 'append') {
        assertProvenance(event, []);
        return { kind: 'append', seq: event.seq };
    }
    const range = replacementRange(state, surfaceOp);
    assertProvenance(event, range.shadowedSeqs);
    assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);
    return {
        kind: 'replace',
        seq: event.seq,
        start: surfaceOp.start,
        end: surfaceOp.end,
        ...range,
    };
}
/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(state, event, expectedSeq, events, baseSeq) {
    const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq);
    return applySurfacePlan(state, plan);
}
/** Commit one previously validated surface transition. */
function applySurfacePlan(state, plan) {
    if (plan?.kind === 'append') {
        state.nodes.push(plan.seq);
    }
    else if (plan?.kind === 'replace') {
        state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
        state.replaceGeneration += 1;
    }
    if (plan?.kind !== 'replace')
        return;
    return {
        seq: plan.seq,
        start: plan.start,
        end: plan.end,
        shadowedSeqs: plan.shadowedSeqs,
    };
}
/**
 * Replay a complete session log through the canonical surface fold.
 * @param events - session events in contiguous seq order.
 * @returns detached current sequences and replacement history.
 * @throws when an event violates surface metadata, source-event references, range, or tool-result rewrite rules.
 */
function foldSurface(events) {
    const state = createFoldState();
    const replacements = [];
    for (const [index, event] of events.entries()) {
        const replacement = applySurfaceEvent(state, event, index, events, 0);
        if (replacement !== undefined)
            replacements.push(replacement);
    }
    return { nodes: [...state.nodes], replacements };
}
/** Incremental ordered surface view and append-boundary validator. */
class SurfaceManager {
    /**
     * @param log - Contiguous complete log or loaded event window.
     * @param baseSeq - Absolute sequence of the window's first event.
     */
    constructor(log, baseSeq = 0) {
        this.log = log;
        this.baseSeq = baseSeq;
        /** Shared transition state; replacement history is not retained. */
        this._state = createFoldState();
        this._lastProcessedSeq = baseSeq - 1;
    }
    /**
     * Validate the next candidate without mutating the committed surface.
     * @param event - candidate event that has not entered the log yet.
     */
    validateNext(event) {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        const expectedSeq = this.baseSeq + this.log.length;
        this._pendingPlan = {
            event,
            expectedSeq,
            plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq),
        };
    }
    /** Monotonic count of folded positional replacements. */
    get replaceGeneration() {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        return this._state.replaceGeneration;
    }
    /** Surface event sequences in model-visible order. */
    get nodes() {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        return this._state.nodes;
    }
    /** Fold events appended since the previous access. */
    _processDelta() {
        const tailSeq = this.baseSeq + this.log.length - 1;
        for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
            const index = seq - this.baseSeq;
            // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
            const event = this.log[index];
            if (event === undefined)
                throw new Error(`missing event at seq ${seq}`);
            const pending = this._pendingPlan;
            if (pending?.event === event && pending.expectedSeq === seq) {
                applySurfacePlan(this._state, pending.plan);
            }
            else {
                applySurfaceEvent(this._state, event, seq, this.log, this.baseSeq);
            }
            if (pending !== undefined && pending.expectedSeq <= seq)
                this._pendingPlan = undefined;
            this._lastProcessedSeq = seq;
        }
    }
}
exports.SurfaceManager = SurfaceManager;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isUnknownArray(value) { return Array.isArray(value); }
function isRewriteData(value) {
    return isRecord(value) && isRecord(value.message) && isUnknownArray(value.message.content)
        && isRecord(value.message.content[0]);
}

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

}
};
const __dependencies = {"src/modules/client-connection/index.js":{"./controller":"src/modules/client-connection/controller.js","./fixture":"src/modules/client-connection/fixture.js","./web-api-client":"src/modules/client-connection/web-api-client.js","./rpc":"src/modules/client-connection/rpc.js","./loopback-hostname":"src/modules/client-connection/loopback-hostname.js","../jobs/client":"src/modules/jobs/client.js","./api":"src/modules/client-connection/api.js"},"src/modules/client-connection/controller.js":{},"src/modules/client-connection/fixture.js":{"./contracts/host/apiproxy/api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","./contracts/host/apiproxy/api/subagents.schema":"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js","./contracts/host/apiproxy/api/host.schema":"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js","./contracts/host/apiproxy/api/workspace.schema":"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js","./contracts/host/apiproxy/api/skills.schema":"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js","./contracts/host/apiproxy/api/agent-presets.schema":"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js","./contracts/host/apiproxy/api/goals.schema":"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js","./contracts/host/apiproxy/api/settings.schema":"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js","./contracts/host/apiproxy/api/credentials.schema":"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js","./contracts/host/apiproxy/api/llm.schema":"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js","./contracts/host/apiproxy/fetch/client":"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js","../shared/runtime-types":"src/modules/shared/runtime-types.js","./contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","./contracts/attachment/attachment/brand":"src/modules/client-connection/contracts/attachment/attachment/brand.js","./contracts/interaction/user-approval/types":"src/modules/client-connection/contracts/interaction/user-approval/types.js","./contracts/llm/llm/brand":"src/modules/client-connection/contracts/llm/llm/brand.js","./contracts/llm/llm/message":"src/modules/client-connection/contracts/llm/llm/message.js","./contracts/interaction/commands/brand":"src/modules/client-connection/contracts/interaction/commands/brand.js","./contracts/core/session/surface":"src/modules/client-connection/contracts/core/session/surface.js","./api":"src/modules/client-connection/api.js","./random-uuid":"src/modules/client-connection/random-uuid.js"},"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js":{"./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js":{"../api/rpc":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js","../api/rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","../api/events.schema":"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js","../api/host.schema":"src/modules/client-connection/contracts/host/apiproxy/api/host.schema.js","../api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","../api/workspace.schema":"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js","../api/skills.schema":"src/modules/client-connection/contracts/host/apiproxy/api/skills.schema.js","../api/agent-presets.schema":"src/modules/client-connection/contracts/host/apiproxy/api/agent-presets.schema.js","../api/goals.schema":"src/modules/client-connection/contracts/host/apiproxy/api/goals.schema.js","../api/settings.schema":"src/modules/client-connection/contracts/host/apiproxy/api/settings.schema.js","../api/credentials.schema":"src/modules/client-connection/contracts/host/apiproxy/api/credentials.schema.js","../api/llm.schema":"src/modules/client-connection/contracts/host/apiproxy/api/llm.schema.js","../api/subagents.schema":"src/modules/client-connection/contracts/host/apiproxy/api/subagents.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js":{"./rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./approvals.schema":"src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.js","./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","./jobs.schema":"src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.js","./workspace.schema":"src/modules/client-connection/contracts/host/apiproxy/api/workspace.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/approvals.schema.js":{"./sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/client-connection/contracts/host/apiproxy/api/jobs.schema.js":{},"src/modules/shared/runtime-types.js":{},"src/modules/client-connection/contracts/core/session/types.js":{},"src/modules/client-connection/contracts/attachment/attachment/brand.js":{},"src/modules/client-connection/contracts/interaction/user-approval/types.js":{},"src/modules/client-connection/contracts/llm/llm/brand.js":{},"src/modules/client-connection/contracts/llm/llm/message.js":{"./brand":"src/modules/client-connection/contracts/llm/llm/brand.js","./call-config":"src/modules/client-connection/contracts/llm/llm/call-config.js"},"src/modules/client-connection/contracts/llm/llm/call-config.js":{},"src/modules/client-connection/contracts/interaction/commands/brand.js":{},"src/modules/client-connection/contracts/core/session/surface.js":{},"src/modules/client-connection/api.js":{"./contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","./contracts/host/apiproxy/fetch/client":"src/modules/client-connection/contracts/host/apiproxy/fetch/client.js"},"src/modules/client-connection/contracts/host/apiproxy/api/index.js":{"./rpc":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js","./rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/random-uuid.js":{},"src/modules/client-connection/web-api-client.js":{"./api":"src/modules/client-connection/api.js","./contracts/host/apiproxy/api/events.schema":"src/modules/client-connection/contracts/host/apiproxy/api/events.schema.js","./contracts/host/apiproxy/api/rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./api-path":"src/modules/client-connection/api-path.js"},"src/modules/client-connection/api-path.js":{},"src/modules/client-connection/rpc.js":{"./contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","./random-uuid":"src/modules/client-connection/random-uuid.js"},"src/modules/client-connection/loopback-hostname.js":{},"src/modules/jobs/client.js":{"./model":"src/modules/jobs/model.js"},"src/modules/jobs/model.js":{}};
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
