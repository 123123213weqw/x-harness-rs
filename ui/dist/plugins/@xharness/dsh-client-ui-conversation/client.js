// Generated from src/modules/conversation/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-conversation",
factory: (__externalRequire) => {
const __units = {
"src/modules/conversation/index.js": function(module, exports, require) {
// source: src/modules/conversation/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhEditMessage = exports.XHarnessEditableInputBar = exports.XHarnessMessageEditor = exports.ConversationController = exports.inject = exports.apply = void 0;
var apply_1 = require("./apply");
Object.defineProperty(exports, "apply", { enumerable: true, get: function () { return apply_1.apply; } });
Object.defineProperty(exports, "inject", { enumerable: true, get: function () { return apply_1.inject; } });
var service_1 = require("./service");
Object.defineProperty(exports, "ConversationController", { enumerable: true, get: function () { return service_1.ConversationController; } });
// Export discipline: packages/client/AGENTS.md.
var MessageEditor_1 = require("./edit/MessageEditor");
Object.defineProperty(exports, "XHarnessMessageEditor", { enumerable: true, get: function () { return MessageEditor_1.XHarnessMessageEditor; } });
var EditableInputBar_1 = require("./edit/EditableInputBar");
Object.defineProperty(exports, "XHarnessEditableInputBar", { enumerable: true, get: function () { return EditableInputBar_1.XHarnessEditableInputBar; } });
var actions_1 = require("./edit/actions");
Object.defineProperty(exports, "xhEditMessage", { enumerable: true, get: function () { return actions_1.xhEditMessage; } });

},
"src/modules/conversation/apply.js": function(module, exports, require) {
// source: src/modules/conversation/apply.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const EditableInputBar_1 = require("./edit/EditableInputBar");
const actions_1 = require("./edit/actions");
const dsh_client_ui_slots_1 = require("@xharness/dsh-client-ui-slots");
const runtime_values_1 = require("./runtime-values");
const stores_1 = require("./stores");
const service_1 = require("./service");
const blocks_1 = require("./input/blocks");
const hub_1 = require("./input/hub");
const submission_policy_1 = require("./input/submission-policy");
const EnterBehaviorRow_1 = require("./settings/EnterBehaviorRow");
const ChatView_1 = require("./chat/ChatView");
const scroll_memory_1 = require("./chat/scroll-memory");
const StatsLine_1 = require("./chat/StatsLine");
const ApprovalPanel_1 = require("./skeleton/ApprovalPanel");
const TodoPanel_1 = require("./skeleton/TodoPanel");
const QueueDock_1 = require("./queue/QueueDock");
const ConversationRoot_1 = require("./skeleton/ConversationRoot");
const ConversationSession_1 = require("./skeleton/ConversationSession");
const DetailsPanel_1 = require("./skeleton/DetailsPanel");
const locales_1 = require("./locales");
const register_1 = require("./conversation-nodes/register");
const register_node_renderers_1 = require("./chat/register-node-renderers");
const submission_settings_1 = require("./submission-settings");
/** Services required by the conversation plugin. */
exports.inject = [
    'slots', 'layout', 'sessions', 'workspaces', 'locale', 'connection', 'remote', 'settingsScope',
    'conversationEvents', 'conversationViews',
];
// Static no-session sources for the composer-bar hooks compartment: module
// constants so the render side's per-source hook cache (observableHook) keeps
// one identity across every no-session render.
const ABSENT_NOTICES = {
    getSnapshot: () => null,
    subscribe: () => () => { },
};
/** No session, therefore nothing to block; same one-identity rule as above. */
const ABSENT_BLOCK = {
    getSnapshot: () => undefined,
    subscribe: () => () => { },
};
const EMPTY_LEXICON = new Map();
const ABSENT_LEXICON = {
    getSnapshot: () => EMPTY_LEXICON,
    subscribe: () => () => { },
};
const ABSENT_MENU_LAUNCHER = {
    getSnapshot: () => null,
    subscribe: () => () => { },
};
const CHAT_NODE_INJECT = {
    hooks: {
        turnData: ({ useSession }, nodeKey) => function useTurnData(key) {
            return useSession((snapshot) => {
                const location = snapshot.chat.nodes.get(nodeKey)?.location;
                return location?.kind === 'turn' || location?.kind === 'step'
                    ? location.turn.data.get(key)
                    : undefined;
            });
        },
    },
};
/** Resolve the session-scoped conversation face (scope-addressed send/cancel), failing loud. */
function scopedConversation(sessions, id) {
    const scoped = sessions.scope(id);
    if (scoped === undefined)
        throw new Error(`ui-conversation: session "${id}" resolved no scope`);
    const conversation = scoped.get('conversation');
    if (conversation === undefined)
        throw new Error('ui-conversation: conversation service unavailable through the session scope');
    return conversation;
}
/** Resolve package-internal attachment operations from the public service registration. */
function concreteConversation(ctx) {
    const conversation = ctx.get('conversation');
    if (conversation === undefined)
        throw new Error('ui-conversation: conversation service unavailable');
    return conversation;
}
/** Chain routing: claim the composer while an approval wait is pending (pure — owner props only). */
function selectApproval({ interactions }) {
    return interactions.find((i) => i.kind === 'approval') ?? null;
}
/** Mounts the conversation plugin.
 * @param ctx - Client root context.
 */
function apply(ctx) {
    const sessions = ctx.sessions;
    const workspaces = ctx.workspaces;
    const layout = ctx.layout;
    const slots = ctx.slots;
    (0, register_1.registerConversationNodes)(ctx);
    (0, register_node_renderers_1.registerChatNodeRenderers)(ctx);
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-conversation: dictionaries');
    // Registration-time text (the view tab label) reads through the bound
    // translate as a thunk, so it follows the active locale without
    // re-registration; components read the standard `t` seat instead.
    const t = ctx.locale.bind(locales_1.NS);
    // Apply-time construction keeps store identity bound to this fiber.
    const chatStore = (0, stores_1.createChatStore)();
    const submissionPolicy = new submission_policy_1.ComposerSubmissionPolicy(ctx.settingsScope.bind({ namespace: submission_settings_1.CONVERSATION_SETTINGS_NAMESPACE }));
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'composer-enter',
        order: 20,
        locale: locales_1.NS,
        inject: () => ({
            hooks: { busyEnter: submissionPolicy.busyEnter },
            setBusyEnter: (behavior) => { submissionPolicy.setBusyEnter(behavior); },
        }),
    }, EnterBehaviorRow_1.EnterBehaviorRow));
    // Chat semantic reader positions by session, surviving view switches and
    // width reflow when the tab ring remounts the view. Deliberately not
    // persisted: a fresh page load keeps the open-jump-to-bottom default.
    const chatScrollMemory = new scroll_memory_1.ChatScrollMemory((sessionId, position) => {
        const seq = position?.anchorSeq;
        sessions.binding(sessionId)?.session.setHistoryOpenTarget?.(position === null ? { kind: 'latest' }
            : seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 ? { kind: 'anchor', seq } : undefined);
    });
    ctx.effect(() => () => { chatScrollMemory.dispose(); }, 'conversation reader memory');
    const viewTabs = () => {
        const tabs = [];
        for (const entry of slots.entries('conversation.view')) {
            /* v8 ignore next -- unreachable: list registration validates id at load. */
            if (entry.options.id === undefined)
                continue;
            tabs.push({ id: entry.options.id, label: (0, dsh_client_ui_slots_1.resolveSlotLabel)(entry.options.label) ?? entry.options.id });
        }
        return tabs;
    };
    const views = {
        list: viewTabs,
        subscribe: (fn) => slots.subscribe('conversation.view', fn),
        version: () => slots.getVersion('conversation.view'),
    };
    // The per-session input machine registry (SessionInputResolver face; published as
    // ctx.conversation.input by the service below sharing this one instance).
    const inputHub = new hub_1.InputHub(ctx, t, sessionId => { chatScrollMemory.requestFollow(sessionId); });
    // The composer-block registry: a plugin that knows a session cannot send —
    // ui-model-selection, when no adapter serves the session's route — raises a block
    // here, and the bar reads its own session's store. It cannot flow the other
    // way: this package must not import the plugins that would know.
    const composerBlocks = new blocks_1.ComposerBlockRegistry();
    // The input machine feeds every session-scope slot
    // component through the standard provide channel — the 'input' hook plus
    // the two public actions. Materialization is the shell creation trigger
    // (per-session lazy; scope disposer tears down).
    ctx.effect(() => sessions.provide({
        hooks: ['input'],
        props: ['inputActions'],
        resolve: (binding) => {
            const shell = inputHub.shellFor(binding);
            return {
                hooks: { input: shell.state },
                props: { inputActions: shell.actions },
            };
        },
    }), 'ui-conversation: input standard-kit provider');
    // Resident current-session-optional shell. It owns the stable Hero/composer
    // frame while strict session slots fill only their session-bound regions.
    slots.register({
        name: 'conversation',
        locale: locales_1.NS,
        children: {
            'conversation.session': { kind: 'single', scope: 'session' },
            'conversation.session.header': { kind: 'single', scope: 'session' },
            'conversation.composer': { kind: 'chain', scope: 'session' },
            'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
            'conversation.input.overlay': { kind: 'list', scope: 'session' },
            'conversation.input.dock': { kind: 'list', scope: 'session' },
            'conversation.composer.dock': { kind: 'list', scope: 'session' },
            'conversation.input.left': { kind: 'list', scope: 'session' },
            'conversation.input.right': { kind: 'list', scope: 'session' },
            'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
            'conversation.hero.workspace': { kind: 'single', scope: 'root' },
            'conversation.hero.runtimeEnvironment': { kind: 'single', scope: 'root' },
            'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
        },
        inject: (sessionId) => ({
            hooks: { composerBlock: sessionId === undefined ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId) },
            selectWorkspace: async (workspaceId) => {
                const nextId = await workspaces.connectWorkspace(workspaceId);
                if (sessionId !== undefined && nextId !== sessionId) {
                    const from = inputHub.shell(sessionId);
                    const draft = from.snapshot.draft;
                    const imageIds = from.snapshot.imageIds;
                    const next = inputHub.shell(nextId);
                    if (imageIds.length === 0 || next.addImages(imageIds)) {
                        if (draft !== '') {
                            next.setDraft(draft);
                            from.setDraft('');
                        }
                        if (imageIds.length > 0) {
                            for (const id of imageIds)
                                from.removeImage(id);
                        }
                    }
                }
                sessions.open(nextId);
            },
        }),
    }, ConversationRoot_1.ConversationRoot);
    // The strict session body fills the resident scrollport without owning it;
    // the Hero/composer path therefore stays fixed while the first blank
    // session appears after a Workspace pick.
    slots.register({
        name: 'conversation.session',
        children: {
            'conversation.view': { kind: 'list', scope: 'session' },
        },
        store: chatStore,
        inject: (sessionId, _actions) => {
            const conversation = concreteConversation(ctx);
            return {
                views,
                releaseSessionImages: (id) => { conversation.releaseSessionImages(id); },
                bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
            };
        },
    }, ConversationSession_1.ConversationSession);
    // Header chrome sits above the resident scrollport but shares the same
    // per-session chat store (active view) as its body and view entries.
    slots.register({
        name: 'conversation.session.header',
        locale: locales_1.NS,
        children: {
            'conversation.session.header.actions': { kind: 'list', scope: 'session' },
            'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        },
        store: chatStore,
        inject: () => ({
            views,
            open: (id) => { sessions.open(id); },
        }),
    }, ConversationSession_1.ConversationSessionHeader);
    // The default composer body: its own single slot inside the composer
    // chain's fallback. Public machine surface arrives via the
    // provide channel above; the keyboard command face and the stop/retry
    // verbs ride this inject (package-internal — hub and bar are one plugin).
    // Session-maybe: with no current session the machine faces are absent and
    // the hooks compartment binds static empty sources (module constants, so
    // observableHook caching and hook order stay stable across transitions).
    slots.register({
        name: 'conversation.composer.bar',
        locale: locales_1.NS,
        // The two named control seats in the bar's tool row (plan beside the
        // access control, model right); empty until their owning plugins
        // register.
        children: {
            'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
            'conversation.input.plan': { kind: 'single', scope: 'session' },
            'conversation.input.model': { kind: 'single', scope: 'session' },
        },
        inject: (sessionId) => {
            if (sessionId === undefined) {
                return {
                    keyboard: undefined,
                    addImages: undefined,
                    removeImage: undefined,
                    draftImages: undefined,
                    resolveSubmitMode: (running, gesture, steeringAvailable) => submissionPolicy.resolve(running, gesture, steeringAvailable),
                    toggleCommandMenu: undefined,
                    stop: undefined,
                    command: undefined,
                    hooks: { notices: ABSENT_NOTICES, lexicon: ABSENT_LEXICON, menuLauncher: ABSENT_MENU_LAUNCHER },
                };
            }
            const conversation = concreteConversation(ctx);
            const shell = inputHub.shell(sessionId);
            const inputTriggers = inputHub.inputTriggers(sessionId);
            return {
                keyboard: shell,
                addImages: (files) => {
                    try {
                        const images = conversation.createDraftImages(files);
                        if (!shell.addImages(images.map(image => image.id))) {
                            conversation.releaseDraftImages(images);
                        }
                        return null;
                    }
                    catch (error) {
                        if (error instanceof service_1.UnsupportedImageMediaTypeError) {
                            // Positive copy: the supported list is fixed in imageMediaType,
                            // and naming it beats echoing the rejected MIME type back.
                            return t('image.unsupportedType');
                        }
                        return error instanceof Error ? error.message : String(error);
                    }
                },
                removeImage: (id) => {
                    shell.removeImage(id);
                    if (!shell.snapshot.imageIds.includes(id))
                        conversation.releaseDraftImage(id);
                },
                draftImages: ids => conversation.draftImages(ids),
                resolveSubmitMode: (running, gesture, steeringAvailable) => submissionPolicy.resolve(running, gesture, steeringAvailable),
                toggleCommandMenu: inputTriggers === undefined
                    ? undefined
                    : (selection) => {
                        shell.dismissPopup();
                        const snapshot = shell.snapshot;
                        inputTriggers.toggleSource('command', {
                            trigger: '/',
                            query: '',
                            quoted: false,
                            position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
                            span: { ...selection, draftRev: snapshot.draftRev },
                        });
                    },
                stop: () => {
                    scopedConversation(sessions, sessionId).cancel().catch(() => {
                        // Stop failure surfaces via snapshot.promptError; nothing to restore.
                    });
                },
                command: async (line) => {
                    const session = sessions.binding(sessionId)?.session;
                    if (session === undefined)
                        return false;
                    const result = await session.command(line);
                    return result.ok && result.value.matched;
                },
                hooks: {
                    notices: shell.notices,
                    lexicon: shell.lexicon,
                    menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
                },
            };
        },
    }, EditableInputBar_1.XHarnessEditableInputBar);
    // The approval takeover: a selector-routed entry of the chain this package
    // just declared (the ui-user-questions registration pattern; the entry lives here
    // because approval answering is core conversation UX, not an optional tool).
    // Zero business face — data and verbs both ride the matched carrier.
    // priority 1: question takeovers (default 0) win when both kinds are
    // pending — a question is a conversation the model is waiting on, while an
    // approval only blocks one tool call; answering the question first cannot
    // strand the approval (it re-elects the moment the question resolves).
    slots.register({ name: 'conversation.composer', select: selectApproval, priority: 1, locale: locales_1.NS }, ApprovalPanel_1.ApprovalPanel);
    // The chat view: first entry of the ring this package just declared.
    // ChatView owns only the stable ordered Node list. Business renderers are
    // independently keyed behind its one Node seat.
    slots.register({
        name: 'conversation.view',
        id: 'chat',
        order: 0,
        label: () => t('view.chat'),
        locale: locales_1.NS,
        children: {
            'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
            'conversation.message.images': { kind: 'single', scope: 'session' },
        },
        store: chatStore,
        inject: (sessionId, actions) => {
            const conversation = concreteConversation(ctx);
            const scoped = scopedConversation(sessions, sessionId);
            return {
                openDetails: (target) => {
                    actions.select(target);
                    layout.openDetails();
                },
                fileMentions: owner => ctx.get('chatFileMentions')?.forClosing(owner),
                openFile: (path) => {
                    const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
                    const resolved = (0, runtime_values_1.resolveWorkspacePath)(cwd, path);
                    if (path === '.' || path === '..' || /[\\/]$/.test(path))
                        return workspaces.openPath(resolved);
                    window.dispatchEvent(new CustomEvent('xharness:workspace-open', { detail: { kind: 'file', source: resolved, sessionId } }));
                    return Promise.resolve();
                },
                loadOlder: () => scoped.loadOlder(),
                loadImage: attachment => conversation.resolveImage(sessionId, attachment),
                // Unregistered 'trajectory' id is safe: the tab ring falls back to
                // the first view, and the untouched inspect target stays inert.
                editMessage: content => (0, actions_1.xhEditMessage)(inputHub, sessionId, content),
                forkMessage: (seq, content) => (0, actions_1.xhForkMessage)(inputHub, sessions, sessionId, seq, content).catch((error) => inputHub.shell(sessionId).notify('error', String(error))),
                inspectCall: (callId) => {
                    actions.setInspect({ callId });
                    actions.setView('trajectory');
                },
                chatScroll: chatScrollMemory.forSession(sessionId),
                forkAt: (seq) => { void (0, actions_1.xhForkAt)(inputHub, sessions, sessionId, seq); },
            };
        },
    }, ChatView_1.ChatView);
    // Session stats stick with the composer (composer.dock = stats-line family).
    slots.register({ name: 'conversation.composer.dock', id: 'stats', order: 0, locale: locales_1.NS }, StatsLine_1.StatsLine);
    // Class-plugin mount (packages/AGENTS.md service form): the service
    // registers itself as `conversation` and lives on its own child fiber.
    // Presentation registrants depend directly on their slot declarations;
    // this service remains only where conversation actions are required.
    ctx.plugin(service_1.ConversationController, { input: inputHub, blocks: composerBlocks });
    // The plan strip rides the input dock above the queue rows (same posture).
    ctx.plugin(TodoPanel_1.todoDockEntry);
    // The read-only queue dock entry rides the same
    // registration path into the input dock declared above.
    ctx.plugin(QueueDock_1.queueDockEntry);
    slots.register({
        name: 'details',
        locale: locales_1.NS,
        children: {
            'conversation.details.tool': { kind: 'single', scope: 'session' },
        },
        store: chatStore,
        inject: () => ({
            closeDetails: () => { layout.closeDetails(); },
        }),
    }, DetailsPanel_1.DetailsPanel);
}

},
"src/modules/conversation/edit/EditableInputBar.js": function(module, exports, require) {
// source: src/modules/conversation/edit/EditableInputBar.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XHarnessEditableInputBar = XHarnessEditableInputBar;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const InputBar_1 = require("../skeleton/InputBar");
const ABSENT_EDITOR = { subscribe: () => () => { }, getSnapshot: () => null };
function XHarnessEditableInputBar(props) {
    const editor = props.keyboard?.xhEditor, state = (0, react_1.useSyncExternalStore)(editor?.subscribe ?? ABSENT_EDITOR.subscribe, editor?.getSnapshot ?? ABSENT_EDITOR.getSnapshot);
    const button = (label, action, disabled = false) => (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: disabled, onClick: () => { void Promise.resolve(action()).catch((error) => editor?.set({ error: String(error) })); }, children: props.t(label) });
    const images = editor?.d.conversation.draftImages(editor.d.shell.snapshot.imageIds) ?? [];
    const editingLocked = state?.phase === 'confirm' || state?.phase === 'recover' || state?.phase === 'saving';
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { "data-xh-editor-session": props.sessionId, style: { fontSize: 13, padding: state?.phase !== 'idle' || state?.error ? '8px 12px' : 0 }, children: [state?.phase === 'confirm' && (0, jsx_runtime_1.jsxs)("div", { role: "alertdialog", "aria-label": props.t('message.editReplace'), children: [props.t('message.editReplace'), button('message.editConfirm', () => editor?.confirm()), button('message.editCancel', () => editor?.cancel())] }), state?.phase === 'recover' && (0, jsx_runtime_1.jsxs)("div", { children: [props.t('message.editRecovered'), button('message.editResume', () => editor?.recover()), button('message.editCancel', () => editor?.cancel())] }), state?.phase === 'saving' && props.t('message.editSaving'), state?.editing && (0, jsx_runtime_1.jsxs)("div", { children: [props.t('message.editActive'), button('message.editCancel', () => editor?.cancel(), editor?.busy())] }), state?.error && (0, jsx_runtime_1.jsx)("div", { role: "alert", children: state.error }), images.filter(image => image.historyRef && image.loadState !== 'ready').map(image => (0, jsx_runtime_1.jsxs)("div", { role: "status", children: [props.t(image.loadState === 'loading' ? 'message.editLoading' : 'message.editMissing'), " ", image.file.name, image.loadState === 'missing' && button('message.editRetry', () => editor?.hydrate(image)), button('message.editRemove', () => props.removeImage?.(image.id), editor?.busy())] }, image.id))] }), (0, jsx_runtime_1.jsx)(InputBar_1.InputBar, { ...props, disabled: props.disabled || editingLocked })] });
}

},
"src/modules/conversation/skeleton/InputBar.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/InputBar.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputBar = InputBar;
const jsx_runtime_1 = require("react/jsx-runtime");
/** The default composer body: the 'conversation.composer.bar' slot entry.
 * Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession. */
const react_1 = require("react");
const classnames_1 = __importDefault(require("../classnames"));
const primitives_1 = require("../primitives");
const decorations_1 = require("../input/decorations");
const image_labels_1 = require("../image-labels");
const ReferenceIcon_1 = require("../reference/ReferenceIcon");
const ContextMeter_1 = require("./ContextMeter");
const PermissionSelect_1 = require("./PermissionSelect");
const safari_1 = require("./safari");
const InputBar_styles_1 = __importDefault(require("./InputBar.styles"));
const ComposerAddMenu_1 = require("./ComposerAddMenu");
const attachments_1 = require("../attachments");
/** Decoration product of the no-session state (no machine, empty draft). */
const INERT_DECORATIONS = { token: null, chips: [], textRefs: [], hint: null };
function InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useProjection, sessionId, variant, disabled: inert = false, blocked, workspacePickerOpen = false, onRequestWorkspace, placeholder, accessory, overlay, leftItems, rightItems, footer, }) {
    const input = useInput(s => s);
    const notice = useNotices(s => s);
    const lexicon = useLexicon(s => s);
    const commandMenuOpen = useMenuLauncher(source => source === 'command');
    const promptError = useSession(s => s.promptError) ?? null;
    const running = useSession(s => s.running) ?? false;
    const subagent = useSession(s => s.subagent) ?? null;
    const removed = useSession(s => s.removed) ?? false;
    // Plan mode swaps the textarea placeholder (the projection is the folded
    // host value; owner-prop placeholders — hero, session-unavailable — win).
    const planActive = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active));
    // Absent (undefined: no frame yet) and cleared (null) both mean no goal.
    const hasGoal = useProjection('goal', goal => goal != null);
    // Session-maybe: the machine faces are absent together while no session is
    // current; the bar renders the same DOM inert instead of a parallel tree.
    const live = input !== undefined && keyboard !== undefined && inputActions !== undefined;
    const draft = input?.draft ?? '';
    const attachments = (0, react_1.useMemo)(() => input === undefined || draftImages === undefined ? [] : draftImages(input.imageIds), [draftImages, input?.imageIds]);
    const empty = draft.trim() === '' && attachments.length === 0;
    // Transient error banner (machine notices, image-intake rejections, and
    // prompt failures): the seq keys the Toast so an identical repeated message
    // restarts the hold-then-fade cycle instead of reusing the faded one.
    const [toast, setToast] = (0, react_1.useState)(null);
    const toastSeq = (0, react_1.useRef)(0);
    const showToast = (0, react_1.useCallback)((text) => {
        toastSeq.current += 1;
        setToast({ seq: toastSeq.current, text });
    }, []);
    const dismissToast = (0, react_1.useCallback)(() => { setToast(null); }, []);
    // The deployment's image-intake limits (absent while no attachment service
    // is composed — the pre-check below then defers entirely to the host).
    const imageLimits = useProjection('imageLimits');
    // Prompt failures are ordinary failures (no create/attach transaction exists
    // anymore): the toast announces promptError, the draft stays in the machine,
    // and the user resubmits. A remount over a session whose machine still holds
    // an unresolved promptError deliberately re-announces it once — the failure
    // is still pending, and a transient banner is its only surface. Attachment
    // rejections show product copy keyed by the wire reason; other codes are
    // developer-facing and keep the raw message plus code.
    (0, react_1.useEffect)(() => {
        if (promptError === null)
            return;
        showToast(promptError.error.code === 'attachment-error'
            ? (0, image_labels_1.attachmentErrorText)(t, typeof promptError.error.details.reason === 'string' ? promptError.error.details.reason : '', imageLimits)
            : `${promptError.error.message} (${promptError.error.code})`);
    }, [promptError, showToast, t, imageLimits]);
    (0, react_1.useEffect)(() => {
        if (notice?.level === 'error')
            showToast(notice.text);
    }, [notice, showToast]);
    const inputRef = (0, react_1.useRef)(null);
    const cardRef = (0, react_1.useRef)(null);
    const scrollRef = (0, react_1.useRef)(null);
    const mirrorRef = (0, react_1.useRef)(null);
    const safari = (0, react_1.useMemo)(() => (0, safari_1.isSafariBrowser)(navigator), []);
    const safariNativeShrinkRef = (0, react_1.useRef)(false);
    // IME guard: composition Enter picks a candidate, it must not send. The ref outlives renders;
    // clearing is deferred one tick because Safari delivers the closing keydown AFTER compositionend.
    const composingRef = (0, react_1.useRef)(false);
    const onCompositionStart = () => {
        composingRef.current = true;
    };
    const onCompositionEnd = () => {
        setTimeout(() => {
            composingRef.current = false;
        }, 10);
    };
    // The Access seat's data: the host-computed permissions projection
    // (undefined = capability absent → the chip renders nothing).
    const permissions = useProjection('permissions');
    // A continuable child without its live parent cannot accept human input,
    // but its independent Stop below stays available while it runs.
    const continuable = subagent?.address.mode === 'continuable';
    const parentOffline = continuable && !subagent.parentAvailable;
    // Running input stays free; locked = session removed, the
    // inert no-workspace state, the machine faces absent (no session), or a
    // parent-offline continuable child. An owner block also disables input;
    // adjudicating and submitting render read-only so the draft stays visible.
    const disabled = removed || inert || !live || blocked !== undefined || parentOffline;
    const locked = disabled;
    // The model seat is the ONE control a block leaves live: every block this
    // contract has is cleared by choosing a model, so locking it too would leave
    // the composer asking for the only thing it prevents. The other reasons to
    // be disabled do lock it — there is no session to choose a model for.
    const modelSeatLocked = removed || inert || !live;
    const machineBusy = input?.phase === 'adjudicating' || input?.phase === 'submitting';
    // The no-workspace textarea remains the resident DOM node but acts as the
    // existing picker trigger. Message controls stay locked until a Session
    // exists; the trigger itself is read-only rather than disabled so pointer
    // and keyboard users can reach the recovery action.
    const workspaceTrigger = inert && !removed && onRequestWorkspace !== undefined;
    const textareaDisabled = removed || (locked && !workspaceTrigger);
    const canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && subagent === null
        && input.queue.some(row => row.placement === 'queued');
    (0, react_1.useEffect)(() => {
        if (input === undefined || inputActions === undefined)
            return;
        if (attachments.length !== input.imageIds.length) {
            inputActions.pruneImages(attachments.map(attachment => attachment.id));
        }
    }, [attachments, input?.imageIds, inputActions]);
    // A native Safari edit that shortens the draft may leave the previous
    // soft-wrap layout behind after the mirror shrinks. The native-change signal
    // keeps ordinary typing and programmatic draft updates from reading layout;
    // the helper then repairs only measured overflow before paint while
    // preserving native editing state. See
    // .agents/notes/implemented/bug-fix/2026-08-13-safari-textarea-soft-wrap-reflow.md.
    (0, react_1.useLayoutEffect)(() => {
        const nativeShrink = safariNativeShrinkRef.current;
        safariNativeShrinkRef.current = false;
        if (safari && nativeShrink)
            (0, safari_1.repairSafariTextareaLayout)(inputRef.current);
    }, [draft, safari]);
    // Scroll the draft scrollport the minimum that brings `caret` into view — the
    // browser's own behavior for typing, performed for the paths where it does
    // not act.
    //
    // The mirror is the caret's ruler: it renders the same draft at the same
    // metrics and the same wrap width in the same stack (that is what makes it
    // the height authority), so a Range collapsed at the caret's index reports
    // where the caret is without a caret API.
    const revealCaret = (caret) => {
        const scrollEl = scrollRef.current;
        const mirrorEl = mirrorRef.current;
        const text = mirrorEl?.firstChild;
        if (scrollEl === null || mirrorEl === null || !(text instanceof Text))
            return;
        // A box that cannot scroll has nothing to reveal: the draft fits, so every
        // caret is already in view and the assignment below would clamp to itself.
        if (scrollEl.scrollHeight <= scrollEl.clientHeight)
            return;
        const at = Math.min(caret, text.data.length);
        // A caret straight after a newline sits on a line with nothing on it to
        // measure — the shape a trailing-newline draft ends in — and the engines
        // disagree there: chromium returns NO client rects at all (an all-zero box,
        // which would scroll the wrong way), firefox reports the line above, WebKit
        // the right one. Measure the newline itself instead, which is the line the
        // caret just left, and step one line down; that they all agree on.
        const afterNewline = at > 0 && text.data[at - 1] === '\n';
        const range = document.createRange();
        range.setStart(text, afterNewline ? at - 1 : at);
        if (afterNewline)
            range.setEnd(text, at);
        else
            range.collapse(true);
        const line = afterNewline ? Number.parseFloat(getComputedStyle(mirrorEl).lineHeight) : 0;
        const rect = range.getBoundingClientRect();
        const box = scrollEl.getBoundingClientRect();
        if (rect.bottom + line > box.bottom)
            scrollEl.scrollTop += rect.bottom + line - box.bottom;
        else if (rect.top + line < box.top)
            scrollEl.scrollTop -= box.top - rect.top - line;
    };
    // Reveal the focus end of the current selection. Today's entry paths leave a
    // collapsed selection, but honoring direction keeps a future range-preserving
    // path from revealing its anchor instead of its focus.
    const revealSelectionFocus = (el) => {
        // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
        const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        revealCaret(caret ?? el.value.length);
    };
    // Unlock (mount / session switch) returns focus to the box, and owns the
    // reveal that comes with it. `preventScroll` because this focus is ours, not
    // a gesture: the textarea is as tall as the draft, so the browser's reveal
    // would walk up to the conversation scrollport and move the transcript under
    // a user who only switched session. That leaves the caret to us — the DOM is
    // reused across sessions, so switching to a longer draft keeps the previous
    // offset while the value swap puts the caret at the new draft's end, which is
    // off screen (measured on all three engines: offset 0 with the caret 940px
    // down). Suppress the walk, then reveal in our own box.
    (0, react_1.useEffect)(() => {
        const el = inputRef.current;
        if (locked || el === null)
            return;
        el.focus({ preventScroll: true });
        revealSelectionFocus(el);
    }, [locked, sessionId]);
    // A persisted draft arrives AFTER the unlock effect: ConversationSession
    // adopts it in its own mount effect, and a parent's mount effect runs after
    // its children's. Reveal when the draft becomes non-empty so a restored long
    // draft does not stay at its head with the caret at its end. This effect does
    // not focus: send-clear, failed-send restore, and first-character transitions
    // must not steal focus from another control the user moved to.
    (0, react_1.useEffect)(() => {
        const el = inputRef.current;
        if (locked || draft === '' || el === null)
            return;
        revealSelectionFocus(el);
    }, [draft !== '']);
    // Caret restore after an edit the composer performs itself. The machine owns
    // the draft and the undo log, so paste and cut suppress the native edit and
    // write the value through the machine — and a
    // programmatic selection change reveals nothing: measured in chromium and
    // WebKit, pasting a long block leaves the view where it was while the caret
    // sits at the end of the draft. Native typing gets its reveal from the
    // browser; these two have to ask for it, so they share one restore.
    const restoreCaret = (el, caret) => {
        requestAnimationFrame(() => {
            el.setSelectionRange(caret, caret);
            revealCaret(caret);
        });
    };
    // Wheel chaining on the draft scrollport, one lifetime (it is never
    // unmounted — the inert state renders the same element disabled). While the
    // capped box can still move in this direction, keep the native scroll; only
    // at its own edge forward the delta to the active conversation scrollport, so
    // a short draft never traps the gesture and a long draft stays scrollable.
    // Hero mounts have no host and keep native wheel scrolling.
    (0, react_1.useEffect)(() => {
        const el = scrollRef.current;
        if (el === null)
            return;
        const onWheel = (e) => {
            const host = el.closest('[data-conversation-scroll]');
            if (!(host instanceof HTMLElement) || e.deltaY === 0)
                return;
            const atTop = el.scrollTop <= 0;
            const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
            if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd))
                return;
            e.preventDefault();
            host.scrollTop += e.deltaY;
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => { el.removeEventListener('wheel', onWheel); };
    }, []);
    // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
    /* oxlint-disable typescript/no-unnecessary-condition */
    const selectionOf = (el) => ({
        start: el.selectionStart ?? 0,
        end: el.selectionEnd ?? el.selectionStart ?? 0,
    });
    /* oxlint-enable typescript/no-unnecessary-condition */
    const onKeyDown = (e) => {
        if (workspaceTrigger) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRequestWorkspace();
            }
            return;
        }
        // Absent machine without a Workspace recovery action stays disabled; the
        // guard narrows the faces for the paths below.
        if (input === undefined || keyboard === undefined || inputActions === undefined)
            return;
        // Shift+Enter is the native newline UNCONDITIONALLY — decided before the
        // IME guard so a composition-closing Shift+Enter still breaks the line.
        if (e.key === 'Enter' && e.shiftKey)
            return;
        // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
        // oxlint-disable-next-line typescript/no-deprecated
        const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
        if (!composing && !machineBusy && !locked
            && (e.key === 'Backspace' || e.key === 'Delete')) {
            const selection = selectionOf(e.currentTarget);
            if (selection.start === selection.end) {
                const occurrence = input.occurrences.find(o => e.key === 'Backspace'
                    ? o.offset + o.length === selection.start
                    : o.offset === selection.start);
                if (occurrence !== undefined) {
                    e.preventDefault();
                    const start = occurrence.offset;
                    const end = occurrence.offset + occurrence.length;
                    keyboard.setDraft(draft.slice(0, start) + draft.slice(end), { start, end, insertedLength: 0 });
                    restoreCaret(e.currentTarget, start);
                    keyboard.track(keyboard.snapshot.draft, start);
                    return;
                }
            }
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (keyboard.arbitrate(e.key === 'ArrowUp' ? 'up' : 'down', composing) === 'consumed')
                e.preventDefault();
            return;
        }
        if (e.key === 'Escape') {
            // Escape layering: an open overlay closes; claimed without an overlay
            // does NOT release (backspacing the token is the only exit gesture).
            keyboard.dismissPopup();
            if (keyboard.arbitrate('escape', composing) === 'consumed')
                e.preventDefault();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
            // The machine owns the undo/redo log (chip transactions have semantics
            // the browser stack cannot represent); never let the native stack run.
            e.preventDefault();
            if (machineBusy || locked)
                return;
            const redo = e.key === 'y' || e.shiftKey;
            if (redo)
                keyboard.redo();
            else
                keyboard.undo();
            return;
        }
        if (e.key === ' ') {
            if (composing)
                return;
            if (keyboard.space())
                e.preventDefault(); // claim token already carries the trailing separator
            return;
        }
        if (e.key !== 'Enter')
            return;
        if (composing)
            return;
        // Menu-open Enter picks the highlight through arbitration; a no-highlight
        // menu passes down to the machine's own adjudication.
        const arbitrated = keyboard.arbitrate('enter', composing);
        if (arbitrated !== 'pass') {
            e.preventDefault();
            return;
        }
        e.preventDefault();
        if (e.repeat)
            return; // held-down Enter must not machine-gun sends
        if (locked || machineBusy)
            return;
        const accelerated = e.ctrlKey || e.metaKey;
        // Empty-draft accelerated Enter acts on the queue instead of the (empty)
        // draft: the machine rejects empty drafts, so the gesture steers every
        // still-pending queued message into the running turn (the dock's per-row
        // steer button applied to the whole queue). Steering needs the same
        // window as the per-row button: a running ordinary session.
        if (accelerated && canSteerQueue) {
            keyboard.steerQueue();
            return;
        }
        keyboard.submit(resolveSubmitMode(running, accelerated ? 'accelerated' : 'enter', subagent === null));
    };
    const onChange = (e) => {
        if (keyboard === undefined || locked)
            return; // disabled/read-only states cannot edit the draft
        if (machineBusy)
            return; // submitting is the read-only span; adjudicating holds the pending lock
        const next = e.target.value;
        safariNativeShrinkRef.current = safari && next.length < draft.length;
        keyboard.setDraft(next);
        // selectionStart is number|null in lib.dom; the type-aware lint program narrows it.
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        keyboard.track(next, e.target.selectionStart ?? next.length);
    };
    const onCopyOrCut = (e, cut) => {
        if (input === undefined || keyboard === undefined)
            return; // absent machine: no draft can be copied or cut
        const el = e.currentTarget;
        const { start, end } = selectionOf(el);
        if (start === end)
            return;
        const touched = input.occurrences.filter(o => o.offset < end && o.offset + o.length > start);
        if (touched.length === 0 && !cut)
            return; // plain copy of plain text: native path is fine
        e.preventDefault();
        const copyStart = touched.reduce((value, o) => Math.min(value, o.offset), start);
        const copyEnd = touched.reduce((value, o) => Math.max(value, o.offset + o.length), end);
        // Expand structured ranges to their owner clipboard projections.
        let text = '';
        let cursor = copyStart;
        for (const o of touched) {
            text += draft.slice(cursor, o.offset) + o.clipboardText;
            cursor = o.offset + o.length;
        }
        text += draft.slice(cursor, copyEnd);
        e.clipboardData.setData('text/plain', text);
        if (cut && !machineBusy && !locked) {
            keyboard.setDraft(draft.slice(0, copyStart) + draft.slice(copyEnd), { start: copyStart, end: copyEnd, insertedLength: 0 });
            restoreCaret(el, copyStart);
        }
    };
    const onPaste = (e) => {
        if (keyboard === undefined)
            return; // absent machine: no draft can accept a paste
        if (machineBusy || locked)
            return;
        const files = Array.from(e.clipboardData.items)
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter((file) => file !== null);
        if (files.length > 0)
            intakeImages(files);
        const text = e.clipboardData.getData('text/plain');
        if (text === '') {
            if (files.length > 0)
                e.preventDefault();
            return;
        }
        e.preventDefault();
        const el = e.currentTarget;
        const sel = selectionOf(el);
        // Sync components stay empty at this layer: hot-snapshot matching needs
        // the Slash roster, which lives behind keyboard.track — the paste attempt
        // opens in the machine and the controller upgrades tokens as matches
        // land (paste-upgrade). The DOM layer only starts the transaction.
        keyboard.pasteBegin(text, sel);
        const caret = sel.start + text.length;
        restoreCaret(el, caret);
        keyboard.track(keyboard.snapshot.draft, caret);
    };
    // Intake pre-check (DeepSeek Chat semantics): an addition that would break
    // a projected limit is refused as a whole batch, announced immediately, and
    // never enters the rail — no more submit-time failure rolling the rail
    // back. The host enforces the same limits at submit for callers that bypass
    // this composer.
    const intakeImages = (0, react_1.useCallback)((files) => {
        if (addImages === undefined || files.length === 0)
            return;
        const rejected = (() => {
            try {
                (0, attachments_1.validateAttachments)([...attachments.map(attachment => attachment.file), ...files]);
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            return addImages(files);
        })();
        if (rejected !== null)
            showToast(rejected);
    }, [addImages, attachments, imageLimits, showToast, t]);
    const canAcceptDrop = !locked && !machineBusy && addImages !== undefined;
    const onSelect = (e) => {
        // Any caret/selection gesture ends a live paste attempt (the machine
        // cannot observe DOM selection). Cheap no-op when none is live.
        if (keyboard !== undefined && keyboard.snapshot.paste !== undefined)
            keyboard.invalidatePaste();
        void e;
    };
    // Button presses steal focus from the textarea; suppress at mousedown so
    // typing continues seamlessly. `preventScroll` for the same reason as the
    // unlock effect, and with no reveal of its own: the caret has not moved, and
    // the next keystroke gets the browser's native one.
    const keepFocus = (e) => {
        e.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
    };
    const onToggleCommandMenu = () => {
        const el = inputRef.current;
        if (el !== null)
            toggleCommandMenu?.(selectionOf(el));
    };
    // Ordinary sessions retain their primary Send/Stop toggle. A continuable
    // child keeps Send as the primary action and exposes Stop independently so
    // pointer users can queue follow-ups while its current turn is running.
    const primaryStops = running && subagent === null;
    const interruptible = running && continuable;
    const primaryLabel = primaryStops ? t('input.stop') : t('input.send');
    const onPrimary = () => {
        if (primaryStops) {
            stop?.();
            return;
        }
        if (inputActions === undefined)
            return; // absent machine: the button is disabled
        /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
        if (!empty && !disabled && !machineBusy)
            inputActions.submit();
    };
    // The Access seat: the projection-fed permission chip (renders nothing
    // while the permissions key is absent — permission-less host or Draft —
    // or while the command face is absent with the session).
    const compact = variant !== 'hero';
    const accessSelect = command === undefined
        ? null
        : (0, jsx_runtime_1.jsx)(PermissionSelect_1.PermissionSelect, { value: permissions, locked: locked, compact: compact, command: command, t: t }, sessionId);
    // Mirror-layer decorations: a visible backdrop with transparent textarea
    // text. Claim tokens and references retain the draft's own glyph metrics,
    // so their decoration cannot drift from wrapping, selection, or the caret.
    const deco = input === undefined ? INERT_DECORATIONS : (0, decorations_1.deriveDecorations)(input, lexicon);
    const backdrop = [];
    {
        // Segment boundaries: the token range end, every structured-reference
        // offset, and every text-ref range — merged in draft order (the sources never
        // overlap: structured references own their ranges, text-refs own plain tokens, the
        // claim token only leads).
        let cursor = 0;
        const pushPlain = (upTo) => {
            if (upTo > cursor)
                backdrop.push(draft.slice(cursor, upTo));
            cursor = upTo;
        };
        if (deco.token !== null) {
            backdrop.push((0, jsx_runtime_1.jsx)("mark", { className: InputBar_styles_1.default.hlToken, "data-decoration": "token", children: draft.slice(deco.token.start, deco.token.end) }, "token"));
            cursor = deco.token.end;
        }
        const boundaries = [
            ...deco.chips.map(chip => ({ at: chip.offset, kind: 'chip', chip })),
            ...deco.textRefs.map(ref => ({ at: ref.start, kind: 'text-ref', ref })),
        ].sort((a, b) => a.at - b.at);
        for (const b of boundaries) {
            if (b.at < cursor)
                continue; // claim-token overlap: the leading mark wins
            pushPlain(b.at);
            if (b.kind === 'chip') {
                const chip = b.chip;
                backdrop.push((0, jsx_runtime_1.jsxs)("span", { className: (0, classnames_1.default)(InputBar_styles_1.default.chip, chip.invalid && InputBar_styles_1.default.chipInvalid), "data-decoration": "chip", "data-reference-appearance": chip.appearance, "data-occurrence": chip.occurrenceId, "data-invalid": chip.invalid || undefined, title: chip.label, children: [chip.appearance === undefined
                            ? chip.text[0]
                            : ((0, jsx_runtime_1.jsxs)("span", { className: InputBar_styles_1.default.chipTrigger, children: [(0, jsx_runtime_1.jsx)("span", { className: InputBar_styles_1.default.chipTriggerGlyph, children: chip.text[0] }), (0, jsx_runtime_1.jsx)(ReferenceIcon_1.ReferenceIcon, { kind: chip.appearance, size: 16, className: InputBar_styles_1.default.chipIcon })] })), (0, jsx_runtime_1.jsx)("span", { children: chip.text.slice(1) })] }, `chip-${chip.occurrenceId}`));
                cursor = chip.offset + chip.length;
            }
            else {
                // Plain-range highlight: the glyphs stay the
                // textarea's (advance untouched); the mark paints the chip look.
                const text = draft.slice(b.ref.start, b.ref.end);
                backdrop.push((0, jsx_runtime_1.jsx)("mark", { className: InputBar_styles_1.default.textRef, "data-decoration": "text-ref", children: b.ref.appearance === 'folder'
                        ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("span", { className: InputBar_styles_1.default.textRefTrigger, children: [(0, jsx_runtime_1.jsx)("span", { className: InputBar_styles_1.default.textRefTriggerGlyph, children: text[0] }), (0, jsx_runtime_1.jsx)(ReferenceIcon_1.ReferenceIcon, { kind: "folder", size: 16, className: InputBar_styles_1.default.textRefIcon })] }), text.slice(1)] }))
                        : text }, `ref-${b.ref.start}`));
                cursor = b.ref.end;
            }
        }
        pushPlain(draft.length);
        if (deco.hint !== null) {
            // Claim tokens have the `/name ` format (trailing space); trim to the bare name.
            const commandName = input?.claim?.token.slice(1).trim() ?? '';
            const hintKey = commandName === 'goal' ? hasGoal ? 'hint.goal.active' : 'hint.goal' : commandName === 'plan' ? 'hint.plan' : undefined;
            // Dynamic lookup by claimed command name: unknown commands miss the
            // dictionary and keep the machine's own hint, so the call is wide.
            const translated = hintKey === undefined ? undefined : t(hintKey);
            const displayHint = translated !== undefined && translated !== hintKey ? translated : deco.hint;
            backdrop.push((0, jsx_runtime_1.jsx)("span", { className: InputBar_styles_1.default.hint, "data-decoration": "hint", children: displayHint }, "hint"));
        }
    }
    const modelControl = renderSlot('conversation.input.model', { locked: modelSeatLocked, compact });
    const contextControl = (0, jsx_runtime_1.jsx)(ContextMeter_1.ContextMeter, { useProjection: useProjection, t: t });
    const primaryControls = (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [interruptible && ((0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('input.stop'), side: "top", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: InputBar_styles_1.default.primary, "aria-label": t('input.stop'), disabled: stop === undefined, onMouseDown: keepFocus, onClick: stop, children: (0, jsx_runtime_1.jsx)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("rect", { x: "3", y: "3", width: "10", height: "10", rx: "3", fill: "currentColor" }) }) }) })), (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: primaryLabel, side: "top", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: InputBar_styles_1.default.primary, "aria-label": primaryLabel, disabled: primaryStops ? stop === undefined : empty || disabled || machineBusy, onMouseDown: keepFocus, onClick: onPrimary, children: primaryStops ? ((0, jsx_runtime_1.jsx)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("rect", { x: "3", y: "3", width: "10", height: "10", rx: "3", fill: "currentColor" }) })) : ((0, jsx_runtime_1.jsx)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("path", { d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z", fill: "currentColor" }) })) }) })] });
    return ((0, jsx_runtime_1.jsxs)("div", { className: (0, classnames_1.default)(InputBar_styles_1.default.root, variant === 'hero' && InputBar_styles_1.default.hero), "data-composer-layout": compact ? 'compact' : 'hero', children: [toast !== null && ((0, jsx_runtime_1.jsx)(primitives_1.Toast, { text: toast.text, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconWarningOutline16, {}), anchor: cardRef.current, onDone: dismissToast }, toast.seq)), notice?.level === 'info' && ((0, jsx_runtime_1.jsx)("div", { className: InputBar_styles_1.default.notice, role: "status", children: notice.text })), (0, jsx_runtime_1.jsxs)("div", { ref: cardRef, className: (0, classnames_1.default)(InputBar_styles_1.default.card, workspaceTrigger && InputBar_styles_1.default.cardWorkspaceTrigger), "data-composer-card": true, "data-xh-silver-input": workspaceTrigger ? undefined : '', onClick: workspaceTrigger ? onRequestWorkspace : undefined, onPointerDown: workspaceTrigger ? (e) => { e.stopPropagation(); } : undefined, children: [overlay !== undefined && (0, jsx_runtime_1.jsx)("div", { className: InputBar_styles_1.default.overlayAnchor, children: overlay }), accessory !== undefined && (0, jsx_runtime_1.jsx)("div", { className: InputBar_styles_1.default.accessory, children: accessory }), renderSlot('conversation.input.attachments', {
                        attachments,
                        canAcceptDrop,
                        onAddImages: intakeImages,
                        onRemoveImage: (id) => { removeImage?.(id); },
                        dropLimits: imageLimits === undefined ? undefined : {
                            count: imageLimits.maxImagesPerMessage,
                            size: (0, image_labels_1.imageSizeText)(imageLimits.maxImageBytes),
                        },
                    }), (0, jsx_runtime_1.jsx)("div", { ref: scrollRef, className: InputBar_styles_1.default.scroll, "data-input-scroll": true, children: (0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.grow, children: [(0, jsx_runtime_1.jsx)("div", { "aria-hidden": true, className: (0, classnames_1.default)(InputBar_styles_1.default.backdrop, textareaDisabled && InputBar_styles_1.default.backdropDisabled), "data-input-backdrop": true, "data-disabled": textareaDisabled || undefined, children: backdrop }), (0, jsx_runtime_1.jsx)("textarea", { ref: inputRef, className: InputBar_styles_1.default.input, value: draft, disabled: textareaDisabled, readOnly: machineBusy || workspaceTrigger, "aria-label": workspaceTrigger ? t('hero.chooseWorkspace') : undefined, "aria-haspopup": workspaceTrigger ? 'menu' : undefined, "aria-expanded": workspaceTrigger ? workspacePickerOpen : undefined, "data-phase": input?.phase ?? 'inert', placeholder: placeholder ?? (parentOffline
                                        ? t('placeholder.parentOffline')
                                        : disabled
                                            ? t('placeholder.unavailable')
                                            // The steer hint deliberately outranks the plan placeholder:
                                            // while it shows, the whole-queue gesture is genuinely available
                                            // (the gate never consults plan mode), so the actionable hint wins.
                                            : canSteerQueue
                                                ? t('placeholder.steerQueue')
                                                : planActive ? t('placeholder.plan') : t('placeholder.default')), rows: 2, onChange: onChange, onKeyDown: onKeyDown, onSelect: onSelect, onCopy: (e) => { onCopyOrCut(e, false); }, onCut: (e) => { onCopyOrCut(e, true); }, onPaste: onPaste, onCompositionStart: onCompositionStart, onCompositionEnd: onCompositionEnd }), (0, jsx_runtime_1.jsx)("div", { ref: mirrorRef, "aria-hidden": true, className: InputBar_styles_1.default.mirror, "data-input-mirror": true, children: `${draft}\n` })] }) }), (0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.row, "data-composer-toolbar": true, children: [(0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.tools, children: [(0, jsx_runtime_1.jsx)(ComposerAddMenu_1.ComposerAddMenu, { className: InputBar_styles_1.default.add, canAttach: canAcceptDrop, canCommands: !locked && !machineBusy && toggleCommandMenu !== undefined, onAddFiles: intakeImages, onCommands: onToggleCommandMenu, onOpen: () => { if (commandMenuOpen)
                                            onToggleCommandMenu(); }, focusInput: () => inputRef.current?.focus({ preventScroll: true }), t: t }, sessionId), (0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.modes, children: [accessSelect, renderSlot('conversation.input.plan', { locked })] }), leftItems, compact && (0, jsx_runtime_1.jsx)("div", { className: InputBar_styles_1.default.footer, "data-composer-footer": true, children: footer })] }), (0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.trailing, children: [rightItems, compact ? (0, jsx_runtime_1.jsxs)("div", { className: InputBar_styles_1.default.actions, "data-composer-actions": true, children: [contextControl, (0, jsx_runtime_1.jsx)("div", { className: InputBar_styles_1.default.modelSeat, children: modelControl }), primaryControls] }) : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [modelControl, contextControl, primaryControls] })] })] })] }), !compact && footer] }));
}

},
"src/modules/conversation/classnames.js": function(module, exports, require) {
// source: src/modules/conversation/classnames.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = classes;
/** Composer classes only accept strings and boolean guards; no third-party runtime. */
function classes(...values) { return values.filter((value) => typeof value === 'string' && value.length > 0).join(' '); }

},
"src/modules/conversation/primitives.js": function(module, exports, require) {
// source: src/modules/conversation/primitives.ts

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
exports.writeClipboard = exports.IconWarningOutline16 = exports.IconTrashOutline16 = exports.IconThinkOutline14 = exports.IconSendOutline14 = exports.IconQueueOutline14 = exports.IconPlusOutline16 = exports.IconFolderOpen16 = exports.IconFolderClose16 = exports.IconEditOutline16 = exports.IconCopyOutline16 = exports.IconCloseOutline16 = exports.IconChevronUpOutline14 = exports.IconChevronRightOutline14 = exports.IconChevronDownOutline14 = exports.IconChecklistOutline14 = exports.IconCheckOutline16 = exports.IconBrowseOutline16 = exports.IconBranchOutline16 = exports.IconApiOutline14 = exports.IconCodeOutline16 = exports.IconPaperclipOutline16 = exports.FishLogo = exports.RiskConfirmation = exports.Toast = exports.StateDot = exports.Menu = exports.Tooltip = exports.DisclosureRow = exports.MessageText = exports.MarkdownText = exports.CodeBlock = exports.JsonBlock = exports.Modal = exports.Button = void 0;
/** Render primitives remain platform-owned; only consumed props are described here. */
const platform = __importStar(require("@xharness/dsh-client-ui-primitives"));
exports.Button = platform.Button, exports.Modal = platform.Modal, exports.JsonBlock = platform.JsonBlock, exports.CodeBlock = platform.CodeBlock, exports.MarkdownText = platform.MarkdownText, exports.MessageText = platform.MessageText, exports.DisclosureRow = platform.DisclosureRow, exports.Tooltip = platform.Tooltip, exports.Menu = platform.Menu, exports.StateDot = platform.StateDot, exports.Toast = platform.Toast, exports.RiskConfirmation = platform.RiskConfirmation, exports.FishLogo = platform.FishLogo, exports.IconPaperclipOutline16 = platform.IconPaperclipOutline16, exports.IconCodeOutline16 = platform.IconCodeOutline16, exports.IconApiOutline14 = platform.IconApiOutline14, exports.IconBranchOutline16 = platform.IconBranchOutline16, exports.IconBrowseOutline16 = platform.IconBrowseOutline16, exports.IconCheckOutline16 = platform.IconCheckOutline16, exports.IconChecklistOutline14 = platform.IconChecklistOutline14, exports.IconChevronDownOutline14 = platform.IconChevronDownOutline14, exports.IconChevronRightOutline14 = platform.IconChevronRightOutline14, exports.IconChevronUpOutline14 = platform.IconChevronUpOutline14, exports.IconCloseOutline16 = platform.IconCloseOutline16, exports.IconCopyOutline16 = platform.IconCopyOutline16, exports.IconEditOutline16 = platform.IconEditOutline16, exports.IconFolderClose16 = platform.IconFolderClose16, exports.IconFolderOpen16 = platform.IconFolderOpen16, exports.IconPlusOutline16 = platform.IconPlusOutline16, exports.IconQueueOutline14 = platform.IconQueueOutline14, exports.IconSendOutline14 = platform.IconSendOutline14, exports.IconThinkOutline14 = platform.IconThinkOutline14, exports.IconTrashOutline16 = platform.IconTrashOutline16, exports.IconWarningOutline16 = platform.IconWarningOutline16, exports.writeClipboard = platform.writeClipboard;

},
"src/modules/conversation/input/decorations.js": function(module, exports, require) {
// source: src/modules/conversation/input/decorations.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanTextRefs = scanTextRefs;
exports.deriveDecorations = deriveDecorations;
/** Token matcher: a trigger char at line start or after whitespace, then a word-ish name (never crosses \n). */
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g;
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g;
/**
 * Scan the draft for plain-text reference tokens against the hot lexicons.
 * Word-boundary discipline: the trigger must sit at the draft
 * start or after whitespace ('x/name' never matches); the name must be an
 * exact lexicon member.
 * @param draft - draft text.
 * @param lexicon - per-trigger name lists (a missing trigger scans nothing).
 * @returns matched ranges in draft order.
 */
function scanTextRefs(draft, lexicon) {
    if (draft === '')
        return [];
    const out = [];
    if (lexicon.size > 0) {
        TEXT_REF_RE.lastIndex = 0;
        let m;
        while ((m = TEXT_REF_RE.exec(draft)) !== null) {
            const trigger = m[2] === '/' ? '/' : '@';
            const name = m[3] ?? '';
            if (lexicon.get(trigger)?.includes(name)) {
                const start = m.index + (m[1]?.length ?? 0);
                out.push({ start, end: start + 1 + name.length, trigger });
            }
        }
    }
    FOLDER_REF_RE.lastIndex = 0;
    let folder;
    while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
        const token = folder[2] ?? '';
        const start = folder.index + (folder[1]?.length ?? 0);
        const end = start + token.length;
        if (!out.some(range => range.start < end && range.end > start)) {
            out.push({ start, end, trigger: '@', appearance: 'folder' });
        }
    }
    return out.sort((left, right) => left.start - right.start);
}
/** The empty lexicon (default: zero text-ref decorations, old call sites unchanged). */
const EMPTY_LEXICON = new Map();
/**
 * Derive the mirror-layer decorations from the input state.
 * @param state - published input state.
 * @param lexicon - optional per-trigger reference lexicons (plain-text-reference scan).
 * @returns token range, chip instructions, text-ref ranges, and the ghost hint.
 */
function deriveDecorations(state, lexicon = EMPTY_LEXICON) {
    const { draft, claim, phase, occurrences } = state;
    const claimActive = (phase === 'claimed' || phase === 'submitting')
        && claim !== undefined && draft.startsWith(claim.token);
    const token = claimActive ? { start: 0, end: claim.token.length } : null;
    const chips = occurrences.map(o => ({
        occurrenceId: o.occurrenceId,
        offset: o.offset,
        length: o.length,
        text: draft.slice(o.offset, o.offset + o.length),
        label: o.label,
        ...o.appearance === undefined ? {} : { appearance: o.appearance },
        invalid: o.invalid === true,
    }));
    const hint = claimActive && claim.hint !== undefined && draft.slice(claim.token.length).trim() === ''
        ? claim.hint
        : null;
    return { token, chips, textRefs: scanTextRefs(draft, lexicon), hint };
}

},
"src/modules/conversation/image-labels.js": function(module, exports, require) {
// source: src/modules/conversation/image-labels.ts

"use strict";
/** Attachment error and limit copy owned by the conversation input flow. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageSizeText = imageSizeText;
exports.attachmentErrorText = attachmentErrorText;
/**
 * Byte count as user-facing megabytes (`10MB`, `2.5MB`).
 * @param bytes - the byte count.
 * @returns the rounded megabyte text.
 */
function imageSizeText(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`;
}
/**
 * Product copy for a host attachment rejection (the `attachment-error`
 * `details.reason`). User-solvable reasons name the limit and the way out;
 * reasons the user cannot act on fold into one send-failed line carrying the
 * reason code for a bug report.
 * @param t - the conversation-namespace translate.
 * @param reason - the wire `details.reason` code.
 * @param limits - projected limits interpolated into count/size copy, when known.
 * @returns the banner text.
 */
function attachmentErrorText(t, reason, limits) {
    switch (reason) {
        case 'MODEL_DOES_NOT_SUPPORT_IMAGES': return t('image.modelUnsupported');
        case 'SUBAGENT_IMAGE_UNSUPPORTED': return t('image.subagentUnsupported');
        case 'IMAGE_TOO_MANY_PIXELS': return t('image.tooManyPixels');
        case 'IMAGE_DIMENSION_TOO_LARGE':
            if (limits !== undefined)
                return t('image.dimensionTooLarge', { size: limits.maxImageDimension });
            break;
        // Undecodable bytes or a declared type its bytes contradict: solvable by
        // replacing or re-exporting the file, so it reads as a format problem.
        case 'INVALID_IMAGE':
        case 'IMAGE_TYPE_MISMATCH':
            return t('image.unsupportedType');
        case 'TOO_MANY_IMAGES':
            if (limits !== undefined)
                return t('image.tooMany', { count: limits.maxImagesPerMessage });
            break;
        case 'IMAGE_TOO_LARGE':
            if (limits !== undefined)
                return t('image.fileTooLarge', { size: imageSizeText(limits.maxImageBytes) });
            break;
        case 'IMAGES_TOO_LARGE':
            if (limits !== undefined)
                return t('image.totalTooLarge', { size: imageSizeText(limits.maxMessageImageBytes) });
            break;
        default: break;
    }
    return t('image.sendFailed', { reason });
}

},
"src/modules/conversation/reference/ReferenceIcon.js": function(module, exports, require) {
// source: src/modules/conversation/reference/ReferenceIcon.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReferenceIcon = ReferenceIcon;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../primitives");
/**
 * Render the icon that identifies one inline reference domain.
 * @param props - Reference kind, optional size, and optional CSS class.
 * @returns The corresponding current-color SVG glyph.
 */
function ReferenceIcon({ kind, size = 16, className }) {
    switch (kind) {
        case 'session':
            return ((0, jsx_runtime_1.jsx)("svg", { width: size, height: size, className: className, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("path", { d: "M8 0.597656C3.91296 0.597656 0.599716 3.91103 0.599609 7.99805C0.599609 9.13171 0.854567 10.2079 1.31152 11.1699L1.59277 11.7607L2.77441 11.1992L2.49414 10.6084L2.36035 10.3076C2.06865 9.59612 1.90723 8.81645 1.90723 7.99805C1.90733 4.63362 4.63554 1.90625 8 1.90625C11.3644 1.90635 14.0917 4.63368 14.0918 7.99805C14.0918 11.3625 11.3644 14.0907 8 14.0908C7.311 14.0908 6.80642 14.0414 6.35938 13.918C5.919 13.7963 5.50105 13.5929 5.00098 13.2441C4.26805 12.7329 3.21756 12.5526 2.35156 13.0996L2.33789 13.1084L2.32422 13.1182L1.74805 13.5234L2.18164 14.8184L3.05957 14.2002C3.37505 14.0068 3.84248 14.0319 4.25195 14.3174C4.84447 14.7307 5.39718 15.009 6.01172 15.1787C6.61963 15.3465 7.25579 15.3984 8 15.3984C12.087 15.3983 15.4004 12.0851 15.4004 7.99805C15.4003 3.9111 12.087 0.59776 8 0.597656ZM4.56836 8.50977V9.80371H8.12402V8.50977H4.56836ZM4.56836 7.30078H11.4619V6.00684H4.56836V7.30078Z", fill: "currentColor" }) }));
        case 'file': return (0, jsx_runtime_1.jsx)(primitives_1.IconBrowseOutline16, { size: size, className: className });
        case 'folder': return (0, jsx_runtime_1.jsx)(primitives_1.IconFolderClose16, { size: size, className: className });
    }
}

},
"src/modules/conversation/skeleton/ContextMeter.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ContextMeter.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextMeter = ContextMeter;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Stable context-ring seat. Occupancy is a reading; category distribution is an estimate. */
const react_1 = require("react");
const primitives_1 = require("../primitives");
const StatsLine_1 = require("../chat/StatsLine");
const ContextMeter_styles_1 = __importDefault(require("./ContextMeter.styles"));
const RADIUS = 5.5, CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ROWS = [
    { key: 'systemTokens', label: 'context.system', tint: '#8290a5' },
    { key: 'userTokens', label: 'context.yourMessages', tint: '#3b82f6' },
    { key: 'agentReportTokens', label: 'context.agentReports', tint: '#36b7c4' },
    { key: 'runtimeContextTokens', label: 'context.runtimeContext', tint: '#d48e5b' },
    { key: 'checkpointTokens', label: 'context.checkpoints', tint: '#bb79cd' },
    { key: 'unattributedTokens', label: 'context.unattributed', tint: '#a1a1aa' },
    { key: 'assistantTokens', label: 'context.assistant', tint: '#20a887' },
    { key: 'toolResultTokens', label: 'context.toolResults', tint: '#e1a63b' },
    { key: 'toolDefinitionTokens', label: 'context.tools', tint: '#a78bfa' },
    { key: 'mcpToolDefinitionTokens', label: 'context.mcp', tint: '#c770ca' },
    { key: 'protocolTokens', label: 'context.protocol', tint: '#9b9b9b' },
];
function tintStyle(tint, width) { return { '--meter-tint': tint, ...(width === undefined ? {} : { width }) }; }
function ContextMeter({ useProjection, t }) {
    const pressure = useProjection('contextPressure'), composition = pressure?.composition;
    const [open, setOpen] = (0, react_1.useState)(false), rootRef = (0, react_1.useRef)(null);
    const context = (0, StatsLine_1.contextOccupancy)(pressure), available = context !== null;
    (0, react_1.useEffect)(() => { if (!available && open)
        setOpen(false); }, [available, open]);
    (0, react_1.useEffect)(() => {
        if (!open || !available)
            return;
        const pointer = (event) => { if (event.target instanceof Node && rootRef.current?.contains(event.target))
            return; setOpen(false); };
        const escape = (event) => { if (event.key === 'Escape')
            setOpen(false); };
        document.addEventListener('pointerdown', pointer);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
    }, [available, open]);
    const values = ROWS.map(row => ({ ...row, value: composition?.[row.key] ?? 0 }))
        .filter(row => Number.isSafeInteger(row.value) && row.value > 0);
    const weight = available ? values.reduce((total, row) => total + row.value, 0) : 0;
    const percent = context?.percent ?? 0;
    const reading = available ? (context.exact ? '' : '≈') + percent + '%' : null;
    const label = available ? t('context.aria', { percent: reading }) : t(['preparing', 'in_flight', 'model_changed'].includes(pressure?.phase ?? '') ? 'context.pending' : 'context.unavailable');
    const segments = weight > 0 && composition ? values.map(row => ({ ...row, ratio: row.value / weight })) : [{ key: 'total', tint: 'currentColor', ratio: 1 }];
    let offset = 0;
    const ring = segments.map(segment => {
        const length = CIRCUMFERENCE * percent / 100 * segment.ratio, start = offset;
        offset += length;
        return (0, jsx_runtime_1.jsx)("circle", { className: ContextMeter_styles_1.default.fill, cx: "7", cy: "7", r: RADIUS, stroke: segment.tint, strokeDasharray: `${length} ${CIRCUMFERENCE}`, strokeDashoffset: -start, transform: "rotate(-90 7 7)" }, segment.key);
    });
    return (0, jsx_runtime_1.jsxs)("span", { ref: rootRef, className: ContextMeter_styles_1.default.root, children: [(0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: label, side: "top", delayMs: 200, disabled: open, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: ContextMeter_styles_1.default.trigger, "aria-label": label, "aria-haspopup": available ? 'dialog' : undefined, "aria-expanded": available ? open : undefined, disabled: !available, onClick: () => setOpen(!open), children: (0, jsx_runtime_1.jsxs)("svg", { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("circle", { className: ContextMeter_styles_1.default.track, cx: "7", cy: "7", r: RADIUS }), ring] }) }) }), open && context && (0, jsx_runtime_1.jsxs)("div", { className: ContextMeter_styles_1.default.panel, role: "dialog", "aria-modal": "false", "aria-label": t('context.used'), children: [(0, jsx_runtime_1.jsxs)("div", { className: ContextMeter_styles_1.default.header, children: [(0, jsx_runtime_1.jsx)("span", { className: ContextMeter_styles_1.default.headline, children: context.label }), (0, jsx_runtime_1.jsx)("span", { className: ContextMeter_styles_1.default.percent, children: reading }), (0, jsx_runtime_1.jsx)("span", { className: ContextMeter_styles_1.default.figures, children: `${context.exact ? '' : '≈'}${(0, StatsLine_1.formatTokens)(context.usedTokens)} / ${(0, StatsLine_1.formatTokens)(context.contextWindow)}` })] }), (0, jsx_runtime_1.jsx)("div", { className: ContextMeter_styles_1.default.bar, children: segments.map(row => (0, jsx_runtime_1.jsx)("div", { className: ContextMeter_styles_1.default.segment, style: tintStyle(row.tint, `${percent * row.ratio}%`) }, row.key)) }), weight > 0 && (0, jsx_runtime_1.jsxs)("dl", { className: ContextMeter_styles_1.default.rows, children: [(0, jsx_runtime_1.jsx)("div", { className: ContextMeter_styles_1.default.headline, children: t('context.distributionEstimate') }), segments.map(row => (0, jsx_runtime_1.jsxs)("div", { className: ContextMeter_styles_1.default.row, children: [(0, jsx_runtime_1.jsxs)("dt", { children: [(0, jsx_runtime_1.jsx)("span", { className: ContextMeter_styles_1.default.swatch, style: tintStyle(row.tint), "aria-hidden": true }), row.label ? t(row.key === 'userTokens' && composition?.attributionVersion !== 2 ? 'context.userRoleHistory' : row.label) : ''] }), (0, jsx_runtime_1.jsx)("dd", { children: `≈${(0, StatsLine_1.formatTokens)(Math.round(context.usedTokens * row.ratio))}` })] }, row.key))] })] })] });
}

},
"src/modules/conversation/chat/StatsLine.js": function(module, exports, require) {
// source: src/modules/conversation/chat/StatsLine.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsLine = void 0;
exports.deriveStats = deriveStats;
exports.formatTokens = formatTokens;
exports.formatDuration = formatDuration;
exports.cacheHitPercent = cacheHitPercent;
exports.billedInputTokens = billedInputTokens;
exports.contextOccupancy = contextOccupancy;
const jsx_runtime_1 = require("react/jsx-runtime");
// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).
const reception_metrics_1 = require("../../shared/reception-metrics");
const react_1 = require("react");
const primitives_1 = require("../primitives");
const message_chrome_1 = require("./message-chrome");
const turn_metrics_1 = require("./turn-metrics");
const StatsLine_styles_1 = __importDefault(require("./StatsLine.styles"));
/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
function deriveStats(nodes) {
    const turns = new Set();
    let steps = 0;
    let llmMs = 0;
    let toolMs = 0;
    let ttftMs = 0;
    let ttftSteps = 0;
    let decodeMs = 0;
    let decodeTokens = 0;
    for (const node of nodes) {
        if (node.kind === 'tool-result') {
            if (node.callTime !== null)
                toolMs += Math.max(0, node.time - node.callTime);
            continue;
        }
        if (node.kind !== 'assistant')
            continue;
        turns.add(node.turn);
        steps += 1;
        if (node.timing !== undefined && node.timing.stepStartTime !== null) {
            llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime);
        }
        const reading = (0, turn_metrics_1.assistantStepReading)(node);
        if (reading.ttftMs !== null) {
            ttftMs += reading.ttftMs;
            ttftSteps += 1;
        }
        if (reading.decodeMs !== null && reading.outputTokens !== null) {
            decodeMs += reading.decodeMs;
            decodeTokens += reading.outputTokens;
        }
    }
    return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens };
}
/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
function formatTokens(n) {
    const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
    if (n < 1000)
        return String(n);
    if (n < 1000000)
        return `${scaled(n / 1000)}K`;
    return `${scaled(n / 1000000)}M`;
}
/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
function formatDuration(ms) {
    const s = ms / 1000;
    if (s < 60)
        return `${Math.round(s * 10) / 10}s`;
    const whole = Math.round(s);
    return `${Math.floor(whole / 60)}m${whole % 60}s`;
}
/**
 * Cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns rounded integer percent, or null when no input was billed.
 */
function cacheHitPercent(usage) {
    const denominator = billedInputTokens(usage);
    return denominator === 0
        ? null
        : Math.round(usage.cacheReadTokens / denominator * 100);
}
/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
function billedInputTokens(usage) {
    return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
/**
 * Approximate context occupancy, using the TUI's integer rounding and upper
 * clamp. The numerator is `projectedTokens` — the provider sample carried
 * forward over the surface's movement since — so compaction shows immediately
 * instead of waiting for the next request to report usage; it falls back to the
 * bare sample only for a log whose projection predates that field. Numerator
 * and capacity remain independent last-wins projection fields, so this is a
 * reference figure rather than an exact measurement of one request (see the
 * token-meter README).
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy with its numerator and denominator, or null until both values are known.
 */
function contextOccupancy(pressure) {
    const measured = Number.isFinite(pressure?.pressureTokens);
    const usedTokens = measured ? pressure?.pressureTokens : pressure?.projectedTokens;
    const accuracy = measured ? (pressure?.pressureAccuracy ?? 'provider_reported') : (pressure?.projectedAccuracy ?? pressure?.accuracy ?? 'estimated');
    const exact = measured ? accuracy === 'provider_reported' : ['exact_request', 'exact_tokenizer'].includes(accuracy);
    const stale = pressure?.phase === 'history_changed';
    const label = (measured ? '最近请求实际输入' : stale ? '最近请求输入计数' : '本次请求输入计数') + (!measured && !exact ? '（估算）' : '') + (stale ? ' · 历史已变化' : '');
    const contextWindow = pressure?.contextWindow;
    if (usedTokens === undefined || !Number.isFinite(usedTokens) || usedTokens < 0 || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0)
        return null;
    return { percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)), usedTokens, contextWindow, exact, label, accuracy, stale };
}
exports.StatsLine = (0, react_1.memo)(function StatsLine({ useSession, useProjection, t }) {
    const disclosureRef = (0, react_1.useRef)(null);
    const [open, setOpen] = (0, react_1.useState)(false);
    const panelId = (0, react_1.useId)();
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            const disclosure = disclosureRef.current;
            if (disclosure !== null && event.target instanceof Node && !disclosure.contains(event.target))
                setOpen(false);
        };
        const closeEscape = (event) => {
            const disclosure = disclosureRef.current;
            if (event.key !== 'Escape' || disclosure === null)
                return;
            setOpen(false);
            disclosure.querySelector('button')?.focus();
        };
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('keydown', closeEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOutside);
            document.removeEventListener('keydown', closeEscape);
        };
    }, [open]);
    const settledNodes = useSession(s => s.chat.legacy.nodes);
    const usage = useProjection('tokenUsage');
    // Every figure rides the durable sessionStats projection, so paging and
    // compaction cannot change any of them; an assembly without the unit falls
    // back to the window-scoped fold wholesale (same field names), paid only
    // while no projection value is served.
    const projected = useProjection('sessionStats');
    const stats = (0, react_1.useMemo)(() => projected ?? deriveStats(settledNodes), [projected, settledNodes]);
    // Groups with no data drop out whole; all reported metrics remain available.
    const groups = [];
    const rateTotals = projected?.activeThroughput ?? stats;
    const rate = (0, reception_metrics_1.throughput)(rateTotals.decodeTokens, rateTotals.decodeMs);
    const rateLabel = rate === null ? null : t('stats.tokensPerSecond', { throughput: (0, message_chrome_1.formatTokensPerSecond)(rate) });
    if (stats.steps > 0) {
        groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }));
        const durations = [];
        if (stats.llmMs > 0)
            durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }));
        if (stats.toolMs > 0)
            durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }));
        if (durations.length > 0)
            groups.push(durations.join(' · '));
        const speeds = [];
        if (stats.ttftSteps > 0) {
            speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
        }
        if (rateLabel !== null)
            speeds.push(rateLabel);
        if (speeds.length > 0)
            groups.push(speeds.join(' · '));
    }
    // Context occupancy deliberately lives on the composer's ContextMeter ring,
    // not here — one home per fact.
    // Billing rides the durable projection, so these survive paging and
    // compaction. Gated on actual token activity: a session whose steps all
    // settled without billing (e.g. every request failed) shows its counts
    // without a zero-token group.
    if (usage !== undefined
        && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        const cacheHit = cacheHitPercent(usage);
        if (cacheHit !== null)
            groups.push(t('stats.cacheHit', { percent: cacheHit }));
        groups.push(t('stats.tokens', {
            input: formatTokens(billedInputTokens(usage)),
            output: formatTokens(usage.outputTokens),
        }));
    }
    if (groups.length === 0)
        return null;
    // Explicit disclosure keeps off-card content accessible in WebKit as well
    // as Chromium. It owns only open state, never token accounting.
    return ((0, jsx_runtime_1.jsxs)("div", { ref: disclosureRef, className: StatsLine_styles_1.default.root, "data-composer-stats": true, "data-expanded": open || undefined, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: StatsLine_styles_1.default.summary, "aria-label": t('stats.title'), title: t('stats.title'), "aria-expanded": open, "aria-controls": open ? panelId : undefined, onClick: () => { setOpen(!open); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChecklistOutline14, {}) }), open && (0, jsx_runtime_1.jsx)("div", { id: panelId, className: StatsLine_styles_1.default.details, role: "region", "aria-label": t('stats.title'), children: groups.map(group => (0, jsx_runtime_1.jsx)("div", { children: group }, group)) })] }));
});

},
"src/modules/shared/reception-metrics.js": function(module, exports, require) {
// source: src/modules/shared/reception-metrics.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.throughput = throughput;
exports.totalOutputTokens = totalOutputTokens;
exports.messageProvenance = messageProvenance;
exports.receptionReading = receptionReading;
const runtime_types_1 = require("./runtime-types");
/** Pure metric arithmetic shared by Chat and Performance. Never reads UI time. */
function throughput(tokens, milliseconds) {
    return Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(milliseconds) && milliseconds > 0
        ? tokens / (milliseconds / 1000) : null;
}
function totalOutputTokens(usage) {
    if (!(0, runtime_types_1.isObjectRecord)(usage))
        return null;
    const output = usage.outputTokens;
    const reasoning = usage.reasoningTokens ?? 0;
    return typeof output === 'number' && Number.isFinite(output) && output >= 0
        && typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0 ? output + reasoning : null;
}
function messageProvenance(message) {
    if (!(0, runtime_types_1.isObjectRecord)(message) || !(0, runtime_types_1.isObjectRecord)(message.source))
        return undefined;
    const { provider, model } = message.source;
    return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}
function receptionReading(event) {
    if (event?.type !== 'model/reception' || !(0, runtime_types_1.isObjectRecord)(event.data))
        return null;
    const data = event.data, r = data.reception;
    if (!(0, runtime_types_1.isObjectRecord)(r))
        return null;
    const { turn, step } = data;
    const { attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished } = r;
    const finite = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!finite(turn) || !finite(step) || !finite(attempt) || !finite(startMs) || !finite(elapsedMs)
        || !finite(receptionMs) || receptionMs < 1 || typeof finished !== 'boolean'
        || !(firstDeltaMs === null || finite(firstDeltaMs) && firstDeltaMs >= startMs))
        return null;
    return { turn, step, attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished };
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
"src/modules/conversation/chat/message-chrome.js": function(module, exports, require) {
// source: src/modules/conversation/chat/message-chrome.ts

"use strict";
// Shared time-label helpers for user/assistant IconActions rows.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOfLocalDay = startOfLocalDay;
exports.msUntilNextLocalMidnight = msUntilNextLocalMidnight;
exports.formatRunDuration = formatRunDuration;
exports.formatLatencySeconds = formatLatencySeconds;
exports.formatTokensPerSecond = formatTokensPerSecond;
exports.formatMessageClock = formatMessageClock;
function pad2(n) {
    return String(n).padStart(2, '0');
}
/**
 * Local calendar-day epoch (ms at local midnight) for an instant.
 * @param ms - Unix epoch ms.
 * @returns Midnight of that local calendar day.
 */
function startOfLocalDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
/**
 * Delay until the next local midnight after `ms` (at least 1ms).
 * @param ms - Unix epoch ms.
 * @returns Milliseconds until the following local midnight.
 */
function msUntilNextLocalMidnight(ms) {
    const next = new Date(ms);
    next.setHours(24, 0, 0, 0);
    return Math.max(next.getTime() - ms, 1);
}
/**
 * Localized elapsed-time label shared by running and settled turn chrome.
 * @param ms - Elapsed duration in milliseconds (negatives clamp to zero).
 * @param t - Translate seat supplying the duration templates.
 * @returns Display string in whole seconds.
 */
function formatRunDuration(ms, t) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0
        ? t('duration.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
        : t('duration.seconds', { seconds });
}
/**
 * Sub-turn latency figure: one decimal under ten seconds, whole seconds
 * beyond. Unit-less so the locale template owns the second suffix.
 * @param ms - Latency in milliseconds (negatives clamp to zero).
 * @returns Display number in seconds without unit.
 */
function formatLatencySeconds(ms) {
    const s = Math.max(0, ms) / 1000;
    return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}
/**
 * Decode-throughput figure: whole tokens from ten up, one decimal below.
 * @param tps - Tokens per second.
 * @returns Display number without unit.
 */
function formatTokensPerSecond(tps) {
    const clamped = Math.max(0, tps);
    return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
/**
 * Compact local timestamp for message IconActions. Same calendar day →
 * `HH:mm`; earlier this year → the `clock.md` date template + clock; other
 * years → the `clock.ymd` template + clock. Pure: the date templates arrive
 * through the caller's locale seat.
 * @param time - Unix epoch ms from the source session event.
 * @param t - translate seat supplying the `clock.md` / `clock.ymd` templates.
 * @param now - Reference instant for the day/year cut (defaults to wall clock).
 * @returns Date-aware clock string (24-hour, zero-padded time).
 */
function formatMessageClock(time, t, now = Date.now()) {
    const d = new Date(time);
    const n = new Date(now);
    const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (d.getFullYear() === n.getFullYear()
        && d.getMonth() === n.getMonth()
        && d.getDate() === n.getDate()) {
        return clock;
    }
    const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    const md = d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params);
    return `${md} ${clock}`;
}

},
"src/modules/conversation/chat/turn-metrics.js": function(module, exports, require) {
// source: src/modules/conversation/chat/turn-metrics.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assistantStepReading = assistantStepReading;
exports.deriveTurnMetrics = deriveTurnMetrics;
const reception_metrics_1 = require("../../shared/reception-metrics");
/**
 * Read one assistant node's TTFT, decode wall time, and output tokens.
 * @param node - A settled assistant node.
 * @returns Per-part readings with `null` for unrecorded values.
 */
function assistantStepReading(node) {
    const timing = node.timing;
    const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
        ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
        : null;
    const decodeMs = timing !== undefined && timing.firstTokenTime !== null
        ? (timing.receptionMs ?? (timing.completedTime > timing.firstTokenTime ? timing.completedTime - timing.firstTokenTime : Math.max(1, timing.completedTime - (timing.stepStartTime ?? timing.firstTokenTime))))
        : null;
    return { ttftMs, decodeMs, outputTokens: (0, reception_metrics_1.totalOutputTokens)(node.usage) };
}
/**
 * Fold assistant nodes into per-turn footer metrics.
 *
 * TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
 * it is only meaningful when the turn's start is inside
 * the loaded window (the caller gates on `turnTimings`, which shares that
 * window). Throughput divides summed output tokens by summed decode wall time,
 * counting only steps that carry both.
 * @param nodes - Snapshot nodes of the loaded window.
 * @returns Turn number → available metrics; turns with none are absent.
 */
function deriveTurnMetrics(nodes) {
    const folds = new Map();
    const routes = new Map();
    for (const node of nodes) {
        if (node.kind === 'assistant' && node.provenance !== undefined
            && node.step >= (routes.get(node.turn)?.step ?? -1))
            routes.set(node.turn, node);
    }
    for (const node of nodes) {
        if (node.kind !== 'assistant')
            continue;
        const reading = assistantStepReading(node);
        let fold = folds.get(node.turn);
        if (fold === undefined) {
            fold = { firstStep: node.step, firstStepTtftMs: reading.ttftMs, decodeMs: 0, outputTokens: 0, sampled: false };
            folds.set(node.turn, fold);
        }
        else if (node.step < fold.firstStep) {
            fold.firstStep = node.step;
            fold.firstStepTtftMs = reading.ttftMs;
        }
        const route = routes.get(node.turn)?.provenance;
        const sameRoute = route === undefined || (node.provenance?.provider === route.provider && node.provenance?.model === route.model);
        if (sameRoute && reading.decodeMs !== null && reading.outputTokens !== null) {
            fold.decodeMs += reading.decodeMs;
            fold.outputTokens += reading.outputTokens;
            fold.sampled = true;
        }
    }
    const metrics = new Map();
    for (const [turn, fold] of folds) {
        const entry = {};
        if (fold.firstStepTtftMs !== null)
            entry.ttftMs = fold.firstStepTtftMs;
        const rate = fold.sampled ? (0, reception_metrics_1.throughput)(fold.outputTokens, fold.decodeMs) : null;
        if (rate !== null)
            entry.tokensPerSecond = rate;
        if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined)
            metrics.set(turn, entry);
    }
    return metrics;
}

},
"src/modules/conversation/chat/StatsLine.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/StatsLine.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const StatsLine_css_1 = __importDefault(require("./StatsLine.css"));
exports.default = {
    "root": "PvwIvW_root",
    "summary": "PvwIvW_summary",
    "details": "PvwIvW_details"
};
const tagId = '@xharness/dsh-client-ui-conversation/StatsLine.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = StatsLine_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/StatsLine.css": function(module, exports, require) {
// source: src/modules/conversation/chat/StatsLine.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".PvwIvW_root{position:static;flex:none;box-sizing:border-box;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}\n.PvwIvW_summary{display:flex;align-items:center;justify-content:center;width:32px;height:32px;cursor:pointer;border:0;background:transparent;color:inherit;padding:0;border-radius:50%}\n.PvwIvW_summary svg{width:18px;height:18px}\n.PvwIvW_summary:hover,.PvwIvW_root[data-expanded]>.PvwIvW_summary{background:var(--dsw-alias-interactive-bg-hover)}\n.PvwIvW_summary:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}\n.PvwIvW_details{position:absolute;z-index:100;bottom:calc(100% + 10px);left:0;box-sizing:border-box;width:max-content;min-width:min(220px,100%);max-width:min(340px,100%);max-height:min(300px,60vh);overflow:auto;display:grid;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);overflow-wrap:anywhere}\n";

},
"src/modules/conversation/skeleton/ContextMeter.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ContextMeter.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ContextMeter_css_1 = __importDefault(require("./ContextMeter.css"));
exports.default = {
    "bar": "S4my2G_bar",
    "colorMessages": "S4my2G_colorMessages",
    "colorSystem": "S4my2G_colorSystem",
    "colorTools": "S4my2G_colorTools",
    "figures": "S4my2G_figures",
    "fill": "S4my2G_fill",
    "header": "S4my2G_header",
    "headline": "S4my2G_headline",
    "panel": "S4my2G_panel",
    "percent": "S4my2G_percent",
    "root": "S4my2G_root",
    "row": "S4my2G_row",
    "rows": "S4my2G_rows",
    "segment": "S4my2G_segment",
    "swatch": "S4my2G_swatch",
    "track": "S4my2G_track",
    "trigger": "S4my2G_trigger"
};
const tagId = '@xharness/dsh-client-ui-conversation/ContextMeter.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ContextMeter_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/ContextMeter.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ContextMeter.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".S4my2G_root{display:inline-flex;position:relative}.S4my2G_trigger{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.S4my2G_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.S4my2G_trigger:disabled{cursor:default;opacity:.45}.S4my2G_track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}.S4my2G_fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}.S4my2G_panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:264px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);cursor:default;border-radius:12px;padding:12px;font-size:12px;line-height:20px;position:absolute;bottom:calc(100% + 8px);right:0}.S4my2G_header{align-items:center;gap:6px;display:flex}.S4my2G_figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}.S4my2G_percent{color:var(--dsw-alias-label-primary);font-weight:500}.S4my2G_headline{color:var(--dsw-alias-label-tertiary)}.S4my2G_headline:empty{display:none}.S4my2G_bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}.S4my2G_segment{background:var(--meter-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}.S4my2G_swatch{background:var(--meter-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}.S4my2G_colorSystem{--meter-tint:var(--dsw-static-neutral-bluish-400)}.S4my2G_colorTools{--meter-tint:#a78bfa}.S4my2G_colorMessages{--meter-tint:var(--dsw-static-blue-450)}.S4my2G_rows{margin:6px 0 0}.S4my2G_row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}.S4my2G_row dt{color:var(--dsw-alias-label-secondary)}.S4my2G_row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}\n/* The toolbar is the shared popover anchor at narrow split-pane widths. */\n[data-composer-toolbar] .S4my2G_root{position:static}\n[data-composer-toolbar] .S4my2G_panel{max-width:100%}\n";

},
"src/modules/conversation/skeleton/PermissionSelect.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/PermissionSelect.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionFeedback = permissionFeedback;
exports.PermissionSelect = PermissionSelect;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const classnames_1 = __importDefault(require("../classnames"));
const primitives_1 = require("../primitives");
const PermissionSelect_styles_1 = __importDefault(require("./PermissionSelect.styles"));
const FULL_ACCESS = 'danger-full-access';
/* Shield glyphs (design set 1556): check = read-only, pencil = workspace
   write, sparkle = AI review, exclamation = full access. currentColor so
   the trigger and menu rows tint them with their own text color. */
const shieldOutline = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z';
const permissionGlyphs = {
    'read-only': ((0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("path", { d: shieldOutline, stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), (0, jsx_runtime_1.jsx)("path", { d: "M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z", fill: "currentColor" })] })),
    'workspace-write': ((0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("path", { d: "M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M11.3525 5.64688V6.85688H5V5.64688H11.3525Z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M9.5824 8.29376V9.50376H5V8.29376H9.5824Z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z", fill: "currentColor" })] })),
    'workspace-write-ai-review': ((0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("path", { d: shieldOutline, stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), (0, jsx_runtime_1.jsx)("path", { d: "m8.2 4.2.95 2.55 2.55.95-2.55.95-.95 2.55-.95-2.55-2.55-.95 2.55-.95Z", stroke: "currentColor", strokeWidth: "1.15", strokeLinejoin: "round" })] })),
    [FULL_ACCESS]: ((0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("path", { d: shieldOutline, stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), (0, jsx_runtime_1.jsx)("path", { d: "M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z", fill: "currentColor" })] })),
};
/** Glyph for a permission option value; host-configured names outside the design set get none. */
function permissionGlyph(value) {
    return permissionGlyphs[value];
}
/**
 * Display transform: kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`); non-kebab host-configured names
 * pass through. Full access intentionally overrides the machine-name
 * transform so both permission surfaces use the product label `Full access`;
 * the warning body remains locale-aware.
 */
function displayName(name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
        return name;
    return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function optionLabel(option) {
    return option.value === FULL_ACCESS ? 'Full access' : displayName(option.name);
}
function permissionFeedback(value) {
    if (!value?.pending)
        return '';
    return '下一轮生效；当前轮：' + (value.activeValue ?? '正在准备') + '。立即收紧请停止当前任务；已有后台任务需单独停止。';
}
function PermissionSelect({ value, locked, compact = false, command, t }) {
    const [pick, setPick] = (0, react_1.useState)(null);
    const [open, setOpen] = (0, react_1.useState)(false);
    const [confirmation, setConfirmation] = (0, react_1.useState)(null);
    const [acknowledged, setAcknowledged] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        if (!locked && value !== undefined)
            return;
        setOpen(false);
        setAcknowledged(false);
        setConfirmation(null);
    }, [locked, value]);
    if (value === undefined)
        return null;
    const currentValue = pick ?? value.currentValue;
    const current = value.options.find(option => option.value === currentValue);
    const busy = pick !== null || confirmation !== null;
    const items = value.options
        .filter(o => o.value !== 'custom')
        .map((option) => {
        const icon = permissionGlyph(option.value);
        return { id: option.value, label: optionLabel(option), ...icon === undefined ? {} : { icon } };
    });
    const submit = (id) => {
        setPick(id);
        void command(`/permission ${id}`)
            .catch(() => false)
            .then(() => { setPick(null); });
    };
    const choose = (id) => {
        setOpen(false);
        if (id === value.currentValue)
            return;
        if (id === FULL_ACCESS) {
            setAcknowledged(false);
            setConfirmation(id);
            return;
        }
        submit(id);
    };
    const closeConfirmation = () => {
        setAcknowledged(false);
        setConfirmation(null);
    };
    const confirmFullAccess = () => {
        if (locked || !acknowledged || confirmation === null)
            return;
        const id = confirmation;
        closeConfirmation();
        submit(id);
    };
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: open, items: items, selectedId: currentValue, onSelect: choose, onClose: () => { setOpen(false); }, side: "top", anchor: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, classnames_1.default)(PermissionSelect_styles_1.default.trigger, compact && permissionGlyph(currentValue) !== undefined && PermissionSelect_styles_1.default.compact), "data-access-pending": value.pending || pick !== null || undefined, "data-access-full": currentValue === FULL_ACCESS || undefined, "aria-haspopup": "menu", "aria-expanded": open, "aria-label": t('input.accessMode', { name: current === undefined ? displayName(currentValue) : optionLabel(current) }), title: pick !== null ? '正在保存权限选择；当前执行权限不变' : permissionFeedback(value) || current?.description || (current === undefined ? displayName(currentValue) : optionLabel(current)), disabled: locked || busy, onClick: () => { setOpen(!open); }, children: [permissionGlyph(currentValue) !== undefined && ((0, jsx_runtime_1.jsx)("span", { className: PermissionSelect_styles_1.default.triggerIcon, "aria-hidden": true, children: permissionGlyph(currentValue) })), (0, jsx_runtime_1.jsx)("span", { className: PermissionSelect_styles_1.default.triggerLabel, children: (current === undefined ? displayName(currentValue) : optionLabel(current)) + (pick !== null ? ' · 保存中' : value.pending ? ' · 下一轮生效' : '') }), (0, jsx_runtime_1.jsx)("span", { className: (0, classnames_1.default)(PermissionSelect_styles_1.default.chevron, open && PermissionSelect_styles_1.default.chevronOpen), "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) })] }) }), (0, jsx_runtime_1.jsx)(primitives_1.RiskConfirmation, { open: confirmation !== null, title: t('access.confirm.title'), description: t('access.confirm.description'), acknowledgeLabel: t('access.confirm.acknowledge'), cancelLabel: t('access.confirm.cancel'), confirmLabel: t('access.confirm.enable'), acknowledged: acknowledged, disabled: locked, onAcknowledgedChange: setAcknowledged, onCancel: closeConfirmation, onConfirm: confirmFullAccess })] }));
}

},
"src/modules/conversation/skeleton/PermissionSelect.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/PermissionSelect.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PermissionSelect_css_1 = __importDefault(require("./PermissionSelect.css"));
exports.default = {
    compact: "Qgao_G_compact",
    "chevron": "Qgao_G_chevron",
    "chevronOpen": "Qgao_G_chevronOpen",
    "trigger": "Qgao_G_trigger",
    "triggerIcon": "Qgao_G_triggerIcon",
    "triggerLabel": "Qgao_G_triggerLabel"
};
const tagId = '@xharness/dsh-client-ui-conversation/PermissionSelect.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = PermissionSelect_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/PermissionSelect.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/PermissionSelect.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Qgao_G_trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.Qgao_G_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.Qgao_G_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.Qgao_G_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.Qgao_G_triggerIcon{flex:none;display:inline-flex}.Qgao_G_triggerIcon svg{width:14px;height:14px}.Qgao_G_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.Qgao_G_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}@container (width<=460px){.Qgao_G_trigger:has(.Qgao_G_triggerIcon) .Qgao_G_triggerLabel{display:none}}.Qgao_G_chevronOpen{transform:rotate(180deg)}\n.Qgao_G_compact{position:relative;width:32px;min-width:32px;height:32px;padding:0;justify-content:center}\n.Qgao_G_compact .Qgao_G_triggerLabel,.Qgao_G_compact .Qgao_G_chevron{display:none}\n.Qgao_G_compact .Qgao_G_triggerIcon svg{width:18px;height:18px}\n.Qgao_G_compact[data-access-full]{color:var(--dsw-alias-state-warn-label)}\n.Qgao_G_compact[data-access-pending]:after{content:\"\";position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-label)}\n";

},
"src/modules/conversation/skeleton/safari.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/safari.ts

"use strict";
/** Safari-specific textarea layout recovery for the conversation composer. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSafariBrowser = isSafariBrowser;
exports.repairSafariTextareaLayout = repairSafariTextareaLayout;
const ALTERNATE_IOS_BROWSER = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|OPT|DuckDuckGo|Brave)(?:\/|\b)/;
/**
 * Detect Safari's `Version/... Safari/...` form while excluding known alternate iOS browser tokens.
 * @param identity - Browser user-agent and vendor values.
 * @returns Whether the identity should use the Safari-specific recovery.
 */
function isSafariBrowser(identity) {
    return identity.vendor === 'Apple Computer, Inc.'
        && /\bVersion\/[\d.]+.*\bSafari\/[\d.]+/.test(identity.userAgent)
        && !ALTERNATE_IOS_BROWSER.test(identity.userAgent);
}
/**
 * Repair Safari's stale native textarea layout and the scrollport auto height it can contaminate.
 * @param input - Composer textarea whose own scrollable overflow must stay zero.
 */
function repairSafariTextareaLayout(input) {
    if (input === null || input.scrollHeight <= input.clientHeight)
        return;
    const scrollport = input.closest('[data-input-scroll]');
    if (scrollport === null)
        return;
    const inputHeight = input.style.height;
    input.style.height = `${String(input.clientHeight + 1)}px`;
    void input.offsetHeight;
    input.style.height = inputHeight;
    void input.offsetHeight;
    const scrollportHeight = scrollport.style.height;
    scrollport.style.height = `${String(scrollport.clientHeight + 1)}px`;
    void scrollport.offsetHeight;
    scrollport.style.height = scrollportHeight;
    void scrollport.offsetHeight;
}

},
"src/modules/conversation/skeleton/InputBar.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/InputBar.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const InputBar_css_1 = __importDefault(require("./InputBar.css"));
exports.default = {
    "modelSeat": "_7yzX1q_modelSeat",
    "actions": "_7yzX1q_actions",
    "footer": "_7yzX1q_footer",
    "accessory": "_7yzX1q_accessory",
    "add": "_7yzX1q_add",
    "backdrop": "_7yzX1q_backdrop",
    "backdropDisabled": "_7yzX1q_backdropDisabled",
    "card": "_7yzX1q_card",
    "cardWorkspaceTrigger": "_7yzX1q_cardWorkspaceTrigger",
    "chip": "_7yzX1q_chip",
    "chipIcon": "_7yzX1q_chipIcon",
    "chipInvalid": "_7yzX1q_chipInvalid",
    "chipTrigger": "_7yzX1q_chipTrigger",
    "chipTriggerGlyph": "_7yzX1q_chipTriggerGlyph",
    "grow": "_7yzX1q_grow",
    "hero": "_7yzX1q_hero",
    "hint": "_7yzX1q_hint",
    "hlSegment": "_7yzX1q_hlSegment",
    "hlToken": "_7yzX1q_hlToken",
    "input": "_7yzX1q_input",
    "input-pending": "_7yzX1q_input-pending",
    "mirror": "_7yzX1q_mirror",
    "modes": "_7yzX1q_modes",
    "notice": "_7yzX1q_notice",
    "overlayAnchor": "_7yzX1q_overlayAnchor",
    "pending": "_7yzX1q_pending",
    "primary": "_7yzX1q_primary",
    "retry": "_7yzX1q_retry",
    "root": "_7yzX1q_root",
    "row": "_7yzX1q_row",
    "scroll": "_7yzX1q_scroll",
    "select": "_7yzX1q_select",
    "textRef": "_7yzX1q_textRef",
    "textRefIcon": "_7yzX1q_textRefIcon",
    "textRefTrigger": "_7yzX1q_textRefTrigger",
    "textRefTriggerGlyph": "_7yzX1q_textRefTriggerGlyph",
    "tools": "_7yzX1q_tools",
    "trailing": "_7yzX1q_trailing"
};
const tagId = '@xharness/dsh-client-ui-conversation/InputBar.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = InputBar_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/InputBar.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/InputBar.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._7yzX1q_root{padding:0 var(--dsh-composer-side-clearance) 8px;flex-direction:column;align-items:center;display:flex}._7yzX1q_hero{padding:0 var(--dsh-composer-side-clearance)}._7yzX1q_notice{width:100%;max-width:var(--dsh-composer-card-max-width);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-radius:8px;margin-bottom:6px;padding:4px 8px;font-size:12px;line-height:18px}._7yzX1q_card{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:22px;flex-direction:column;gap:12px;padding-top:10px;font-size:16px;line-height:24px;display:flex;position:relative}._7yzX1q_cardWorkspaceTrigger{cursor:pointer;border-color:#0000}._7yzX1q_cardWorkspaceTrigger:after{content:\"\";background:var(--dsw-alias-border-l4);pointer-events:none;border-radius:22px;transition:background-color .1s;position:absolute;inset:-1px;-webkit-mask:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='100%25' height='100%25' fill='none' rx='22' ry='22' stroke='black' stroke-width='2' stroke-dasharray='4 4'/%3E%3C/svg%3E\");mask:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='100%25' height='100%25' fill='none' rx='22' ry='22' stroke='black' stroke-width='2' stroke-dasharray='4 4'/%3E%3C/svg%3E\")}._7yzX1q_cardWorkspaceTrigger :disabled{pointer-events:none}._7yzX1q_cardWorkspaceTrigger:hover:after{background:var(--dsw-alias-state-business-primary)}._7yzX1q_accessory{align-items:center;gap:8px;padding:10px 12px 0;display:flex}._7yzX1q_overlayAnchor{height:0;position:absolute;inset:0 0 auto}._7yzX1q_scroll{max-height:var(--dsh-composer-text-max-height);overflow-y:auto}._7yzX1q_grow{position:relative}._7yzX1q_backdrop{color:var(--dsw-alias-label-primary);pointer-events:none;position:absolute;inset:0;overflow:hidden}._7yzX1q_backdropDisabled,._7yzX1q_backdropDisabled :is(._7yzX1q_hlToken,._7yzX1q_hint,._7yzX1q_textRef,._7yzX1q_chip,._7yzX1q_chipInvalid){color:var(--dsw-alias-label-tertiary)}._7yzX1q_hlToken{color:var(--dsw-alias-state-warn-label);background-color:#0000}._7yzX1q_hlSegment{color:#0000;background-color:#0000;border-radius:4px}._7yzX1q_hint{color:var(--dsw-alias-label-caption)}._7yzX1q_pending{background:var(--dsw-alias-state-business-primary);border-radius:50%;width:8px;height:8px;animation:1s ease-in-out infinite alternate _7yzX1q_input-pending}@keyframes _7yzX1q_input-pending{0%{opacity:.35}to{opacity:1}}._7yzX1q_input{resize:none;color:#0000;-webkit-text-fill-color:transparent;width:100%;height:100%;caret-color:var(--dsw-alias-state-business-primary);background:0 0;border:none;outline:none;position:absolute;inset:0;overflow:hidden}._7yzX1q_input,._7yzX1q_mirror,._7yzX1q_backdrop{box-sizing:border-box;font-family:var(--dsw-font-family);font-size:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:4px 12px 0 16px}._7yzX1q_input::placeholder{color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption);user-select:none}._7yzX1q_input:disabled{color:#0000;-webkit-text-fill-color:transparent;cursor:not-allowed}._7yzX1q_input[aria-haspopup=menu]{cursor:pointer}._7yzX1q_mirror{visibility:hidden;pointer-events:none}._7yzX1q_hero ._7yzX1q_mirror{min-height:52px}._7yzX1q_row{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;min-width:0;padding:2px 8px 6px;display:flex;container-type:inline-size}._7yzX1q_tools,._7yzX1q_modes,._7yzX1q_trailing{align-items:center;min-width:0;display:flex}._7yzX1q_tools{gap:16px}._7yzX1q_modes{gap:12px}._7yzX1q_trailing{flex:none;gap:12px;margin-left:auto}._7yzX1q_add{background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;display:grid}._7yzX1q_add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}._7yzX1q_add:disabled{opacity:.5;cursor:default}._7yzX1q_select{max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;appearance:none;background-color:#0000;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 4px center;background-repeat:no-repeat;background-size:12px 12px;border:none;border-radius:8px;outline:none;padding:0 20px 0 8px;font-size:13px;font-weight:500;line-height:20px}._7yzX1q_select:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}._7yzX1q_select:disabled{opacity:.5;cursor:default}._7yzX1q_primary{background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px)}._7yzX1q_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}._7yzX1q_primary:disabled{opacity:.4;cursor:default}._7yzX1q_retry{color:inherit;cursor:pointer;background:0 0;border:1px solid;border-radius:4px;margin-left:8px;padding:1px 8px;font-size:12px}._7yzX1q_textRef{color:var(--dsw-alias-state-business-primary);-webkit-box-decoration-break:clone;box-decoration-break:clone;background-color:#0000}._7yzX1q_textRef:after{display:none}._7yzX1q_textRefTrigger{position:relative}._7yzX1q_textRefTriggerGlyph{color:#0000}._7yzX1q_textRefIcon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}._7yzX1q_chip{color:var(--dsw-alias-state-business-primary);-webkit-box-decoration-break:clone;box-decoration-break:clone;background:0 0;position:relative}._7yzX1q_chipTrigger{position:relative}._7yzX1q_chipTriggerGlyph{color:#0000}._7yzX1q_chipIcon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}._7yzX1q_chipInvalid{opacity:.7;color:var(--dsw-alias-state-error-primary);text-decoration:line-through}\n\n/* Compact chat presentation never changes the welcome/hero layout. */\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_card{gap:8px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_accessory{flex-direction:column;align-items:stretch;gap:6px;padding:0 12px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_accessory:empty,._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_footer:empty,._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_accessory:has(>[data-slot]:only-child:empty),._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_footer:has(>[data-slot]:only-child:empty){display:none}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_row{position:relative;justify-content:normal;flex-wrap:wrap;gap:8px;padding:4px 12px 12px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_tools{flex:0 1 auto;gap:6px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_modes{gap:6px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_trailing{flex:1 0 auto;justify-content:flex-end;gap:8px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_model._7yzX1q_root[data-composer-layout=\"compact\"] eat{display:flex;justify-content:flex-end;flex:none;min-width:0}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_actions{display:flex;align-items:center;flex:none;gap:6px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_footer{display:flex;min-width:0;flex:none;padding:0}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_add{width:32px;height:32px;background:transparent}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_add svg{width:20px;height:20px}\n._7yzX1q_root[data-composer-layout=\"compact\"] ._7yzX1q_primary{transform:none}\n\n/* Composer-owned integration preserves standalone Goal lifecycle styles. */\n._7yzX1q_root[data-composer-layout=\"compact\"] [data-goal-bar]{width:100%;margin:0}\n._7yzX1q_root[data-composer-layout=\"compact\"] [data-goal-bar]>div{max-width:none;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent;margin:0;padding:0 0 8px;gap:8px}\n._7yzX1q_root[data-composer-layout=\"compact\"] [data-goal-bar]>div>:last-child{gap:2px;margin-left:auto}\n\n/* A null dock slot must not leave a padded blank row on the welcome card. */\n._7yzX1q_root[data-composer-layout=\"hero\"] ._7yzX1q_accessory:empty,\n._7yzX1q_root[data-composer-layout=\"hero\"] ._7yzX1q_accessory:has(>[data-slot]:only-child:empty){display:none}\n";

},
"src/modules/conversation/skeleton/ComposerAddMenu.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ComposerAddMenu.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComposerAddMenu = ComposerAddMenu;
const jsx_runtime_1 = require("react/jsx-runtime");
/** One shared plus menu owns native attachment selection and command launching. */
const react_1 = require("react");
const primitives_1 = require("../primitives");
function ComposerAddMenu({ className, canAttach, canCommands, onAddFiles, onCommands, onOpen, focusInput, t }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const picker = (0, react_1.useRef)(null), trigger = (0, react_1.useRef)(null);
    const fileLabel = (0, react_1.useRef)(null), commandLabel = (0, react_1.useRef)(null), lastFirst = (0, react_1.useRef)(false);
    const disabled = !canAttach && !canCommands;
    const buttons = () => [fileLabel.current, commandLabel.current].map(label => label?.closest('[role="menuitem"]')).filter((button) => button != null && !button.disabled);
    const close = () => { if (buttons().some(button => button === document.activeElement))
        trigger.current?.focus({ preventScroll: true }); setOpen(false); };
    const show = (last = false) => { if (disabled)
        return; onOpen?.(); lastFirst.current = last; setOpen(true); };
    (0, react_1.useEffect)(() => {
        if (!open || disabled)
            return;
        const frame = requestAnimationFrame(() => { const items = buttons(); (lastFirst.current ? items.at(-1) : items[0])?.focus({ preventScroll: true }); });
        return () => cancelAnimationFrame(frame);
    }, [open, disabled]);
    (0, react_1.useEffect)(() => { if (disabled)
        setOpen(false); }, [disabled]);
    (0, react_1.useEffect)(() => { const input = picker.current; input?.addEventListener('cancel', focusInput); return () => input?.removeEventListener('cancel', focusInput); }, [focusInput]);
    const select = (id) => { setOpen(false); if (id === 'attachment' && canAttach)
        picker.current?.click(); if (id === 'commands' && canCommands) {
        focusInput();
        onCommands();
    } };
    const onKeyDown = (event) => {
        if (event.key === 'Tab' && open) {
            close();
            return;
        }
        if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
            return;
        if (!open && event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
            return;
        event.preventDefault();
        event.stopPropagation();
        if (!open) {
            show(event.key === 'ArrowUp');
            return;
        }
        const items = buttons(), current = items.findIndex(button => button === document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus({ preventScroll: true });
    };
    return (0, jsx_runtime_1.jsxs)("span", { "data-composer-add-menu": "true", onKeyDown: onKeyDown, style: { display: 'inline-flex' }, children: [(0, jsx_runtime_1.jsx)("style", { children: '[role="menuitem"]:has([data-composer-add-label]):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}' }), (0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: open && !disabled, side: "top", portal: true, compact: true, onClose: close, onSelect: select, items: [
                    { id: 'attachment', disabled: !canAttach, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconPaperclipOutline16, { size: 16 }), label: (0, jsx_runtime_1.jsx)("span", { ref: fileLabel, "data-composer-add-label": "true", children: t('input.attachFiles') }) },
                    { type: 'separator', id: 'attachment-commands' },
                    { id: 'commands', disabled: !canCommands, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconCodeOutline16, { size: 16 }), label: (0, jsx_runtime_1.jsx)("span", { ref: commandLabel, "data-composer-add-label": "true", children: t('input.commands') }) },
                ], anchor: (0, jsx_runtime_1.jsx)("button", { ref: trigger, type: "button", className: className, disabled: disabled, title: t('input.add'), "aria-label": t('input.add'), "aria-haspopup": "menu", "aria-expanded": open && !disabled, onMouseDown: event => event.preventDefault(), onClick: () => open ? close() : show(), children: (0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)("input", { ref: picker, type: "file", multiple: true, hidden: true, disabled: !canAttach, "aria-label": t('input.attachFiles'), onChange: event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (canAttach && files.length)
                    onAddFiles(files); focusInput(); } })] });
}

},
"src/modules/conversation/attachments.js": function(module, exports, require) {
// source: src/modules/conversation/attachments.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachmentMediaType = attachmentMediaType;
exports.attachmentKind = attachmentKind;
exports.validateAttachments = validateAttachments;
exports.browserDraftAttachment = browserDraftAttachment;
const contract_1 = require("./input/contract");
/** Local intake UX matches the durable Host limits, including ordinary files. */
function attachmentMediaType(file) {
    if (file.type)
        return file.type;
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    return types[extension] ?? 'application/octet-stream';
}
function attachmentKind(file) { return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachmentMediaType(file)) ? 'image' : 'file'; }
function validateAttachments(files) {
    if (files.length > 128)
        throw Error('最多同时添加 128 个附件');
    if (files.filter(file => attachmentKind(file) === 'image').length > 16)
        throw Error('每条消息最多 16 张图片');
    for (const file of files) {
        const limit = attachmentKind(file) === 'image' ? 20 : 32;
        if (file.size > limit * 1024 * 1024)
            throw Error(file.name + ' 超过 ' + limit + ' MiB 上传限制');
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 96 * 1024 * 1024)
        throw Error('本次附件合计不能超过 96 MiB');
}
function browserDraftAttachment(file) { return { kind: attachmentKind(file), id: (0, contract_1.DraftAttachmentId)(crypto.randomUUID()), previewUrl: URL.createObjectURL(file), file }; }

},
"src/modules/conversation/input/contract.js": function(module, exports, require) {
// source: src/modules/conversation/input/contract.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DraftAttachmentId = DraftAttachmentId;
const zod_1 = require("zod");
/** Browser-runtime identity of one unsent image draft. */
const draftAttachmentIdSchema = zod_1.z.string().brand();
function DraftAttachmentId(value) { return draftAttachmentIdSchema.parse(value); }

},
"src/modules/conversation/edit/actions.js": function(module, exports, require) {
// source: src/modules/conversation/edit/actions.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhEditMessage = xhEditMessage;
exports.xhForkMessage = xhForkMessage;
exports.xhForkAt = xhForkAt;
const MessageEditor_1 = require("./MessageEditor");
function xhEditMessage(hub, id, content) {
    const shell = hub.shell(id), editor = shell.xhEditor;
    if (!editor)
        return Promise.reject(new Error('Message editor unavailable'));
    return editor.request(content).catch((error) => shell.notify('error', String(error)));
}
/** Resolve source-owned attachment bytes before forking; excluded history cannot authorize child references. */
async function xhForkMessage(hub, sessions, id, seq, content) {
    const draft = (0, MessageEditor_1.editableDraft)(content);
    if (!Number.isSafeInteger(seq) || seq < 0 || !draft)
        throw new Error('Unsupported fork message');
    const source = sessions.binding(id)?.session;
    if (!source)
        throw new Error('Source session is unavailable');
    const images = await Promise.all(draft.images.map(async (image) => {
        if (!image.ref?.attachmentId)
            throw new Error('Attachment reference is missing');
        const result = await source.readAttachment(image.ref.attachmentId);
        if (!result.ok)
            throw new Error(result.error.message || 'Attachment could not be read');
        return { file: new File([Uint8Array.from(result.value.data).buffer], image.ref.name || 'attachment', { type: result.value.attachment.mediaType || image.ref.mediaType }) };
    }));
    const childId = await sessions.fork({ sessionId: id, beforeUserSeq: seq, increaseTitle: true }), shell = hub.shell(childId);
    const editor = shell.xhEditor;
    if (!editor)
        throw new Error('Message editor unavailable');
    await editor.request(content, images);
    sessions.open(childId);
    if (!editor.state.editing)
        shell.notify('error', editor.state.error || 'Could not prepare fork draft');
    return childId;
}
/** Report a failed message fork without navigating away from its source. */
async function xhForkAt(hub, sessions, id, seq) {
    try {
        const childId = await sessions.fork({ sessionId: id, atSeq: seq, increaseTitle: true });
        sessions.open(childId);
    }
    catch (error) {
        hub.shell(id).notify('error', String(error));
    }
}

},
"src/modules/conversation/edit/MessageEditor.js": function(module, exports, require) {
// source: src/modules/conversation/edit/MessageEditor.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XHarnessMessageEditor = void 0;
exports.editableDraft = editableDraft;
const wire_guards_1 = require("../wire-guards");
const runtime_types_1 = require("../../shared/runtime-types");
const recordOf = (value) => (0, runtime_types_1.isObjectRecord)(value) ? value : undefined;
function editableDraft(content, prepared) {
    const blocks = content.map(recordOf);
    if (blocks.some(block => !block || !['text', 'image', 'file'].includes(String(block.type))))
        return undefined;
    const text = blocks.flatMap(block => block?.type === 'text' ? [typeof block.text === 'string' ? block.text : ''] : []).join('');
    const images = [];
    for (const block of blocks) {
        if (!block || (block.type !== 'image' && block.type !== 'file'))
            continue;
        const ref = recordOf(block.attachment);
        if (!(0, wire_guards_1.isImageAttachmentRef)(ref) || !ref.attachmentId)
            return undefined;
        images.push({ ref: ref, kind: block.type, name: typeof ref.name === 'string' ? ref.name : 'image', ...(typeof ref.mediaType === 'string' ? { type: ref.mediaType } : {}) });
    }
    return { text, images: prepared ?? images };
}
class XHarnessMessageEditor {
    constructor(d) {
        this.d = d;
        this.listeners = new Set();
        this.state = { phase: 'idle', editing: false, error: '' };
        this.backup = null;
        this.pending = null;
        this.saved = null;
        this.ownChange = false;
        this.disposed = false;
        this.writes = Promise.resolve();
        this.subscribe = (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
        this.getSnapshot = () => this.state;
        this.off = d.shell.state.subscribe(() => { if (this.ownChange || this.disposed)
            return; if (this.state.editing && !this.busy())
            void this.persist().catch(() => { }); this.set({}); });
        this.ready = d.storage.load(d.id).then(record => { if (record && !this.disposed && this.state.phase === 'idle') {
            this.saved = record;
            this.set({ phase: 'recover' });
        } }).catch((error) => this.set({ error: String(error) }));
    }
    set(next) { if (this.disposed)
        return; this.state = { ...this.state, ...next }; for (const listener of this.listeners)
        listener(); }
    busy() { const shell = this.d.shell; return shell.disposed || shell.imageSendInFlight || shell.snapshot.phase === 'adjudicating' || shell.snapshot.phase === 'submitting'; }
    capture() {
        const snapshot = this.d.shell.snapshot, images = this.d.conversation.draftImages(snapshot.imageIds);
        if (images.length !== snapshot.imageIds.length)
            throw new Error(this.d.t('message.editMissing'));
        return { text: snapshot.draft, images: images.map(image => image.historyRef ? { ref: image.historyRef, ...(image.historyKind ? { kind: image.historyKind } : {}), name: image.file.name, type: image.file.type } : { file: image.file }) };
    }
    persist() {
        try {
            const record = { version: 1, backup: this.backup, draft: this.capture() };
            this.writes = this.writes.catch(() => { }).then(() => this.d.storage.save(this.d.id, record));
            void this.writes.catch((error) => this.set({ error: this.d.t('message.editStorage') + ': ' + String(error) }));
            return this.writes;
        }
        catch (error) {
            this.set({ error: String(error) });
            return Promise.reject(error);
        }
    }
    async request(content, preparedImages) {
        await this.ready;
        if (this.disposed || this.busy() || this.d.running())
            return;
        if (this.state.phase !== 'idle') {
            this.set({ error: this.d.t('message.editFinish') });
            return;
        }
        const draft = editableDraft(content, preparedImages);
        if (!draft) {
            this.set({ error: this.d.t('message.editUnsupported') });
            return;
        }
        this.pending = draft;
        if (draft.images.some(image => !image.file && !image.ref.attachmentId)) {
            this.set({ error: this.d.t('message.editMissing') });
            return;
        }
        const before = this.capture();
        if (before.text || before.images.length)
            this.set({ phase: 'confirm', error: '' });
        else
            await this.confirm();
    }
    async confirm() {
        if (!this.pending || this.busy() || this.d.running() || this.state.editing || this.state.phase === 'saving')
            return;
        this.set({ phase: 'saving', error: '' });
        const snapshot = this.d.shell.snapshot;
        try {
            this.backup = this.capture();
            await this.d.storage.save(this.d.id, { version: 1, backup: this.backup, draft: this.pending });
            if (this.disposed)
                return;
            if (snapshot !== this.d.shell.snapshot || this.busy() || this.d.running())
                throw new Error(this.d.t('message.editChanged'));
            this.apply(this.pending);
            this.pending = null;
            this.set({ phase: 'editing', editing: true, error: '' });
            this.d.focus();
        }
        catch (error) {
            await this.d.storage.remove(this.d.id).catch(() => { });
            this.backup = null;
            this.set({ phase: 'idle', error: String(error) });
        }
    }
    apply(draft) {
        const { shell, conversation } = this.d, old = [...shell.snapshot.imageIds], images = [];
        try {
            for (const descriptor of draft.images) {
                const file = descriptor.file ?? new File([], descriptor.name ?? 'image', { type: descriptor.type ?? 'image/png' });
                const image = conversation.createDraftImages([file])[0];
                if (!image)
                    throw new Error(this.d.t('message.editMissing'));
                if (descriptor.ref) {
                    image.historyRef = descriptor.ref;
                    image.historyKind = descriptor.kind ?? 'image';
                    image.loadState = 'loading';
                }
                images.push(image);
            }
        }
        catch (error) {
            for (const image of images)
                conversation.releaseDraftImage(image.id);
            throw error;
        }
        this.ownChange = true;
        try {
            for (const id of old)
                shell.removeImage(id);
            shell.addImages(images.map(image => image.id));
            shell.setDraft(draft.text);
        }
        finally {
            this.ownChange = false;
        }
        for (const id of old)
            conversation.releaseDraftImage(id);
        for (const image of images)
            if (image.historyRef)
                void this.hydrate(image);
    }
    async hydrate(image) {
        const generation = image.generation = (image.generation ?? 0) + 1;
        image.loadState = 'loading';
        this.set({});
        try {
            if (!image.historyRef)
                throw new Error(this.d.t('message.editMissing'));
            const result = await this.d.read(image.historyRef.attachmentId);
            if (!result.ok)
                throw new Error(result.error.message);
            if (this.disposed || generation !== image.generation || !this.d.conversation.draftImages([image.id]).length)
                return;
            const file = new File([Uint8Array.from(result.value.data).buffer], image.file.name, { type: result.value.attachment.mediaType });
            this.d.conversation.replaceDraftPreview(image, file);
        }
        catch (error) {
            if (generation !== image.generation)
                return;
            image.loadState = 'missing';
            image.loadError = String(error);
        }
        if (!this.disposed) {
            this.ownChange = true;
            this.d.shell.publish();
            this.ownChange = false;
            this.set({});
        }
    }
    async recover() {
        if (!this.saved || this.busy() || this.d.running())
            return;
        const snapshot = this.d.shell.snapshot;
        if ((snapshot.draft && snapshot.draft !== this.saved.draft.text) || snapshot.imageIds.length) {
            this.set({ error: this.d.t('message.editChanged') });
            return;
        }
        this.backup = this.saved.backup;
        this.apply(this.saved.draft);
        this.saved = null;
        this.set({ phase: 'editing', editing: true, error: '' });
        this.d.focus();
    }
    async cancel() {
        if (this.busy() || this.state.phase === 'saving')
            return;
        if (this.state.phase === 'confirm') {
            this.pending = null;
            this.set({ phase: 'idle', error: '' });
            return;
        }
        if (this.state.phase === 'recover' && this.saved) {
            const snapshot = this.d.shell.snapshot;
            if ((snapshot.draft && snapshot.draft !== this.saved.draft.text) || snapshot.imageIds.length) {
                this.set({ error: this.d.t('message.editChanged') });
                return;
            }
            this.backup = this.saved.backup;
        }
        if (this.backup)
            this.apply(this.backup);
        this.set({ phase: 'saving', editing: false, error: '' });
        this.saved = null;
        this.backup = null;
        await this.writes.catch(() => { });
        await this.d.storage.remove(this.d.id).catch((error) => this.set({ error: String(error) }));
        this.set({ phase: 'idle' });
    }
    guardSubmit() {
        if (this.state.phase === 'confirm' || this.state.phase === 'recover' || this.state.phase === 'saving')
            throw new Error(this.d.t('message.editFinish'));
        if (this.state.editing && this.d.running())
            throw new Error(this.d.t('message.editRunning'));
        for (const image of this.d.conversation.draftImages(this.d.shell.snapshot.imageIds))
            if (image.historyRef && image.loadState !== 'ready')
                throw new Error(this.d.t('message.editMissing'));
    }
    async sent() {
        if (!this.state.editing)
            return;
        this.set({ phase: 'saving', editing: false, error: '' });
        this.backup = null;
        await this.writes.catch(() => { });
        await this.d.storage.remove(this.d.id).catch((error) => this.set({ error: String(error) }));
        this.set({ phase: 'idle' });
    }
    dispose() { this.off(); this.disposed = true; this.listeners.clear(); }
}
exports.XHarnessMessageEditor = XHarnessMessageEditor;

},
"src/modules/conversation/wire-guards.js": function(module, exports, require) {
// source: src/modules/conversation/wire-guards.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUnknownArray = isUnknownArray;
exports.isImageAttachmentRef = isImageAttachmentRef;
const runtime_types_1 = require("../shared/runtime-types");
function isUnknownArray(value) { return Array.isArray(value); }
function isImageAttachmentRef(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value) || typeof value.attachmentId !== 'string' || typeof value.mediaType !== 'string' || typeof value.bytes !== 'number')
        return false;
    return (value.name === undefined || typeof value.name === 'string')
        && (value.width == null || typeof value.width === 'number')
        && (value.height == null || typeof value.height === 'number');
}

},
"src/modules/conversation/runtime-values.js": function(module, exports, require) {
// source: src/modules/conversation/runtime-values.ts

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
exports.emptyAssistantBlock = exports.isTokenDelta = exports.toAssistantBlocks = exports.toAssistantBlock = exports.workspaceTitleOf = exports.resolveWorkspacePath = exports.sessionRecallLabels = exports.displayFailureMessage = exports.conversationContextKey = exports.contextProvenance = exports.contextForm = exports.isReplacementSurfaceEvent = exports.isAppendSurfaceEvent = exports.shallowEqual = exports.publishChatSnapshot = exports.defineStore = exports.createSnapshotStore = void 0;
const platform = __importStar(require("@xharness/dsh-client-runtime/client"));
exports.createSnapshotStore = platform.createSnapshotStore, exports.defineStore = platform.defineStore, exports.publishChatSnapshot = platform.publishChatSnapshot, exports.shallowEqual = platform.shallowEqual, exports.isAppendSurfaceEvent = platform.isAppendSurfaceEvent, exports.isReplacementSurfaceEvent = platform.isReplacementSurfaceEvent, exports.contextForm = platform.contextForm, exports.contextProvenance = platform.contextProvenance, exports.conversationContextKey = platform.conversationContextKey, exports.displayFailureMessage = platform.displayFailureMessage, exports.sessionRecallLabels = platform.sessionRecallLabels, exports.resolveWorkspacePath = platform.resolveWorkspacePath, exports.workspaceTitleOf = platform.workspaceTitleOf;
var model_1 = require("./types/model");
Object.defineProperty(exports, "toAssistantBlock", { enumerable: true, get: function () { return model_1.toAssistantBlock; } });
Object.defineProperty(exports, "toAssistantBlocks", { enumerable: true, get: function () { return model_1.toAssistantBlocks; } });
var chunk_values_1 = require("./chat/chunk-values");
Object.defineProperty(exports, "isTokenDelta", { enumerable: true, get: function () { return chunk_values_1.isTokenDelta; } });
Object.defineProperty(exports, "emptyAssistantBlock", { enumerable: true, get: function () { return chunk_values_1.emptyAssistantBlock; } });

},
"src/modules/conversation/types/model.js": function(module, exports, require) {
// source: src/modules/conversation/types/model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_CHAT_SNAPSHOT = exports.EMPTY_CONVERSATION_VIEWS = void 0;
exports.toAssistantBlocks = toAssistantBlocks;
exports.toAssistantBlock = toAssistantBlock;
const runtime_types_1 = require("../../shared/runtime-types");
const wire_guards_1 = require("../wire-guards");
/**
 * core ContentBlock[] -> AssistantBlock[] (classifier shared by finalized messages and partial block-end).
 * @param content - core content blocks verbatim.
 * @returns UI-classified blocks in source order.
 */
function toAssistantBlocks(content) {
    return content.map(toAssistantBlock);
}
/**
 * Classify one block (ToolCallBlock fields are id/arguments, mapped to callId/argsRaw).
 * @param block - one core content block.
 * @returns the UI classification.
 */
function toAssistantBlock(block) {
    if (!(0, runtime_types_1.isObjectRecord)(block))
        return { kind: 'other', block };
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string')
        return { kind: block.type, text: block.text };
    if (block.type === 'image' && (0, wire_guards_1.isImageAttachmentRef)(block.attachment))
        return { kind: 'image', attachment: block.attachment };
    if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string')
        return { kind: 'tool-call', callId: block.id, name: block.name, argsRaw: block.arguments };
    return { kind: 'other', block };
}
const EMPTY_LIST = [];
const EMPTY_TIMELINE = { turnOrder: EMPTY_LIST, turns: new Map() };
/** Empty target store used by fixtures and Sessions without registered views. */
exports.EMPTY_CONVERSATION_VIEWS = {
    get: () => undefined,
};
/** Empty Chat target used before a view builder is registered. */
exports.EMPTY_CHAT_SNAPSHOT = {
    order: EMPTY_LIST,
    nodes: {
        get: () => undefined,
        values: () => EMPTY_LIST,
    },
    locations: {
        getTurn: () => EMPTY_LIST,
        getStep: () => EMPTY_LIST,
    },
    timeline: EMPTY_TIMELINE,
    legacy: {
        nodes: EMPTY_LIST,
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: EMPTY_LIST,
    },
};

},
"src/modules/conversation/chat/chunk-values.js": function(module, exports, require) {
// source: src/modules/conversation/chat/chunk-values.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyAssistantBlock = emptyAssistantBlock;
exports.isTokenDelta = isTokenDelta;
/** The UI-local chunk vocabulary admits file/foreign block starts as opaque. */
function emptyAssistantBlock(blockType) {
    switch (blockType) {
        case 'text': return { kind: 'text', text: '' };
        case 'reasoning': return { kind: 'reasoning', text: '' };
        case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' };
        default: return { kind: 'other', block: null };
    }
}
function isTokenDelta(chunk) {
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta': return chunk.text !== '';
        case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined;
        default: return false;
    }
}

},
"src/modules/conversation/stores.js": function(module, exports, require) {
// source: src/modules/conversation/stores.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatStore = createChatStore;
const chat_store_codec_1 = require("./contract/chat-store-codec");
const runtime_values_1 = require("./runtime-values");
/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
function createChatStore() {
    return (0, runtime_values_1.defineStore)({
        // Anchored to the contract shape: consumers read the store through
        // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
        // and the contract cannot drift.
        init: () => ({ selection: null, draft: '', view: null, inspect: null }),
        persist: 'dsh.conversation.chat',
        decode: chat_store_codec_1.decodeChatStoreState,
        bake: (bind, actions) => ({ select: bind(actions.select), setDraft: bind(actions.setDraft), setView: bind(actions.setView), setInspect: bind(actions.setInspect) }),
        actions: {
            select: (d, target) => { d.selection = target; },
            setDraft: (d, text) => { d.draft = text; },
            setView: (d, view) => { d.view = view; },
            setInspect: (d, target) => { d.inspect = target; },
        },
    });
}

},
"src/modules/conversation/contract/chat-store-codec.js": function(module, exports, require) {
// source: src/modules/conversation/contract/chat-store-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeChatStoreState = decodeChatStoreState;
const zod_1 = require("zod");
const schema = zod_1.z.looseObject({
    selection: zod_1.z.looseObject({ turnSeq: zod_1.z.number(), stepSeq: zod_1.z.number().optional(), callId: zod_1.z.string().optional(), toolName: zod_1.z.string().optional() }).nullable(),
    draft: zod_1.z.string(), view: zod_1.z.string().nullable().default(null),
    // Original consumers used ??null for pre-inspect persisted snapshots.
    inspect: zod_1.z.looseObject({ callId: zod_1.z.string() }).nullable().default(null),
});
/** Admit original persisted drafts, retained unknown view ids and foreign fields. */
function decodeChatStoreState(value) { return schema.parse(value); }

},
"src/modules/conversation/service.js": function(module, exports, require) {
// source: src/modules/conversation/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationController = exports.UnsupportedImageMediaTypeError = void 0;
const core_context_1 = require("./core-context");
/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
const cordis_1 = require("@xharness/cordis");
const Service = cordis_1.Service;
const attachments_1 = require("./attachments");
/** Unsupported browser-declared image type, localized by the UI boundary. */
class UnsupportedImageMediaTypeError extends Error {
    /** @param mediaType - Browser-declared MIME value, possibly empty. */
    constructor(mediaType) {
        super(`unsupported image media type: ${mediaType || '(empty)'}`);
        this.name = 'UnsupportedImageMediaTypeError';
        this.mediaType = mediaType;
    }
}
exports.UnsupportedImageMediaTypeError = UnsupportedImageMediaTypeError;
/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
class ConversationController extends Service {
    /**
     * @param ctx - owning root context (the plugin apply context; the service
     * registers itself and follows that fiber's lifetime).
     * @param config - carries the SessionInputResolver and composer-block registry
     * constructed by the plugin apply (the same instances the slot inject
     * factories close over).
     */
    constructor(ctx, config) {
        super((0, core_context_1.requireCoreContext)(ctx), 'conversation');
        this.draftAttachments = new Map();
        this.imageUrls = new Map();
        this.imageGenerations = new Map();
        this.createdImageUrls = new Set();
        this.disposed = false;
        this.input = config.input;
        this.blocks = config.blocks;
        ctx.effect(() => () => {
            this.disposed = true;
            for (const url of this.createdImageUrls)
                revokePreview(url);
            this.createdImageUrls.clear();
            this.draftAttachments.clear();
            this.imageUrls.clear();
            this.imageGenerations.clear();
        }, 'conversation attachment URL cache');
    }
    /**
     * Send a prompt into the scoped session. Business failures also land in the
     * session snapshot's promptError (object-layer state); the rejection here
     * exists for caller choreography (the composer restores the draft on it).
     * @param text - prompt text, sent verbatim as one text block.
     */
    async send(text) {
        const session = this.scopedSession('send');
        const result = await session.prompt([{ type: 'text', text }], 'queue');
        if (!result.ok)
            throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`);
    }
    /**
     * Submit ordered draft images with text through one host admission.
     * @param session - target session.
     * @param text - serialized prompt text.
     * @param imageIds - ordered draft-local attachment ids.
     * @param mode - queue or steer delivery selected by composer policy.
     * @param signal - optional cancellation for the complete Host admission.
     * @returns the Host admission outcome; local attachment preparation failures reject.
     */
    async sendSession(session, text, imageIds, mode, signal, requireIdle = false) {
        const attachments = this.draftImages(imageIds);
        if (attachments.length !== imageIds.length) {
            throw new Error('conversation.sendSession: one or more draft images are no longer available');
        }
        const parts = await Promise.all(attachments.map(async (attachment) => {
            if (attachment.historyRef)
                return attachment.historyKind === 'file'
                    ? { type: 'file_ref', attachmentId: attachment.historyRef.attachmentId, name: attachment.file.name }
                    : { type: 'image_ref', attachmentId: attachment.historyRef.attachmentId };
            const [part] = await this.serializeImages([attachment.file]);
            if (!part)
                throw new Error('attachment serialization failed');
            return part;
        }));
        const content = [...parts, ...(text === '' ? [] : [{ type: 'text', text }])];
        const result = await session.prompt(content, mode, signal, { requireIdle });
        if (!result.ok)
            return { kind: 'error' };
        this.releaseDraftImages(attachments);
        return { kind: 'success' };
    }
    /**
     * Create runtime-only draft images and their object URLs.
     * @param files - browser files to register after MIME validation.
     * @returns ordered draft descriptors.
     */
    createDraftImages(files) {
        (0, attachments_1.validateAttachments)(files);
        return files.map((file) => {
            const attachment = (0, attachments_1.browserDraftAttachment)(file);
            this.draftAttachments.set(attachment.id, attachment);
            this.createdImageUrls.add(attachment.previewUrl);
            return attachment;
        });
    }
    /**
     * Resolve ordered input-state ids to runtime-owned draft images.
     * @param ids - draft attachment ids.
     * @returns descriptors that remain live, in requested order.
     */
    draftImages(ids) {
        const attachments = [];
        for (const id of ids) {
            const attachment = this.draftAttachments.get(id);
            if (attachment !== undefined)
                attachments.push(attachment);
        }
        return attachments;
    }
    /**
     * Serialize ordered draft images to command-submit wire payloads without
     * sending or releasing them (the composer releases only after the command
     * settles successfully).
     * @param imageIds - ordered draft-local attachment ids.
     * @returns base64 payloads in id order.
     */
    async serializeDraftImages(imageIds) {
        const attachments = this.draftImages(imageIds);
        if (attachments.length !== imageIds.length) {
            throw new Error('conversation.serializeDraftImages: one or more draft images are no longer available');
        }
        if (attachments.some(attachment => attachment.kind === 'file' || attachment.historyKind === 'file'))
            throw Error("斜杠命令暂不支持普通文件附件，请作为普通消息发送；草稿已保留。");
        return Promise.all(attachments.map(attachment => this.encodeImage(attachment.file)));
    }
    /**
     * Release one browser-owned draft image and preview URL.
     * @param id - draft attachment id.
     */
    releaseDraftImage(id) {
        const attachment = this.draftAttachments.get(id);
        if (attachment === undefined)
            return;
        this.draftAttachments.delete(id);
        this.createdImageUrls.delete(attachment.previewUrl);
        revokePreview(attachment.previewUrl);
    }
    /**
     * Release a set of browser-owned draft images.
     * @param attachments - descriptors to release.
     */
    releaseDraftImages(attachments) {
        for (const attachment of attachments)
            this.releaseDraftImage(attachment.id);
    }
    /**
     * Resolve and cache one session-authorized historical image URL.
     * @param sessionId - owning session authorization scope.
     * @param attachment - durable image reference.
     * @returns browser URL valid until its rendered session is released.
     */
    resolveImage(sessionId, attachment) {
        if (this.disposed)
            return Promise.reject(new Error('conversation.resolveImage: service is disposed'));
        const key = `${sessionId}:${attachment.attachmentId}`;
        const cached = this.imageUrls.get(key);
        if (cached !== undefined)
            return cached.pending;
        const generation = this.imageGenerations.get(sessionId) ?? 0;
        const session = this.requireSessions().binding(sessionId)?.session;
        if (session === undefined) {
            return Promise.reject(new Error(`conversation.resolveImage: unknown session "${sessionId}"`));
        }
        const pending = session.readAttachment(attachment.attachmentId)
            .then((result) => {
            if (!result.ok)
                throw new Error(`${result.error.code}: ${result.error.message}`);
            if (this.disposed)
                throw new Error('conversation.resolveImage: service was disposed before loading completed');
            if ((this.imageGenerations.get(sessionId) ?? 0) !== generation) {
                throw new Error('historical image scope was released before loading completed');
            }
            if (typeof URL.createObjectURL !== 'function') {
                return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`;
            }
            const bytes = Uint8Array.from(result.value.data);
            const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }));
            this.createdImageUrls.add(url);
            return url;
        })
            .catch((error) => {
            if (this.imageUrls.get(key)?.generation === generation)
                this.imageUrls.delete(key);
            throw error;
        });
        this.imageUrls.set(key, { sessionId, generation, pending });
        return pending;
    }
    /**
     * Release every historical image URL owned by one rendered session.
     * @param sessionId - rendered session scope.
     */
    releaseSessionImages(sessionId) {
        this.imageGenerations.set(sessionId, (this.imageGenerations.get(sessionId) ?? 0) + 1);
        for (const [key, entry] of this.imageUrls) {
            if (entry.sessionId !== sessionId)
                continue;
            this.imageUrls.delete(key);
            void entry.pending.then((url) => {
                if (!this.createdImageUrls.delete(url))
                    return;
                revokePreview(url);
            }, () => {
                // A failed or invalidated load owns no object URL.
            });
        }
    }
    /** Replace one editor hydration preview without leaking the prior URL. */
    replaceDraftPreview(image, file) {
        const url = URL.createObjectURL(file);
        this.createdImageUrls.add(url);
        this.createdImageUrls.delete(image.previewUrl);
        revokePreview(image.previewUrl);
        image.file = file;
        image.previewUrl = url;
        image.loadState = 'ready';
    }
    /** Apply one operation to a pending queue occurrence. */
    async updateQueue(itemId, action) {
        const session = this.scopedSession('updateQueue');
        const result = await session.updateQueue(itemId, action);
        if (!result.ok) {
            if (action.kind === 'steer'
                && (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found'))
                return;
            throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`);
        }
    }
    /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
    async cancel() {
        const session = this.scopedSession('cancel');
        const result = await session.cancel();
        if (!result.ok)
            throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`);
    }
    /** Pull one older history page for the scoped Session. */
    async loadOlder() {
        await this.scopedSession('loadOlder').loadOlder();
    }
    /** Resolve the caller scope's session face or throw on root contexts. */
    scopedSession(op) {
        const id = this.scopeId(op);
        const binding = this.requireSessions().binding(id);
        if (binding === undefined)
            throw new Error(`conversation.${op}: session "${id}" resolved no binding`);
        return binding.session;
    }
    /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
    scopeId(op) {
        const id = this.requireSessions().scopeOf(this.ctx);
        if (id === undefined) {
            throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`);
        }
        return id;
    }
    requireSessions() {
        // Strict ctx.get, not the injection proxy: the scope-addressed pattern
        // reads the service off whatever context the tracker rebound.
        const sessions = this.ctx.get('sessions');
        if (!(0, core_context_1.isSessions)(sessions))
            throw new Error('conversation: sessions service unavailable');
        return sessions;
    }
    /** Convert browser files to canonical base64 prompt parts. */
    serializeImages(images) {
        return Promise.all(images.map(async (file) => ({ type: (0, attachments_1.attachmentKind)(file), mediaType: (0, attachments_1.attachmentMediaType)(file), data: bytesToBase64(new Uint8Array(await file.arrayBuffer())), ...(file.name === '' ? {} : { name: file.name }) })));
    }
    /** Canonical base64 wire form of one browser image file. */
    async encodeImage(file) {
        return {
            mediaType: imageMediaType((0, attachments_1.attachmentMediaType)(file)),
            data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
            ...(file.name === '' ? {} : { name: file.name }),
        };
    }
}
exports.ConversationController = ConversationController;
function imageMediaType(value) {
    switch (value) {
        case 'image/png':
        case 'image/jpeg':
        case 'image/webp':
        case 'image/gif':
            return value;
        default:
            throw new UnsupportedImageMediaTypeError(value);
    }
}
function bytesToBase64(data) {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < data.length; offset += chunk) {
        binary += String.fromCharCode(...data.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}
function revokePreview(url) {
    if (url.startsWith('blob:'))
        URL.revokeObjectURL(url);
}

},
"src/modules/conversation/core-context.js": function(module, exports, require) {
// source: src/modules/conversation/core-context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCoreContext = requireCoreContext;
exports.isSessions = isSessions;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
/** Cordis' real brand proves the base constructor, not a fabricated structural SDK. */
function requireCoreContext(value) {
    if (!cordis_1.Context.is(value))
        throw new Error('conversation requires a Cordis Context');
    return value;
}
/** Validate the injected service capabilities at their first actual use. */
function isSessions(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value) || !(0, runtime_types_1.isObjectRecord)(value.list))
        return false;
    return typeof value.list.getSnapshot === 'function' && typeof value.list.subscribe === 'function'
        && typeof value.scopeOf === 'function' && typeof value.scope === 'function'
        && typeof value.binding === 'function' && typeof value.open === 'function'
        && typeof value.fork === 'function' && typeof value.provide === 'function';
}

},
"src/modules/conversation/input/blocks.js": function(module, exports, require) {
// source: src/modules/conversation/input/blocks.ts

"use strict";
/**
 * Composer blocks: the one way another plugin stops a session's input.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so a blocker pushes here and the
 * bar reads its own session's store. A block carries the localized reason it
 * exists, because the plugin that raised it owns that copy; the composer only
 * knows how to render an inert textarea with a placeholder, exactly as it
 * already does for a session with no workspace.
 *
 * This is an affordance, not enforcement: the Host refuses a prompt it cannot
 * route regardless of what any client disables.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComposerBlockRegistry = void 0;
const runtime_values_1 = require("../runtime-values");
/** The per-session composer-block registry (one instance per plugin fiber). */
class ComposerBlockRegistry {
    constructor() {
        this.stores = new Map();
    }
    /** @inheritdoc */
    set(sessionId, block) {
        const store = this.storeFor(sessionId);
        const current = store.getSnapshot();
        if (current?.reason === block?.reason)
            return;
        store.set(block);
    }
    /** @inheritdoc */
    storeFor(sessionId) {
        const existing = this.stores.get(sessionId);
        if (existing !== undefined)
            return existing;
        const created = (0, runtime_values_1.createSnapshotStore)(undefined);
        this.stores.set(sessionId, created);
        return created;
    }
    /** @inheritdoc */
    forget(sessionId) {
        this.stores.delete(sessionId);
    }
}
exports.ComposerBlockRegistry = ComposerBlockRegistry;

},
"src/modules/conversation/input/hub.js": function(module, exports, require) {
// source: src/modules/conversation/input/hub.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputHub = void 0;
const MessageEditor_1 = require("../edit/MessageEditor");
const persistence_1 = require("../edit/persistence");
const store_1 = require("../queue/store");
const facade_1 = require("./facade");
/** Session-addressed input facade registry (SessionInputResolver face + composer-layer extras). */
class InputHub {
    /**
     * @param ctx - client root context (services resolved lazily per call — boot order stays free).
     * @param t - conversation-namespace translate thunk (reads the active locale at call time).
     */
    constructor(rootCtx, t, onPromptDispatch) {
        this.rootCtx = rootCtx;
        this.t = t;
        this.onPromptDispatch = onPromptDispatch;
        this.shells = new Map();
    }
    /**
     * Resolve the facade for one session-scope ctx (SessionInputResolver face).
     * @param actx - session-scope context.
     * @returns the resident per-session facade.
     */
    for(actx) {
        const sessions = this.sessions();
        const id = sessions.scopeOf(actx);
        if (id === undefined)
            throw new Error('conversation.input.for requires a session scope');
        return this.shell(id);
    }
    /**
     * Resident shell for one session binding — the provide-channel entry
     * (called during scope materialization, BEFORE the scope record is
     * queryable, hence binding-fed and hence the thunked slash/popup deps).
     * Wires the scoped event listeners + teardown into the session scope.
     * @param binding - session assembly handle.
     * @returns the shell.
     */
    shellFor(binding) {
        const existing = this.shells.get(binding.sessionId);
        if (existing !== undefined)
            return existing;
        const { sessionId: id, session, ctx: actx } = binding;
        const shell = new facade_1.SessionInputShell({
            actx,
            inputTriggers: () => this.controller(actx),
            popup: () => this.popup(actx),
            queue: (0, store_1.queueReadFaceOf)(session),
            defaultSink: (text, imageIds, mode, signal) => this.sink(session, text, imageIds, mode, signal),
            steerQueue: () => { void this.steerQueue(session, shell); },
            commandImages: {
                serialize: ids => this.conversation().serializeDraftImages(ids),
                // Asymmetric with serialize on purpose: release settles AFTER the
                // submit RPC, where session teardown may already have unloaded the
                // conversation service (the same tolerance as the scope disposer
                // above); leaked preview URLs then die with the document.
                release: (ids) => {
                    const conversation = this.rootCtx.get('conversation');
                    for (const imageId of ids)
                        conversation?.releaseDraftImage(imageId);
                },
                unsupportedNotice: token => this.t('command.imagesUnsupported', {
                    command: token.trim().replace(/^\//u, ''),
                }),
            },
        });
        this.shells.set(id, shell);
        const hub = this;
        shell.xhEditor = new MessageEditor_1.XHarnessMessageEditor({ id, shell, get conversation() { return hub.conversation(); }, storage: persistence_1.xhEditPersistence, t: this.t,
            running: () => this.sessions().list.getSnapshot().byId[id]?.running === true,
            read: attachmentId => session.readAttachment(attachmentId),
            focus: () => requestAnimationFrame(() => { const seat = document.querySelector('[data-xh-editor-session="' + CSS.escape(id) + '"]')?.parentElement; const input = seat?.querySelector('textarea'); if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            } }),
        });
        // The one teardown axis: listeners, shell, and map entries all ride the
        // scope fiber (nothing here outlives the scope).
        actx.effect(() => {
            const offs = [
                actx.on('slash/input-begin-command', req => shell.beginCommand(req.claim, req.span) ? true : undefined),
                actx.on('slash/input-insert-reference', req => shell.insertReference(req.reference, req.span) ? true : undefined),
                actx.on('slash/input-consume-token', req => shell.consumeToken(req.guard) ? true : undefined),
                actx.on('slash/input-insert-text', req => shell.insertText(req.text, req.span, req.continue === true) ? true : undefined),
            ];
            return () => {
                for (const off of offs)
                    off();
                const drafts = shell.snapshot.imageIds;
                shell.dispose();
                this.shells.delete(id);
                const conversation = this.rootCtx.get('conversation');
                for (const imageId of drafts)
                    conversation?.releaseDraftImage(imageId);
            };
        }, 'conversation.input: session shell');
        return shell;
    }
    /**
     * Resident shell by session id (service-face path; the provide channel has
     * normally created it already — this covers direct id-addressed access).
     * @param id - session id.
     * @returns the shell.
     */
    shell(id) {
        const existing = this.shells.get(id);
        if (existing !== undefined)
            return existing;
        const binding = this.sessions().binding(id);
        if (binding === undefined)
            throw new Error(`conversation.input: session "${id}" resolved no binding`);
        return this.shellFor(binding);
    }
    /**
     * The InputBar-exclusive keyboard command face: the shell
     * satisfies it structurally; package-internal — handed through the
     * composer-bar entry's inject, never across a plugin boundary.
     * @param id - session id.
     * @returns the shell as the keyboard face.
     */
    keyboard(id) {
        return this.shell(id);
    }
    /**
     * Resolve the optional slash controller for composer chrome that launches
     * the shared candidate menu without typing a trigger.
     * @param id - session id.
     * @returns the resident controller, or undefined when ui-input-trigger is absent.
     */
    inputTriggers(id) {
        const actx = this.sessions().scope(id);
        return actx === undefined ? undefined : this.controller(actx);
    }
    /**
     * Default sink: optimistic clear + prompt. The session is always a real
     * host entity (materialized when its workspace was picked), so there is
     * exactly one path; a failed first prompt is an ordinary prompt failure
     * (banner via promptError, draft restored only while untouched).
     */
    async sink(session, text, imageIds, mode, signal) {
        if (text === '' && imageIds.length === 0)
            return Promise.resolve({ kind: 'success' });
        const editor = this.shell(session.sessionId).xhEditor;
        editor?.guardSubmit();
        const editing = editor?.state.editing === true;
        // Local gesture, not a later RPC receipt: a reader gesture while admission
        // is pending wins, including rejection/cancellation and delayed steering.
        this.onPromptDispatch?.(session.sessionId);
        const result = await this.conversation().sendSession(session, text, imageIds, mode, signal, editing);
        if (editing && result.kind === 'success')
            await editor?.sent();
        return result;
    }
    /**
     * Steer every still-pending queued message into the running turn, in FIFO
     * order — the same strict-steer operation as the queue dock's per-row
     * button. A turn closing mid-way (`steer-unavailable`) or a row already
     * claimed by the agent (`queue-item-not-found`) converges silently, while a
     * genuine failure surfaces as one composer notice. Repeated triggers
     * (e.g. two rapid empty-draft chords) rely on that `queue-item-not-found`
     * convergence: the snapshot may still list a row the host already steered,
     * and the duplicate strict steer is a silent no-op.
     * @param session - the addressed host session.
     * @param shell - the resident shell (notice outlet).
     */
    async steerQueue(session, shell) {
        const queued = session.getSnapshot().queue.filter(item => item.placement === 'queued');
        if (queued.length === 0)
            return;
        this.onPromptDispatch?.(session.sessionId);
        for (const item of queued) {
            const result = await session.updateQueue(item.id, { kind: 'steer' });
            if (result.ok)
                continue;
            if (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found')
                return;
            shell.notify('error', this.t('queue.steerFailed'));
            return;
        }
    }
    controller(actx) {
        const inputTriggers = this.rootCtx.get('inputTriggers');
        return inputTriggers?.sessionOf(actx);
    }
    popup(actx) {
        const command = this.rootCtx.get('commandUi');
        return command?.popupFor(actx);
    }
    sessions() {
        const sessions = this.rootCtx.get('sessions');
        if (sessions === undefined)
            throw new Error('conversation.input: sessions service unavailable');
        return sessions;
    }
    conversation() {
        const conversation = this.rootCtx.get('conversation');
        if (conversation === undefined)
            throw new Error('conversation.input: conversation service unavailable');
        return conversation;
    }
}
exports.InputHub = InputHub;

},
"src/modules/conversation/edit/persistence.js": function(module, exports, require) {
// source: src/modules/conversation/edit/persistence.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhEditPersistence = void 0;
exports.xhEditStorage = xhEditStorage;
const runtime_types_1 = require("../../shared/runtime-types");
const wire_guards_1 = require("../wire-guards");
/** Portable bytes, not File handles: WebKit may abort IndexedDB writes containing File blobs. */
function xhEditStorage() {
    let database;
    const fileBytes = new WeakMap();
    const encodeDraft = async (draft) => draft === null ? null : { ...draft, images: await Promise.all(draft.images.map(async (image) => {
            if (!image.file)
                return image;
            let bytes = fileBytes.get(image.file);
            if (!bytes) {
                bytes = image.file.arrayBuffer();
                fileBytes.set(image.file, bytes);
            }
            return { blob: await bytes, name: image.file.name, type: image.file.type, lastModified: image.file.lastModified };
        })) };
    const decodeDraft = (draft) => ({ ...draft, images: draft.images.map(image => 'blob' in image ? { file: new File([image.blob], image.name, { type: image.type, lastModified: image.lastModified }) } : image) });
    const access = async (mode, operation) => {
        database ?? (database = new Promise((resolve, reject) => { const request = indexedDB.open('xharness-message-edits-v1', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
        const db = await database;
        return new Promise((resolve, reject) => { const tx = db.transaction('drafts', mode), request = operation(tx.objectStore('drafts')); tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Draft storage failed')); });
    };
    return {
        load: async (id) => { const raw = await access('readonly', store => { const request = store.get(id); return request; }); if (raw !== undefined && !storedRecord(raw))
            throw new Error('Stored draft is invalid'); const record = raw; return record ? { version: 1, backup: record.backup ? decodeDraft(record.backup) : null, draft: decodeDraft(record.draft) } : undefined; },
        save: async (id, value) => { const draft = await encodeDraft(value.draft); if (!draft)
            throw Error('Draft unavailable'); const record = { version: 1, backup: await encodeDraft(value.backup), draft }; await access('readwrite', store => store.put(record, id)); },
        remove: async (id) => { await access('readwrite', store => store.delete(id)); },
    };
}
exports.xhEditPersistence = xhEditStorage();
function storedImage(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value))
        return false;
    if ('blob' in value)
        return value.blob instanceof ArrayBuffer && typeof value.name === 'string' && typeof value.type === 'string' && typeof value.lastModified === 'number';
    return (0, wire_guards_1.isImageAttachmentRef)(value.ref) && value.file === undefined
        && (value.kind === undefined || value.kind === 'image' || value.kind === 'file')
        && (value.name === undefined || typeof value.name === 'string') && (value.type === undefined || typeof value.type === 'string');
}
function storedDraft(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.text === 'string' && (0, wire_guards_1.isUnknownArray)(value.images) && value.images.every(storedImage);
}
function storedRecord(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && value.version === 1 && (value.backup === null || storedDraft(value.backup)) && storedDraft(value.draft);
}

},
"src/modules/conversation/queue/store.js": function(module, exports, require) {
// source: src/modules/conversation/queue/store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueReadFaceOf = queueReadFaceOf;
/**
 * Project a session's transient inbox rows as a bare observable (subscribe/getSnapshot).
 * The wiring layer overlays this onto InputState.queue; the runtime
 * QueuedMessage and the input-contract QueuedMessage are structurally
 * identical.
 * @param session - the resident session face.
 * @returns the queue read face (snapshot reference stable while the queue is unchanged).
 */
function queueReadFaceOf(session) {
    return {
        getSnapshot: () => session.getSnapshot().queue,
        subscribe: fn => session.subscribe(fn),
    };
}

},
"src/modules/conversation/input/facade.js": function(module, exports, require) {
// source: src/modules/conversation/input/facade.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionInputShell = void 0;
const runtime_values_1 = require("../runtime-values");
const machine_1 = require("./machine");
/** Guard tier from the machine phase. */
function guardOf(phase) {
    switch (phase) {
        case 'plain': return 'plain';
        case 'claimed': return 'claimed';
        default: return 'frozen'; // adjudicating / submitting
    }
}
const EMPTY_QUEUE = [];
/** No-pipeline lexicon: zero text-ref decorations. */
const EMPTY_LEXICON = new Map();
/**
 * The per-session input facade: scoped-event application verbs +
 * setDraft/submit + the published InputState store.
 */
class SessionInputShell {
    constructor(deps) {
        this.deps = deps;
        /** Latest surfaced notice (null after clear); the bar renders errors as banners and information inline. */
        this.notices = (0, runtime_values_1.createSnapshotStore)(null);
        /** The public provide-channel action face (one stable identity per session). */
        this.actions = {
            setDraft: (text) => { this.setDraft(text); },
            addImages: ids => this.addImages(ids),
            removeImage: (id) => { this.removeImage(id); },
            pruneImages: (ids) => { this.pruneImages(ids); },
            submit: () => { this.submit('queue'); },
        };
        // Real wall clock: the typing-run merge window must actually expire in
        // production (the machine's no-clock default is a constant for pure tests).
        this.core = new machine_1.InputMachine({ now: () => Date.now() });
        this.noticeSeq = 0;
        this.lastMirroredDraft = '';
        this.imageIds = [];
        /** One image-only send at a time: Enter during the Host round-trip is a no-op. */
        this.imageSendInFlight = false;
        this.disposed = false;
        /**
         * Hot plain-text reference lexicon source for the decoration scan
         * (the plain-text-reference decision;
         * see .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
         * delegates to the controller's aggregated store. Stable
         * identity per shell; without a pipeline the snapshot is the empty Map and
         * subscribers never fire.
         */
        this.lexicon = {
            getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
            subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => { }),
        };
        this.state = (0, runtime_values_1.createSnapshotStore)(this.compose());
        deps.queue?.subscribe(() => { this.publish(); });
    }
    // ---- SessionInput face ----
    /**
     * Single draft write path (all mutation rides machine events).
     * @param text - the full next draft.
     * @param editRange - the DOM-observed edit shape, when the caller knows it
     * (narrows the machine's occurrence math; absent → diff scan).
     */
    setDraft(text, editRange) {
        this.run(this.core.dispatch({ type: 'draft-changed', draft: text, ...(editRange !== undefined ? { editRange } : {}) }));
    }
    /** Append ordered image ids unless an admission transaction is locked. */
    addImages(ids) {
        if (this.imageSendInFlight || this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting')
            return false;
        if (ids.length === 0)
            return true;
        this.imageIds = [...this.imageIds, ...ids];
        this.publish();
        return true;
    }
    /**
     * Remove one image id from this draft. Busy admission phases refuse, like
     * {@link addImages}: a removal landing while a command submit serializes
     * would otherwise vanish from the rail yet still ride the in-flight send.
     */
    removeImage(id) {
        if (this.imageSendInFlight || this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting')
            return;
        const next = this.imageIds.filter(candidate => candidate !== id);
        if (next.length === this.imageIds.length)
            return;
        this.imageIds = next;
        this.publish();
    }
    /**
     * Keep only image ids that still resolve in the browser attachment registry.
     * @param available - live registry ids.
     */
    pruneImages(available) {
        const keep = new Set(available);
        const next = this.imageIds.filter(id => keep.has(id));
        if (next.length === this.imageIds.length)
            return;
        this.imageIds = next;
        this.publish();
    }
    /**
     * Clear the draft as a successful-send commit: no undo unit is recorded and
     * the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent content
     * (the command path gets the same discipline from submit-settled success).
     * @param imageIds - admitted image ids to remove from this draft.
     */
    commitSend(imageIds) {
        const submitted = new Set(imageIds);
        this.imageIds = this.imageIds.filter(id => !submitted.has(id));
        this.run(this.core.dispatch({ type: 'send-committed' }));
    }
    /** Undo the latest transaction (InputBar intercepts the platform chord). */
    undo() {
        this.run(this.core.dispatch({ type: 'undo' }));
    }
    /** Redo the latest undone transaction. */
    redo() {
        this.run(this.core.dispatch({ type: 'redo' }));
    }
    /**
     * Paste text over the selection in one transaction, with any hot-snapshot
     * sync matches componentized inside it.
     * @param text - pasted plain text.
     * @param selection - replaced selection in draft coordinates.
     * @param components - sync-matched reference components (disjoint, inside `text`).
     * @param generation - projection generation for late async-upgrade guards.
     */
    pasteBegin(text, selection, components, generation) {
        this.run(this.core.dispatch({
            type: 'paste-begin', text, selection,
            ...(components !== undefined ? { components } : {}),
            ...(generation !== undefined ? { generation } : {}),
        }));
    }
    /** End the live paste-match attempt (caret/selection ops and Slash updates the machine cannot see). */
    invalidatePaste() {
        this.run(this.core.dispatch({ type: 'invalidate-paste' }));
    }
    /**
     * Enter adjudication + submit transaction + default sink. Effects fan out
     * from the machine; this method only feeds the event. Lock entry
     * (adjudicating/submitting) force-closes the transient layers: the popup
     * dismisses and the menu tracks frozen.
     */
    submit(mode = 'queue') {
        try {
            this.xhEditor?.guardSubmit();
        }
        catch (error) {
            this.notify('error', String(error));
            return;
        }
        if (this.snapshot.draft.trim() === '' && this.imageIds.length > 0) {
            if (this.snapshot.phase === 'plain' && !this.imageSendInFlight) {
                const imageIds = [...this.imageIds];
                this.imageSendInFlight = true;
                void this.deps.defaultSink('', imageIds, mode, new AbortController().signal).then((outcome) => {
                    this.imageSendInFlight = false;
                    if (this.disposed)
                        return;
                    if (outcome.kind === 'success')
                        this.commitSend(imageIds);
                    else if (outcome.text !== undefined)
                        this.notify('error', outcome.text);
                }, (error) => {
                    this.imageSendInFlight = false;
                    if (!this.disposed)
                        this.notify('error', error instanceof Error ? error.message : String(error));
                });
            }
            return;
        }
        // Claimed pre-gate: a claim that does not declare image acceptance never
        // submits while images are attached — one notice, everything retained.
        // Enter-time adjudication applies the same policy for unclaimed lines
        // inside the command source itself.
        const before = this.snapshot;
        if (before.phase === 'claimed' && this.imageIds.length > 0 && before.claim?.images !== true) {
            this.notify('error', this.deps.commandImages.unsupportedNotice(before.claim?.token ?? before.draft));
            return;
        }
        this.run(this.core.dispatch({ type: 'enter', mode }));
        const phase = this.snapshot.phase;
        if (phase === 'adjudicating' || phase === 'submitting') {
            this.deps.popup?.()?.dismiss();
            this.deps.inputTriggers?.()?.track(this.snapshot.draft, 0, { tier: 'frozen' }, this.snapshot.draftRev);
        }
    }
    /**
     * Feed a draft/caret change through trigger detection (guard derived from
     * the machine phase).
     * @param draft - live draft text.
     * @param caret - caret position in draft coordinates.
     */
    track(draft, caret) {
        this.deps.inputTriggers?.()?.track(draft, caret, { tier: guardOf(this.snapshot.phase) }, this.snapshot.draftRev);
    }
    /**
     * Keyboard arbitration while the menu is open.
     * @param key - the intercepted key.
     * @param composing - IME composition guard state.
     * @returns the menu's verdict; 'pass' when no pipeline is mounted.
     */
    arbitrate(key, composing) {
        return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass';
    }
    /**
     * Steer every still-pending queued message into the running turn (the
     * empty-draft accelerated-Enter gesture). Execution belongs to the hub's
     * queue choreography; absent dep = the gesture falls back to the machine's
     * empty-draft no-op.
     */
    steerQueue() {
        this.deps.steerQueue?.();
    }
    /**
     * Space adjudication over the controller's hot state.
     * @returns true = a claim/insert was applied — the caller preventDefaults.
     */
    space() {
        const inputTriggers = this.deps.inputTriggers?.();
        if (inputTriggers === undefined)
            return false;
        const consumed = inputTriggers.onSpace();
        // Machine-driven draft replacement never passes through onChange, so
        // re-track: the caret lands after the token, where detection sees
        // whitespace and closes the menu.
        if (consumed) {
            const next = this.snapshot;
            inputTriggers.track(next.draft, next.draft.length, { tier: guardOf(next.phase) }, next.draftRev);
        }
        return consumed;
    }
    /** Dismiss the popupSelect shell (any interaction outside the box). */
    dismissPopup() {
        this.deps.popup?.()?.dismiss();
    }
    /**
     * Apply one command claim (scoped begin-command event listener body).
     * @param claim - the command claim from the pick path.
     * @param span - pick-time span snapshot.
     * @returns whether the machine accepted (phase + span CAS passed and the draft mutated).
     */
    beginCommand(claim, span) {
        const before = this.core.state.draftRev;
        this.run(this.core.dispatch({ type: 'begin-command', claim, span }));
        return this.core.state.phase === 'claimed' && this.core.state.draftRev !== before;
    }
    /**
     * Apply one reference insertion (scoped insert-reference event listener body).
     * @param ref - the reference insertion from the pick path.
     * @param span - pick-time span snapshot.
     * @returns whether the machine accepted.
     */
    insertReference(ref, span) {
        const before = this.core.state.draftRev;
        this.run(this.core.dispatch({ type: 'insert-ref', reference: ref, span }));
        return this.core.state.draftRev !== before;
    }
    /**
     * Consume one command token after business success (scoped consume-token
     * event listener body). Span guard: revision CAS then splice; bare-token
     * guard: trimmed-draft equality then clear.
     * @param guard - exact span or bare-token guard.
     * @returns whether the token was consumed.
     */
    consumeToken(guard) {
        const snapshot = this.core.state;
        if (guard.kind === 'span') {
            if (guard.span.draftRev !== snapshot.draftRev)
                return false;
            const draft = snapshot.draft;
            this.setDraft(draft.slice(0, guard.span.start) + draft.slice(guard.span.end));
            return true;
        }
        if (snapshot.draft.trim() !== guard.token)
            return false;
        this.setDraft('');
        return true;
    }
    /**
     * Insert plain reference text over the pick-time span (scoped insert-text
     * event listener body; plain-text-reference decision, web-input-machine
     * note). Same CAS-then-splice shape as the
     * consume-token span branch: the machine sees an ordinary draft-changed
     * transaction (one undo step), no occurrence is minted — the chip look is
     * a scan-derived decoration, never state.
     * @param text - the plain reference text to splice in (e.g. `/name `).
     * @param span - pick-time span snapshot (draftRev CAS).
     * @param keepCompleting - re-track at the caret after the splice so an open
     * token (a directory pick's trailing slash) reopens the menu.
     * @returns whether the text was applied.
     */
    insertText(text, span, keepCompleting = false) {
        const snapshot = this.core.state;
        if (span.draftRev !== snapshot.draftRev)
            return false;
        const draft = snapshot.draft;
        this.setDraft(draft.slice(0, span.start) + text + draft.slice(span.end));
        if (keepCompleting) {
            // Machine-driven draft replacement never passes through onChange, so
            // re-track at the caret inside the still-open token (see space()).
            const next = this.snapshot;
            this.deps.inputTriggers?.()?.track(next.draft, span.start + text.length, { tier: guardOf(next.phase) }, next.draftRev);
        }
        return true;
    }
    /**
     * Surface a notice from outside the machine (detached command results).
     * @param level - severity tier.
     * @param text - notice body.
     */
    notify(level, text) {
        this.noticeSeq += 1;
        this.notices.set({ level, text, seq: this.noticeSeq });
    }
    // ---- wiring-layer extras (not on the frozen SessionInput face) ----
    /** Teardown: abort any in-flight attempt and stop accepting async settlements. */
    dispose() {
        this.xhEditor?.dispose();
        this.disposed = true;
        this.run(this.core.dispatch({ type: 'release' }));
    }
    /** Read the live machine state (guard derivation reads here). */
    get snapshot() {
        return this.state.getSnapshot();
    }
    /**
     * Bind the draft persistence mirror (chat store write). Adopt-on-bind: the
     * store draft may hold a persisted value from a previous mount; the caller
     * seeds it via setDraft BEFORE binding, and afterwards every machine-adopted
     * draft mirrors out.
     * @param write - store draft write.
     * @returns the unbind disposer.
     */
    bindMirror(write) {
        this.mirrorFn = write;
        return () => {
            if (this.mirrorFn === write)
                this.mirrorFn = undefined;
        };
    }
    // ---- effect executor ----
    run(effects) {
        for (const fx of effects)
            this.execute(fx);
        this.publish();
    }
    execute(fx) {
        switch (fx.type) {
            case 'notice': {
                this.noticeSeq += 1;
                this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq });
                return;
            }
            case 'adjudicate': {
                this.adjudicate(fx.attempt, fx.draft);
                return;
            }
            case 'begin-submit': {
                this.beginSubmit(fx.attempt, fx.claim, fx.args);
                return;
            }
            case 'default-sink': {
                this.sinkSerialized(fx.attempt, fx.draft, fx.mode);
                return;
            }
            default:
                return; // machine-internal effects (mirror rides publish)
        }
    }
    /**
     * Prompt serialization before the sink: expand each
     * inline reference range to its owner's model form via the session controller's
     * codec routing. Owner missing / serialize failure / disposal blocks the
     * send — notice + draft and chips retained, never a silent downgrade to
     * the clipboard text. Chip-free drafts skip the async detour.
     */
    sinkSerialized(attempt, draft, mode) {
        const imageIds = [...this.imageIds];
        const occurrences = this.core.state.occurrences;
        if (occurrences.length === 0) {
            this.settleSubmit(attempt, this.deps.defaultSink(draft.trim(), imageIds, mode, attempt.signal), imageIds);
            return;
        }
        const inputTriggers = this.deps.inputTriggers?.();
        const controller = new AbortController();
        void Promise.all(occurrences.map(async (o) => {
            if (inputTriggers === undefined)
                throw new Error(`no serializer for reference source "${o.source}"`);
            return {
                offset: o.offset,
                length: o.length,
                text: await inputTriggers.serializeReference(o.source, o.ref, controller.signal),
            };
        })).then((parts) => {
            if (this.disposed)
                return;
            // Splice model forms over their display ranges (offsets are draft-time;
            // parts arrive offset-sorted since the table is).
            let out = '';
            let cursor = 0;
            for (const part of parts) {
                out += draft.slice(cursor, part.offset) + part.text;
                cursor = part.offset + part.length;
            }
            out += draft.slice(cursor);
            this.settleSubmit(attempt, this.deps.defaultSink(out.trim(), imageIds, mode, attempt.signal), imageIds);
        }, (error) => {
            controller.abort();
            if (this.dead(attempt))
                return;
            const message = error instanceof Error ? error.message : String(error);
            this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }));
        });
    }
    /** Settle one admission attempt; successful sends consume only their captured images. */
    settleSubmit(attempt, pending, imageIds = []) {
        pending.then((outcome) => {
            if (this.dead(attempt))
                return;
            if (outcome.kind === 'success' && imageIds.length > 0) {
                const submitted = new Set(imageIds);
                this.imageIds = this.imageIds.filter(id => !submitted.has(id));
            }
            this.run(this.core.dispatch({
                type: 'submit-settled',
                attempt,
                ok: outcome.kind === 'success',
                outcome,
            }));
        }, (error) => {
            if (this.dead(attempt))
                return;
            this.run(this.core.dispatch({
                type: 'submit-settled',
                attempt,
                ok: false,
                message: error instanceof Error ? error.message : String(error),
            }));
        });
    }
    /** Enter adjudication: poll the session controller; failure = notice + draft retained (never a silent downgrade). */
    adjudicate(attempt, draft) {
        const inputTriggers = this.deps.inputTriggers?.();
        if (inputTriggers === undefined) {
            // No pipeline mounted: the '/' line is an ordinary message.
            this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome: undefined }));
            return;
        }
        inputTriggers.adjudicate(draft.trim(), attempt.signal, { images: this.imageIds.length }).then((outcome) => {
            if (this.dead(attempt))
                return;
            this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome }));
        }, (error) => {
            if (this.dead(attempt))
                return;
            const message = error instanceof Error ? error.message : String(error);
            this.run(this.core.dispatch({ type: 'adjudication-failed', attempt, message }));
        });
    }
    /**
     * The submit transaction: claim.submit against the session scope; ok maps
     * from the outcome kind. An accepting claim receives the serialized draft
     * images, which are cleared and released only on a success outcome; a
     * failure (serialize, transport, or handler error) keeps draft and images
     * for correction.
     */
    beginSubmit(attempt, claim, args) {
        const imageIds = claim.images === true ? [...this.imageIds] : [];
        Promise.resolve()
            .then(async () => {
            const images = imageIds.length > 0 ? await this.deps.commandImages.serialize(imageIds) : [];
            // Serialization may outlive the attempt (large files, session
            // teardown); a dead attempt must not reach the Host executor.
            if (this.dead(attempt))
                return undefined;
            return claim.submit(args, this.deps.actx, images);
        })
            .then((outcome) => {
            if (outcome === undefined || this.dead(attempt))
                return;
            if (outcome.kind === 'success' && imageIds.length > 0) {
                const submitted = new Set(imageIds);
                this.imageIds = this.imageIds.filter(id => !submitted.has(id));
                this.deps.commandImages.release(imageIds);
            }
            this.run(this.core.dispatch({
                type: 'submit-settled', attempt, ok: outcome.kind === 'success', outcome,
                ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
            }));
        }, (error) => {
            if (this.dead(attempt))
                return;
            const message = error instanceof Error ? error.message : String(error);
            this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }));
        });
    }
    /** Late-settlement guard: superseded attempts and disposed facades drop silently. */
    dead(attempt) {
        return this.disposed || attempt.signal.aborted;
    }
    compose() {
        const core = this.core.state;
        return { ...core, imageIds: this.imageIds, queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE };
    }
    publish() {
        const next = this.compose();
        this.state.set(next);
        const mirroredDraft = (0, machine_1.projectClipboard)(next);
        if (mirroredDraft !== this.lastMirroredDraft) {
            this.lastMirroredDraft = mirroredDraft;
            this.mirrorFn?.(mirroredDraft);
        }
    }
}
exports.SessionInputShell = SessionInputShell;

},
"src/modules/conversation/input/machine.js": function(module, exports, require) {
// source: src/modules/conversation/input/machine.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputMachine = exports.PLACEHOLDER = void 0;
exports.referenceDraftText = referenceDraftText;
exports.projectClipboard = projectClipboard;
/** Legacy fixed-width object replacement character rejected from pasted text. */
exports.PLACEHOLDER = '￼';
const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu;
/**
 * Build the inline draft text whose leading marker is decorated as the
 * reference icon in the backdrop.
 * @param reference - reference insertion with its cached display projection.
 * @returns display text with one marker glyph followed by the complete label.
 */
function referenceDraftText(reference) {
    return `@${reference.label}`;
}
/** The machine never writes the queue; the wiring layer overlays the queue store's projection. */
const EMPTY_QUEUE = [];
/** Undo ring depth (bounded self-managed transaction log). */
const LOG_LIMIT = 100;
/** Exhaustiveness backstop for the closed InputEvent / guard unions. */
function unreachable(value) {
    throw new Error(`unreachable input event: ${JSON.stringify(value)}`);
}
/**
 * Strip the claim token off a draft to yield submit args. Leading whitespace
 * (incl. newlines — leading-trigger trim) is tolerated; a bare `/name`
 * missing the token's trailing separator yields empty args. Exactly one
 * separator char is consumed; the remainder — newlines included — stays
 * verbatim (`/goal x\ny` → `x\ny`).
 */
function argsAfter(draft, token) {
    const s = draft.trimStart();
    if (s.startsWith(token))
        return s.slice(token.length);
    const base = token.trimEnd();
    if (s.startsWith(base)) {
        const rest = s.slice(base.length);
        return /^\s/.test(rest) ? rest.slice(1) : rest;
    }
    return '';
}
/**
 * Prefix/suffix common-scan recovering the edit range between two drafts
 * (used when the wiring layer cannot supply one from the DOM event).
 */
function diffEdit(prev, next) {
    let p = 0;
    const maxCommon = Math.min(prev.length, next.length);
    while (p < maxCommon && prev[p] === next[p])
        p += 1;
    let s = 0;
    const maxSuffix = maxCommon - p;
    while (s < maxSuffix && prev[prev.length - 1 - s] === next[next.length - 1 - s])
        s += 1;
    return { start: p, end: prev.length - s, insertedLength: next.length - s - p };
}
/**
 * Expand the draft's reference ranges into their occurrences' clipboard text
 * for persistence and clipboard projection. Table order is offset order, so
 * one linear walk pairs ranges with entries.
 * @param state - published input state.
 * @returns the plain-text projection of the draft.
 */
function projectClipboard(state) {
    const { draft, occurrences } = state;
    if (occurrences.length === 0)
        return draft;
    let out = '';
    let cursor = 0;
    for (const o of occurrences) {
        out += draft.slice(cursor, o.offset) + o.clipboardText;
        cursor = o.offset + o.length;
    }
    return out + draft.slice(cursor);
}
/**
 * Pure input machine, one instance per session (per-session isolation is by
 * construction). The machine constructs one AbortController per SubmitAttempt
 * at enter time and aborts it itself on release; the shell never aborts, it
 * only observes attempt.signal on its adjudicate/submit promises. Stale
 * attempts (any adjudicated / adjudication-failed / submit-settled whose seq
 * is not the in-flight one) are dropped: same state, zero effects.
 */
class InputMachine {
    constructor(options = {}) {
        this.draft = '';
        this.draftRev = 0;
        this.phase = 'plain';
        this.occurrences = [];
        this.occurrenceSeq = 0;
        this.seq = 0;
        this.log = [];
        this.redoStack = [];
        this.pasteSeq = 0;
        this.mergeWindowMs = options.mergeWindowMs ?? 1000;
        this.now = options.now ?? (() => 0);
    }
    /** Read-only snapshot of the machine state (queue always empty at this tier). */
    get state() {
        const c = this.claim;
        return {
            draft: this.draft,
            imageIds: [],
            draftRev: this.draftRev,
            phase: this.phase,
            ...(c
                ? {
                    claim: {
                        token: c.token,
                        ...(c.hint !== undefined ? { hint: c.hint } : {}),
                        ...(c.images === true ? { images: true } : {}),
                    },
                }
                : {}),
            occurrences: this.occurrences,
            ...(this.paste !== undefined ? { paste: this.paste } : {}),
            queue: EMPTY_QUEUE,
        };
    }
    /**
     * Feed one event through the machine.
     * @param ev - Input event; the single write path for all input state.
     * @returns Effects for the shell to execute in order; empty on no-ops, locks, and dropped stale events.
     */
    dispatch(ev) {
        switch (ev.type) {
            case 'draft-changed': return this.onDraftChanged(ev.draft, ev.editRange);
            case 'begin-command': return this.onBeginCommand(ev.claim, ev.span);
            case 'insert-ref': return this.onInsertRef(ev.reference, ev.span);
            case 'consume-token': return this.onConsumeToken(ev.guard);
            case 'set-invalid': return this.onSetInvalid(ev.invalidIds);
            case 'undo': return this.onUndo();
            case 'redo': return this.onRedo();
            case 'paste-begin': return this.onPasteBegin(ev.text, ev.selection, ev.components, ev.generation);
            case 'paste-upgrade': return this.onPasteUpgrade(ev.attemptId, ev.span, ev.reference);
            case 'invalidate-paste': {
                this.paste = undefined;
                return [];
            }
            case 'enter': return this.onEnter(ev.mode);
            case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome);
            case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message);
            case 'submit-settled': return this.onSubmitSettled(ev);
            case 'send-committed': return this.onSendCommitted();
            case 'release': return this.onRelease();
            default: return unreachable(ev);
        }
    }
    // ---- transaction plumbing ----
    /** Adopt a new draft: bump the revision (the span-CAS invalidation point). */
    adopt(draft) {
        this.draft = draft;
        this.draftRev += 1;
    }
    /** Push one undo unit (before-state), trim the ring, and cut the redo chain. */
    pushTxn(selectionBefore) {
        this.log.push({
            draftBefore: this.draft,
            occurrencesBefore: this.occurrences,
            ...(selectionBefore !== undefined ? { selectionBefore } : {}),
        });
        if (this.log.length > LOG_LIMIT)
            this.log.shift();
        this.redoStack = [];
    }
    /**
     * Reconcile the occurrence table with one edit (old-draft coordinates):
     * entries past the range shift by the length delta; an edit that intersects
     * a reference range removes its structured occurrence and leaves the edited
     * characters as ordinary draft text.
     */
    reconcile(range) {
        const delta = range.insertedLength - (range.end - range.start);
        const kept = [];
        for (const o of this.occurrences) {
            if (o.offset + o.length <= range.start)
                kept.push(o);
            else if (o.offset >= range.end)
                kept.push(delta === 0 ? o : { ...o, offset: o.offset + delta });
        }
        this.occurrences = kept;
    }
    /** Claimed integrity watch: any mutation that breaks the token prefix releases the claim. */
    watchClaim() {
        if (this.phase === 'claimed' && this.claim !== undefined && !this.draft.startsWith(this.claim.token)) {
            this.phase = 'plain';
            this.claim = undefined;
        }
    }
    /** Mint one occurrence at a draft offset. */
    mint(reference, offset, length) {
        this.occurrenceSeq += 1;
        return {
            occurrenceId: this.occurrenceSeq,
            source: reference.source,
            ref: reference.ref,
            offset,
            length,
            label: reference.label,
            ...reference.appearance === undefined ? {} : { appearance: reference.appearance },
            clipboardText: reference.clipboardText,
        };
    }
    /** Splice minted entries into the offset-sorted table. */
    withMinted(minted) {
        if (minted.length === 0)
            return;
        this.occurrences = [...this.occurrences, ...minted].sort((a, b) => a.offset - b.offset);
    }
    // ---- draft transactions ----
    onDraftChanged(draft, editRange) {
        if (draft === this.draft)
            return [];
        const range = editRange ?? diffEdit(this.draft, draft);
        // Single-char typing coalesces into the open run while contiguous and
        // inside the merge window; anything else opens its own transaction.
        const typing = range.start === range.end && range.insertedLength === 1;
        const at = this.now();
        const run = this.typingRun;
        const merges = typing && run !== undefined && run.end === range.start && at - run.at <= this.mergeWindowMs;
        if (!merges)
            this.pushTxn({ start: range.start, end: range.end });
        this.typingRun = typing ? { end: range.start + 1, at } : undefined;
        this.reconcile(range);
        this.adopt(draft);
        this.watchClaim();
        this.paste = undefined;
        return [];
    }
    /** Span CAS: revision equality (content identity follows) plus bounds sanity. */
    casOk(span) {
        return span.draftRev === this.draftRev
            && span.start >= 0 && span.start <= span.end && span.end <= this.draft.length;
    }
    onBeginCommand(claim, span) {
        if (this.phase !== 'plain' && this.phase !== 'claimed')
            return [];
        // Leading-trigger contract: only whitespace may precede the span; the
        // whitespace prefix is dropped so the claimed watch (startsWith) holds.
        if (!this.casOk(span) || this.draft.slice(0, span.start).trim() !== '')
            return [];
        this.pushTxn();
        this.typingRun = undefined;
        this.reconcile({ start: 0, end: span.end, insertedLength: claim.token.length });
        this.adopt(claim.token + this.draft.slice(span.end));
        this.claim = claim;
        this.phase = 'claimed';
        this.paste = undefined;
        return [];
    }
    onInsertRef(reference, span) {
        if (this.phase !== 'plain' && this.phase !== 'claimed')
            return [];
        if (!this.casOk(span))
            return [];
        this.replaceSpanWithChip(reference, span);
        this.paste = undefined;
        return [];
    }
    /**
     * Shared reference-insertion transaction: replace [span) with one inline
     * occurrence (insert-ref and paste-upgrade both land here). A separating
     * space follows the reference unless one is already next.
     * @returns the inserted length (display text plus optional gap).
     */
    replaceSpanWithChip(reference, span) {
        this.pushTxn();
        this.typingRun = undefined;
        const tail = this.draft.slice(span.end);
        const gap = tail.length === 0 || tail[0] !== ' ' ? ' ' : '';
        const displayText = referenceDraftText(reference);
        const inserted = displayText + gap;
        this.reconcile({ start: span.start, end: span.end, insertedLength: inserted.length });
        this.withMinted([this.mint(reference, span.start, displayText.length)]);
        this.adopt(this.draft.slice(0, span.start) + inserted + tail);
        this.watchClaim();
        return inserted.length;
    }
    /**
     * Guarded token deletion after business success (popup settle / menu-pick
     * execute). No effect signals success: the caller reads the draftRev
     * advance off the published state (same currency as the other bail verbs).
     */
    onConsumeToken(guard) {
        if (this.phase !== 'plain' && this.phase !== 'claimed')
            return [];
        switch (guard.kind) {
            case 'span': {
                const span = guard.span;
                if (!this.casOk(span) || span.start === span.end)
                    return [];
                this.pushTxn();
                this.typingRun = undefined;
                this.reconcile({ start: span.start, end: span.end, insertedLength: 0 });
                this.adopt(this.draft.slice(0, span.start) + this.draft.slice(span.end));
                this.watchClaim();
                this.paste = undefined;
                return [];
            }
            case 'bare-token': {
                if (guard.token === '' || this.draft.trim() !== guard.token)
                    return [];
                this.pushTxn();
                this.typingRun = undefined;
                this.occurrences = [];
                this.adopt('');
                this.watchClaim();
                this.paste = undefined;
                return [];
            }
            default: return unreachable(guard);
        }
    }
    /**
     * Owner-resolution style bits: exactly the listed occurrences render
     * invalid. Not a transaction — the draft, revision, and undo log are
     * untouched (invalidation never deletes or rewrites chips).
     */
    onSetInvalid(invalidIds) {
        const ids = new Set(invalidIds);
        if (!this.occurrences.some(o => (o.invalid === true) !== ids.has(o.occurrenceId)))
            return [];
        this.occurrences = this.occurrences.map((o) => {
            const invalid = ids.has(o.occurrenceId);
            if ((o.invalid === true) === invalid)
                return o;
            const { invalid: _drop, ...rest } = o;
            return invalid ? { ...rest, invalid: true } : rest;
        });
        return [];
    }
    // ---- undo / redo ----
    onUndo() {
        const entry = this.log.pop();
        if (entry === undefined)
            return [];
        this.redoStack.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences });
        this.occurrences = entry.occurrencesBefore;
        this.adopt(entry.draftBefore);
        this.watchClaim();
        this.typingRun = undefined;
        this.paste = undefined;
        return [];
    }
    onRedo() {
        const entry = this.redoStack.pop();
        if (entry === undefined)
            return [];
        // Manual log push: pushTxn would cut the redo chain being walked.
        this.log.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences });
        if (this.log.length > LOG_LIMIT)
            this.log.shift();
        this.occurrences = entry.occurrencesBefore;
        this.adopt(entry.draftBefore);
        this.watchClaim();
        this.typingRun = undefined;
        this.paste = undefined;
        return [];
    }
    // ---- paste plane ----
    /**
     * Paste as one transaction: the text (reference-placeholder-sanitized) replaces the
     * selection; hot-snapshot sync matches componentize inside the SAME
     * transaction (one undo returns to pre-paste); a match attempt opens for
     * the async remainder while the phase still accepts reference mutations.
     */
    onPasteBegin(rawText, selection, components = [], generation = 0) {
        const { start, end } = selection;
        if (start < 0 || start > end || end > this.draft.length)
            return [];
        const text = rawText.replace(REFERENCE_PLACEHOLDER_RE, '');
        this.pushTxn(selection);
        this.typingRun = undefined;
        // Componentize: replace each matched token range (paste-text coordinates,
        // disjoint by contract) with inline display text while assembling the insert.
        const sorted = [...components].sort((a, b) => a.start - b.start);
        const minted = [];
        let inserted = '';
        let cursor = 0;
        for (const c of sorted) {
            inserted += text.slice(cursor, c.start);
            const displayText = referenceDraftText(c.reference);
            minted.push(this.mint(c.reference, start + inserted.length, displayText.length));
            inserted += displayText;
            cursor = c.end;
        }
        inserted += text.slice(cursor);
        this.reconcile({ start, end, insertedLength: inserted.length });
        this.withMinted(minted);
        this.adopt(this.draft.slice(0, start) + inserted + this.draft.slice(end));
        this.watchClaim();
        if (this.phase === 'plain' || this.phase === 'claimed') {
            this.pasteSeq += 1;
            this.paste = {
                attemptId: this.pasteSeq,
                insertedRange: { start, end: start + inserted.length },
                generation,
            };
        }
        else {
            this.paste = undefined;
        }
        return [];
    }
    /**
     * Async match landed: upgrade one pasted token to a chip as an INDEPENDENT
     * transaction (undo #1 → the token text, undo #2 → pre-paste). The attempt
     * stays current — later tokens re-CAS against the advanced draftRev.
     */
    onPasteUpgrade(attemptId, span, reference) {
        const attempt = this.paste;
        if (attempt === undefined || attempt.attemptId !== attemptId)
            return [];
        if (this.phase !== 'plain' && this.phase !== 'claimed')
            return [];
        if (!this.casOk(span) || span.start === span.end)
            return [];
        const insertedLength = this.replaceSpanWithChip(reference, span);
        this.paste = {
            ...attempt,
            insertedRange: { start: attempt.insertedRange.start, end: attempt.insertedRange.end + insertedLength - (span.end - span.start) },
        };
        return [];
    }
    // ---- submit plane ----
    /** Mint the next SubmitAttempt and take the in-flight slot. */
    beginAttempt(mode) {
        const controller = new AbortController();
        this.seq += 1;
        const attempt = { seq: this.seq, signal: controller.signal, draftSnapshot: this.draft, mode };
        this.inflight = { attempt, controller };
        return attempt;
    }
    onEnter(mode) {
        if (this.phase === 'adjudicating' || this.phase === 'submitting')
            return [];
        if (this.phase === 'claimed' && this.claim !== undefined) {
            const attempt = this.beginAttempt(mode);
            this.phase = 'submitting';
            this.paste = undefined;
            return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(this.draft, this.claim.token) }];
        }
        const trimmed = this.draft.trim();
        if (trimmed === '')
            return [];
        this.paste = undefined;
        if (trimmed.startsWith('/')) {
            const attempt = this.beginAttempt(mode);
            this.phase = 'adjudicating';
            return [{ type: 'adjudicate', attempt, draft: this.draft }];
        }
        const attempt = this.beginAttempt(mode);
        this.phase = 'submitting';
        return [{ type: 'default-sink', attempt, draft: this.draft, mode }];
    }
    onAdjudicated(attempt, outcome) {
        const flight = this.inflight;
        if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq)
            return [];
        if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
            this.claim = outcome.claim;
            this.phase = 'submitting';
            return [{
                    type: 'begin-submit',
                    attempt,
                    claim: outcome.claim,
                    args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
                }];
        }
        // 'handled' (source dealt internally), {insert} (no enter-time span
        // semantics), or a miss: all land plain; only the miss flows to the sink.
        if (outcome === undefined) {
            this.phase = 'submitting';
            return [{
                    type: 'default-sink',
                    attempt,
                    draft: attempt.draftSnapshot,
                    mode: attempt.mode,
                }];
        }
        this.inflight = undefined;
        this.phase = 'plain';
        return [];
    }
    onAdjudicationFailed(attempt, message) {
        if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq)
            return [];
        this.inflight = undefined;
        this.phase = 'plain';
        // Draft retained: warmup failure never silently downgrades to a prompt.
        return [{ type: 'notice', level: 'error', text: message }];
    }
    onSubmitSettled(ev) {
        const flight = this.inflight;
        if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq)
            return [];
        this.inflight = undefined;
        if (ev.ok) {
            this.phase = 'plain';
            this.claim = undefined;
            this.occurrences = [];
            // Text appended after the sent snapshot during the Host round-trip
            // survives the commit; edits interleaved with committed content cannot
            // be separated from it, so only a pure suffix is retained.
            const snapshot = flight.attempt.draftSnapshot;
            this.adopt(this.draft !== snapshot && this.draft.startsWith(snapshot)
                ? this.draft.slice(snapshot.length)
                : '');
            // Committed content is gone for good: undo must not resurrect a sent draft.
            this.log = [];
            this.redoStack = [];
            this.typingRun = undefined;
            this.paste = undefined;
            return ev.outcome?.text !== undefined
                ? [{ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text }]
                : [];
        }
        const text = ev.message ?? ev.outcome?.text;
        // Keep the same command claim only while the live draft still equals the
        // enter-time draft; user input typed during flight wins.
        // Claimed re-entry additionally requires the watch to hold — an
        // enter-path snapshot may carry leading whitespace the token never had.
        if (this.draft === flight.attempt.draftSnapshot
            && this.claim !== undefined && this.draft.startsWith(this.claim.token)) {
            this.phase = 'claimed';
            return text === undefined ? [] : [{ type: 'notice', level: 'error', text }];
        }
        this.phase = 'plain';
        this.claim = undefined;
        return text === undefined ? [] : [{ type: 'notice', level: 'error', text }];
    }
    /** Cut undo state after an accepted image-only send. */
    onSendCommitted() {
        if (this.phase !== 'plain')
            return [];
        this.claim = undefined;
        this.occurrences = [];
        this.adopt('');
        this.log = [];
        this.redoStack = [];
        this.typingRun = undefined;
        this.paste = undefined;
        return [];
    }
    onRelease() {
        if (this.inflight !== undefined) {
            this.inflight.controller.abort();
            this.inflight = undefined;
        }
        this.phase = 'plain';
        this.claim = undefined;
        this.typingRun = undefined;
        this.paste = undefined;
        return [];
    }
}
exports.InputMachine = InputMachine;

},
"src/modules/conversation/input/submission-policy.js": function(module, exports, require) {
// source: src/modules/conversation/input/submission-policy.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComposerSubmissionPolicy = exports.DEFAULT_BUSY_ENTER_BEHAVIOR = void 0;
const runtime_values_1 = require("../runtime-values");
const submission_settings_1 = require("../submission-settings");
var submission_settings_2 = require("../submission-settings");
Object.defineProperty(exports, "DEFAULT_BUSY_ENTER_BEHAVIOR", { enumerable: true, get: function () { return submission_settings_2.DEFAULT_BUSY_ENTER_BEHAVIOR; } });
/**
 * Busy-Enter policy used by both the composer inject face and its Settings row.
 * Direct `steer` is intentionally best-effort: AgentLoop turns a closed-window
 * submission into the next waking Queue item.
 */
class ComposerSubmissionPolicy {
    /**
     * @param host - durable preference scope owned by the providing plugin;
     * absent compositions stay process-local. The adoption subscription shares
     * the scope's plugin lifetime — a disposed scope never publishes again, so
     * the policy needs no release hook.
     */
    constructor(host) {
        /** Reactive preference source for the Settings row. */
        this.busyEnter = (0, runtime_values_1.createSnapshotStore)(submission_settings_1.DEFAULT_BUSY_ENTER_BEHAVIOR);
        this.host = host;
        if (host !== undefined) {
            host.subscribe(() => { this.adopt(host); });
            this.adopt(host);
        }
    }
    /**
     * Resolve one keyboard gesture without changing state.
     * @param running - whether the addressed agent currently reports busy.
     * @param gesture - plain Enter or the Cmd/Ctrl-accelerated chord.
     * @param steeringAvailable - whether this session transport supports steering.
     * @returns Queue outside steer-capable busy state; otherwise the preferred mode or its opposite.
     */
    resolve(running, gesture, steeringAvailable) {
        if (!running || !steeringAvailable)
            return 'queue';
        const preferred = this.busyEnter.getSnapshot();
        if (gesture === 'enter')
            return preferred;
        return preferred === 'queue' ? 'steer' : 'queue';
    }
    /**
     * Change the plain-Enter behavior used during busy state; the live value
     * publishes before the durable write starts.
     * @param behavior - Queue or Steer.
     */
    setBusyEnter(behavior) {
        if (this.busyEnter.getSnapshot() === behavior)
            return;
        this.busyEnter.set(behavior);
        void this.host?.set(submission_settings_1.BUSY_ENTER_FIELD, behavior);
    }
    /**
     * Adopt the scope's accepted durable behavior without writing it back.
     * @param host - the constructor-narrowed scope driving this adoption.
     */
    adopt(host) {
        const section = host.getSnapshot().value;
        if (section === undefined || this.busyEnter.getSnapshot() === section.busyEnter)
            return;
        this.busyEnter.set(section.busyEnter);
    }
}
exports.ComposerSubmissionPolicy = ComposerSubmissionPolicy;

},
"src/modules/conversation/submission-settings.js": function(module, exports, require) {
// source: src/modules/conversation/submission-settings.ts

"use strict";
/** Busy-Enter preference stored in the Host user-settings document. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BUSY_ENTER_BEHAVIOR = exports.BUSY_ENTER_BEHAVIORS = exports.BUSY_ENTER_FIELD = exports.CONVERSATION_SETTINGS_NAMESPACE = void 0;
/** Settings namespace owned by the conversation plugin. */
exports.CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation';
/** Field carrying the delivery mode for plain Enter while an agent is busy. */
exports.BUSY_ENTER_FIELD = 'busyEnter';
/** Busy-Enter behaviors accepted at settings and input boundaries. */
exports.BUSY_ENTER_BEHAVIORS = ['queue', 'steer'];
/** Default preserves Enter-as-Queue for running conversations. */
exports.DEFAULT_BUSY_ENTER_BEHAVIOR = 'queue';

},
"src/modules/conversation/settings/EnterBehaviorRow.js": function(module, exports, require) {
// source: src/modules/conversation/settings/EnterBehaviorRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnterBehaviorRow = EnterBehaviorRow;
const jsx_runtime_1 = require("react/jsx-runtime");
/** General Settings row for the Composer's busy-state Enter preference. */
const react_1 = require("react");
const primitives_1 = require("../primitives");
const EnterBehaviorRow_styles_1 = __importDefault(require("./EnterBehaviorRow.styles"));
const OPTIONS = [
    { id: 'queue', label: 'settings.enter.queue' },
    { id: 'steer', label: 'settings.enter.steer' },
];
/**
 * Render the busy-state Enter behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
function EnterBehaviorRow({ useBusyEnter, setBusyEnter, t }) {
    const behavior = useBusyEnter(value => value);
    const [open, setOpen] = (0, react_1.useState)(false);
    const selectedLabel = behavior === 'queue' ? 'settings.enter.queue' : 'settings.enter.steer';
    return ((0, jsx_runtime_1.jsxs)("div", { className: EnterBehaviorRow_styles_1.default.row, children: [(0, jsx_runtime_1.jsxs)("div", { className: EnterBehaviorRow_styles_1.default.rowText, children: [(0, jsx_runtime_1.jsx)("div", { className: EnterBehaviorRow_styles_1.default.title, children: t('settings.enter.title') }), (0, jsx_runtime_1.jsx)("div", { className: EnterBehaviorRow_styles_1.default.desc, children: t('settings.enter.description') })] }), (0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: open, onClose: () => { setOpen(false); }, items: OPTIONS.map(option => ({ id: option.id, label: t(option.label) })), selectedId: behavior, onSelect: (id) => {
                    setOpen(false);
                    if (id === 'queue' || id === 'steer')
                        setBusyEnter(id);
                }, align: "end", portal: true, anchor: ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: EnterBehaviorRow_styles_1.default.selector, "aria-haspopup": "menu", "aria-expanded": open, onClick: () => { setOpen(value => !value); }, children: [t(selectedLabel), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, { className: EnterBehaviorRow_styles_1.default.chevron })] })) })] }));
}

},
"src/modules/conversation/settings/EnterBehaviorRow.styles.js": function(module, exports, require) {
// source: src/modules/conversation/settings/EnterBehaviorRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const EnterBehaviorRow_css_1 = __importDefault(require("./EnterBehaviorRow.css"));
exports.default = {
    "chevron": "h_7F-q_chevron",
    "desc": "h_7F-q_desc",
    "row": "h_7F-q_row",
    "rowText": "h_7F-q_rowText",
    "selector": "h_7F-q_selector",
    "title": "h_7F-q_title"
};
const tagId = '@xharness/dsh-client-ui-conversation/EnterBehaviorRow.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = EnterBehaviorRow_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/settings/EnterBehaviorRow.css": function(module, exports, require) {
// source: src/modules/conversation/settings/EnterBehaviorRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".h_7F-q_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.h_7F-q_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.h_7F-q_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.h_7F-q_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.h_7F-q_selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.h_7F-q_selector:hover{background:var(--dsw-alias-interactive-bg-hover)}.h_7F-q_chevron{flex:none}";

},
"src/modules/conversation/chat/ChatView.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ChatView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatView = ChatView;
exports.scrollFollowAtBottom = scrollFollowAtBottom;
const jsx_runtime_1 = require("react/jsx-runtime");
const pending_tool_1 = require("./pending-tool");
const use_adaptive_tool_fold_1 = require("./use-adaptive-tool-fold");
const process_mode_1 = require("./process-mode");
// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition. A Host
// open-path refusal from the injected opener is an in-page dialog here.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const primitives_1 = require("../primitives");
const MessageItem_1 = require("./MessageItem");
const ChatNodeSeat_1 = require("./ChatNodeSeat");
const TranscriptWindowRow_1 = require("./TranscriptWindowRow");
const message_chrome_1 = require("./message-chrome");
const chat_node_codec_1 = require("../contract/chat-node-codec");
const message_preview_1 = require("./message-preview");
const ChatView_styles_1 = __importDefault(require("./ChatView.styles"));
const MessageRail_1 = require("./MessageRail");
const history_page_intent_1 = require("./history-page-intent");
const LoadingIndicator_1 = require("./LoadingIndicator");
const FOLLOW_THRESHOLD = 24;
/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from) {
    return (from.closest('[data-conversation-scroll]')) ?? from;
}
/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list, key) {
    for (const row of list.querySelectorAll('[data-chat-anchor-key]')) {
        if (row.dataset.chatAnchorKey === key)
            return row;
    }
    return null;
}
/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row, scrollport) {
    return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
}
/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list, scrollport) {
    const viewport = scrollport.getBoundingClientRect();
    const composer = scrollport.querySelector('[data-composer-seat]');
    const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom;
    // Scroll events are hot: hit-test a few points through the stretched flow
    // rows before considering the full mounted set. The fallback keeps jsdom
    // and pre-layout states deterministic; a virtualizer naturally bounds it.
    if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
        const content = list.getBoundingClientRect();
        const left = Math.max(viewport.left, content.left);
        const right = Math.min(viewport.right, content.right);
        const x = left + Math.max(0, right - left) / 2;
        const height = visibleBottom - viewport.top;
        const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)];
        for (const offset of points) {
            for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
                const row = element instanceof HTMLElement
                    ? element.closest('[data-chat-anchor-key]')
                    : null;
                if (row !== null && list.contains(row))
                    return row;
            }
        }
    }
    const rows = [...list.querySelectorAll('[data-chat-anchor-key]')];
    const visibleRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < visibleBottom;
    });
    return visibleRows[0] ?? rows[0] ?? null;
}
/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list, scrollport) {
    const row = pagingAnchor(list, scrollport);
    const anchorKey = row?.dataset.chatAnchorKey;
    if (row === null || anchorKey === undefined)
        return null;
    const seq = row.dataset.chatAnchorSeq === undefined ? NaN : Number(row.dataset.chatAnchorSeq);
    return {
        anchorKey,
        ...(Number.isSafeInteger(seq) && seq >= 0 ? { anchorSeq: seq } : {}),
        anchorTop: flowTop(row, scrollport),
        scrollTop: scrollport.scrollTop,
    };
}
/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error, fallback) {
    const message = error instanceof Error ? error.message : String(error);
    return message === '' ? fallback : message;
}
/** ProducedFiles opens the session workspace as `.`. */
function isFolderOpenPath(path) {
    return path === '.';
}
function runningTurnStartTime(timeline) {
    let latest = null;
    for (const turn of timeline.turns.values()) {
        if (turn.status === 'open' && turn.start !== undefined)
            latest = turn.start.time;
    }
    return latest;
}
/** Stable turn-level activity seat across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }) {
    const [mountedAt] = (0, react_1.useState)(() => Date.now());
    // Anchored to turn/start so a mid-turn reload keeps the real
    // elapsed time and the final footer's Ran-for label matches this clock.
    const anchor = startTime ?? mountedAt;
    const [elapsedMs, setElapsedMs] = (0, react_1.useState)(() => Math.max(0, Date.now() - anchor));
    (0, react_1.useEffect)(() => {
        const tick = () => {
            setElapsedMs(Math.max(0, Date.now() - anchor));
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => { clearInterval(id); };
    }, [anchor]);
    // Short turns keep just the spinner; the clock only appears once the turn
    // has clearly been running for a while.
    const showClock = elapsedMs >= 15000;
    return ((0, jsx_runtime_1.jsxs)("div", { className: ChatView_styles_1.default.turnStatus, children: [(0, jsx_runtime_1.jsx)(LoadingIndicator_1.LoadingIndicator, { active: true, label: t('xh.turn.working') }), showClock && ((0, jsx_runtime_1.jsx)("span", { className: ChatView_styles_1.default.turnStatusClock, "aria-hidden": true, children: (0, message_chrome_1.formatRunDuration)(elapsedMs, t) }))] }));
}
/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, editMessage, forkMessage, t, }) {
    const order = useSession(s => s.chat.order);
    const nodeStore = useSession(s => s.chat.nodes);
    const timeline = useSession(s => s.chat.timeline);
    const inbox = useSession(s => s.queue);
    // Workspace root off the session list row: path summaries display relative to it.
    const cwd = useSessions(s => s.byId[sessionId]?.cwd);
    const running = useSession(s => s.running);
    const openState = useSession(s => s.openState);
    const openError = useSession(s => s.openError);
    const hasMore = useSession(s => s.hasMore);
    const loadingOlder = useSession(s => s.loadingOlder);
    const selectedCallId = useStore(s => s.selection?.callId);
    const [fileOpenError, setFileOpenError] = (0, react_1.useState)(null);
    const [fileOpenBusy, setFileOpenBusy] = (0, react_1.useState)(false);
    const processMode = (0, process_mode_1.useProcessMode)();
    const [processState, setProcessState] = (0, react_1.useState)(() => ({ sessionId, mode: processMode, choices: new Map() }));
    // A global mode change deliberately reapplies defaults. Manual group choices
    // win until then, stay turn/session-local and do not disable windowing.
    if (processState.sessionId !== sessionId || processState.mode !== processMode) {
        setProcessState({ sessionId, mode: processMode, choices: new Map() });
    }
    const expandedTurnsCache = (0, react_1.useRef)(null);
    const expandedTurns = (0, react_1.useMemo)(() => {
        const result = new Set();
        const choices = processState.sessionId === sessionId && processState.mode === processMode ? processState.choices : undefined;
        for (const turn of timeline.turns.keys()) {
            if (choices?.get(turn) ?? processMode === 'expanded')
                result.add(turn);
        }
        const previous = expandedTurnsCache.current;
        if (previous !== null && previous.size === result.size && [...result].every(turn => previous.has(turn)))
            return previous;
        expandedTurnsCache.current = result;
        return result;
    }, [timeline, processState, sessionId, processMode]);
    // Close/retry must ignore a settlement that started before the latest
    // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
    const fileOpenRequest = (0, react_1.useRef)(0);
    const requestOpenFile = (0, react_1.useCallback)((path) => {
        const id = ++fileOpenRequest.current;
        setFileOpenBusy(true);
        void openFile(path).then(() => {
            if (id !== fileOpenRequest.current)
                return;
            setFileOpenError(null);
            setFileOpenBusy(false);
        }, (error) => {
            if (id !== fileOpenRequest.current)
                return;
            setFileOpenError({
                path,
                message: openFailureMessage(error, t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown')),
            });
            setFileOpenBusy(false);
        });
    }, [openFile, t]);
    const closeFileOpenError = (0, react_1.useCallback)(() => {
        fileOpenRequest.current += 1;
        setFileOpenError(null);
        setFileOpenBusy(false);
    }, []);
    const pendingSteering = (0, react_1.useMemo)(() => inbox.filter(item => item.placement === 'steering'), [inbox]);
    const [markerCache] = (0, react_1.useState)(() => new message_preview_1.MessageMarkerCache());
    const messageMarkers = (0, react_1.useMemo)(() => markerCache.read(order, key => {
        const node = nodeStore.get(key);
        // Do not recursively validate every assistant/tool payload merely to find
        // user markers. Candidate user payloads still cross the same codec.
        if (node?.kind !== 'user' && node?.kind !== 'steering')
            return undefined;
        return (0, chat_node_codec_1.isChatNode)(node) && (node.kind === 'user' || node.kind === 'steering') ? node.data.content : undefined;
    }), [order, nodeStore, markerCache]);
    const renderMessageImages = (0, react_1.useCallback)(owner => renderSlot('conversation.message.images', { ...owner, loadImage }), [loadImage, renderSlot]);
    const runningTurnStart = (0, react_1.useMemo)(() => runningTurnStartTime(timeline), [timeline]);
    const listRef = (0, react_1.useRef)(null);
    const [railHost, setRailHost] = (0, react_1.useState)(null);
    const [activeMarker, setActiveMarker] = (0, react_1.useState)(null);
    const columnRef = (0, react_1.useRef)(null);
    const atBottomRef = (0, react_1.useRef)(chatScroll.read() === null);
    const [atBottom, setAtBottom] = (0, react_1.useState)(atBottomRef.current);
    /** Last position delivered or written on the main thread. */
    const observedTopRef = (0, react_1.useRef)(0);
    const readerScrollUntilRef = (0, react_1.useRef)(0);
    // A resize/anchor correction shortly after an upward gesture is not a
    // downward reader gesture. Only a fresh downward/scrollbar input may re-pin.
    const readerDirectionRef = (0, react_1.useRef)(0);
    /** Paging anchor: semantic row/position at click, updated by reader scrolls
     * while the request is pending and restored after the prepend lands. */
    const anchorRef = (0, react_1.useRef)(null);
    const firstSeqRef = (0, react_1.useRef)(null);
    const openedRef = (0, react_1.useRef)(false);
    /** Flow tip signature — follow-scroll only when this moves, never on a
     *  scroll-driven at-bottom chrome re-render (which would snap inertial
     *  scrolls the rest of the way to the floor). */
    const followSigRef = (0, react_1.useRef)(null);
    const processAnchorRef = (0, react_1.useRef)(null);
    const pageIntent = (0, react_1.useMemo)(() => new history_page_intent_1.HistoryPageIntent(), [sessionId]);
    const checkOlderRef = (0, react_1.useRef)(null);
    (0, react_1.useLayoutEffect)(() => {
        const local = listRef.current;
        setRailHost(local?.closest('[data-conversation-root]') ?? local?.closest('[data-chat-view-root]') ?? null);
    }, [sessionId]);
    (0, react_1.useEffect)(() => {
        const local = listRef.current;
        if (local === null || messageMarkers.length === 0) {
            setActiveMarker(null);
            return;
        }
        const scrollport = scrollerOf(local);
        let frame = 0;
        const update = () => {
            frame = 0;
            const threshold = scrollport.getBoundingClientRect().top + 48;
            let current = messageMarkers[0]?.key ?? null;
            for (const row of local.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')) {
                if (row.getBoundingClientRect().top > threshold)
                    break;
                current = row.dataset.chatAnchorKey ?? current;
            }
            setActiveMarker(previous => previous === current ? previous : current);
        };
        const schedule = () => { if (frame === 0)
            frame = window.requestAnimationFrame(update); };
        schedule();
        scrollport.addEventListener('scroll', schedule, { passive: true });
        return () => {
            scrollport.removeEventListener('scroll', schedule);
            if (frame !== 0)
                window.cancelAnimationFrame(frame);
        };
    }, [messageMarkers, sessionId]);
    const captureAutoFoldAnchor = (commit) => {
        const local = listRef.current;
        if (local === null || atBottomRef.current)
            return undefined;
        const port = scrollerOf(local);
        const row = pagingAnchor(local, port);
        const key = row?.dataset.chatAnchorKey;
        if (commit && row !== null && key !== undefined)
            processAnchorRef.current = { key, top: flowTop(row, port) };
        return key;
    };
    const { foldedTools, invalidateFoldedTool } = (0, use_adaptive_tool_fold_1.useAdaptiveToolFold)(sessionId, listRef, expandedTurns, captureAutoFoldAnchor, nodeStore);
    const toggleTurnProcess = (0, react_1.useCallback)((turn) => {
        pageIntent.cancel();
        const local = listRef.current;
        if (local !== null) {
            const scrollport = scrollerOf(local);
            const row = anchorElement(local, `turn-process:${turn}`);
            processAnchorRef.current = row === null ? null : { key: `turn-process:${turn}`, top: flowTop(row, scrollport) };
            // A disclosure click is a reading gesture, not permission to snap to the
            // floor. Release follow before commit/ResizeObserver and keep it released
            // even when a collapsed list temporarily fits inside the viewport.
            atBottomRef.current = false;
            setAtBottom(false);
            readerScrollUntilRef.current = 0;
            readerDirectionRef.current = 0;
        }
        setProcessState(previous => {
            const choices = new Map(previous.sessionId === sessionId && previous.mode === processMode ? previous.choices : []);
            choices.set(turn, !(choices.get(turn) ?? processMode === 'expanded'));
            return { sessionId, mode: processMode, choices };
        });
    }, [pageIntent, sessionId, processMode]);
    (0, react_1.useLayoutEffect)(() => {
        const local = listRef.current;
        const anchor = processAnchorRef.current;
        processAnchorRef.current = null;
        if (local === null || anchor === null)
            return;
        const scrollport = scrollerOf(local);
        const row = anchorElement(local, anchor.key);
        if (row !== null)
            scrollport.scrollTop += flowTop(row, scrollport) - anchor.top;
        observedTopRef.current = scrollport.scrollTop;
        const position = scrollPosition(local, scrollport);
        if (position !== null)
            chatScroll.save(position);
    }, [expandedTurns, foldedTools, chatScroll]);
    // One independently subscribed resident entry per loaded turn, including
    // partial history pages without the original user/start event. No full-turn
    // pinning: only the live tip and pending tools bypass row windowing.
    const processHeads = (0, react_1.useMemo)(() => {
        const heads = new Set();
        const turns = new Set();
        for (const key of order) {
            const node = nodeStore.get(key);
            if (node?.kind === 'user' || node?.kind === 'steering')
                continue;
            const location = node?.location;
            if (location?.kind !== 'turn' && location?.kind !== 'step')
                continue;
            if (turns.has(location.turn.turn))
                continue;
            turns.add(location.turn.turn);
            heads.add(key);
        }
        return heads;
    }, [order, nodeStore, timeline]);
    const firstKey = order[0];
    const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null;
    const lastKey = order.at(-1) ?? null;
    const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null;
    const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`;
    const toBottom = (el) => {
        pageIntent.cancel();
        anchorRef.current = null;
        processAnchorRef.current = null;
        // Explicit/programmatic return ends the previous reader gesture. Delayed
        // resize/clamp scroll events must not inherit an earlier up gesture.
        readerScrollUntilRef.current = 0;
        readerDirectionRef.current = 0;
        el.scrollTop = el.scrollHeight;
        observedTopRef.current = el.scrollTop;
        atBottomRef.current = true;
        setAtBottom(true);
        chatScroll.save(null);
    };
    (0, react_1.useLayoutEffect)(() => chatScroll.subscribeFollow?.(() => {
        const local = listRef.current;
        if (local !== null)
            toBottom(scrollerOf(local));
    }), [chatScroll, sessionId]);
    (0, react_1.useLayoutEffect)(() => {
        const local = listRef.current;
        if (local === null)
            return;
        return (0, TranscriptWindowRow_1.bindTranscriptFollow)(scrollerOf(local), atBottomRef);
    }, []);
    (0, react_1.useLayoutEffect)(() => {
        const local = listRef.current;
        /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
        if (local === null)
            return;
        const el = scrollerOf(local);
        // A cold view has no flow to follow yet. In particular, its empty first
        // layout must not turn an older reading bookmark into a latest-page hint.
        if (openState !== 'open' && order.length === 0)
            return;
        // Open completed: jump to the bottom once — unless a scroll position
        // survives from a previous mount (view-tab switch away and back), which
        // is restored instead of snapping the reader back to the floor.
        if (openState === 'open' && !openedRef.current) {
            openedRef.current = true;
            const saved = chatScroll.read();
            if (saved === null) {
                toBottom(el);
            }
            else {
                el.scrollTop = saved.scrollTop;
                const row = anchorElement(local, saved.anchorKey);
                if (row !== null)
                    el.scrollTop += flowTop(row, el) - saved.anchorTop;
                observedTopRef.current = el.scrollTop;
                const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1;
                atBottomRef.current = isAtBottom;
                setAtBottom(isAtBottom);
                const normalized = isAtBottom ? null : scrollPosition(local, el);
                if (isAtBottom)
                    chatScroll.save(null);
                else if (normalized !== null)
                    chatScroll.save(normalized);
            }
            firstSeqRef.current = firstSeq;
            followSigRef.current = followSig;
            return;
        }
        // Prepend (head seq decreased): preserve the same settled row at the
        // position established by the reader's latest scroll. This excludes
        // unrelated tail/composer growth while the request was in flight.
        if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
            const anchor = anchorRef.current;
            anchorRef.current = null;
            const row = anchorElement(local, anchor.key);
            if (row !== null)
                el.scrollTop += flowTop(row, el) - anchor.top;
            observedTopRef.current = el.scrollTop;
            firstSeqRef.current = firstSeq;
            followSigRef.current = followSig;
            return;
        }
        firstSeqRef.current = firstSeq;
        // Delivery is not a local send gesture. A restored/other-observer user
        // node or a delayed steering snapshot must not take reader ownership.
        const tipMoved = followSigRef.current !== followSig;
        followSigRef.current = followSig;
        // Follow new flow content while pinned; do NOT re-pin on every render
        // merely because atBottomRef is true (scroll threshold → setState → snap).
        if (tipMoved && atBottomRef.current)
            toBottom(el);
    });
    const onScrollRef = (0, react_1.useRef)(() => { });
    onScrollRef.current = () => {
        // Empty loading/retry layouts are not reader intent and must not erase a
        // bookmark before its required history window has been restored.
        if (openState !== 'open' && order.length === 0)
            return;
        const local = listRef.current;
        /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
        if (local === null)
            return;
        const el = scrollerOf(local);
        // Only reader input may make raw scroll geometry change follow ownership:
        // a delivered position that deviates from the observed-top ledger (every
        // programmatic write records itself there synchronously). This covers
        // wheel, touch, scrollbar, and keyboard alike without naming devices.
        // Browser shrink-clamps land exactly on the floor min and delayed
        // programmatic deliveries land on the ledger itself, so both preserve
        // the current ownership state.
        const floor = Math.max(0, el.scrollHeight - el.clientHeight);
        const readerInputRecent = Date.now() <= readerScrollUntilRef.current;
        const movedByReader = readerInputRecent && Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5;
        // Scrollbar dragging has no wheel/key direction. Only actual upward
        // movement after its pointer input arms paging, not a passive layout clamp.
        if (movedByReader && readerDirectionRef.current === 0 && el.scrollTop < Math.min(observedTopRef.current, floor))
            pageIntent.arm();
        const isAtBottom = scrollFollowAtBottom(atBottomRef.current, el.scrollTop, floor, observedTopRef.current, readerInputRecent && (atBottomRef.current || readerDirectionRef.current >= 0));
        if (!movedByReader && isAtBottom) {
            toBottom(el);
            return;
        }
        atBottomRef.current = isAtBottom;
        setAtBottom(isAtBottom);
        const position = isAtBottom ? null : scrollPosition(local, el);
        if (isAtBottom) {
            anchorRef.current = null;
        }
        else if (anchorRef.current !== null && position !== null) {
            anchorRef.current = { key: position.anchorKey, top: position.anchorTop };
        }
        // Continuous save (unmount happens after ref detach, so saving there is
        // too late); pinned-to-bottom clears so a remount keeps following.
        if (isAtBottom)
            chatScroll.save(null);
        else if (position !== null)
            chatScroll.save(position);
        observedTopRef.current = el.scrollTop;
        // Reflow/arrival can move geometry, but cannot spend an earlier gesture.
        if (movedByReader)
            checkOlderRef.current?.();
    };
    // Gesture intent is delivered before scroll/resize/layout callbacks. Release
    // follow synchronously when the reader starts moving up, even a few pixels
    // inside FOLLOW_THRESHOLD. Otherwise streaming can win that first frame.
    (0, react_1.useEffect)(() => {
        const local = listRef.current;
        /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
        if (local === null)
            return;
        const el = scrollerOf(local);
        const onScroll = () => { onScrollRef.current(); };
        const markReaderInput = (direction) => {
            readerScrollUntilRef.current = Date.now() + 1500;
            if (direction !== undefined) {
                readerDirectionRef.current = direction;
                if (direction >= 0)
                    pageIntent.cancel();
            }
        };
        const pauseFollowing = () => {
            atBottomRef.current = false;
            setAtBottom(false);
        };
        const readUp = () => {
            pauseFollowing();
            pageIntent.arm();
            checkOlderRef.current?.();
        };
        const onWheel = (event) => {
            // Ctrl-wheel/pinch zoom and horizontal-only movement are not read-up.
            if (event.ctrlKey || event.deltaY === 0)
                return;
            markReaderInput(Math.sign(event.deltaY));
            if (event.deltaY < 0)
                readUp();
        };
        let touchY = null;
        const onTouchStart = (event) => {
            const touch = event.touches[0];
            touchY = event.touches.length === 1 && touch !== undefined ? touch.clientY : null;
        };
        const onTouchMove = (event) => {
            const touch = event.touches[0];
            if (event.touches.length !== 1 || touch === undefined) {
                touchY = null;
                return;
            }
            const y = touch.clientY;
            markReaderInput(touchY === null ? -1 : y === touchY ? undefined : Math.sign(touchY - y));
            if (touchY === null || y > touchY)
                readUp();
            touchY = y;
        };
        const onTouchEnd = () => { touchY = null; };
        let readerPointer = null;
        const onPointer = (event) => {
            if (event.target !== el || event.button !== 0)
                return;
            readerPointer = event.pointerId;
            markReaderInput(0);
            pauseFollowing();
        };
        const onPointerMove = (event) => {
            if (event.pointerId === readerPointer)
                markReaderInput();
        };
        const onPointerEnd = (event) => {
            if (event.pointerId === readerPointer)
                readerPointer = null;
        };
        const onKey = (event) => {
            if (event.defaultPrevented || (event.target instanceof Element
                && event.target.closest('input,textarea,[contenteditable=true],[role=menu],[role=listbox],[role=combobox]')))
                return;
            if (event.key === ' ' && event.target instanceof Element && event.target.closest('button,a'))
                return;
            if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
                return;
            const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
            markReaderInput(upward ? -1 : 1);
            if (upward)
                readUp();
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        el.addEventListener('wheel', onWheel, { passive: true });
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: true });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        el.addEventListener('touchcancel', onTouchEnd, { passive: true });
        el.addEventListener('pointerdown', onPointer);
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerEnd);
        window.addEventListener('pointercancel', onPointerEnd);
        el.addEventListener('keydown', onKey);
        return () => {
            el.removeEventListener('scroll', onScroll);
            el.removeEventListener('wheel', onWheel);
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
            el.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerEnd);
            window.removeEventListener('pointercancel', onPointerEnd);
            el.removeEventListener('keydown', onKey);
        };
    }, [pageIntent]);
    // The ref starts null and is assigned every render, so the placeholder
    // initializer a function initial value would need never exists.
    const followRef = (0, react_1.useRef)(null);
    followRef.current = () => {
        if (openState !== 'open' && order.length === 0)
            return;
        const local = listRef.current;
        if (local !== null && atBottomRef.current) {
            const el = scrollerOf(local);
            el.scrollTop = el.scrollHeight;
            observedTopRef.current = el.scrollTop;
            chatScroll.save(null);
        }
    };
    // Streaming, tool disclosures, and other flow changes resize the column;
    // the sticky composer resizes outside it. This observer owns ChatView's
    // dynamic-height follow decisions and writes only while the reader is pinned.
    (0, react_1.useEffect)(() => {
        const column = columnRef.current;
        const local = listRef.current;
        if (column === null || local === null || typeof ResizeObserver === 'undefined')
            return;
        const scrollport = scrollerOf(local);
        const composer = scrollport.querySelector('[data-composer-seat]');
        const observer = new ResizeObserver(() => { followRef.current?.(); });
        observer.observe(column);
        if (composer !== null)
            observer.observe(composer);
        return () => { observer.disconnect(); };
    }, []);
    // A failed/empty page leaves the head unchanged. Once the request leaves
    // its busy state there is no future prepend for the saved anchor to own.
    (0, react_1.useEffect)(() => {
        if (!loadingOlder)
            anchorRef.current = null;
    }, [loadingOlder]);
    const loadOlderAnchored = async () => {
        if (!pageIntent.begin())
            return;
        const local = listRef.current;
        /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
        if (local !== null) {
            const el = scrollerOf(local);
            const row = pagingAnchor(local, el);
            if (row !== null && row.dataset.chatAnchorKey !== undefined) {
                anchorRef.current = {
                    key: row.dataset.chatAnchorKey,
                    top: flowTop(row, el),
                };
            }
        }
        try {
            await loadOlder();
        }
        catch (error) {
            // The production Session publishes its history error transactionally.
            // Also isolate rejected legacy providers from native input dispatch.
            console.error('[conversation] older history request failed:', error);
        }
        finally {
            pageIntent.end();
        }
    };
    checkOlderRef.current = () => {
        const local = listRef.current;
        if (local === null)
            return;
        const el = scrollerOf(local);
        if (pageIntent.shouldLoad({ ready: openState === 'open', hasMore, loading: loadingOlder,
            following: atBottomRef.current, head: firstSeq, top: el.scrollTop, viewport: el.clientHeight })) {
            void loadOlderAnchored();
        }
    };
    const scrollToMessage = (0, react_1.useCallback)((key) => {
        pageIntent.cancel();
        const local = listRef.current;
        if (local === null)
            return;
        const row = anchorElement(local, key);
        if (row === null)
            return;
        const scrollport = scrollerOf(local);
        atBottomRef.current = false;
        setAtBottom(false);
        readerScrollUntilRef.current = 0;
        readerDirectionRef.current = 0;
        scrollport.scrollTop += flowTop(row, scrollport) - 24;
        observedTopRef.current = scrollport.scrollTop;
        setActiveMarker(key);
        const position = scrollPosition(local, scrollport);
        if (position !== null)
            chatScroll.save(position);
    }, [pageIntent, chatScroll]);
    return ((0, jsx_runtime_1.jsxs)("div", { className: ChatView_styles_1.default.root, "data-chat-view-root": "", children: [railHost !== null && messageMarkers.length > 1 && (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)(MessageRail_1.MessageRail, { markers: messageMarkers, active: activeMarker, select: scrollToMessage, t: t }), railHost), (0, jsx_runtime_1.jsxs)("div", { ref: listRef, className: ChatView_styles_1.default.scroll, children: [(0, jsx_runtime_1.jsxs)("div", { ref: columnRef, className: ChatView_styles_1.default.column, "data-chat-flow": "", children: [openState === 'loading' && (0, jsx_runtime_1.jsx)("div", { className: ChatView_styles_1.default.hint, children: t('chat.loadingHistory') }), openState === 'error' && openError !== null && ((0, jsx_runtime_1.jsxs)("div", { className: ChatView_styles_1.default.openError, role: "alert", children: [t('chat.loadError', { message: openError.message, code: openError.code }), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-history-retry": "", onClick: loadOlderAnchored, children: t('retry') })] })), hasMore && ((0, jsx_runtime_1.jsx)("div", { className: ChatView_styles_1.default.older, children: (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: loadingOlder, onClick: loadOlderAnchored, children: loadingOlder ? t('loading') : t('chat.loadOlder') }) })), order.flatMap((nodeKey) => [
                                ...(processHeads.has(nodeKey) ? [(0, jsx_runtime_1.jsx)(ChatNodeSeat_1.TurnProcessSummarySeat, { nodeKey: nodeKey, useSession: useSession, expandedTurns: expandedTurns, foldedTools: foldedTools, toggleTurnProcess: toggleTurnProcess, t: t }, `${sessionId}:process:${nodeKey}`)] : []),
                                (0, jsx_runtime_1.jsx)(ChatNodeSeat_1.ChatNodeSeat, { nodeKey: nodeKey, expandedTurns: expandedTurns, foldedTools: foldedTools, invalidateFoldedTool: invalidateFoldedTool, keepMounted: running && (nodeKey === lastKey || (0, pending_tool_1.transcriptHasPendingTool)(nodeStore.get(nodeKey))), editMessage: editMessage, forkMessage: forkMessage, editAvailable: !running, useSession: useSession, selectedCallId: selectedCallId, cwd: cwd, openFile: requestOpenFile, inspectCall: inspectCall, forkAt: forkAt, renderMessageImages: renderMessageImages, fileMentions: fileMentions, renderSlot: renderSlot, t: t }, `${sessionId}:node:${nodeKey}`),
                            ]), running && (0, jsx_runtime_1.jsx)(TurnStatus, { startTime: runningTurnStart, t: t }), pendingSteering.map(item => ((0, jsx_runtime_1.jsx)(MessageItem_1.PendingSteeringBubble, { content: item.content, renderMessageImages: renderMessageImages, t: t }, item.id)))] }), !atBottom && ((0, jsx_runtime_1.jsx)("div", { className: ChatView_styles_1.default.toBottomSlot, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: ChatView_styles_1.default.toBottom, "aria-label": t('chat.toBottom'), onClick: () => {
                                const local = listRef.current;
                                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                                if (local !== null)
                                    toBottom(scrollerOf(local));
                            }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) }) }))] }), fileOpenError !== null && ((0, jsx_runtime_1.jsx)(FileOpenErrorDialog, { path: fileOpenError.path, message: fileOpenError.message, busy: fileOpenBusy, onClose: closeFileOpenError, onRetry: () => { requestOpenFile(fileOpenError.path); }, t: t }))] }));
}
/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({ path, message, busy, onClose, onRetry, t, }) {
    return ((0, jsx_runtime_1.jsx)(primitives_1.Modal, { open: true, onClose: onClose, closeLabel: t('close'), title: t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title'), description: message, footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", className: ChatView_styles_1.default.modalAction, onClick: onClose, children: t('cancel') }), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "primary", className: ChatView_styles_1.default.modalAction, disabled: busy, onClick: onRetry, children: t('retry') })] })) }));
}
/** Native clamp/compaction is not reader input and cannot steal follow ownership. */
function scrollFollowAtBottom(current, top, floor, observed, recentInput) {
    const delta = top - Math.min(observed, floor);
    if (!recentInput || Math.abs(delta) <= 0.5)
        return current;
    // Near-bottom tolerance is for downward re-entry, never for cancelling an
    // upward gesture. A layout shrink/clamp without movement keeps ownership.
    return delta > 0 && floor - top <= FOLLOW_THRESHOLD + 1;
}

},
"src/modules/conversation/chat/pending-tool.js": function(module, exports, require) {
// source: src/modules/conversation/chat/pending-tool.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcriptHasPendingTool = transcriptHasPendingTool;
const chat_node_codec_1 = require("../contract/chat-node-codec");
/** Pending root and recursive Computer privacy effects survive offscreen settlement. */
function transcriptHasPendingTool(node) {
    if (!(0, chat_node_codec_1.isChatNode)(node) || node.kind !== 'tool-call')
        return false;
    const stack = [node.data.root];
    for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
        if (!('kind' in block))
            return true;
        for (const child of block.subCalls)
            stack.push(child);
    }
    return false;
}

},
"src/modules/conversation/contract/chat-node-codec.js": function(module, exports, require) {
// source: src/modules/conversation/contract/chat-node-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isChatNode = isChatNode;
exports.isChatData = isChatData;
const zod_1 = require("zod");
const compaction_outcome_1 = require("../../shared/compaction-outcome");
const n = zod_1.z.number(), s = zod_1.z.string(), nullable = s.nullable();
const base = { seq: n, time: n };
const attachment = zod_1.z.looseObject({ attachmentId: s, mediaType: s, bytes: n, name: s.optional(), width: n.nullable().optional(), height: n.nullable().optional() });
const content = zod_1.z.unknown();
const callView = zod_1.z.looseObject({ card: s, kind: s.optional(), title: s.optional(), locations: zod_1.z.array(zod_1.z.object({ path: s, line: n.optional() })).optional() }).nullable();
const resultView = zod_1.z.looseObject({ card: s }).nullable();
const callBase = { ...base, callId: s, callView };
const tool = zod_1.z.lazy(() => zod_1.z.union([
    zod_1.z.looseObject({ callId: s, callView, time: n, name: s, argsRaw: s, turn: n, step: n, subCalls: zod_1.z.array(tool) }).refine(value => !('kind' in value)),
    zod_1.z.looseObject({ ...callBase, kind: zod_1.z.literal('tool-result'), call: zod_1.z.object({ name: s, argsRaw: s }).nullable(), callTime: n.nullable(),
        content: zod_1.z.array(content), isError: zod_1.z.boolean(), error: zod_1.z.object({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional(), resultView, subCalls: zod_1.z.array(tool),
    }),
]));
const blocks = zod_1.z.array(zod_1.z.union([
    zod_1.z.looseObject({ kind: zod_1.z.enum(['text', 'reasoning']), text: s }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('image'), attachment }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('tool-call'), callId: s, name: s, argsRaw: s }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('other'), block: zod_1.z.unknown() }),
]));
const finalAssistant = zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('assistant'), turn: n, step: n, blocks,
    messageId: s.optional(), usage: zod_1.z.unknown().optional(), interrupted: zod_1.z.literal(true).optional(),
    provenance: zod_1.z.object({ provider: s, model: s }).optional(),
    requestConfig: zod_1.z.looseObject({ provider: s, model: s, purpose: s.optional(), thinking: s.optional(), reasoningEffort: s.optional(), temperature: n.optional(), maxTokens: n.optional(), stop: zod_1.z.array(s).optional() }).optional(),
    timing: zod_1.z.object({ stepStartTime: n.nullable(), firstTokenTime: n.nullable(), completedTime: n, receptionMs: n.optional() }).optional(),
});
const assistant = zod_1.z.looseObject({ status: zod_1.z.enum(['running', 'settled', 'interrupted']), turn: n, step: n, blocks, time: n, usage: zod_1.z.unknown().optional(), finalNode: finalAssistant.optional() });
const command = zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('command'), commandId: s, name: nullable, args: nullable,
    outcome: zod_1.z.looseObject({ kind: zod_1.z.enum(['success', 'error']), text: s.optional(), sourceEventSeq: n.optional() }).nullable(),
});
const progress = zod_1.z.looseObject({ stage: zod_1.z.enum(['preparing', 'summarizing', 'splitting', 'merging', 'retrying', 'paused', 'validating', 'committing']),
    calls: n, completedParts: n, splits: n, retries: n, delayMs: n.nullish(), inputTokensBefore: n.nullish(), inputTokensAfter: n.nullish(),
}).optional();
const compaction = zod_1.z.union([
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('compaction'), summary: nullable, summaryEventSeq: n.nullable(), shadowedItemCount: n.nullable(), shadowedTokenCount: n.nullable(), progress, startedAt: n.optional(), endedAt: n.optional() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('compaction'), status: zod_1.z.enum(['running', 'failed', 'skipped', 'cancelled']), progress, progressTime: n.optional(), error: nullable, outcome: compaction_outcome_1.CompactionEndOutcomeSchema.optional(), endedAt: n.optional() }),
]);
const retryBase = { ...base, kind: zod_1.z.literal('model-retry'), turn: n, step: n, retryId: s, retry: n, retryState: zod_1.z.enum(['scheduled', 'started', 'cancelled']) };
const retryFacts = { delayMs: n, policyKey: s, provider: s, failure: zod_1.z.looseObject({ message: s, code: s }) };
const retry = zod_1.z.union([
    zod_1.z.looseObject({ ...retryBase, ...retryFacts, mode: zod_1.z.literal('normal'), maxRetries: n }),
    zod_1.z.looseObject({ ...retryBase, ...retryFacts, mode: zod_1.z.literal('always') }),
    zod_1.z.looseObject({ ...retryBase, partial: zod_1.z.literal(true) }),
]);
const schemas = {
    user: zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('user'), content: zod_1.z.array(content), source: zod_1.z.unknown(), referenceLabels: zod_1.z.array(s).optional() }),
    steering: zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('steering'), messageId: s, content: zod_1.z.array(content), source: zod_1.z.unknown(), referenceLabels: zod_1.z.array(s).optional() }),
    context: zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('context'), content: zod_1.z.array(content), source: zod_1.z.unknown(), provenance: zod_1.z.object({ role: zod_1.z.enum(['inject', 'recall']), label: nullable }), form: zod_1.z.enum(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']).nullable() }),
    command,
    compaction,
    'manual-compaction': zod_1.z.looseObject({ command, compaction: compaction.nullable() }),
    'assistant-step': assistant,
    'tool-call': zod_1.z.looseObject({ root: tool }),
    'model-retry': zod_1.z.looseObject({ attempts: zod_1.z.array(retry), current: retry }),
    'turn-error': zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-error'), turn: n, step: n, message: s, code: s.optional() }),
    'turn-max-tokens': zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-max-tokens'), turn: n, step: n }),
    unknown: zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('unknown'), type: s, data: zod_1.z.unknown() }),
    'run-checkpoint': zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('run-checkpoint'), turn: n, step: n, noticeKind: s, message: s }),
    'turn-tail': zod_1.z.looseObject({ ...base, turn: n, closing: assistant.extend({ finalNode: finalAssistant }).nullable(), branchUnavailable: zod_1.z.boolean(), ttftMs: n.optional(), tokensPerSecond: n.optional() }),
};
function knownKind(value) { return Object.hasOwn(schemas, value); }
/** Validate a foreign published node without cloning a valid owner's immutable payload. */
function isChatNode(node) {
    return node !== undefined && knownKind(node.kind) && schemas[node.kind].safeParse(node.data).success;
}
/** Location store values are owner-decoded rather than unsound generic getters. */
function isChatData(kind, value) {
    return schemas[kind].safeParse(value).success;
}

},
"src/modules/shared/compaction-outcome.js": function(module, exports, require) {
// source: src/modules/shared/compaction-outcome.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionEndOutcomeSchema = void 0;
exports.isCompactionEndOutcome = isCompactionEndOutcome;
exports.compactionTerminalPhase = compactionTerminalPhase;
exports.validCompactionTerminalData = validCompactionTerminalData;
const zod_1 = require("zod");
/** Additive durable terminal outcome. Absence retains legacy error semantics. */
exports.CompactionEndOutcomeSchema = zod_1.z.enum(['applied', 'no_benefit', 'no_eligible_source', 'interrupted', 'failed']);
function isCompactionEndOutcome(value) {
    return exports.CompactionEndOutcomeSchema.safeParse(value).success;
}
function compactionTerminalPhase(outcome, error) {
    switch (outcome) {
        case 'applied': return 'succeeded';
        case 'no_benefit':
        case 'no_eligible_source': return 'skipped';
        case 'interrupted': return 'cancelled';
        case 'failed': return 'failed';
        case undefined: return error == null ? 'succeeded' : 'failed';
    }
}
/** Validate explicit outcome/error consistency; legacy payloads remain accepted. */
function validCompactionTerminalData(value) {
    switch (value.outcome) {
        case 'applied':
        case 'no_benefit':
        case 'no_eligible_source': return value.error == null;
        case 'interrupted':
        case 'failed': return typeof value.error === 'string' && value.error.trim() !== '';
        case undefined: return true;
    }
}

},
"src/modules/conversation/chat/use-adaptive-tool-fold.js": function(module, exports, require) {
// source: src/modules/conversation/chat/use-adaptive-tool-fold.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAdaptiveToolFold = useAdaptiveToolFold;
const react_1 = require("react");
const process_mode_1 = require("./process-mode");
const adaptive_tool_fold_1 = require("./adaptive-tool-fold");
const chat_node_codec_1 = require("../contract/chat-node-codec");
/** One observer per chat, not per Tool. No transport/event parsing in this seat. */
function useAdaptiveToolFold(sessionId, list, expanded, beforeFold, revision) {
    const mode = (0, process_mode_1.useProcessMode)();
    const [state, setState] = (0, react_1.useState)(() => ({ sessionId, folded: adaptive_tool_fold_1.NO_FOLDED_TOOLS }));
    if (state.sessionId !== sessionId)
        setState({ sessionId, folded: adaptive_tool_fold_1.NO_FOLDED_TOOLS });
    // Seats subscribe to individual lifecycle updates, while the parent store
    // stays reference-stable. Invalidate before paint, not at the next geometry
    // measurement: an error/pending row may recover while the reader focuses it.
    const invalidateFoldedTool = (0, react_1.useCallback)((key) => {
        setState(previous => {
            if (previous.sessionId !== sessionId)
                return previous;
            let folded;
            for (const [turn, keys] of previous.folded) {
                if (!keys.has(key))
                    continue;
                folded ?? (folded = new Map(previous.folded));
                const kept = new Set(keys);
                kept.delete(key);
                if (kept.size)
                    folded.set(turn, kept);
                else
                    folded.delete(turn);
            }
            return folded === undefined ? previous : { sessionId, folded };
        });
    }, [sessionId]);
    const latest = (0, react_1.useRef)({ expanded, beforeFold, revision });
    latest.current = { expanded, beforeFold, revision };
    const scheduleRef = (0, react_1.useRef)(() => { });
    (0, react_1.useLayoutEffect)(() => {
        if (mode === 'expanded') {
            setState({ sessionId, folded: adaptive_tool_fold_1.NO_FOLDED_TOOLS });
            return;
        }
        const root = list.current;
        if (!root || typeof ResizeObserver === 'undefined')
            return;
        const elementRoot = root;
        const scrollport = root.closest('[data-conversation-scroll]') ?? root;
        let frame = 0, disposed = false;
        const observed = new Set(), manuallyOpened = new Set();
        const schedule = () => {
            if (disposed || frame)
                return;
            frame = requestAnimationFrame(measure);
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(scrollport);
        // ChatNodeStore is deliberately stable/mutable. A lifecycle update may
        // change eligibility without changing its identity or the row height.
        const mutations = new MutationObserver(schedule);
        mutations.observe(root, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-chat-auto-fold-turn', 'data-chat-auto-fold-eligible'] });
        function measure() {
            frame = 0;
            const elements = [...elementRoot.querySelectorAll('[data-chat-auto-fold-turn]')];
            const current = new Set(elements);
            for (const key of manuallyOpened) {
                const location = latest.current.revision.get(key)?.location;
                if ((location?.kind !== 'turn' && location?.kind !== 'step') || location.turn.status !== 'open')
                    manuallyOpened.delete(key);
            }
            for (const element of observed)
                if (!current.has(element)) {
                    observer.unobserve(element);
                    observed.delete(element);
                }
            for (const element of elements)
                if (!observed.has(element)) {
                    observer.observe(element);
                    observed.add(element);
                }
            const selection = document.getSelection();
            const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
            const rows = [];
            const readerAnchor = latest.current.beforeFold(false);
            for (const element of elements) {
                const turn = Number(element.dataset.chatAutoFoldTurn), key = element.dataset.chatFlowKey;
                if (key === undefined || latest.current.expanded.has(turn))
                    continue;
                const gap = Number.parseFloat(element.parentElement ? getComputedStyle(element.parentElement).rowGap : '0');
                rows.push({ key, turn, height: element.getBoundingClientRect().height + (Number.isFinite(gap) ? gap : 0),
                    eligible: element.dataset.chatAutoFoldEligible === 'true',
                    protected: manuallyOpened.has(key) || key === readerAnchor || element.contains(document.activeElement)
                        || !!(range && range.intersectsNode(element)) });
            }
            // The composer occupies part of the scrollport. Never use its space as
            // a tool budget, and never react to a hidden/zero-height chat viewport.
            const composer = scrollport.querySelector('[data-composer-seat]');
            const viewport = scrollport.getBoundingClientRect();
            const visibleHeight = Math.min(scrollport.clientHeight, (composer?.getBoundingClientRect().top ?? viewport.bottom) - viewport.top);
            const hidden = (0, adaptive_tool_fold_1.planToolFold)(rows, visibleHeight);
            if (hidden.size > 0)
                latest.current.beforeFold(true);
            setState(previous => {
                if (disposed || previous.sessionId !== sessionId)
                    return previous;
                const folded = new Map();
                let changed = false;
                // Display bookkeeping must not grow with every historical turn.
                // Closed/deleted turns need only the existing authoritative tail fold.
                for (const [turn, keys] of previous.folded) {
                    const kept = new Set();
                    for (const key of keys) {
                        const node = latest.current.revision.get(key);
                        const location = node?.location;
                        if ((location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open'
                            && (0, chat_node_codec_1.isChatNode)(node) && (0, adaptive_tool_fold_1.toolCanAutoFold)(node))
                            kept.add(key);
                    }
                    if (kept.size)
                        folded.set(turn, kept);
                    if (kept.size !== keys.size)
                        changed = true;
                }
                for (const row of rows)
                    if (hidden.has(row.key)) {
                        const keys = folded.get(row.turn) ?? new Set();
                        if (keys.has(row.key))
                            continue;
                        keys.add(row.key);
                        folded.set(row.turn, keys);
                        changed = true;
                    }
                return changed ? { sessionId, folded } : previous;
            });
        }
        const onClick = (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const disclosure = target?.closest('button[aria-expanded],summary');
            const row = disclosure?.closest('[data-chat-auto-fold-turn]');
            const key = row?.dataset.chatFlowKey;
            if (key && (disclosure?.getAttribute('aria-expanded') === 'false'
                || disclosure?.parentElement instanceof HTMLDetailsElement && !disclosure.parentElement.open))
                manuallyOpened.add(key);
            schedule();
        };
        root.addEventListener('click', onClick, true);
        root.addEventListener('focusout', schedule);
        document.addEventListener('selectionchange', schedule);
        scheduleRef.current = schedule;
        schedule();
        return () => {
            disposed = true;
            if (frame)
                cancelAnimationFrame(frame);
            scheduleRef.current = () => { };
            mutations.disconnect();
            observer.disconnect();
            observed.clear();
            manuallyOpened.clear();
            root.removeEventListener('click', onClick, true);
            root.removeEventListener('focusout', schedule);
            document.removeEventListener('selectionchange', schedule);
        };
    }, [sessionId, list, mode]);
    // New/settled nodes and explicit choices may change eligibility without
    // changing geometry. Observe them without tearing down the ResizeObserver.
    (0, react_1.useLayoutEffect)(() => { scheduleRef.current(); }, [revision, expanded, state]);
    return { foldedTools: mode === 'auto' && state.sessionId === sessionId ? state.folded : adaptive_tool_fold_1.NO_FOLDED_TOOLS, invalidateFoldedTool };
}

},
"src/modules/conversation/chat/process-mode.js": function(module, exports, require) {
// source: src/modules/conversation/chat/process-mode.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useProcessMode = void 0;
var process_display_1 = require("../../shared/process-display");
Object.defineProperty(exports, "useProcessMode", { enumerable: true, get: function () { return process_display_1.useProcessMode; } });

},
"src/modules/shared/process-display.js": function(module, exports, require) {
// source: src/modules/shared/process-display.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROCESS_MODE_KEY = void 0;
exports.normalizeProcessMode = normalizeProcessMode;
exports.useProcessMode = useProcessMode;
const react_1 = require("react");
exports.PROCESS_MODE_KEY = 'xharness.ui.process-mode.v1';
function normalizeProcessMode(value) {
    // Keep the old preference key: no data migration or destructive storage reset.
    return value === 'expanded' || value === 'verbose' ? 'expanded' : 'auto';
}
function useProcessMode() {
    const read = () => normalizeProcessMode(typeof document === 'undefined' ? undefined : document.documentElement.dataset.xhProcessMode);
    const [mode, setMode] = (0, react_1.useState)(read);
    (0, react_1.useEffect)(() => {
        const update = () => { setMode(read()); };
        window.addEventListener('xh-process-mode', update);
        update();
        return () => { window.removeEventListener('xh-process-mode', update); };
    }, []);
    return mode;
}

},
"src/modules/conversation/chat/adaptive-tool-fold.js": function(module, exports, require) {
// source: src/modules/conversation/chat/adaptive-tool-fold.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_FOLDED_TOOLS = exports.TOOL_FOLD_VIEWPORT_SHARE = void 0;
exports.toolCanAutoFold = toolCanAutoFold;
exports.toolCanFoldAfterTurn = toolCanFoldAfterTurn;
exports.planToolFold = planToolFold;
/** Display budget only: no request, token, Tool output or runtime policy changes. */
exports.TOOL_FOLD_VIEWPORT_SHARE = 0.4;
exports.NO_FOLDED_TOOLS = new Map();
/** Fail open on active, failed, recursive pending, or unknown tool carriers. */
function toolCanAutoFold(node) {
    return toolCanFold(node, false);
}
/** An authoritative turn/end can fold known failures too, but not an unresolved
 * call or an unknown execution outcome. The original failure remains inspectable.
 */
function toolCanFoldAfterTurn(node) {
    return toolCanFold(node, true);
}
function toolCanFold(node, includeFailures) {
    if (node.kind !== 'tool-call')
        return false;
    const stack = [node.data.root];
    for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
        // Agent communication acknowledgements must remain visible when a turn
        // closes or its tool activity is folded. This does not pin offscreen DOM:
        // ordinary transcript windowing still applies, including nested calls.
        if (('kind' in block ? block.call?.name : block.name) === 'agent')
            return false;
        // Projection's synthetic interrupted result has no settled tool/result.
        if (!('kind' in block) || block.kind !== 'tool-result'
            || block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted'
            || (!includeFailures && block.isError))
            return false;
        stack.push(...block.subCalls);
    }
    return true;
}
/** Oldest successful roots first. Keep the newest root and all protected rows.
 * Sticky folding avoids resize oscillation; explicit expansion bypasses it.
 * Window placeholders contribute their bounded estimate, without mounting them.
 */
function planToolFold(rows, viewportHeight, share = exports.TOOL_FOLD_VIEWPORT_SHARE) {
    const hidden = new Set();
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || !Number.isFinite(share) || share <= 0 || share >= 1)
        return hidden;
    const turns = new Map();
    for (const row of rows) {
        const group = turns.get(row.turn) ?? [];
        group.push(row);
        turns.set(row.turn, group);
    }
    const budget = viewportHeight * share;
    for (const group of turns.values()) {
        let height = group.reduce((sum, row) => sum + (Number.isFinite(row.height) ? Math.max(0, row.height) : 0), 0);
        for (const row of group.slice(0, -1)) {
            if (height <= budget)
                break;
            if (!row.eligible || row.protected || !Number.isFinite(row.height) || row.height <= 0)
                continue;
            hidden.add(row.key);
            height -= row.height;
        }
    }
    return hidden;
}

},
"src/modules/conversation/chat/MessageItem.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageItem.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownNodeView = exports.TurnMaxTokensNodeView = exports.TurnErrorNodeView = exports.RetryNodeView = exports.CompactionNodeView = exports.ContextMessageNodeView = exports.UserMessageNodeView = void 0;
exports.PendingSteeringBubble = PendingSteeringBubble;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../../shared/runtime-types");
const wire_guards_1 = require("../wire-guards");
const CompactionProgressCard_1 = require("./CompactionProgressCard");
// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock + copy IconActions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const ReferenceIcon_1 = require("../reference/ReferenceIcon");
const CompactionItem_1 = require("./CompactionItem");
const ContextInjectionRow_1 = require("./ContextInjectionRow");
const MessageIconActions_1 = require("./MessageIconActions");
const MessageItem_styles_1 = __importDefault(require("./MessageItem.styles"));
const MessageEditActions_1 = require("../edit/MessageEditActions");
function contentParts(content) {
    const texts = [];
    const images = [];
    const rest = [];
    for (const block of content) {
        if (!(0, runtime_types_1.isObjectRecord)(block)) {
            rest.push(block);
            continue;
        }
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string')
            texts.push(b.text);
        else if ((b.type === 'image' || b.type === 'file') && (0, wire_guards_1.isImageAttachmentRef)(b.attachment)) {
            images.push({ attachment: b.attachment, kind: b.type });
        }
        else
            rest.push(block);
    }
    return { text: texts.join(''), images, rest };
}
function retrySeconds(milliseconds) {
    return Math.max(1, Math.ceil(milliseconds / 1000));
}
function ModelRetryItem({ node, active, t }) {
    // Anchor the host-scheduled delay to this browser's first render of the
    // retry node. Host event time and Date.now() may belong to different clocks.
    const deadline = (0, react_1.useMemo)(() => Date.now() + (node.delayMs ?? 0), [node.delayMs, node.seq]);
    const scheduledSeconds = node.delayMs === undefined ? '—' : retrySeconds(node.delayMs);
    const maximum = node.partial ? '—' : node.mode === 'normal' ? node.maxRetries : '∞';
    const [countdown, setCountdown] = (0, react_1.useState)(() => ({
        deadline,
        seconds: retrySeconds(deadline - Date.now()),
    }));
    const remainingSeconds = countdown.deadline === deadline
        ? countdown.seconds
        : retrySeconds(deadline - Date.now());
    (0, react_1.useEffect)(() => {
        if (!active)
            return;
        const updateCountdown = () => {
            const next = retrySeconds(deadline - Date.now());
            setCountdown(current => (current.deadline === deadline && current.seconds === next
                ? current
                : { deadline, seconds: next }));
            return next;
        };
        if (updateCountdown() === 1)
            return;
        const timer = window.setInterval(() => {
            if (updateCountdown() === 1)
                window.clearInterval(timer);
        }, 250);
        return () => { window.clearInterval(timer); };
    }, [active, deadline]);
    const label = active
        ? t(node.mode === 'always' && (node.policyKey === 'xharness:network-wait' || node.policyKey === 'xharness:network-wait:continuation') ? 'message.retry.networkWaiting' : 'message.retry.active')
        : node.retryState === 'cancelled'
            ? t('message.retry.cancelled')
            : node.retryState === 'started'
                ? t('message.retry.started')
                : t('message.retry.scheduled');
    const seconds = active ? remainingSeconds : scheduledSeconds;
    return ((0, jsx_runtime_1.jsxs)("details", { className: MessageItem_styles_1.default.retryRow, "data-active": active || undefined, children: [(0, jsx_runtime_1.jsx)("summary", { className: MessageItem_styles_1.default.retrySummary, children: (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.retryText, role: "status", children: t('message.retry.status', { label, retry: node.retry, maximum, seconds }) }) }), (0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.retryDetails, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.retryDetailLabel, children: t('message.retry.delay') }), node.delayMs === undefined ? '—' : Math.round(node.delayMs), "ms"] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.retryDetailLabel, children: t('message.retry.failure') }), node.failure?.message ?? '—'] })] })] }));
}
/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.turnErrorRow, role: "status", children: [(0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "error", className: MessageItem_styles_1.default.turnErrorDot }), (0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.turnErrorCopy, children: [(0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.turnErrorTitle, children: t('message.turnError') }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.turnErrorMessage, children: node.message })] }), node.code !== undefined && (0, jsx_runtime_1.jsx)("code", { className: MessageItem_styles_1.default.turnErrorCode, children: node.code })] }));
}
/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.turnErrorRow, role: "status", children: [(0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "warning", className: MessageItem_styles_1.default.turnErrorDot }), (0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.turnErrorCopy, children: [(0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.maxTokensTitle, children: t('message.maxTokens') }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.turnErrorMessage, children: t('message.maxTokens.hint') })] })] }));
}
/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
function projectUserText(text, sessionLabels) {
    const ranges = [];
    for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
        const label = `@${rawLabel}`;
        let start = text.indexOf(label);
        while (start >= 0) {
            ranges.push({ start, end: start + label.length, label, kind: 'session' });
            start = text.indexOf(label, start + label.length);
        }
    }
    const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu;
    let m;
    while ((m = re.exec(text)) !== null) {
        const tokenStart = m.index + (m[1]?.length ?? 0);
        const rawLabel = m[2] ?? '';
        const label = rawLabel.startsWith('@"')
            ? rawLabel
            : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '');
        if (label.length <= 1)
            continue;
        ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' });
    }
    ranges.sort((a, b) => a.start - b.start
        || (a.kind === b.kind ? b.end - a.end : a.kind === 'session' ? -1 : 1));
    const parts = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start < cursor)
            continue;
        const { start: tokenStart, end, label, kind } = range;
        if (tokenStart > cursor)
            parts.push((0, jsx_runtime_1.jsx)(primitives_1.MessageText, { text: text.slice(cursor, tokenStart) }, cursor));
        const referenceKind = kind === 'session'
            ? 'session'
            : label.startsWith('@')
                ? label.endsWith('/') ? 'folder' : 'file'
                : undefined;
        const displayLabel = referenceKind === undefined
            ? label
            : referenceKind === 'session'
                ? label.slice(1)
                : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1);
        parts.push((0, jsx_runtime_1.jsxs)("span", { className: MessageItem_styles_1.default.refChip, "data-ref-chip": referenceKind ?? 'skill', title: label, children: [referenceKind !== undefined && ((0, jsx_runtime_1.jsx)(ReferenceIcon_1.ReferenceIcon, { kind: referenceKind, size: 16, className: MessageItem_styles_1.default.refIcon })), displayLabel] }, tokenStart));
        cursor = end;
    }
    if (parts.length === 0)
        return (0, jsx_runtime_1.jsx)(primitives_1.MessageText, { text: text });
    if (cursor < text.length)
        parts.push((0, jsx_runtime_1.jsx)(primitives_1.MessageText, { text: text.slice(cursor) }, cursor));
    return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: parts });
}
/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({ content, renderMessageImages, actions, pending = false, referenceLabels = [], t, }) {
    const { text, images, rest } = contentParts(content);
    const truncated = (total) => t('json.truncated', { total });
    const showBubble = text !== '' || rest.length > 0;
    return ((0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.userRow, "data-pending-steering": pending || undefined, "data-time-hover-root": true, children: [(0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.userStack, children: [renderMessageImages({ images, align: 'end' }), showBubble && (0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.bubble, children: [projectUserText(text, referenceLabels), rest.map((block, i) => (0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.extraBlock'), payload: block, truncatedLabel: truncated }, i))] }), referenceLabels.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: MessageItem_styles_1.default.referenceSummary, children: t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) }) }))] }), actions?.(text)] }));
}
/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
function PendingSteeringBubble({ content, renderMessageImages, t }) {
    return ((0, jsx_runtime_1.jsx)(UserStyleBubble, { content: content, renderMessageImages: renderMessageImages, pending: true, t: t, actions: text => ((0, jsx_runtime_1.jsx)(MessageIconActions_1.MessageIconActions, { text: text, clock: "start", className: MessageItem_styles_1.default.actions, t: t })) }));
}
/** User and admitted-steering keyed Chat renderer. */
exports.UserMessageNodeView = (0, react_1.memo)(function UserMessageNodeView({ node, renderMessageImages, editMessage, forkMessage, editAvailable, t, }) {
    const data = node.data;
    return ((0, jsx_runtime_1.jsx)(UserStyleBubble, { content: data.content, renderMessageImages: renderMessageImages, ...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }, t: t, actions: text => ((0, jsx_runtime_1.jsx)(MessageIconActions_1.MessageIconActions, { text: text, time: data.time, clock: "start", className: MessageItem_styles_1.default.actions, extraActions: editAvailable && data.content.length > 0 ? (0, jsx_runtime_1.jsx)(MessageEditActions_1.MessageEditActions, { content: data.content, seq: data.seq, editMessage: editMessage, forkMessage: forkMessage, t: t }) : undefined, t: t })) }));
});
/** Injected-context keyed Chat renderer. */
exports.ContextMessageNodeView = (0, react_1.memo)(function ContextMessageNodeView({ node, t }) {
    const data = node.data;
    return ((0, jsx_runtime_1.jsx)(ContextInjectionRow_1.ContextInjectionRow, { content: data.content, source: data.source, provenance: data.provenance, form: data.form, t: t }));
});
/** Automatic compaction keyed Chat renderer. */
exports.CompactionNodeView = (0, react_1.memo)(function CompactionNodeView({ node, t }) {
    if ('status' in node.data)
        return (0, jsx_runtime_1.jsx)(CompactionProgressCard_1.CompactionProgressCard, { data: node.data, t: t });
    return (0, jsx_runtime_1.jsx)(CompactionItem_1.CompactionItem, { node: node.data, t: t });
});
/** Correlated retry-chain keyed Chat renderer. */
exports.RetryNodeView = (0, react_1.memo)(function RetryNodeView({ node, t }) {
    const data = node.data;
    return (0, jsx_runtime_1.jsx)(ModelRetryItem, { node: data.current, active: data.current.retryState === 'scheduled', t: t });
});
/** Terminal turn-error keyed Chat renderer. */
exports.TurnErrorNodeView = (0, react_1.memo)(function TurnErrorNodeView({ node, t }) {
    return (0, jsx_runtime_1.jsx)(TurnErrorItem, { node: node.data, t: t });
});
/** Max-tokens turn-end notice keyed Chat renderer. */
exports.TurnMaxTokensNodeView = (0, react_1.memo)(function TurnMaxTokensNodeView({ t }) {
    return (0, jsx_runtime_1.jsx)(TurnMaxTokensItem, { t: t });
});
/** Explicit unknown-surface keyed Chat renderer. */
exports.UnknownNodeView = (0, react_1.memo)(function UnknownNodeView({ node, t }) {
    const data = node.data;
    return ((0, jsx_runtime_1.jsx)("div", { className: MessageItem_styles_1.default.contextRow, children: (0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownSurface', { type: data.type }), payload: data.data, truncatedLabel: (total) => t('json.truncated', { total }) }) }));
});

},
"src/modules/conversation/chat/CompactionProgressCard.js": function(module, exports, require) {
// source: src/modules/conversation/chat/CompactionProgressCard.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionProgressCard = CompactionProgressCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../primitives");
const transcript_state_1 = require("./transcript-state");
const MessageItem_styles_1 = __importDefault(require("./MessageItem.styles"));
/** Minimal status; runtime owns all durable progress, waits and recovery. */
function CompactionProgressCard({ data, t }) {
    const [open, setOpen] = (0, transcript_state_1.useTranscriptState)('compact-progress', false);
    const active = data.status === 'running';
    const paused = active && data.progress?.stage === 'paused';
    const title = paused ? t('xh.compact.paused') : active ? t('message.compaction.running')
        : data.status === 'skipped' ? t('xh.compact.skipped') : data.status === 'cancelled' ? t('xh.compact.cancelled') : t('xh.compact.failed');
    const detail = paused ? t('xh.compact.resume') : active ? t('xh.compact.takesMinutes') : t('xh.compact.unchanged');
    const content = (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.IconApiOutline14, { "aria-hidden": true }), (0, jsx_runtime_1.jsxs)("span", { style: { minWidth: 0, overflowWrap: 'anywhere' }, children: [title, " \u00B7 ", detail] })] });
    return (0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.compactionRow, "data-compaction-progress": true, "data-compaction-running": active || undefined, "data-active": active || undefined, "data-state": data.status === 'failed' ? 'error' : data.status, "data-stage": data.progress?.stage, style: { display: 'block', width: '100%', minWidth: 0 }, children: [active ? (0, jsx_runtime_1.jsx)("div", { role: "status", "aria-live": "polite", "aria-atomic": true, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }, children: content })
                : (0, jsx_runtime_1.jsx)("div", { role: data.status === 'failed' ? 'alert' : 'status', children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: MessageItem_styles_1.default.compactionButton, "aria-expanded": open, disabled: !data.error, onClick: () => { setOpen(value => !value); }, style: { width: '100%', textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }, children: [content, data.error && (open ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, { "aria-hidden": true }) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { "aria-hidden": true }))] }) }), !active && open && data.error && (0, jsx_runtime_1.jsx)("div", { style: { padding: '4px 0 10px 22px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }, children: data.error })] });
}

},
"src/modules/conversation/chat/transcript-state.js": function(module, exports, require) {
// source: src/modules/conversation/chat/transcript-state.ts

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
exports.useTranscriptState = exports.transcriptState = void 0;
exports.transcriptStateFor = transcriptStateFor;
const React = __importStar(require("react"));
function createBridge() {
    const Context = React.createContext(null);
    function useStoredState(key, initial, read) {
        const store = React.useContext(Context);
        const [value, publish] = React.useState(() => {
            const restored = read(store?.get(key));
            if (restored !== undefined)
                return restored;
            store?.set(key, initial);
            return initial;
        });
        const current = React.useRef(value);
        const set = React.useCallback(next => {
            const result = typeof next === 'function' ? next(current.current) : next;
            current.current = result;
            store?.set(key, result);
            publish(result);
        }, [store, key]);
        return [value, set];
    }
    function useState(key, initial) {
        if (typeof initial === 'boolean')
            return useStoredState(key, initial, value => typeof value === 'boolean' ? value : undefined);
        return useStoredState(key, initial, value => typeof value === 'string' || value === null ? value : undefined);
    }
    return { Context, useState };
}
/** Shared by independent plugin factories through the unchanged React singleton. */
function transcriptStateFor(react) {
    const registry = globalThis.__xhTranscriptState ?? (globalThis.__xhTranscriptState = new WeakMap());
    let state = registry.get(react.createElement);
    if (!state) {
        state = createBridge();
        registry.set(react.createElement, state);
    }
    return state;
}
exports.transcriptState = transcriptStateFor(React);
exports.useTranscriptState = exports.transcriptState.useState;

},
"src/modules/conversation/chat/MessageItem.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageItem.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MessageItem_css_1 = __importDefault(require("./MessageItem.css"));
exports.default = { actions: '',
    "bubble": "L-d22q_bubble",
    "compactionBody": "L-d22q_compactionBody",
    "compactionButton": "L-d22q_compactionButton",
    "compactionContextIcon": "L-d22q_compactionContextIcon",
    "compactionDisclosureIcon": "L-d22q_compactionDisclosureIcon",
    "compactionLeading": "L-d22q_compactionLeading",
    "compactionRow": "L-d22q_compactionRow",
    "compactionSep": "L-d22q_compactionSep",
    "compactionSummary": "L-d22q_compactionSummary",
    "compactionTitle": "L-d22q_compactionTitle",
    "contextRow": "L-d22q_contextRow",
    "maxTokensTitle": "L-d22q_maxTokensTitle",
    "refChip": "L-d22q_refChip",
    "refIcon": "L-d22q_refIcon",
    "referenceSummary": "L-d22q_referenceSummary",
    "retry-shimmer": "L-d22q_retry-shimmer",
    "retryDetailLabel": "L-d22q_retryDetailLabel",
    "retryDetails": "L-d22q_retryDetails",
    "retryRow": "L-d22q_retryRow",
    "retrySummary": "L-d22q_retrySummary",
    "retryText": "L-d22q_retryText",
    "turnErrorCode": "L-d22q_turnErrorCode",
    "turnErrorCopy": "L-d22q_turnErrorCopy",
    "turnErrorDot": "L-d22q_turnErrorDot",
    "turnErrorMessage": "L-d22q_turnErrorMessage",
    "turnErrorRow": "L-d22q_turnErrorRow",
    "turnErrorTitle": "L-d22q_turnErrorTitle",
    "userRow": "L-d22q_userRow",
    "userStack": "L-d22q_userStack"
};
const tagId = '@xharness/dsh-client-ui-conversation/MessageItem.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = MessageItem_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/MessageItem.css": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageItem.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".L-d22q_userRow{flex-direction:column;align-items:flex-end;gap:6px;display:flex}.L-d22q_userStack{flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%);display:flex}.L-d22q_bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px}.L-d22q_referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.L-d22q_contextRow,.L-d22q_compactionRow{padding:2px 0}.L-d22q_compactionButton{width:100%;min-width:0;height:24px;color:inherit;font:inherit;text-align:left;background:0 0;border:none;border-radius:6px;align-items:center;padding:0;display:flex}.L-d22q_compactionButton:not(:disabled){cursor:pointer}.L-d22q_compactionButton:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}.L-d22q_compactionLeading{width:16px;height:16px;color:var(--dsw-alias-label-secondary);flex:none;place-items:center;margin-right:6px;display:inline-grid}.L-d22q_compactionContextIcon,.L-d22q_compactionDisclosureIcon{grid-area:1/1;justify-content:center;align-items:center;display:inline-flex}.L-d22q_compactionDisclosureIcon,.L-d22q_compactionButton:not(:disabled):hover .L-d22q_compactionContextIcon,.L-d22q_compactionButton:not(:disabled):focus-visible .L-d22q_compactionContextIcon{opacity:0}.L-d22q_compactionButton:not(:disabled):hover .L-d22q_compactionDisclosureIcon,.L-d22q_compactionButton:not(:disabled):focus-visible .L-d22q_compactionDisclosureIcon{opacity:1}.L-d22q_compactionTitle{color:var(--dsw-alias-label-primary-dimmed);flex:none;font-size:14px;line-height:24px}.L-d22q_compactionSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.L-d22q_compactionSummary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}.L-d22q_compactionBody{color:var(--dsw-alias-label-tertiary);padding:4px 0 4px 22px;font-size:14px;line-height:24px}.L-d22q_retryRow{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.L-d22q_retrySummary{width:fit-content;color:inherit;cursor:pointer;user-select:none;border-radius:3px;align-items:center;gap:7px;padding:2px 0;list-style:none;display:inline-flex}.L-d22q_retrySummary::-webkit-details-marker{display:none}.L-d22q_retrySummary:after{content:\"\";opacity:.8;border-bottom:1.5px solid;border-right:1.5px solid;width:6px;height:6px;transition:transform .12s;transform:rotate(-45deg)}.L-d22q_retrySummary:hover{color:var(--dsw-alias-label-secondary)}.L-d22q_retrySummary:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:2px}.L-d22q_retryText{color:inherit}.L-d22q_retryRow[data-active] .L-d22q_retryText{background:linear-gradient(90deg, var(--dsw-alias-label-tertiary) 0%, var(--dsw-alias-label-tertiary) 40%, var(--dsw-alias-label-secondary) 50%, var(--dsw-alias-label-tertiary) 60%, var(--dsw-alias-label-tertiary) 100%);color:#0000;background-position:100%;background-size:200% 100%;background-clip:text;animation:1.6s ease-in-out infinite L-d22q_retry-shimmer}.L-d22q_retryRow[open] .L-d22q_retrySummary:after{transform:rotate(45deg)}.L-d22q_retryDetails{overflow-wrap:anywhere;gap:2px;margin-top:3px;padding-left:14px;font-size:12px;line-height:18px;display:grid}.L-d22q_retryDetailLabel{color:var(--dsw-alias-label-secondary)}.L-d22q_turnErrorRow{grid-template-columns:10px minmax(0,1fr) auto;align-items:start;gap:8px;padding:2px 0;font-size:13px;line-height:20px;display:grid}.L-d22q_turnErrorDot{margin-top:5px}.L-d22q_turnErrorCopy{overflow-wrap:anywhere;min-width:0}.L-d22q_turnErrorTitle{color:var(--dsw-alias-state-error-primary);margin-right:6px;font-weight:600}.L-d22q_turnErrorMessage{color:var(--dsw-alias-label-secondary)}.L-d22q_turnErrorCode{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-markdown-code-block-small)}.L-d22q_maxTokensTitle{color:var(--dsw-alias-state-warn-primary);margin-right:6px;font-weight:600}@keyframes L-d22q_retry-shimmer{0%{background-position:100%}to{background-position:0}}@media (prefers-reduced-motion:reduce){.L-d22q_retryRow[data-active] .L-d22q_retryText{color:inherit;background:0 0;animation:none}}.L-d22q_refChip{color:var(--dsw-alias-state-business-primary);white-space:nowrap;vertical-align:baseline;align-items:center;gap:4px;margin:0 2px;font-weight:500;display:inline-flex}.L-d22q_refIcon{flex:none}";

},
"src/modules/conversation/chat/CompactionItem.js": function(module, exports, require) {
// source: src/modules/conversation/chat/CompactionItem.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionItem = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const transcript_state_1 = require("./transcript-state");
// CompactionItem: the one row a landed compaction contributes to the flow.
// The conversation it shadowed on the model surface stays above it, so this
// marker reports where the model stopped seeing that history — it never
// replaces it. The framed checkpoint payload is written for the model and is
// not rendered; the disclosure shows the summary from the checkpoint's own
// cited `compaction/summary` event, and a window cut that left that event outside makes the row
// non-expandable rather than empty.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const MessageItem_styles_1 = __importDefault(require("./MessageItem.styles"));
/**
 * The collapsed-by-default compaction marker.
 * @param props - the marker node off the snapshot cache.
 * @returns the marker row, with the summary disclosure when one is available.
 */
exports.CompactionItem = (0, react_1.memo)(function CompactionItem({ node, title, fallbackSummary, t, }) {
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('compact', false);
    const expandable = node.summary !== null;
    const open = expandable && expanded;
    const summary = node.shadowedItemCount !== null && node.shadowedTokenCount !== null
        ? t('message.compaction.completed', {
            items: node.shadowedItemCount,
            tokens: node.shadowedTokenCount,
        })
        : fallbackSummary
            ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'));
    return ((0, jsx_runtime_1.jsxs)("div", { className: MessageItem_styles_1.default.compactionRow, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: MessageItem_styles_1.default.compactionButton, disabled: !expandable, "aria-expanded": expandable ? open : undefined, onClick: () => { setExpanded(value => !value); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: MessageItem_styles_1.default.compactionLeading, "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.compactionContextIcon, "data-compaction-icon": "context", children: (0, jsx_runtime_1.jsx)(primitives_1.IconApiOutline14, {}) }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.compactionDisclosureIcon, "data-compaction-disclosure": open ? 'expanded' : 'collapsed', children: open ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, {}) })] }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.compactionTitle, children: title ?? t('message.compaction') }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.compactionSep, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: MessageItem_styles_1.default.compactionSummary, children: summary })] }), open && node.summary !== null
                && (0, jsx_runtime_1.jsx)("div", { className: MessageItem_styles_1.default.compactionBody, children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: node.summary }) })] }));
});

},
"src/modules/conversation/chat/ContextInjectionRow.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextInjectionRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextInjectionRow = ContextInjectionRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const transcript_state_1 = require("./transcript-state");
const primitives_1 = require("../primitives");
const ReferenceIcon_1 = require("../reference/ReferenceIcon");
const ContextBody_1 = require("./ContextBody");
const ContextInjectionRow_styles_1 = __importDefault(require("./ContextInjectionRow.styles"));
/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * The expanded body follows the producer-declared form; an absent or unknown
 * form renders the opaque body.
 * @param props - Durable content, its projected producer role/name and form, and the locale seat.
 * @returns A collapsed context row with a bounded, form-specific body.
 */
function ContextInjectionRow({ content, source, provenance, form, t }) {
    const [open, setOpen] = (0, transcript_state_1.useTranscriptState)('context', false);
    // Resolved rather than declared: a form whose fields are unreadable renders
    // the opaque body, and the marker must say what the row actually shows.
    const { rendered, summary, body } = (0, ContextBody_1.contextBody)(form, { content, source, t });
    return ((0, jsx_runtime_1.jsx)(primitives_1.DisclosureRow, { className: ContextInjectionRow_styles_1.default.root, icon: provenance.role === 'recall'
            ? (0, jsx_runtime_1.jsx)("span", { "data-context-recall-icon": true, children: (0, jsx_runtime_1.jsx)(ReferenceIcon_1.ReferenceIcon, { kind: "session" }) })
            : (0, jsx_runtime_1.jsx)(primitives_1.IconBrowseOutline16, { size: 14 }), chevronClassName: ContextInjectionRow_styles_1.default.chevron, title: t(provenance.role === 'recall' ? 'message.contextRecall' : 'message.contextInjection'), collapsedContent: provenance.label === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: ContextInjectionRow_styles_1.default.sep, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: ContextInjectionRow_styles_1.default.source, "data-context-source": true, children: provenance.label }), summary !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: ContextInjectionRow_styles_1.default.sep, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: ContextInjectionRow_styles_1.default.summary, "data-context-summary": true, children: summary })] }))] })), keepContentWhenOpen: true, open: open, expandable: true, expandOnRowClick: true, onToggle: () => { setOpen(value => !value); }, children: (0, jsx_runtime_1.jsx)("div", { className: ContextInjectionRow_styles_1.default.body, "data-context-injection-body": true, "data-context-form": rendered ?? undefined, children: body }) }));
}

},
"src/modules/conversation/chat/ContextBody.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextBody.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpaqueBody = OpaqueBody;
exports.InstructionsBody = InstructionsBody;
exports.CatalogBody = CatalogBody;
exports.SnapshotBody = SnapshotBody;
exports.NoticeBody = NoticeBody;
exports.RelayBody = RelayBody;
exports.RecallBody = RecallBody;
exports.contextBody = contextBody;
const jsx_runtime_1 = require("react/jsx-runtime");
const wire_guards_1 = require("../wire-guards");
const runtime_types_1 = require("../../shared/runtime-types");
const primitives_1 = require("../primitives");
const ContextBody_styles_1 = __importDefault(require("./ContextBody.styles"));
/** Model-facing text stays bounded at the disclosure, not at the producer. */
const MAX_CHARS = 20000;
/** Rows a list body materializes before summarizing the remainder. */
const MAX_ENTRIES = 200;
/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value) {
    return (0, runtime_types_1.isObjectRecord)(value)
        ? value
        : null;
}
/**
 * The content blocks as runs, IN THE ORDER the model received them.
 *
 * Adjacent text blocks join with no separator, matching how provider adapters
 * flatten them — inserting a line break would show the reader a line the model
 * never saw. An unknown block breaks the run and keeps its own fallback rather
 * than being hoisted past the text around it or vanishing; the block union is
 * merge-extensible, so a foreign log may interleave shapes this build does not
 * know.
 */
function contentRuns(content) {
    const runs = [];
    for (const block of content) {
        if (!(0, runtime_types_1.isObjectRecord)(block) || block.type !== 'text' || typeof block.text !== 'string') {
            runs.push({ block });
            continue;
        }
        const last = runs[runs.length - 1];
        if (last !== undefined && 'text' in last)
            last.text += block.text;
        else
            runs.push({ text: block.text });
    }
    return runs;
}
/** Only the blocks this UI version does not know, for bodies that replace the text. */
function unknownBlocks(content) {
    return contentRuns(content).flatMap(run => 'block' in run ? [run.block] : []);
}
/** The model-facing text, truncated to the display bound. */
function boundedText(text, t) {
    return text.length > MAX_CHARS
        ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
        : text;
}
/**
 * One source field rendered as a value row; nested shapes stay compact JSON.
 * Bounded on its own, because source fields are as unbounded as the text: an unknown
 * producer may record an arbitrarily large string or array.
 */
function fieldValue(value, t) {
    const text = typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
    return boundedText(text, t);
}
/**
 * Source fields as a key/value list. `kind` is always omitted because the
 * row header already names the producer. `form` is omitted only when a
 * dedicated body rendered for it — then the presentation the reader is looking
 * at IS that value. On the opaque fallback the declaration is kept, because
 * that is the one place a form this version cannot present would otherwise
 * disappear from the UI entirely.
 */
function SourceFields({ source, formRendered, t }) {
    const record = asRecord(source);
    if (record === null)
        return null;
    const hidden = formRendered ? ['kind', 'form'] : ['kind'];
    const rows = Object.entries(record).filter(([key]) => !hidden.includes(key));
    if (rows.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsx)("dl", { className: ContextBody_styles_1.default.fields, "data-context-fields": true, children: rows.map(([key, value]) => ((0, jsx_runtime_1.jsxs)("div", { className: ContextBody_styles_1.default.field, children: [(0, jsx_runtime_1.jsx)("dt", { className: ContextBody_styles_1.default.fieldKey, children: key }), (0, jsx_runtime_1.jsx)("dd", { className: ContextBody_styles_1.default.fieldValue, children: fieldValue(value, t) })] }, key))) }));
}
/**
 * Content blocks this UI version does not know, kept visible rather than
 * dropped: the block union is merge-extensible, so a newer or foreign log may
 * carry a shape this build has no presentation for.
 * @param props - The unrecognized blocks and the locale seat.
 * @returns One generic JSON block per unknown entry.
 */
function UnknownBlocks({ blocks, t }) {
    return ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: blocks.map((block, index) => ((0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownBlock'), payload: block, truncatedLabel: (total) => t('json.truncated', { total }) }, index))) }));
}
/**
 * The model-facing content of one context, shared by every form that shows it:
 * the text with its real line breaks, then any block this UI version does not
 * know, which keeps its own fallback rather than vanishing.
 * @param props - Durable content and the locale seat.
 * @returns The content blocks as the model received them.
 */
function ModelFacingContent({ content, t }) {
    return ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: contentRuns(content).map((run, index) => ('text' in run
            ? run.text !== '' && ((0, jsx_runtime_1.jsx)("pre", { className: ContextBody_styles_1.default.text, "data-context-text": true, children: boundedText(run.text, t) }, index))
            : ((0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownBlock'), payload: run.block, truncatedLabel: (total) => t('json.truncated', { total }) }, index)))) }));
}
/**
 * Default presentation: the model-facing text as text, with its real line
 * breaks, and the remaining source fields beneath it. This is what every form
 * this UI version does not recognize renders as.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The opaque context body.
 */
function OpaqueBody({ content, source, t }) {
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ModelFacingContent, { content: content, t: t }), (0, jsx_runtime_1.jsx)(SourceFields, { source: source, formRendered: false, t: t })] }));
}
/**
 * Instruction changes read off the source, or null when the record is not a
 * usable instruction list.
 *
 * The read is all-or-nothing: silently dropping one unreadable entry would show
 * a confident, incomplete file list for a log this version cannot fully read.
 * Paths are deduplicated in first-seen order, matching how the header label is
 * derived from the same array.
 */
function instructionChanges(source) {
    const record = asRecord(source);
    const list = record === null ? undefined : record['changes'];
    if (!(0, wire_guards_1.isUnknownArray)(list))
        return null;
    const changes = [];
    const seen = new Set();
    for (const entry of list) {
        const change = asRecord(entry);
        if (change === null)
            return null;
        const path = change['path'];
        if (typeof path !== 'string' || path === '')
            return null;
        const action = change['action'];
        // The action decides which word the row shows, so an unrecognized one is
        // not a readable change — it would be presented as loaded or updated.
        if (action !== 'set' && action !== 'replace' && action !== 'remove')
            return null;
        const digest = change['digest'];
        if (seen.has(path))
            continue;
        seen.add(path);
        changes.push({ action, path, ...typeof digest === 'string' ? { digest } : {} });
    }
    return changes.length === 0 ? null : changes;
}
/**
 * Locale key for one reconciled file. The baseline loads a file; a later delta
 * distinguishes a newly reconciled path from a rewritten one, which `set` and
 * `replace` already separate at the producer.
 * @param action - the durable change action.
 * @param baseline - whether this context is the startup/resume baseline.
 * @returns the key naming what happened to that file.
 */
function instructionAction(action, baseline) {
    if (action === 'remove')
        return 'message.context.instructions.removed';
    if (baseline)
        return 'message.context.instructions.loaded';
    return action === 'set' ? 'message.context.instructions.added' : 'message.context.instructions.updated';
}
/**
 * `instructions` form: the files this context reconciled, then their text.
 *
 * The text keeps its `<system-reminder>` framing verbatim — the framing is part
 * of what the model read, so hiding it would misreport the request.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The instructions context body, or the opaque body when the change
 * list is unreadable.
 */
function InstructionsBody({ content, source, t }) {
    const changes = instructionChanges(source);
    if (changes === null)
        return (0, jsx_runtime_1.jsx)(OpaqueBody, { content: content, source: source, t: t });
    const baseline = asRecord(source)?.['baseline'] === true;
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("ul", { className: ContextBody_styles_1.default.files, "data-context-files": true, children: changes.map(change => ((0, jsx_runtime_1.jsxs)("li", { className: ContextBody_styles_1.default.file, title: change.digest, children: [(0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.filePath, children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.fileAction, children: t(instructionAction(change.action, baseline)) })] }, change.path))) }), (0, jsx_runtime_1.jsx)(ModelFacingContent, { content: content, t: t })] }));
}
/**
 * Catalog entries read off the source, or null when the record is not a usable
 * catalog. All-or-nothing for the same reason as the instruction list: this body
 * replaces the model-facing text, so a partial list would hide the only complete
 * account of what the model read.
 */
function catalogEntries(source) {
    const record = asRecord(source);
    const list = record === null ? undefined : record['entries'];
    if (!(0, wire_guards_1.isUnknownArray)(list))
        return null;
    const entries = [];
    for (const item of list) {
        const entry = asRecord(item);
        if (entry === null)
            return null;
        const name = entry['name'];
        const description = entry['description'];
        if (typeof name !== 'string' || name === '' || typeof description !== 'string')
            return null;
        entries.push({ name, description });
    }
    // An empty list is a real catalog: a replacement with no entries retires
    // every earlier name. Only an unreadable shape falls back.
    return entries;
}
/**
 * `catalog` form: the published entries as a list, read from the source rather
 * than re-parsed out of the model-facing prose.
 *
 * A catalog whose source carries no usable entries falls through to the opaque
 * body, so an older or hand-edited log still shows its text.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The catalog context body, or the opaque body when the entry list is
 * unreadable.
 */
function CatalogBody({ content, source, t }) {
    const entries = catalogEntries(source);
    if (entries === null)
        return (0, jsx_runtime_1.jsx)(OpaqueBody, { content: content, source: source, t: t });
    const update = asRecord(source)?.['update'] === true;
    // Entry count is unbounded (a provider may publish any number of skills), and
    // the scrollport bounds height, not node count — so the list bounds itself.
    const shown = entries.slice(0, MAX_ENTRIES);
    const rest = unknownBlocks(content);
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [update && (0, jsx_runtime_1.jsx)("p", { className: ContextBody_styles_1.default.catalogNotice, "data-context-catalog-update": true, children: t('message.context.catalog.replaced') }), (0, jsx_runtime_1.jsx)("ul", { className: ContextBody_styles_1.default.entries, "data-context-entries": true, children: shown.map((entry, index) => (
                // Index key: a hand-edited or foreign log may repeat a name, and a
                // duplicate React key would drop a row the model did see.
                (0, jsx_runtime_1.jsxs)("li", { className: ContextBody_styles_1.default.entry, children: [(0, jsx_runtime_1.jsx)("code", { className: ContextBody_styles_1.default.entryName, children: entry.name }), (0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.entryDescription, children: entry.description })] }, index))) }), shown.length < entries.length && ((0, jsx_runtime_1.jsx)("p", { className: ContextBody_styles_1.default.catalogNotice, "data-context-entries-truncated": true, children: t('message.context.catalog.more', { count: entries.length - shown.length }) })), (0, jsx_runtime_1.jsx)(UnknownBlocks, { blocks: rest, t: t })] }));
}
/** Snapshot sections read off the source, or null when the record is unusable. */
function snapshotSections(source) {
    const record = asRecord(source);
    const list = record === null ? undefined : record['sections'];
    if (!(0, wire_guards_1.isUnknownArray)(list))
        return null;
    const sections = [];
    for (const item of list) {
        const section = asRecord(item);
        if (section === null)
            return null;
        const name = section['name'];
        const text = section['text'];
        if (typeof name !== 'string' || name === '' || typeof text !== 'string')
            return null;
        sections.push({ name, text });
    }
    return sections.length === 0 ? null : sections;
}
/**
 * `snapshot` form: the named contributions this snapshot assembled, in order.
 *
 * The sections are the same bytes the model read, split at the boundaries the
 * producer assembled them on, so a reader sees which subsystem contributed
 * which state instead of one undifferentiated wall.
 *
 * One sentence of the model-facing text is NOT in any section: the producer's
 * framing line declaring that this snapshot supersedes earlier ones. Unlike the
 * `<system-reminder>` wrapper an instruction context carries — which wraps
 * content and cannot be separated from it — that line states the form's own
 * semantics, so the body states them as a caption instead of reprinting the
 * joined prose beside the sections it was split from.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The snapshot context body, or the opaque body when unreadable.
 */
function SnapshotBody({ content, source, t }) {
    const sections = snapshotSections(source);
    /* v8 ignore next -- contextBody reads the sections before choosing this body. */
    if (sections === null)
        return (0, jsx_runtime_1.jsx)(OpaqueBody, { content: content, source: source, t: t });
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("p", { className: ContextBody_styles_1.default.catalogNotice, "data-context-snapshot-supersedes": true, children: t('message.context.snapshot.supersedes') }), (0, jsx_runtime_1.jsx)("dl", { className: ContextBody_styles_1.default.sections, "data-context-sections": true, children: sections.map((section, index) => ((0, jsx_runtime_1.jsxs)("div", { className: ContextBody_styles_1.default.section, children: [(0, jsx_runtime_1.jsx)("dt", { className: ContextBody_styles_1.default.sectionName, children: section.name }), (0, jsx_runtime_1.jsx)("dd", { className: ContextBody_styles_1.default.sectionText, children: boundedText(section.text, t) })] }, index))) })] }));
}
/**
 * `notice` form: what just happened, with the model-facing text beneath it.
 *
 * The one-line account also rides the collapsed row ({@link contextBody}), so a
 * notice is usually readable without expanding at all.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The notice context body.
 */
function NoticeBody({ content, t }) {
    return (0, jsx_runtime_1.jsx)(ModelFacingContent, { content: content, t: t });
}
/**
 * `relay` form: which agent sent this, then what it said.
 *
 * The sender is an opaque session id; it is shown as a field rather than a
 * label, because this client cannot resolve it to a title.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The relay context body.
 */
function RelayBody({ content, source, t }) {
    const sender = relaySender(source);
    /* v8 ignore next -- contextBody resolves the sender before choosing this body. */
    if (sender === null)
        return (0, jsx_runtime_1.jsx)(OpaqueBody, { content: content, source: source, t: t });
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("p", { className: ContextBody_styles_1.default.relaySender, "data-context-relay-sender": true, children: t('message.context.relay.from', { session: sender }) }), (0, jsx_runtime_1.jsx)(ModelFacingContent, { content: content, t: t })] }));
}
/** The sending agent's session id, or null when the record does not name one. */
function relaySender(source) {
    const sender = asRecord(source)?.['senderSessionId'];
    return typeof sender === 'string' && sender !== '' ? sender : null;
}
/** Recalled sessions read off the source, or null when the record is unusable. */
function recalledSessions(source) {
    const record = asRecord(source);
    const list = record === null ? undefined : record['references'];
    if (!(0, wire_guards_1.isUnknownArray)(list))
        return null;
    const sessions = [];
    for (const item of list) {
        const reference = asRecord(item);
        if (reference === null)
            return null;
        const label = reference['label'];
        const retained = reference['retainedMessages'];
        const omitted = reference['omittedMessages'];
        const truncated = reference['truncated'];
        // Completeness is the fact this card exists to report, so a reference that
        // cannot state it is not a readable recall — showing the label alone would
        // present a confident card over unknown loss.
        if (typeof label !== 'string' || label === ''
            || typeof retained !== 'number' || typeof omitted !== 'number'
            || typeof truncated !== 'boolean')
            return null;
        sessions.push({ label, retained, omitted, truncated });
    }
    return sessions.length === 0 ? null : sessions;
}
/**
 * `recall` form: which sessions this material came from and how much of each
 * survived the read, then the material itself.
 *
 * Completeness is the fact a reader needs first: recalled context is bounded on
 * the way in, so a card that hid the omitted count would overstate what the
 * model received.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The recall context body, or the opaque body when unreadable.
 */
function RecallBody({ content, source, t }) {
    const sessions = recalledSessions(source);
    if (sessions === null)
        return (0, jsx_runtime_1.jsx)(OpaqueBody, { content: content, source: source, t: t });
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("ul", { className: ContextBody_styles_1.default.recalls, "data-context-recalls": true, children: sessions.map((session, index) => ((0, jsx_runtime_1.jsxs)("li", { className: ContextBody_styles_1.default.recall, children: [(0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.recallLabel, children: session.label }), (0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.recallCounts, children: t('message.context.recall.counts', {
                                retained: session.retained,
                                omitted: session.omitted,
                            }) }), session.truncated && ((0, jsx_runtime_1.jsx)("span", { className: ContextBody_styles_1.default.recallCounts, children: t('message.context.recall.truncated') }))] }, index))) }), (0, jsx_runtime_1.jsx)(ModelFacingContent, { content: content, t: t })] }));
}
/** The one-line account a `notice` puts on its collapsed row, when it records one. */
function noticeSummary(source) {
    const summary = asRecord(source)?.['summary'];
    return typeof summary === 'string' && summary !== '' ? summary : null;
}
/**
 * Choose the body for one context node.
 *
 * Returns the form the body actually rendered as, which is not always the
 * declared one: a declared form whose fields are unreadable falls back to
 * opaque, and the caller labels the row with what it really shows.
 * `summary` is the collapsed row's one-line account, which only a `notice`
 * records: its whole point is being readable without expanding.
 * @param form - the producer-declared form projected onto the node.
 * @param props - durable content, its source, and the locale seat.
 * @returns the rendered form (null for opaque), its collapsed summary, and its body.
 */
function contextBody(form, props) {
    const opaque = { rendered: null, summary: null, body: (0, jsx_runtime_1.jsx)(OpaqueBody, { ...props }) };
    switch (form) {
        case 'instructions':
            return instructionChanges(props.source) === null
                ? opaque
                : { rendered: 'instructions', summary: null, body: (0, jsx_runtime_1.jsx)(InstructionsBody, { ...props }) };
        case 'catalog':
            return catalogEntries(props.source) === null
                ? opaque
                : { rendered: 'catalog', summary: null, body: (0, jsx_runtime_1.jsx)(CatalogBody, { ...props }) };
        case 'snapshot':
            return snapshotSections(props.source) === null
                ? opaque
                : { rendered: 'snapshot', summary: null, body: (0, jsx_runtime_1.jsx)(SnapshotBody, { ...props }) };
        case 'notice': {
            const summary = noticeSummary(props.source);
            return summary === null
                ? opaque
                : { rendered: 'notice', summary, body: (0, jsx_runtime_1.jsx)(NoticeBody, { ...props }) };
        }
        case 'relay':
            return relaySender(props.source) === null
                ? opaque
                : { rendered: 'relay', summary: null, body: (0, jsx_runtime_1.jsx)(RelayBody, { ...props }) };
        case 'recall':
            return recalledSessions(props.source) === null
                ? opaque
                : { rendered: 'recall', summary: null, body: (0, jsx_runtime_1.jsx)(RecallBody, { ...props }) };
        case null:
            return opaque;
        /* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
        KnownContextForm here rather than letting it degrade to opaque silently. */
        default: {
            const unreachable = form;
            throw new Error(`unreachable context form: ${String(unreachable)}`);
        }
    }
}

},
"src/modules/conversation/chat/ContextBody.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextBody.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ContextBody_css_1 = __importDefault(require("./ContextBody.css"));
exports.default = {
    "catalogNotice": "KbBcQa_catalogNotice",
    "entries": "KbBcQa_entries",
    "entry": "KbBcQa_entry",
    "entryDescription": "KbBcQa_entryDescription",
    "entryName": "KbBcQa_entryName",
    "field": "KbBcQa_field",
    "fieldKey": "KbBcQa_fieldKey",
    "fieldValue": "KbBcQa_fieldValue",
    "fields": "KbBcQa_fields",
    "file": "KbBcQa_file",
    "fileAction": "KbBcQa_fileAction",
    "filePath": "KbBcQa_filePath",
    "files": "KbBcQa_files",
    "recall": "KbBcQa_recall",
    "recallCounts": "KbBcQa_recallCounts",
    "recallLabel": "KbBcQa_recallLabel",
    "recalls": "KbBcQa_recalls",
    "relaySender": "KbBcQa_relaySender",
    "section": "KbBcQa_section",
    "sectionName": "KbBcQa_sectionName",
    "sectionText": "KbBcQa_sectionText",
    "sections": "KbBcQa_sections",
    "text": "KbBcQa_text"
};
const tagId = '@xharness/dsh-client-ui-conversation/ContextBody.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ContextBody_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/ContextBody.css": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextBody.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".KbBcQa_text{color:var(--dsw-alias-label-secondary);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.KbBcQa_fields{border-top:1px solid var(--dsw-alias-line-secondary);flex-direction:column;gap:2px;margin:8px 0 0;padding-top:8px;display:flex}.KbBcQa_field{gap:8px;min-width:0;display:flex}.KbBcQa_fieldKey{min-width:96px;color:var(--dsw-alias-label-caption);flex:none}.KbBcQa_fieldValue{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;flex:auto;margin:0}.KbBcQa_files{flex-wrap:wrap;gap:4px 12px;margin:0 0 8px;padding:0;list-style:none;display:flex}.KbBcQa_file{align-items:baseline;gap:6px;min-width:0;display:flex}.KbBcQa_filePath{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.KbBcQa_fileAction{color:var(--dsw-alias-label-caption)}.KbBcQa_catalogNotice{color:var(--dsw-alias-label-caption);margin:0 0 6px}.KbBcQa_entries{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.KbBcQa_entry{gap:8px;min-width:0;display:flex}.KbBcQa_entryName{color:var(--dsw-alias-label-secondary);flex:none}.KbBcQa_entryDescription{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.KbBcQa_sections{flex-direction:column;gap:8px;margin:0;display:flex}.KbBcQa_section{flex-direction:column;gap:2px;min-width:0;display:flex}.KbBcQa_sectionName{color:var(--dsw-alias-label-caption)}.KbBcQa_sectionText{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.KbBcQa_relaySender{color:var(--dsw-alias-label-caption);overflow-wrap:anywhere;margin:0 0 6px}.KbBcQa_recalls{flex-direction:column;gap:2px;margin:0 0 8px;padding:0;list-style:none;display:flex}.KbBcQa_recall{gap:8px;min-width:0;display:flex}.KbBcQa_recallLabel{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.KbBcQa_recallCounts{color:var(--dsw-alias-label-caption);flex:none}";

},
"src/modules/conversation/chat/ContextInjectionRow.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextInjectionRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ContextInjectionRow_css_1 = __importDefault(require("./ContextInjectionRow.css"));
exports.default = {
    "body": "y2WvVq_body",
    "chevron": "y2WvVq_chevron",
    "root": "y2WvVq_root",
    "sep": "y2WvVq_sep",
    "source": "y2WvVq_source",
    "summary": "y2WvVq_summary"
};
const tagId = '@xharness/dsh-client-ui-conversation/ContextInjectionRow.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ContextInjectionRow_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/ContextInjectionRow.css": function(module, exports, require) {
// source: src/modules/conversation/chat/ContextInjectionRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".y2WvVq_root{min-width:0}.y2WvVq_root[data-open]{padding-bottom:4px}.y2WvVq_chevron{color:var(--dsw-alias-label-secondary)}.y2WvVq_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.y2WvVq_source{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:14px;line-height:24px;overflow:hidden}.y2WvVq_summary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}.y2WvVq_body{box-sizing:border-box;background:var(--dsw-alias-markdown-code-block);width:calc(100% - 22px);max-height:141px;color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);border:none;border-radius:8px;margin:4px 0 0 22px;padding:10px 16px 12px 12px;overflow:auto}";

},
"src/modules/conversation/chat/MessageIconActions.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageIconActions.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageIconActions = MessageIconActions;
const jsx_runtime_1 = require("react/jsx-runtime");
// Shared IconActions chrome for user and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const message_chrome_1 = require("./message-chrome");
const use_calendar_day_1 = require("./use-calendar-day");
const MessageIconActions_styles_1 = __importDefault(require("./MessageIconActions.styles"));
/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The actions row element.
 */
function MessageIconActions({ text, time, runMs, ttftMs, tokensPerSecond, clock, onBranch, branchUnavailable = false, className, extraActions, t, }) {
    const day = (0, use_calendar_day_1.useCalendarDay)();
    const reasonId = (0, react_1.useId)();
    // Same success chrome as CodeBlock: a short check swap after the write,
    // gated so re-clicks during the window neither re-copy nor stack timers.
    const [copied, setCopied] = (0, react_1.useState)(false);
    const copyPending = (0, react_1.useRef)(false);
    const copyTimer = (0, react_1.useRef)(null);
    const copyEpoch = (0, react_1.useRef)(0);
    (0, react_1.useEffect)(() => () => {
        copyEpoch.current += 1;
        copyPending.current = false;
        if (copyTimer.current !== null)
            clearTimeout(copyTimer.current);
    }, []);
    const onCopy = (0, react_1.useCallback)(() => {
        if (copied || copyPending.current)
            return;
        const epoch = copyEpoch.current;
        copyPending.current = true;
        void (0, primitives_1.writeClipboard)(text).then((ok) => {
            if (epoch !== copyEpoch.current)
                return;
            copyPending.current = false;
            if (!ok)
                return;
            setCopied(true);
            copyTimer.current = window.setTimeout(() => {
                copyTimer.current = null;
                setCopied(false);
            }, 1000);
        });
    }, [copied, text]);
    // The dot is decorative and stays hidden, but its margins separate the
    // readings only on screen: without the flanking spaces a reader hears one
    // run-on string ("Ran for 13sTTFT 0.2s12 tok/s") instead of three facts.
    const clockEl = time === undefined ? null : ((0, jsx_runtime_1.jsxs)("span", { className: clock === 'start' ? MessageIconActions_styles_1.default.timeStart : MessageIconActions_styles_1.default.timeEnd, children: [(0, message_chrome_1.formatMessageClock)(time, t, day), runMs !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [' ', (0, jsx_runtime_1.jsx)("span", { className: MessageIconActions_styles_1.default.runTimeDot, "aria-hidden": true, children: "\u00B7" }), ' ', t('message.ranFor', { duration: (0, message_chrome_1.formatRunDuration)(runMs, t) })] })), ttftMs !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [' ', (0, jsx_runtime_1.jsx)("span", { className: MessageIconActions_styles_1.default.runTimeDot, "aria-hidden": true, children: "\u00B7" }), ' ', t('message.ttft', { seconds: (0, message_chrome_1.formatLatencySeconds)(ttftMs) })] })), tokensPerSecond !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [' ', (0, jsx_runtime_1.jsx)("span", { className: MessageIconActions_styles_1.default.runTimeDot, "aria-hidden": true, children: "\u00B7" }), ' ', t('message.tokensPerSecond', { tps: (0, message_chrome_1.formatTokensPerSecond)(tokensPerSecond) })] }))] }));
    return ((0, jsx_runtime_1.jsxs)("div", { className: className === undefined ? MessageIconActions_styles_1.default.actions : `${MessageIconActions_styles_1.default.actions} ${className}`, children: [clock === 'start' ? clockEl : null, (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: copied ? t('copied') : t('copy'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageIconActions_styles_1.default.action, "aria-label": copied ? t('copied') : t('copy'), onClick: onCopy, children: copied ? (0, jsx_runtime_1.jsx)(primitives_1.IconCheckOutline16, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconCopyOutline16, {}) }) }), extraActions, onBranch !== undefined && ((0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: branchUnavailable ? t('message.branchUnavailable') : t('message.branch'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageIconActions_styles_1.default.action, "aria-label": t('message.branch'), "aria-disabled": branchUnavailable || undefined, "aria-describedby": branchUnavailable ? reasonId : undefined, "data-unavailable": branchUnavailable || undefined, onClick: branchUnavailable ? undefined : onBranch, children: (0, jsx_runtime_1.jsx)(primitives_1.IconBranchOutline16, {}) }) })), onBranch !== undefined && branchUnavailable && ((0, jsx_runtime_1.jsx)("span", { id: reasonId, className: MessageIconActions_styles_1.default.visuallyHidden, children: t('message.branchUnavailable') })), clock === 'end' ? clockEl : null] }));
}

},
"src/modules/conversation/chat/use-calendar-day.js": function(module, exports, require) {
// source: src/modules/conversation/chat/use-calendar-day.ts

"use strict";
// Component-local calendar-day tick: memoized message rows keep stable props
// across midnight, so the IconActions clock needs a local day seat that
// re-fires at the next local midnight without reaching for framework hooks.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCalendarDay = useCalendarDay;
const react_1 = require("react");
const message_chrome_1 = require("./message-chrome");
/**
 * Local calendar-day epoch that advances at each local midnight.
 * @returns Midnight ms for the current local day; updates after the boundary.
 */
function useCalendarDay() {
    const [day, setDay] = (0, react_1.useState)(() => (0, message_chrome_1.startOfLocalDay)(Date.now()));
    (0, react_1.useEffect)(() => {
        let timer;
        const arm = () => {
            const now = Date.now();
            setDay((0, message_chrome_1.startOfLocalDay)(now));
            timer = setTimeout(arm, (0, message_chrome_1.msUntilNextLocalMidnight)(now));
        };
        timer = setTimeout(arm, (0, message_chrome_1.msUntilNextLocalMidnight)(Date.now()));
        return () => { clearTimeout(timer); };
    }, []);
    return day;
}

},
"src/modules/conversation/chat/MessageIconActions.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageIconActions.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MessageIconActions_css_1 = __importDefault(require("./MessageIconActions.css"));
exports.default = {
    "action": "AEC1ra_action",
    "actions": "AEC1ra_actions",
    "runTimeDot": "AEC1ra_runTimeDot",
    "timeEnd": "AEC1ra_timeEnd",
    "timeStart": "AEC1ra_timeStart",
    "visuallyHidden": "AEC1ra_visuallyHidden"
};
const tagId = '@xharness/dsh-client-ui-conversation/MessageIconActions.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = MessageIconActions_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/MessageIconActions.css": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageIconActions.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".AEC1ra_actions{align-items:center;gap:10px;height:28px;display:flex}.AEC1ra_timeStart{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px;font-size:14px;line-height:24px}.AEC1ra_timeEnd{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-left:12px;font-size:14px;line-height:24px}.AEC1ra_runTimeDot{margin:0 10px}@media (hover:hover){[data-time-hover-root] :is(.AEC1ra_timeStart,.AEC1ra_timeEnd){opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover :is(.AEC1ra_timeStart,.AEC1ra_timeEnd),[data-time-hover-root]:focus-within :is(.AEC1ra_timeStart,.AEC1ra_timeEnd){opacity:1}}.AEC1ra_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}.AEC1ra_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.AEC1ra_action[data-unavailable]{cursor:default;opacity:.4}.AEC1ra_action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}.AEC1ra_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";

},
"src/modules/conversation/edit/MessageEditActions.js": function(module, exports, require) {
// source: src/modules/conversation/edit/MessageEditActions.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageEditActions = MessageEditActions;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../primitives");
const MessageIconActions_styles_1 = __importDefault(require("../chat/MessageIconActions.styles"));
function MessageEditActions({ content, seq, editMessage, forkMessage, t }) {
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('message.edit'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageIconActions_styles_1.default.action, "data-message-edit": "", "aria-label": t('message.edit'), onClick: () => { void editMessage(content); }, children: "\u270E" }) }), (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('message.editFork'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageIconActions_styles_1.default.action, "data-message-edit-fork": "", "aria-label": t('message.editFork'), onClick: () => { void forkMessage(seq, content); }, children: "\u2442" }) })] });
}

},
"src/modules/conversation/chat/ChatNodeSeat.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ChatNodeSeat.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatNodeSeat = exports.TurnProcessSummarySeat = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const chat_node_codec_1 = require("../contract/chat-node-codec");
const react_1 = require("react");
const primitives_1 = require("../primitives");
const ChatView_styles_1 = __importDefault(require("./ChatView.styles"));
const TranscriptWindowRow_1 = require("./TranscriptWindowRow");
const turn_process_1 = require("./turn-process");
const TurnTailNodeView_1 = require("./TurnTailNodeView");
const adaptive_tool_fold_1 = require("./adaptive-tool-fold");
const process_mode_1 = require("./process-mode");
/** Resident, independently subscribed entry before the first loaded work row. */
exports.TurnProcessSummarySeat = (0, react_1.memo)(function TurnProcessSummarySeat({ nodeKey, useSession, expandedTurns, foldedTools, toggleTurnProcess, t }) {
    const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey));
    const location = node?.location;
    const turnId = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined;
    const currentTurn = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId));
    const rawTail = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId)?.data.get('turn-tail'));
    const tail = (0, react_1.useMemo)(() => (0, chat_node_codec_1.isChatData)('turn-tail', rawTail) && rawTail.turn === turnId ? rawTail : undefined, [rawTail, turnId]);
    const foldedCount = useSession(snapshot => {
        let count = 0;
        for (const key of foldedTools?.get(turnId ?? -1) ?? []) {
            const tool = snapshot.chat.nodes.get(key);
            if ((0, chat_node_codec_1.isChatNode)(tool) && (0, adaptive_tool_fold_1.toolCanAutoFold)(tool))
                count++;
        }
        return count;
    });
    if (currentTurn === undefined || toggleTurnProcess === undefined)
        return null;
    if (tail === undefined && (currentTurn.status !== 'open' || foldedCount === 0))
        return null;
    return (0, jsx_runtime_1.jsx)(TranscriptWindowRow_1.TranscriptWindowRow, { estimatedHeight: 32, className: ChatView_styles_1.default.flowItem, "data-chat-anchor-key": `turn-process:${currentTurn.turn}`, "data-chat-anchor-seq": currentTurn.start?.seq ?? node?.anchorSeq, children: tail === undefined ? (0, jsx_runtime_1.jsx)(TurnTailNodeView_1.AdaptiveToolSummary, { turn: currentTurn.turn, count: foldedCount, t: t, expanded: expandedTurns?.has(currentTurn.turn) ?? false, onToggle: () => { toggleTurnProcess(currentTurn.turn); } })
            : (0, jsx_runtime_1.jsx)(TurnTailNodeView_1.TurnProcessSummary, { turn: currentTurn, data: tail, t: t, collapsed: !(expandedTurns?.has(currentTurn.turn) ?? false), onToggle: () => { toggleTurnProcess(currentTurn.turn); } }) });
});
/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
exports.ChatNodeSeat = (0, react_1.memo)(function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, keepMounted, renderMessageImages, fileMentions, useSession, renderSlot, t, expandedTurns, foldedTools, invalidateFoldedTool, }) {
    const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey));
    const routedNode = (0, chat_node_codec_1.isChatNode)(node) ? node : undefined;
    const location = node?.location;
    const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined;
    const rawTail = useSession(snapshot => turn === undefined ? undefined : snapshot.chat.timeline.turns.get(turn)?.data.get('turn-tail'));
    const tail = (0, react_1.useMemo)(() => (0, chat_node_codec_1.isChatData)('turn-tail', rawTail) && rawTail.turn === turn ? rawTail : undefined, [rawTail, turn]);
    const presentation = routedNode === undefined ? { collapsed: false, hidden: false }
        : (0, turn_process_1.turnProcessPresentation)(routedNode, tail, expandedTurns?.has(turn ?? -1) ?? false);
    // This seat, not its heavy/windowed child, owns display choices. Whole-turn
    // folding must not erase Think/Tool/Compaction/native-details expansion.
    const [presentationState] = (0, react_1.useState)(() => new Map());
    const processMode = (0, process_mode_1.useProcessMode)();
    const previousMode = (0, react_1.useRef)(processMode);
    // Lightweight seats remain resident even when their heavy child is folded.
    // Reset defaults on an explicit mode switch, including currently unmounted
    // cards; otherwise expanded -> auto -> expanded can revive a stale choice.
    if (previousMode.current !== processMode) {
        presentationState.clear();
        previousMode.current = processMode;
    }
    const owner = (0, react_1.useMemo)(() => node === undefined
        ? null
        : {
            selectedCallId,
            cwd,
            openFile,
            inspectCall,
            forkAt,
            editMessage, forkMessage, editAvailable,
            renderMessageImages,
            fileMentions,
            processCollapsed: presentation.collapsed,
        }, [
        node, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, renderMessageImages, fileMentions, presentation.collapsed,
    ]);
    const autoFoldable = routedNode !== undefined && (0, adaptive_tool_fold_1.toolCanAutoFold)(routedNode);
    (0, react_1.useLayoutEffect)(() => {
        if (!autoFoldable)
            invalidateFoldedTool?.(nodeKey);
    }, [autoFoldable, invalidateFoldedTool, nodeKey]);
    const liveTurn = (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open' && tail === undefined;
    const autoHidden = liveTurn && autoFoldable && foldedTools?.get(turn ?? -1)?.has(nodeKey)
        && !(expandedTurns?.has(turn ?? -1) ?? false);
    if (node === undefined || owner === null || presentation.hidden || autoHidden)
        return null;
    // Runtime dispatch owns the correlation: every Node's discriminant is the
    // keyed-slot entry passed alongside that same Node. TypeScript does not
    // distribute an object containing a union into a union of objects itself.
    const routedOwner = routedNode === undefined ? undefined : ownerFor(owner, routedNode);
    return ((0, jsx_runtime_1.jsx)(TranscriptWindowRow_1.TranscriptWindowRow, { keepMounted: keepMounted ?? false, presentationState: presentationState, className: ChatView_styles_1.default.flowItem, "data-chat-anchor-key": node.key, "data-chat-anchor-seq": node.anchorSeq, "data-chat-flow-key": node.key, "data-chat-flow-kind": node.kind, "data-chat-auto-fold-turn": node.kind === 'tool-call' &&
            (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open' && tail === undefined ? turn : undefined, "data-chat-auto-fold-eligible": autoFoldable ? 'true' : 'false', children: routedOwner === undefined ? (0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownSurface', { type: node.kind }), payload: node.data, truncatedLabel: (total) => t('json.truncated', { total }) }) : renderSlot('conversation.chat.node', routedOwner, {
            entryKey: routedOwner.node.kind,
            hookContext: nodeKey,
            fallback: ((0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownSurface', { type: node.kind }), payload: node.data, truncatedLabel: (total) => t('json.truncated', { total }) })),
        }) }));
});
function ownerFor(owner, node) {
    switch (node.kind) {
        case 'user': return { ...owner, node };
        case 'steering': return { ...owner, node };
        case 'context': return { ...owner, node };
        case 'command': return { ...owner, node };
        case 'compaction': return { ...owner, node };
        case 'manual-compaction': return { ...owner, node };
        case 'assistant-step': return { ...owner, node };
        case 'tool-call': return { ...owner, node };
        case 'model-retry': return { ...owner, node };
        case 'turn-error': return { ...owner, node };
        case 'turn-max-tokens': return { ...owner, node };
        case 'unknown': return { ...owner, node };
        case 'run-checkpoint': return { ...owner, node };
        case 'turn-tail': return { ...owner, node };
    }
}

},
"src/modules/conversation/chat/ChatView.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ChatView.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ChatView_css_1 = __importDefault(require("./ChatView.css"));
exports.default = {
    "callRow": "IxU-fW_callRow",
    "column": "IxU-fW_column",
    "flowItem": "IxU-fW_flowItem",
    "hint": "IxU-fW_hint",
    "modalAction": "IxU-fW_modalAction",
    "older": "IxU-fW_older",
    "openError": "IxU-fW_openError",
    "root": "IxU-fW_root",
    "scroll": "IxU-fW_scroll",
    "toBottom": "IxU-fW_toBottom",
    "toBottomSlot": "IxU-fW_toBottomSlot",
    "turnStatus": "IxU-fW_turnStatus",
    "turnStatusClock": "IxU-fW_turnStatusClock"
};
const tagId = '@xharness/dsh-client-ui-conversation/ChatView.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ChatView_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/ChatView.css": function(module, exports, require) {
// source: src/modules/conversation/chat/ChatView.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".IxU-fW_root{flex-direction:column;flex:auto;min-height:0;display:flex;position:relative}.IxU-fW_scroll{min-height:0;padding:16px calc(var(--dsh-composer-side-clearance) + 16px);flex:auto;overflow-y:auto}[data-conversation-scroll] .IxU-fW_root{flex:none;height:auto;min-height:auto}[data-conversation-scroll] .IxU-fW_scroll{flex:none;min-height:auto;overflow:visible}.IxU-fW_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}.IxU-fW_flowItem{min-width:0}.IxU-fW_flowItem:empty{display:none}.IxU-fW_callRow{border-radius:6px}.IxU-fW_turnStatus{height:26px;white-space:nowrap;flex:none;align-self:flex-start;align-items:center;display:inline-flex}.IxU-fW_turnStatusClock{font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);margin-left:8px;font-weight:400}.IxU-fW_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.IxU-fW_openError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.IxU-fW_older{justify-content:center;display:flex}.IxU-fW_older button{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid);cursor:pointer;border:none;border-radius:14px;padding:4px 12px;font-size:12px}.IxU-fW_older button:disabled{cursor:default;opacity:.6}.IxU-fW_toBottomSlot{z-index:8;height:0;padding-right:max(0px, calc((100% - var(--dsh-chat-content-width)) / 2));pointer-events:none;justify-content:flex-end;display:flex;position:sticky;bottom:16px}[data-conversation-scroll] .IxU-fW_toBottomSlot{bottom:calc(var(--dsh-composer-height,152px) + 16px)}.IxU-fW_toBottom{border:1px solid var(--dsw-alias-border-l2);width:34px;height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-shadow-lv2);cursor:pointer;pointer-events:auto;border-radius:100px;justify-content:center;align-items:center;margin-top:-34px;padding:0;display:flex}.IxU-fW_toBottom:hover{background:var(--dsw-alias-button-floating-hover)}.IxU-fW_modalAction{min-width:72px}";

},
"src/modules/conversation/chat/TranscriptWindowRow.js": function(module, exports, require) {
// source: src/modules/conversation/chat/TranscriptWindowRow.tsx

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
exports.bindTranscriptFollow = bindTranscriptFollow;
exports.TranscriptWindowRow = TranscriptWindowRow;
exports.createTranscriptWindowing = createTranscriptWindowing;
const jsx_runtime_1 = require("react/jsx-runtime");
const React = __importStar(require("react"));
const react_dom_1 = require("react-dom");
const transcript_state_1 = require("./transcript-state");
const roots = new WeakMap();
const followOwners = new WeakMap();
/** ChatView owns reader intent; measuring rows must not infer it a second time. */
function bindTranscriptFollow(root, owner) {
    followOwners.set(root, owner);
    return () => {
        if (followOwners.get(root) === owner)
            followOwners.delete(root);
    };
}
/** Product-owned bounded transcript DOM. Heavy children are mounted near the viewport only. */
function controller(root) {
    const previous = roots.get(root);
    if (previous)
        return previous;
    const rows = new Map();
    let frame = 0, width = root.clientWidth, height = root.clientHeight;
    let intersection;
    let anchor = null;
    let following = false;
    const viewportTop = () => root.getBoundingClientRect().top;
    function remember() {
        following = followOwners.get(root)?.current ?? (root.scrollHeight - root.scrollTop - root.clientHeight <= 25);
        const top = viewportTop();
        anchor = null;
        for (const row of rows.values()) {
            if (!row.near && !row.mounted)
                continue;
            const rect = row.element.getBoundingClientRect();
            if (rect.bottom > top && rect.top < top + root.clientHeight && (!anchor || rect.top < anchor.top + top)) {
                anchor = { element: row.element, top: rect.top - top };
            }
        }
    }
    function compensate() {
        // Only an explicitly supported native 'auto' anchor can compensate for
        // us. WebKit may omit this property altogether; omission is not support.
        if (getComputedStyle(root).overflowAnchor !== 'auto') {
            // Read the live ref here too: upward intent may arrive after remember(),
            // before ResizeObserver. Geometry alone must not take ownership back.
            if (followOwners.get(root)?.current ?? following)
                root.scrollTop = root.scrollHeight;
            else if (anchor?.element.isConnected && rows.has(anchor.element)) {
                root.scrollTop += anchor.element.getBoundingClientRect().top - viewportTop() - anchor.top;
            }
        }
        remember();
    }
    const measure = new ResizeObserver(entries => {
        for (const entry of entries) {
            const row = rows.get(entry.target);
            if (!row?.mounted)
                continue;
            const measured = entry.target.getBoundingClientRect().height;
            if (Number.isFinite(measured) && measured >= 0)
                row.height = measured;
        }
        compensate();
    });
    function schedule() {
        if (frame)
            return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            const changes = [];
            for (const row of rows.values()) {
                const show = row.near || row.focused || row.selected || row.keep;
                if (show === row.mounted)
                    continue;
                changes.push({ row, mounted: show });
            }
            if (changes.length === 0)
                return;
            // This is a bounded viewport transaction, not a full-history render.
            // Do not publish controller state before its DOM exists: concurrent
            // React can otherwise leave a resize queued beyond a settled frame.
            // GTK WebKit then applies the first native wheel against the old range;
            // a later placeholder shrink clamps that gesture back to the new floor.
            (0, react_dom_1.flushSync)(() => {
                for (const { row, mounted } of changes) {
                    row.mounted = mounted;
                    row.update({ mounted, height: row.height });
                }
            });
        });
    }
    function observe() {
        intersection?.disconnect();
        intersection = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const row = rows.get(entry.target);
                if (row)
                    row.near = entry.isIntersecting;
            }
            if (!anchor)
                remember();
            schedule();
        }, { root, rootMargin: `${Math.max(1, root.clientHeight)}px 0px` });
        for (const element of rows.keys())
            intersection.observe(element);
    }
    const rootObserver = new ResizeObserver(() => {
        const nextWidth = root.clientWidth, nextHeight = root.clientHeight;
        if (nextWidth === width && nextHeight === height)
            return;
        width = nextWidth;
        height = nextHeight;
        // Offscreen heights stay estimates after reflow. Never materialize the full history.
        observe();
        compensate();
    });
    rootObserver.observe(root);
    observe();
    function selectionChanged() {
        const selection = document.getSelection();
        const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
        for (const row of rows.values())
            row.selected = !!(range && row.mounted && range.intersectsNode(row.element));
        schedule();
    }
    root.addEventListener('scroll', remember, { passive: true });
    document.addEventListener('selectionchange', selectionChanged);
    const result = {
        add(element, update, keep, estimate) {
            const row = { element, update, keep, focused: false, selected: false, near: false, mounted: keep, height: estimate };
            rows.set(element, row);
            measure.observe(element);
            intersection.observe(element);
            if (rows.size === 1)
                remember();
            return {
                keep(value) { row.keep = value; schedule(); },
                focus(value) { row.focused = value; schedule(); },
                remove() {
                    rows.delete(element);
                    measure.unobserve(element);
                    intersection.unobserve(element);
                    if (rows.size)
                        return;
                    if (frame)
                        cancelAnimationFrame(frame);
                    root.removeEventListener('scroll', remember);
                    document.removeEventListener('selectionchange', selectionChanged);
                    rootObserver.disconnect();
                    intersection.disconnect();
                    measure.disconnect();
                    roots.delete(root);
                },
            };
        },
    };
    roots.set(root, result);
    return result;
}
function detailKey(node, index) {
    return node.getAttribute('data-transcript-state-key') || node.id || `${index}:${node.querySelector('summary')?.textContent?.slice(0, 120) ?? ''}`;
}
function TranscriptWindowRow({ children, keepMounted = false, estimatedHeight = 240, presentationState, ...attributes }) {
    const element = React.useRef(null), binding = React.useRef(null);
    // The keyed Node seat may outlive a folded/unmounted WindowRow. Use its
    // lightweight state when provided; standalone window rows retain their own.
    const [values] = React.useState(() => presentationState ?? new Map());
    const estimate = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 240;
    const [view, setView] = React.useState({ mounted: keepMounted, height: estimate });
    React.useLayoutEffect(() => {
        const node = element.current, root = node?.closest('[data-conversation-scroll]');
        if (!node || !root || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
            setView(value => ({ ...value, mounted: true }));
            return;
        }
        const handle = controller(root).add(node, setView, keepMounted, estimate);
        binding.current = handle;
        return () => { handle.remove(); binding.current = null; };
    }, []);
    React.useLayoutEffect(() => { binding.current?.keep(keepMounted); }, [keepMounted]);
    React.useLayoutEffect(() => {
        if (!view.mounted)
            return;
        element.current?.querySelectorAll('details').forEach((node, index) => {
            const restored = values.get('native-details:' + detailKey(node, index));
            if (typeof restored === 'boolean')
                node.open = restored;
        });
    }, [view.mounted]);
    const focusedControl = () => {
        const active = document.activeElement;
        // Buttons and native disclosures also own keyboard focus. Keep only the
        // current focused row, not every previously interacted row.
        return !!(active && active !== document.body && element.current?.contains(active));
    };
    const onToggle = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLDetailsElement))
            return;
        const nodes = [...element.current?.querySelectorAll('details') ?? []];
        const index = nodes.indexOf(target);
        if (index >= 0)
            values.set('native-details:' + detailKey(target, index), target.open);
    };
    return (0, jsx_runtime_1.jsx)("div", { ...attributes, ref: element, "data-transcript-mounted": view.mounted ? 'true' : 'false', onFocusCapture: event => { attributes.onFocusCapture?.(event); binding.current?.focus(focusedControl()); }, onBlurCapture: event => { attributes.onBlurCapture?.(event); queueMicrotask(() => binding.current?.focus(focusedControl())); }, onToggleCapture: (event) => { attributes.onToggleCapture?.(event); onToggle(event); }, style: view.mounted ? attributes.style : { ...attributes.style, display: 'block', height: view.height, boxSizing: 'border-box' }, children: view.mounted ? (0, jsx_runtime_1.jsx)(transcript_state_1.transcriptState.Context.Provider, { value: values, children: children }) : null });
}
/** Module-loader namespace wrappers share one React createElement identity. */
function createTranscriptWindowing(react) {
    (0, transcript_state_1.transcriptStateFor)(react);
    return TranscriptWindowRow;
}

},
"src/modules/conversation/chat/turn-process.js": function(module, exports, require) {
// source: src/modules/conversation/chat/turn-process.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnProcessPresentation = turnProcessPresentation;
const adaptive_tool_fold_1 = require("./adaptive-tool-fold");
/** Only an authoritative turn/end tail closes the process; idle/step/end do not. */
function turnProcessPresentation(node, tail, expanded) {
    const collapsed = tail !== undefined && !expanded;
    if (!collapsed)
        return { collapsed: false, hidden: false };
    switch (node.kind) {
        case 'assistant-step':
            return { collapsed, hidden: tail.closing === null || node.data.finalNode?.seq !== tail.closing.finalNode.seq };
        case 'tool-call':
            // A returned error is finished work, not an active call. Keep recursive
            // pending/unknown outcomes visible even if a stale turn/end is present.
            // Composer approvals/questions and turn failures have their own seats.
            if (node.data.root !== undefined && !(0, adaptive_tool_fold_1.toolCanFoldAfterTurn)(node))
                return { collapsed, hidden: false };
            return { collapsed, hidden: true };
        case 'model-retry':
        case 'context':
        case 'compaction':
            return { collapsed, hidden: true };
        // Never suppress user instructions, terminal notices or unknown extensions.
        default:
            return { collapsed, hidden: false };
    }
}

},
"src/modules/conversation/chat/TurnTailNodeView.js": function(module, exports, require) {
// source: src/modules/conversation/chat/TurnTailNodeView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnTailNodeView = void 0;
exports.TurnProcessSummary = TurnProcessSummary;
exports.AdaptiveToolSummary = AdaptiveToolSummary;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const MessageIconActions_1 = require("./MessageIconActions");
const turn_assistant_1 = require("./turn-assistant");
const TurnTailNodeView_styles_1 = __importDefault(require("./TurnTailNodeView.styles"));
const primitives_1 = require("../primitives");
const message_chrome_1 = require("./message-chrome");
/** Visible independently of hover, final prose, or contributed tail slots. */
function TurnProcessSummary({ turn, data, t, collapsed, onToggle }) {
    const runMs = turn.start === undefined || turn.end === undefined ? undefined : Math.max(0, turn.end.time - turn.start.time);
    const label = runMs === undefined ? t('message.turnFinished') : t('message.ranFor', { duration: (0, message_chrome_1.formatRunDuration)(runMs, t) });
    return (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TurnTailNodeView_styles_1.default.summary, "data-turn-process-summary": data.turn, "aria-expanded": !collapsed, "aria-label": `${label} · ${t(collapsed ? 'message.expandProcess' : 'message.collapseProcess')}`, onClick: onToggle, children: [(0, jsx_runtime_1.jsx)("span", { children: label }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, {})] });
}
/** Active work folds only settled successful roots; pending/error rows stay outside. */
function AdaptiveToolSummary({ turn, count, t, expanded, onToggle }) {
    return (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TurnTailNodeView_styles_1.default.summary, "data-live-tool-summary": turn, "aria-expanded": expanded, "aria-label": t(expanded ? 'message.collapseProcess' : 'message.expandProcess'), onClick: onToggle, children: [(0, jsx_runtime_1.jsx)("span", { children: t(expanded ? 'message.expandedTools' : 'message.foldedTools', { count }) }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, {})] });
}
/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
exports.TurnTailNodeView = (0, react_1.memo)(function TurnTailNodeView({ node, openFile, forkAt, renderSlot, renderSlotChain, t, useSession, }) {
    const data = node.data;
    const hasLaterChatNode = useSession(snapshot => snapshot.chat.locations.getTurn(data.turn).at(-1) !== node.key);
    const turn = node.location.kind === 'turn' || node.location.kind === 'step'
        ? node.location.turn
        : undefined;
    if (turn === undefined)
        return null;
    const closing = data.closing;
    const owner = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile };
    const tail = renderSlotChain('conversation.chat.turnTail', owner);
    if (closing === null)
        return tail === null ? null : (0, jsx_runtime_1.jsx)("div", { className: TurnTailNodeView_styles_1.default.root, children: tail });
    // Interruption-frozen partials carry no messageId, so they address no
    // durable message and contribute no per-message actions.
    const messageId = closing.finalNode.messageId;
    const assistantActions = messageId === undefined
        ? null
        : renderSlot('conversation.chat.assistant-actions', { messageId });
    return ((0, jsx_runtime_1.jsxs)("div", { className: TurnTailNodeView_styles_1.default.root, "data-turn-tail": data.turn, "data-time-hover-root": true, children: [tail, (0, jsx_runtime_1.jsx)(MessageIconActions_1.MessageIconActions, { text: (0, turn_assistant_1.assistantText)(closing.blocks), time: closing.time, ttftMs: data.ttftMs, tokensPerSecond: data.tokensPerSecond, clock: "end", onBranch: () => { forkAt(data.seq); }, branchUnavailable: data.branchUnavailable || hasLaterChatNode, className: TurnTailNodeView_styles_1.default.actions, extraActions: assistantActions, t: t })] }));
});

},
"src/modules/conversation/chat/turn-assistant.js": function(module, exports, require) {
// source: src/modules/conversation/chat/turn-assistant.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assistantText = assistantText;
/**
 * Collect visible prose from one Assistant lifecycle.
 * @param blocks - Assistant content blocks.
 * @returns concatenated text blocks.
 */
function assistantText(blocks) {
    return blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('');
}

},
"src/modules/conversation/chat/TurnTailNodeView.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/TurnTailNodeView.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const TurnTailNodeView_css_1 = __importDefault(require("./TurnTailNodeView.css"));
exports.default = {
    "actions": "Aov_lG_actions",
    "summary": "Aov_lG_summary",
    "root": "Aov_lG_root"
};
const tagId = '@xharness/dsh-client-ui-conversation/TurnTailNodeView.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = TurnTailNodeView_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/TurnTailNodeView.css": function(module, exports, require) {
// source: src/modules/conversation/chat/TurnTailNodeView.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Aov_lG_root{flex-direction:column;gap:16px;display:flex}.Aov_lG_actions{margin-left:-6px}\n.Aov_lG_summary{display:flex;align-items:center;gap:8px;max-width:100%;background:none;border:0;padding:4px 0;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:24px;text-align:left;cursor:pointer}.Aov_lG_summary:hover{color:var(--dsw-alias-label-secondary)}.Aov_lG_summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px;border-radius:4px}.Aov_lG_summary[aria-expanded=true] svg{transform:rotate(90deg)}\n";

},
"src/modules/conversation/chat/message-preview.js": function(module, exports, require) {
// source: src/modules/conversation/chat/message-preview.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageMarkerCache = void 0;
exports.messagePreview = messagePreview;
const runtime_types_1 = require("../../shared/runtime-types");
const PREVIEW_LENGTH = 80;
const WHITESPACE = /\s/;
/** Keep navigation chrome independent of unrelated assistant/tool deltas.
 * Content arrays are immutable publications; weak keys never pin old histories.
 * Only the current bounded previews and ordered marker list remain resident.
 */
class MessageMarkerCache {
    constructor() {
        this.markers = [];
        this.previews = new WeakMap();
    }
    read(order, contentOf) {
        let changed;
        let index = 0;
        for (const key of order) {
            const content = contentOf(key);
            if (content === undefined)
                continue;
            let preview = this.previews.get(content);
            if (preview === undefined) {
                preview = messagePreview(content);
                this.previews.set(content, preview);
            }
            const old = this.markers[index];
            const marker = old?.key === key && old.preview === preview ? old : { key, preview };
            if (changed === undefined && marker !== old)
                changed = this.markers.slice(0, index);
            changed?.push(marker);
            index++;
        }
        if (changed !== undefined)
            this.markers = changed;
        else if (index !== this.markers.length)
            this.markers = this.markers.slice(0, index);
        return this.markers;
    }
}
exports.MessageMarkerCache = MessageMarkerCache;
/** Navigation-only text, equivalent to joining text blocks with a space,
 * collapsing whitespace, trimming, then slicing the first 80 UTF-16 units.
 * Build a small independent string instead of normalizing the entire message
 * and retaining its backing storage through a short substring. */
function messagePreview(content) {
    const chars = [];
    let pendingSpace = false;
    for (const block of content) {
        if (!(0, runtime_types_1.isObjectRecord)(block) || block.type !== 'text' || typeof block.text !== 'string')
            continue;
        // A join separator is whitespace even when this text block is empty.
        if (chars.length > 0)
            pendingSpace = true;
        const text = block.text;
        for (let index = 0; index < text.length; index++) {
            const char = text.charAt(index);
            if (WHITESPACE.test(char)) {
                if (chars.length > 0)
                    pendingSpace = true;
                continue;
            }
            // Delay whitespace until another visible unit: trailing whitespace must
            // be trimmed before slicing, but a separator at unit 80 is preserved.
            if (pendingSpace) {
                chars.push(' ');
                pendingSpace = false;
                if (chars.length === PREVIEW_LENGTH)
                    return chars.join('');
            }
            chars.push(char);
            if (chars.length === PREVIEW_LENGTH)
                return chars.join('');
        }
    }
    return chars.join('');
}

},
"src/modules/conversation/chat/MessageRail.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageRail.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRail = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const primitives_1 = require("../primitives");
const MessageRail_styles_1 = __importDefault(require("./MessageRail.styles"));
/** The navigation rail changes only with messages, reader position or locale. */
exports.MessageRail = (0, react_1.memo)(function MessageRail({ markers, active, select, t }) {
    return (0, jsx_runtime_1.jsx)("nav", { className: MessageRail_styles_1.default.root, "aria-label": t('chat.messageRail'), children: markers.map((marker, index) => {
            const label = marker.preview === ''
                ? t('chat.messageRail.message', { n: index + 1 })
                : `${t('chat.messageRail.message', { n: index + 1 })}: ${marker.preview}`;
            return (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: label, side: "right", delayMs: 300, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: MessageRail_styles_1.default.item, "data-message-key": marker.key, "aria-label": label, "aria-current": active === marker.key ? 'location' : undefined, onClick: () => { select(marker.key); }, children: (0, jsx_runtime_1.jsx)("span", { className: MessageRail_styles_1.default.mark, "aria-hidden": "true" }) }) }, marker.key);
        }) });
});

},
"src/modules/conversation/chat/MessageRail.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageRail.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const MessageRail_css_1 = __importDefault(require("./MessageRail.css"));
const foundation_styles_1 = require("../../shared/foundation-styles");
(0, foundation_styles_1.installStyles)('@xharness/dsh-client-ui-conversation/MessageRail.css', '@xharness/dsh-client-ui-conversation', MessageRail_css_1.default);
const styles = {
    root: 'xh-message-rail',
    item: 'xh-message-rail-item',
    mark: 'xh-message-rail-mark',
};
exports.default = styles;

},
"src/modules/conversation/chat/MessageRail.css": function(module, exports, require) {
// source: src/modules/conversation/chat/MessageRail.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "[data-conversation-root] { position: relative; }\n.xh-message-rail {\n  position: absolute;\n  z-index: 6;\n  top: 50%;\n  left: 8px;\n  transform: translateY(-50%);\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  width: 24px;\n  max-height: min(70%, 480px);\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  scrollbar-width: none;\n}\n/* AppFrame owns docked/drawer workspace state; hiding this navigation never\n   changes the loaded history, scroll owner or panel state. */\n[data-xhworkspace-open] .xh-message-rail { display: none; }\n.xh-message-rail::-webkit-scrollbar { display: none; }\n.xh-message-rail-item {\n  display: flex;\n  flex: none;\n  align-items: center;\n  justify-content: center;\n  width: 24px;\n  height: 17px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  cursor: pointer;\n}\n.xh-message-rail-mark {\n  width: 10px;\n  height: 2px;\n  border-radius: 2px;\n  background: var(--dsw-alias-label-dimmed);\n}\n.xh-message-rail-item:hover .xh-message-rail-mark,\n.xh-message-rail-item:focus-visible .xh-message-rail-mark,\n.xh-message-rail-item[aria-current=\"location\"] .xh-message-rail-mark {\n  background: var(--dsw-alias-label-primary);\n}\n.xh-message-rail-item:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; border-radius: 4px; }\n";

},
"src/modules/shared/foundation-styles.js": function(module, exports, require) {
// source: src/modules/shared/foundation-styles.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installStyles = installStyles;
/** Runs at ModuleLoader factory materialization, never during script registration. */
function installStyles(tagId, plugin, css) {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = plugin;
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/history-page-intent.js": function(module, exports, require) {
// source: src/modules/conversation/chat/history-page-intent.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryPageIntent = void 0;
/** UI admission only. Session remains the owner of pagination, errors and data.
 * One upward reader intent can admit one page; arrivals/reflow never arm it. */
class HistoryPageIntent {
    constructor() {
        this.armed = false;
        this.pending = false;
    }
    arm() { if (!this.pending)
        this.armed = true; }
    cancel() { this.armed = false; }
    shouldLoad(state) {
        if (!state.ready || !state.hasMore || state.loading || state.following || this.pending) {
            this.cancel();
            return false;
        }
        return this.armed && state.head !== null && Number.isFinite(state.top)
            && Number.isFinite(state.viewport) && state.viewport > 0
            && state.top <= Math.min(240, state.viewport / 2);
    }
    /** Shared by automatic and explicit requests: lock before the RPC/React tick. */
    begin() {
        if (this.pending)
            return false;
        this.pending = true;
        this.cancel();
        return true;
    }
    /** No automatic draining after success, error, no-op or a delayed receipt. */
    end() { this.pending = false; this.cancel(); }
}
exports.HistoryPageIntent = HistoryPageIntent;

},
"src/modules/conversation/chat/LoadingIndicator.js": function(module, exports, require) {
// source: src/modules/conversation/chat/LoadingIndicator.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoadingIndicator = LoadingIndicator;
const jsx_runtime_1 = require("react/jsx-runtime");
/*!
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
// Visual behavior adapted from ZCode ChatLoading (Apache-2.0).
// Loader glyph: Lucide/Feather (ISC/MIT); see docs/licenses/lucide-loader.txt.
const LoadingIndicator_styles_1 = __importDefault(require("./LoadingIndicator.styles"));
/** Presentation only: the caller owns the authoritative activity state. */
function LoadingIndicator({ active, label }) {
    if (!active)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { className: LoadingIndicator_styles_1.default.root, role: "status", "aria-live": "polite", "aria-label": label, "data-xh-loading-indicator": "true", children: (0, jsx_runtime_1.jsx)("div", { className: LoadingIndicator_styles_1.default.rotor, "data-xh-loading-rotor": "true", children: (0, jsx_runtime_1.jsxs)("svg", { className: LoadingIndicator_styles_1.default.icon, width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", children: [(0, jsx_runtime_1.jsx)("path", { d: "M12 2v4" }), (0, jsx_runtime_1.jsx)("path", { d: "m16.2 7.8 2.9-2.9" }), (0, jsx_runtime_1.jsx)("path", { d: "M18 12h4" }), (0, jsx_runtime_1.jsx)("path", { d: "m16.2 16.2 2.9 2.9" }), (0, jsx_runtime_1.jsx)("path", { d: "M12 18v4" }), (0, jsx_runtime_1.jsx)("path", { d: "m4.9 19.1 2.9-2.9" }), (0, jsx_runtime_1.jsx)("path", { d: "M2 12h4" }), (0, jsx_runtime_1.jsx)("path", { d: "m4.9 4.9 2.9 2.9" })] }) }) }));
}

},
"src/modules/conversation/chat/LoadingIndicator.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/LoadingIndicator.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const LoadingIndicator_css_1 = __importDefault(require("./LoadingIndicator.css"));
exports.default = { root: 'xhLoading_root', rotor: 'xhLoading_rotor', icon: 'xhLoading_icon' };
const tagId = '@xharness/dsh-client-ui-conversation/LoadingIndicator.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = LoadingIndicator_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/LoadingIndicator.css": function(module, exports, require) {
// source: src/modules/conversation/chat/LoadingIndicator.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhLoading_root {\n  display: flex;\n  align-items: center;\n  min-height: 20px;\n  color: var(--dsw-alias-label-tertiary);\n  animation: xhLoading_enter var(--xh-duration-stream-in, 900ms) var(--xh-ease-stream, cubic-bezier(.16, 1, .3, 1)) both;\n}\n.xhLoading_rotor {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex: 0 0 16px;\n  width: 16px;\n  height: 16px;\n  transform-origin: center;\n  animation: xhLoading_spin 1s linear infinite;\n}\n.xhLoading_icon { display: block; flex: none; width: 16px; height: 16px; }\n@keyframes xhLoading_spin { to { transform: rotate(360deg); } }\n@keyframes xhLoading_enter { from { opacity: 0; } to { opacity: 1; } }\n@media (prefers-reduced-motion: reduce) {\n  .xhLoading_root, .xhLoading_rotor { animation: none; }\n}\n";

},
"src/modules/conversation/chat/scroll-memory.js": function(module, exports, require) {
// source: src/modules/conversation/chat/scroll-memory.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatScrollMemory = void 0;
/** Session-local reader memory and explicit local submit intent. No wire event
 * can request following; a hidden view only clears its stale reader bookmark. */
class ChatScrollMemory {
    constructor(onPosition) {
        this.onPosition = onPosition;
        this.positions = new Map();
        this.listeners = new Map();
        this.disposed = false;
    }
    publish(sessionId, position) {
        if (this.disposed)
            return;
        try {
            this.onPosition?.(sessionId, position);
        }
        catch (error) {
            console.error('[conversation] reading target listener failed:', error);
        }
    }
    forSession(sessionId) {
        // Slot injection may run in a discarded concurrent render. Only committed
        // position saves and explicit follow intents may publish a runtime hint.
        return {
            read: () => this.positions.get(sessionId) ?? null,
            save: position => {
                if (this.disposed)
                    return;
                if (position === null)
                    this.positions.delete(sessionId);
                else
                    this.positions.set(sessionId, position);
                this.publish(sessionId, position);
            },
            subscribeFollow: listener => {
                if (this.disposed)
                    return () => { };
                const listeners = this.listeners.get(sessionId) ?? new Set();
                listeners.add(listener);
                this.listeners.set(sessionId, listeners);
                return () => {
                    listeners.delete(listener);
                    if (listeners.size === 0 && this.listeners.get(sessionId) === listeners)
                        this.listeners.delete(sessionId);
                };
            },
        };
    }
    /** Called synchronously at local prompt dispatch, never on a delayed receipt. */
    requestFollow(sessionId) {
        if (this.disposed)
            return;
        this.positions.delete(sessionId);
        this.publish(sessionId, null);
        const listeners = this.listeners.get(sessionId);
        for (const listener of [...listeners ?? []]) {
            if (!listeners?.has(listener))
                continue;
            // Presentation failure must not change whether a user's prompt is sent.
            try {
                listener();
            }
            catch (error) {
                console.error('[conversation] scroll intent listener failed:', error);
            }
        }
    }
    dispose() {
        this.disposed = true;
        for (const listeners of this.listeners.values())
            listeners.clear();
        this.listeners.clear();
        this.positions.clear();
    }
}
exports.ChatScrollMemory = ChatScrollMemory;

},
"src/modules/conversation/skeleton/ApprovalPanel.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ApprovalPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandOf = commandOf;
exports.ApprovalPanel = ApprovalPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
// ApprovalPanel: the composer-takeover approval prompt (designer draft
// approval.png), registered as a selector-routed entry of the
// conversation-declared composer chain. While an approval question is
// pending, this panel occupies the composer slot in place of the InputBar:
// an amber "Waiting for approval" strip on the card top, the model's
// justification as the headline, the paired command in muted code text, and
// a right-aligned refuse/allow action row. Justification and command are
// unbounded model text, so they scroll inside the card at the shared composer
// cap (`data-approval-scroll`) and the action row stays outside it — the
// buttons must be reachable no matter how long the command is.
// One-shot: the buttons disable
// after a click and the panel leaves (the InputBar returns) on the broadcast
// resolved frame.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const slots_1 = require("../contract/slots");
const tool_node_reader_1 = require("../chat/tool-node-reader");
const ApprovalPanel_styles_1 = __importDefault(require("./ApprovalPanel.styles"));
/** Extract the shell command from an approval's paired running call (bash-family args carry `command`); undefined hides the line. */
function commandOf(call) {
    if (call === undefined)
        return undefined;
    try {
        const args = JSON.parse(call.argsRaw);
        if (args === null || typeof args !== 'object' || !('command' in args))
            return undefined;
        return typeof args.command === 'string' ? args.command : undefined;
    }
    catch {
        // Unparseable model args: the panel still renders, just without the command line.
        return undefined;
    }
}
/**
 * Composer takeover boundary: mints the domain face on the carrier's stable
 * identity and remounts the flow per request key, so the one-shot answered
 * latch never leaks to the next pending approval.
 * @param props - the selector-matched pending approval carrier plus the framework standard kit.
 * @returns The approval prompt for this request.
 */
function ApprovalPanel(props) {
    const approval = (0, react_1.useMemo)(() => new slots_1.PendingApproval(props.matched), [props.matched]);
    const command = props.useSession((snapshot) => {
        if (approval.callId === undefined)
            return undefined;
        const root = (0, tool_node_reader_1.rootToolCall)(snapshot, approval.callId);
        if (root === undefined)
            return undefined;
        return root.callId === approval.callId && !('kind' in root) ? commandOf(root) : undefined;
    });
    return (0, jsx_runtime_1.jsx)(ApprovalFlow, { pending: approval, t: props.t, ...command === undefined ? {} : { command } }, approval.key);
}
function ApprovalFlow({ pending, command, t }) {
    // Local one-shot latch: the panel leaves only when the resolved frame
    // lands; until then the buttons must not re-fire. An answer failure
    // (rejected receipt / transport) re-arms them for retry.
    const [answered, setAnswered] = (0, react_1.useState)(false);
    const answer = (outcome) => {
        setAnswered(true);
        void pending.answer(outcome).catch(() => { setAnswered(false); });
    };
    return ((0, jsx_runtime_1.jsx)("div", { className: ApprovalPanel_styles_1.default.root, "data-approval-key": pending.key, children: (0, jsx_runtime_1.jsxs)("div", { className: ApprovalPanel_styles_1.default.card, children: [(0, jsx_runtime_1.jsxs)("div", { className: ApprovalPanel_styles_1.default.strip, children: [(0, jsx_runtime_1.jsx)("span", { className: ApprovalPanel_styles_1.default.dot }), t(pending.reviewing ? 'approval.reviewing' : 'approval.waiting')] }), (0, jsx_runtime_1.jsxs)("div", { className: ApprovalPanel_styles_1.default.body, "data-approval-scroll": "", tabIndex: 0, role: "group", "aria-label": t('approval.detail.aria'), children: [(0, jsx_runtime_1.jsx)("div", { className: ApprovalPanel_styles_1.default.headline, children: pending.reason ?? t('approval.escalation', { toolName: pending.toolName }) }), command !== undefined && (0, jsx_runtime_1.jsx)("div", { className: ApprovalPanel_styles_1.default.command, children: command })] }), (0, jsx_runtime_1.jsxs)("div", { className: ApprovalPanel_styles_1.default.actionRow, children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", className: ApprovalPanel_styles_1.default.reject, disabled: answered, onClick: () => { answer('rejected'); }, children: t('approval.reject') }), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "primary", disabled: answered || pending.reviewing, onClick: () => { answer('allowed-once'); }, children: t('approval.allowOnce') })] })] }) }));
}

},
"src/modules/conversation/contract/slots.js": function(module, exports, require) {
// source: src/modules/conversation/contract/slots.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingApproval = void 0;
/**
 * Approval domain face over the carrier (the ui-user-questions PendingQuestion
 * pattern): render identity and question material forwarded transparently;
 * answer owns the wire encoding — the ApprovalResponsePayload value shape
 * with the audit correlation the host reconciles — and turns a rejected
 * carrier receipt into a thrown error. Minted per carrier via useMemo.
 */
class PendingApproval {
    /**
     * @param wait - the runtime carrier for one pending approval question.
     */
    constructor(wait) {
        this.wait = wait;
    }
    /** Opaque render identity (React key / one-shot latch remount axis), forwarded from the carrier. */
    get key() {
        return this.wait.key;
    }
    /** The tool the question is about (headline fallback), forwarded from the carrier payload. */
    get toolName() {
        return this.wait.payload.toolName;
    }
    /** The asker's human-readable WHY (headline when present), forwarded from the carrier payload. */
    get reason() {
        return this.wait.payload.reason;
    }
    /** AI review is transient; failures return this same carrier to manual approval. */
    get reviewing() { return this.wait.payload.reviewing === true; }
    /** The paired tool call's id when the ask names one (command-line lookup key), forwarded from the carrier payload. */
    get callId() {
        return this.wait.payload.callId;
    }
    /**
     * Deliver the user's decision; a rejected carrier receipt throws. Panel
     * removal stays frame-driven: the broadcast `approval/resolved` settles the
     * wait and drops it from the pending list.
     * @param outcome - the only two client-answerable outcomes.
     */
    async answer(outcome) {
        const receipt = await this.wait.respond({
            ok: true,
            value: { sessionId: this.wait.sessionId, approvalId: this.wait.payload.approvalId, outcome },
        });
        if (!receipt.accepted) {
            throw new Error(`approval response rejected: ${receipt.reason}`);
        }
    }
}
exports.PendingApproval = PendingApproval;

},
"src/modules/conversation/chat/tool-node-reader.js": function(module, exports, require) {
// source: src/modules/conversation/chat/tool-node-reader.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rootToolCall = rootToolCall;
exports.findToolCall = findToolCall;
const chat_node_codec_1 = require("../contract/chat-node-codec");
const runtime_values_1 = require("../runtime-values");
function toolNode(node) {
    return (0, chat_node_codec_1.isChatNode)(node) && node.kind === 'tool-call' ? node : undefined;
}
/**
 * Read one root Tool lifecycle through the internal Chat Node index.
 * @param snapshot - current Conversation snapshot.
 * @param rootCallId - root call identity and Tool Context identity.
 * @returns root lifecycle when it is materialized in the current window.
 */
function rootToolCall(snapshot, rootCallId) {
    return toolNode(snapshot.chat.nodes.get((0, runtime_values_1.conversationContextKey)('tool-call', rootCallId)))?.data.root;
}
/**
 * Find any root or nested Tool lifecycle through the internal Node store.
 * @param snapshot - current Conversation snapshot.
 * @param callId - root or nested call identity.
 * @returns current Tool lifecycle when materialized in the loaded window.
 */
function findToolCall(snapshot, callId) {
    const visit = (block) => {
        if (block.callId === callId)
            return block;
        for (const child of block.subCalls) {
            const found = visit(child);
            if (found !== undefined)
                return found;
        }
        return undefined;
    };
    for (const node of snapshot.chat.nodes.values()) {
        const root = toolNode(node)?.data.root;
        if (root === undefined)
            continue;
        const found = visit(root);
        if (found !== undefined)
            return found;
    }
    return undefined;
}

},
"src/modules/conversation/skeleton/ApprovalPanel.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ApprovalPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ApprovalPanel_css_1 = __importDefault(require("./ApprovalPanel.css"));
exports.default = {
    "actionRow": "rQ88rq_actionRow",
    "body": "rQ88rq_body",
    "card": "rQ88rq_card",
    "command": "rQ88rq_command",
    "dot": "rQ88rq_dot",
    "headline": "rQ88rq_headline",
    "reject": "rQ88rq_reject",
    "root": "rQ88rq_root",
    "strip": "rQ88rq_strip"
};
const tagId = '@xharness/dsh-client-ui-conversation/ApprovalPanel.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ApprovalPanel_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/ApprovalPanel.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ApprovalPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".rQ88rq_root{padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px;flex-direction:column;align-items:center;display:flex}.rQ88rq_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;overflow:hidden}.rQ88rq_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}.rQ88rq_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}.rQ88rq_body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height);flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow-y:auto}.rQ88rq_headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}.rQ88rq_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);word-break:break-all;font-size:13px;line-height:20px}.rQ88rq_actionRow{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex}.rQ88rq_reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:#0000}";

},
"src/modules/conversation/skeleton/TodoPanel.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/TodoPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.todoDockEntry = void 0;
exports.TodoPanel = TodoPanel;
exports.TodoDock = TodoDock;
const jsx_runtime_1 = require("react/jsx-runtime");
// TodoPanel: plan strip above the composer (the web counterpart of the TUI
// plan panel). Renders the standing todo/write whole-list snapshot (cleared on
// the next turn/start) — no data of its own, hidden while the list is empty.
// Mounted through the 'conversation.input.dock' slot (QueueDock posture): the
// dock adapter does the selecting, so the panel takes the plain list and stays
// framework-free. Visual: figma 772:51905 / 772:52972 / 772:53419.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const locales_1 = require("../locales");
const TodoPanel_styles_1 = __importDefault(require("./TodoPanel.styles"));
/** Local exhaustiveness helper — client packages do not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if status is forged */
function assertNever(value) {
    throw new Error(`unreachable todo status: ${String(value)}`);
}
/** Status glyphs share the figma 14×14 artboard; the 16×16 `.glyph` cell centers them. */
function CompletedGlyph() {
    return ((0, jsx_runtime_1.jsxs)("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true", className: TodoPanel_styles_1.default.glyphCompleted, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: "currentColor", strokeWidth: "1.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z", fill: "currentColor" })] }));
}
/** In-progress: business-blue ring fading out; CSS spins the svg. */
function ProgressGlyph() {
    const gradientId = (0, react_1.useId)();
    return ((0, jsx_runtime_1.jsxs)("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true", className: TodoPanel_styles_1.default.glyphProgress, children: [(0, jsx_runtime_1.jsx)("defs", { children: (0, jsx_runtime_1.jsxs)("linearGradient", { id: gradientId, x1: "2.5", y1: "12", x2: "10.5", y2: "3.5", gradientUnits: "userSpaceOnUse", children: [(0, jsx_runtime_1.jsx)("stop", { stopColor: "currentColor" }), (0, jsx_runtime_1.jsx)("stop", { offset: "1", stopColor: "currentColor", stopOpacity: "0" })] }) }), (0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: `url(#${gradientId})`, strokeWidth: "1.2" })] }));
}
/** Pending: dashed unstarted ring (figma dash 2.4 2.4). */
function PendingGlyph() {
    return ((0, jsx_runtime_1.jsx)("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true", className: TodoPanel_styles_1.default.glyphPending, children: (0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: "currentColor", strokeWidth: "1.2", strokeDasharray: "2.4 2.4" }) }));
}
function StatusGlyph({ status }) {
    switch (status) {
        case 'completed': return (0, jsx_runtime_1.jsx)(CompletedGlyph, {});
        case 'in_progress': return (0, jsx_runtime_1.jsx)(ProgressGlyph, {});
        case 'pending': return (0, jsx_runtime_1.jsx)(PendingGlyph, {});
        /* v8 ignore next -- closed TodoItem status union */
        default: return assertNever(status);
    }
}
/** Compact completed/total summary; item states remain in the ordered list. */
function progressLabel(todos) {
    const done = todos.filter(item => item.status === 'completed').length;
    return `${done}/${todos.length}`;
}
function TodoPanel({ todos, t }) {
    const [collapsed, setCollapsed] = (0, react_1.useState)(false);
    if (todos.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsx)("section", { className: TodoPanel_styles_1.default.root, "data-testid": "todo-panel", "aria-label": t('todo.title'), children: (0, jsx_runtime_1.jsxs)("div", { className: TodoPanel_styles_1.default.body, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: TodoPanel_styles_1.default.header, "aria-expanded": !collapsed, onClick: () => { setCollapsed(v => !v); }, children: [(0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.lead, "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChecklistOutline14, {}) }), (0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.title, children: t('todo.title') }), (0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.progress, children: progressLabel(todos) }), (0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.chevron, "aria-hidden": true, children: collapsed ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronUpOutline14, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) })] }), !collapsed && ((0, jsx_runtime_1.jsx)("ul", { className: TodoPanel_styles_1.default.list, children: todos.map(item => ((0, jsx_runtime_1.jsxs)("li", { className: TodoPanel_styles_1.default.item, "data-status": item.status, children: [(0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.glyph, "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(StatusGlyph, { status: item.status }) }), (0, jsx_runtime_1.jsx)("span", { className: TodoPanel_styles_1.default.content, children: item.content })] }, item.content))) }))] }) }));
}
/** Dock adapter: reads the host-computed 'todos' projection (whole list; absent or null renders nothing). */
function TodoDock({ useProjection, t }) {
    const todos = useProjection('todos');
    return (0, jsx_runtime_1.jsx)(TodoPanel, { todos: todos ?? [], t: t });
}
/**
 * The plan strip as a plain registrant plugin (QueueDock posture), following
 * the input-dock declaration across independent activation and reload.
 */
exports.todoDockEntry = {
    name: 'conversation-todo-dock',
    inject: ['slots'],
    /**
     * Register the plan strip before the goal and queue entries (order 0).
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'todo', order: 0, locale: locales_1.NS }, TodoDock));
    },
};

},
"src/modules/conversation/locales.js": function(module, exports, require) {
// source: src/modules/conversation/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.NS = void 0;
/** Current product dictionaries, including recoverable editing and attachment intake. */
const PLAN_NEXT_ACTION_ZH = "描述你的任务以生成计划";
const PLAN_NEXT_ACTION_EN = "describe your task to generate plan";
exports.NS = 'conversation';
exports.en = {
    "tool.arguments.generating": "Generating tool input",
    "tool.arguments.received": "{size} received",
    "tool.arguments.elapsed": "{seconds}s",
    "tool.arguments.notExecuted": "The model is still generating input. The tool has not executed yet.",
    "tool.arguments.preview": "Input preview",
    "tool.arguments.raw": "Raw JSON",
    "tool.arguments.showPreview": "Show preview",
    "tool.arguments.showRaw": "Show raw JSON",
    "tool.arguments.waiting": "Waiting for input…",
    "tool.arguments.truncated": "Preview limited to {count} characters. The actual tool input is not truncated.",
    "view.chat": "Chat",
    "xh.turn.working": "Working…",
    "hint.plan": PLAN_NEXT_ACTION_EN,
    "hint.goal": "describe the objective for a long-running task",
    "hint.goal.active": "goal active — edit / pause / resume / clear",
    "placeholder.plan": PLAN_NEXT_ACTION_EN,
    "placeholder.default": "Message the agent",
    "placeholder.unavailable": "Session unavailable",
    "placeholder.parentOffline": "Parent session offline; sending is unavailable but you can still stop the run",
    "placeholder.hero": "Describe what you want to build",
    "placeholder.workspace": "Choose a workspace to start",
    "input.commands": "Commands",
    "input.add": "Add attachments or commands",
    "input.attachFiles": "Add images or files",
    "input.stop": "Stop generating",
    "input.send": "Send message",
    "placeholder.steerQueue": "Cmd/Ctrl+Enter steers all queued messages",
    "input.accessMode": "Access mode, current: {name}",
    "image.dropTitle": "Drag images here to add them",
    "image.dropDesc": "Up to {count} images, {size} each",
    "image.dropBlocked": "Images cannot be added right now",
    "image.pending": "Pending images",
    "image.openOriginal": "View original",
    "image.openOriginalLabel": "{label}, click to view original",
    "image.remove": "Remove image {name}",
    "image.scrollLeft": "Scroll images left",
    "image.scrollRight": "Scroll images right",
    "image.original": "Original image",
    "image.label": "Image",
    "image.loadFailed": "Image failed to load; click to retry",
    "image.loading": "Loading image…",
    "image.preview": "Original image preview",
    "image.closePreview": "Close original image preview",
    "image.serviceUnavailable": "Image loading service unavailable",
    "image.unsupportedType": "Only PNG, JPG, WebP, and GIF images are supported",
    "image.tooMany": "A message can include up to {count} images",
    "image.fileTooLarge": "Each image must be smaller than {size}",
    "image.totalTooLarge": "Images exceed {size} in total; remove some and try again",
    "image.tooManyPixels": "Image resolution is too high; compress it and try again",
    "image.dimensionTooLarge": "Image sides must be at most {size}px; downscale it and try again",
    "image.modelUnsupported": "The current model does not support images; switch to a model that does",
    "image.subagentUnsupported": "Subagent sessions do not support images yet",
    "image.sendFailed": "Sending images failed ({reason}); re-add them and try again",
    "context.aria": "{percent} of context used",
    "context.pending": "Calculating context usage",
    "context.unavailable": "Context usage unavailable",
    "context.used": "of context used",
    "context.system": "System prompt",
    "context.tools": "Tools",
    "context.messages": "Messages", "context.user": "User", "context.assistant": "Assistant", "context.toolResults": "Tool results", "context.mcp": "MCP tools", "context.protocol": "Protocol overhead", "context.distributionEstimate": "Category shares are estimated",
    "context.yourMessages": "Your messages", "context.agentReports": "Agent reports", "context.runtimeContext": "Runtime context", "context.checkpoints": "Checkpoints", "context.unattributed": "Unattributed context", "context.userRoleHistory": "User-role history (source unknown)",
    "stats.title": "Conversation statistics",
    "stats.counts": "{turns} turns · {steps} steps",
    "stats.llm": "LLM {duration}",
    "stats.toolCall": "Tool call {duration}",
    "stats.ttftAverage": "TTFT avg {duration}",
    "stats.tokensPerSecond": "{throughput} tok/s",
    "stats.cacheHit": "Cache hit {percent}%",
    "stats.tokens": "Input {input} tok · Output {output} tok",
    "settings.enter.title": "Enter behavior while busy",
    "settings.enter.description": "Busy only; Cmd/Ctrl+Enter uses the other behavior",
    "settings.enter.queue": "Queue",
    "settings.enter.steer": "Steer",
    "access.confirm.title": "Enable Full access?",
    "access.confirm.description": "Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.",
    "access.confirm.acknowledge": "I understand the risks and want to continue",
    "access.confirm.cancel": "Cancel",
    "access.confirm.enable": "Enable Full access",
    "hero.headline": "The Language of a New Era",
    "hero.preview": "Preview",
    "hero.chooseWorkspace": "Choose workspace",
    "session.hierarchy": "Session hierarchy",
    "details.title": "Details",
    "details.close": "Close details",
    "details.empty": "Click a tool row in the message flow to view its details",
    "details.notInWindow": "This call is outside the current window",
    "details.input": "Input",
    "details.output": "Output",
    "details.running": "Running…",
    "todo.title": "To-dos",
    "todo.progress.done": "{done} completed",
    "todo.progress.active": "{active} in progress",
    "todo.progress.pending": "{pending} pending",
    "todo.rowTitle": "Update to-do list",
    "todo.completed": "{done}/{total} completed",
    "chat.loadingHistory": "Loading history…",
    "chat.loadError": "Failed to load history: {message} ({code})",
    "chat.loadOlder": "Load earlier",
    "chat.toBottom": "Back to bottom",
    "chat.messageRail": "Messages in this chat",
    "chat.messageRail.message": "Message {n}",
    "fileOpen.title": "Couldn’t open file",
    "fileOpen.unknown": "Couldn’t open this file",
    "fileOpen.folderTitle": "Couldn’t open folder",
    "fileOpen.folderUnknown": "Couldn’t open this folder",
    "message.extraBlock": "Extra content block",
    "message.contextInjection": "Context injection",
    "message.contextRecall": "Session recall",
    "message.referenceSummary": "Referenced session · {labels}",
    "message.referenceSeparator": ", ",
    "message.context.instructions.loaded": "loaded",
    "message.context.instructions.added": "added",
    "message.context.instructions.updated": "updated",
    "message.context.instructions.removed": "removed",
    "message.context.catalog.replaced": "Replacement catalog",
    "message.context.catalog.more": "… {count} more",
    "message.context.snapshot.supersedes": "Supersedes earlier snapshots",
    "message.context.relay.from": "From session {session}",
    "message.context.recall.counts": "{retained} kept · {omitted} omitted",
    "message.context.recall.truncated": "truncated",
    "message.compaction": "Context compacted",
    "message.compaction.running": "Compacting context…",
    "xh.compact.paused": "Compaction paused",
    "xh.compact.resume": "Resume to continue",
    "xh.compact.failed": "Compaction not completed",
    "xh.compact.skipped": "Compaction skipped",
    "xh.compact.cancelled": "Compaction interrupted",
    "xh.compact.takesMinutes": "May take a few minutes",
    "xh.compact.unchanged": "Original history unchanged",
    "message.compaction.completed": "Compacted {items} history items (~{tokens} tokens)",
    "message.compaction.expand": "View compaction summary",
    "message.compaction.unavailable": "Compaction summary unavailable",
    "message.unknownSurface": "Unknown surface event: {type}",
    "message.unknownBlock": "Unknown content block",
    "message.stopped": "Stopped",
    "message.editReplace": "Replace current draft? Cancel editing to restore it.",
    "message.editConfirm": "Replace draft",
    "message.editCancel": "Cancel editing",
    "message.editRecovered": "Unfinished message edit found",
    "message.editResume": "Resume editing",
    "message.editActive": "Editing a historical message · sends a new turn",
    "message.editSaving": "Saving original draft…",
    "message.editLoading": "Restoring attachment…",
    "message.editMissing": "Attachment missing or not ready: retry, reattach or remove it",
    "message.editRetry": "Retry",
    "message.editRemove": "Remove attachment",
    "message.editChanged": "Draft or task changed; nothing overwritten. Resolve the current draft and retry.",
    "message.editRunning": "The agent is running; stop it before resending the edited message",
    "message.editFinish": "Finish or cancel the current edit first",
    "message.editUnsupported": "This message contains unsupported content; draft unchanged",
    "message.editStorage": "Could not persist the edited draft",
    "message.edit": "Edit and resend",
    "message.editFork": "Edit and fork into a new conversation",
    "message.branch": "Branch into a new conversation",
    "message.branchUnavailable": "Available only on the last message of a completed turn",
    "message.retry.active": "Retrying model request",
    "message.retry.networkWaiting": "Connection interrupted; waiting to reconnect",
    "message.retry.cancelled": "Model request retry cancelled",
    "message.retry.started": "Retried model request",
    "message.retry.scheduled": "Waiting to retry model request",
    "message.retry.status": "{label} ({retry}/{maximum}) · {seconds}s",
    "message.retry.delay": "Retry delay: ",
    "message.retry.failure": "Failure reason: ",
    "message.turnError": "This turn failed",
    "message.maxTokens": "Output token limit reached",
    "message.maxTokens.hint": "This turn reached its output limit. The generated content has been preserved.",
    "message.ranFor": "Ran for {duration}",
    "message.turnFinished": "Turn finished",
    "message.foldedTools": "{count} completed operations",
    "message.expandedTools": "Earlier completed operations · {count}",
    "message.expandProcess": "Show this turn's work",
    "message.collapseProcess": "Hide this turn's work",
    "message.ttft": "TTFT {seconds}s",
    "message.tokensPerSecond": "{tps} tok/s",
    "duration.seconds": "{seconds}s",
    "duration.minutes": "{minutes}m {seconds}s",
    "command.running": "Running…",
    "command.failed": "Command failed",
    "command.done": "Completed",
    "command.title": "Command",
    "command.imagesUnsupported": "/{command} does not accept image attachments; remove them first",
    "approval.waiting": "Waiting for approval",
    "approval.reviewing": "Reviewing on your behalf…",
    "approval.detail.aria": "Approval details",
    "approval.escalation": "Tool {toolName} requests privileged execution",
    "approval.reject": "Reject",
    "approval.allowOnce": "Allow once",
    "ask.rowTitle": "Ask question",
    "ask.waiting": "waiting",
    "ask.cancelled": "cancelled",
    "ask.interrupted": "interrupted",
    "ask.answered": "{answered}/{total} answered",
    "bash.running": "Running",
    "bash.failed": "Failed",
    "bash.stopped": "Stopped",
    "row.running": "Running",
    "row.failed": "Failed",
    "row.stopped": "Stopped",
    "queue.count": "{n} queued messages",
    "queue.edit": "Edit queued message",
    "queue.edit.unsupported": "Contains non-text content; editing is not supported yet",
    "queue.save": "Save queued message",
    "queue.cancelEdit": "Cancel editing",
    "queue.remove": "Remove queued message",
    "queue.steer": "Steer queued message",
    "queue.steer.unavailable": "Steering is available only while the agent is running",
    "queue.editFailed": "Edit failed: this message may have already started sending.",
    "queue.removeFailed": "Removal failed: this message may have already started sending.",
    "queue.steerFailed": "Steering failed. Try again.",
    "terminal.signal": "signal {signal}",
    "terminal.exitCode": "exit code {code}",
    "terminal.running": "Running",
    "terminal.failed": "Failed",
    "terminal.done": "Done",
    "terminal.noOutput": "No output",
    "terminal.collapseAria": "Collapse output",
    "terminal.expandAria": "Expand the remaining {n} output lines",
    "terminal.expandRest": "… {n} more lines",
    "json.truncated": "… truncated, {total} characters total",
    "clock.md": "{m}/{d}",
    "clock.ymd": "{y}-{m}-{d}"
};
exports.zh = {
    "tool.arguments.generating": "正在生成工具参数",
    "tool.arguments.received": "已接收 {size}",
    "tool.arguments.elapsed": "{seconds} 秒",
    "tool.arguments.notExecuted": "模型仍在生成参数，工具尚未执行。",
    "tool.arguments.preview": "内容预览",
    "tool.arguments.raw": "原始 JSON",
    "tool.arguments.showPreview": "查看内容预览",
    "tool.arguments.showRaw": "查看原始 JSON",
    "tool.arguments.waiting": "等待参数内容…",
    "tool.arguments.truncated": "仅预览前 {count} 个字符，实际工具参数未被截断。",
    "view.chat": "对话",
    "xh.turn.working": "Working…",
    "hint.plan": PLAN_NEXT_ACTION_ZH,
    "hint.goal": "输入目标，智能体将持续执行",
    "hint.goal.active": "当前目标进行中。可输入 edit 修改 / pause 暂停 / resume 继续 / clear 清除",
    "placeholder.plan": PLAN_NEXT_ACTION_ZH,
    "placeholder.default": "给智能体发消息",
    "placeholder.unavailable": "会话不可用",
    "placeholder.parentOffline": "父会话已离线，无法继续发送；仍可停止当前运行",
    "placeholder.hero": "描述你想要构建的内容",
    "placeholder.workspace": "选择一个工作区开始",
    "input.commands": "命令",
    "input.add": "添加附件或命令",
    "input.attachFiles": "添加图片或文件",
    "input.stop": "停止生成",
    "input.send": "发送消息",
    "placeholder.steerQueue": "Cmd/Ctrl+Enter 插话发送全部排队消息",
    "input.accessMode": "访问模式，当前：{name}",
    "image.dropTitle": "图片拖动到此处即可添加",
    "image.dropDesc": "最多 {count} 张，每张 {size}",
    "image.dropBlocked": "当前无法添加图片",
    "image.pending": "待发送图片",
    "image.openOriginal": "查看原图",
    "image.openOriginalLabel": "{label}，点击查看原图",
    "image.remove": "移除图片 {name}",
    "image.scrollLeft": "向左滚动图片",
    "image.scrollRight": "向右滚动图片",
    "image.original": "原图",
    "image.label": "图片",
    "image.loadFailed": "图片加载失败，点击重试",
    "image.loading": "图片加载中…",
    "image.preview": "原图预览",
    "image.closePreview": "关闭原图预览",
    "image.serviceUnavailable": "图片读取服务不可用",
    "image.unsupportedType": "仅支持 PNG、JPG、WebP、GIF 格式的图片",
    "image.tooMany": "一条消息最多添加 {count} 张图片",
    "image.fileTooLarge": "单张图片不能超过 {size}",
    "image.totalTooLarge": "图片总大小超过 {size}，请移除部分图片",
    "image.tooManyPixels": "图片分辨率过大，请压缩后重试",
    "image.dimensionTooLarge": "图片宽高不能超过 {size}px，请缩小后重试",
    "image.modelUnsupported": "当前模型不支持图片，请切换支持图片的模型",
    "image.subagentUnsupported": "子智能体会话暂不支持图片",
    "image.sendFailed": "图片发送失败（{reason}），请重新添加图片后再试",
    "context.aria": "上下文已用 {percent}",
    "context.pending": "正在计算上下文",
    "context.unavailable": "暂无上下文读数",
    "context.used": "上下文已用",
    "context.system": "系统提示词",
    "context.tools": "工具",
    "context.messages": "对话消息", "context.user": "用户", "context.assistant": "助手", "context.toolResults": "工具结果", "context.mcp": "MCP 工具", "context.protocol": "协议开销", "context.distributionEstimate": "颜色分布为估算",
    "context.yourMessages": "Your messages", "context.agentReports": "Agent reports", "context.runtimeContext": "Runtime context", "context.checkpoints": "Checkpoints", "context.unattributed": "Unattributed context", "context.userRoleHistory": "User-role history (source unknown)",
    "stats.title": "对话统计",
    "stats.counts": "{turns} 轮 · {steps} 步",
    "stats.llm": "LLM {duration}",
    "stats.toolCall": "工具调用 {duration}",
    "stats.ttftAverage": "首 token 平均 {duration}",
    "stats.tokensPerSecond": "{throughput} tok/s",
    "stats.cacheHit": "缓存命中 {percent}%",
    "stats.tokens": "输入 {input} tok · 输出 {output} tok",
    "settings.enter.title": "繁忙时 Enter 键行为",
    "settings.enter.description": "仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为",
    "settings.enter.queue": "排队发送",
    "settings.enter.steer": "插话发送",
    "access.confirm.title": "确认启用 Full access？",
    "access.confirm.description": "启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",
    "access.confirm.acknowledge": "我已了解风险，并愿意继续",
    "access.confirm.cancel": "取消",
    "access.confirm.enable": "启用 Full access",
    "hero.headline": "新时代的语言",
    "hero.preview": "预览版",
    "hero.chooseWorkspace": "选择工作区",
    "session.hierarchy": "会话层级",
    "details.title": "详情",
    "details.close": "关闭详情",
    "details.empty": "点击消息流中的工具行查看详情",
    "details.notInWindow": "该调用不在当前窗口内",
    "details.input": "输入",
    "details.output": "输出",
    "details.running": "运行中…",
    "todo.title": "任务",
    "todo.progress.done": "{done} 已完成",
    "todo.progress.active": "{active} 进行中",
    "todo.progress.pending": "{pending} 待处理",
    "todo.rowTitle": "更新任务清单",
    "todo.completed": "{done}/{total} 已完成",
    "chat.loadingHistory": "载入历史…",
    "chat.loadError": "历史加载失败：{message}（{code}）",
    "chat.loadOlder": "加载更早",
    "chat.toBottom": "回到底部",
    "chat.messageRail": "当前聊天中的消息",
    "chat.messageRail.message": "第 {n} 条消息",
    "fileOpen.title": "无法打开文件",
    "fileOpen.unknown": "无法打开此文件",
    "fileOpen.folderTitle": "无法打开文件夹",
    "fileOpen.folderUnknown": "无法打开此文件夹",
    "message.extraBlock": "附加内容块",
    "message.contextInjection": "上下文注入",
    "message.contextRecall": "跨会话召回",
    "message.referenceSummary": "引用会话 · {labels}",
    "message.referenceSeparator": "、",
    "message.context.instructions.loaded": "已载入",
    "message.context.instructions.added": "已新增",
    "message.context.instructions.updated": "已更新",
    "message.context.instructions.removed": "已移除",
    "message.context.catalog.replaced": "替换目录",
    "message.context.catalog.more": "…还有 {count} 条",
    "message.context.snapshot.supersedes": "取代先前的快照",
    "message.context.relay.from": "来自会话 {session}",
    "message.context.recall.counts": "保留 {retained} 条 · 省略 {omitted} 条",
    "message.context.recall.truncated": "已截断",
    "message.compaction": "上下文已压缩",
    "message.compaction.running": "正在压缩…",
    "xh.compact.paused": "压缩已暂停",
    "xh.compact.resume": "恢复后继续",
    "xh.compact.failed": "压缩未完成",
    "xh.compact.skipped": "压缩已跳过",
    "xh.compact.cancelled": "压缩已中断",
    "xh.compact.takesMinutes": "可能需要几分钟",
    "xh.compact.unchanged": "原始历史未改变",
    "message.compaction.completed": "已压缩 {items} 条历史记录（约 {tokens} tokens）",
    "message.compaction.expand": "点击查看压缩摘要",
    "message.compaction.unavailable": "压缩摘要不可用",
    "message.unknownSurface": "未知 surface 事件：{type}",
    "message.unknownBlock": "未知内容块",
    "message.stopped": "已停止",
    "message.editReplace": "替换当前草稿？原草稿会暂存，取消编辑可恢复。",
    "message.editConfirm": "替换草稿",
    "message.editCancel": "取消编辑",
    "message.editRecovered": "发现未完成的历史消息编辑",
    "message.editResume": "恢复编辑",
    "message.editActive": "正在编辑历史消息 · 发送后开启新一轮",
    "message.editSaving": "正在保存原草稿…",
    "message.editLoading": "正在恢复附件…",
    "message.editMissing": "附件未就绪或已丢失，请重试、重新上传或主动移除",
    "message.editRetry": "重试",
    "message.editRemove": "移除附件",
    "message.editChanged": "草稿或任务状态已变化，未覆盖；请先处理当前草稿再重试",
    "message.editRunning": "任务已经开始运行，请停止后再发送编辑消息",
    "message.editFinish": "请先完成或取消当前编辑",
    "message.editUnsupported": "此消息含不支持恢复的内容，未修改草稿",
    "message.editStorage": "无法持久保存编辑草稿",
    "message.edit": "编辑并重新发送",
    "message.editFork": "编辑并 Fork 到新对话",
    "message.branch": "在新对话中分支",
    "message.branchUnavailable": "仅可从已完成轮次的最后一条消息分支",
    "message.retry.active": "正在重试模型请求",
    "message.retry.networkWaiting": "连接中断，等待恢复",
    "message.retry.cancelled": "模型请求重试已取消",
    "message.retry.started": "已重试模型请求",
    "message.retry.scheduled": "等待重试模型请求",
    "message.retry.status": "{label}（{retry}/{maximum}） · {seconds}s",
    "message.retry.delay": "重试延迟：",
    "message.retry.failure": "失败原因：",
    "message.turnError": "本轮运行失败",
    "message.maxTokens": "已达到输出 token 上限",
    "message.maxTokens.hint": "本轮输出达到上限，已生成的内容已保留。",
    "message.ranFor": "用时 {duration}",
    "message.turnFinished": "本轮已结束",
    "message.foldedTools": "已收起 {count} 个完成的操作",
    "message.expandedTools": "较早的已完成操作 · {count}",
    "message.expandProcess": "展开本轮过程",
    "message.collapseProcess": "收起本轮过程",
    "message.ttft": "首 token {seconds}秒",
    "message.tokensPerSecond": "{tps} tok/s",
    "duration.seconds": "{seconds}秒",
    "duration.minutes": "{minutes}分{seconds}秒",
    "command.running": "执行中…",
    "command.failed": "命令失败",
    "command.done": "已完成",
    "command.title": "命令",
    "command.imagesUnsupported": "/{command} 不接受图片附件，请先移除图片",
    "approval.waiting": "等待审批",
    "approval.reviewing": "正在代你审核…",
    "approval.detail.aria": "审批详情",
    "approval.escalation": "工具 {toolName} 请求越权执行",
    "approval.reject": "拒绝",
    "approval.allowOnce": "允许一次",
    "ask.rowTitle": "提问",
    "ask.waiting": "等待回答",
    "ask.cancelled": "已取消",
    "ask.interrupted": "已中断",
    "ask.answered": "{answered}/{total} 已回答",
    "bash.running": "运行中",
    "bash.failed": "失败",
    "bash.stopped": "已停止",
    "row.running": "运行中",
    "row.failed": "失败",
    "row.stopped": "已停止",
    "queue.count": "{n} 条排队消息",
    "queue.edit": "编辑排队消息",
    "queue.edit.unsupported": "包含非文本内容，暂不支持编辑",
    "queue.save": "保存排队消息",
    "queue.cancelEdit": "取消编辑",
    "queue.remove": "删除排队消息",
    "queue.steer": "插话发送",
    "queue.steer.unavailable": "仅运行中可插话发送",
    "queue.editFailed": "编辑失败：这条消息可能已经开始发送。",
    "queue.removeFailed": "删除失败：这条消息可能已经开始发送。",
    "queue.steerFailed": "插话发送失败，请重试。",
    "terminal.signal": "信号 {signal}",
    "terminal.exitCode": "退出码 {code}",
    "terminal.running": "运行中",
    "terminal.failed": "失败",
    "terminal.done": "已完成",
    "terminal.noOutput": "无输出",
    "terminal.collapseAria": "收起输出",
    "terminal.expandAria": "展开其余 {n} 行输出",
    "terminal.expandRest": "… 其余 {n} 行",
    "json.truncated": "… 已截断，共 {total} 字符",
    "clock.md": "{m}月{d}日",
    "clock.ymd": "{y}年{m}月{d}日"
};

},
"src/modules/conversation/skeleton/TodoPanel.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/TodoPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const TodoPanel_css_1 = __importDefault(require("./TodoPanel.css"));
exports.default = {
    "body": "Xe4JHW_body",
    "chevron": "Xe4JHW_chevron",
    "content": "Xe4JHW_content",
    "glyph": "Xe4JHW_glyph",
    "glyphCompleted": "Xe4JHW_glyphCompleted",
    "glyphPending": "Xe4JHW_glyphPending",
    "glyphProgress": "Xe4JHW_glyphProgress",
    "header": "Xe4JHW_header",
    "item": "Xe4JHW_item",
    "lead": "Xe4JHW_lead",
    "list": "Xe4JHW_list",
    "progress": "Xe4JHW_progress",
    "root": "Xe4JHW_root",
    "title": "Xe4JHW_title",
    "todo-progress-spin": "Xe4JHW_todo-progress-spin"
};
const tagId = '@xharness/dsh-client-ui-conversation/TodoPanel.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = TodoPanel_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/TodoPanel.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/TodoPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Xe4JHW_root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex:none;margin:0 auto;overflow:hidden}.Xe4JHW_body{flex-direction:column;gap:8px;padding:6px 12px;display:flex}.Xe4JHW_header{text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;width:100%;padding:0;display:flex}.Xe4JHW_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.Xe4JHW_title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}.Xe4JHW_progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;font-weight:400;line-height:20px;overflow:hidden}.Xe4JHW_chevron{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.Xe4JHW_list{flex-direction:column;gap:8px;max-height:180px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.Xe4JHW_item{min-width:0;color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:13px;line-height:20px;display:flex}.Xe4JHW_glyph{flex:none;place-items:center;width:16px;height:16px;display:grid}.Xe4JHW_glyphCompleted{color:var(--dsw-alias-state-success-primary)}.Xe4JHW_glyphPending{color:var(--dsw-alias-label-caption)}.Xe4JHW_glyphProgress{color:var(--dsw-alias-state-business-primary);animation:1s linear infinite Xe4JHW_todo-progress-spin}@keyframes Xe4JHW_todo-progress-spin{to{transform:rotate(360deg)}}.Xe4JHW_content{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}\n/* The input dock now shares the composer's inner width. */\n[data-composer-card] .Xe4JHW_root{width:100%;max-width:none;margin:0}\n\n/* Compact read-only checklist; the original composer geometry stays unchanged. */\n.Xe4JHW_root{border:0;border-radius:0;background:transparent}\n.Xe4JHW_body{gap:4px;padding:6px 12px 8px}\n.Xe4JHW_header{gap:8px}\n.Xe4JHW_progress{flex:none;font-variant-numeric:tabular-nums}\n.Xe4JHW_chevron{margin-left:auto}\n.Xe4JHW_list{gap:2px;max-height:168px}\n.Xe4JHW_item{min-height:26px;align-items:flex-start}\n.Xe4JHW_glyph{height:26px}\n.Xe4JHW_glyphCompleted,.Xe4JHW_glyphProgress{color:var(--dsw-alias-label-secondary)}\n.Xe4JHW_item[data-status=\"completed\"] .Xe4JHW_content{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px}\n.Xe4JHW_content{white-space:normal;overflow-wrap:anywhere;line-height:26px}\n@media(prefers-reduced-motion:reduce){.Xe4JHW_glyphProgress{animation:none}}\n[data-composer-card] .Xe4JHW_body{padding-left:0;padding-right:0}\n";

},
"src/modules/conversation/queue/QueueDock.js": function(module, exports, require) {
// source: src/modules/conversation/queue/QueueDock.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueDockEntry = void 0;
exports.QueueDock = QueueDock;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const primitives_1 = require("../primitives");
const locales_1 = require("../locales");
const QueueDock_styles_1 = __importDefault(require("./QueueDock.styles"));
/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing.
 */
function QueueDock({ useSession, updateQueue, notify, t }) {
    const inbox = useSession(s => s.queue);
    const queue = (0, react_1.useMemo)(() => inbox.filter(row => row.placement === 'queued'), [inbox]);
    const running = useSession(s => s.running);
    const queueMutable = useSession(s => s.subagent === null);
    const [editing, setEditing] = (0, react_1.useState)(null);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [collapsed, setCollapsed] = (0, react_1.useState)(true);
    const listId = (0, react_1.useId)();
    (0, react_1.useEffect)(() => {
        if (queue.length === 0 && !collapsed)
            setCollapsed(true);
        if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id)))
            setEditing(null);
    }, [collapsed, editing, queue, queueMutable]);
    if (queue.length === 0)
        return null;
    const interactionActive = queueMutable && (editing !== null || busy !== null);
    const expanded = !collapsed || interactionActive;
    const listVisible = queue.length === 1 || expanded;
    const applyAction = async (itemId, action, failure) => {
        setBusy(itemId);
        try {
            await updateQueue(itemId, action);
            return true;
        }
        catch {
            notify('error', failure);
            return false;
        }
        finally {
            setBusy(current => current === itemId ? null : current);
        }
    };
    const saveEdit = async () => {
        if (editing === null || editing.text.trim() === '')
            return;
        if (await applyAction(editing.id, { kind: 'edit', content: [{ type: 'text', text: editing.text }] }, t('queue.editFailed')))
            setEditing(null);
    };
    return ((0, jsx_runtime_1.jsx)("div", { className: QueueDock_styles_1.default.dock, "data-queue-dock": "", children: (0, jsx_runtime_1.jsxs)("div", { className: QueueDock_styles_1.default.panel, children: [queue.length > 1 && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: QueueDock_styles_1.default.header, "aria-controls": listId, "aria-expanded": expanded, disabled: interactionActive, onClick: () => { setCollapsed(value => !value); }, children: [(0, jsx_runtime_1.jsx)("span", { className: QueueDock_styles_1.default.lead, "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(primitives_1.IconQueueOutline14, {}) }), (0, jsx_runtime_1.jsx)("span", { className: QueueDock_styles_1.default.count, children: t('queue.count', { n: queue.length }) }), (0, jsx_runtime_1.jsx)("span", { className: QueueDock_styles_1.default.chevron, "aria-hidden": true, children: expanded ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronUpOutline14, {}) })] })), (0, jsx_runtime_1.jsx)("ul", { id: listId, className: QueueDock_styles_1.default.list, hidden: !listVisible, children: listVisible && queue.map(row => ((0, jsx_runtime_1.jsxs)("li", { className: QueueDock_styles_1.default.row, children: [queue.length === 1 && (0, jsx_runtime_1.jsx)("span", { className: QueueDock_styles_1.default.lead, "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(primitives_1.IconQueueOutline14, {}) }), editing?.id === row.id
                                ? ((0, jsx_runtime_1.jsx)("input", { autoFocus: true, className: QueueDock_styles_1.default.editor, "aria-label": t('queue.edit'), value: editing.text, onChange: (event) => { setEditing({ id: row.id, text: event.currentTarget.value }); }, onKeyDown: (event) => {
                                        if (event.key === 'Escape') {
                                            setEditing(null);
                                            return;
                                        }
                                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                            event.preventDefault();
                                            void saveEdit();
                                        }
                                    } }))
                                : (0, jsx_runtime_1.jsx)("span", { className: QueueDock_styles_1.default.preview, children: row.preview }), queueMutable && (0, jsx_runtime_1.jsx)("div", { className: QueueDock_styles_1.default.actions, children: editing?.id === row.id
                                    ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('queue.save'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: QueueDock_styles_1.default.action, "aria-label": t('queue.save'), disabled: busy !== null || editing.text.trim() === '', onClick: () => { void saveEdit(); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconCheckOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('queue.cancelEdit'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: QueueDock_styles_1.default.action, "aria-label": t('queue.cancelEdit'), disabled: busy !== null, onClick: () => { setEditing(null); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconCloseOutline16, { size: 14 }) }) })] }))
                                    : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('queue.edit'), side: "bottom", delayMs: 500, disabled: row.text === null, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: QueueDock_styles_1.default.action, "aria-label": t('queue.edit'),
                                                    // Disabled buttons fire no hover events, so the
                                                    // unsupported hint stays a native title.
                                                    title: row.text === null ? t('queue.edit.unsupported') : undefined, disabled: busy !== null || row.text === null, onClick: () => {
                                                        if (row.text !== null)
                                                            setEditing({ id: row.id, text: row.text });
                                                    }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('queue.remove'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: QueueDock_styles_1.default.action, "aria-label": t('queue.remove'), disabled: busy !== null, onClick: () => {
                                                        void applyAction(row.id, { kind: 'remove' }, t('queue.removeFailed'));
                                                    }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconTrashOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: t('queue.steer'), side: "bottom", delayMs: 500, disabled: !running, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: QueueDock_styles_1.default.action, "aria-label": t('queue.steer'), title: running ? undefined : t('queue.steer.unavailable'), disabled: busy !== null || !running, onClick: () => {
                                                        void applyAction(row.id, { kind: 'steer' }, t('queue.steerFailed'));
                                                    }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconSendOutline14, {}) }) })] })) })] }, row.id))) })] }) }));
}
/**
 * The dock entry as a plain registrant plugin. The conversation service is
 * the action contract; the slot declaration has an independent lifecycle boundary.
 */
exports.queueDockEntry = {
    name: 'conversation-queue-dock',
    inject: ['slots', 'conversation', 'sessions'],
    /**
     * Register the queue strip as the terminal input-dock entry (order 20).
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'queue',
            order: 20,
            locale: locales_1.NS,
            inject: (sessionId) => {
                const actx = ctx.sessions.scope(sessionId);
                if (actx === undefined)
                    throw new Error(`queue dock: session "${sessionId}" resolved no scope`);
                const conversation = actx.get('conversation');
                if (conversation === undefined)
                    throw new Error('queue dock: conversation service unavailable');
                return {
                    updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
                    notify: (level, text) => { conversation.input.for(actx).notify(level, text); },
                };
            },
        }, QueueDock));
    },
};

},
"src/modules/conversation/queue/QueueDock.styles.js": function(module, exports, require) {
// source: src/modules/conversation/queue/QueueDock.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const QueueDock_css_1 = __importDefault(require("./QueueDock.css"));
exports.default = {
    "action": "Q8gw3G_action",
    "actions": "Q8gw3G_actions",
    "chevron": "Q8gw3G_chevron",
    "count": "Q8gw3G_count",
    "dock": "Q8gw3G_dock",
    "editor": "Q8gw3G_editor",
    "header": "Q8gw3G_header",
    "lead": "Q8gw3G_lead",
    "list": "Q8gw3G_list",
    "panel": "Q8gw3G_panel",
    "preview": "Q8gw3G_preview",
    "row": "Q8gw3G_row"
};
const tagId = '@xharness/dsh-client-ui-conversation/QueueDock.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = QueueDock_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/queue/QueueDock.css": function(module, exports, require) {
// source: src/modules/conversation/queue/QueueDock.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Q8gw3G_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}.Q8gw3G_panel{background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px 12px 0 0;width:100%;padding:2px 0;position:relative;overflow:hidden}.Q8gw3G_panel:after{border:1px solid var(--dsw-alias-border-l1);border-radius:inherit;content:\"\";pointer-events:none;border-bottom:none;position:absolute;inset:0}.Q8gw3G_header{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:10px;padding:4px 12px;display:flex}.Q8gw3G_header:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}.Q8gw3G_header:disabled{cursor:default}.Q8gw3G_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.Q8gw3G_count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}.Q8gw3G_chevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.Q8gw3G_list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}.Q8gw3G_row{box-sizing:border-box;border-radius:8px;align-items:center;gap:10px;width:100%;height:36px;padding:4px 5px 4px 12px;display:flex}.Q8gw3G_row+.Q8gw3G_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}.Q8gw3G_preview,.Q8gw3G_editor{min-width:0;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto}.Q8gw3G_preview{color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}.Q8gw3G_editor{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);height:28px;color:var(--dsw-alias-label-primary);border-radius:6px;outline:none;padding:0 8px}.Q8gw3G_editor:focus{border-color:var(--dsw-alias-state-business-primary)}.Q8gw3G_actions{flex:none;align-items:center;gap:10px;display:flex}.Q8gw3G_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}.Q8gw3G_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.Q8gw3G_action:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}.Q8gw3G_action:disabled{cursor:default;opacity:.45}\n/* Flat queue preview; edit, delete and steer retain the original actions. */\n.Q8gw3G_panel{background:transparent;border-radius:0}\n.Q8gw3G_panel:after{display:none}\n[data-composer-card] .Q8gw3G_dock{width:100%;max-width:none;margin:0;padding:0}\n[data-composer-card] .Q8gw3G_header,[data-composer-card] .Q8gw3G_row{padding-left:0;padding-right:0}\n";

},
"src/modules/conversation/skeleton/ConversationRoot.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ConversationRoot.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationRoot = ConversationRoot;
const jsx_runtime_1 = require("react/jsx-runtime");
// Resident conversation skeleton. Hero chrome, composer positioning, the
// chain, AND the composer bar (session-maybe slot) stay mounted across
// no-session/session transitions — the bar renders inert via owner props.
const react_1 = require("react");
const classnames_1 = __importDefault(require("../classnames"));
const EmptyHero_1 = require("./EmptyHero");
const ConversationRoot_styles_1 = __importDefault(require("./ConversationRoot.styles"));
const HeroShell_styles_1 = __importDefault(require("./HeroShell.styles"));
function ConversationRoot({ sessionId, useSession, useSessions, useWorkspaces, useInput, useComposerBlock, renderSlot, renderSlotChain, selectWorkspace, t, }) {
    const openState = useSession(s => s.openState);
    const composerPhase = useSession(s => s.composerPhase);
    const pending = useSession(s => s.pending) ?? [];
    const session = useSession(s => s);
    const inputState = useInput(s => s);
    const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd);
    const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank);
    const workspaces = useWorkspaces(s => s);
    // A plugin this package cannot import (ui-model-selection) says this session cannot
    // send; its reason is already localized by whoever raised it.
    const composerBlock = useComposerBlock(block => block);
    const [pickerOpen, setPickerOpen] = (0, react_1.useState)(false);
    const [pendingWorkspaceId, setPendingWorkspaceId] = (0, react_1.useState)();
    const pickerAnchor = (0, react_1.useRef)(null);
    // Publishes the seat's live height as --dsh-composer-height on the scroll
    // body so floating controls (ChatView back-to-bottom) clear the composer as
    // it grows. Callback ref, not an effect; stable identity prevents observer
    // churn while the first blank session fills the resident body outlet.
    const seatObserver = (0, react_1.useRef)(null);
    const seatResizeRef = (0, react_1.useCallback)((seat) => {
        seatObserver.current?.disconnect();
        seatObserver.current = null;
        const scroller = seat?.parentElement ?? null;
        if (seat === null || scroller === null)
            return;
        seatObserver.current = new ResizeObserver(() => {
            scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`);
        });
        seatObserver.current.observe(seat);
    }, []);
    const sessionWorkspace = sessionId === undefined
        ? undefined
        : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId));
    const pendingWorkspace = workspaces.items.find(workspace => workspace.workspaceId === pendingWorkspaceId);
    // Clear the pending pick once the session lands in it, or when the picked
    // workspace disappears from a ready list (deleted from the sidebar).
    (0, react_1.useEffect)(() => {
        if (pendingWorkspaceId === undefined)
            return;
        if (sessionWorkspace?.workspaceId === pendingWorkspaceId
            || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
            setPendingWorkspaceId(undefined);
        }
    }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace]);
    // While a session is still replaying (loading + blank) the hero/docked
    // choice is unknowable — render the composer hidden instead of flashing
    // the centered hero and snapping to the docked bar (or vice versa).
    // Exemption: a session the list summary already proves blank can only
    // land on the hero, so hiding would blank the column for the whole
    // history round-trip (the startup auto-selection flash) for nothing.
    // The exemption is deliberately open-state-wide, not loading-only: a
    // summary-blank session is the hero before its open starts (`cold`) and
    // after one fails (`error`) for the same reason — there is no history.
    const settling = sessionId !== undefined && composerPhase === 'blank' && openState === 'loading'
        && summaryBlank !== true;
    const hero = sessionId === undefined
        || (composerPhase === 'blank' && (openState === 'open' || summaryBlank === true));
    const zone = session === undefined || inputState === undefined ? undefined : { session, input: inputState };
    // The chip is a selector; label resolution walks the flow top-down:
    //   1. a just-picked workspace (pending) → its title;
    //   2. cold start, no session yet → placeholder ("Choose workspace");
    //   3. the blank session's workspace is in the list → its title;
    //   4. list still loading → cwd folder name bridges so the title does not
    //      flash on refresh (empty cwd → placeholder);
    //   5. list ready but no owning workspace (deleted from the sidebar) →
    //      placeholder, never the deleted folder's name via cwd.
    const chipTitle = pendingWorkspace?.title
        ?? (sessionId === undefined
            ? undefined
            : sessionWorkspace?.title
                ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
                    ? undefined
                    : (0, EmptyHero_1.workspaceLabel)(cwd)));
    const heroWorkspaceRow = ((0, jsx_runtime_1.jsxs)("div", { className: ConversationRoot_styles_1.default.heroWorkspaceRow, style: { flexWrap: 'wrap' }, children: [renderSlot('conversation.hero.runtimeEnvironment', {
                sessionId, summaryBlank, composerPhase, openState,
                appearance: {
                    trigger: HeroShell_styles_1.default.workspace, icon: HeroShell_styles_1.default.folder,
                    label: HeroShell_styles_1.default.workspaceLabel, chevron: HeroShell_styles_1.default.chevron,
                },
            }), (0, jsx_runtime_1.jsx)(EmptyHero_1.WorkspaceChip, { buttonRef: pickerAnchor, label: chipTitle, menuOpen: pickerOpen, onClick: () => { setPickerOpen(open => !open); }, t: t }), renderSlot('conversation.hero.workspace', {
                open: pickerOpen,
                anchorRef: pickerAnchor,
                selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
                onPick: (workspaceId) => {
                    setPickerOpen(false);
                    setPendingWorkspaceId(workspaceId);
                    void selectWorkspace(workspaceId).catch(() => {
                        setPendingWorkspaceId(current => current === workspaceId ? undefined : current);
                    });
                },
                onClose: () => { setPickerOpen(false); },
            }), renderSlot('conversation.hero.agentPreset', {})] }));
    // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
    // together: no workspace picked yet (cold start, no session at all), or a
    // blank session whose workspace vanished (deleted from the sidebar). The
    // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
    // not a different tree, so the textarea DOM survives the transition.
    const inert = sessionId === undefined || (hero && chipTitle === undefined);
    // A raised block is the same inert posture with the blocker's own reason:
    // one disabled textarea, never a second tree. The no-workspace state wins
    // when both hold — picking a workspace is the earlier prerequisite.
    const blocked = !inert && composerBlock !== undefined;
    const inputBar = renderSlot('conversation.composer.bar', {
        variant: hero ? 'hero' : 'composer',
        ...(inert
            ? {
                disabled: true,
                placeholder: t('placeholder.workspace'),
                workspacePickerOpen: pickerOpen,
                onRequestWorkspace: () => { setPickerOpen(true); },
            }
            : blocked
                // `blocked`, not `disabled`: the bar refuses input either way, but a
                // block keeps the model seat live because choosing a model is how the
                // user clears it.
                ? { blocked: composerBlock, placeholder: composerBlock.reason }
                : hero ? { placeholder: t('placeholder.hero') } : {}),
        overlay: renderSlot('conversation.input.overlay', {}),
        accessory: zone === undefined ? null : renderSlot('conversation.input.dock', zone),
        leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
        rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
        // Docks share the card's geometry; their plugins still own all state and actions.
        footer: !hero && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
    });
    const composerBar = ((0, jsx_runtime_1.jsxs)("div", { className: (0, classnames_1.default)(ConversationRoot_styles_1.default.composerStack, hero && ConversationRoot_styles_1.default.composerHero), children: [hero && (0, jsx_runtime_1.jsx)(EmptyHero_1.HeroGlow, { className: ConversationRoot_styles_1.default.heroGlow }), hero && (0, jsx_runtime_1.jsx)(EmptyHero_1.HeroShell, { t: t, renderSlot: renderSlot }), hero && heroWorkspaceRow, inputBar] }));
    const phase = settling ? 'settling' : hero ? 'hero' : 'active';
    const composer = renderSlotChain('conversation.composer', { interactions: pending, session }, { fallback: composerBar, overlay: true });
    // Sticky wraps the whole chain output (fallback + elected overlay), not
    // only `.composerStack`: overlay:true renders those as siblings, and sticky
    // on the fallback alone would leave Question/Approval panels at the content
    // end off-screen when the user is not pinned to the floor.
    const composerSeat = ((0, jsx_runtime_1.jsx)("div", { ref: seatResizeRef, className: ConversationRoot_styles_1.default.composerSeat, "data-composer-seat": "", children: composer }));
    return ((0, jsx_runtime_1.jsxs)("div", { className: ConversationRoot_styles_1.default.root, "data-phase": phase, "data-conversation-root": "", children: [renderSlot('conversation.session.header', {}), (0, jsx_runtime_1.jsxs)("div", { className: ConversationRoot_styles_1.default.scrollBody, "data-conversation-scroll": "", children: [renderSlot('conversation.session', {}), composerSeat] })] }));
}

},
"src/modules/conversation/skeleton/EmptyHero.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/EmptyHero.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceLabel = workspaceLabel;
exports.WorkspaceChip = WorkspaceChip;
exports.HeroGlow = HeroGlow;
exports.HeroShell = HeroShell;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../primitives");
const runtime_values_1 = require("../runtime-values");
const HeroShell_styles_1 = __importDefault(require("./HeroShell.styles"));
/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
function workspaceLabel(cwd) {
    const base = (0, runtime_values_1.workspaceTitleOf)(cwd);
    return base !== '' ? base : cwd;
}
/**
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session. Without a
 * label the chip renders its placeholder state: closed folder + the
 * "Choose workspace" call to action.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }) {
    return ((0, jsx_runtime_1.jsxs)("button", { ref: buttonRef, type: "button", className: HeroShell_styles_1.default.workspace, "aria-label": t('hero.chooseWorkspace'), "aria-haspopup": "menu", "aria-expanded": menuOpen, onClick: onClick, children: [label === undefined
                ? (0, jsx_runtime_1.jsx)(primitives_1.IconFolderClose16, { className: HeroShell_styles_1.default.folder, size: 16 })
                : (0, jsx_runtime_1.jsx)(primitives_1.IconFolderOpen16, { className: HeroShell_styles_1.default.folder, size: 16 }), (0, jsx_runtime_1.jsx)("span", { className: HeroShell_styles_1.default.workspaceLabel, children: label ?? t('hero.chooseWorkspace') }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, { className: HeroShell_styles_1.default.chevron, size: 12 })] }));
}
/**
 * The product silver backdrop hook. Rendered by the hero
 * owner (ConversationRoot), not HeroShell, so it can center on the input
 * card; the owner's className supplies all positioning.
 * @param props.className - positioning class from the owner.
 * @returns the theme-owned silver backdrop seat.
 */
function HeroGlow({ className }) {
    return (0, jsx_runtime_1.jsx)("div", { className: className, "data-xh-silver-glow": "", "aria-hidden": "true" });
}
/**
 * Render the hero chrome (headline only; no glow, no composer, no workspace
 * row — the glow is the owner's {@link HeroGlow}).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
function HeroShell({ t, renderSlot, children }) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: HeroShell_styles_1.default.root, children: [(0, jsx_runtime_1.jsxs)("div", { className: HeroShell_styles_1.default.stack, children: [(0, jsx_runtime_1.jsxs)("div", { className: HeroShell_styles_1.default.headline, children: [(0, jsx_runtime_1.jsx)("span", { className: HeroShell_styles_1.default.fishHitbox, children: renderSlot('conversation.hero.brand.mark', { size: 34, className: HeroShell_styles_1.default.fish }, {
                                    fallback: (0, jsx_runtime_1.jsx)(primitives_1.FishLogo, { size: 34, className: HeroShell_styles_1.default.fish }),
                                }) }), (0, jsx_runtime_1.jsx)("span", { className: HeroShell_styles_1.default.headlineText, children: t('hero.headline') })] }), (0, jsx_runtime_1.jsx)("div", { className: HeroShell_styles_1.default.body })] }), children] }));
}

},
"src/modules/conversation/skeleton/HeroShell.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/HeroShell.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const HeroShell_css_1 = __importDefault(require("./HeroShell.css"));
exports.default = {
    "body": "_f60Wq_body",
    "chevron": "_f60Wq_chevron",
    "fish": "_f60Wq_fish",
    "fishHitbox": "_f60Wq_fishHitbox",
    "folder": "_f60Wq_folder",
    "headline": "_f60Wq_headline",
    "headlineText": "_f60Wq_headlineText",
    "hero-fish-swim": "_f60Wq_hero-fish-swim",
    "modalAction": "_f60Wq_modalAction",
    "modalError": "_f60Wq_modalError",
    "modalInput": "_f60Wq_modalInput",
    "previewBadge": "_f60Wq_previewBadge",
    "root": "_f60Wq_root",
    "stack": "_f60Wq_stack",
    "workspace": "_f60Wq_workspace",
    "workspaceLabel": "_f60Wq_workspaceLabel",
    "workspaceRow": "_f60Wq_workspaceRow"
};
const tagId = '@xharness/dsh-client-ui-conversation/HeroShell.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = HeroShell_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/HeroShell.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/HeroShell.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._f60Wq_root{justify-content:center;align-items:center;min-width:0;height:100%;padding:0 24px;display:flex}._f60Wq_stack{width:100%;max-width:var(--dsh-composer-card-max-width);flex-direction:column;align-items:stretch;gap:12px;display:flex;overflow:visible}._f60Wq_headline{color:var(--dsw-alias-label-primary);grid-template-columns:34px auto auto;justify-content:center;align-items:center;column-gap:10px;font-size:26px;font-weight:500;line-height:32px;display:grid}._f60Wq_headlineText{grid-area:1/2}._f60Wq_previewBadge{border:1px solid var(--dsw-alias-interactive-bg-hover);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish);font-family:var(--ds-font-family-code);white-space:nowrap;border-radius:24px;grid-area:1/3;align-self:start;margin-top:2px;margin-left:-3px;padding:1px 7px 0;font-size:12px;font-weight:500;line-height:18px}._f60Wq_fishHitbox{grid-area:1/1;justify-content:center;align-items:center;display:inline-flex}._f60Wq_fish{color:var(--dsw-alias-label-primary);transform-origin:50% 60%}@keyframes _f60Wq_hero-fish-swim{0%,to{transform:translate(0)rotate(0)}35%{transform:translate(-1px,-1px)rotate(-5deg)}70%{transform:translate(1px)rotate(3deg)}}@media (hover:hover) and (prefers-reduced-motion:no-preference){._f60Wq_fishHitbox:hover ._f60Wq_fish{animation:_f60Wq_hero-fish-swim var(--ds-transition-duration-slow) var(--ds-ease-in-out)}}._f60Wq_body{flex-direction:column;gap:12px;min-width:0;display:flex;position:relative;overflow:visible}._f60Wq_body>*{z-index:1;position:relative}._f60Wq_body>._f60Wq_workspaceRow{z-index:10;align-items:center;min-width:0;padding-left:8px;display:flex}._f60Wq_workspace{max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}._f60Wq_workspace:not(:disabled):hover,._f60Wq_workspace[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}._f60Wq_workspace:disabled{cursor:default}._f60Wq_folder{color:var(--dsw-alias-label-primary);flex:none}._f60Wq_workspaceLabel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._f60Wq_chevron{color:var(--dsw-alias-label-caption);flex:none}._f60Wq_modalInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;border-radius:22px;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}._f60Wq_modalInput::placeholder{color:var(--dsw-alias-label-caption)}._f60Wq_modalInput:disabled{color:var(--dsw-alias-label-dimmed)}._f60Wq_modalAction{min-width:72px}._f60Wq_modalError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}";

},
"src/modules/conversation/skeleton/ConversationRoot.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ConversationRoot.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ConversationRoot_css_1 = __importDefault(require("./ConversationRoot.css"));
exports.default = {
    "composerHero": "lvQYKa_composerHero",
    "composerSeat": "lvQYKa_composerSeat",
    "composerStack": "lvQYKa_composerStack",
    "crumb": "lvQYKa_crumb",
    "crumbCurrent": "lvQYKa_crumbCurrent",
    "crumbSeg": "lvQYKa_crumbSeg",
    "crumbSep": "lvQYKa_crumbSep",
    "crumbs": "lvQYKa_crumbs",
    "header": "lvQYKa_header",
    "headerActions": "lvQYKa_headerActions",
    "headerHidden": "lvQYKa_headerHidden",
    "headerUtilities": "lvQYKa_headerUtilities",
    "heroGlow": "lvQYKa_heroGlow",
    "heroWorkspaceRow": "lvQYKa_heroWorkspaceRow",
    "root": "lvQYKa_root",
    "scrollBody": "lvQYKa_scrollBody",
    "tab": "lvQYKa_tab",
    "tabActive": "lvQYKa_tabActive",
    "tabs": "lvQYKa_tabs",
    "titleCluster": "lvQYKa_titleCluster",
    "titleRow": "lvQYKa_titleRow",
    "viewArea": "lvQYKa_viewArea"
};
const tagId = '@xharness/dsh-client-ui-conversation/ConversationRoot.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ConversationRoot_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/ConversationRoot.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ConversationRoot.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".lvQYKa_root{background:var(--dsw-alias-bg-base);--dsh-chat-content-width:680px;--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);--dsh-composer-side-clearance:16px;--dsh-composer-dock-inset:8px;flex-direction:column;min-width:0;height:100%;display:flex}.lvQYKa_header{border-bottom:1px solid #0000;flex:none;padding:12px 28px 0 20px;position:relative}.lvQYKa_header:after{content:\"\";z-index:0;background:var(--dsw-alias-border-l2);pointer-events:none;height:1px;position:absolute;bottom:1px;left:0;right:0}.lvQYKa_headerHidden{display:none}.lvQYKa_titleRow{align-items:center;gap:0;min-height:32px;display:flex}.lvQYKa_titleCluster{flex:1;align-items:center;gap:10px;min-width:0;display:flex}.lvQYKa_crumbs{white-space:nowrap;align-items:center;gap:4px;min-width:0;display:flex;overflow:hidden}.lvQYKa_crumbSeg{align-items:center;gap:4px;min-width:0;display:inline-flex}.lvQYKa_crumbSep{color:var(--dsw-alias-label-caption);font-size:14px;line-height:20px}.lvQYKa_crumb{max-width:220px;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:0 0;border:none;border-radius:12px;padding:4px 8px;font-size:14px;line-height:20px;overflow:hidden}.lvQYKa_crumb:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.lvQYKa_crumbCurrent{color:var(--dsw-alias-label-primary);cursor:default;font-weight:500}.lvQYKa_headerActions{flex:none;align-items:center;gap:8px;display:flex}.lvQYKa_headerUtilities{flex:none;align-items:center;gap:8px;margin-left:20px;display:flex}.lvQYKa_headerUtilities:empty{display:none}.lvQYKa_tabs{z-index:1;gap:36px;margin-top:4px;padding-left:8px;display:flex;position:relative}.lvQYKa_tab{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0 0 11px;font-size:13px;font-weight:500;line-height:16px;position:relative}.lvQYKa_tab:after{content:\"\";background:0 0;border-radius:2px;height:2px;position:absolute;bottom:1px;left:0;right:0}.lvQYKa_tabActive{color:var(--dsw-alias-state-business-primary)}.lvQYKa_tabActive:after{background:var(--dsw-alias-state-business-primary)}.lvQYKa_viewArea{flex-direction:column;flex:1;min-height:0;display:flex}.lvQYKa_composerStack{--dsh-composer-stack-gap:6px;gap:var(--dsh-composer-stack-gap);flex-direction:column;display:flex}.lvQYKa_composerSeat{--dsh-composer-text-max-height:336px;flex-direction:column;flex:none;display:flex}.lvQYKa_root[data-phase=active]{overflow:hidden}.lvQYKa_root[data-phase=active] .lvQYKa_header{flex:none}.lvQYKa_scrollBody{scrollbar-gutter:stable;flex-direction:column;flex:1;min-height:0;display:flex;overflow:hidden auto}.lvQYKa_root[data-phase=active] .lvQYKa_viewArea{flex:1 0 auto;min-height:auto}.lvQYKa_root[data-phase=active] .lvQYKa_composerSeat{z-index:7;background:linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px, var(--dsw-alias-bg-base) 36px);position:sticky;bottom:0}.lvQYKa_scrollBody:has([data-conversation-composer-overlay]){scrollbar-gutter:auto;position:relative;overflow:hidden auto}.lvQYKa_scrollBody:has([data-conversation-composer-overlay])>[data-slot=conversation\\.session]>.lvQYKa_viewArea{flex:1 1 0;min-height:0;overflow:hidden}.lvQYKa_scrollBody:has([data-conversation-composer-overlay])>.lvQYKa_composerSeat{right:var(--dsh-scrollbar-width);position:absolute;bottom:0;left:0}.lvQYKa_composerHero{width:min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%);z-index:1;align-self:center;gap:8px;padding-bottom:32px;position:relative}.lvQYKa_heroGlow{z-index:-1;aspect-ratio:1051/468;pointer-events:none;width:135.438%;position:absolute;bottom:92px;left:50%;transform:translate(-50%,50%)}.lvQYKa_heroWorkspaceRow{align-items:center;gap:2px;min-width:0;margin-top:4px;padding-left:20px;display:flex}.lvQYKa_root[data-phase=hero] .lvQYKa_scrollBody{justify-content:center;overflow-y:auto}.lvQYKa_root[data-phase=settling] .lvQYKa_composerSeat{visibility:hidden}";

},
"src/modules/conversation/skeleton/ConversationSession.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/ConversationSession.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationSessionHeader = ConversationSessionHeader;
exports.ConversationSession = ConversationSession;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Strict per-session header/body content inserted into the resident conversation layout. */
const react_1 = require("react");
const classnames_1 = __importDefault(require("../classnames"));
const ConversationRoot_styles_1 = __importDefault(require("./ConversationRoot.styles"));
const DEFAULT_VIEW_ID = 'chat';
/** Resolve by id and keep stale persisted selections on the stable Chat fallback. */
function resolveActiveView(tabs, selectedId) {
    const requestedId = selectedId ?? DEFAULT_VIEW_ID;
    return tabs.find(view => view.id === requestedId)
        ?? tabs.find(view => view.id === DEFAULT_VIEW_ID);
}
function deriveAncestry(list, id) {
    const chain = [];
    const seen = new Set();
    let cursor = id;
    while (cursor !== undefined) {
        if (seen.has(cursor))
            break;
        seen.add(cursor);
        const summary = list.byId[cursor];
        if (summary === undefined)
            break;
        chain.unshift({ id: summary.id, displayTitle: summary.displayTitle });
        if (summary.origin !== 'subagent' && summary.origin !== 'fork')
            break;
        cursor = summary.parentId;
    }
    return chain;
}
function equalBreadcrumbs(left, right) {
    return left.length === right.length
        && left.every((item, index) => {
            const other = right.at(index);
            return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle;
        });
}
/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header or visible title and tabs.
 */
function ConversationSessionHeader({ sessionId, useSession, useSessions, useStore, actions, renderSlot, views, open, t, }) {
    (0, react_1.useSyncExternalStore)(views.subscribe, views.version);
    const tabs = views.list();
    const selectedId = useStore(s => s.view);
    const active = resolveActiveView(tabs, selectedId);
    const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs);
    const composerPhase = useSession(s => s.composerPhase);
    const blank = useSession(s => s.blank);
    const hideChrome = blank && composerPhase === 'blank';
    return ((0, jsx_runtime_1.jsx)("header", { className: (0, classnames_1.default)(ConversationRoot_styles_1.default.header, hideChrome && ConversationRoot_styles_1.default.headerHidden), "aria-hidden": hideChrome || undefined, children: !hideChrome && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: ConversationRoot_styles_1.default.titleRow, children: [(0, jsx_runtime_1.jsxs)("div", { className: ConversationRoot_styles_1.default.titleCluster, children: [(0, jsx_runtime_1.jsxs)("nav", { className: ConversationRoot_styles_1.default.crumbs, "aria-label": t('session.hierarchy'), children: [ancestry.map((summary, index) => {
                                            const last = index === ancestry.length - 1;
                                            return ((0, jsx_runtime_1.jsxs)("span", { className: ConversationRoot_styles_1.default.crumbSeg, children: [index > 0 && (0, jsx_runtime_1.jsx)("span", { className: ConversationRoot_styles_1.default.crumbSep, children: "/" }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: (0, classnames_1.default)(ConversationRoot_styles_1.default.crumb, last && ConversationRoot_styles_1.default.crumbCurrent), disabled: last, onClick: () => { open(summary.id); }, children: summary.displayTitle })] }, summary.id));
                                        }), ancestry.length === 0 && (0, jsx_runtime_1.jsx)("span", { className: ConversationRoot_styles_1.default.crumbCurrent, children: sessionId })] }), (0, jsx_runtime_1.jsx)("div", { className: ConversationRoot_styles_1.default.headerActions, children: renderSlot('conversation.session.header.actions', {}) })] }), (0, jsx_runtime_1.jsx)("div", { className: ConversationRoot_styles_1.default.headerUtilities, children: renderSlot('conversation.session.header.utilities', {}) })] }), tabs.length > 1 && ((0, jsx_runtime_1.jsx)("div", { className: ConversationRoot_styles_1.default.tabs, role: "tablist", children: tabs.map(viewTab => ((0, jsx_runtime_1.jsx)("button", { type: "button", role: "tab", "aria-selected": viewTab.id === active?.id, className: (0, classnames_1.default)(ConversationRoot_styles_1.default.tab, viewTab.id === active?.id && ConversationRoot_styles_1.default.tabActive), onClick: () => { actions.setView(viewTab.id); }, children: viewTab.label }, viewTab.id))) }))] })) }));
}
/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
function ConversationSession({ sessionId, useSession, useInput, inputActions, useStore, actions, renderSlot, views, bindDraftMirror, releaseSessionImages, }) {
    (0, react_1.useSyncExternalStore)(views.subscribe, views.version);
    const tabs = views.list();
    const selectedId = useStore(s => s.view);
    const active = resolveActiveView(tabs, selectedId);
    const composerPhase = useSession(s => s.composerPhase);
    const blank = useSession(s => s.blank);
    const inputState = useInput(s => s);
    const storedDraft = useStore(s => s.draft);
    // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
    const inspect = useStore(s => s.inspect ?? null);
    (0, react_1.useEffect)(() => {
        if (inputState.draft === '' && storedDraft !== '')
            inputActions.setDraft(storedDraft);
        const unmirror = bindDraftMirror(actions.setDraft);
        return () => { unmirror(); };
        // Mount-only (deps pinned to inputActions): later store writes come from
        // the machine mirror, not this seed effect.
    }, [inputActions]);
    (0, react_1.useEffect)(() => () => {
        releaseSessionImages(sessionId);
    }, [releaseSessionImages, sessionId]);
    if (blank && composerPhase === 'blank')
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { className: ConversationRoot_styles_1.default.viewArea, children: active !== undefined && renderSlot('conversation.view', {
            inspect,
            onInspectDone: () => { actions.setInspect(null); },
        }, { only: active.id }) }));
}

},
"src/modules/conversation/skeleton/DetailsPanel.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/DetailsPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DetailsPanel = DetailsPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../../shared/runtime-types");
// DetailsPanel: close button + the selected call's args and
// result — args as JSON, the result raw except for a terminal-card call, whose
// Output section is the command's terminal card. Reads the
// selection from the shared chat
// store (conversation writes, this panel reads — the cross-registration
// share the store seat exists for) and derives the call material from the
// session snapshot — no data of its own.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const runtime_values_1 = require("../runtime-values");
const tool_node_reader_1 = require("../chat/tool-node-reader");
const DetailsPanel_styles_1 = __importDefault(require("./DetailsPanel.styles"));
/** Material of a settled result node (native call or run_code sub-dispatch). */
function settledMaterial(node, callId) {
    return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node };
}
/** Material of an in-flight call (native call or run_code sub-dispatch). */
function runningMaterial(call) {
    return { name: call.name, argsRaw: call.argsRaw, block: call };
}
function materialFor(s, callId) {
    const found = (0, tool_node_reader_1.findToolCall)(s, callId);
    if (found === undefined)
        return null;
    return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found);
}
function pretty(raw) {
    try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2) ?? raw;
    }
    catch {
        // Not JSON (streaming fragment or plain text): show verbatim.
        return raw;
    }
}
/** Flatten a settled result for the no-ui-tool fallback. */
function rawResultText(block) {
    if (!('kind' in block))
        return '';
    const parts = block.content.map(item => (0, runtime_types_1.isObjectRecord)(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(item, null, 2));
    if (parts.length === 0 && block.error !== undefined)
        parts.push(`${block.error.name}: ${block.error.code}`);
    return parts.join('\n');
}
function DetailsPanel({ useSession, useSessions, sessionId, useStore, renderSlot, closeDetails, t }) {
    const selection = useStore(s => s.selection);
    // Session workspace root: an omitted or relative terminal cwd resolves
    // against it, which the pure presenter cannot see.
    const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd);
    const callId = selection?.callId;
    // materialFor builds a fresh wrapper; shallowEqual short-circuits on its
    // stable members (result node reference rides the snapshot's structural sharing).
    const material = useSession(s => (callId === undefined ? null : materialFor(s, callId)), (a, b) => (0, runtime_values_1.shallowEqual)(a, b));
    return ((0, jsx_runtime_1.jsxs)("div", { className: DetailsPanel_styles_1.default.root, children: [(0, jsx_runtime_1.jsxs)("div", { className: DetailsPanel_styles_1.default.header, children: [(0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.title, children: selection === null ? t('details.title') : material?.name ?? selection.toolName ?? t('details.title') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: DetailsPanel_styles_1.default.close, "aria-label": t('details.close'), onClick: () => { closeDetails(); }, children: (0, jsx_runtime_1.jsx)("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }) }) })] }), (0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.body, children: selection === null || callId === undefined
                    ? (0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.empty, children: t('details.empty') })
                    : material === null
                        ? (0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.empty, children: t('details.notInWindow') })
                        : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [material.argsRaw !== null && ((0, jsx_runtime_1.jsxs)("section", { className: DetailsPanel_styles_1.default.section, children: [(0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.sectionLabel, children: t('details.input') }), (0, jsx_runtime_1.jsx)(primitives_1.CodeBlock, { code: pretty(material.argsRaw), lang: "json", copyLabel: t('copy'), copiedLabel: t('copied') })] })), (0, jsx_runtime_1.jsxs)("section", { className: DetailsPanel_styles_1.default.section, children: [(0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.sectionLabel, children: t('details.output') }), (0, jsx_runtime_1.jsx)(react_1.Fragment, { children: renderSlot('conversation.details.tool', { block: material.block, cwd: sessionCwd }, {
                                                fallback: 'kind' in material.block
                                                    ? ((0, jsx_runtime_1.jsx)("pre", { className: DetailsPanel_styles_1.default.code, "data-error": material.block.isError || undefined, children: rawResultText(material.block) }))
                                                    : (0, jsx_runtime_1.jsx)("div", { className: DetailsPanel_styles_1.default.empty, children: t('details.running') }),
                                            }) }, callId)] })] })) })] }));
}

},
"src/modules/conversation/skeleton/DetailsPanel.styles.js": function(module, exports, require) {
// source: src/modules/conversation/skeleton/DetailsPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const DetailsPanel_css_1 = __importDefault(require("./DetailsPanel.css"));
exports.default = {
    "body": "JXxdLa_body",
    "close": "JXxdLa_close",
    "code": "JXxdLa_code",
    "empty": "JXxdLa_empty",
    "header": "JXxdLa_header",
    "root": "JXxdLa_root",
    "section": "JXxdLa_section",
    "sectionLabel": "JXxdLa_sectionLabel",
    "title": "JXxdLa_title"
};
const tagId = '@xharness/dsh-client-ui-conversation/DetailsPanel.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = DetailsPanel_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/skeleton/DetailsPanel.css": function(module, exports, require) {
// source: src/modules/conversation/skeleton/DetailsPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".JXxdLa_root{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex-direction:column;min-width:0;height:100%;display:flex}.JXxdLa_header{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:8px;padding:14px 12px 12px;display:flex}.JXxdLa_title{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.JXxdLa_close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.JXxdLa_close:hover{background:var(--dsw-alias-interactive-bg-hover)}.JXxdLa_body{flex:1;min-height:0;padding:12px 16px;overflow-y:auto}.JXxdLa_empty{color:var(--dsw-alias-label-tertiary);padding:8px 0;font-size:13px;line-height:20px}.JXxdLa_section{margin-bottom:16px}.JXxdLa_sectionLabel{color:var(--dsw-alias-label-secondary);margin-bottom:6px;font-size:12px;font-weight:500;line-height:18px}.JXxdLa_code{background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:12px;margin:0;padding:16px;font-size:13px;line-height:22px}.JXxdLa_code[data-error]{color:var(--dsw-alias-state-error-primary)}";

},
"src/modules/conversation/conversation-nodes/register.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/register.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConversationNodes = registerConversationNodes;
const checkpoint_1 = require("./checkpoint");
const assistant_1 = require("./assistant");
const chat_snapshot_builder_1 = require("./chat-snapshot-builder");
const command_1 = require("./command");
const compaction_1 = require("./compaction");
const fallback_1 = require("./fallback");
const inbox_1 = require("./inbox");
const message_1 = require("./message");
const retry_1 = require("./retry");
const tool_1 = require("./tool");
const turn_error_1 = require("./turn-error");
const turn_max_tokens_1 = require("./turn-max-tokens");
const turn_tail_1 = require("./turn-tail");
/**
 * Register the Chat business Definitions and target builder contributed by this package.
 * @param ctx - owning UI Conversation context.
 */
function registerConversationNodes(ctx) {
    (0, inbox_1.registerInboxConversationNodes)(ctx);
    (0, message_1.registerMessageConversationNode)(ctx);
    (0, assistant_1.registerAssistantConversationNode)(ctx);
    (0, tool_1.registerToolConversationNode)(ctx);
    (0, command_1.registerCommandConversationNode)(ctx);
    (0, compaction_1.registerCompactionConversationNode)(ctx);
    (0, retry_1.registerRetryConversationNode)(ctx);
    (0, turn_error_1.registerTurnErrorConversationNode)(ctx);
    (0, turn_max_tokens_1.registerTurnMaxTokensConversationNode)(ctx);
    (0, checkpoint_1.registerCheckpointConversationNode)(ctx);
    (0, turn_tail_1.registerTurnTailConversationNode)(ctx);
    (0, fallback_1.registerUnknownConversationFallback)(ctx);
    (0, chat_snapshot_builder_1.registerChatConversationView)(ctx);
}

},
"src/modules/conversation/conversation-nodes/checkpoint.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/checkpoint.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpointDefinition = void 0;
exports.checkpointState = checkpointState;
exports.registerCheckpointConversationNode = registerCheckpointConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const common_1 = require("./common");
function checkpointState(event) {
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'run/checkpoint') && event.data.notice)
        return { turn: event.data.turn, seq: event.seq, time: event.time, ...event.data.notice };
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end') && event.data.reason.kind === 'max-steps')
        return { turn: event.data.turn, seq: event.seq, time: event.time, kind: 'limit', message: '已达到本轮步骤硬上限，进度已保存。发送“继续”可启动下一轮；不会重放已完成的工具。' };
    return null;
}
exports.checkpointDefinition = {
    kind: 'run-checkpoint', target: 'chat',
    match: event => checkpointState(event) ? { id: String(event.seq), role: 'start' } : null,
    start: (_ctx, match) => checkpointState(match.event), update: ctx => ctx.state,
    publication: () => 'immediate',
    buildViewNode: ctx => ctx.state ? (0, common_1.chatNode)(ctx, 'run-checkpoint', ctx.state.seq, { ...ctx.state, noticeKind: ctx.state.kind, kind: 'run-checkpoint', step: ctx.start?.location.kind === 'step' ? ctx.start.location.step.step : 0 }) : null,
};
function registerCheckpointConversationNode(ctx) { ctx.conversationEvents.register(exports.checkpointDefinition); }

},
"src/modules/conversation/contract/wire-event-codec.js": function(module, exports, require) {
// source: src/modules/conversation/contract/wire-event-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSessionEvent = isSessionEvent;
exports.validateCompactionEvent = validateCompactionEvent;
const zod_1 = require("zod");
const compaction_outcome_1 = require("../../shared/compaction-outcome");
const session_terminal_1 = require("../../shared/generated/session-terminal");
const n = zod_1.z.number(), s = zod_1.z.string(), content = zod_1.z.array(zod_1.z.unknown());
const coords = { turn: n, step: n };
const failure = zod_1.z.looseObject({ message: s, code: s });
const chunk = zod_1.z.union([
    zod_1.z.looseObject({ type: zod_1.z.literal('block-start'), index: n, blockType: s }),
    zod_1.z.looseObject({ type: zod_1.z.enum(['text-delta', 'reasoning-delta']), index: n, text: s }),
    zod_1.z.looseObject({ type: zod_1.z.literal('tool-call-delta'), index: n, id: s, name: s.optional(), argumentsDelta: s }),
    zod_1.z.looseObject({ type: zod_1.z.literal('block-end'), index: n, block: zod_1.z.unknown() }),
    zod_1.z.looseObject({ type: zod_1.z.literal('usage'), usage: zod_1.z.unknown() }),
    zod_1.z.looseObject({ type: zod_1.z.literal('finish'), reason: zod_1.z.unknown().optional() }),
]);
const dispatch = { parentCallId: s, rootCallId: s, subCallId: s, name: s, arguments: zod_1.z.unknown() };
const compact = { compactionId: s, sourceCommandId: s.optional() };
const retry = { ...coords, retryId: s, retry: n, delayMs: n, policyKey: s, provider: s, failure };
const schemas = {
    'turn/start': zod_1.z.looseObject({ turn: n }),
    'run/checkpoint': zod_1.z.looseObject({ turn: n, notice: zod_1.z.object({ kind: s, message: s }).optional() }),
    'turn/end': session_terminal_1.TurnEndDataInputSchema,
    'step/start': zod_1.z.looseObject(coords), 'step/end': zod_1.z.looseObject({ ...coords, reason: zod_1.z.unknown().optional() }),
    'assistant/chunk': zod_1.z.looseObject({ ...coords, chunk }),
    'assistant/message': zod_1.z.looseObject({ ...coords, message: zod_1.z.looseObject({ id: s, content }), usage: zod_1.z.unknown().optional(), interrupted: zod_1.z.boolean().optional() }),
    'user/message': zod_1.z.looseObject({ id: s, content, source: zod_1.z.looseObject({ kind: s }) }),
    'tool/call': zod_1.z.looseObject({ ...coords, callId: s, name: s, arguments: s }),
    'tool/result': zod_1.z.looseObject({ ...coords, message: zod_1.z.looseObject({ source: zod_1.z.looseObject({ callId: s }), content: zod_1.z.tuple([zod_1.z.looseObject({ type: zod_1.z.literal('tool-result'), content, isError: zod_1.z.boolean().optional() })]).rest(zod_1.z.unknown()) }), error: zod_1.z.object({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional() }),
    'tool/code-dispatch-start': zod_1.z.looseObject(dispatch), 'tool/code-dispatch': zod_1.z.looseObject({ ...dispatch, content: content.optional(), isError: zod_1.z.boolean().optional() }),
    'command/run': zod_1.z.looseObject({ commandId: s, name: s, args: s.optional() }),
    'command/done': zod_1.z.looseObject({ commandId: s, kind: zod_1.z.enum(['success', 'error']), text: s.optional(), sourceEventSeq: n.optional() }),
    'compaction/start': zod_1.z.looseObject(compact), 'compaction/end': zod_1.z.looseObject({ ...compact, error: s.nullable().optional(), outcome: compaction_outcome_1.CompactionEndOutcomeSchema.optional(), fingerprint: s.optional() }).refine(compaction_outcome_1.validCompactionTerminalData),
    'compaction/progress': zod_1.z.looseObject({ ...compact, progress: zod_1.z.unknown() }),
    'compaction/summary': zod_1.z.looseObject({ ...compact, summary: content, shadowedSeqs: zod_1.z.array(n), shadowedTokenCount: n }),
    'agent/inbox/spliced': zod_1.z.looseObject({ target: zod_1.z.enum(['next-turn', 'next-step']), start: n, removedCount: n.optional(), inserted: zod_1.z.array(zod_1.z.looseObject({ id: s })), outcome: zod_1.z.literal('canceled').optional() }),
    'llm/retry': zod_1.z.union([zod_1.z.looseObject({ ...retry, mode: zod_1.z.literal('normal'), maxRetries: n }), zod_1.z.looseObject({ ...retry, mode: zod_1.z.literal('always') })]),
    'llm/retry-started': zod_1.z.looseObject({ ...coords, retryId: s, retry: n }),
    unknown: zod_1.z.unknown(),
};
/** Validate just this owner-consumed DTO; preserve the immutable carrier and all foreign fields. */
function isSessionEvent(event, kind) {
    return event !== undefined && event.type === kind && schemas[kind].safeParse(event.data).success;
}
/** A recognized malformed compaction is a failed history transaction, not foreign fallback.
 * The assembler must retain the previous window and expose its retry/error state.
 */
function validateCompactionEvent(event) {
    switch (event.type) {
        case 'compaction/start':
            if (!isSessionEvent(event, 'compaction/start'))
                throw new Error('invalid compaction/start data');
            break;
        case 'compaction/progress':
            if (!isSessionEvent(event, 'compaction/progress'))
                throw new Error('invalid compaction/progress data');
            break;
        case 'compaction/summary':
            if (!isSessionEvent(event, 'compaction/summary'))
                throw new Error('invalid compaction/summary data');
            break;
        case 'compaction/end':
            if (!isSessionEvent(event, 'compaction/end'))
                throw new Error('invalid compaction/end data');
            break;
    }
}

},
"src/modules/shared/generated/session-terminal.js": function(module, exports, require) {
// source: src/modules/shared/generated/session-terminal.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnFailureSchema = exports.TurnEndReasonWireSchema = exports.TurnEndReasonInputSchema = exports.TurnEndDataInputSchema = exports.TurnEndDataSchema = exports.LegacyTurnFailureSchema = exports.LegacyTurnEndReasonSchema = exports.SESSION_TERMINAL_SCHEMA_SHA256 = exports.SESSION_TERMINAL_CONTRACT = void 0;
// GENERATED from crates/xharness-projection/src/wire.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-session-terminal-contract.mjs.
const zod_1 = require("zod");
exports.SESSION_TERMINAL_CONTRACT = "xharness-session-terminal-v1";
exports.SESSION_TERMINAL_SCHEMA_SHA256 = "746b83b5db83d153180eb2c7b3dcc476302b2efc1346b496cb47edc1692cc2c9";
exports.LegacyTurnEndReasonSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("aborted") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("stop") }), zod_1.z.looseObject({ "error": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "failure": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "kind": zod_1.z.literal("error") })]));
exports.LegacyTurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "details": zod_1.z.union([zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()), zod_1.z.null()]).optional(), "message": zod_1.z.string() }));
exports.TurnEndDataSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonWireSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndDataInputSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonInputSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndReasonInputSchema = zod_1.z.lazy(() => zod_1.z.union([exports.TurnEndReasonWireSchema, exports.LegacyTurnEndReasonSchema]));
exports.TurnEndReasonWireSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("completed") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-tokens") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("cancelled") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-steps") }), zod_1.z.looseObject({ "error": exports.TurnFailureSchema, "kind": zod_1.z.literal("error") })]));
exports.TurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "message": zod_1.z.string() }));

},
"src/modules/conversation/conversation-nodes/common.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/common.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_SYNTHETIC_SEQ_OFFSETS = void 0;
exports.contextLocation = contextLocation;
exports.chatNode = chatNode;
exports.coordinate = coordinate;
/**
 * Relative positions in one durable event's seq neighborhood: interrupted
 * Assistant, its follow-up Nodes, then follow-ups to an ordinary final. The
 * max-tokens notice sits between a closing Assistant and the turn-tail so the
 * tail stays the turn's last node and keeps its branch action enabled.
 */
exports.CHAT_SYNTHETIC_SEQ_OFFSETS = {
    interruptedAssistant: -0.9,
    interruptedFollowup: -0.8,
    maxTokensNotice: 0.05,
    finalizedFollowup: 0.1,
};
/**
 * Resolve one Context's best currently loaded event Location.
 * @param context - assembled business Context.
 * @returns start or first-match Location, otherwise unresolved.
 */
function contextLocation(context) {
    return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
}
/**
 * Build one final Chat target Node with the engine-owned stable key.
 * @param context - assembled business Context.
 * @param kind - Chat renderer dispatch key.
 * @param anchorSeq - sortable render position.
 * @param data - renderer-owned payload.
 * @param options - optional Location and visibility overrides.
 * @returns final Chat view Node.
 */
function chatNode(context, kind, anchorSeq, data, options = {}) {
    return {
        key: context.key,
        kind,
        id: context.id,
        target: 'chat',
        anchorSeq,
        location: options.location ?? contextLocation(context),
        visibility: options.visibility ?? 'visible',
        data,
    };
}
/**
 * Read a finite non-negative integer from a structurally narrowed payload.
 * @param value - untrusted payload field.
 * @returns valid coordinate, otherwise undefined.
 */
function coordinate(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

},
"src/modules/conversation/conversation-nodes/assistant.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/assistant.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assistantDefinition = void 0;
exports.registerAssistantConversationNode = registerAssistantConversationNode;
const reception_metrics_1 = require("../../shared/reception-metrics");
const wire_event_codec_1 = require("../contract/wire-event-codec");
const preparing_call_1 = require("../chat/preparing-call");
const runtime_values_1 = require("../runtime-values");
const common_1 = require("./common");
function initialState(turn, step) {
    return {
        turn,
        step,
        blocks: [],
        firstVisibleSeq: undefined,
        firstVisibleTime: undefined,
        firstTokenTime: undefined,
        hidden: false,
        final: undefined,
        usage: undefined,
    };
}
function compactBlocks(blocks) {
    return blocks.filter((block) => block !== undefined);
}
function hasVisibleContent(blocks) {
    return blocks.some((block) => {
        if (block.kind === 'tool-call')
            return false;
        if (block.kind === 'text' || block.kind === 'reasoning')
            return block.text.trim() !== '';
        return true;
    });
}
function hasInterruptionEvidence(blocks) {
    return blocks.some((block) => {
        if (block.kind === 'text' || block.kind === 'reasoning')
            return block.text.trim() !== '';
        return true;
    });
}
function resetForRetry(state) {
    return {
        ...initialState(state.turn, state.step),
        firstTokenTime: state.firstTokenTime,
        hidden: true,
    };
}
function updateChunk(state, match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/chunk'))
        return state;
    const chunk = match.event.data.chunk;
    const blocks = [...state.blocks];
    switch (chunk.type) {
        case 'block-start':
            blocks[chunk.index] = (0, runtime_values_1.emptyAssistantBlock)(chunk.blockType);
            break;
        case 'text-delta': {
            const previous = blocks[chunk.index];
            blocks[chunk.index] = { kind: 'text', text: (previous?.kind === 'text' ? previous.text : '') + chunk.text };
            break;
        }
        case 'reasoning-delta': {
            const previous = blocks[chunk.index];
            blocks[chunk.index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text };
            break;
        }
        case 'tool-call-delta': {
            const previous = blocks[chunk.index];
            const base = previous?.kind === 'tool-call'
                ? previous
                : { kind: 'tool-call', callId: '', name: '', argsRaw: '' };
            blocks[chunk.index] = {
                kind: 'tool-call',
                callId: base.callId || String(chunk.id),
                // Argument-only continuation chunks may carry an empty name.
                // Preserve the tool identity already received for this block.
                name: chunk.name || base.name,
                argsRaw: base.argsRaw + chunk.argumentsDelta,
                startedAt: base.startedAt ?? match.event.time,
            };
            break;
        }
        case 'block-end':
            blocks[chunk.index] = (0, runtime_values_1.toAssistantBlock)(chunk.block);
            break;
        case 'usage':
            return { ...state, usage: chunk.usage };
        default:
            return state;
    }
    const visible = hasVisibleContent(compactBlocks(blocks));
    const firstToken = (0, runtime_values_1.isTokenDelta)(chunk);
    return {
        ...state,
        blocks,
        hidden: visible ? false : state.hidden,
        ...visible && state.firstVisibleSeq === undefined
            ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
            : {},
        ...firstToken && state.firstTokenTime === undefined
            ? { firstTokenTime: match.event.time }
            : {},
    };
}
function closedBoundary(location) {
    if (location.kind === 'step' && location.step.status === 'closed' && location.step.end !== undefined) {
        return location.step.end;
    }
    if ((location.kind === 'step' || location.kind === 'turn')
        && location.turn.status === 'closed' && location.turn.end !== undefined) {
        return location.turn.end;
    }
    return undefined;
}
function finalNode(state, context) {
    const final = state.final;
    if ((0, wire_event_codec_1.isSessionEvent)(final?.event, 'assistant/message')) {
        const event = final.event;
        return {
            kind: 'assistant',
            seq: event.seq,
            messageId: event.data.message.id,
            time: event.time,
            turn: state.turn,
            step: state.step,
            blocks: (0, runtime_values_1.toAssistantBlocks)(event.data.message.content),
            usage: event.data.usage,
            ...((0, reception_metrics_1.messageProvenance)(event.data.message) === undefined ? {} : { provenance: (0, reception_metrics_1.messageProvenance)(event.data.message) }),
            timing: {
                stepStartTime: state.reception?.startMs ?? context.start?.event.time ?? null,
                firstTokenTime: state.reception?.firstDeltaMs ?? state.firstTokenTime ?? null,
                completedTime: state.reception?.finished ? state.reception.startMs + state.reception.elapsedMs : event.time,
                ...(state.reception === undefined ? {} : { receptionMs: state.reception.receptionMs }),
            },
            ...event.data.interrupted === true ? { interrupted: true } : {},
        };
    }
    const location = context.start?.location ?? context.matches.at(-1)?.location;
    const boundary = location === undefined ? undefined : closedBoundary(location);
    const blocks = compactBlocks(state.blocks);
    if (boundary === undefined || !hasInterruptionEvidence(blocks))
        return undefined;
    return {
        kind: 'assistant',
        seq: boundary.seq + common_1.CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
        time: boundary.time,
        turn: state.turn,
        step: state.step,
        blocks,
        interrupted: true,
    };
}
function fallbackState(context) {
    let state;
    for (const match of context.matches) {
        const r = (0, reception_metrics_1.receptionReading)(match.event);
        if (r !== null) {
            state ?? (state = initialState(r.turn, r.step));
            state = { ...state, reception: r };
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/chunk')) {
            state ?? (state = initialState(match.event.data.turn, match.event.data.step));
            state = updateChunk(state, match);
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/message')) {
            state ?? (state = initialState(match.event.data.turn, match.event.data.step));
            state = {
                ...state,
                blocks: (0, runtime_values_1.toAssistantBlocks)(match.event.data.message.content),
                hidden: false,
                final: match,
                usage: match.event.data.usage,
            };
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'llm/retry') && state !== undefined) {
            state = resetForRetry(state);
        }
    }
    return state;
}
function projectAssistant(context) {
    const state = context.state ?? fallbackState(context);
    if (state === undefined)
        return undefined;
    const settled = finalNode(state, context);
    const blocks = settled?.blocks ?? compactBlocks(state.blocks);
    const visible = hasVisibleContent(blocks) || settled === undefined && blocks.some(preparing_call_1.preparingCall);
    const status = settled?.interrupted === true
        ? 'interrupted'
        : settled === undefined ? 'running' : 'settled';
    const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0;
    const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0;
    return {
        anchorSeq,
        visible,
        settled,
        data: {
            status,
            turn: state.turn,
            step: state.step,
            blocks,
            time,
            ...state.usage === undefined ? {} : { usage: state.usage },
            ...settled === undefined ? {} : { finalNode: settled },
        },
    };
}
/** Per-step Assistant streaming/final/interruption Definition. */
exports.assistantDefinition = {
    historyReuse: 'local',
    kind: 'assistant-step',
    target: 'chat',
    match: (event) => {
        const r = (0, reception_metrics_1.receptionReading)(event);
        if (r !== null)
            return { id: `${r.turn}:${r.step}`, role: 'update' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'step/start'))
            return { id: `${event.data.turn}:${event.data.step}`, role: 'start' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'assistant/chunk')
            || ((0, wire_event_codec_1.isSessionEvent)(event, 'assistant/message') && (0, runtime_values_1.isAppendSurfaceEvent)(event))) {
            return { id: `${event.data.turn}:${event.data.step}`, role: 'update' };
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry')) {
            return { id: `${event.data.turn}:${event.data.step}`, role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'step/start'))
            throw new Error('assistant-step start requires step/start');
        return initialState(match.event.data.turn, match.event.data.step);
    },
    update: (context, match) => {
        const r = (0, reception_metrics_1.receptionReading)(match.event);
        if (r !== null)
            return { ...context.state, reception: r };
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/chunk'))
            return updateChunk(context.state, match);
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/message')) {
            return {
                ...context.state,
                blocks: (0, runtime_values_1.toAssistantBlocks)(match.event.data.message.content),
                hidden: false,
                final: match,
                usage: match.event.data.usage,
            };
        }
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'llm/retry')) {
            return resetForRetry(context.state);
        }
        return context.state;
    },
    publication: (match) => {
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'step/start'))
            return 'none';
        if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'assistant/chunk'))
            return 'immediate';
        const type = match.event.data.chunk.type;
        return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame';
    },
    buildLocationData: (context, scope) => {
        if (scope !== 'step')
            return null;
        const projected = projectAssistant(context);
        if (projected === undefined)
            return null;
        return {
            kind: 'step',
            turn: projected.data.turn,
            step: projected.data.step,
            key: 'assistant-step',
            value: projected.data,
        };
    },
    buildViewNode: (context) => {
        const projected = projectAssistant(context);
        if (projected === undefined)
            return null;
        if (projected.settled === undefined && !projected.visible) {
            const state = context.state ?? fallbackState(context);
            if (state === undefined)
                return null;
            const current = context.current.get('chat');
            // A preparing tool call can materialize a row without text/reasoning.
            // Once arguments complete or retry clears content, hide that same key
            // rather than withdrawing an already materialized target.
            if (current === undefined || current === null)
                return null;
        }
        return (0, common_1.chatNode)(context, 'assistant-step', projected.anchorSeq, projected.data, {
            visibility: projected.settled?.interrupted === true || projected.visible ? 'visible' : 'hidden',
        });
    },
};
/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerAssistantConversationNode(ctx) {
    ctx.conversationEvents.register(exports.assistantDefinition);
}

},
"src/modules/conversation/chat/preparing-call.js": function(module, exports, require) {
// source: src/modules/conversation/chat/preparing-call.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.preparingCall = preparingCall;
/** Partial tool arguments do not render a settled tool card prematurely. */
function preparingCall(block) {
    if (block.kind !== 'tool-call' || !block.name)
        return false;
    if (!block.argsRaw || block.argsRaw.length > 8192)
        return true;
    try {
        const value = JSON.parse(block.argsRaw);
        return value === null || typeof value !== 'object' || Array.isArray(value);
    }
    catch {
        return true;
    }
}

},
"src/modules/conversation/conversation-nodes/chat-snapshot-builder.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/chat-snapshot-builder.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatViewDefinition = exports.ChatSnapshotBuilder = void 0;
exports.registerChatConversationView = registerChatConversationView;
const chat_node_codec_1 = require("../contract/chat-node-codec");
const runtime_values_1 = require("../runtime-values");
const chat_nodes_1 = require("../contract/chat-nodes");
const EMPTY_KEYS = [];
const EMPTY_TURNS = [];
const EMPTY_LIST = [];
function sameReferences(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
class MutableChatNodeStore {
    constructor() {
        this.byKey = new Map();
        this.valuesCache = EMPTY_LIST;
        this.valuesDirty = false;
    }
    get(key) {
        return this.byKey.get(key);
    }
    values() {
        if (this.valuesDirty) {
            this.valuesCache = [...this.byKey.values()];
            this.valuesDirty = false;
        }
        return this.valuesCache;
    }
    replace(nodes) {
        this.byKey.clear();
        for (const node of nodes)
            this.byKey.set(node.key, node);
        this.valuesCache = [...this.byKey.values()];
        this.valuesDirty = false;
    }
    upsert(nodes) {
        let changed = false;
        for (const node of nodes) {
            if (this.byKey.get(node.key) === node)
                continue;
            this.byKey.set(node.key, node);
            changed = true;
        }
        if (changed)
            this.valuesDirty = true;
    }
}
class MutableChatLocationIndex {
    constructor() {
        this.turns = new Map();
        this.steps = new Map();
    }
    getTurn(turn) {
        return this.turns.get(turn) ?? EMPTY_KEYS;
    }
    getStep(turn, step) {
        return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS;
    }
    rebuild(order, store) {
        const turns = new Map();
        const steps = new Map();
        for (const key of order) {
            const location = store.get(key)?.location;
            if (location === undefined)
                continue;
            const coordinates = locationCoordinates(location);
            if (coordinates.turn === undefined)
                continue;
            const turnKeys = turns.get(coordinates.turn) ?? [];
            turnKeys.push(key);
            turns.set(coordinates.turn, turnKeys);
            if (coordinates.step === undefined)
                continue;
            const step = stepKey(coordinates.turn, coordinates.step);
            const stepKeys = steps.get(step) ?? [];
            stepKeys.push(key);
            steps.set(step, stepKeys);
        }
        this.turns = updateIndex(this.turns, turns);
        this.steps = updateIndex(this.steps, steps);
    }
    /** Invalidate aggregate readers when member data changes without moving. */
    touch(nodes) {
        const turns = new Set();
        const steps = new Set();
        for (const node of nodes) {
            const coordinates = locationCoordinates(node.location);
            if (coordinates.turn === undefined || !this.turns.get(coordinates.turn)?.includes(node.key))
                continue;
            turns.add(coordinates.turn);
            if (coordinates.step !== undefined)
                steps.add(stepKey(coordinates.turn, coordinates.step));
        }
        for (const turn of turns) {
            const keys = this.turns.get(turn);
            if (keys === undefined)
                continue;
            this.turns.set(turn, [...keys]);
        }
        for (const step of steps) {
            const keys = this.steps.get(step);
            if (keys === undefined)
                continue;
            this.steps.set(step, [...keys]);
        }
    }
}
function updateIndex(previous, nextMutable) {
    const next = new Map();
    const keys = new Set([...previous.keys(), ...nextMutable.keys()]);
    for (const key of keys) {
        const before = previous.get(key) ?? EMPTY_KEYS;
        const candidate = nextMutable.get(key) ?? EMPTY_KEYS;
        const value = sameReferences(before, candidate) ? before : candidate;
        if (candidate.length > 0)
            next.set(key, value);
    }
    return next;
}
function stepKey(turn, step) {
    return `${turn}:${step}`;
}
function locationCoordinates(location) {
    if (location.kind === 'step')
        return { turn: location.turn.turn, step: location.step.step };
    if (location.kind === 'turn')
        return { turn: location.turn.turn };
    return {};
}
function orderedVisible(nodes) {
    return nodes
        .filter(node => node.visibility === 'visible')
        .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key));
}
function referenceMessageSeq(node) {
    const candidate = (0, chat_node_codec_1.isChatNode)(node) ? node : undefined;
    return candidate?.kind === 'user' || candidate?.kind === 'steering'
        ? candidate.data.seq
        : undefined;
}
function followingRecall(node) {
    const candidate = (0, chat_node_codec_1.isChatNode)(node) ? node : undefined;
    if (candidate?.kind !== 'context')
        return undefined;
    return {
        messageSeq: candidate.data.seq - 1,
        labels: (0, runtime_values_1.sessionRecallLabels)(candidate.data.source),
    };
}
function withReferenceLabels(node, labels) {
    const candidate = (0, chat_node_codec_1.isChatNode)(node) ? node : undefined;
    if (candidate?.kind !== 'user' && candidate?.kind !== 'steering')
        return node;
    const current = candidate.data.referenceLabels ?? EMPTY_KEYS;
    const hasLabels = Object.hasOwn(candidate.data, 'referenceLabels');
    if (sameReferences(current, labels) && hasLabels === (labels.length > 0))
        return node;
    const data = { ...candidate.data };
    if (labels.length === 0)
        delete data.referenceLabels;
    else
        data.referenceLabels = labels;
    return { ...candidate, data };
}
/** Associates a direct message with the sourced recall event that immediately follows it. */
class ReferenceLabelProjector {
    constructor() {
        this.messagesBySeq = new Map();
        this.labelsByMessageSeq = new Map();
    }
    replace(nodes) {
        this.messagesBySeq.clear();
        this.labelsByMessageSeq.clear();
        for (const node of nodes) {
            const messageSeq = referenceMessageSeq(node);
            if (messageSeq !== undefined)
                this.messagesBySeq.set(messageSeq, node.key);
            const recall = followingRecall(node);
            if (recall !== undefined && recall.labels.length > 0) {
                this.labelsByMessageSeq.set(recall.messageSeq, recall.labels);
            }
        }
        return nodes.map((node) => {
            const messageSeq = referenceMessageSeq(node);
            return messageSeq === undefined
                ? node
                : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS);
        });
    }
    apply(upserts, store) {
        const byKey = new Map(upserts.map(node => [node.key, node]));
        const affected = new Set();
        for (const node of upserts) {
            const messageSeq = referenceMessageSeq(node);
            if (messageSeq !== undefined) {
                this.messagesBySeq.set(messageSeq, node.key);
                affected.add(messageSeq);
            }
            const recall = followingRecall(node);
            if (recall === undefined)
                continue;
            const current = this.labelsByMessageSeq.get(recall.messageSeq);
            if (recall.labels.length === 0)
                this.labelsByMessageSeq.delete(recall.messageSeq);
            else {
                this.labelsByMessageSeq.set(recall.messageSeq, current !== undefined && sameReferences(current, recall.labels) ? current : recall.labels);
            }
            affected.add(recall.messageSeq);
        }
        for (const messageSeq of affected) {
            const key = this.messagesBySeq.get(messageSeq);
            if (key === undefined)
                continue;
            const node = byKey.get(key) ?? store.get(key);
            if (node === undefined)
                continue;
            byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS));
        }
        return [...byKey.values()];
    }
}
const EMPTY_CONTRIBUTION = {
    anchorSeq: 0,
    nodes: EMPTY_LIST,
    partial: null,
    running: null,
};
function legacyContribution(raw) {
    if (!(0, chat_node_codec_1.isChatNode)(raw))
        return EMPTY_CONTRIBUTION;
    const node = raw;
    // Content-free settled Assistants remain in the finalized compatibility
    // stream so StatsLine preserves its pre-assembly step counts; hidden running
    // attempts have no final Node to contribute.
    if (raw.visibility !== 'visible' && node.kind !== 'assistant-step')
        return EMPTY_CONTRIBUTION;
    switch (node.kind) {
        case 'user':
        case 'steering':
        case 'context':
        case 'command':
        case 'compaction':
        case 'turn-error':
        case 'turn-max-tokens':
        case 'unknown':
            return { anchorSeq: node.anchorSeq, nodes: [node.data], partial: null, running: null };
        case 'assistant-step': {
            const data = node.data;
            if (data.status === 'running') {
                if (raw.visibility !== 'visible')
                    return EMPTY_CONTRIBUTION;
                return {
                    anchorSeq: node.anchorSeq,
                    nodes: EMPTY_LIST,
                    partial: { turn: data.turn, step: data.step, blocks: data.blocks },
                    running: null,
                };
            }
            return {
                anchorSeq: node.anchorSeq,
                nodes: data.finalNode === undefined ? EMPTY_LIST : [data.finalNode],
                partial: null,
                running: null,
            };
        }
        case 'tool-call': {
            const root = node.data.root;
            return (0, chat_nodes_1.isRunningTool)(root)
                ? { anchorSeq: node.anchorSeq, nodes: EMPTY_LIST, partial: null, running: root }
                : { anchorSeq: node.anchorSeq, nodes: [root], partial: null, running: null };
        }
        case 'manual-compaction': {
            const data = node.data;
            return {
                anchorSeq: node.anchorSeq,
                nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
                partial: null,
                running: null,
            };
        }
        case 'model-retry':
            return {
                anchorSeq: node.anchorSeq,
                nodes: node.data.attempts,
                partial: null,
                running: null,
            };
        case 'turn-tail':
            return EMPTY_CONTRIBUTION;
        default:
            return EMPTY_CONTRIBUTION;
    }
}
function sameContribution(left, right) {
    return left !== undefined
        && left.anchorSeq === right.anchorSeq
        && left.partial?.blocks === right.partial?.blocks
        && left.partial?.turn === right.partial?.turn
        && left.partial?.step === right.partial?.step
        && left.running === right.running
        && sameReferences(left.nodes, right.nodes);
}
/** Incremental compatibility projection for StatsLine and legacy top-level snapshot fields. */
class LegacySliceBuilder {
    constructor() {
        this.contributions = new Map();
        this.finalizedContributions = new Map();
        this.runningContributions = new Map();
        this.partialContributions = new Map();
        this.finalized = EMPTY_LIST;
        this.runningCalls = EMPTY_LIST;
        this.partial = null;
        this.turnTimings = new Map();
        this.turnEnds = new Map();
    }
    replace(nodes, timeline) {
        this.contributions.clear();
        this.finalizedContributions.clear();
        this.runningContributions.clear();
        this.partialContributions.clear();
        for (const node of nodes) {
            const contribution = legacyContribution(node);
            this.contributions.set(node.key, contribution);
            this.indexContribution(node.key, contribution);
        }
        this.rebuildFinalized();
        this.rebuildRunning();
        this.rebuildPartial();
        this.updateTimeline(timeline);
        return this.snapshot();
    }
    apply(upserts, timeline) {
        let finalizedChanged = false;
        let runningChanged = false;
        let partialChanged = false;
        for (const node of upserts) {
            const contribution = legacyContribution(node);
            const previous = this.contributions.get(node.key);
            if (sameContribution(previous, contribution))
                continue;
            finalizedChanged || (finalizedChanged = finalizedContributionChanged(previous, contribution));
            runningChanged || (runningChanged = runningContributionChanged(previous, contribution));
            partialChanged || (partialChanged = partialContributionChanged(previous, contribution));
            this.contributions.set(node.key, contribution);
            this.indexContribution(node.key, contribution);
        }
        if (finalizedChanged)
            this.rebuildFinalized();
        if (runningChanged)
            this.rebuildRunning();
        if (partialChanged)
            this.rebuildPartial();
        this.updateTimeline(timeline);
        return this.snapshot();
    }
    indexContribution(key, contribution) {
        updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0);
        updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null);
        updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null);
    }
    rebuildFinalized() {
        const finalized = [...this.finalizedContributions.values()]
            .flatMap(value => value.nodes)
            .sort((left, right) => left.seq - right.seq);
        if (!sameReferences(this.finalized, finalized))
            this.finalized = finalized;
    }
    rebuildRunning() {
        const runningCalls = [...this.runningContributions.values()]
            .sort((left, right) => left.anchorSeq - right.anchorSeq)
            .flatMap(value => value.running === null ? [] : [value.running]);
        if (!sameReferences(this.runningCalls, runningCalls))
            this.runningCalls = runningCalls;
    }
    rebuildPartial() {
        const partial = [...this.partialContributions.values()]
            .sort((left, right) => left.anchorSeq - right.anchorSeq)
            .findLast(value => value.partial !== null)?.partial ?? null;
        if (this.partial?.blocks !== partial?.blocks
            || this.partial?.turn !== partial?.turn
            || this.partial?.step !== partial?.step)
            this.partial = partial;
    }
    updateTimeline(timeline) {
        if (this.timeline === timeline)
            return;
        this.timeline = timeline;
        const turnTimings = new Map();
        const turnEnds = new Map();
        for (const turn of timeline.turns.values()) {
            if (turn.start !== undefined) {
                turnTimings.set(turn.turn, {
                    startTime: turn.start.time,
                    ...turn.end === undefined ? {} : { endTime: turn.end.time },
                });
            }
            if (turn.end !== undefined)
                turnEnds.set(turn.turn, turn.end.seq);
        }
        this.turnTimings = turnTimings;
        this.turnEnds = turnEnds;
    }
    snapshot() {
        return {
            nodes: this.finalized,
            turnTimings: this.turnTimings,
            turnEnds: this.turnEnds,
            partial: this.partial,
            runningCalls: this.runningCalls,
        };
    }
}
function updateContributionIndex(index, key, contribution, present) {
    if (present)
        index.set(key, contribution);
    else
        index.delete(key);
}
function finalizedContributionChanged(previous, next) {
    const previousNodes = previous?.nodes ?? EMPTY_LIST;
    return !sameReferences(previousNodes, next.nodes)
        || ((previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq);
}
function runningContributionChanged(previous, next) {
    return previous?.running !== next.running
        || ((previous.running !== null || next.running !== null)
            && previous.anchorSeq !== next.anchorSeq);
}
function partialContributionChanged(previous, next) {
    return previous?.partial?.blocks !== next.partial?.blocks
        || previous?.partial?.turn !== next.partial?.turn
        || previous?.partial?.step !== next.partial?.step
        || (((previous?.partial ?? null) !== null || next.partial !== null)
            && previous?.anchorSeq !== next.anchorSeq);
}
/** Incremental keyed Chat builder registered under the `chat` target. */
class ChatSnapshotBuilder {
    constructor() {
        this.store = new MutableChatNodeStore();
        this.locations = new MutableChatLocationIndex();
        this.legacy = new LegacySliceBuilder();
        this.referenceLabels = new ReferenceLabelProjector();
        this.order = EMPTY_KEYS;
        this.empty = this.snapshot({ turnOrder: EMPTY_TURNS, turns: new Map() });
    }
    replace(input) {
        const nodes = this.referenceLabels.replace(input.nodes);
        this.store.replace(nodes);
        this.order = orderedVisible(nodes).map(node => node.key);
        this.locations.rebuild(this.order, this.store);
        return this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline));
    }
    apply(input) {
        const upserts = this.referenceLabels.apply(input.upserts, this.store);
        let structural = false;
        const contentOnly = [];
        for (const node of upserts) {
            const previous = this.store.get(node.key);
            const nodeStructural = previous === undefined
                || previous.anchorSeq !== node.anchorSeq
                || previous.visibility !== node.visibility
                || locationIdentity(previous.location) !== locationIdentity(node.location);
            structural || (structural = nodeStructural);
            if (!nodeStructural)
                contentOnly.push(node);
        }
        this.store.upsert(upserts);
        if (structural) {
            const next = orderedVisible(this.store.values()).map(node => node.key);
            this.order = sameReferences(this.order, next) ? this.order : next;
            this.locations.rebuild(this.order, this.store);
        }
        this.locations.touch(contentOnly);
        return this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline));
    }
    snapshot(timeline, legacy = this.legacy.replace(EMPTY_LIST, timeline)) {
        return (0, runtime_values_1.publishChatSnapshot)({
            order: this.order,
            nodes: this.store,
            locations: this.locations,
            timeline,
            legacy,
        });
    }
}
exports.ChatSnapshotBuilder = ChatSnapshotBuilder;
function locationIdentity(location) {
    const coordinates = locationCoordinates(location);
    return `${location.kind}:${coordinates.turn ?? ''}:${coordinates.step ?? ''}`;
}
/** Chat target factory contributed to the Runtime view registry. */
exports.chatViewDefinition = {
    target: 'chat',
    create: () => new ChatSnapshotBuilder(),
};
/**
 * Register the incremental Chat target builder.
 * @param ctx - owning UI Conversation context.
 */
function registerChatConversationView(ctx) {
    ctx.conversationViews.register(exports.chatViewDefinition);
}

},
"src/modules/conversation/contract/chat-nodes.js": function(module, exports, require) {
// source: src/modules/conversation/contract/chat-nodes.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSettledTool = isSettledTool;
exports.isRunningTool = isRunningTool;
/**
 * Test whether a Tool root has settled.
 * @param block - Tool root lifecycle value.
 * @returns whether the root carries its final result.
 */
function isSettledTool(block) {
    return 'kind' in block;
}
/**
 * Test whether a Tool root is still running.
 * @param block - Tool root lifecycle value.
 * @returns whether the root lacks a final result.
 */
function isRunningTool(block) {
    return !isSettledTool(block);
}

},
"src/modules/conversation/conversation-nodes/command.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/command.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandDefinition = void 0;
exports.updateCompactionState = updateCompactionState;
exports.registerCommandConversationNode = registerCommandConversationNode;
exports.compactSource = compactSource;
exports.compactSummary = compactSummary;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const wire_guards_1 = require("../wire-guards");
const runtime_types_1 = require("../../shared/runtime-types");
const compaction_lifecycle_1 = require("./compaction-lifecycle");
const runtime_values_1 = require("../runtime-values");
const common_1 = require("./common");
const COMPACT_PLUGIN = 'compact';
function commandFromRun(match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'command/run'))
        throw new Error('command start requires command/run');
    const data = match.event.data;
    return {
        kind: 'command',
        seq: match.event.seq,
        time: match.event.time,
        commandId: data.commandId,
        name: data.name,
        args: data.args ?? null,
        outcome: null,
    };
}
function commandFromDone(match, previous) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'command/done'))
        throw new Error('command update requires command/done');
    const data = match.event.data;
    const sourceEventSeq = data.kind === 'success'
        && data.sourceEventSeq !== undefined
        && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
        ? data.sourceEventSeq
        : undefined;
    return {
        kind: 'command',
        seq: previous?.seq ?? match.event.seq,
        time: previous?.time ?? match.event.time,
        commandId: data.commandId,
        name: previous?.name ?? null,
        args: previous?.args ?? null,
        outcome: {
            kind: data.kind,
            ...data.text === undefined ? {} : { text: data.text },
            ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
        },
    };
}
/**
 * Read correlation identity from a compaction replacement checkpoint.
 * @param event - candidate Session event.
 * @returns correlated compaction and optional command identity.
 */
function compactSource(event) {
    if (!(0, wire_event_codec_1.isSessionEvent)(event, 'user/message') || !(0, runtime_values_1.isReplacementSurfaceEvent)(event))
        return undefined;
    const source = event.data.source;
    if (source.kind !== 'plugin' || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== 'string')
        return undefined;
    return {
        compactionId: source.compactionId,
        ...typeof source.sourceCommandId !== 'string' ? {} : { sourceCommandId: source.sourceCommandId },
    };
}
/**
 * Build the visible summary marker from optional lifecycle evidence.
 * @param match - compaction/summary Match, when loaded.
 * @param checkpoint - replacement checkpoint Match.
 * @returns final compaction summary Node data.
 */
function compactSummary(match, checkpoint) {
    let summary = null;
    let shadowedItemCount = null;
    let shadowedTokenCount = null;
    if ((0, wire_event_codec_1.isSessionEvent)(match?.event, 'compaction/summary')) {
        const data = match.event.data;
        if ((0, wire_guards_1.isUnknownArray)(data.summary)) {
            const text = data.summary
                .map((block) => (0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
                .join('');
            summary = text.trim() === '' ? null : text;
        }
        shadowedItemCount = (0, wire_guards_1.isUnknownArray)(data.shadowedSeqs)
            && data.shadowedSeqs.every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
            ? data.shadowedSeqs.length
            : null;
        shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount)
            && data.shadowedTokenCount >= 0
            ? data.shadowedTokenCount
            : null;
    }
    return {
        kind: 'compaction',
        seq: checkpoint.event.seq,
        time: checkpoint.event.time,
        summary,
        summaryEventSeq: match?.event.seq ?? null,
        shadowedItemCount,
        shadowedTokenCount,
    };
}
function fallbackState(context) {
    const lifecycle = context.matches.find(match => typeof (0, compaction_lifecycle_1.projectedCompactionView)(match.view)?.sourceCommandId === 'string' || (0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/start') && typeof match.event.data.sourceCommandId === 'string');
    if (lifecycle) {
        const view = (0, compaction_lifecycle_1.projectedCompactionView)(lifecycle.view);
        const run = context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'command/run'));
        const done = context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'command/done'));
        const commandId = view?.sourceCommandId ?? ((0, wire_event_codec_1.isSessionEvent)(lifecycle.event, 'compaction/start') ? lifecycle.event.data.sourceCommandId : undefined);
        if (commandId !== undefined) {
            const command = done ? commandFromDone(done) : run ? commandFromRun(run) : {
                kind: 'command', seq: view?.anchorSeq ?? lifecycle.event.seq, time: view?.time ?? lifecycle.event.time,
                commandId, name: 'compact', args: null, outcome: null,
            };
            return context.matches.reduce(updateCompactionState, { command });
        }
    }
    const done = context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'command/done'));
    const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined);
    const summary = context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/summary'));
    if (checkpoint === undefined)
        return done === undefined ? undefined : { command: commandFromDone(done) };
    const source = compactSource(checkpoint.event);
    if (source?.sourceCommandId === undefined)
        return done === undefined ? undefined : { command: commandFromDone(done) };
    const fallbackCommand = done === undefined
        ? {
            kind: 'command',
            seq: checkpoint.event.seq,
            time: checkpoint.event.time,
            commandId: source.sourceCommandId,
            name: 'compact',
            args: null,
            outcome: null,
        }
        : { ...commandFromDone(done), name: 'compact' };
    return {
        command: fallbackCommand,
        checkpoint,
        ...summary === undefined ? {} : { summary },
    };
}
/**
 * Fold shared compaction evidence into a Definition-owned State.
 * @param state - current business State carrying optional compaction evidence.
 * @param match - next compaction lifecycle Match.
 * @returns adopted State, preserving reference identity when the Match adds no evidence.
 */
function updateCompactionState(state, match) {
    if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/progress') && (state.end || (state.presentation !== undefined && state.presentation.phase !== 'running')))
        return state;
    const presentation = (0, compaction_lifecycle_1.projectedCompactionView)(match.view);
    let next = state;
    if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/start'))
        next = { ...state, start: match, end: undefined };
    else if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/progress'))
        next = state.end ? state : { ...state, progress: match };
    else if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/end'))
        next = { ...state, presentation: undefined, end: match };
    else if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'compaction/summary'))
        next = { ...state, summary: match };
    else if (compactSource(match.event) !== undefined)
        next = { ...state, checkpoint: match };
    return presentation === undefined ? next : { ...next, presentation };
}
/** Slash-command lifecycle, including integrated manual compaction, Definition. */
exports.commandDefinition = {
    historyReuse: 'local',
    kind: 'command',
    target: 'chat',
    match: (event, view) => {
        const projected = (0, compaction_lifecycle_1.projectedCompactionView)(view);
        if (typeof projected?.sourceCommandId === 'string')
            return { id: projected.sourceCommandId, role: 'update' };
        (0, wire_event_codec_1.validateCompactionEvent)(event);
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'command/run')) {
            return { id: String(event.data.commandId), role: 'start' };
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'command/done')) {
            return { id: String(event.data.commandId), role: 'update' };
        }
        const checkpoint = compactSource(event);
        if (checkpoint?.sourceCommandId !== undefined) {
            return { id: String(checkpoint.sourceCommandId), role: 'update' };
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'compaction/start')
            || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/progress')
            || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/summary')
            || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/end')) {
            if (event.data.sourceCommandId !== undefined) {
                return { id: String(event.data.sourceCommandId), role: 'update' };
            }
        }
        return null;
    },
    start: (_context, match) => {
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'command/run'))
            return { command: commandFromRun(match) };
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'command/done'))
            return { command: commandFromDone(match) };
        const view = (0, compaction_lifecycle_1.projectedCompactionView)(match.view);
        const sourceCommandId = view?.sourceCommandId ?? sourceCommandIdOf(match);
        if (sourceCommandId === undefined)
            throw new Error('manual compaction requires command identity');
        const command = { kind: 'command', seq: view?.anchorSeq ?? match.event.seq, time: view?.time ?? match.event.time,
            commandId: sourceCommandId, name: 'compact', args: null, outcome: null };
        return updateCompactionState({ command }, match);
    },
    update: (context, match) => {
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'command/done')) {
            return { ...context.state, command: commandFromDone(match, context.state.command) };
        }
        return updateCompactionState(context.state, match);
    },
    buildViewNode: (context) => {
        const state = context.state ?? fallbackState(context);
        if (state === undefined)
            return null;
        if (state.command.name !== 'compact') {
            return (0, common_1.chatNode)(context, 'command', state.command.seq, state.command);
        }
        const compaction = state.checkpoint === undefined
            ? (0, compaction_lifecycle_1.compactLifecycle)(state)
            : { ...compactSummary(state.summary, state.checkpoint), progress: (0, compaction_lifecycle_1.compactProgress)((0, wire_event_codec_1.isSessionEvent)(state.progress?.event, 'compaction/progress') ? state.progress.event.data.progress : undefined) };
        const data = { command: state.command, compaction };
        return (0, common_1.chatNode)(context, 'manual-compaction', compaction?.seq ?? state.command.seq, data);
    },
};
/**
 * Register the command lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerCommandConversationNode(ctx) {
    ctx.conversationEvents.register(exports.commandDefinition);
}
function sourceCommandIdOf(match) {
    const value = match.event.data;
    return typeof value === 'object' && value !== null && 'sourceCommandId' in value && typeof value.sourceCommandId === 'string' ? value.sourceCommandId : undefined;
}

},
"src/modules/conversation/conversation-nodes/compaction-lifecycle.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/compaction-lifecycle.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compactProgress = compactProgress;
exports.projectedCompactionView = projectedCompactionView;
exports.compactLifecycle = compactLifecycle;
const compaction_outcome_1 = require("../../shared/compaction-outcome");
const wire_event_codec_1 = require("../contract/wire-event-codec");
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function progressStage(value) {
    return value === 'preparing' || value === 'summarizing' || value === 'splitting' || value === 'merging'
        || value === 'retrying' || value === 'paused' || value === 'validating' || value === 'committing';
}
function isCompactProgress(value) {
    if (!record(value) || !progressStage(value.stage))
        return false;
    if (!count(value.calls) || !count(value.completedParts) || !count(value.splits) || !count(value.retries))
        return false;
    if (value.completedParts > value.calls)
        return false;
    for (const key of ['delayMs', 'inputTokensBefore', 'inputTokensAfter'])
        if (value[key] != null && !count(value[key]))
            return false;
    return true;
}
function compactProgress(value) {
    return isCompactProgress(value) ? value : undefined;
}
/** xh-compaction-view-model/v2: validated wire presentation survives history cuts. */
function projectedCompactionView(envelope) {
    if (envelope?.for !== 'compaction' || envelope.view.schemaVersion !== 1)
        return undefined;
    const view = envelope.view;
    if (view.outcome !== undefined && !(0, compaction_outcome_1.isCompactionEndOutcome)(view.outcome))
        return undefined;
    if (view.outcome !== undefined && (!(0, compaction_outcome_1.validCompactionTerminalData)({ outcome: view.outcome, error: typeof view.error === 'string' || view.error === null ? view.error : undefined }) || (view.error !== undefined && view.error !== null && typeof view.error !== 'string')))
        return undefined;
    if (view.outcome !== undefined && (view.phase === 'running' || view.phase !== (0, compaction_outcome_1.compactionTerminalPhase)(view.outcome, typeof view.error === 'string' ? view.error : undefined)))
        return undefined;
    if (typeof view.id !== 'string' || view.id === '' || !count(view.anchorSeq) || typeof view.time !== 'number' || !Number.isFinite(view.time))
        return undefined;
    const base = { id: view.id, anchorSeq: view.anchorSeq, time: view.time, progress: view.progress,
        ...(typeof view.sourceCommandId === 'string' ? { sourceCommandId: view.sourceCommandId } : {}),
        ...(typeof view.progressTime === 'number' ? { progressTime: view.progressTime } : {}),
        ...(typeof view.startedAt === 'number' ? { startedAt: view.startedAt } : {}),
        ...(typeof view.endedAt === 'number' ? { endedAt: view.endedAt } : {}),
        ...(typeof view.error === 'string' || view.error === null ? { error: view.error } : {}),
        ...((0, compaction_outcome_1.isCompactionEndOutcome)(view.outcome) ? { outcome: view.outcome } : {}),
    };
    if (view.phase === 'running' || view.phase === 'failed' || view.phase === 'skipped' || view.phase === 'cancelled')
        return { ...base, phase: view.phase };
    if (view.phase !== 'succeeded' || typeof view.summary !== 'string' || !count(view.summaryEventSeq) || !count(view.shadowedItemCount) || !count(view.shadowedTokenCount))
        return undefined;
    return { ...base, phase: view.phase, summary: view.summary, summaryEventSeq: view.summaryEventSeq, shadowedItemCount: view.shadowedItemCount, shadowedTokenCount: view.shadowedTokenCount };
}
/** Minimal durable lifecycle. No browser progress simulation or per-row timers. */
function compactLifecycle(state) {
    const view = state.presentation, start = state.start?.event, end = state.end?.event, update = state.progress?.event;
    const progress = compactProgress(view?.progress ?? ((0, wire_event_codec_1.isSessionEvent)(update, 'compaction/progress') ? update.data.progress : undefined));
    if (view?.phase === 'succeeded')
        return { kind: 'compaction', seq: view.anchorSeq, time: view.time, summary: view.summary,
            summaryEventSeq: view.summaryEventSeq, shadowedItemCount: view.shadowedItemCount, shadowedTokenCount: view.shadowedTokenCount,
            progress, startedAt: view.startedAt, endedAt: view.endedAt,
        };
    if (!view && !start)
        return null;
    const rawEnd = (0, wire_event_codec_1.isSessionEvent)(end, 'compaction/end') ? end.data : undefined;
    const outcome = view?.outcome ?? rawEnd?.outcome;
    const terminal = (0, compaction_outcome_1.compactionTerminalPhase)(outcome, view?.error ?? rawEnd?.error);
    // A succeeded raw end still needs its checkpoint; do not manufacture a
    // committed summary if a legacy page is missing replacement evidence.
    const status = view?.phase ?? (end ? terminal === 'succeeded' ? 'failed' : terminal : 'running');
    return { kind: 'compaction', status,
        seq: view?.anchorSeq ?? start?.seq ?? 0, time: view?.time ?? start?.time ?? 0, progress,
        progressTime: view?.progressTime ?? update?.time,
        error: view?.error ?? rawEnd?.error ?? null,
        ...(outcome === undefined ? {} : { outcome }),
        endedAt: view?.endedAt ?? end?.time,
    };
}

},
"src/modules/conversation/conversation-nodes/compaction.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/compaction.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compactionDefinition = void 0;
exports.registerCompactionConversationNode = registerCompactionConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const common_1 = require("./common");
const command_1 = require("./command");
const compaction_lifecycle_1 = require("./compaction-lifecycle");
function fallbackState(context) {
    return context.matches.reduce(command_1.updateCompactionState, {});
}
/** Automatic compaction progress, recovery and landed checkpoint contribution. */
exports.compactionDefinition = {
    historyReuse: 'local', kind: 'compaction', target: 'chat',
    match: (event, view) => {
        if (view?.for === 'compaction') {
            const presentation = (0, compaction_lifecycle_1.projectedCompactionView)(view);
            if (typeof presentation?.sourceCommandId === 'string')
                return null;
            if (presentation !== undefined)
                return { id: presentation.id, role: (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/progress') ? 'update' : presentation.phase === 'running' ? 'start' : 'update' };
        }
        (0, wire_event_codec_1.validateCompactionEvent)(event);
        const checkpoint = (0, command_1.compactSource)(event);
        if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined)
            return { id: checkpoint.compactionId, role: 'update' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'compaction/start') || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/progress') || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/summary') || (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/end')) {
            if (event.data.sourceCommandId !== undefined)
                return null;
            const compactionId = event.data.compactionId;
            if (typeof compactionId !== 'string' || compactionId === '')
                return null;
            return { id: compactionId, role: (0, wire_event_codec_1.isSessionEvent)(event, 'compaction/start') ? 'start' : 'update' };
        }
        return null;
    },
    start: (_context, match) => match === undefined ? {} : (0, command_1.updateCompactionState)({}, match),
    update: (context, match) => (0, command_1.updateCompactionState)(context.state, match),
    buildViewNode: context => {
        const state = context.state ?? fallbackState(context);
        if (state.checkpoint && !state.presentation) {
            const data = { ...(0, command_1.compactSummary)(state.summary, state.checkpoint), progress: (0, compaction_lifecycle_1.compactProgress)((0, wire_event_codec_1.isSessionEvent)(state.progress?.event, 'compaction/progress') ? state.progress.event.data.progress : undefined) };
            return (0, common_1.chatNode)(context, 'compaction', data.seq, data);
        }
        const data = (0, compaction_lifecycle_1.compactLifecycle)(state);
        return data ? (0, common_1.chatNode)(context, 'compaction', data.seq, data) : null;
    },
};
function registerCompactionConversationNode(ctx) { ctx.conversationEvents.register(exports.compactionDefinition); }

},
"src/modules/conversation/conversation-nodes/fallback.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/fallback.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unknownFallbackDefinition = void 0;
exports.registerUnknownConversationFallback = registerUnknownConversationFallback;
const runtime_values_1 = require("../runtime-values");
const common_1 = require("./common");
/** Unclaimed append-surface fallback Definition. */
exports.unknownFallbackDefinition = {
    kind: 'unknown-surface',
    target: 'chat',
    match: event => (0, runtime_values_1.isAppendSurfaceEvent)(event)
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({
        kind: 'unknown',
        seq: match.event.seq,
        time: match.event.time,
        type: match.event.type,
        data: match.event.data,
    }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : (0, common_1.chatNode)(context, 'unknown', context.state.seq, context.state),
};
/**
 * Register the unmatched append-surface fallback contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerUnknownConversationFallback(ctx) {
    ctx.conversationEvents.registerFallback(exports.unknownFallbackDefinition);
}

},
"src/modules/conversation/conversation-nodes/inbox.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/inbox.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextStepInboxDefinition = exports.nextTurnInboxDefinition = void 0;
exports.registerInboxConversationNodes = registerInboxConversationNodes;
exports.isInboxState = isInboxState;
const runtime_types_1 = require("../../shared/runtime-types");
const wire_guards_1 = require("../wire-guards");
const wire_event_codec_1 = require("../contract/wire-event-codec");
function applySplice(previous, splice) {
    const old = isInboxState(previous?.state) ? previous.state : undefined;
    const pending = [...(old?.pending ?? [])];
    const claimed = new Set(old?.claimed ?? []);
    // Legacy envelopes can still contain bodies; this fold owns identities only.
    const inserted = splice.inserted.map(({ id }) => ({ id }));
    const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...inserted);
    if (splice.target === 'next-step') {
        for (const identity of removed) {
            if (splice.outcome === 'canceled')
                claimed.delete(identity.id);
            else
                claimed.add(identity.id);
        }
    }
    // Reinsertion is a pending identity, not consumption of that same input.
    for (const identity of splice.inserted)
        claimed.delete(identity.id);
    return { pending, claimed };
}
function inboxDefinition(target) {
    const kind = `inbox-${target}`;
    return {
        kind,
        match: event => (0, wire_event_codec_1.isSessionEvent)(event, 'agent/inbox/spliced')
            && event.data.target === target
            ? { id: String(event.seq), role: 'start' }
            : null,
        start: (_context, match, reader) => {
            if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'agent/inbox/spliced'))
                throw new Error(`${kind} start requires agent/inbox/spliced`);
            return applySplice(reader.previous(kind), match.event.data);
        },
        update: context => context.state,
        publication: () => 'none',
    };
}
/** Cumulative next-turn inbox splice Definition. */
exports.nextTurnInboxDefinition = inboxDefinition('next-turn');
/** Cumulative next-step inbox splice Definition used to classify steering. */
exports.nextStepInboxDefinition = inboxDefinition('next-step');
/**
 * Register the two durable Inbox-state contributions.
 * @param ctx - owning UI Conversation context.
 */
function registerInboxConversationNodes(ctx) {
    ctx.conversationEvents.register(exports.nextTurnInboxDefinition);
    ctx.conversationEvents.register(exports.nextStepInboxDefinition);
}
function isUnknownSet(value) { return value instanceof Set; }
function isInboxState(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && (0, wire_guards_1.isUnknownArray)(value.pending)
        && value.pending.every(item => (0, runtime_types_1.isObjectRecord)(item) && typeof item.id === 'string')
        && isUnknownSet(value.claimed) && Array.from(value.claimed).every(id => typeof id === 'string');
}

},
"src/modules/conversation/conversation-nodes/message.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/message.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageDefinition = void 0;
exports.registerMessageConversationNode = registerMessageConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const runtime_values_1 = require("../runtime-values");
const inbox_1 = require("./inbox");
const common_1 = require("./common");
function isCompactionCheckpoint(event) {
    if (!(0, wire_event_codec_1.isSessionEvent)(event, 'user/message') || !(0, runtime_values_1.isReplacementSurfaceEvent)(event))
        return false;
    const source = event.data.source;
    return source.kind === 'plugin' && source.plugin === 'compact';
}
/** User, steering, and injected-context message classification Definition. */
exports.messageDefinition = {
    historyReuse: 'local',
    kind: 'input-message',
    target: 'chat',
    match: event => (0, wire_event_codec_1.isSessionEvent)(event, 'user/message')
        && (0, runtime_values_1.isAppendSurfaceEvent)(event)
        && !isCompactionCheckpoint(event)
        ? { id: String(event.data.id), role: 'start' }
        : null,
    start: (_context, match, reader) => {
        if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'user/message'))
            throw new Error('input-message start requires user/message');
        const event = match.event;
        if (event.data.source.kind !== 'user') {
            return {
                kind: 'context',
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
                provenance: (0, runtime_values_1.contextProvenance)(event.data.source),
                form: (0, runtime_values_1.contextForm)(event.data.source),
            };
        }
        const previous = reader.previous('inbox-next-step')?.state;
        const claimed = (0, inbox_1.isInboxState)(previous) && previous.claimed.has(String(event.data.id));
        return claimed
            ? {
                kind: 'steering',
                messageId: event.data.id,
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
            }
            : {
                kind: 'user',
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
            };
    },
    update: context => context.state,
    buildViewNode: (context) => {
        if (context.state === undefined)
            return null;
        return (0, common_1.chatNode)(context, context.state.kind, context.state.seq, context.state);
    },
};
/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerMessageConversationNode(ctx) {
    ctx.conversationEvents.register(exports.messageDefinition);
}

},
"src/modules/conversation/conversation-nodes/retry.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/retry.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryDefinition = void 0;
exports.updateRetryState = updateRetryState;
exports.registerRetryConversationNode = registerRetryConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const common_1 = require("./common");
function scheduledNode(match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'llm/retry'))
        return undefined;
    return {
        kind: 'model-retry',
        seq: match.event.seq,
        time: match.event.time,
        retryState: 'scheduled',
        ...match.event.data,
    };
}
/** A scheduled attempt is cancelled once either owning boundary closes. */
function isClosed(location) {
    return (location.kind === 'step' && location.step.status === 'closed')
        || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed');
}
/** Replay and history cuts preserve observed attempts without inventing facts. */
function updateRetryState(state, match) {
    const event = match.event;
    if (!(0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry') && !(0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry-started'))
        return state;
    const attempts = state?.attempts ?? [];
    const index = attempts.findIndex(attempt => attempt.retry === event.data.retry);
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry')) {
        const node = scheduledNode(match);
        if (node === undefined)
            return state;
        const next = index < 0 ? [...attempts, node] : attempts.map((old, at) => at === index ? { ...node, retryState: old.retryState } : old);
        return { turn: event.data.turn, step: event.data.step, attempts: next };
    }
    const old = attempts[index];
    const started = old === undefined ? {
        kind: 'model-retry', seq: event.seq, time: event.time, ...event.data, retryState: 'started', partial: true,
    } : { ...old, retryState: 'started' };
    return { turn: event.data.turn, step: event.data.step, attempts: index < 0 ? [...attempts, started] : attempts.map((old, at) => at === index ? started : old) };
}
/** Producer-correlated model retry chain Definition. */
exports.retryDefinition = {
    historyReuse: 'local', kind: 'model-retry', target: 'chat',
    match: event => {
        if (!(0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry') && !(0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry-started'))
            return null;
        const id = event.data.retryId;
        return typeof id === 'string' && id !== '' ? { id, role: (0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry') && event.data.retry === 1 ? 'start' : 'update' } : null;
    },
    start: (_context, match) => updateRetryState(undefined, match),
    update: (context, match) => updateRetryState(context.state, match),
    buildViewNode: (context) => {
        const state = context.state ?? context.matches.reduce(updateRetryState, undefined);
        if (state === undefined || state.attempts.length === 0)
            return null;
        const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
        const stateAttempts = state.attempts;
        const attempts = stateAttempts.map((attempt, index) => index === stateAttempts.length - 1
            && attempt.retryState === 'scheduled'
            && isClosed(location)
            ? { ...attempt, retryState: 'cancelled' }
            : attempt);
        const current = attempts.at(-1);
        if (current === undefined)
            return null;
        const data = { attempts, current };
        return (0, common_1.chatNode)(context, 'model-retry', attempts[0]?.seq ?? current.seq, data);
    },
};
/**
 * Register the correlated model-retry business contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerRetryConversationNode(ctx) {
    ctx.conversationEvents.register(exports.retryDefinition);
}

},
"src/modules/conversation/conversation-nodes/tool.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/tool.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolDefinition = void 0;
exports.registerToolConversationNode = registerToolConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const runtime_values_1 = require("../runtime-values");
const common_1 = require("./common");
const MAX_DEPTH = 256;
const projectedBlocks = new WeakMap();
function jsonArguments(value) {
    return JSON.stringify(value);
}
function rootCall(match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'tool/call'))
        throw new Error('tool-call start requires tool/call');
    return {
        callId: String(match.event.data.callId),
        name: match.event.data.name,
        argsRaw: match.event.data.arguments,
        turn: match.event.data.turn,
        step: match.event.data.step,
        time: match.event.time,
        callView: match.view?.for === 'call' ? match.view.view : null,
        subCalls: [],
    };
}
function rootResult(match, previous) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'tool/result'))
        return undefined;
    const result = match.event.data.message.content[0];
    return {
        kind: 'tool-result',
        seq: match.event.seq,
        time: match.event.time,
        callId: String(match.event.data.message.source.callId),
        call: previous === undefined ? null : { name: previous.name, argsRaw: previous.argsRaw },
        callTime: previous?.time ?? null,
        content: result.content,
        isError: result.isError === true,
        ...match.event.data.error === undefined ? {} : { error: match.event.data.error },
        meta: match.event.data.meta,
        callView: previous?.callView ?? null,
        resultView: match.view?.for === 'result' ? match.view.view : null,
        subCalls: [],
    };
}
function childCall(match, data) {
    return {
        callId: data.subCallId,
        name: data.name,
        argsRaw: jsonArguments(data.arguments),
        turn: locationTurn(match),
        step: locationStep(match),
        time: match.event.time,
        callView: null,
        subCalls: [],
    };
}
function childResult(match, data, previous) {
    return {
        kind: 'tool-result',
        seq: match.event.seq,
        time: match.event.time,
        callId: data.subCallId,
        call: { name: data.name, argsRaw: jsonArguments(data.arguments) },
        callTime: previous?.time ?? null,
        content: data.content ?? [],
        isError: data.isError === true,
        callView: null,
        resultView: null,
        subCalls: [],
    };
}
function locationTurn(match) {
    return match.location.kind === 'step' || match.location.kind === 'turn' ? match.location.turn.turn : 0;
}
function locationStep(match) {
    return match.location.kind === 'step' ? match.location.step.step : 0;
}
function acceptsEdge(state, parent, child) {
    if (parent === child || state.parents.has(child))
        return false;
    let cursor = parent;
    let parentDepth = 0;
    const ancestors = new Set();
    while (cursor !== undefined) {
        if (cursor === child || ancestors.has(cursor))
            return false;
        ancestors.add(cursor);
        parentDepth++;
        cursor = state.parents.get(cursor);
    }
    const pending = [{ callId: child, depth: 1 }];
    const descendants = new Set();
    let subtreeDepth = 0;
    for (const candidate of pending) {
        if (descendants.has(candidate.callId))
            return false;
        descendants.add(candidate.callId);
        subtreeDepth = Math.max(subtreeDepth, candidate.depth);
        for (const nested of state.children.get(candidate.callId) ?? []) {
            pending.push({ callId: nested.callId, depth: candidate.depth + 1 });
        }
    }
    return parentDepth + subtreeDepth <= MAX_DEPTH;
}
function updateDispatch(state, match) {
    const event = match.event;
    if (!(0, wire_event_codec_1.isSessionEvent)(event, 'tool/code-dispatch-start') && !(0, wire_event_codec_1.isSessionEvent)(event, 'tool/code-dispatch'))
        return state;
    const data = event.data;
    const parentCallId = String(data.parentCallId);
    const subCallId = String(data.subCallId);
    const siblings = state.children.get(parentCallId) ?? [];
    const index = siblings.findIndex(candidate => candidate.callId === subCallId);
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/code-dispatch-start')) {
        if (index >= 0 || !acceptsEdge(state, parentCallId, subCallId))
            return state;
        const children = new Map(state.children);
        children.set(parentCallId, [...siblings, childCall(match, data)]);
        const parents = new Map(state.parents);
        parents.set(subCallId, parentCallId);
        return { ...state, children, parents };
    }
    if (index < 0 && !acceptsEdge(state, parentCallId, subCallId))
        return state;
    const previous = index < 0 ? undefined : siblings[index];
    const settled = childResult(match, data, previous);
    const children = new Map(state.children);
    children.set(parentCallId, index < 0
        ? [...siblings, settled]
        : siblings.map((child, at) => at === index ? settled : child));
    const parents = new Map(state.parents);
    if (index < 0)
        parents.set(subCallId, parentCallId);
    return { ...state, children, parents };
}
function projectBlock(block, state, interruptedAt, visited = new Set(), depth = 1) {
    if (visited.has(block.callId) || depth > MAX_DEPTH)
        return { ...block, subCalls: [] };
    const nextVisited = new Set(visited);
    nextVisited.add(block.callId);
    const children = (state.children.get(block.callId) ?? block.subCalls)
        .map(child => projectBlock(child, state, interruptedAt, nextVisited, depth + 1));
    const interruptionSeq = 'kind' in block ? undefined : interruptedAt?.seq;
    const interruptionTime = 'kind' in block ? undefined : interruptedAt?.time;
    const cached = projectedBlocks.get(block);
    if (cached !== undefined
        && cached.interruptionSeq === interruptionSeq
        && cached.interruptionTime === interruptionTime
        && sameReferences(cached.children, children)) {
        return cached.value;
    }
    const projected = 'kind' in block || interruptedAt === undefined
        ? sameReferences(block.subCalls, children) ? block : { ...block, subCalls: children }
        : {
            kind: 'tool-result',
            seq: interruptedAt.seq + common_1.CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
            time: interruptedAt.time,
            callId: block.callId,
            call: { name: block.name, argsRaw: block.argsRaw },
            callTime: block.time,
            content: [],
            isError: true,
            error: { name: 'Interrupted', code: 'interrupted' },
            callView: block.callView,
            resultView: null,
            subCalls: children,
        };
    projectedBlocks.set(block, { children, interruptionSeq, interruptionTime, value: projected });
    return projected;
}
function sameReferences(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function interruption(context) {
    const location = context.start?.location;
    if (location?.kind === 'step' && location.step.status === 'closed')
        return location.step.end;
    if ((location?.kind === 'step' || location?.kind === 'turn') && location.turn.status === 'closed') {
        return location.turn.end;
    }
    return undefined;
}
function fallbackState(context) {
    const match = context.matches.find(candidate => (0, wire_event_codec_1.isSessionEvent)(candidate.event, 'tool/result'));
    const root = match === undefined ? undefined : rootResult(match);
    if (root === undefined)
        return undefined;
    let state = { root, children: new Map(), parents: new Map() };
    for (const candidate of context.matches)
        state = updateDispatch(state, candidate);
    return state;
}
/** Root Tool lifecycle and nested Code Dispatch Definition. */
exports.toolDefinition = {
    historyReuse: 'local',
    kind: 'tool-call',
    target: 'chat',
    match: (event) => {
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/call'))
            return { id: String(event.data.callId), role: 'start' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/result') && (0, runtime_values_1.isAppendSurfaceEvent)(event)) {
            return { id: String(event.data.message.source.callId), role: 'update' };
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/code-dispatch-start') || (0, wire_event_codec_1.isSessionEvent)(event, 'tool/code-dispatch')) {
            const rootCallId = event.data.rootCallId;
            return typeof rootCallId === 'string' && rootCallId !== ''
                ? { id: rootCallId, role: 'update' }
                : null;
        }
        return null;
    },
    start: (_context, match) => ({ root: rootCall(match), children: new Map(), parents: new Map() }),
    update: (context, match) => {
        if ((0, wire_event_codec_1.isSessionEvent)(match.event, 'tool/result')) {
            const running = 'kind' in context.state.root ? undefined : context.state.root;
            const result = rootResult(match, running);
            return result === undefined ? context.state : { ...context.state, root: result };
        }
        return updateDispatch(context.state, match);
    },
    buildViewNode: (context) => {
        const state = context.state ?? fallbackState(context);
        if (state === undefined)
            return null;
        const projected = projectBlock(state.root, state, interruption(context));
        const anchor = context.start?.event.seq
            ?? ('kind' in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0);
        return (0, common_1.chatNode)(context, 'tool-call', anchor, { root: projected });
    },
};
/**
 * Register the root Tool lifecycle and nested-subcall contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerToolConversationNode(ctx) {
    ctx.conversationEvents.register(exports.toolDefinition);
}

},
"src/modules/conversation/conversation-nodes/turn-error.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/turn-error.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnErrorDefinition = void 0;
exports.registerTurnErrorConversationNode = registerTurnErrorConversationNode;
const wire_event_codec_1 = require("../contract/wire-event-codec");
const runtime_values_1 = require("../runtime-values");
const common_1 = require("./common");
function lastStep(context) {
    const location = context.start?.location ?? context.matches[0]?.location;
    if (location?.kind !== 'turn' && location?.kind !== 'step')
        return 0;
    return location.turn.steps.at(-1)?.step ?? 0;
}
function retryTurn(event) {
    return (0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry') || (0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry-started')
        ? event.data.turn
        : undefined;
}
function failureFrom(match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end') || match.event.data.reason.kind !== 'error')
        return undefined;
    const reason = match.event.data.reason;
    const failure = reason.error ?? ('failure' in reason ? reason.failure : undefined);
    if (failure === undefined || failure === null)
        return undefined;
    return {
        seq: match.event.seq,
        time: match.event.time,
        message: (0, runtime_values_1.displayFailureMessage)(failure),
        code: failure.code,
    };
}
function fallbackState(context) {
    const end = context.matches.find(match => failureFrom(match) !== undefined);
    if (!(0, wire_event_codec_1.isSessionEvent)(end?.event, 'turn/end'))
        return undefined;
    const failure = failureFrom(end);
    if (failure === undefined)
        return undefined;
    const turn = end.event.data.turn;
    return {
        turn,
        hidden: context.matches.some(match => retryTurn(match.event) === turn),
        failure,
    };
}
/** Terminal turn failure Definition, suppressed when the turn owns a retry chain. */
exports.turnErrorDefinition = {
    kind: 'turn-error',
    target: 'chat',
    match: (event) => {
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/start'))
            return { id: String(event.data.turn), role: 'start' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end') && event.data.reason.kind === 'error') {
            return { id: String(event.data.turn), role: 'update' };
        }
        const turn = retryTurn(event);
        return turn === undefined ? null : { id: String(turn), role: 'update' };
    },
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/start'))
            throw new Error('turn-error start requires turn/start');
        return { turn: match.event.data.turn, hidden: false };
    },
    update: (context, match) => {
        const failure = failureFrom(match);
        if (failure !== undefined)
            return { ...context.state, failure };
        return retryTurn(match.event) === context.state.turn
            ? { ...context.state, hidden: true }
            : context.state;
    },
    buildViewNode: (context) => {
        const state = context.state ?? fallbackState(context);
        if (state?.failure === undefined)
            return null;
        const failure = state.failure;
        const node = {
            kind: 'turn-error',
            seq: failure.seq,
            time: failure.time,
            turn: state.turn,
            step: lastStep(context),
            message: failure.message,
            ...failure.code === undefined ? {} : { code: failure.code },
        };
        if (!state.hidden)
            return (0, common_1.chatNode)(context, 'turn-error', node.seq, node);
        const current = context.current.get('chat');
        return current === undefined || current === null
            ? null
            : (0, common_1.chatNode)(context, 'turn-error', node.seq, node, { visibility: 'hidden' });
    },
};
/**
 * Register the terminal Turn-error business contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerTurnErrorConversationNode(ctx) {
    ctx.conversationEvents.register(exports.turnErrorDefinition);
}

},
"src/modules/conversation/conversation-nodes/turn-max-tokens.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/turn-max-tokens.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnMaxTokensDefinition = void 0;
exports.registerTurnMaxTokensConversationNode = registerTurnMaxTokensConversationNode;
const chat_node_codec_1 = require("../contract/chat-node-codec");
const wire_event_codec_1 = require("../contract/wire-event-codec");
const common_1 = require("./common");
function lastStep(context) {
    const location = context.start?.location ?? context.matches[0]?.location;
    if (location?.kind !== 'turn' && location?.kind !== 'step')
        return 0;
    return location.turn.steps.at(-1)?.step ?? 0;
}
/**
 * Anchor the notice between the closing Assistant and the turn-tail so the
 * tail stays the turn's last Chat node and keeps its branch action enabled.
 * Without a closing text Assistant there is no branch action to protect, and
 * the turn/end seq keeps the notice at the truncation point.
 */
function noticeAnchor(context, seq) {
    const location = context.start?.location ?? context.matches[0]?.location;
    if (location?.kind !== 'turn' && location?.kind !== 'step')
        return seq;
    const tail = location.turn.data.get('turn-tail');
    const closing = (0, chat_node_codec_1.isChatData)('turn-tail', tail) ? tail.closing : undefined;
    return closing === null || closing === undefined
        ? seq
        : closing.finalNode.seq + common_1.CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice;
}
function stateFrom(match) {
    if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end') || match.event.data.reason.kind !== 'max-tokens')
        return undefined;
    return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time };
}
/** Notice Definition for a turn the provider ended at its output-token cap. */
exports.turnMaxTokensDefinition = {
    kind: 'turn-max-tokens',
    target: 'chat',
    match: (event) => {
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end') && event.data.reason.kind === 'max-tokens') {
            return { id: String(event.data.turn), role: 'start' };
        }
        return null;
    },
    start: (_context, match) => {
        const state = stateFrom(match);
        if (state === undefined)
            throw new Error('turn-max-tokens start requires a max-tokens turn/end');
        return state;
    },
    update: context => context.state,
    buildViewNode: (context) => {
        const state = context.state;
        if (state === undefined)
            return null;
        const node = {
            kind: 'turn-max-tokens',
            seq: state.seq,
            time: state.time,
            turn: state.turn,
            step: lastStep(context),
        };
        return (0, common_1.chatNode)(context, 'turn-max-tokens', noticeAnchor(context, state.seq), node);
    },
};
/**
 * Register the max-tokens turn-end notice contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerTurnMaxTokensConversationNode(ctx) {
    ctx.conversationEvents.register(exports.turnMaxTokensDefinition);
}

},
"src/modules/conversation/conversation-nodes/turn-tail.js": function(module, exports, require) {
// source: src/modules/conversation/conversation-nodes/turn-tail.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnTailDefinition = void 0;
exports.registerTurnTailConversationNode = registerTurnTailConversationNode;
const runtime_types_1 = require("../../shared/runtime-types");
const chat_node_codec_1 = require("../contract/chat-node-codec");
const wire_event_codec_1 = require("../contract/wire-event-codec");
const runtime_values_1 = require("../runtime-values");
const turn_metrics_1 = require("../chat/turn-metrics");
const common_1 = require("./common");
function hasTextAssistant(event) {
    return (0, wire_event_codec_1.isSessionEvent)(event, 'assistant/message')
        && (0, runtime_values_1.isAppendSurfaceEvent)(event)
        && (0, runtime_values_1.toAssistantBlocks)(event.data.message.content)
            .some(block => block.kind === 'text' && block.text.trim() !== '');
}
function chunkHasText(event) {
    if (!(0, wire_event_codec_1.isSessionEvent)(event, 'assistant/chunk'))
        return false;
    const chunk = event.data.chunk;
    if (chunk.type === 'text-delta')
        return chunk.text.trim() !== '';
    return chunk.type === 'block-end'
        && (0, runtime_types_1.isObjectRecord)(chunk.block) && chunk.block.type === 'text'
        && typeof chunk.block.text === 'string' && chunk.block.text.trim() !== '';
}
function turnCoordinates(event) {
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'assistant/message')
        || (0, wire_event_codec_1.isSessionEvent)(event, 'assistant/chunk')
        || (0, wire_event_codec_1.isSessionEvent)(event, 'step/end')) {
        return { turn: event.data.turn, step: event.data.step };
    }
    if ((0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry'))
        return { turn: event.data.turn, step: event.data.step };
    return undefined;
}
function closingAnchor(context) {
    let anchor = context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end'))?.event.seq
        ?? context.start?.event.seq
        ?? context.matches[0]?.event.seq
        ?? 0;
    const steps = new Map();
    for (const match of context.matches) {
        const event = match.event;
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end'))
            continue;
        const coordinates = turnCoordinates(event);
        if (coordinates?.step === undefined)
            continue;
        const previous = steps.get(coordinates.step) ?? { streamedText: false, finalized: false };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'assistant/chunk')) {
            steps.set(coordinates.step, {
                ...previous,
                streamedText: previous.streamedText || chunkHasText(event),
            });
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'assistant/message')) {
            steps.set(coordinates.step, { streamedText: false, finalized: true });
            if (hasTextAssistant(event)) {
                anchor = event.seq + common_1.CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup;
            }
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry')) {
            steps.set(coordinates.step, { streamedText: false, finalized: false });
            continue;
        }
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'step/end') && previous.streamedText && !previous.finalized) {
            anchor = event.seq + common_1.CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup;
        }
    }
    return anchor;
}
function turnLocation(context) {
    const location = context.start?.location ?? context.matches[0]?.location;
    return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined;
}
function hasAnswer(data) {
    return data.finalNode !== undefined
        && data.blocks.some(block => block.kind === 'text' ? block.text.trim() !== '' : block.kind === 'image' || block.kind === 'other');
}
function tailData(context) {
    const end = context.state?.end
        ?? context.matches.find(match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end'));
    if (!(0, wire_event_codec_1.isSessionEvent)(end?.event, 'turn/end'))
        return null;
    const turn = turnLocation(context);
    if (turn === undefined)
        return null;
    const assistants = turn.steps
        .map(step => step.data.get('assistant-step'))
        .filter((candidate) => (0, chat_node_codec_1.isChatData)('assistant-step', candidate));
    const finalized = assistants
        .filter((candidate) => candidate.finalNode !== undefined)
        .sort((left, right) => left.finalNode.seq - right.finalNode.seq);
    const closing = finalized.findLast(hasAnswer) ?? null;
    let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq;
    for (const match of context.matches) {
        const event = match.event;
        const candidate = (0, wire_event_codec_1.isSessionEvent)(event, 'tool/call')
            || ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/result') && (0, runtime_values_1.isAppendSurfaceEvent)(event))
            || ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end') && event.data.reason.kind === 'error')
            || (0, wire_event_codec_1.isSessionEvent)(event, 'llm/retry')
            ? event.seq
            : undefined;
        if (candidate !== undefined && (latestTranscriptSeq === undefined || candidate > latestTranscriptSeq)) {
            latestTranscriptSeq = candidate;
        }
    }
    const metrics = (0, turn_metrics_1.deriveTurnMetrics)(finalized.map(candidate => candidate.finalNode)).get(end.event.data.turn);
    return {
        turn: end.event.data.turn,
        seq: end.event.seq,
        time: end.event.time,
        closing,
        branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
        ...metrics?.ttftMs === undefined ? {} : { ttftMs: metrics.ttftMs },
        ...metrics?.tokensPerSecond === undefined ? {} : { tokensPerSecond: metrics.tokensPerSecond },
    };
}
/** Completed-turn footer Definition independent of any Assistant row. */
exports.turnTailDefinition = {
    kind: 'turn-tail',
    target: 'chat',
    match: (event) => {
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/start'))
            return { id: String(event.data.turn), role: 'start' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'turn/end'))
            return { id: String(event.data.turn), role: 'update' };
        if ((0, wire_event_codec_1.isSessionEvent)(event, 'tool/call') || (0, wire_event_codec_1.isSessionEvent)(event, 'tool/result')) {
            return { id: String(event.data.turn), role: 'update' };
        }
        const coordinates = turnCoordinates(event);
        if (coordinates !== undefined)
            return { id: String(coordinates.turn), role: 'update' };
        return null;
    },
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/start'))
            throw new Error('turn-tail start requires turn/start');
        return { turn: match.event.data.turn };
    },
    update: (context, match) => (0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end')
        ? { ...context.state, end: match }
        : context.state,
    publication: match => (0, wire_event_codec_1.isSessionEvent)(match.event, 'turn/end') ? 'immediate' : 'none',
    buildLocationData: (context, scope) => {
        if (scope !== 'turn')
            return null;
        const value = tailData(context);
        return value === null ? null : {
            kind: 'turn',
            turn: value.turn,
            key: 'turn-tail',
            value,
        };
    },
    buildViewNode: (context) => {
        const turn = turnLocation(context);
        const data = turn?.data.get('turn-tail');
        return (0, chat_node_codec_1.isChatData)('turn-tail', data) ? (0, common_1.chatNode)(context, 'turn-tail', closingAnchor(context), data) : null;
    },
};
/**
 * Register completed-Turn footer data and its Chat node contribution.
 * @param ctx - owning UI Conversation context.
 */
function registerTurnTailConversationNode(ctx) {
    ctx.conversationEvents.register(exports.turnTailDefinition);
}

},
"src/modules/conversation/chat/register-node-renderers.js": function(module, exports, require) {
// source: src/modules/conversation/chat/register-node-renderers.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerChatNodeRenderers = registerChatNodeRenderers;
const locales_1 = require("../locales");
const CheckpointView_1 = require("./CheckpointView");
const AssistantNodeView_1 = require("./AssistantNodeView");
const CommandNodeView_1 = require("./CommandNodeView");
const MessageItem_1 = require("./MessageItem");
const TurnTailNodeView_1 = require("./TurnTailNodeView");
/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * @param ctx - owning UI Conversation context.
 */
function registerChatNodeRenderers(ctx) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'user', locale: locales_1.NS }, MessageItem_1.UserMessageNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'steering', locale: locales_1.NS }, MessageItem_1.UserMessageNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'context', locale: locales_1.NS }, MessageItem_1.ContextMessageNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', locale: locales_1.NS }, AssistantNodeView_1.AssistantNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'command',
        locale: locales_1.NS,
        children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
    }, CommandNodeView_1.CommandNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'manual-compaction', locale: locales_1.NS }, CommandNodeView_1.ManualCompactionNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'compaction', locale: locales_1.NS }, MessageItem_1.CompactionNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'model-retry', locale: locales_1.NS }, MessageItem_1.RetryNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-error', locale: locales_1.NS }, MessageItem_1.TurnErrorNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-max-tokens', locale: locales_1.NS }, MessageItem_1.TurnMaxTokensNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'run-checkpoint', locale: locales_1.NS }, CheckpointView_1.CheckpointView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'turn-tail',
        locale: locales_1.NS,
        children: {
            'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
            'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
        },
    }, TurnTailNodeView_1.TurnTailNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'unknown', locale: locales_1.NS }, MessageItem_1.UnknownNodeView));
}

},
"src/modules/conversation/chat/CheckpointView.js": function(module, exports, require) {
// source: src/modules/conversation/chat/CheckpointView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointView = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const MessageItem_styles_1 = __importDefault(require("./MessageItem.styles"));
exports.CheckpointView = (0, react_1.memo)(function CheckpointView({ node }) {
    const data = node.data;
    const title = data.noticeKind === 'limit' ? '执行已停止：步骤硬上限' : data.noticeKind === 'continued' ? '已进入下一执行阶段' : '执行检查点';
    return (0, jsx_runtime_1.jsxs)("details", { className: MessageItem_styles_1.default.contextRow, style: { padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2, #d9dde5)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #525866)' }, open: data.noticeKind === 'limit', children: [(0, jsx_runtime_1.jsx)("summary", { style: { cursor: 'pointer', fontWeight: 500 }, children: title }), (0, jsx_runtime_1.jsx)("div", { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: data.message })] });
});

},
"src/modules/conversation/chat/AssistantNodeView.js": function(module, exports, require) {
// source: src/modules/conversation/chat/AssistantNodeView.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssistantNodeView = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const chat_node_codec_1 = require("../contract/chat-node-codec");
const react_1 = require("react");
const AssistantMarkdown_1 = require("./AssistantMarkdown");
/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
exports.AssistantNodeView = (0, react_1.memo)(function AssistantNodeView({ node, useTurnData, openFile, renderMessageImages, fileMentions, t, processCollapsed, }) {
    const data = node.data;
    const turn = node.location.kind === 'turn' || node.location.kind === 'step'
        ? node.location.turn
        : undefined;
    const rawTail = useTurnData('turn-tail');
    const tail = (0, chat_node_codec_1.isChatData)('turn-tail', rawTail) ? rawTail : undefined;
    const owner = (0, react_1.useMemo)(() => {
        if (turn?.status !== 'closed' || data.finalNode === undefined)
            return undefined;
        if (tail?.closing?.finalNode.seq !== data.finalNode.seq)
            return undefined;
        return { turn, seq: data.finalNode.seq, openFile };
    }, [data.finalNode, openFile, tail, turn]);
    const mentions = (0, react_1.useMemo)(() => owner === undefined ? undefined : fileMentions(owner), [fileMentions, owner]);
    return ((0, jsx_runtime_1.jsx)(AssistantMarkdown_1.AssistantMarkdown, { blocks: data.blocks, streaming: data.status === 'running', interrupted: data.status === 'interrupted', hideReasoning: processCollapsed, renderMessageImages: renderMessageImages, mentions: mentions, t: t }));
});

},
"src/modules/conversation/chat/AssistantMarkdown.js": function(module, exports, require) {
// source: src/modules/conversation/chat/AssistantMarkdown.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssistantMarkdown = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
// AssistantMarkdown: renders assistant blocks in order — markdown text body,
// reasoning as the figma Think summary row (expand = indented gray text),
// other-block JSON fallback. Tool-call heads are NOT rendered here: the chat
// view groups them into tool rows through its keyed toolview slot (figma
// step-summary flow). Shared by finalized nodes and the streaming partial;
// the turn-level loading dots live in the chat view's tail, not here.
// Finalized content (text) nodes append IconActions once their turn ends
// (`time` is omitted for mid-turn narration and while the turn still runs);
// their branch action is enabled only when the node is also the completed
// turn's transcript tail. Think / tool-head-only nodes stay chrome-free.
const react_1 = require("react");
const primitives_1 = require("../primitives");
const ReasoningRow_1 = require("./ReasoningRow");
const AssistantMarkdown_styles_1 = __importDefault(require("./AssistantMarkdown.styles"));
const preparing_call_1 = require("./preparing-call");
const ToolArgumentProgress_1 = require("./ToolArgumentProgress");
/** Reasoning block as the Think variant summary row (figma 39:28304). */
exports.AssistantMarkdown = (0, react_1.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, hideReasoning, renderMessageImages, mentions, t, }) {
    // Stable per locale revision (t identity changes on switch): a fresh object
    // per render would rebuild MarkdownText's component table every chunk.
    const codeLabels = (0, react_1.useMemo)(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t]);
    const last = blocks.length - 1;
    // Tool-call heads render as tool rows in the chat view's grouping pass, so
    // a node that is only those heads (or empty) would paint an empty root
    // between tool groups — skip the shell unless something visible remains.
    const hasVisible = streaming
        || interrupted === true
        || blocks.some(block => block.kind !== 'tool-call');
    if (!hasVisible)
        return null;
    const rendered = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block === undefined)
            continue;
        switch (block.kind) {
            case 'text':
                rendered.push((0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: block.text, streaming: streaming, smoothStreaming: true, codeLabels: codeLabels, fileMentions: mentions }, i));
                break;
            case 'reasoning':
                if (!hideReasoning)
                    rendered.push((0, jsx_runtime_1.jsx)(ReasoningRow_1.ReasoningRow, { text: block.text, running: streaming && i === last, t: t, stateKey: i }, i));
                break;
            case 'image': {
                // Consecutive image blocks share one gallery so several images tile
                // into rows instead of each opening a one-image group of its own.
                // Keyed by the group's FIRST block index: a streaming append that
                // extends the group then only grows `images` instead of remounting
                // the gallery under a shifted key.
                const start = i;
                const group = [block];
                while (i + 1 < blocks.length) {
                    const next = blocks[i + 1];
                    if (next === undefined || next.kind !== 'image')
                        break;
                    group.push(next);
                    i += 1;
                }
                rendered.push((0, jsx_runtime_1.jsx)(react_1.Fragment, { children: renderMessageImages({
                        images: group.map(({ attachment }) => ({ attachment })),
                        align: 'start',
                    }) }, start));
                break;
            }
            // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
            case 'tool-call':
                if (streaming && (0, preparing_call_1.preparingCall)(block))
                    rendered.push((0, jsx_runtime_1.jsx)(ToolArgumentProgress_1.ToolArgumentProgress, { block: block, t: t }, `${i}:${block.callId}:${block.startedAt ?? ''}`));
                break;
            default:
                rendered.push((0, jsx_runtime_1.jsx)(primitives_1.JsonBlock, { label: t('message.unknownBlock'), payload: block.block, truncatedLabel: (total) => t('json.truncated', { total }) }, i));
        }
    }
    return ((0, jsx_runtime_1.jsx)("div", { className: AssistantMarkdown_styles_1.default.root, "data-streaming": streaming || undefined, children: (0, jsx_runtime_1.jsxs)("div", { className: AssistantMarkdown_styles_1.default.body, children: [rendered, interrupted && (0, jsx_runtime_1.jsx)("span", { className: AssistantMarkdown_styles_1.default.stopped, children: t('message.stopped') })] }) }));
});

},
"src/modules/conversation/chat/ReasoningRow.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ReasoningRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReasoningRow = ReasoningRow;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Assistant reasoning disclosure, independent of Tool-call presentation. */
const react_1 = require("react");
const primitives_1 = require("../primitives");
const use_throttled_visual_update_1 = require("./use-throttled-visual-update");
const accessibility_styles_1 = __importDefault(require("./accessibility.styles"));
const ReasoningRow_styles_1 = __importDefault(require("./ReasoningRow.styles"));
const transcript_state_1 = require("./transcript-state");
const process_mode_1 = require("./process-mode");
const reasoning_summary_1 = require("./reasoning-summary");
const use_reasoning_summary_1 = require("./use-reasoning-summary");
/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
function ReasoningRow({ text, running, t, stateKey = 0 }) {
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)(`reasoning:${stateKey}`, false);
    const processMode = (0, process_mode_1.useProcessMode)();
    const [appliedMode, setAppliedMode] = (0, transcript_state_1.useTranscriptState)(`reasoning-mode:${stateKey}`, null);
    (0, react_1.useEffect)(() => {
        if (appliedMode === processMode)
            return;
        setAppliedMode(processMode);
        setExpanded(processMode === 'expanded');
    }, [processMode, appliedMode, setAppliedMode, setExpanded]);
    const summaryRef = (0, react_1.useRef)(null);
    const preview = (0, use_reasoning_summary_1.useReasoningSummary)(text, running && !expanded);
    const summary = running ? preview.current : (0, reasoning_summary_1.firstReasoningLine)(text);
    const scheduleSummaryScroll = (0, use_throttled_visual_update_1.useThrottledVisualUpdate)(() => {
        const element = summaryRef.current;
        if (element === null)
            return;
        element.scrollLeft = running && !preview.paging ? element.scrollWidth - element.clientWidth : 0;
    });
    (0, react_1.useEffect)(() => {
        scheduleSummaryScroll();
    }, [running, preview.paging, scheduleSummaryScroll, summary]);
    return ((0, jsx_runtime_1.jsxs)("div", { className: ReasoningRow_styles_1.default.root, "data-variant": "think", "data-state": running ? 'running' : 'ok', "data-preview": preview.paging ? 'paged' : undefined, children: [running && (0, jsx_runtime_1.jsx)("span", { className: accessibility_styles_1.default.visuallyHidden, children: t('row.running') }), (0, jsx_runtime_1.jsx)(primitives_1.DisclosureRow, { rowClassName: ReasoningRow_styles_1.default.row, leadingClassName: ReasoningRow_styles_1.default.leading, titleClassName: ReasoningRow_styles_1.default.title, chevronClassName: ReasoningRow_styles_1.default.chevron, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconThinkOutline14, { size: 14 }), title: "Think", open: expanded, expandable: true, expandOnRowClick: true, onToggle: () => { setExpanded(value => !value); }, collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: ReasoningRow_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { ref: summaryRef, className: ReasoningRow_styles_1.default.summary, "data-follow-end": running && !preview.paging || undefined, "data-paging": preview.paging || undefined, children: preview.paging ? ((0, jsx_runtime_1.jsxs)("span", { className: ReasoningRow_styles_1.default.page, "data-flipping": preview.previous !== undefined || undefined, children: [preview.previous !== undefined && (0, jsx_runtime_1.jsx)("span", { className: ReasoningRow_styles_1.default.pageOut, "aria-hidden": true, children: preview.previous }), (0, jsx_runtime_1.jsx)("span", { className: ReasoningRow_styles_1.default.pageIn, children: summary })] }, preview.revision)) : summary })] })), children: (0, jsx_runtime_1.jsx)("div", { className: ReasoningRow_styles_1.default.thinkBody, children: text }) })] }));
}

},
"src/modules/conversation/chat/use-throttled-visual-update.js": function(module, exports, require) {
// source: src/modules/conversation/chat/use-throttled-visual-update.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useThrottledVisualUpdate = useThrottledVisualUpdate;
/** Frame-throttled scheduling for non-essential visual alignment. */
const react_1 = require("react");
const DEFAULT_INTERVAL_FRAMES = 3;
/**
 * Return a stable scheduler that coalesces visual updates over a frame interval.
 * @param update - DOM alignment to run after the throttle interval.
 * @param intervalFrames - frames to wait before applying the latest alignment.
 * @returns a stable function that schedules the latest update.
 */
function useThrottledVisualUpdate(update, intervalFrames = DEFAULT_INTERVAL_FRAMES) {
    const updateRef = (0, react_1.useRef)(update);
    updateRef.current = update;
    const pendingFrameRef = (0, react_1.useRef)(null);
    (0, react_1.useLayoutEffect)(() => () => {
        if (pendingFrameRef.current === null)
            return;
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
    }, []);
    return (0, react_1.useCallback)(() => {
        if (pendingFrameRef.current !== null)
            return;
        let remainingFrames = intervalFrames;
        const advance = () => {
            remainingFrames -= 1;
            if (remainingFrames > 0) {
                pendingFrameRef.current = requestAnimationFrame(advance);
                return;
            }
            pendingFrameRef.current = null;
            updateRef.current();
        };
        pendingFrameRef.current = requestAnimationFrame(advance);
    }, [intervalFrames]);
}

},
"src/modules/conversation/chat/accessibility.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/accessibility.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const accessibility_css_1 = __importDefault(require("./accessibility.css"));
exports.default = { "visuallyHidden": "kbJlva_visuallyHidden" };
const tagId = '@xharness/dsh-client-ui-conversation/accessibility.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = accessibility_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/accessibility.css": function(module, exports, require) {
// source: src/modules/conversation/chat/accessibility.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".kbJlva_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";

},
"src/modules/conversation/chat/ReasoningRow.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ReasoningRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ReasoningRow_css_1 = __importDefault(require("./ReasoningRow.css"));
exports.default = {
    "chevron": "U8JO7q_chevron",
    "dsh-reasoning-row-sweep": "U8JO7q_dsh-reasoning-row-sweep",
    "leading": "U8JO7q_leading",
    "root": "U8JO7q_root",
    "row": "U8JO7q_row",
    "separator": "U8JO7q_separator",
    "summary": "U8JO7q_summary",
    "page": "U8JO7q_page",
    "pageIn": "U8JO7q_pageIn",
    "pageOut": "U8JO7q_pageOut",
    "thinkBody": "U8JO7q_thinkBody",
    "title": "U8JO7q_title"
};
const tagId = '@xharness/dsh-client-ui-conversation/ReasoningRow.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ReasoningRow_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/ReasoningRow.css": function(module, exports, require) {
// source: src/modules/conversation/chat/ReasoningRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".U8JO7q_root{flex-direction:column;display:flex}.U8JO7q_row{position:relative;overflow:hidden}.U8JO7q_root[data-state=running] .U8JO7q_row:after{content:\"\";inset-block:0;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite U8JO7q_dsh-reasoning-row-sweep;position:absolute;left:0}@keyframes U8JO7q_dsh-reasoning-row-sweep{0%{left:-300px}90%,to{left:100%}}.U8JO7q_leading{flex-shrink:0}.U8JO7q_chevron{color:var(--dsw-alias-label-secondary)}.U8JO7q_title{font-weight:500}.U8JO7q_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.U8JO7q_summary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}.U8JO7q_summary[data-follow-end]{text-overflow:clip}.U8JO7q_thinkBody{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px}@media (prefers-reduced-motion:reduce){.U8JO7q_root[data-state=running] .U8JO7q_row:after{animation:none}}\n/* Fast collapsed reasoning: one fixed-height page, never a per-token queue. */\n.U8JO7q_root[data-preview=paged] .U8JO7q_row:after{content:none}\n.U8JO7q_summary[data-paging]{height:24px;position:relative;overflow:hidden}\n.U8JO7q_page{position:relative;display:block;width:100%;height:24px}\n.U8JO7q_pageIn,.U8JO7q_pageOut{position:absolute;inset:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.U8JO7q_page[data-flipping] .U8JO7q_pageIn{animation:U8JO7q_page-enter var(--xh-duration-reasoning-flip,180ms) var(--xh-ease-stream,cubic-bezier(.16,1,.3,1)) both}\n.U8JO7q_page[data-flipping] .U8JO7q_pageOut{animation:U8JO7q_page-leave var(--xh-duration-reasoning-flip,180ms) var(--xh-ease-stream,cubic-bezier(.16,1,.3,1)) both}\n@keyframes U8JO7q_page-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}\n@keyframes U8JO7q_page-leave{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-8px)}}\n@media(prefers-reduced-motion:reduce){.U8JO7q_pageIn,.U8JO7q_pageOut{animation:none!important}.U8JO7q_pageOut{display:none}}\n";

},
"src/modules/conversation/chat/reasoning-summary.js": function(module, exports, require) {
// source: src/modules/conversation/chat/reasoning-summary.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReasoningSummaryPresentation = exports.REASONING_FLIP_MS = exports.REASONING_PAGE_MS = exports.REASONING_FAST_CHARS_PER_SECOND = void 0;
exports.firstReasoningLine = firstReasoningLine;
exports.latestReasoningLine = latestReasoningLine;
/** Presentation-only pacing. Character growth is a visual proxy, not model TPS. */
exports.REASONING_FAST_CHARS_PER_SECOND = 120;
exports.REASONING_PAGE_MS = 800;
exports.REASONING_FLIP_MS = 180;
const RATE_WINDOW_MS = 1000;
const RATE_BUCKET_MS = 100;
const MIN_RATE_SAMPLE_MS = 200;
const SLOW_CHARS_PER_SECOND = 80;
function firstReasoningLine(text) {
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
}
function latestReasoningLine(text) {
    const visible = text.trimEnd();
    const newline = visible.lastIndexOf('\n');
    return newline === -1 ? visible : visible.slice(newline + 1);
}
function pageExcerpt(text) {
    const visible = text.trimEnd();
    let line = latestReasoningLine(visible);
    // A just-started line can be only one character. Prefer the previous complete
    // line until there is a readable fragment, rather than flipping to a lone word.
    const newline = visible.lastIndexOf('\n');
    if (line.length < 8 && newline >= 0)
        line = latestReasoningLine(visible.slice(0, newline));
    // Only the compact preview is abbreviated; the reasoning body stays exact.
    const tail = Array.from(line.slice(-320)).slice(-160).join('');
    return tail.length < line.length ? `…${tail}` : line;
}
/** At most two visible lines, eleven rate buckets, and no queue of old pages. */
class ReasoningSummaryPresentation {
    constructor(text, now) {
        this.buckets = [];
        this.input = text;
        this.startedAt = this.now = now;
        this.frame = { current: latestReasoningLine(text), previous: undefined, paging: false, revision: 0, at: now };
    }
    reset(text, now) {
        this.input = text;
        this.startedAt = this.now = now;
        this.buckets = [];
        this.nextPageAt = undefined;
        this.frame = { current: latestReasoningLine(text), previous: undefined, paging: false, revision: this.frame.revision + 1, at: now };
        return this.frame;
    }
    update(text, now, animate) {
        if (!text.startsWith(this.input))
            return this.reset(text, now);
        const growth = text.length - this.input.length;
        this.input = text;
        this.now = Math.max(this.now, now);
        if (growth > 0) {
            const at = Math.floor(this.now / RATE_BUCKET_MS) * RATE_BUCKET_MS;
            const last = this.buckets[this.buckets.length - 1];
            if (last?.at === at)
                last.count += growth;
            else
                this.buckets.push({ at, count: growth });
        }
        return this.advance(this.now, animate);
    }
    advance(now, animate) {
        this.now = Math.max(this.now, now);
        this.buckets = this.buckets.filter(bucket => bucket.at > this.now - RATE_WINDOW_MS);
        const elapsed = Math.min(RATE_WINDOW_MS, this.now - this.startedAt);
        const rate = this.buckets.reduce((sum, bucket) => sum + bucket.count, 0) * 1000 / Math.max(MIN_RATE_SAMPLE_MS, elapsed);
        const paging = elapsed >= MIN_RATE_SAMPLE_MS && rate >= (this.frame.paging ? SLOW_CHARS_PER_SECOND : exports.REASONING_FAST_CHARS_PER_SECOND);
        if (!paging) {
            const current = latestReasoningLine(this.input);
            this.nextPageAt = undefined;
            if (this.frame.paging || this.frame.previous !== undefined || current !== this.frame.current) {
                this.frame = { current, previous: undefined, paging: false, revision: this.frame.revision + 1, at: this.now };
            }
            return this.frame;
        }
        if (!this.frame.paging) {
            this.nextPageAt = this.now + exports.REASONING_PAGE_MS;
            this.frame = { current: pageExcerpt(this.input), previous: undefined, paging: true, revision: this.frame.revision + 1, at: this.now };
        }
        else if (this.now >= (this.nextPageAt ?? this.now)) {
            // A delayed browser callback skips straight to the newest page, never replays a backlog.
            this.nextPageAt = this.now + exports.REASONING_PAGE_MS;
            const current = pageExcerpt(this.input);
            if (current !== this.frame.current) {
                this.frame = { current, previous: animate ? this.frame.current : undefined, paging: true, revision: this.frame.revision + 1, at: this.now };
            }
        }
        if (this.frame.previous !== undefined && (!animate || this.now - this.frame.at >= exports.REASONING_FLIP_MS)) {
            this.frame = { ...this.frame, previous: undefined };
        }
        return this.frame;
    }
    /** The hook owns one timer: either expire the outgoing line or show the latest page. */
    get nextAt() {
        return this.frame.previous === undefined ? this.nextPageAt : Math.min(this.frame.at + exports.REASONING_FLIP_MS, this.nextPageAt ?? Infinity);
    }
}
exports.ReasoningSummaryPresentation = ReasoningSummaryPresentation;

},
"src/modules/conversation/chat/use-reasoning-summary.js": function(module, exports, require) {
// source: src/modules/conversation/chat/use-reasoning-summary.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useReasoningSummary = useReasoningSummary;
const react_1 = require("react");
const reasoning_summary_1 = require("./reasoning-summary");
/** Only the running, collapsed preview is paced. History and expanded text are not. */
function useReasoningSummary(text, enabled) {
    const model = (0, react_1.useRef)(null);
    model.current ?? (model.current = new reasoning_summary_1.ReasoningSummaryPresentation(text, Date.now()));
    const presentation = model.current;
    const [frame, setFrame] = (0, react_1.useState)(presentation.frame);
    const input = (0, react_1.useRef)(text);
    input.current = text;
    const controls = (0, react_1.useRef)({ active: false, hidden: false, reduce: false });
    const pending = (0, react_1.useRef)(null);
    const publish = (0, react_1.useRef)(() => { });
    const cancel = () => {
        if (pending.current !== null)
            clearTimeout(pending.current);
        pending.current = null;
    };
    publish.current = () => {
        const current = presentation;
        setFrame(current.frame);
        const nextAt = current.nextAt;
        if (!controls.current.active || controls.current.hidden || nextAt === undefined || pending.current !== null)
            return;
        pending.current = setTimeout(() => {
            pending.current = null;
            if (!controls.current.active || controls.current.hidden)
                return;
            current.advance(Date.now(), !controls.current.reduce);
            publish.current();
        }, Math.max(0, nextAt - Date.now()));
    };
    (0, react_1.useLayoutEffect)(() => {
        controls.current.active = enabled;
        if (!enabled) {
            cancel();
            presentation.reset(input.current, Date.now());
            setFrame(presentation.frame);
            return;
        }
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const sync = () => {
            cancel();
            const wasHidden = controls.current.hidden;
            controls.current.hidden = document.hidden;
            controls.current.reduce = media.matches;
            if (wasHidden || document.hidden)
                presentation.reset(input.current, Date.now());
            else
                presentation.advance(Date.now(), !media.matches);
            publish.current();
        };
        sync();
        document.addEventListener('visibilitychange', sync);
        media.addEventListener('change', sync);
        return () => {
            controls.current.active = false;
            cancel();
            document.removeEventListener('visibilitychange', sync);
            media.removeEventListener('change', sync);
        };
    }, [enabled]);
    (0, react_1.useLayoutEffect)(() => {
        if (!enabled)
            return;
        if (controls.current.hidden)
            presentation.reset(text, Date.now());
        else
            presentation.update(text, Date.now(), !controls.current.reduce);
        // Do not restart the 800ms deadline for each incoming chunk.
        if (presentation.nextAt === undefined)
            cancel();
        publish.current();
    }, [text, enabled]);
    // Finish, expansion, and replacement cannot paint a stale page even for one frame.
    if (!enabled || !text.startsWith(presentation.input) || controls.current.hidden || !frame.paging) {
        return { current: (0, reasoning_summary_1.latestReasoningLine)(text), previous: undefined, paging: false, revision: frame.revision, at: frame.at };
    }
    return frame;
}

},
"src/modules/conversation/chat/AssistantMarkdown.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/AssistantMarkdown.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AssistantMarkdown_css_1 = __importDefault(require("./AssistantMarkdown.css"));
exports.default = {
    "actions": "_5vpFrG_actions",
    "body": "_5vpFrG_body",
    "root": "_5vpFrG_root",
    "stopped": "_5vpFrG_stopped"
};
const tagId = '@xharness/dsh-client-ui-conversation/AssistantMarkdown.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = AssistantMarkdown_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/AssistantMarkdown.css": function(module, exports, require) {
// source: src/modules/conversation/chat/AssistantMarkdown.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._5vpFrG_root{color:var(--dsw-alias-label-primary);flex-direction:column;font-size:16px;line-height:28px;display:flex}._5vpFrG_body{flex-direction:column;gap:16px;display:flex}._5vpFrG_stopped{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);border-radius:6px;align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}._5vpFrG_actions{margin-top:16px;margin-left:-6px}\n.xh-tool-preparing{min-width:0;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}\n.xh-tool-preparing-toggle{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;padding:10px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}\n.xh-tool-preparing-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.xh-tool-preparing-toggle:focus-visible,.xh-tool-preparing-preview-head button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}\n.xh-tool-preparing-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:xh-tool-input-pulse 1.5s ease-in-out infinite}\n.xh-tool-preparing-title{flex:1;min-width:0;overflow-wrap:anywhere}.xh-tool-preparing-title code{margin-left:7px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}\n.xh-tool-preparing-metrics{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}.xh-tool-preparing-chevron{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-tertiary)}\n.xh-tool-preparing-body{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 12px 12px}.xh-tool-preparing-notice{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px}\n.xh-tool-preparing-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}.xh-tool-preparing-preview-head button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;padding:3px 5px;border-radius:4px}\n.xh-tool-preparing-input{max-height:260px;overflow:auto;margin:0;padding:10px;border-radius:7px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}\n.xh-tool-preparing-limit{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px}\n@keyframes xh-tool-input-pulse{50%{opacity:.35}}\n@media(prefers-reduced-motion:reduce){.xh-tool-preparing-dot{animation:none}}\n@media(max-width:480px){.xh-tool-preparing-toggle{flex-wrap:wrap}.xh-tool-preparing-title{flex-basis:calc(100% - 40px)}.xh-tool-preparing-metrics{margin-left:16px;flex:1}.xh-tool-preparing-input{max-height:200px}}\n";

},
"src/modules/conversation/chat/ToolArgumentProgress.js": function(module, exports, require) {
// source: src/modules/conversation/chat/ToolArgumentProgress.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolArgumentProgress = ToolArgumentProgress;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const tool_argument_view_1 = require("./tool-argument-view");
const transcript_state_1 = require("./transcript-state");
/** All providers use normalized tool deltas; this card performs no tool execution. */
function ToolArgumentProgress({ block, t }) {
    const stateKey = `tool-arguments:${block.callId}:${block.startedAt ?? ''}`;
    const [open, setOpen] = (0, transcript_state_1.useTranscriptState)(`${stateKey}:open`, false);
    const [rawMode, setRawMode] = (0, transcript_state_1.useTranscriptState)(`${stateKey}:raw`, false);
    const [now, setNow] = (0, react_1.useState)(Date.now);
    const bodyId = (0, react_1.useId)();
    const bytes = (0, react_1.useMemo)(() => new TextEncoder().encode(block.argsRaw).byteLength, [block.argsRaw]);
    // Closed cards count bytes but do not decode or render the potentially long input.
    const preview = (0, react_1.useMemo)(() => open && !rawMode ? (0, tool_argument_view_1.toolArgumentPreview)(block.argsRaw) : null, [open, rawMode, block.argsRaw]);
    (0, react_1.useEffect)(() => {
        if (block.startedAt === undefined)
            return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [block.startedAt]);
    const text = rawMode ? (0, tool_argument_view_1.boundedToolArgumentText)(block.argsRaw).text : preview?.text ?? '';
    const truncated = rawMode ? block.argsRaw.length > tool_argument_view_1.TOOL_ARGUMENT_PREVIEW_LIMIT : preview?.truncated === true;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "xh-tool-preparing", "data-tool-phase": "generating", "data-tool-name": block.name, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xh-tool-preparing-toggle", "aria-expanded": open, "aria-controls": bodyId, onClick: () => setOpen(value => !value), children: [(0, jsx_runtime_1.jsx)("span", { className: "xh-tool-preparing-dot", "aria-hidden": "true" }), (0, jsx_runtime_1.jsxs)("span", { className: "xh-tool-preparing-title", children: [t('tool.arguments.generating'), " ", (0, jsx_runtime_1.jsx)("code", { children: block.name })] }), (0, jsx_runtime_1.jsxs)("span", { className: "xh-tool-preparing-metrics", "aria-live": "off", children: [t('tool.arguments.received', { size: (0, tool_argument_view_1.formatToolArgumentBytes)(bytes) }), block.startedAt !== undefined && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [" \u00B7 ", t('tool.arguments.elapsed', { seconds: Math.max(0, Math.floor((now - block.startedAt) / 1000)) })] })] }), (0, jsx_runtime_1.jsx)("span", { className: "xh-tool-preparing-chevron", "aria-hidden": "true", children: open ? '⌄' : '›' })] }), open && (0, jsx_runtime_1.jsxs)("div", { id: bodyId, className: "xh-tool-preparing-body", children: [(0, jsx_runtime_1.jsx)("p", { className: "xh-tool-preparing-notice", children: t('tool.arguments.notExecuted') }), (0, jsx_runtime_1.jsxs)("div", { className: "xh-tool-preparing-preview-head", children: [(0, jsx_runtime_1.jsx)("span", { children: rawMode || !preview?.field ? t('tool.arguments.raw') : `${t('tool.arguments.preview')} · ${preview.field}` }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": rawMode, onClick: () => setRawMode(value => !value), children: rawMode ? t('tool.arguments.showPreview') : t('tool.arguments.showRaw') })] }), (0, jsx_runtime_1.jsx)("pre", { className: "xh-tool-preparing-input", children: text || t('tool.arguments.waiting') }), truncated && (0, jsx_runtime_1.jsx)("p", { className: "xh-tool-preparing-limit", children: t('tool.arguments.truncated', { count: tool_argument_view_1.TOOL_ARGUMENT_PREVIEW_LIMIT }) })] })] }));
}

},
"src/modules/conversation/chat/tool-argument-view.js": function(module, exports, require) {
// source: src/modules/conversation/chat/tool-argument-view.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_ARGUMENT_PREVIEW_LIMIT = void 0;
exports.boundedToolArgumentText = boundedToolArgumentText;
exports.toolArgumentPreview = toolArgumentPreview;
exports.formatToolArgumentBytes = formatToolArgumentBytes;
/** Presentation only: never parse a partial input into an executable tool call. */
exports.TOOL_ARGUMENT_PREVIEW_LIMIT = 16384;
function boundedToolArgumentText(raw) {
    let text = raw.slice(0, exports.TOOL_ARGUMENT_PREVIEW_LIMIT);
    // A network chunk or preview boundary may end halfway through an emoji.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        text = text.slice(0, -1);
    return { text, truncated: raw.length > exports.TOOL_ARGUMENT_PREVIEW_LIMIT };
}
const textFields = new Set(['command', 'cmd', 'content', 'file_text', 'patch', 'patchText', 'new_string', 'newString', 'code']);
function readString(raw, start, limit) {
    let text = '', truncated = false;
    const append = (value) => {
        if (text.length + value.length <= limit)
            text += value;
        else
            truncated = true;
    };
    let i = start + 1;
    while (i < raw.length) {
        const c = raw[i++];
        if (c === undefined)
            break;
        if (c === '"')
            return { text, end: i, complete: true, truncated };
        if (c !== '\\') {
            append(c);
            continue;
        }
        const escape = raw[i++];
        if (escape === undefined)
            break;
        if (escape === 'u') {
            const hex = raw.slice(i, i + 4);
            if (!/^[\da-f]{4}$/i.test(hex))
                break;
            append(String.fromCharCode(Number.parseInt(hex, 16)));
            i += 4;
        }
        else {
            const escaped = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
            const decoded = escaped[escape];
            if (decoded === undefined)
                break;
            append(decoded);
        }
    }
    return { text, end: i, complete: false, truncated };
}
/** Decode a top-level text field for readability; the raw input remains authoritative. */
function toolArgumentPreview(raw) {
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '{' || c === '[')
            depth++;
        else if (c === '}' || c === ']')
            depth--;
        else if (c === '"') {
            const key = readString(raw, i, 256);
            let cursor = key.end;
            while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length)
                cursor++;
            if (depth === 1 && key.complete && !key.truncated && textFields.has(key.text) && raw[cursor] === ':') {
                cursor++;
                while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length)
                    cursor++;
                if (raw[cursor] === '"') {
                    const value = readString(raw, cursor, exports.TOOL_ARGUMENT_PREVIEW_LIMIT);
                    return { text: boundedToolArgumentText(value.text).text, field: key.text, truncated: value.truncated };
                }
            }
            i = Math.max(i, key.end - 1);
        }
    }
    return { ...boundedToolArgumentText(raw), field: null };
}
function formatToolArgumentBytes(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

},
"src/modules/conversation/chat/CommandNodeView.js": function(module, exports, require) {
// source: src/modules/conversation/chat/CommandNodeView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualCompactionNodeView = exports.CommandNodeView = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const CompactionCommandCard_1 = require("./CompactionCommandCard");
const GenericCommandCard_1 = require("./GenericCommandCard");
const ChatView_styles_1 = __importDefault(require("./ChatView.styles"));
/** Ordinary command lifecycle renderer with command-name keyed specialization. */
exports.CommandNodeView = (0, react_1.memo)(function CommandNodeView({ node, renderSlot, t }) {
    const command = node.data;
    const owner = (0, react_1.useMemo)(() => ({ node: command }), [command]);
    return ((0, jsx_runtime_1.jsx)("div", { className: ChatView_styles_1.default.callRow, children: renderSlot('conversation.chat.commandview', owner, {
            entryKey: command.name ?? '',
            fallback: (0, jsx_runtime_1.jsx)(GenericCommandCard_1.GenericCommandCard, { ...owner, t: t }),
        }) }));
});
/** One integrated `/compact` command and compaction transaction renderer. */
exports.ManualCompactionNodeView = (0, react_1.memo)(function ManualCompactionNodeView({ node, t, }) {
    const data = node.data;
    return ((0, jsx_runtime_1.jsx)("div", { className: ChatView_styles_1.default.callRow, children: (0, jsx_runtime_1.jsx)(CompactionCommandCard_1.CompactionCommandCard, { node: data.command, ...data.compaction === null ? {} : { compaction: data.compaction }, t: t }) }));
});

},
"src/modules/conversation/chat/CompactionCommandCard.js": function(module, exports, require) {
// source: src/modules/conversation/chat/CompactionCommandCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionCommandCard = CompactionCommandCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const CompactionProgressCard_1 = require("./CompactionProgressCard");
const CompactionItem_1 = require("./CompactionItem");
const GenericCommandCard_1 = require("./GenericCommandCard");
/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
function CompactionCommandCard({ node, compaction, t }) {
    if (compaction !== undefined) {
        if ('status' in compaction)
            return (0, jsx_runtime_1.jsx)(CompactionProgressCard_1.CompactionProgressCard, { data: compaction, t: t });
        return ((0, jsx_runtime_1.jsx)(CompactionItem_1.CompactionItem, { node: compaction, title: "compact", fallbackSummary: node.outcome?.text ?? null, t: t }));
    }
    if (node.outcome !== null)
        return (0, jsx_runtime_1.jsx)(GenericCommandCard_1.GenericCommandCard, { node: node, t: t });
    return (0, jsx_runtime_1.jsx)(GenericCommandCard_1.GenericCommandCard, { node: node, t: t, runningSummary: t('message.compaction.running') });
}

},
"src/modules/conversation/chat/GenericCommandCard.js": function(module, exports, require) {
// source: src/modules/conversation/chat/GenericCommandCard.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericCommandCard = GenericCommandCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const transcript_state_1 = require("./transcript-state");
const primitives_1 = require("../primitives");
const accessibility_styles_1 = __importDefault(require("./accessibility.styles"));
const GenericCommandCard_styles_1 = __importDefault(require("./GenericCommandCard.styles"));
/** Node state → row state semantic (running while unsettled; outcome kind after). */
function stateOf(outcome) {
    if (outcome === null)
        return 'running';
    return outcome.kind === 'error' ? 'error' : 'ok';
}
function leadingFor(state) {
    return state === 'error' ? (0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "error" }) : (0, jsx_runtime_1.jsx)(primitives_1.IconApiOutline14, { size: 14 });
}
function GenericCommandCard({ node, t, runningSummary }) {
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('command', false);
    const text = node.outcome?.text;
    const summary = node.outcome === null
        ? runningSummary ?? t('command.running')
        : text ?? (node.outcome.kind === 'error' ? t('command.failed') : t('command.done'));
    // Title is the bare command name: the row already reads `name · outcome`,
    // and the dispatched line's own `/` and arguments only restate what the
    // settlement text says (`permission · preset workspace-write`). A
    // cross-window node whose run page fell out of the window has no name.
    const title = node.name ?? t('command.title');
    const state = stateOf(node.outcome);
    const body = text !== undefined && text.includes('\n') ? text : null;
    const open = expanded && body !== null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: GenericCommandCard_styles_1.default.root, "data-variant": "others", "data-state": state, children: [state === 'running' && (0, jsx_runtime_1.jsx)("span", { className: accessibility_styles_1.default.visuallyHidden, children: t('row.running') }), state === 'error' && (0, jsx_runtime_1.jsx)("span", { className: accessibility_styles_1.default.visuallyHidden, children: t('row.failed') }), (0, jsx_runtime_1.jsx)(primitives_1.DisclosureRow, { rowClassName: GenericCommandCard_styles_1.default.row, leadingClassName: GenericCommandCard_styles_1.default.leading, titleClassName: GenericCommandCard_styles_1.default.title, chevronClassName: GenericCommandCard_styles_1.default.chevron, icon: leadingFor(state), title: title, open: open, expandable: body !== null, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: () => { setExpanded(value => !value); }, collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: GenericCommandCard_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: GenericCommandCard_styles_1.default.summary, "data-error": state === 'error' || undefined, children: summary })] })), children: (0, jsx_runtime_1.jsx)("pre", { className: GenericCommandCard_styles_1.default.body, "data-error": state === 'error' || undefined, children: body }) })] }));
}

},
"src/modules/conversation/chat/GenericCommandCard.styles.js": function(module, exports, require) {
// source: src/modules/conversation/chat/GenericCommandCard.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const GenericCommandCard_css_1 = __importDefault(require("./GenericCommandCard.css"));
exports.default = {
    "body": "_0kRAKq_body",
    "chevron": "_0kRAKq_chevron",
    "dsh-command-row-sweep": "_0kRAKq_dsh-command-row-sweep",
    "leading": "_0kRAKq_leading",
    "root": "_0kRAKq_root",
    "row": "_0kRAKq_row",
    "separator": "_0kRAKq_separator",
    "summary": "_0kRAKq_summary",
    "title": "_0kRAKq_title"
};
const tagId = '@xharness/dsh-client-ui-conversation/GenericCommandCard.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-conversation';
    tag.dataset.pluginCss = tagId;
    tag.textContent = GenericCommandCard_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/conversation/chat/GenericCommandCard.css": function(module, exports, require) {
// source: src/modules/conversation/chat/GenericCommandCard.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._0kRAKq_root{flex-direction:column;display:flex}._0kRAKq_row{position:relative;overflow:hidden}._0kRAKq_root[data-state=running] ._0kRAKq_row:after{content:\"\";inset-block:0;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite _0kRAKq_dsh-command-row-sweep;position:absolute;left:0}@keyframes _0kRAKq_dsh-command-row-sweep{0%{left:-300px}90%,to{left:100%}}._0kRAKq_leading{flex-shrink:0}._0kRAKq_chevron{color:var(--dsw-alias-label-secondary)}._0kRAKq_title{font-weight:400}._0kRAKq_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}._0kRAKq_summary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}._0kRAKq_summary[data-error],._0kRAKq_body[data-error]{color:var(--dsw-alias-state-error-primary)}._0kRAKq_body{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);max-height:260px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;border-radius:12px;margin:4px 0 4px 4px;padding:12px 16px;overflow:auto}@media (prefers-reduced-motion:reduce){._0kRAKq_root[data-state=running] ._0kRAKq_row:after{animation:none}}";

}
};
const __dependencies = {"src/modules/conversation/index.js":{"./apply":"src/modules/conversation/apply.js","./service":"src/modules/conversation/service.js","./edit/MessageEditor":"src/modules/conversation/edit/MessageEditor.js","./edit/EditableInputBar":"src/modules/conversation/edit/EditableInputBar.js","./edit/actions":"src/modules/conversation/edit/actions.js"},"src/modules/conversation/apply.js":{"./edit/EditableInputBar":"src/modules/conversation/edit/EditableInputBar.js","./edit/actions":"src/modules/conversation/edit/actions.js","./runtime-values":"src/modules/conversation/runtime-values.js","./stores":"src/modules/conversation/stores.js","./service":"src/modules/conversation/service.js","./input/blocks":"src/modules/conversation/input/blocks.js","./input/hub":"src/modules/conversation/input/hub.js","./input/submission-policy":"src/modules/conversation/input/submission-policy.js","./settings/EnterBehaviorRow":"src/modules/conversation/settings/EnterBehaviorRow.js","./chat/ChatView":"src/modules/conversation/chat/ChatView.js","./chat/scroll-memory":"src/modules/conversation/chat/scroll-memory.js","./chat/StatsLine":"src/modules/conversation/chat/StatsLine.js","./skeleton/ApprovalPanel":"src/modules/conversation/skeleton/ApprovalPanel.js","./skeleton/TodoPanel":"src/modules/conversation/skeleton/TodoPanel.js","./queue/QueueDock":"src/modules/conversation/queue/QueueDock.js","./skeleton/ConversationRoot":"src/modules/conversation/skeleton/ConversationRoot.js","./skeleton/ConversationSession":"src/modules/conversation/skeleton/ConversationSession.js","./skeleton/DetailsPanel":"src/modules/conversation/skeleton/DetailsPanel.js","./locales":"src/modules/conversation/locales.js","./conversation-nodes/register":"src/modules/conversation/conversation-nodes/register.js","./chat/register-node-renderers":"src/modules/conversation/chat/register-node-renderers.js","./submission-settings":"src/modules/conversation/submission-settings.js"},"src/modules/conversation/edit/EditableInputBar.js":{"../skeleton/InputBar":"src/modules/conversation/skeleton/InputBar.js"},"src/modules/conversation/skeleton/InputBar.js":{"../classnames":"src/modules/conversation/classnames.js","../primitives":"src/modules/conversation/primitives.js","../input/decorations":"src/modules/conversation/input/decorations.js","../image-labels":"src/modules/conversation/image-labels.js","../reference/ReferenceIcon":"src/modules/conversation/reference/ReferenceIcon.js","./ContextMeter":"src/modules/conversation/skeleton/ContextMeter.js","./PermissionSelect":"src/modules/conversation/skeleton/PermissionSelect.js","./safari":"src/modules/conversation/skeleton/safari.js","./InputBar.styles":"src/modules/conversation/skeleton/InputBar.styles.js","./ComposerAddMenu":"src/modules/conversation/skeleton/ComposerAddMenu.js","../attachments":"src/modules/conversation/attachments.js"},"src/modules/conversation/classnames.js":{},"src/modules/conversation/primitives.js":{},"src/modules/conversation/input/decorations.js":{},"src/modules/conversation/image-labels.js":{},"src/modules/conversation/reference/ReferenceIcon.js":{"../primitives":"src/modules/conversation/primitives.js"},"src/modules/conversation/skeleton/ContextMeter.js":{"../primitives":"src/modules/conversation/primitives.js","../chat/StatsLine":"src/modules/conversation/chat/StatsLine.js","./ContextMeter.styles":"src/modules/conversation/skeleton/ContextMeter.styles.js"},"src/modules/conversation/chat/StatsLine.js":{"../../shared/reception-metrics":"src/modules/shared/reception-metrics.js","../primitives":"src/modules/conversation/primitives.js","./message-chrome":"src/modules/conversation/chat/message-chrome.js","./turn-metrics":"src/modules/conversation/chat/turn-metrics.js","./StatsLine.styles":"src/modules/conversation/chat/StatsLine.styles.js"},"src/modules/shared/reception-metrics.js":{"./runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/conversation/chat/message-chrome.js":{},"src/modules/conversation/chat/turn-metrics.js":{"../../shared/reception-metrics":"src/modules/shared/reception-metrics.js"},"src/modules/conversation/chat/StatsLine.styles.js":{"./StatsLine.css":"src/modules/conversation/chat/StatsLine.css"},"src/modules/conversation/chat/StatsLine.css":{},"src/modules/conversation/skeleton/ContextMeter.styles.js":{"./ContextMeter.css":"src/modules/conversation/skeleton/ContextMeter.css"},"src/modules/conversation/skeleton/ContextMeter.css":{},"src/modules/conversation/skeleton/PermissionSelect.js":{"../classnames":"src/modules/conversation/classnames.js","../primitives":"src/modules/conversation/primitives.js","./PermissionSelect.styles":"src/modules/conversation/skeleton/PermissionSelect.styles.js"},"src/modules/conversation/skeleton/PermissionSelect.styles.js":{"./PermissionSelect.css":"src/modules/conversation/skeleton/PermissionSelect.css"},"src/modules/conversation/skeleton/PermissionSelect.css":{},"src/modules/conversation/skeleton/safari.js":{},"src/modules/conversation/skeleton/InputBar.styles.js":{"./InputBar.css":"src/modules/conversation/skeleton/InputBar.css"},"src/modules/conversation/skeleton/InputBar.css":{},"src/modules/conversation/skeleton/ComposerAddMenu.js":{"../primitives":"src/modules/conversation/primitives.js"},"src/modules/conversation/attachments.js":{"./input/contract":"src/modules/conversation/input/contract.js"},"src/modules/conversation/input/contract.js":{},"src/modules/conversation/edit/actions.js":{"./MessageEditor":"src/modules/conversation/edit/MessageEditor.js"},"src/modules/conversation/edit/MessageEditor.js":{"../wire-guards":"src/modules/conversation/wire-guards.js","../../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/conversation/wire-guards.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/conversation/runtime-values.js":{"./types/model":"src/modules/conversation/types/model.js","./chat/chunk-values":"src/modules/conversation/chat/chunk-values.js"},"src/modules/conversation/types/model.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../wire-guards":"src/modules/conversation/wire-guards.js"},"src/modules/conversation/chat/chunk-values.js":{},"src/modules/conversation/stores.js":{"./contract/chat-store-codec":"src/modules/conversation/contract/chat-store-codec.js","./runtime-values":"src/modules/conversation/runtime-values.js"},"src/modules/conversation/contract/chat-store-codec.js":{},"src/modules/conversation/service.js":{"./core-context":"src/modules/conversation/core-context.js","./attachments":"src/modules/conversation/attachments.js"},"src/modules/conversation/core-context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/conversation/input/blocks.js":{"../runtime-values":"src/modules/conversation/runtime-values.js"},"src/modules/conversation/input/hub.js":{"../edit/MessageEditor":"src/modules/conversation/edit/MessageEditor.js","../edit/persistence":"src/modules/conversation/edit/persistence.js","../queue/store":"src/modules/conversation/queue/store.js","./facade":"src/modules/conversation/input/facade.js"},"src/modules/conversation/edit/persistence.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../wire-guards":"src/modules/conversation/wire-guards.js"},"src/modules/conversation/queue/store.js":{},"src/modules/conversation/input/facade.js":{"../runtime-values":"src/modules/conversation/runtime-values.js","./machine":"src/modules/conversation/input/machine.js"},"src/modules/conversation/input/machine.js":{},"src/modules/conversation/input/submission-policy.js":{"../runtime-values":"src/modules/conversation/runtime-values.js","../submission-settings":"src/modules/conversation/submission-settings.js"},"src/modules/conversation/submission-settings.js":{},"src/modules/conversation/settings/EnterBehaviorRow.js":{"../primitives":"src/modules/conversation/primitives.js","./EnterBehaviorRow.styles":"src/modules/conversation/settings/EnterBehaviorRow.styles.js"},"src/modules/conversation/settings/EnterBehaviorRow.styles.js":{"./EnterBehaviorRow.css":"src/modules/conversation/settings/EnterBehaviorRow.css"},"src/modules/conversation/settings/EnterBehaviorRow.css":{},"src/modules/conversation/chat/ChatView.js":{"./pending-tool":"src/modules/conversation/chat/pending-tool.js","./use-adaptive-tool-fold":"src/modules/conversation/chat/use-adaptive-tool-fold.js","./process-mode":"src/modules/conversation/chat/process-mode.js","../primitives":"src/modules/conversation/primitives.js","./MessageItem":"src/modules/conversation/chat/MessageItem.js","./ChatNodeSeat":"src/modules/conversation/chat/ChatNodeSeat.js","./TranscriptWindowRow":"src/modules/conversation/chat/TranscriptWindowRow.js","./message-chrome":"src/modules/conversation/chat/message-chrome.js","../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","./message-preview":"src/modules/conversation/chat/message-preview.js","./ChatView.styles":"src/modules/conversation/chat/ChatView.styles.js","./MessageRail":"src/modules/conversation/chat/MessageRail.js","./history-page-intent":"src/modules/conversation/chat/history-page-intent.js","./LoadingIndicator":"src/modules/conversation/chat/LoadingIndicator.js"},"src/modules/conversation/chat/pending-tool.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js"},"src/modules/conversation/contract/chat-node-codec.js":{"../../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js"},"src/modules/shared/compaction-outcome.js":{},"src/modules/conversation/chat/use-adaptive-tool-fold.js":{"./process-mode":"src/modules/conversation/chat/process-mode.js","./adaptive-tool-fold":"src/modules/conversation/chat/adaptive-tool-fold.js","../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js"},"src/modules/conversation/chat/process-mode.js":{"../../shared/process-display":"src/modules/shared/process-display.js"},"src/modules/shared/process-display.js":{},"src/modules/conversation/chat/adaptive-tool-fold.js":{},"src/modules/conversation/chat/MessageItem.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../wire-guards":"src/modules/conversation/wire-guards.js","./CompactionProgressCard":"src/modules/conversation/chat/CompactionProgressCard.js","../primitives":"src/modules/conversation/primitives.js","../reference/ReferenceIcon":"src/modules/conversation/reference/ReferenceIcon.js","./CompactionItem":"src/modules/conversation/chat/CompactionItem.js","./ContextInjectionRow":"src/modules/conversation/chat/ContextInjectionRow.js","./MessageIconActions":"src/modules/conversation/chat/MessageIconActions.js","./MessageItem.styles":"src/modules/conversation/chat/MessageItem.styles.js","../edit/MessageEditActions":"src/modules/conversation/edit/MessageEditActions.js"},"src/modules/conversation/chat/CompactionProgressCard.js":{"../primitives":"src/modules/conversation/primitives.js","./transcript-state":"src/modules/conversation/chat/transcript-state.js","./MessageItem.styles":"src/modules/conversation/chat/MessageItem.styles.js"},"src/modules/conversation/chat/transcript-state.js":{},"src/modules/conversation/chat/MessageItem.styles.js":{"./MessageItem.css":"src/modules/conversation/chat/MessageItem.css"},"src/modules/conversation/chat/MessageItem.css":{},"src/modules/conversation/chat/CompactionItem.js":{"./transcript-state":"src/modules/conversation/chat/transcript-state.js","../primitives":"src/modules/conversation/primitives.js","./MessageItem.styles":"src/modules/conversation/chat/MessageItem.styles.js"},"src/modules/conversation/chat/ContextInjectionRow.js":{"./transcript-state":"src/modules/conversation/chat/transcript-state.js","../primitives":"src/modules/conversation/primitives.js","../reference/ReferenceIcon":"src/modules/conversation/reference/ReferenceIcon.js","./ContextBody":"src/modules/conversation/chat/ContextBody.js","./ContextInjectionRow.styles":"src/modules/conversation/chat/ContextInjectionRow.styles.js"},"src/modules/conversation/chat/ContextBody.js":{"../wire-guards":"src/modules/conversation/wire-guards.js","../../shared/runtime-types":"src/modules/shared/runtime-types.js","../primitives":"src/modules/conversation/primitives.js","./ContextBody.styles":"src/modules/conversation/chat/ContextBody.styles.js"},"src/modules/conversation/chat/ContextBody.styles.js":{"./ContextBody.css":"src/modules/conversation/chat/ContextBody.css"},"src/modules/conversation/chat/ContextBody.css":{},"src/modules/conversation/chat/ContextInjectionRow.styles.js":{"./ContextInjectionRow.css":"src/modules/conversation/chat/ContextInjectionRow.css"},"src/modules/conversation/chat/ContextInjectionRow.css":{},"src/modules/conversation/chat/MessageIconActions.js":{"../primitives":"src/modules/conversation/primitives.js","./message-chrome":"src/modules/conversation/chat/message-chrome.js","./use-calendar-day":"src/modules/conversation/chat/use-calendar-day.js","./MessageIconActions.styles":"src/modules/conversation/chat/MessageIconActions.styles.js"},"src/modules/conversation/chat/use-calendar-day.js":{"./message-chrome":"src/modules/conversation/chat/message-chrome.js"},"src/modules/conversation/chat/MessageIconActions.styles.js":{"./MessageIconActions.css":"src/modules/conversation/chat/MessageIconActions.css"},"src/modules/conversation/chat/MessageIconActions.css":{},"src/modules/conversation/edit/MessageEditActions.js":{"../primitives":"src/modules/conversation/primitives.js","../chat/MessageIconActions.styles":"src/modules/conversation/chat/MessageIconActions.styles.js"},"src/modules/conversation/chat/ChatNodeSeat.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","../primitives":"src/modules/conversation/primitives.js","./ChatView.styles":"src/modules/conversation/chat/ChatView.styles.js","./TranscriptWindowRow":"src/modules/conversation/chat/TranscriptWindowRow.js","./turn-process":"src/modules/conversation/chat/turn-process.js","./TurnTailNodeView":"src/modules/conversation/chat/TurnTailNodeView.js","./adaptive-tool-fold":"src/modules/conversation/chat/adaptive-tool-fold.js","./process-mode":"src/modules/conversation/chat/process-mode.js"},"src/modules/conversation/chat/ChatView.styles.js":{"./ChatView.css":"src/modules/conversation/chat/ChatView.css"},"src/modules/conversation/chat/ChatView.css":{},"src/modules/conversation/chat/TranscriptWindowRow.js":{"./transcript-state":"src/modules/conversation/chat/transcript-state.js"},"src/modules/conversation/chat/turn-process.js":{"./adaptive-tool-fold":"src/modules/conversation/chat/adaptive-tool-fold.js"},"src/modules/conversation/chat/TurnTailNodeView.js":{"./MessageIconActions":"src/modules/conversation/chat/MessageIconActions.js","./turn-assistant":"src/modules/conversation/chat/turn-assistant.js","./TurnTailNodeView.styles":"src/modules/conversation/chat/TurnTailNodeView.styles.js","../primitives":"src/modules/conversation/primitives.js","./message-chrome":"src/modules/conversation/chat/message-chrome.js"},"src/modules/conversation/chat/turn-assistant.js":{},"src/modules/conversation/chat/TurnTailNodeView.styles.js":{"./TurnTailNodeView.css":"src/modules/conversation/chat/TurnTailNodeView.css"},"src/modules/conversation/chat/TurnTailNodeView.css":{},"src/modules/conversation/chat/message-preview.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/conversation/chat/MessageRail.js":{"../primitives":"src/modules/conversation/primitives.js","./MessageRail.styles":"src/modules/conversation/chat/MessageRail.styles.js"},"src/modules/conversation/chat/MessageRail.styles.js":{"./MessageRail.css":"src/modules/conversation/chat/MessageRail.css","../../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/conversation/chat/MessageRail.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/conversation/chat/history-page-intent.js":{},"src/modules/conversation/chat/LoadingIndicator.js":{"./LoadingIndicator.styles":"src/modules/conversation/chat/LoadingIndicator.styles.js"},"src/modules/conversation/chat/LoadingIndicator.styles.js":{"./LoadingIndicator.css":"src/modules/conversation/chat/LoadingIndicator.css"},"src/modules/conversation/chat/LoadingIndicator.css":{},"src/modules/conversation/chat/scroll-memory.js":{},"src/modules/conversation/skeleton/ApprovalPanel.js":{"../primitives":"src/modules/conversation/primitives.js","../contract/slots":"src/modules/conversation/contract/slots.js","../chat/tool-node-reader":"src/modules/conversation/chat/tool-node-reader.js","./ApprovalPanel.styles":"src/modules/conversation/skeleton/ApprovalPanel.styles.js"},"src/modules/conversation/contract/slots.js":{},"src/modules/conversation/chat/tool-node-reader.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js"},"src/modules/conversation/skeleton/ApprovalPanel.styles.js":{"./ApprovalPanel.css":"src/modules/conversation/skeleton/ApprovalPanel.css"},"src/modules/conversation/skeleton/ApprovalPanel.css":{},"src/modules/conversation/skeleton/TodoPanel.js":{"../primitives":"src/modules/conversation/primitives.js","../locales":"src/modules/conversation/locales.js","./TodoPanel.styles":"src/modules/conversation/skeleton/TodoPanel.styles.js"},"src/modules/conversation/locales.js":{},"src/modules/conversation/skeleton/TodoPanel.styles.js":{"./TodoPanel.css":"src/modules/conversation/skeleton/TodoPanel.css"},"src/modules/conversation/skeleton/TodoPanel.css":{},"src/modules/conversation/queue/QueueDock.js":{"../primitives":"src/modules/conversation/primitives.js","../locales":"src/modules/conversation/locales.js","./QueueDock.styles":"src/modules/conversation/queue/QueueDock.styles.js"},"src/modules/conversation/queue/QueueDock.styles.js":{"./QueueDock.css":"src/modules/conversation/queue/QueueDock.css"},"src/modules/conversation/queue/QueueDock.css":{},"src/modules/conversation/skeleton/ConversationRoot.js":{"../classnames":"src/modules/conversation/classnames.js","./EmptyHero":"src/modules/conversation/skeleton/EmptyHero.js","./ConversationRoot.styles":"src/modules/conversation/skeleton/ConversationRoot.styles.js","./HeroShell.styles":"src/modules/conversation/skeleton/HeroShell.styles.js"},"src/modules/conversation/skeleton/EmptyHero.js":{"../primitives":"src/modules/conversation/primitives.js","../runtime-values":"src/modules/conversation/runtime-values.js","./HeroShell.styles":"src/modules/conversation/skeleton/HeroShell.styles.js"},"src/modules/conversation/skeleton/HeroShell.styles.js":{"./HeroShell.css":"src/modules/conversation/skeleton/HeroShell.css"},"src/modules/conversation/skeleton/HeroShell.css":{},"src/modules/conversation/skeleton/ConversationRoot.styles.js":{"./ConversationRoot.css":"src/modules/conversation/skeleton/ConversationRoot.css"},"src/modules/conversation/skeleton/ConversationRoot.css":{},"src/modules/conversation/skeleton/ConversationSession.js":{"../classnames":"src/modules/conversation/classnames.js","./ConversationRoot.styles":"src/modules/conversation/skeleton/ConversationRoot.styles.js"},"src/modules/conversation/skeleton/DetailsPanel.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../primitives":"src/modules/conversation/primitives.js","../runtime-values":"src/modules/conversation/runtime-values.js","../chat/tool-node-reader":"src/modules/conversation/chat/tool-node-reader.js","./DetailsPanel.styles":"src/modules/conversation/skeleton/DetailsPanel.styles.js"},"src/modules/conversation/skeleton/DetailsPanel.styles.js":{"./DetailsPanel.css":"src/modules/conversation/skeleton/DetailsPanel.css"},"src/modules/conversation/skeleton/DetailsPanel.css":{},"src/modules/conversation/conversation-nodes/register.js":{"./checkpoint":"src/modules/conversation/conversation-nodes/checkpoint.js","./assistant":"src/modules/conversation/conversation-nodes/assistant.js","./chat-snapshot-builder":"src/modules/conversation/conversation-nodes/chat-snapshot-builder.js","./command":"src/modules/conversation/conversation-nodes/command.js","./compaction":"src/modules/conversation/conversation-nodes/compaction.js","./fallback":"src/modules/conversation/conversation-nodes/fallback.js","./inbox":"src/modules/conversation/conversation-nodes/inbox.js","./message":"src/modules/conversation/conversation-nodes/message.js","./retry":"src/modules/conversation/conversation-nodes/retry.js","./tool":"src/modules/conversation/conversation-nodes/tool.js","./turn-error":"src/modules/conversation/conversation-nodes/turn-error.js","./turn-max-tokens":"src/modules/conversation/conversation-nodes/turn-max-tokens.js","./turn-tail":"src/modules/conversation/conversation-nodes/turn-tail.js"},"src/modules/conversation/conversation-nodes/checkpoint.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/contract/wire-event-codec.js":{"../../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","../../shared/generated/session-terminal":"src/modules/shared/generated/session-terminal.js"},"src/modules/shared/generated/session-terminal.js":{},"src/modules/conversation/conversation-nodes/common.js":{},"src/modules/conversation/conversation-nodes/assistant.js":{"../../shared/reception-metrics":"src/modules/shared/reception-metrics.js","../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../chat/preparing-call":"src/modules/conversation/chat/preparing-call.js","../runtime-values":"src/modules/conversation/runtime-values.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/chat/preparing-call.js":{},"src/modules/conversation/conversation-nodes/chat-snapshot-builder.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js","../contract/chat-nodes":"src/modules/conversation/contract/chat-nodes.js"},"src/modules/conversation/contract/chat-nodes.js":{},"src/modules/conversation/conversation-nodes/command.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../wire-guards":"src/modules/conversation/wire-guards.js","../../shared/runtime-types":"src/modules/shared/runtime-types.js","./compaction-lifecycle":"src/modules/conversation/conversation-nodes/compaction-lifecycle.js","../runtime-values":"src/modules/conversation/runtime-values.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/compaction-lifecycle.js":{"../../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js"},"src/modules/conversation/conversation-nodes/compaction.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","./common":"src/modules/conversation/conversation-nodes/common.js","./command":"src/modules/conversation/conversation-nodes/command.js","./compaction-lifecycle":"src/modules/conversation/conversation-nodes/compaction-lifecycle.js"},"src/modules/conversation/conversation-nodes/fallback.js":{"../runtime-values":"src/modules/conversation/runtime-values.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/inbox.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../wire-guards":"src/modules/conversation/wire-guards.js","../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js"},"src/modules/conversation/conversation-nodes/message.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js","./inbox":"src/modules/conversation/conversation-nodes/inbox.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/retry.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/tool.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/turn-error.js":{"../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/turn-max-tokens.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/conversation-nodes/turn-tail.js":{"../../shared/runtime-types":"src/modules/shared/runtime-types.js","../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","../contract/wire-event-codec":"src/modules/conversation/contract/wire-event-codec.js","../runtime-values":"src/modules/conversation/runtime-values.js","../chat/turn-metrics":"src/modules/conversation/chat/turn-metrics.js","./common":"src/modules/conversation/conversation-nodes/common.js"},"src/modules/conversation/chat/register-node-renderers.js":{"../locales":"src/modules/conversation/locales.js","./CheckpointView":"src/modules/conversation/chat/CheckpointView.js","./AssistantNodeView":"src/modules/conversation/chat/AssistantNodeView.js","./CommandNodeView":"src/modules/conversation/chat/CommandNodeView.js","./MessageItem":"src/modules/conversation/chat/MessageItem.js","./TurnTailNodeView":"src/modules/conversation/chat/TurnTailNodeView.js"},"src/modules/conversation/chat/CheckpointView.js":{"./MessageItem.styles":"src/modules/conversation/chat/MessageItem.styles.js"},"src/modules/conversation/chat/AssistantNodeView.js":{"../contract/chat-node-codec":"src/modules/conversation/contract/chat-node-codec.js","./AssistantMarkdown":"src/modules/conversation/chat/AssistantMarkdown.js"},"src/modules/conversation/chat/AssistantMarkdown.js":{"../primitives":"src/modules/conversation/primitives.js","./ReasoningRow":"src/modules/conversation/chat/ReasoningRow.js","./AssistantMarkdown.styles":"src/modules/conversation/chat/AssistantMarkdown.styles.js","./preparing-call":"src/modules/conversation/chat/preparing-call.js","./ToolArgumentProgress":"src/modules/conversation/chat/ToolArgumentProgress.js"},"src/modules/conversation/chat/ReasoningRow.js":{"../primitives":"src/modules/conversation/primitives.js","./use-throttled-visual-update":"src/modules/conversation/chat/use-throttled-visual-update.js","./accessibility.styles":"src/modules/conversation/chat/accessibility.styles.js","./ReasoningRow.styles":"src/modules/conversation/chat/ReasoningRow.styles.js","./transcript-state":"src/modules/conversation/chat/transcript-state.js","./process-mode":"src/modules/conversation/chat/process-mode.js","./reasoning-summary":"src/modules/conversation/chat/reasoning-summary.js","./use-reasoning-summary":"src/modules/conversation/chat/use-reasoning-summary.js"},"src/modules/conversation/chat/use-throttled-visual-update.js":{},"src/modules/conversation/chat/accessibility.styles.js":{"./accessibility.css":"src/modules/conversation/chat/accessibility.css"},"src/modules/conversation/chat/accessibility.css":{},"src/modules/conversation/chat/ReasoningRow.styles.js":{"./ReasoningRow.css":"src/modules/conversation/chat/ReasoningRow.css"},"src/modules/conversation/chat/ReasoningRow.css":{},"src/modules/conversation/chat/reasoning-summary.js":{},"src/modules/conversation/chat/use-reasoning-summary.js":{"./reasoning-summary":"src/modules/conversation/chat/reasoning-summary.js"},"src/modules/conversation/chat/AssistantMarkdown.styles.js":{"./AssistantMarkdown.css":"src/modules/conversation/chat/AssistantMarkdown.css"},"src/modules/conversation/chat/AssistantMarkdown.css":{},"src/modules/conversation/chat/ToolArgumentProgress.js":{"./tool-argument-view":"src/modules/conversation/chat/tool-argument-view.js","./transcript-state":"src/modules/conversation/chat/transcript-state.js"},"src/modules/conversation/chat/tool-argument-view.js":{},"src/modules/conversation/chat/CommandNodeView.js":{"./CompactionCommandCard":"src/modules/conversation/chat/CompactionCommandCard.js","./GenericCommandCard":"src/modules/conversation/chat/GenericCommandCard.js","./ChatView.styles":"src/modules/conversation/chat/ChatView.styles.js"},"src/modules/conversation/chat/CompactionCommandCard.js":{"./CompactionProgressCard":"src/modules/conversation/chat/CompactionProgressCard.js","./CompactionItem":"src/modules/conversation/chat/CompactionItem.js","./GenericCommandCard":"src/modules/conversation/chat/GenericCommandCard.js"},"src/modules/conversation/chat/GenericCommandCard.js":{"./transcript-state":"src/modules/conversation/chat/transcript-state.js","../primitives":"src/modules/conversation/primitives.js","./accessibility.styles":"src/modules/conversation/chat/accessibility.styles.js","./GenericCommandCard.styles":"src/modules/conversation/chat/GenericCommandCard.styles.js"},"src/modules/conversation/chat/GenericCommandCard.styles.js":{"./GenericCommandCard.css":"src/modules/conversation/chat/GenericCommandCard.css"},"src/modules/conversation/chat/GenericCommandCard.css":{}};
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
return __load("src/modules/conversation/index.js");
}
});
