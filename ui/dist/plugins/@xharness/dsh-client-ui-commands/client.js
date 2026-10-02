// Generated from src/modules/commands/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-commands",
factory: (__externalRequire) => {
const __units = {
"src/modules/commands/index.js": function(module, exports, require) {
// source: src/modules/commands/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.PopupSelectController = exports.filterOptions = exports.CommandDirectory = exports.CommandUiRuntime = void 0;
exports.apply = apply;
// Type-only: pulls the 'conversation.input.overlay' SlotMap declaration (the
// key's owner) into this program so the overlay registration below typechecks
// against the real declaration — no runtime edge to ui-conversation.
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
const service_1 = require("./service");
const PopupSelectView_1 = require("./PopupSelectView");
const locales_1 = require("./locales");
var service_2 = require("./service");
Object.defineProperty(exports, "CommandUiRuntime", { enumerable: true, get: function () { return service_2.CommandUiRuntime; } });
var directory_1 = require("./directory");
Object.defineProperty(exports, "CommandDirectory", { enumerable: true, get: function () { return directory_1.CommandDirectory; } });
var popup_1 = require("./popup");
Object.defineProperty(exports, "filterOptions", { enumerable: true, get: function () { return popup_1.filterOptions; } });
Object.defineProperty(exports, "PopupSelectController", { enumerable: true, get: function () { return popup_1.PopupSelectController; } });
/** Dictionary namespace owned by this plugin. */
const NS = 'command';
/** Required services: the '/' source registry, session scopes, commands Remote, and locale registry. */
exports.inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale'];
/**
 * Client plugin body: mount the service, then register the popupSelect shell
 * into the input overlay once its declarer is up.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-commands: dictionaries');
    ctx.plugin(service_1.CommandUiRuntime);
    ctx.inject(['slots', 'commandUi', 'sessions'], (scope) => {
        const command = scope.commandUi;
        const sessions = scope.sessions;
        scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
            name: 'conversation.input.overlay',
            id: 'command-popup',
            order: 1,
            locale: NS,
            inject: (sessionId) => {
                const actx = sessions.scope(sessionId);
                if (actx === undefined)
                    throw new Error(`ui-commands: session "${String(sessionId)}" resolved no scope`);
                return { popup: command.popupFor(actx) };
            },
        }, PopupSelectView_1.PopupSelectView));
    });
}

},
"src/modules/commands/service.js": function(module, exports, require) {
// source: src/modules/commands/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandUiRuntime = void 0;
const core_context_1 = require("./core-context");
/**
 * CommandUiRuntime (`ctx.commandUi`): the '/' command source over the
 * session-keyed directory, the client-contribution registry, and the
 * per-session popupSelect controllers. Candidate synthesis merges the host
 * catalog with contributions by availability, then fuzzy query/position
 * filtering; a host/contribution name collision fails loud. Every execute
 * addresses the session's agent by sessionId — sessions are always
 * agent-backed.
 */
const cordis_1 = require("@xharness/cordis");
const directory_1 = require("./directory");
const popup_1 = require("./popup");
const Service = cordis_1.Service;
/** Recover the command name from a line the Host confirmed as executed. */
function submittedCommandName(line) {
    const trimmed = line.trim();
    const separator = trimmed.search(/\s/u);
    return (separator === -1 ? trimmed : trimmed.slice(0, separator)).slice(1);
}
/** Extra weight for command-name starts and separator boundaries. */
function boundaryBonus(name, index) {
    return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0;
}
/**
 * Score the strongest ordered-subsequence alignment in O(name × query).
 * Boundary and adjacent matches earn weight; skipped and leading characters
 * cost weight.
 */
function fuzzyScore(name, query) {
    if (query === '')
        return 0;
    if (query.length > name.length)
        return undefined;
    const noMatch = Number.NEGATIVE_INFINITY;
    let previous = Array(name.length).fill(noMatch);
    for (let index = 0; index < name.length; index++) {
        if (name.charAt(index) === query.charAt(0))
            previous[index] = 1 + boundaryBonus(name, index) - index;
    }
    for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
        const current = Array(name.length).fill(noMatch);
        let bestGapped = noMatch;
        for (let index = 0; index < name.length; index++) {
            const gappedIndex = index - 2;
            if (gappedIndex >= 0) {
                const prior = previous[gappedIndex] ?? noMatch;
                if (prior !== noMatch)
                    bestGapped = Math.max(bestGapped, prior + gappedIndex);
            }
            if (name.charAt(index) !== query.charAt(queryIndex))
                continue;
            const bonus = 1 + boundaryBonus(name, index);
            const adjacent = index > 0 ? previous[index - 1] ?? noMatch : noMatch;
            if (adjacent !== noMatch)
                current[index] = adjacent + bonus + 4;
            if (bestGapped !== noMatch)
                current[index] = Math.max(current[index] ?? noMatch, bestGapped + bonus + 1 - index);
        }
        previous = current;
    }
    let best = noMatch;
    for (const score of previous)
        best = Math.max(best, score);
    return best === noMatch ? undefined : best;
}
/** Case-insensitive fuzzy filtering with stable ordering for equal matches. */
function fuzzyCandidates(candidates, rawQuery) {
    const query = rawQuery.toLowerCase();
    if (query === '')
        return candidates;
    const ranked = [];
    candidates.forEach((candidate, index) => {
        const name = candidate.name.toLowerCase();
        const score = fuzzyScore(name, query);
        if (score !== undefined)
            ranked.push({ candidate, index, prefix: name.startsWith(query), score });
    });
    ranked.sort((left, right) => Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index);
    return ranked.map(match => match.candidate);
}
/** Command surface: session-keyed directory + '/' source + contribution registry + per-session popups. */
class CommandUiRuntime extends Service {
    /**
     * @param ctx - owning root context (plugin fiber; the service registers
     * itself as `command` and follows that fiber's lifetime).
     */
    constructor(ctx) {
        super((0, core_context_1.requireCoreContext)(ctx), 'commandUi');
        this.live = { contributions: new Map(), decorations: new Map(), popups: new Map() };
        /** Composer focus hooks by session (the overlay wiring binds the textarea focus here). */
        this.focusHooks = new Map();
        const locale = ctx.get('locale');
        if (locale === undefined)
            throw new Error('ui-commands: locale service unavailable');
        this.t = locale.bind('command');
        this.directory = new directory_1.CommandDirectory(async (sessionId) => {
            if (this.sessions().subagentAddress(sessionId) !== undefined)
                return [];
            const result = await ctx.remote.commands.list(sessionId);
            if (!result.ok)
                throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`);
            return result.value;
        });
        const inputTriggers = ctx.get('inputTriggers');
        if (inputTriggers === undefined)
            throw new Error('ui-commands: slash service unavailable');
        ctx.effect(() => inputTriggers.registerSource({
            trigger: '/',
            name: 'command',
            candidates: (session, req) => this.candidates(session, req),
            onPick: pick => this.dispatch(pick),
            matchSpace: (session, token) => this.matchSpace(session, token),
            matchEnter: (session, line, signal, envelope) => this.matchEnter(session, line, signal, envelope),
            warm: (session) => { this.directory.warm(session.sessionId); },
        }), 'command: slash source');
        ctx.remote.$on('commands/change', () => { this.directory.invalidateAll(); });
        // A preset switch changes which commands one session's agent resolves and
        // registers nothing globally, so the registry-wide signal above never
        // fires for it: repull that key alone, soft, so the old snapshot serves
        // the menu until the new one lands.
        ctx.remote.$on('agent-preset/selected', (sessionId) => { void this.directory.refresh(sessionId); });
        ctx.on('connection/reset', () => { this.directory.resetConnected(); });
    }
    /**
     * Register one client command contribution; effect disposer (rides the
     * caller's fiber). Duplicate names throw.
     * @param contribution - the contribution (descriptor + availability + popup spec).
     * @returns the disposer removing the registration.
     */
    register(contribution) {
        const dispose = this.ctxTyped.effect(() => {
            const { contributions } = this.live;
            if (contributions.has(contribution.name)) {
                throw new Error(`ui-commands: duplicate contribution for /${contribution.name}`);
            }
            contributions.set(contribution.name, contribution);
            return () => { contributions.delete(contribution.name); };
        }, 'command.register()');
        return () => { void dispose(); };
    }
    /**
     * Hang a bare-invocation decoration on one host command; effect disposer
     * (rides the caller's fiber). Duplicate names throw.
     * @param decoration - host command name + availability + popup spec.
     * @returns the disposer removing the registration.
     */
    decorate(decoration) {
        const dispose = this.ctxTyped.effect(() => {
            const { decorations } = this.live;
            if (decorations.has(decoration.name)) {
                throw new Error(`ui-commands: duplicate decoration for /${decoration.name}`);
            }
            decorations.set(decoration.name, decoration);
            return () => { decorations.delete(decoration.name); };
        }, 'command.decorate()');
        return () => { void dispose(); };
    }
    /**
     * Resolve the per-session popup controller (lazy; dies with the session
     * scope). The controller's consume callback dispatches the scoped
     * consume-token event back to this session; focusComposer reaches the
     * composer through the overlay slot currency.
     * @param actx - session-scope ctx.
     * @returns the resident controller.
     */
    popupFor(actx) {
        const sessions = this.sessions();
        const id = sessions.scopeOf(actx);
        if (id === undefined)
            throw new Error('command.popupFor requires a session scope');
        const { popups } = this.live;
        const existing = popups.get(id);
        if (existing !== undefined)
            return existing;
        const controller = new popup_1.PopupSelectController({
            consume: segment => actx.bail(actx, 'slash/input-consume-token', {
                guard: segment.via === 'menu'
                    ? { kind: 'span', span: segment.span }
                    : { kind: 'bare-token', token: segment.token },
            }) === true,
            focusComposer: () => { this.focusHooks.get(id)?.(); },
        });
        popups.set(id, controller);
        actx.effect(() => () => {
            controller.dispose();
            popups.delete(id);
            this.focusHooks.delete(id);
        }, 'command: session popup');
        return controller;
    }
    /**
     * Bind one session's composer-focus hook (overlay slot wiring; unbind on unmount).
     * @param id - session id.
     * @param focus - textarea focus callback.
     * @returns the unbind disposer.
     */
    bindComposerFocus(id, focus) {
        this.focusHooks.set(id, focus);
        return () => {
            if (this.focusHooks.get(id) === focus)
                this.focusHooks.delete(id);
        };
    }
    /** Menu candidates: host catalog + contribution availability, then position filtering and fuzzy name ranking. */
    async candidates(session, req) {
        const list = await this.directory.ensureReady(session.sessionId, req.signal);
        const rows = [];
        const seen = new Set();
        for (const c of list) {
            seen.add(c.name);
            rows.push({ name: c.name, description: c.description, ...(c.input !== undefined ? { hint: c.input.hint } : {}) });
        }
        for (const contribution of this.live.contributions.values()) {
            if (!contribution.available(session))
                continue;
            if (seen.has(contribution.name)) {
                throw new Error(`ui-commands: contribution /${contribution.name} collides with a host command`);
            }
            rows.push({ name: contribution.name, description: contribution.description });
        }
        return fuzzyCandidates(rows.filter(c => req.position === 'leading' || c.hint === undefined), req.query);
    }
    /** Decision table, menu column: contribution/decorated-host → popup; host input → claim; host bare → detached execute. */
    dispatch(pick) {
        const name = pick.candidate.name;
        const contribution = this.live.contributions.get(name);
        if (contribution !== undefined && contribution.available(pick.session)) {
            this.openPopup(name, contribution.ui, pick.session, { via: 'menu', span: pick.span });
            return 'handled';
        }
        const desc = this.directory.resolve(pick.session.sessionId, name);
        if (desc === undefined)
            return undefined; // snapshot swapped between menu and pick → miss
        // A decoration replaces the HOST row's bare invocation with its popup;
        // it decorates only a resolvable host command (checked above), never
        // manufactures one, and never touches the argument claim below.
        const decoration = this.live.decorations.get(name);
        if (decoration !== undefined && decoration.available(pick.session)) {
            this.openPopup(name, decoration.ui, pick.session, { via: 'menu', span: pick.span });
            return 'handled';
        }
        if (desc.input !== undefined)
            return { claim: this.leadingClaim(desc, pick.session) };
        // Menu-pick execute consumes the trigger span before the detached run
        // (scoped event; the input owns the CAS guard).
        this.consumeVia(pick.session.sessionId, { via: 'menu', span: pick.span });
        this.runDetached(desc, pick.session, `/${name}`);
        return 'handled';
    }
    /** Decision table, space column: hot-key sync check; only host leadingInput claims. */
    matchSpace(session, token) {
        if (!token.startsWith('/'))
            return undefined;
        const name = token.slice(1);
        if (this.live.contributions.has(name))
            return undefined; // popup kinds never claim on space
        const desc = this.directory.resolve(session.sessionId, name);
        if (desc === undefined || desc.input === undefined)
            return undefined;
        return { claim: this.leadingClaim(desc, session) };
    }
    /**
     * Decision table, enter column. Strong-waits the session's catalog (a
     * warmup failure rejects — never a silent downgrade). Contributions and
     * bare host commands act on the bare token only; leadingInput claims
     * args-tolerant.
     *
     * Envelope policy: an enter submission carrying images resolves only
     * through a command declaring image acceptance. Every other command route —
     * popup, non-accepting claim, bare detached execute — throws the refusal
     * so the machine surfaces one composer notice and the draft and images
     * stay in place; nothing executes and nothing is dropped.
     */
    async matchEnter(session, line, signal, envelope) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('/'))
            return undefined;
        const ws = trimmed.search(/\s/);
        const token = ws === -1 ? trimmed : trimmed.slice(0, ws);
        const bare = ws === -1;
        const name = token.slice(1);
        if (name === '')
            return undefined;
        const refuseImages = () => {
            throw new Error(this.t('notice.imagesUnsupported', { command: name }));
        };
        const contribution = this.live.contributions.get(name);
        if (contribution !== undefined && contribution.available(session)) {
            if (!bare)
                return undefined;
            if (envelope.images > 0)
                refuseImages();
            this.openPopup(name, contribution.ui, session, { via: 'enter', token });
            return 'handled';
        }
        await this.directory.ensureReady(session.sessionId, signal);
        const desc = this.directory.resolve(session.sessionId, name);
        if (desc === undefined)
            return undefined;
        // Bare enter on a decorated host command opens its popup; an argued line
        // never consults the decoration (the claim/detached paths below own it).
        if (bare) {
            const decoration = this.live.decorations.get(name);
            if (decoration !== undefined && decoration.available(session)) {
                if (envelope.images > 0)
                    refuseImages();
                this.openPopup(name, decoration.ui, session, { via: 'enter', token });
                return 'handled';
            }
        }
        if (desc.input !== undefined) {
            if (envelope.images > 0 && desc.input.images !== true)
                refuseImages();
            return { claim: this.leadingClaim(desc, session) };
        }
        if (!bare)
            return undefined;
        if (envelope.images > 0)
            refuseImages();
        this.consumeVia(session.sessionId, { via: 'enter', token });
        this.runDetached(desc, session, trimmed);
        return 'handled';
    }
    /** Open the session's popup for one contribution or decoration (menu pick / bare enter). */
    openPopup(name, ui, session, segment) {
        const actx = this.scopeFor(session.sessionId);
        if (actx === undefined)
            return;
        this.popupFor(actx).open(name, ui, session, segment);
    }
    /** Build the leadingInput claim: token `/name ` + the command.execute submit transaction. */
    leadingClaim(desc, session) {
        const token = `/${desc.name} `;
        return {
            token,
            ...(desc.input !== undefined ? { hint: desc.input.hint } : {}),
            ...(desc.input?.images === true ? { images: true } : {}),
            submit: (args, _actx, images) => this.execute(session, token + args, images),
        };
    }
    /**
     * The command.execute transaction, addressed to the session's agent — pure
     * admission semantics. An unmatched line reports an error outcome (the
     * composer's immediate admission feedback); an admitted command reports
     * plain success regardless of its handler outcome, because the host
     * executor durably logged the lifecycle (`command/run`/`command/done`) and
     * the outcome renders as a persistent flow node — the composer never
     * echoes it. A handler error result reports an error outcome so the
     * composer keeps the submission (draft and images) for correction.
     * Transport failures throw.
     */
    async execute(session, line, images = []) {
        const result = await (0, core_context_1.commandRemote)(this.ctx).execute(session.sessionId, line, images);
        if (!result.ok)
            throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`);
        if (result.value === undefined)
            return { kind: 'error', text: `unknown or malformed command: ${line}` };
        this.notifyExecuted(session.sessionId, submittedCommandName(line), result.value.result);
        // An image-carrying submission consumed its images only on handler
        // success; an error outcome keeps draft and images in the composer.
        if (images.length > 0 && result.value.result.kind === 'error') {
            return { kind: 'error', text: result.value.result.text };
        }
        return { kind: 'success' };
    }
    /** Publish the local acknowledgment without letting an observer change command admission. */
    notifyExecuted(sessionId, name, result) {
        const args = ['command/executed', sessionId, name, result];
        for (const listener of this.ctxTyped.events.dispatch('emit', args)) {
            try {
                const returned = listener(sessionId, name, result);
                if ((0, core_context_1.isThenable)(returned)) {
                    void Promise.resolve(returned).then(undefined, (error) => {
                        this.warnExecutedListenerFailure(name, error);
                    });
                }
            }
            catch (error) {
                this.warnExecutedListenerFailure(name, error);
            }
        }
    }
    /** Log one contained `command/executed` observer failure. */
    warnExecutedListenerFailure(name, error) {
        this.ctxTyped.logger.warn('client command: a command/executed listener for "%s" failed', name);
        this.ctxTyped.logger.warn(error);
    }
    /**
     * Fire-and-forget execute for the internal ('handled') paths. Outcomes are
     * NOT surfaced here: the host executor durably logs the command lifecycle
     * (`command/run`/`command/done`), and the mux-broadcast events render as a
     * persistent flow node on every tab. Only a transport/admission failure —
     * which never entered a handler and therefore never logged — falls back to
     * the composer notice as immediate feedback.
     */
    runDetached(desc, session, line) {
        void this.execute(session, line).then((outcome) => {
            // matched:false maps to an error outcome with no logged lifecycle.
            if (outcome.kind === 'error')
                this.noticeFor(session.sessionId, 'error', outcome.text ?? `/${desc.name} failed`);
        }, (error) => {
            this.noticeFor(session.sessionId, 'error', error instanceof Error ? error.message : String(error));
        });
    }
    /** Dispatch a consume-token event to one session (menu-pick / bare-enter execute paths). */
    consumeVia(id, segment) {
        const actx = this.scopeFor(id);
        if (actx === undefined)
            return;
        actx.bail(actx, 'slash/input-consume-token', {
            guard: segment.via === 'menu'
                ? { kind: 'span', span: segment.span }
                : { kind: 'bare-token', token: segment.token },
        });
    }
    /** Route an admission/transport failure to the session's composer notice channel (scope gone = attempt died with it). */
    noticeFor(id, level, text) {
        const actx = this.scopeFor(id);
        if (actx === undefined)
            return;
        const conversation = actx.get('conversation');
        if (conversation === undefined)
            return;
        conversation.input.for(actx).notify(level, text);
    }
    /** id → actx interchange (registered exchange point: this service coordinates for projection-only sources). */
    scopeFor(id) {
        return this.sessions().scope(id);
    }
    get ctxTyped() {
        const value = this.ctx;
        return (0, core_context_1.commandContext)(value);
    }
    sessions() {
        const sessions = this.ctxTyped.get('sessions');
        if (!(0, core_context_1.isSessions)(sessions))
            throw new Error('ui-commands: sessions service unavailable');
        return sessions;
    }
}
exports.CommandUiRuntime = CommandUiRuntime;
CommandUiRuntime.inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands'];

},
"src/modules/commands/core-context.js": function(module, exports, require) {
// source: src/modules/commands/core-context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCoreContext = requireCoreContext;
exports.commandContext = commandContext;
exports.commandRemote = commandRemote;
exports.isThenable = isThenable;
exports.isSessions = isSessions;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
function requireCoreContext(value) {
    if (!cordis_1.Context.is(value))
        throw new Error('commands require a Cordis Context');
    return value;
}
function isCommandContext(value) {
    if (!cordis_1.Context.is(value) || !(0, runtime_types_1.isObjectRecord)(value))
        return false;
    const events = value.events, logger = value.logger;
    if (!(0, runtime_types_1.isObjectRecord)(events))
        return false;
    if ((typeof logger !== 'object' && typeof logger !== 'function') || logger === null)
        return false;
    const warn = Reflect.get(logger, 'warn');
    return typeof value.effect === 'function' && typeof value.get === 'function'
        && typeof events.dispatch === 'function' && typeof warn === 'function';
}
/** Read this.ctx for every call: Core's service tracker supplies the calling scope. */
function commandContext(value) {
    if (!isCommandContext(value))
        throw new Error('commands context capabilities unavailable');
    return value;
}
/** Namespace access itself enforces the caller's inject policy. Defer it until
 * an execution actually needs it: contribution registration/decorating only
 * owns an effect and never required remote.commands in the frozen service.
 */
function commandRemote(value) {
    if (!cordis_1.Context.is(value) || !(0, runtime_types_1.isObjectRecord)(value))
        throw new Error('commands require a Cordis Context');
    const remote = value.remote;
    if (!(0, runtime_types_1.isObjectRecord)(remote))
        throw new Error('commands Remote unavailable');
    const commands = remote.commands;
    if (!isCommandsRemote(commands))
        throw new Error('commands Remote unavailable');
    return commands;
}
function isCommandsRemote(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.list === 'function' && typeof value.execute === 'function';
}
function isThenable(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return false;
    const then = Reflect.get(value, 'then');
    return typeof then === 'function';
}
function isSessions(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.scope === 'function' && typeof value.scopeOf === 'function' && typeof value.subagentAddress === 'function';
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

},
"src/modules/commands/directory.js": function(module, exports, require) {
// source: src/modules/commands/directory.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandDirectory = void 0;
/** One session key's cache cell. */
class Entry {
    constructor() {
        this.state = 'cold';
        this.commands = [];
        /** Bumped at each pull start; only the latest pull may publish its outcome. */
        this.epoch = 0;
        this.waiters = [];
    }
}
/** The session-keyed directory cache. Plain class — the owning service wires events and RPC. */
class CommandDirectory {
    constructor(fetchCommands) {
        this.fetchCommands = fetchCommands;
        this.entries = new Map();
    }
    /**
     * Current cache status for one session.
     * @param sessionId - session key.
     * @returns the entry status (cold when never touched).
     */
    status(sessionId) {
        return this.entries.get(sessionId)?.state ?? 'cold';
    }
    /**
     * Synchronous exact-name lookup over one session's hot snapshot.
     * @param sessionId - session key.
     * @param name - command name without the leading slash.
     * @returns the descriptor, or undefined when absent or the entry is not ready.
     */
    resolve(sessionId, name) {
        const entry = this.entries.get(sessionId);
        if (entry === undefined || entry.state !== 'ready')
            return undefined;
        return entry.commands.find(c => c.name === name);
    }
    /** Soft invalidation (commands-changed): background repull on every touched key; ready snapshots keep serving. */
    invalidateAll() {
        for (const key of this.entries.keys())
            void this.refresh(key);
    }
    /**
     * Hard reset on reconnect: every entry drops its snapshot (the agent world
     * may have changed shape across the generation) and prewarms.
     */
    resetConnected() {
        for (const [key, entry] of this.entries) {
            entry.state = 'cold';
            entry.commands = [];
            void this.refresh(key);
        }
    }
    /**
     * Fire-and-forget prewarm of one session (the command source's scope-birth
     * warm hook lands here).
     * @param sessionId - session key.
     */
    warm(sessionId) {
        const entry = this.entry(sessionId);
        if (entry.state === 'cold' || entry.state === 'failed')
            void this.refresh(sessionId);
    }
    /**
     * Start one pull for one session. Publishes ready/failed only while it is
     * still the key's latest pull (epoch guard); a ready snapshot is not
     * demoted while the pull flies.
     * @param sessionId - session key.
     * @returns settled when this pull's outcome is published or discarded.
     */
    async refresh(sessionId) {
        const entry = this.entry(sessionId);
        const epoch = ++entry.epoch;
        if (entry.state !== 'ready')
            entry.state = 'pending';
        try {
            const commands = await this.fetchCommands(sessionId);
            if (epoch !== entry.epoch)
                return;
            entry.commands = commands;
            entry.state = 'ready';
            entry.lastError = undefined;
        }
        catch (error) {
            if (epoch !== entry.epoch)
                return;
            entry.commands = [];
            entry.state = 'failed';
            entry.lastError = error;
        }
        finally {
            if (epoch === entry.epoch)
                notifyWaiters(entry);
        }
    }
    /**
     * Strong-wait until one session's catalog is servable (the enter-
     * adjudication "directory must be reached" rule): ready returns at once;
     * cold/failed launch a fresh pull; pending joins the flying one. Rejects
     * when the awaited pull fails or the signal aborts.
     * @param sessionId - session key.
     * @param signal - attempt-scoped abort (the SubmitAttempt signal).
     * @returns the hot command snapshot.
     */
    async ensureReady(sessionId, signal) {
        const entry = this.entry(sessionId);
        while (true) {
            if (entry.state === 'ready')
                return entry.commands;
            if (entry.state !== 'pending')
                void this.refresh(sessionId);
            await settled(entry, signal);
            if (entry.state === 'failed') {
                throw new Error(`command directory warmup failed: ${entry.lastError instanceof Error ? entry.lastError.message : String(entry.lastError)}`);
            }
            // Still pending (the awaited pull was superseded) → wait for the winner.
        }
    }
    entry(sessionId) {
        let entry = this.entries.get(sessionId);
        if (entry === undefined) {
            entry = new Entry();
            this.entries.set(sessionId, entry);
        }
        return entry;
    }
}
exports.CommandDirectory = CommandDirectory;
/** One settlement tick for one entry: resolves at the next winning publish, rejects on abort. */
function settled(entry, signal) {
    if (signal.aborted)
        return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const waiter = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            entry.waiters = entry.waiters.filter(w => w !== waiter);
            reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.waiters.push(waiter);
    });
}
function notifyWaiters(entry) {
    const woken = entry.waiters;
    entry.waiters = [];
    for (const wake of woken)
        wake();
}
/** Normalize an abort into an Error rejection. */
function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('command directory wait aborted');
}

},
"src/modules/commands/popup.js": function(module, exports, require) {
// source: src/modules/commands/popup.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PopupSelectController = void 0;
exports.filterOptions = filterOptions;
/**
 * Headless popupSelect shell state: one controller per client
 * session, owned by CommandUiRuntime's per-session map and torn down by the
 * session scope disposer. The shell is a transient layer (never in the input
 * state machine): it loads options once, filters them locally against the
 * shell's own search text, and settles a selection through the context
 * captured at open time. Draft consumption and composer focus are injected
 * callbacks — the session wiring dispatches the consume-token event (the
 * Input side owns the span/bare-token CAS guard) and focuses the composer;
 * the controller never touches the input machine.
 */
const client_1 = require("@xharness/dsh-client-runtime/client");
const CLOSED = {
    open: false, command: null, status: 'pending', options: [], search: '', active: 0,
    submitting: false, confirming: null, acknowledged: false, error: null,
};
/**
 * Filter option rows against the shell's local search text (case-insensitive
 * substring over label and detail; blank search keeps every row).
 * @param options - the loaded rows.
 * @param search - the shell's search text.
 * @returns the rows the shell shows and highlights over.
 */
function filterOptions(options, search) {
    const query = search.trim().toLowerCase();
    if (query === '')
        return options;
    return options.filter(o => o.label.toLowerCase().includes(query) || (o.detail?.toLowerCase().includes(query) ?? false));
}
/** The shell's error-strip line for a settlement failure. */
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Headless controller of one session's popupSelect shell. Late settlements
 * lose their write rights through binding identity: dismiss/dispose/reopen
 * swap the binding, so a settling options fetch or onSelect that no longer
 * matches writes nothing and consumes nothing.
 */
class PopupSelectController {
    /**
     * @param deps - session-wiring callbacks (token consumption + composer focus).
     */
    constructor(deps) {
        this.deps = deps;
        /** Shell state store (the overlay component subscribes here). */
        this.state = (0, client_1.createSnapshotStore)(CLOSED);
        this.binding = null;
    }
    /**
     * Open the shell for one command: publish pending state and fetch options
     * once through the business spec. A reopen supersedes the previous shell
     * (its options fetch is aborted, its late settlements are dropped).
     * @param command - command name the shell serves.
     * @param spec - the registered popupSelect spec.
     * @param context - open-time context snapshot, handed verbatim to options/onSelect.
     * @param segment - open-time token segment snapshot for post-select consumption.
     */
    open(command, spec, context, segment) {
        this.binding?.abort.abort();
        const binding = { command, spec, context, segment, abort: new AbortController() };
        this.binding = binding;
        this.state.set({ ...CLOSED, open: true, command });
        this.load(binding);
    }
    /** Run the one options fetch of a binding; settlement rights die with the binding. */
    load(binding) {
        binding.spec.options(binding.context, binding.abort.signal).then((options) => {
            if (this.binding !== binding)
                return;
            this.state.set({ ...this.state.getSnapshot(), status: 'ready', options, active: 0, error: null });
        }, (error) => {
            if (this.binding !== binding)
                return;
            console.error(`[ui-commands] popupSelect options failed for /${binding.command}:`, error);
            this.state.set({ ...this.state.getSnapshot(), status: 'failed', options: [], active: 0, error: errorText(error) });
        });
    }
    /** Re-run a failed options fetch (search survives; no-op unless status is 'failed'). */
    retry() {
        const binding = this.binding;
        const s = this.state.getSnapshot();
        if (binding === null || !s.open || s.status !== 'failed')
            return;
        this.state.set({ ...s, status: 'pending', error: null });
        this.load(binding);
    }
    /**
     * Replace the local search text (pure local filter — the provider is never
     * re-queried) and rebase the highlight onto the new filtered list.
     * @param search - the shell search input's text.
     */
    setSearch(search) {
        const s = this.state.getSnapshot();
        if (!s.open || s.submitting || s.confirming !== null || search === s.search)
            return;
        this.state.set({ ...s, search, active: 0 });
    }
    /**
     * Move the highlight across the filtered rows (wraps around; no-op unless
     * options are ready and no selection is in flight).
     * @param dir - +1 down, -1 up.
     */
    move(dir) {
        const s = this.state.getSnapshot();
        if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
            return;
        const rows = filterOptions(s.options, s.search);
        if (rows.length === 0)
            return;
        const active = (s.active + dir + rows.length) % rows.length;
        this.state.set({ ...s, active });
    }
    /**
     * Set the highlight directly (pointer hover; no-op unless ready, idle, and
     * in filtered range).
     * @param index - filtered-row index.
     */
    highlight(index) {
        const s = this.state.getSnapshot();
        if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
            return;
        if (index < 0 || index >= filterOptions(s.options, s.search).length || index === s.active)
            return;
        this.state.set({ ...s, active: index });
    }
    /**
     * Select one filtered row: single-flight — the first call enters
     * `submitting` and later calls no-op until it settles. Success consumes the
     * open-time token segment (a false CAS answer is benign), closes, and
     * returns focus to the composer. Failure keeps the shell open with search,
     * highlight, and token intact, surfaces the error, and re-arms select as
     * the retry.
     * @param index - filtered-row index (callers pass the highlight or the clicked row).
     * @returns settled when the attempt has closed the shell or surfaced its failure.
     */
    async select(index) {
        const binding = this.binding;
        const s = this.state.getSnapshot();
        if (binding === null || !s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
            return;
        const option = filterOptions(s.options, s.search)[index];
        if (option === undefined)
            return;
        if (option.confirmation !== undefined) {
            this.state.set({ ...s, confirming: option, acknowledged: false, error: null });
            return;
        }
        await this.settle(binding, option);
    }
    /**
     * Update the explicit checkbox for the currently pending risk gate.
     * @param acknowledged - whether the user has acknowledged the displayed risk.
     */
    acknowledge(acknowledged) {
        const s = this.state.getSnapshot();
        if (!s.open || s.submitting || s.confirming === null || s.acknowledged === acknowledged)
            return;
        this.state.set({ ...s, acknowledged });
    }
    /** Cancel only the risk gate and return to the still-open option picker. */
    cancelConfirmation() {
        const s = this.state.getSnapshot();
        if (!s.open || s.submitting || s.confirming === null)
            return;
        this.state.set({ ...s, confirming: null, acknowledged: false });
    }
    /** Settle the gated option only after the checkbox is acknowledged. */
    async confirm() {
        const binding = this.binding;
        const s = this.state.getSnapshot();
        if (binding === null || !s.open || s.submitting || s.confirming === null || !s.acknowledged)
            return;
        await this.settle(binding, s.confirming);
    }
    /** Run the business settlement for an already admitted option. */
    async settle(binding, option) {
        const s = this.state.getSnapshot();
        if (this.binding !== binding || !s.open || s.submitting)
            return;
        this.state.set({ ...s, submitting: true, confirming: null, acknowledged: false, error: null });
        try {
            await binding.spec.onSelect(option, binding.context);
        }
        catch (error) {
            console.error(`[ui-commands] popupSelect onSelect failed for /${binding.command}:`, error);
            if (this.binding !== binding)
                return; // dismissed/reopened/disposed while onSelect flew
            this.state.set({ ...this.state.getSnapshot(), submitting: false, error: errorText(error) });
            return;
        }
        if (this.binding !== binding)
            return; // late success: no state write, no consumption
        this.deps.consume(binding.segment);
        this.binding = null;
        this.state.set(CLOSED);
        this.deps.focusComposer();
    }
    /**
     * Close the shell; aborts a flying options fetch and revokes settlement
     * rights. An outside pointer interaction dismisses plainly (the click's own
     * target takes focus); Escape passes focusComposer to return focus explicitly.
     * @param opts - focusComposer: also restore composer focus (Escape path).
     */
    dismiss(opts) {
        if (this.binding === null)
            return;
        this.binding.abort.abort();
        this.binding = null;
        this.state.set(CLOSED);
        if (opts?.focusComposer === true)
            this.deps.focusComposer();
    }
    /** Scope-teardown disposer: abort in-flight work and clear state (no focus side effect). */
    dispose() {
        this.binding?.abort.abort();
        this.binding = null;
        this.state.set(CLOSED);
    }
}
exports.PopupSelectController = PopupSelectController;

},
"src/modules/commands/PopupSelectView.js": function(module, exports, require) {
// source: src/modules/commands/PopupSelectView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PopupSelectView = PopupSelectView;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Official popupSelect shell: renders one session's PopupSelectController
 * store into the conversation.input.overlay anchor. Unlike the slash menu
 * (combobox — textarea keeps focus), this shell HOLDS focus while open: the
 * inner search input takes focus, plain typing filters the loaded options
 * locally, Enter/↑↓ drive the filtered highlight (scrolled into view), Escape
 * dismisses back to the composer, and ←→ keep the search input's native
 * caret. Any pointer interaction outside the box dismisses (the click's own
 * target takes focus). Closed state renders null; the overlay slot stays
 * mounted. The card height clamps to the space above the composer.
 */
const react_1 = require("react");
const react_2 = require("react");
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const popup_1 = require("./popup");
const PopupSelectView_styles_1 = __importDefault(require("./PopupSelectView.styles"));
/** Design cap on the card height (same MenuDropdown family as the slash menu). */
const MAX_HEIGHT = 320;
/**
 * Render the popupSelect shell overlay entry.
 * @param props - injected face: the session's shell controller; `t` rides the standard locale seat.
 * @returns the select card while open; null while closed.
 */
function PopupSelectView({ popup, t }) {
    const state = (0, react_2.useSyncExternalStore)(fn => popup.state.subscribe(fn), () => popup.state.getSnapshot());
    const cardRef = (0, react_1.useRef)(null);
    const searchRef = (0, react_1.useRef)(null);
    // The card is bottom-anchored above the composer; clamp the design cap to
    // the space above it, re-measured on every store update.
    const maxHeight = (0, dsh_client_ui_primitives_1.useAnchoredMaxHeight)(cardRef, MAX_HEIGHT, state);
    const active = state.open ? state.active : null;
    // The search input keeps focus while arrows move a virtual highlight, so
    // the browser never scrolls the active row into view — do it here.
    (0, react_1.useEffect)(() => {
        if (active === null)
            return;
        cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [active]);
    // Focus ownership: the search input grabs on open, and ANY outside
    // pointer interaction dismisses —
    // capture phase so a click landing anywhere else (textarea included)
    // closes the shell before its own handlers run; that click's target then
    // takes focus naturally, so no focusComposer here.
    (0, react_1.useEffect)(() => {
        if (!state.open || state.confirming !== null)
            return;
        const onPointerDown = (ev) => {
            if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target))
                return;
            popup.dismiss();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => { document.removeEventListener('pointerdown', onPointerDown, true); };
    }, [state.open, state.confirming, popup]);
    // Focus the search input after it mounts (separate effect so the ref is populated).
    (0, react_1.useEffect)(() => {
        if (state.open && state.confirming === null)
            searchRef.current?.focus();
    }, [state.open, state.confirming]);
    if (!state.open)
        return null;
    const rows = (0, popup_1.filterOptions)(state.options, state.search);
    const confirmation = state.confirming?.confirmation;
    const onKeyDown = (ev) => {
        // ArrowLeft/ArrowRight fall through on purpose: the search input keeps
        // its native caret movement.
        switch (ev.key) {
            case 'ArrowDown':
                ev.preventDefault();
                popup.move(1);
                return;
            case 'ArrowUp':
                ev.preventDefault();
                popup.move(-1);
                return;
            case 'Enter':
                ev.preventDefault();
                void popup.select(state.active);
                return;
            case 'Escape':
                ev.preventDefault();
                popup.dismiss({ focusComposer: true });
                return;
            default:
        }
    };
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [state.confirming === null && ((0, jsx_runtime_1.jsxs)("div", { ref: cardRef, className: PopupSelectView_styles_1.default.card, style: { maxHeight }, "aria-label": t('overlay.aria', { command: String(state.command) }), onKeyDown: onKeyDown, children: [(0, jsx_runtime_1.jsx)("input", { ref: searchRef, className: PopupSelectView_styles_1.default.search, type: "text", placeholder: t('search.placeholder'), "aria-label": t('search.aria'), value: state.search, readOnly: state.submitting, onChange: (ev) => { popup.setSearch(ev.currentTarget.value); } }), state.error !== null && ((0, jsx_runtime_1.jsxs)("div", { className: PopupSelectView_styles_1.default.error, role: "alert", children: [(0, jsx_runtime_1.jsx)("span", { className: PopupSelectView_styles_1.default.errorText, children: state.error }), state.status === 'failed' && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: PopupSelectView_styles_1.default.retry, onClick: () => { popup.retry(); }, children: t('retry') }))] })), state.status === 'pending' && (0, jsx_runtime_1.jsx)("div", { className: PopupSelectView_styles_1.default.status, children: t('status.loading') }), state.submitting && (0, jsx_runtime_1.jsx)("div", { className: PopupSelectView_styles_1.default.status, children: t('status.applying') }), state.status === 'ready' && rows.length === 0 && (0, jsx_runtime_1.jsx)("div", { className: PopupSelectView_styles_1.default.status, children: t('status.empty') }), state.status === 'ready' && ((0, jsx_runtime_1.jsx)("div", { role: "listbox", "aria-label": t('listbox.aria', { command: String(state.command) }), className: PopupSelectView_styles_1.default.viewport, children: rows.map((option, index) => ((0, jsx_runtime_1.jsxs)("div", { role: "option", "aria-selected": index === state.active, className: (0, views_types_1.classNames)(PopupSelectView_styles_1.default.row, index === state.active && PopupSelectView_styles_1.default.rowActive),
                            // mousedown would race the document capture listener; the shell
                            // owns focus anyway, so a plain click (inside the card → no
                            // dismiss) works.
                            onClick: () => { void popup.select(index); }, onMouseEnter: () => { popup.highlight(index); }, children: [(0, jsx_runtime_1.jsx)("span", { className: PopupSelectView_styles_1.default.label, children: option.label }), option.detail !== undefined && (0, jsx_runtime_1.jsx)("span", { className: PopupSelectView_styles_1.default.detail, children: option.detail }), option.active === true && (0, jsx_runtime_1.jsx)("span", { className: PopupSelectView_styles_1.default.check, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, {}) })] }, option.id))) }))] })), confirmation !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.RiskConfirmation, { open: true, title: confirmation.title, description: confirmation.description, acknowledgeLabel: confirmation.acknowledgeLabel, cancelLabel: confirmation.cancelLabel, confirmLabel: confirmation.confirmLabel, acknowledged: state.acknowledged, onAcknowledgedChange: (value) => { popup.acknowledge(value); }, onCancel: () => { popup.cancelConfirmation(); }, onConfirm: () => { void popup.confirm(); } }))] }));
}

},
"src/modules/views-types.js": function(module, exports, require) {
// source: src/modules/views-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classNames = classNames;
exports.installStyles = installStyles;
function classNames(...values) { return values.filter(Boolean).join(' '); }
/** Exact legacy style identity, but editable source rather than compiled input. */
function installStyles(id, plugin, css) {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = plugin;
    tag.dataset.pluginCss = id;
    tag.textContent = css;
    document.head.appendChild(tag);
}

},
"src/modules/commands/PopupSelectView.styles.js": function(module, exports, require) {
// source: src/modules/commands/PopupSelectView.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PopupSelectView_css_1 = __importDefault(require("./PopupSelectView.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-commands/PopupSelectView.module.css", "@xharness/dsh-client-ui-commands", PopupSelectView_css_1.default);
const styles = {
    "card": "_9M5QqG_card",
    "check": "_9M5QqG_check",
    "detail": "_9M5QqG_detail",
    "error": "_9M5QqG_error",
    "errorText": "_9M5QqG_errorText",
    "label": "_9M5QqG_label",
    "retry": "_9M5QqG_retry",
    "row": "_9M5QqG_row",
    "rowActive": "_9M5QqG_rowActive",
    "search": "_9M5QqG_search",
    "status": "_9M5QqG_status",
    "viewport": "_9M5QqG_viewport"
};
exports.default = styles;

},
"src/modules/commands/PopupSelectView.css": function(module, exports, require) {
// source: src/modules/commands/PopupSelectView.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._9M5QqG_card{z-index:100;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);min-width:min(220px,100%);max-width:100%;max-height:320px;box-shadow:var(--dsw-shadow-lv3);border-radius:12px;outline:none;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 4px);left:0;overflow:hidden}._9M5QqG_viewport{flex-direction:column;min-height:0;display:flex;overflow-y:auto}._9M5QqG_row{cursor:pointer;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:13px;display:flex}._9M5QqG_rowActive{background:var(--dsw-alias-interactive-bg-hover)}._9M5QqG_label{white-space:nowrap;text-overflow:ellipsis;flex:auto;min-width:0;overflow:hidden}._9M5QqG_detail{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;overflow:hidden}._9M5QqG_check{color:var(--dsw-alias-label-primary);flex:none;display:inline-flex}._9M5QqG_status{color:var(--dsw-alias-label-tertiary);padding:8px 10px;font-size:13px}._9M5QqG_search{border:1px solid var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary);background:0 0;border-radius:8px;outline:none;margin:2px 2px 4px;padding:6px 8px;font-size:13px}._9M5QqG_error{color:var(--dsw-alias-state-error-primary);align-items:center;gap:8px;padding:6px 8px;font-size:12px;display:flex}._9M5QqG_errorText{text-overflow:ellipsis;flex:1;overflow:hidden}._9M5QqG_retry{border:1px solid var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:6px;padding:2px 8px;font-size:12px}\n";

},
"src/modules/commands/locales.js": function(module, exports, require) {
// source: src/modules/commands/locales.ts

"use strict";
/** `command` namespace dictionaries (the popupSelect shell's copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'search.placeholder': '搜索…',
    'search.aria': '筛选选项',
    'status.loading': '正在加载选项…',
    'status.applying': '正在应用…',
    'status.empty': '无选项',
    'overlay.aria': '/{command} 选项',
    'listbox.aria': '/{command} 匹配项',
    'notice.imagesUnsupported': '/{command} 不接受图片附件，请先移除图片',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'search.placeholder': 'Search…',
    'search.aria': 'Filter options',
    'status.loading': 'Loading options…',
    'status.applying': 'Applying…',
    'status.empty': 'No options',
    'overlay.aria': '/{command} options',
    'listbox.aria': '/{command} matches',
    'notice.imagesUnsupported': '/{command} does not accept image attachments; remove them first',
};

}
};
const __dependencies = {"src/modules/commands/index.js":{"./service":"src/modules/commands/service.js","./PopupSelectView":"src/modules/commands/PopupSelectView.js","./locales":"src/modules/commands/locales.js","./directory":"src/modules/commands/directory.js","./popup":"src/modules/commands/popup.js"},"src/modules/commands/service.js":{"./core-context":"src/modules/commands/core-context.js","./directory":"src/modules/commands/directory.js","./popup":"src/modules/commands/popup.js"},"src/modules/commands/core-context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/commands/directory.js":{},"src/modules/commands/popup.js":{},"src/modules/commands/PopupSelectView.js":{"../views-types":"src/modules/views-types.js","./popup":"src/modules/commands/popup.js","./PopupSelectView.styles":"src/modules/commands/PopupSelectView.styles.js"},"src/modules/views-types.js":{},"src/modules/commands/PopupSelectView.styles.js":{"./PopupSelectView.css":"src/modules/commands/PopupSelectView.css","../views-types":"src/modules/views-types.js"},"src/modules/commands/PopupSelectView.css":{},"src/modules/commands/locales.js":{}};
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
return __load("src/modules/commands/index.js");
}
});
