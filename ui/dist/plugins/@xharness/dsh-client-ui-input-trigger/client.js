// Generated from src/modules/input-trigger/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-input-trigger",
factory: (__externalRequire) => {
const __units = {
"src/modules/input-trigger/index.js": function(module, exports, require) {
// source: src/modules/input-trigger/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.InputTriggerController = exports.InputTriggerService = void 0;
exports.apply = apply;
const service_1 = require("./service");
const MenuView_1 = require("./MenuView");
const locales_1 = require("./locales");
var service_2 = require("./service");
Object.defineProperty(exports, "InputTriggerService", { enumerable: true, get: function () { return service_2.InputTriggerService; } });
var controller_1 = require("./controller");
Object.defineProperty(exports, "InputTriggerController", { enumerable: true, get: function () { return controller_1.InputTriggerController; } });
/** Namespace owning the candidate-menu copy. */
const MENU_NS = 'slash.menu';
/** Required services: controller resolution reads the session scope tree; the menu copy is localized. */
exports.inject = ['sessions', 'locale'];
/**
 * Client plugin body: mount the service, then register MenuView into the
 * input overlay once its declarer is up.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.plugin(service_1.InputTriggerService);
    ctx.effect(() => ctx.locale.register(MENU_NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-input-trigger: menu dictionaries');
    ctx.inject(['slots', 'inputTriggers', 'sessions'], (scope) => {
        const inputTriggers = scope.inputTriggers;
        const sessions = scope.sessions;
        scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
            name: 'conversation.input.overlay',
            id: 'slash-menu',
            order: 0,
            locale: MENU_NS,
            inject: (sessionId) => {
                // Session-scoped slot: resolve this session's controller (the slot
                // frame hands ids, not ctx — the registered id→ctx interchange).
                const actx = sessions.scope(sessionId);
                if (actx === undefined)
                    throw new Error(`ui-input-trigger: session "${String(sessionId)}" resolved no scope`);
                const controller = inputTriggers.sessionOf(actx);
                return {
                    menu: controller.menu,
                    onPick: (source, index) => { controller.pick(source, index); },
                    onDismiss: () => { controller.dismiss(); },
                };
            },
        }, MenuView_1.MenuView));
    });
}

},
"src/modules/input-trigger/service.js": function(module, exports, require) {
// source: src/modules/input-trigger/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputTriggerService = void 0;
const core_context_1 = require("./core-context");
/**
 * InputTriggerService (`ctx.inputTriggers`): the root half of the trigger pipeline — the
 * stateless source registry plus the per-session controller map. Every piece
 * of mutable interaction state (hit, menu, fetch) lives on the
 * {@link InputTriggerController}; the service only registers sources, resolves
 * controllers by session scope, and relays roster changes.
 */
const cordis_1 = require("@xharness/cordis");
const controller_1 = require("./controller");
const Service = cordis_1.Service;
/** The `ctx.inputTriggers` trigger pipeline service (root registry + controller resolution). */
class InputTriggerService extends Service {
    /**
     * @param ctx - owning root context (the service registers itself as `slash`).
     */
    constructor(ctx) {
        super((0, core_context_1.requireCoreContext)(ctx), 'inputTriggers');
        this.live = { sources: [], controllers: new Map() };
    }
    /**
     * Register one trigger source. Live session controllers are notified so a
     * source arriving after scope birth still warms and joins the lexicon.
     * @param src - the source; (trigger, name) must be unique — duplicates throw.
     * @returns the disposer (callers wrap registration in ctx.effect). Disposal
     * while a controller shows the source's menu group drops that group.
     */
    registerSource(src) {
        const { live } = this;
        if (live.sources.some(s => s.trigger === src.trigger && s.name === src.name)) {
            throw new Error(`slash source "${src.trigger}${src.name}" is already registered`);
        }
        live.sources.push(src);
        for (const controller of live.controllers.values()) {
            try {
                controller.sourceAdded(src);
            }
            catch (error) {
                // Contain faulty source callbacks (warm/subscribeLexicon): the
                // registration must stand with a usable disposer and the remaining
                // controllers must still be notified.
                console.error(`[ui-input-trigger] source "${src.trigger}${src.name}" late-registration setup failed:`, error);
            }
        }
        return () => {
            const at = live.sources.indexOf(src);
            if (at < 0)
                return;
            live.sources.splice(at, 1);
            for (const controller of live.controllers.values())
                controller.sourceRemoved(src);
        };
    }
    /**
     * Resolve the per-session controller for one session scope (lazy; the
     * scope disposer removes and disposes it). Construction warms the source
     * roster once — sessions are always agent-backed, so scope birth is the
     * single prewarm moment.
     * @param actx - session-scope ctx.
     * @returns the resident controller.
     */
    sessionOf(actx) {
        const sessions = this.sessions();
        const id = sessions.scopeOf(actx);
        if (id === undefined)
            throw new Error('slash.sessionOf requires a session scope');
        const { live } = this;
        const existing = live.controllers.get(id);
        if (existing !== undefined)
            return existing;
        const controller = new controller_1.InputTriggerController({
            actx,
            sessionId: id,
            roster: {
                sources: trigger => live.sources.filter(s => s.trigger === trigger).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
                all: () => live.sources,
            },
        });
        live.controllers.set(id, controller);
        actx.effect(() => () => {
            controller.dispose();
            live.controllers.delete(id);
        }, 'slash: session controller');
        return controller;
    }
    sessions() {
        const sessions = this.ctx.get('sessions');
        if (!(0, core_context_1.isSessions)(sessions))
            throw new Error('ui-input-trigger: sessions service unavailable');
        return sessions;
    }
}
exports.InputTriggerService = InputTriggerService;
InputTriggerService.inject = ['sessions'];

},
"src/modules/input-trigger/core-context.js": function(module, exports, require) {
// source: src/modules/input-trigger/core-context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCoreContext = requireCoreContext;
exports.isSessions = isSessions;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
function requireCoreContext(value) {
    if (!cordis_1.Context.is(value))
        throw new Error('input triggers require a Cordis Context');
    return value;
}
/** Scope providers are registered runtime services, not unvalidated wire payloads. */
function isSessions(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.scope === 'function' && typeof value.scopeOf === 'function';
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
"src/modules/input-trigger/controller.js": function(module, exports, require) {
// source: src/modules/input-trigger/controller.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputTriggerController = void 0;
const client_1 = require("@xharness/dsh-client-runtime/client");
const detect_1 = require("./core/detect");
const menu_1 = require("./core/menu");
/**
 * Per-session trigger pipeline state and orchestration. All mutation stays
 * inside; MenuView renders from {@link InputTriggerController.menu} and routes
 * pointer picks back through {@link InputTriggerController.pick}.
 */
class InputTriggerController {
    constructor(deps) {
        this.deps = deps;
        /** Menu state store (per-session; survives session switches, dies with the scope). */
        this.menu = (0, client_1.createSnapshotStore)(menu_1.MENU_CLOSED);
        /**
         * Name of the source opened through the programmatic launcher, or null for
         * trigger-detected/closed menus. Composer chrome subscribes to this store
         * for the launcher's expanded state without owning a second menu model.
         */
        this.launcher = (0, client_1.createSnapshotStore)(null);
        /**
         * Aggregated hot reference lexicon, grouped by trigger (plain-text-reference decision;
         * see .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
         * sources implementing the lexicon hook are polled with the session
         * projection; undefined answers (roll not hot yet) are skipped; multiple
         * sources on one trigger concatenate in registration order. A snapshot
         * store because rolls change asynchronously (catalog settles, children
         * spawn/exit) — render-side consumers subscribe instead of re-reading a
         * mutable answer.
         */
        this.lexicon = (0, client_1.createSnapshotStore)(new Map());
        /** The authoritative hit: single truth for span CAS material (menu snapshot never carries it alone). */
        this.hit = null;
        this.fetch = null;
        this.disposed = false;
        /** Per-source lexicon unsubscribers (sources without the hook never enter). */
        this.lexiconOffs = new Map();
        // Scope-birth prewarm: sessions are always agent-backed, so the one-time
        // roster warm here replaces the projection-transition watch — there are
        // no capability steps to react to.
        const projection = this.project();
        for (const src of deps.roster.all()) {
            src.warm?.(projection);
            this.watchLexicon(src, projection);
        }
        this.refreshLexicon();
    }
    /**
     * Feed a draft/caret change through trigger detection and drive the menu.
     * @param draft - full draft text.
     * @param caret - caret offset into `draft`.
     * @param guard - availability tier derived from the input phase.
     * @param draftRev - the input machine's current draft revision, stamped
     * into the hit span for pick-time CAS.
     */
    track(draft, caret, guard, draftRev) {
        if (this.disposed)
            return;
        const launched = this.launcher.getSnapshot() !== null;
        this.clearLauncher();
        const raw = (0, detect_1.detectTrigger)(draft, caret, guard);
        if (raw === null) {
            this.hit = null;
            this.stopFetch();
            this.reduce({ type: 'close' });
            return;
        }
        const hit = { ...raw, span: { ...raw.span, draftRev } };
        const prev = this.menu.getSnapshot();
        const same = !launched && prev.open && prev.hit !== null
            && prev.hit.trigger === hit.trigger && prev.hit.query === hit.query
            && prev.hit.quoted === hit.quoted
            && prev.hit.span.start === hit.span.start && prev.hit.span.end === hit.span.end;
        this.hit = hit;
        if (same)
            return;
        const roster = this.deps.roster.sources(hit.trigger);
        if (roster.length === 0) {
            this.stopFetch();
            this.reduce({ type: 'close' });
            return;
        }
        if (launched || !prev.open || prev.hit === null || prev.hit.trigger !== hit.trigger) {
            this.menu.set((0, menu_1.seedGroups)(this.menu.getSnapshot(), roster));
        }
        this.reduce({ type: 'hit', hit });
        this.fetchCandidates(hit, roster);
    }
    /**
     * Toggle a menu containing exactly one registered source. The supplied hit
     * is a synthetic selection span rather than a typed trigger token, but
     * picks deliberately reuse the ordinary source callback and scoped input
     * mutation pipeline.
     * @param source - registered source name under `hit.trigger`.
     * @param hit - synthetic hit carrying position and pick-time draft CAS.
     */
    toggleSource(source, hit) {
        if (this.disposed)
            return;
        if (this.launcher.getSnapshot() === source && this.menu.getSnapshot().open) {
            this.dismiss();
            return;
        }
        const match = this.deps.roster.sources(hit.trigger).find(item => item.name === source);
        if (match === undefined) {
            this.dismiss();
            return;
        }
        this.stopFetch();
        this.hit = hit;
        this.launcher.set(source);
        this.menu.set((0, menu_1.seedGroups)(this.menu.getSnapshot(), [match]));
        this.reduce({ type: 'hit', hit });
        this.fetchCandidates(hit, [match]);
    }
    /**
     * Pointer pick from MenuView: route the clicked candidate through onPick
     * and execute claim/insert outcomes via the scoped input events.
     * @param source - source (group) name.
     * @param index - candidate index within the group.
     */
    pick(source, index) {
        const state = this.menu.getSnapshot();
        const hit = this.hit;
        if (this.disposed || !state.open || hit === null)
            return;
        const group = state.groups.find(g => g.source === source);
        const candidate = group !== undefined && group.status === 'ready' ? group.items[index] : undefined;
        if (candidate === undefined)
            return;
        const src = this.deps.roster.sources(hit.trigger).find(s => s.name === source);
        if (src === undefined)
            return;
        const outcome = src.onPick({
            candidate,
            session: this.project(),
            position: hit.position,
            via: 'menu',
            span: hit.span,
        });
        this.stopFetch();
        this.reduce({ type: 'close' });
        this.execute(outcome, hit.span);
    }
    /**
     * Keyboard arbitration while the menu is open.
     * @param key - intercepted key.
     * @param composing - inside IME composition: everything passes.
     * @returns consumed / pick-highlighted / pass.
     */
    arbitrate(key, composing) {
        if (composing || this.disposed)
            return 'pass';
        const state = this.menu.getSnapshot();
        if (!state.open)
            return 'pass';
        switch (key) {
            case 'up': {
                this.reduce({ type: 'move', dir: -1 });
                return 'consumed';
            }
            case 'down': {
                this.reduce({ type: 'move', dir: 1 });
                return 'consumed';
            }
            case 'escape': {
                this.stopFetch();
                this.reduce({ type: 'close' });
                return 'consumed';
            }
            case 'enter': {
                if (state.highlight === null)
                    return 'pass';
                this.pick(state.highlight.source, state.highlight.index);
                return 'pick-highlighted';
            }
        }
    }
    /**
     * Space adjudication over the just-completed leading token: polls sources'
     * matchSpace (hot state, synchronous) and dispatches the outcome itself.
     * @returns true when a claim/insert was actually applied by the input —
     * the caller preventDefaults exactly then.
     */
    onSpace() {
        const hit = this.hit;
        if (this.disposed || hit === null || hit.position !== 'leading')
            return false;
        const token = hit.trigger + hit.query;
        const projection = this.project();
        for (const src of this.deps.roster.sources(hit.trigger)) {
            if (src.matchSpace === undefined)
                continue;
            const outcome = src.matchSpace(projection, token);
            if (outcome === undefined)
                continue;
            if (outcome === 'handled')
                return true;
            return this.execute(outcome, hit.span);
        }
        return false;
    }
    /**
     * Serialize one reference occurrence to its model form via the owning
     * source's codec (prompt serialization: registry → explicit
     * call → await). Owner missing or codec-less rejects — the submit attempt
     * blocks instead of silently downgrading to the clipboard text.
     * @param source - owning source name.
     * @param ref - owner-scoped reference id.
     * @param signal - the submit attempt's abort signal.
     * @returns the model representation (e.g. `<skill>name</skill>`).
     */
    serializeReference(source, ref, signal) {
        const owner = this.deps.roster.all().find(s => s.name === source);
        if (owner?.codec === undefined) {
            return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`));
        }
        return owner.codec.serialize(ref, signal);
    }
    /**
     * Enter last adjudication: polls sources' matchEnter in registration
     * order, first non-undefined wins. The outcome returns to the caller (the
     * input machine applies it inside the same submit attempt — no event).
     * @param line - trimmed draft; the leading char selects the trigger roster.
     * @param signal - attempt-scoped abort from the input machine.
     * @param envelope - non-text submission state accompanying the draft.
     * @returns the winning outcome or undefined (default sink). Rejects when a
     * polled source's warmup fails or the winning source refuses the envelope —
     * the caller must not silently downgrade.
     */
    async adjudicate(line, signal, envelope) {
        const projection = this.project();
        for (const src of this.deps.roster.all()) {
            if (signal.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('slash adjudication aborted');
            }
            if (src.matchEnter === undefined || !line.startsWith(src.trigger))
                continue;
            const outcome = await src.matchEnter(projection, line, signal, envelope);
            if (outcome !== undefined)
                return outcome;
        }
        return undefined;
    }
    /**
     * Drop the menu group of a disposed source (root registry change notification).
     * @param source - the source whose registration was disposed.
     */
    sourceRemoved(source) {
        const state = this.menu.getSnapshot();
        if (state.open && state.hit !== null && state.hit.trigger === source.trigger) {
            this.reduce({ type: 'source-failed', generation: state.generation, source: source.name });
        }
        this.lexiconOffs.get(source)?.();
        this.lexiconOffs.delete(source);
        this.refreshLexicon();
    }
    /**
     * Admit a source registered after this controller's birth (root registry
     * change notification): warm it and fold its roll into the live lexicon —
     * the constructor-time prewarm covers only the roster present at scope
     * birth.
     * @param source - the newly registered source.
     */
    sourceAdded(source) {
        const projection = this.project();
        source.warm?.(projection);
        this.watchLexicon(source, projection);
        this.refreshLexicon();
    }
    /** External dismiss (e.g. pointer outside the composer area). */
    dismiss() {
        if (this.disposed)
            return;
        this.stopFetch();
        this.reduce({ type: 'close' });
    }
    /** Scope teardown: close and abort (the service deletes the map entry). */
    dispose() {
        this.disposed = true;
        this.stopFetch();
        this.reduce({ type: 'close' });
        this.hit = null;
        for (const off of this.lexiconOffs.values())
            off();
        this.lexiconOffs.clear();
    }
    /** The session projection handed to sources (agent-backed identity; constant per scope). */
    project() {
        return { sessionId: this.deps.sessionId };
    }
    /** Execute a claim/insert/text outcome via the scoped input events (actx as dispatch subject); true = the input applied it. */
    execute(outcome, span) {
        const { actx } = this.deps;
        if (outcome === undefined || outcome === 'handled')
            return false;
        if ('claim' in outcome) {
            return actx.bail(actx, 'slash/input-begin-command', { claim: outcome.claim, span }) === true;
        }
        if ('text' in outcome) {
            return actx.bail(actx, 'slash/input-insert-text', {
                text: outcome.text,
                span,
                ...outcome.continue === true ? { continue: true } : {},
            }) === true;
        }
        return actx.bail(actx, 'slash/input-insert-reference', { reference: outcome.insert, span }) === true;
    }
    /** Re-poll every lexicon-bearing source and publish the aggregated rolls (see the store doc). */
    refreshLexicon() {
        const projection = this.project();
        const rolls = new Map();
        for (const src of this.deps.roster.all()) {
            if (src.lexicon === undefined)
                continue;
            let names;
            try {
                names = src.lexicon(projection);
            }
            catch (error) {
                // A faulty source drops silently with a console record (the
                // candidate-fetch failure policy); the refresh runs inside
                // notification callbacks, where a throw would starve other consumers.
                console.error(`[ui-input-trigger] source "${src.name}" lexicon failed:`, error);
                continue;
            }
            if (names === undefined)
                continue;
            const prev = rolls.get(src.trigger);
            rolls.set(src.trigger, prev === undefined ? names : [...prev, ...names]);
        }
        this.lexicon.set(rolls);
    }
    /** Wire one source's lexicon invalidation channel into refresh (hookless or roll-less sources never notify). */
    watchLexicon(source, projection) {
        if (source.lexicon === undefined || source.subscribeLexicon === undefined)
            return;
        this.lexiconOffs.set(source, source.subscribeLexicon(projection, () => { this.refreshLexicon(); }));
    }
    /** Launch the candidate fetch for one hit generation, superseding the previous one. */
    fetchCandidates(hit, roster) {
        this.stopFetch();
        const controller = new AbortController();
        this.fetch = controller;
        const generation = this.menu.getSnapshot().generation;
        const projection = this.project();
        for (const source of roster) {
            void source
                .candidates(projection, {
                query: hit.query,
                quoted: hit.quoted,
                position: hit.position,
                signal: controller.signal,
            })
                .then((items) => {
                if (controller.signal.aborted)
                    return;
                this.reduce({ type: 'source-settled', generation, source: source.name, items });
            }, (error) => {
                if (controller.signal.aborted)
                    return;
                console.error(`[ui-input-trigger] source "${source.name}" candidates failed:`, error);
                this.reduce({ type: 'source-failed', generation, source: source.name });
            });
        }
    }
    stopFetch() {
        this.fetch?.abort();
        this.fetch = null;
    }
    clearLauncher() {
        if (this.launcher.getSnapshot() !== null)
            this.launcher.set(null);
    }
    reduce(ev) {
        const cur = this.menu.getSnapshot();
        const next = (0, menu_1.menuReduce)(cur, ev);
        if (next !== cur)
            this.menu.set(next);
        if (!next.open)
            this.clearLauncher();
    }
}
exports.InputTriggerController = InputTriggerController;

},
"src/modules/input-trigger/core/detect.js": function(module, exports, require) {
// source: src/modules/input-trigger/core/detect.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectTrigger = void 0;
/**
 * Trigger detection pure core. Scans backward from
 * the caret for a live trigger char under the guard tier and applies the
 * word-boundary rules. Zero React / DOM / cordis.
 */
const file_reference_grammar_1 = require("../../shared/file-reference-grammar");
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;
/**
 * Word-boundary rule: a trigger char opens only at start-of-draft, after
 * whitespace (newlines included), or after punctuation. Two URL carve-outs
 * keep '/' dead inside URLs (both pinned by tests): '/' after a ':' that
 * itself follows a non-whitespace char (scheme separator, `https:/…`), and
 * '/' directly after another '/' (second slash of `//`).
 */
function boundaryOk(draft, index, char) {
    if (index === 0)
        return true;
    const prev = draft.charAt(index - 1);
    if (WHITESPACE.test(prev))
        return true;
    if (WORD_CHAR.test(prev))
        return false;
    if (char === '/') {
        if (prev === '/')
            return false;
        if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2)))
            return false;
    }
    return true;
}
/**
 * Detect a trigger token at the caret. `@` first uses the shared grammar,
 * including an open quoted token that may span whitespace. Slash detection
 * scans left to the first whitespace; slashes failing the word boundary are
 * treated as ordinary token chars and the scan continues (URL slashes).
 * Guard tiers: plain = both chars live; claimed = '/' fully suppressed,
 * '@' live; frozen = none.
 *
 * @param draft - Full draft text.
 * @param caret - Caret offset into `draft`.
 * @param guard - Availability tier derived from the input phase.
 * @returns The hit with `query` = trigger-to-caret slice and `span` =
 * `{start: triggerIndex, end: caret}`; `span.draftRev` is a placeholder `0`
 * — the calling shell stamps the real revision. Null when no trigger is
 * live at the caret.
 */
const detectTrigger = (draft, caret, guard) => {
    if (guard.tier === 'frozen')
        return null;
    const at = (0, file_reference_grammar_1.activeAtToken)(draft, caret);
    if (at !== undefined) {
        const start = caret - at.prefix.length;
        return {
            trigger: '@',
            query: at.query,
            quoted: at.quoted,
            position: draft.search(/\S/) === start ? 'leading' : 'inline',
            span: { start, end: caret, draftRev: 0 },
        };
    }
    for (let i = caret - 1; i >= 0; i--) {
        const ch = draft.charAt(i);
        if (WHITESPACE.test(ch))
            return null;
        if (ch !== '/')
            continue;
        if (guard.tier === 'claimed')
            continue;
        if (!boundaryOk(draft, i, ch))
            continue;
        return {
            trigger: ch,
            query: draft.slice(i + 1, caret),
            quoted: false,
            position: draft.search(/\S/) === i ? 'leading' : 'inline',
            span: { start: i, end: caret, draftRev: 0 },
        };
    }
    return null;
};
exports.detectTrigger = detectTrigger;

},
"src/modules/shared/file-reference-grammar.js": function(module, exports, require) {
// source: src/modules/shared/file-reference-grammar.ts

"use strict";
/**
 * Browser-safe `@file` token grammar shared by terminal and web clients.
 *
 * @module @xharness/dsh-file-reference/grammar
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeAtToken = activeAtToken;
exports.formatFileMention = formatFileMention;
/**
 * Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
 * inside another token, such as an email address, is not a completion trigger.
 * @param line - current editor line.
 * @param cursorCol - cursor column within that line.
 * @returns the active token, or `undefined` outside an `@` token.
 */
function activeAtToken(line, cursorCol) {
    const beforeCursor = line.slice(0, cursorCol);
    const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
    if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
        return { prefix: quoted[1], query: quoted[2], quoted: true };
    }
    const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
    if (plain?.[1] === undefined || plain[2] === undefined)
        return undefined;
    return { prefix: plain[1], query: plain[2], quoted: false };
}
/**
 * Format a selected path as prompt text. Whitespace uses the quoted
 * `@"path"` grammar; a quoted directory keeps that quote open after its
 * trailing slash so completion can descend another level.
 * @param candidate - selected file or directory.
 * @param preserveQuote - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
 */
function formatFileMention(candidate, preserveQuote) {
    const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path))
        return undefined;
    const quoted = preserveQuote || /\s/u.test(path);
    if (!quoted)
        return `@${path}`;
    if (candidate.kind === 'directory')
        return `@"${path}`;
    return `@"${path}"`;
}

},
"src/modules/input-trigger/core/menu.js": function(module, exports, require) {
// source: src/modules/input-trigger/core/menu.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exactMatch = exports.menuReduce = exports.MENU_CLOSED = void 0;
exports.seedGroups = seedGroups;
/** Closed rest state with generation 0; store initializer and test seed. */
exports.MENU_CLOSED = { open: false, hit: null, generation: 0, groups: [], highlight: null };
/**
 * Replace the group roster with pending groups for `sources`, in order.
 * Shell-side step before dispatching `hit` on a fresh menu open.
 *
 * @param state - Current menu state.
 * @param sources - Sources registered for the hit trigger, in menu order.
 * @returns State carrying the new pending roster; highlight cleared.
 */
function seedGroups(state, sources) {
    return {
        ...state,
        groups: sources.map(source => ({
            source: source.name,
            ...(source.showGroupTitle === false ? { showGroupTitle: false } : {}),
            status: 'pending',
            items: [],
        })),
        highlight: null,
    };
}
/** Close, preserving the generation so in-flight settlements stay droppable. */
const closed = (state) => state.open || state.hit !== null || state.groups.length > 0 || state.highlight !== null
    ? { open: false, hit: null, generation: state.generation, groups: [], highlight: null }
    : state;
/** First item of the first non-empty ready group, or null. */
function firstHighlight(groups) {
    for (const g of groups) {
        if (g.status === 'ready' && g.items.length > 0)
            return { source: g.source, index: 0 };
    }
    return null;
}
/** The highlight itself when it still points at a ready item, else null. */
function validHighlight(highlight, groups) {
    if (!highlight)
        return null;
    const g = groups.find(x => x.source === highlight.source);
    return g && g.status === 'ready' && highlight.index < g.items.length ? highlight : null;
}
/** Flatten ready items into (source, index) positions in group order. */
function positions(groups) {
    const out = [];
    for (const g of groups) {
        if (g.status !== 'ready')
            continue;
        for (let i = 0; i < g.items.length; i++)
            out.push({ source: g.source, index: i });
    }
    return out;
}
/** True when every group is ready with zero items (the auto-close condition). */
const allReadyEmpty = (groups) => groups.every(g => g.status === 'ready' && g.items.length === 0);
/**
 * Pure menu reducer. `hit` opens a new generation over the seeded roster
 * (null hit closes); `source-settled` outside the current generation, the
 * open menu, or the roster is dropped; a settlement or failure leaving every
 * group ready-and-empty (or no groups) auto-closes; `source-failed` silently
 * removes the group (the shell logs); `move` cycles the highlight across
 * ready items.
 *
 * @param state - Current menu state.
 * @param ev - Menu event.
 * @returns Next state; the same reference when stale or a no-op.
 */
const menuReduce = (state, ev) => {
    switch (ev.type) {
        case 'hit': {
            if (ev.hit === null)
                return closed(state);
            return {
                open: true,
                hit: ev.hit,
                generation: state.generation + 1,
                groups: state.groups.map(g => ({ ...g, status: 'pending', items: [] })),
                highlight: null,
            };
        }
        case 'source-settled': {
            if (!state.open || ev.generation !== state.generation)
                return state;
            const idx = state.groups.findIndex(g => g.source === ev.source);
            if (idx < 0)
                return state;
            const items = ev.items ?? [];
            const groups = state.groups.map((g, i) => i === idx ? { ...g, status: 'ready', items } : g);
            if (allReadyEmpty(groups))
                return closed(state);
            const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);
            return { ...state, groups, highlight };
        }
        case 'source-failed': {
            if (!state.open || ev.generation !== state.generation)
                return state;
            if (!state.groups.some(g => g.source === ev.source))
                return state;
            const groups = state.groups.filter(g => g.source !== ev.source);
            if (groups.length === 0 || allReadyEmpty(groups))
                return closed(state);
            const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);
            return { ...state, groups, highlight };
        }
        case 'move': {
            if (!state.open)
                return state;
            const pos = positions(state.groups);
            if (pos.length === 0)
                return state;
            const hl = state.highlight;
            const at = hl ? pos.findIndex(p => p.source === hl.source && p.index === hl.index) : -1;
            const next = pos[at < 0
                ? (ev.dir === 1 ? 0 : pos.length - 1)
                : (at + ev.dir + pos.length) % pos.length];
            if (next === undefined)
                return state;
            if (hl && next.source === hl.source && next.index === hl.index)
                return state;
            return { ...state, highlight: next };
        }
        case 'close':
            return closed(state);
    }
};
exports.menuReduce = menuReduce;
/**
 * Exact-name lookup in one source's ready group.
 *
 * @param groups - Menu groups.
 * @param source - Source (group) name.
 * @param name - Candidate name to match exactly.
 * @returns The candidate, or null when the group is absent, not ready, or
 * has no candidate of that name.
 */
const exactMatch = (groups, source, name) => {
    const group = groups.find(g => g.source === source);
    if (!group || group.status !== 'ready')
        return null;
    return group.items.find(c => c.name === name) ?? null;
};
exports.exactMatch = exactMatch;

},
"src/modules/input-trigger/MenuView.js": function(module, exports, require) {
// source: src/modules/input-trigger/MenuView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MenuView = MenuView;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized title
 * rows, pending groups as a loading row; pointer picks route back through
 * the service (combobox pattern — focus never leaves the textarea, so rows
 * are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the listbox).
 */
const react_1 = require("react");
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const MenuView_styles_1 = __importDefault(require("./MenuView.styles"));
/** Design cap on the list height (figma SLASH 39:26572 MenuDropdown). */
const MAX_HEIGHT = 320;
/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source, index) {
    return `dsh-slash-option-${source}-${index}`;
}
/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
function MenuView({ menu, onPick, onDismiss, t }) {
    const state = (0, react_1.useSyncExternalStore)(fn => menu.subscribe(fn), () => menu.getSnapshot());
    const listRef = (0, react_1.useRef)(null);
    // The list is bottom-anchored above the composer; clamp the design cap to
    // the space above it, re-measured on every store update (the anchor moves
    // when the composer grows).
    const maxHeight = (0, dsh_client_ui_primitives_1.useAnchoredMaxHeight)(listRef, MAX_HEIGHT, state);
    const highlight = state.open ? state.highlight : null;
    // Focus stays in the textarea (combobox pattern), so the browser never
    // scrolls the active option into view on keyboard moves — do it here.
    (0, react_1.useEffect)(() => {
        if (highlight === null)
            return;
        document.getElementById(optionId(highlight.source, highlight.index))
            ?.scrollIntoView({ block: 'nearest' });
    }, [highlight]);
    // Dismiss on pointer outside the menu AND outside the composer card
    // (clicking the textarea or bottom bar must not close the menu).
    (0, react_1.useEffect)(() => {
        if (!state.open)
            return;
        const onPointerDown = (ev) => {
            if (!(ev.target instanceof Node))
                return;
            if (listRef.current?.contains(ev.target))
                return;
            const composerCard = listRef.current?.closest('[data-composer-card]');
            if (composerCard?.contains(ev.target))
                return;
            onDismiss();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => { document.removeEventListener('pointerdown', onPointerDown, true); };
    }, [state.open, onDismiss]);
    if (!state.open)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { ref: listRef, className: MenuView_styles_1.default.menu, style: { maxHeight }, role: "listbox", "aria-label": t('suggestions.aria'), "aria-activedescendant": highlight !== null ? optionId(highlight.source, highlight.index) : undefined, children: (0, jsx_runtime_1.jsx)("div", { className: MenuView_styles_1.default.viewport, children: state.groups.map(group => (group.status === 'ready' && group.items.length === 0)
                ? null
                : ((0, jsx_runtime_1.jsxs)(react_1.Fragment, { children: [group.showGroupTitle === false || group.items.some(item => item.section !== undefined)
                            ? null
                            : (0, jsx_runtime_1.jsx)("div", { className: MenuView_styles_1.default.groupTitle, role: "presentation", "data-source": group.source, children: t(group.source) }), group.status === 'pending'
                            ? (0, jsx_runtime_1.jsx)("div", { className: MenuView_styles_1.default.loading, "data-source": group.source, children: t('loading') })
                            : group.items.map((item, index) => {
                                const active = highlight !== null && highlight.source === group.source && highlight.index === index;
                                return ((0, jsx_runtime_1.jsxs)(react_1.Fragment, { children: [item.section !== undefined && item.section !== group.items[index - 1]?.section
                                            ? (0, jsx_runtime_1.jsx)("div", { className: MenuView_styles_1.default.sectionTitle, role: "presentation", children: item.section })
                                            : null, (0, jsx_runtime_1.jsxs)("button", { id: optionId(group.source, index), type: "button", role: "option", "aria-selected": active, className: (0, views_types_1.classNames)(MenuView_styles_1.default.item, active && MenuView_styles_1.default.active),
                                            // mousedown, not click: the textarea keeps focus (combobox
                                            // pattern) — preventing default stops the focus steal, and the
                                            // pick runs before any blur-driven teardown.
                                            onMouseDown: (ev) => {
                                                ev.preventDefault();
                                                onPick(group.source, index);
                                            }, children: [item.icon !== undefined && (0, jsx_runtime_1.jsx)("span", { className: MenuView_styles_1.default.itemIcon, "aria-hidden": true, children: item.icon }), (0, jsx_runtime_1.jsx)("span", { className: MenuView_styles_1.default.itemName, children: item.name }), item.description !== undefined && (0, jsx_runtime_1.jsx)("span", { className: MenuView_styles_1.default.itemDescription, children: item.description })] })] }, optionId(group.source, index)));
                            })] }, group.source))) }) }));
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
"src/modules/input-trigger/MenuView.styles.js": function(module, exports, require) {
// source: src/modules/input-trigger/MenuView.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MenuView_css_1 = __importDefault(require("./MenuView.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-input-trigger/MenuView.module.css", "@xharness/dsh-client-ui-input-trigger", MenuView_css_1.default);
const styles = {
    "active": "Q7Z8tG_active",
    "groupTitle": "Q7Z8tG_groupTitle",
    "item": "Q7Z8tG_item",
    "itemDescription": "Q7Z8tG_itemDescription",
    "itemIcon": "Q7Z8tG_itemIcon",
    "itemName": "Q7Z8tG_itemName",
    "loading": "Q7Z8tG_loading",
    "menu": "Q7Z8tG_menu",
    "sectionTitle": "Q7Z8tG_sectionTitle",
    "viewport": "Q7Z8tG_viewport"
};
exports.default = styles;

},
"src/modules/input-trigger/MenuView.css": function(module, exports, require) {
// source: src/modules/input-trigger/MenuView.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Q7Z8tG_menu{z-index:100;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);min-width:min(260px,100%);max-width:min(537px,100%);max-height:320px;box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 4px);left:0;overflow:hidden}.Q7Z8tG_viewport{flex-direction:column;min-height:0;display:flex;overflow-y:auto}.Q7Z8tG_item{cursor:pointer;width:100%;min-height:40px;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:8px 10px;font-size:14px;line-height:22px;display:flex}.Q7Z8tG_item:hover,.Q7Z8tG_item.Q7Z8tG_active{background:var(--dsw-alias-interactive-bg-hover)}.Q7Z8tG_sectionTitle{min-height:26px;color:var(--dsw-alias-label-tertiary);flex:none;padding:6px 10px 2px;font-size:12px;font-weight:500;line-height:18px}.Q7Z8tG_sectionTitle:not(:first-child){margin-top:4px}.Q7Z8tG_itemIcon{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.Q7Z8tG_itemName{text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:40%;overflow:hidden}.Q7Z8tG_itemDescription{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;overflow:hidden}.Q7Z8tG_groupTitle{color:var(--dsw-alias-label-tertiary);padding:8px 10px;font-size:12px;line-height:16px}.Q7Z8tG_loading{min-height:40px;color:var(--dsw-alias-label-dimmed);align-items:center;padding:8px 10px;font-size:14px;line-height:22px;display:flex}\n";

},
"src/modules/input-trigger/locales.js": function(module, exports, require) {
// source: src/modules/input-trigger/locales.ts

"use strict";
/**
 * `slash.menu` namespace dictionaries: group titles keyed by source name
 * (the lookup chain returns the key itself, so an unknown source shows its
 * raw name), the pending row, and the listbox aria label.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'command': '命令',
    'skill': '技能',
    'subagent': '子智能体',
    'loading': '正在加载…',
    'suggestions.aria': '触发候选建议',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'command': 'Commands',
    'skill': 'Skills',
    'subagent': 'Subagents',
    'loading': 'Loading…',
    'suggestions.aria': 'Trigger suggestions',
};

}
};
const __dependencies = {"src/modules/input-trigger/index.js":{"./service":"src/modules/input-trigger/service.js","./MenuView":"src/modules/input-trigger/MenuView.js","./locales":"src/modules/input-trigger/locales.js","./controller":"src/modules/input-trigger/controller.js"},"src/modules/input-trigger/service.js":{"./core-context":"src/modules/input-trigger/core-context.js","./controller":"src/modules/input-trigger/controller.js"},"src/modules/input-trigger/core-context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/input-trigger/controller.js":{"./core/detect":"src/modules/input-trigger/core/detect.js","./core/menu":"src/modules/input-trigger/core/menu.js"},"src/modules/input-trigger/core/detect.js":{"../../shared/file-reference-grammar":"src/modules/shared/file-reference-grammar.js"},"src/modules/shared/file-reference-grammar.js":{},"src/modules/input-trigger/core/menu.js":{},"src/modules/input-trigger/MenuView.js":{"../views-types":"src/modules/views-types.js","./MenuView.styles":"src/modules/input-trigger/MenuView.styles.js"},"src/modules/views-types.js":{},"src/modules/input-trigger/MenuView.styles.js":{"./MenuView.css":"src/modules/input-trigger/MenuView.css","../views-types":"src/modules/views-types.js"},"src/modules/input-trigger/MenuView.css":{},"src/modules/input-trigger/locales.js":{}};
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
return __load("src/modules/input-trigger/index.js");
}
});
