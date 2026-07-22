// Generated from src/modules/message-feedback/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-message-feedback",
factory: (__externalRequire) => {
const __units = {
"src/modules/message-feedback/index.js": function(module, exports, require) {
// source: src/modules/message-feedback/index.ts

"use strict";
/**
 * Message feedback plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip. One MessageFeedbackController per
 * Session backs every message control in that Session, so a single list read
 * seeds the whole transcript. Mutations go through the generated
 * messageFeedback Remote; the Host owns per-item compare-and-set.
 * @module @xharness/dsh-client-ui-message-feedback/client
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions entry).
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
const controller_1 = require("./controller");
const MessageFeedbackActions_1 = require("./MessageFeedbackActions");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin. */
const NS = 'feedback';
/** Required services: the slot registry, the Remote namespace, and the copy. */
exports.inject = ['slots', 'remote', 'remote.messageFeedback', 'locale'];
/**
 * Client plugin body: the per-message feedback entry and its per-session
 * object layer.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-message-feedback: dictionaries');
    const controllers = new Map();
    const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId);
        if (controller === undefined) {
            controller = new controller_1.MessageFeedbackController(ctx.remote.messageFeedback, sessionId);
            controllers.set(sessionId, controller);
        }
        return controller;
    };
    // A reconnect can only invalidate what was already read; a cold Session
    // stays cold until something asks for it.
    ctx.on('connection/reset', () => {
        for (const controller of controllers.values()) {
            if (controller.getSnapshot().status !== 'cold')
                void controller.resync();
        }
    });
    ctx.slots.inject('conversation.chat.assistant-actions', () => {
        const dispose = ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'feedback',
            order: 10,
            locale: NS,
            inject: (sessionId) => {
                const controller = controllerFor(sessionId);
                return {
                    hooks: { feedback: controller },
                    ensure: () => controller.ensure(),
                    rate: (messageId, rating, note) => controller.rate(messageId, rating, note),
                    toggle: (messageId, rating) => controller.toggle(messageId, rating),
                    clearNote: messageId => controller.clearNote(messageId),
                    clear: messageId => controller.clear(messageId),
                };
            },
        }, MessageFeedbackActions_1.MessageFeedbackActions);
        return () => {
            dispose();
            for (const controller of controllers.values())
                controller.dispose();
            controllers.clear();
        };
    });
}

},
"src/modules/message-feedback/controller.js": function(module, exports, require) {
// source: src/modules/message-feedback/controller.ts

"use strict";
/**
 * Browser-local object layer over one Session's durable message-feedback
 * sidecar. The Host owns per-item compare-and-set: every mutation carries the
 * version this controller last observed, and a `version-conflict` reply carries
 * the authoritative item, so a lost race reconciles from the reply itself
 * instead of refetching the whole Session.
 * @module @xharness/dsh-client-ui-message-feedback/client/controller
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageFeedbackController = void 0;
// `Object.freeze` does not protect a Map: `set`/`delete` write internal slots,
// not properties. Immutability here is by discipline instead — the view type is
// ReadonlyMap and every publish hands over a freshly built Map that this class
// keeps no mutable reference to.
const EMPTY_ITEMS = new Map();
const INITIAL_VIEW = Object.freeze({
    status: 'cold',
    items: EMPTY_ITEMS,
    error: null,
});
const OK = Object.freeze({ ok: true });
const DISPOSED = Object.freeze({
    ok: false,
    error: Object.freeze({ code: 'disposed', message: 'feedback controller is disposed' }),
});
/** Human-readable text for one business failure code. */
function describe(code) {
    switch (code) {
        case 'session-not-found': return 'this session is no longer persisted';
        case 'target-not-found': return 'this message is not a persisted assistant message';
        case 'version-conflict': return 'feedback changed elsewhere';
        case 'note-blank': return 'a note must contain a non-whitespace character';
        case 'note-too-large': return 'the note is too long';
        default: return code;
    }
}
/** Build the rejected branch for one business failure code. */
function fail(code) {
    return { ok: false, error: { code, message: describe(code) } };
}
/** Carrier failure rendered with the Host-supplied code and message. */
function carrierFailure(error) {
    return { ok: false, error: { code: error.code, message: error.message } };
}
/**
 * Per-session feedback object layer. One instance backs every per-message
 * control in that Session, so a single list read seeds them all.
 */
class MessageFeedbackController {
    /**
     * @param remote - the messageFeedback Remote namespace.
     * @param sessionId - Session owning every addressed assistant message.
     */
    constructor(remote, sessionId) {
        this.remote = remote;
        this.sessionId = sessionId;
        this.view = INITIAL_VIEW;
        this.listeners = new Set();
        this.loadPromise = null;
        this.operationTail = Promise.resolve();
        this.disposed = false;
        /** Return the cached immutable view. */
        this.getSnapshot = () => this.view;
        /** Subscribe to view replacement. */
        this.subscribe = (listener) => {
            this.listeners.add(listener);
            return () => { this.listeners.delete(listener); };
        };
    }
    /**
     * Load once; a failed load stays retryable.
     * @returns the settled load result, shared by concurrent callers.
     */
    ensure() {
        if (this.view.status === 'ready')
            return Promise.resolve(OK);
        return this.refresh();
    }
    /**
     * Re-read the authoritative list, collapsing concurrent callers onto one
     * in-flight read.
     *
     * This is the unserialized read used to seed a cold controller, where no
     * mutation can be in flight yet. A reconnect must use {@link resync} instead:
     * an unserialized list response can otherwise arrive after a newer mutation's
     * reply and overwrite the version that mutation just committed.
     * @returns the settled reload result.
     */
    refresh() {
        if (this.loadPromise !== null)
            return this.loadPromise;
        this.publish({ status: 'loading', items: this.view.items, error: null });
        const pending = this.load();
        this.loadPromise = pending;
        return pending.finally(() => { this.loadPromise = null; });
    }
    /**
     * Re-read the list behind this Session's queued mutations, so a reconnect
     * cannot resurrect a version an in-flight mutation already replaced.
     * @returns the settled reload result.
     */
    resync() {
        // seed: false — this operation *is* the read, so pre-seeding would either
        // short-circuit it (status already ready) or run it twice.
        return this.mutate(() => this.refresh(), { seed: false });
    }
    /**
     * Create or replace feedback for one message, comparing against the version
     * this controller last observed.
     *
     * The note is resolved here rather than by the caller: `mutate` awaits the
     * one list read first, so this body always sees the committed item, while a
     * control that rendered before that read completed would still be holding
     * `undefined`. Omitting `note` therefore keeps whatever is stored; only
     * {@link clearNote} removes one.
     * @param messageId - target assistant message.
     * @param rating - desired judgment.
     * @param note - replacement explanation; omitted keeps the stored note.
     * @returns the settled mutation result.
     */
    rate(messageId, rating, note) {
        return this.mutate(async () => {
            const observed = this.view.items.get(messageId);
            return await this.putCommitted(messageId, rating, note ?? observed?.note, observed);
        });
    }
    /**
     * Replace one message's rating with the opposite judgment, or retract it when
     * the committed rating already matches. The decision reads the committed item
     * inside the serialized mutation, so a click that lands before the first list
     * read still toggles against the stored value rather than the empty view a
     * cold control rendered.
     * @param messageId - target assistant message.
     * @param rating - the judgment the human asked for.
     * @returns the settled mutation result.
     */
    toggle(messageId, rating) {
        return this.mutate(async () => {
            const observed = this.view.items.get(messageId);
            if (observed?.rating === rating)
                return await this.deleteCommitted(messageId, observed);
            return await this.putCommitted(messageId, rating, observed?.note, observed);
        });
    }
    /**
     * Drop the note while keeping the rating. Absent feedback needs no call.
     * @param messageId - target assistant message.
     * @returns the settled mutation result.
     */
    clearNote(messageId) {
        return this.mutate(async () => {
            const observed = this.view.items.get(messageId);
            if (observed === undefined || observed.note === undefined)
                return OK;
            return await this.putCommitted(messageId, observed.rating, undefined, observed);
        });
    }
    /**
     * Remove feedback for one message. A message with no known item is already
     * in the requested state, so no call is made.
     * @param messageId - target assistant message.
     * @returns the settled mutation result.
     */
    clear(messageId) {
        return this.mutate(async () => {
            const observed = this.view.items.get(messageId);
            if (observed === undefined)
                return OK;
            return await this.deleteCommitted(messageId, observed);
        });
    }
    /** Commit one put against the observed version and reconcile a conflict. */
    async putCommitted(messageId, rating, note, observed) {
        const carried = await this.remote.put({
            sessionId: this.sessionId,
            messageId,
            rating,
            ...(note === undefined ? {} : { note }),
            ifVersion: observed?.version ?? null,
        });
        if (!carried.ok)
            return carrierFailure(carried.error);
        const result = carried.value;
        if (result.ok) {
            this.commit(messageId, result.value);
            return OK;
        }
        if (result.error.code === 'version-conflict')
            this.commit(messageId, result.error.current);
        return fail(result.error.code);
    }
    /** Commit one delete against the observed version and reconcile a conflict. */
    async deleteCommitted(messageId, observed) {
        const carried = await this.remote.delete({
            sessionId: this.sessionId,
            messageId,
            ifVersion: observed.version,
        });
        if (!carried.ok)
            return carrierFailure(carried.error);
        const result = carried.value;
        if (result.ok) {
            this.commit(messageId, null);
            return OK;
        }
        if (result.error.code === 'version-conflict')
            this.commit(messageId, result.error.current);
        return fail(result.error.code);
    }
    /** Drop subscribers and refuse further work when the owning fiber unloads. */
    dispose() {
        this.disposed = true;
        this.listeners.clear();
    }
    /** Fetch the whole sidecar and publish it as the seeded view. */
    async load() {
        try {
            const carried = await this.remote.list({ sessionId: this.sessionId });
            if (this.disposed)
                return OK;
            if (!carried.ok) {
                this.publish({ status: 'error', items: this.view.items, error: carried.error.message });
                return carrierFailure(carried.error);
            }
            const result = carried.value;
            if (!result.ok) {
                this.publish({ status: 'error', items: this.view.items, error: describe(result.error.code) });
                return fail(result.error.code);
            }
            const items = new Map();
            for (const item of result.value.items)
                items.set(item.messageId, item);
            this.publish({ status: 'ready', items, error: null });
            return OK;
        }
        catch (error) {
            if (this.disposed)
                return OK;
            const message = error instanceof Error ? error.message : 'message feedback list failed';
            this.publish({ status: 'error', items: this.view.items, error: message });
            return { ok: false, error: { code: 'transport', message } };
        }
    }
    /**
     * Serialize one mutation behind this Session's prior mutation so queued
     * operations always compare against the committed version, and translate a
     * transport throw into the same settled shape the controls already render.
     */
    mutate(operation, options = {}) {
        const guarded = async () => {
            if (this.disposed)
                return DISPOSED;
            if (options.seed !== false) {
                const loaded = await this.ensure();
                if (!loaded.ok)
                    return loaded;
                // Disposal can land while the seeding read is in flight; without this
                // second check the fiber would still reach the wire after unloading.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
                if (this.disposed)
                    return DISPOSED;
            }
            try {
                return await operation();
            }
            catch (error) {
                return {
                    ok: false,
                    error: {
                        code: 'transport',
                        message: error instanceof Error ? error.message : 'message feedback mutation failed',
                    },
                };
            }
        };
        const result = this.operationTail.then(guarded, guarded);
        // `guarded` settles every carrier and business failure as a
        // MessageFeedbackActionResult and never rethrows, so this tail cannot reject and
        // needs no rejection handler.
        this.operationTail = result.then(() => undefined);
        return result;
    }
    /**
     * Replace one message's entry, keeping every other entry's identity. Only a
     * `mutate` operation reaches this, and `mutate` refuses admission once the
     * controller is disposed, so no disposal guard belongs here; `publish` is
     * the single place that stops notifying after listeners are dropped.
     */
    commit(messageId, item) {
        const items = new Map(this.view.items);
        if (item === null)
            items.delete(messageId);
        else
            items.set(messageId, item);
        this.publish({ status: 'ready', items, error: null });
    }
    /** Replace the view and contain subscriber failures at the observable boundary. */
    publish(view) {
        this.view = Object.freeze(view);
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch (error) {
                console.error('[ui-message-feedback] subscriber threw:', error);
            }
        }
    }
}
exports.MessageFeedbackController = MessageFeedbackController;

},
"src/modules/message-feedback/MessageFeedbackActions.js": function(module, exports, require) {
// source: src/modules/message-feedback/MessageFeedbackActions.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageFeedbackActions = MessageFeedbackActions;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Per-message feedback controls: a Like/Dislike pair plus an optional note.
 * The buttons render inside the assistant message's IconActions row, so they
 * reuse that row's chrome and sit between copy and branch. The note editor is
 * a popover (portaled to `document.body`) anchored to the note trigger, not an
 * inline expansion: a 260px textarea plus buttons cannot fit the row at any
 * viewport, and an inline element pushed the branch action and clock out of the
 * conversation column. Portaling out of the column also escapes its `overflow`
 * clip, so the panel cannot be cropped or detached from the message it annotates.
 * @module @xharness/dsh-client-ui-message-feedback/client/MessageFeedbackActions
 */
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const MessageFeedbackActions_styles_1 = __importDefault(require("./MessageFeedbackActions.styles"));
/** Safe distance kept between the panel and the viewport edges (the Menu portal margin). */
const PANEL_MARGIN = 12;
/** Distance between the trigger's bottom edge and the panel's top. */
const PANEL_GAP = 4;
/**
 * Unplaced portal panel: hidden but laid out so `offsetWidth` is real for the
 * clamp. The explicit insets match `Menu`'s measure style — a `position: fixed`
 * element with auto insets otherwise sits at its static position, a different
 * origin than the one the first placement measures from.
 */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
/**
 * One message's feedback controls.
 * @param props - the owner's message identity, the injected verbs, and the
 * shared feedback hook.
 * @returns the rating buttons and the note trigger, with the note editor
 * portal-open beneath the trigger while it is open.
 */
function MessageFeedbackActions({ messageId, ensure, rate, toggle, clearNote, useFeedback, t }) {
    const item = useFeedback(view => view.items.get(messageId));
    const loadFailed = useFeedback(view => view.status === 'error');
    const rating = item?.rating;
    const [noteOpen, setNoteOpen] = (0, react_1.useState)(false);
    const [draft, setDraft] = (0, react_1.useState)('');
    const [pending, setPending] = (0, react_1.useState)(false);
    // A rating or load failure surfaces beside the rating buttons, always legible
    // whether or not the note popover is open.
    const [rowFailure, setRowFailure] = (0, react_1.useState)(null);
    // A note save failure surfaces inside the note popover, where the human is
    // looking; it stays open so the draft survives to be corrected.
    const [noteFailure, setNoteFailure] = (0, react_1.useState)(null);
    const triggerRef = (0, react_1.useRef)(null);
    const panelRef = (0, react_1.useRef)(null);
    const inputRef = (0, react_1.useRef)(null);
    // The controls mount for every settled message in the transcript, so the
    // Session's feedback is read once on first hover/focus rather than on mount.
    const seeded = (0, react_1.useRef)(false);
    const seed = (0, react_1.useCallback)(() => {
        if (seeded.current)
            return;
        seeded.current = true;
        void ensure();
    }, [ensure]);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => () => { alive.current = false; }, []);
    /** Bumped whenever an editing session ends, so a late save can tell it is stale. */
    const noteGeneration = (0, react_1.useRef)(0);
    /** Current panel open-state, readable from a stale closure via a ref. */
    const noteOpenRef = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => { noteOpenRef.current = noteOpen; }, [noteOpen]);
    const errorCopy = (0, react_1.useCallback)((result) => {
        return result.error?.code === 'version-conflict' ? t('error.conflict') : t('error.generic');
    }, [t]);
    const settleRating = (0, react_1.useCallback)((result) => {
        if (!alive.current)
            return;
        setPending(false);
        setRowFailure(result.ok ? null : errorCopy(result));
    }, [errorCopy]);
    const closeNote = (0, react_1.useCallback)(() => {
        // Ends the editing session, so any save still in flight becomes stale.
        noteGeneration.current += 1;
        setNoteOpen(false);
    }, []);
    const onRate = (0, react_1.useCallback)((next) => {
        setPending(true);
        setRowFailure(null);
        // The controller decides retract-vs-replace from the committed item, so a
        // click that lands before the first list read still toggles the stored
        // value instead of this render's empty view.
        closeNote();
        void toggle(messageId, next).then(settleRating);
    }, [closeNote, messageId, settleRating, toggle]);
    // The rating is a parameter because only the note editor's render site can
    // prove one is recorded; that removes an unreachable undefined guard here.
    const onSaveNote = (0, react_1.useCallback)((current) => {
        const trimmed = draft.trim();
        setPending(true);
        setNoteFailure(null);
        // A save belongs to the editing session that started it. Closing and
        // reopening the panel begins a new one, and a late reply from the old
        // session must not act on it: a stale success would shut the panel the
        // human just opened, and a stale failure would describe a draft this
        // session never sent.
        const generation = noteGeneration.current;
        // What a session reopened before this save commits would be seeded with.
        const staleSeed = item?.note ?? '';
        // An emptied editor removes the note explicitly; `rate` alone preserves a
        // stored note, so it cannot express deletion.
        const settled = trimmed.length === 0
            ? clearNote(messageId)
            : rate(messageId, current, trimmed);
        void settled.then((result) => {
            if (!alive.current)
                return;
            // `pending` tracks the request in flight, not the editing session, so it
            // is released either way; all three of like, dislike and Save read
            // `disabled={pending}`, and holding it would lock the row until remount.
            // Releasing it unconditionally is safe because those three are the only
            // mutation entries and each is gated by it, so at most one request is ever
            // in flight. A future entry that bypasses the gate would have to bind
            // `pending` to the generation instead of clearing it here.
            setPending(false);
            if (result.ok) {
                // Only the session that is still open may act on a success: closing it
                // already discarded the draft, and reopening seeded a new one.
                if (generation === noteGeneration.current) {
                    setNoteFailure(null);
                    setNoteOpen(false);
                    return;
                }
                // A newer session is open, seeded from the note as it read before this
                // save committed. Resync it so the editor shows what is stored and the
                // next save cannot overwrite the text that just landed. An edited draft
                // is the human's, so it is left alone.
                setDraft(draftNow => (draftNow === staleSeed ? trimmed : draftNow));
                return;
            }
            // A failure from the session still on screen belongs in its panel. One
            // from an abandoned session is reported only when no new session has
            // taken over: the row then carries it, so a save that failed after the
            // human walked away is not silently dropped. Writing it into a reopened
            // panel instead would label the new draft with the old attempt's error.
            // `noteOpenRef` — not the `noteOpen` this closure was created from — is
            // read here, because a close+reopen between the save and resolution
            // leaves this closure with the panel state from when the save started.
            if (generation === noteGeneration.current || !noteOpenRef.current) {
                setNoteFailure(errorCopy(result));
            }
        });
    }, [clearNote, draft, errorCopy, item?.note, messageId, noteOpenRef, rate]);
    // The trigger toggles: while closed it opens the popover (seeding the draft
    // with the recorded note), while open it closes it. Toggling closed via the
    // trigger also fires the outside/within logic correctly because the trigger
    // is inside the panel's "inside" region.
    const toggleNote = (0, react_1.useCallback)(() => {
        if (noteOpen) {
            closeNote();
            return;
        }
        setDraft(item?.note ?? '');
        // A note-save failure belongs to the editing session that produced it. The
        // panel stays open on failure so the draft can be corrected, but once it is
        // closed and reopened the draft is reseeded from the stored note, so a
        // carried-over error would describe an attempt the new draft never made.
        // A failure that arrives after the panel closed is reported in the row, and
        // clearing it here is what retires that notice when a new session starts.
        setNoteFailure(null);
        setNoteOpen(true);
    }, [noteOpen, closeNote, item?.note]);
    // Place the portaled panel from the trigger rect before paint and keep it
    // with the trigger on scroll/resize, the same anchoring `Menu` uses for its
    // portal mode.
    const pos = (0, dsh_client_ui_primitives_1.useAnchoredPosition)({
        open: noteOpen,
        anchorRef: triggerRef,
        panelRef,
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
    });
    // Focus the input and close on Escape or outside pointer-down while open.
    (0, react_1.useEffect)(() => {
        if (!noteOpen)
            return;
        inputRef.current?.focus();
        const onPointerDown = (e) => {
            if (!(e.target instanceof Node))
                return;
            if (triggerRef.current?.contains(e.target) === true)
                return;
            if (panelRef.current?.contains(e.target) === true)
                return;
            closeNote();
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape')
                closeNote();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [noteOpen, closeNote]);
    // Return focus to the trigger only when the panel actually closes, not on the
    // initial mount (a freshly rendered message with a recorded rating must not
    // pull focus into its action row).
    const wasOpen = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => {
        if (noteOpen) {
            wasOpen.current = true;
            return;
        }
        if (wasOpen.current)
            triggerRef.current?.focus();
        wasOpen.current = false;
    }, [noteOpen]);
    const likeLabel = rating === 'positive' ? t('action.likeActive') : t('action.like');
    const dislikeLabel = rating === 'negative' ? t('action.dislikeActive') : t('action.dislike');
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: likeLabel, side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageFeedbackActions_styles_1.default.action, "aria-label": likeLabel, "aria-pressed": rating === 'positive', "data-active": rating === 'positive' || undefined, disabled: pending, onFocus: seed, onPointerEnter: seed, onClick: () => { onRate('positive'); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconLikeOutline16, {}) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: dislikeLabel, side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageFeedbackActions_styles_1.default.action, "aria-label": dislikeLabel, "aria-pressed": rating === 'negative', "data-active": rating === 'negative' || undefined, disabled: pending, onFocus: seed, onPointerEnter: seed, onClick: () => { onRate('negative'); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDislikeOutline16, {}) }) }), rating !== undefined && ((0, jsx_runtime_1.jsx)("button", { ref: triggerRef, type: "button", className: MessageFeedbackActions_styles_1.default.noteOpen, "aria-haspopup": "dialog", "aria-expanded": noteOpen, onClick: toggleNote, children: item?.note === undefined ? t('note.open') : item.note })), rowFailure === null && loadFailed && ((0, jsx_runtime_1.jsx)("span", { className: MessageFeedbackActions_styles_1.default.failure, role: "status", children: t('error.load') })), rowFailure !== null && (0, jsx_runtime_1.jsx)("span", { className: MessageFeedbackActions_styles_1.default.failure, role: "status", children: rowFailure }), !(rating !== undefined && noteOpen) && noteFailure !== null && ((0, jsx_runtime_1.jsx)("span", { className: MessageFeedbackActions_styles_1.default.failure, role: "status", children: noteFailure })), rating !== undefined && noteOpen && (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsxs)("div", { ref: panelRef, className: MessageFeedbackActions_styles_1.default.notePanel, role: "dialog", "aria-label": t('note.dialog'), style: pos ?? MEASURE_STYLE, children: [(0, jsx_runtime_1.jsx)("textarea", { ref: inputRef, className: MessageFeedbackActions_styles_1.default.noteInput, "aria-label": t('note.aria'), placeholder: t('note.placeholder'), value: draft, rows: 3, onChange: (event) => { setDraft(event.target.value); } }), (0, jsx_runtime_1.jsxs)("div", { className: MessageFeedbackActions_styles_1.default.noteActions, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageFeedbackActions_styles_1.default.noteSave, disabled: pending, onClick: () => { onSaveNote(rating); }, children: t('note.save') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageFeedbackActions_styles_1.default.noteCancel, onClick: closeNote, children: t('note.cancel') })] }), noteFailure !== null && (0, jsx_runtime_1.jsx)("span", { className: MessageFeedbackActions_styles_1.default.failure, role: "status", children: noteFailure })] }), document.body)] }));
}

},
"src/modules/message-feedback/MessageFeedbackActions.styles.js": function(module, exports, require) {
// source: src/modules/message-feedback/MessageFeedbackActions.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MessageFeedbackActions_css_1 = __importDefault(require("./MessageFeedbackActions.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-message-feedback/MessageFeedbackActions.module.css", "@xharness/dsh-client-ui-message-feedback", MessageFeedbackActions_css_1.default);
const styles = {
    "action": "fp-x2q_action",
    "failure": "fp-x2q_failure",
    "noteActions": "fp-x2q_noteActions",
    "noteCancel": "fp-x2q_noteCancel",
    "noteInput": "fp-x2q_noteInput",
    "noteOpen": "fp-x2q_noteOpen",
    "notePanel": "fp-x2q_notePanel",
    "noteSave": "fp-x2q_noteSave"
};
exports.default = styles;

},
"src/modules/message-feedback/MessageFeedbackActions.css": function(module, exports, require) {
// source: src/modules/message-feedback/MessageFeedbackActions.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".fp-x2q_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}.fp-x2q_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.fp-x2q_action:disabled{cursor:default;opacity:.4}.fp-x2q_action[data-active]{color:var(--dsw-alias-label-primary)}.fp-x2q_noteOpen{max-width:220px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;cursor:pointer;background:0 0;border:none;border-radius:14px;padding:0 8px;font-size:13px;line-height:28px;overflow:hidden}.fp-x2q_noteOpen:hover,.fp-x2q_noteOpen[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.fp-x2q_notePanel{z-index:1100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:320px;max-width:min(360px,100vw - 24px);max-height:calc(100vh - 24px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;gap:8px;padding:8px;display:flex;position:fixed;overflow-y:auto}.fp-x2q_noteInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;color:var(--dsw-alias-label-primary);font:inherit;resize:vertical;border-radius:8px;padding:6px 8px;font-size:13px}.fp-x2q_noteActions{justify-content:flex-end;gap:6px;display:flex}.fp-x2q_noteSave,.fp-x2q_noteCancel{cursor:pointer;border:none;border-radius:14px;height:28px;padding:0 10px;font-size:13px}.fp-x2q_noteSave{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.fp-x2q_noteSave:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.fp-x2q_noteSave:disabled{cursor:default;opacity:.4}.fp-x2q_noteCancel{color:var(--dsw-alias-label-tertiary);background:0 0}.fp-x2q_noteCancel:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.fp-x2q_failure{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}\n";

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
"src/modules/message-feedback/locales.js": function(module, exports, require) {
// source: src/modules/message-feedback/locales.ts

"use strict";
/** `feedback` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'action.like': '好的回答',
    'action.likeActive': '取消标记',
    'action.dislike': '有问题的回答',
    'action.dislikeActive': '取消标记',
    'note.open': '补充说明',
    'note.dialog': '反馈',
    'note.placeholder': '这条回答哪里好，或哪里有问题？（可选）',
    'note.save': '保存',
    'note.cancel': '取消',
    'note.aria': '反馈说明',
    'error.conflict': '这条反馈已在别处改动，已显示最新状态',
    'error.load': '反馈状态加载失败',
    'error.generic': '反馈保存失败',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'action.like': 'Good response',
    'action.likeActive': 'Remove rating',
    'action.dislike': 'Bad response',
    'action.dislikeActive': 'Remove rating',
    'note.open': 'Add a note',
    'note.dialog': 'Feedback',
    'note.placeholder': 'What was good, or what went wrong? (optional)',
    'note.save': 'Save',
    'note.cancel': 'Cancel',
    'note.aria': 'Feedback note',
    'error.conflict': 'This feedback changed elsewhere; the latest state is shown',
    'error.load': 'Could not load feedback',
    'error.generic': 'Could not save feedback',
};

}
};
const __dependencies = {"src/modules/message-feedback/index.js":{"./controller":"src/modules/message-feedback/controller.js","./MessageFeedbackActions":"src/modules/message-feedback/MessageFeedbackActions.js","./locales":"src/modules/message-feedback/locales.js"},"src/modules/message-feedback/controller.js":{},"src/modules/message-feedback/MessageFeedbackActions.js":{"./MessageFeedbackActions.styles":"src/modules/message-feedback/MessageFeedbackActions.styles.js"},"src/modules/message-feedback/MessageFeedbackActions.styles.js":{"./MessageFeedbackActions.css":"src/modules/message-feedback/MessageFeedbackActions.css","../views-types":"src/modules/views-types.js"},"src/modules/message-feedback/MessageFeedbackActions.css":{},"src/modules/views-types.js":{},"src/modules/message-feedback/locales.js":{}};
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
return __load("src/modules/message-feedback/index.js");
}
});
