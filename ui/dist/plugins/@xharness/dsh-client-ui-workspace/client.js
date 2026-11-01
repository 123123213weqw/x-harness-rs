// Generated from src/modules/workspace/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-workspace",
factory: (__externalRequire) => {
const __units = {
"src/modules/workspace/index.js": function(module, exports, require) {
// source: src/modules/workspace/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const stores_1 = require("./stores");
const WorkspaceBrowser_1 = require("./WorkspaceBrowser");
const WorkspacePicker_1 = require("./WorkspacePicker");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin. */
const NS = 'workspace';
/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
exports.inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection'];
/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const connection = ctx.get('connection');
    const hostDescription = connection.hostDescription;
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-workspace: dictionaries');
    const searchSessions = async (query, signal) => {
        const result = await ctx.sessions.search(query, signal);
        if (!result.ok)
            throw new Error(result.error.message);
        return result.value;
    };
    // Stable per-surface occupancy sources (the renderer's hook cache keys by
    // source identity): true while the surface's directory-flow hole is filled.
    const flowSource = (hole) => ({
        getSnapshot: () => ctx.slots.entries(hole).length > 0,
        subscribe: listener => ctx.slots.subscribe(hole, listener),
    });
    const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow');
    const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow');
    const browserInjected = () => ({
        // Explicit group actions keep their target; unscoped New Session inherits
        // the current Session Workspace before the recent-Workspace fallback.
        startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId); },
        open: (sessionId) => { ctx.sessions.open(sessionId); },
        searchSessions,
        searchResultLimit: ctx.sessions.searchResultLimit,
        renameSession: async (sessionId, title) => {
            // Row → session-face hop: rename is a per-session verb (ISession), not
            // a list-service verb; the binding resolves any listed session.
            const session = ctx.sessions.binding(sessionId)?.session;
            if (session === undefined)
                throw new Error(`unknown session "${sessionId}"`);
            const result = await session.rename(title);
            if (!result.ok)
                throw new Error(result.error.message);
        },
        forkSession: (sessionId) => {
            ctx.sessions.fork({ sessionId, increaseTitle: true })
                .then((childId) => { ctx.sessions.open(childId); })
                .catch(() => {
                // Fork or child-rename failure keeps the current selection.
            });
        },
        renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title); },
        deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId); },
        insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
            await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId);
        },
        archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId); },
        insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
            await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
        },
        createWorkspace: input => ctx.workspaces.create(input),
        hooks: { directoryFlow: browserFlowSource, hostDescription },
    });
    const pickerInjected = () => ({
        createWorkspace: input => ctx.workspaces.create(input),
        hooks: { directoryFlow: pickerFlowSource },
    });
    // Each registration declares its directory-flow child in the same call;
    // slot injection follows both the owner and declaration HMR lifetimes.
    ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces',
        children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
        store: (0, stores_1.createWorkspaceViewStore)(),
        inject: browserInjected,
        locale: NS,
    }, WorkspaceBrowser_1.WorkspaceBrowser));
    ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
        name: 'conversation.hero.workspace',
        children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
        inject: pickerInjected,
        locale: NS,
    }, WorkspacePicker_1.WorkspacePicker));
}

},
"src/modules/workspace/stores.js": function(module, exports, require) {
// source: src/modules/workspace/stores.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FLAT_SESSION_ORDER_KEY = void 0;
exports.decodeWorkspaceViewState = decodeWorkspaceViewState;
exports.createWorkspaceViewStore = createWorkspaceViewStore;
const zod_1 = require("zod");
/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
const runtime_1 = require("./runtime");
/** Browser-local order account for the hierarchy-free flat Session list. */
exports.FLAT_SESSION_ORDER_KEY = '__flat_session_order__';
const workspaceViewSchema = zod_1.z.looseObject({
    groupBy: zod_1.z.enum(['workspace', 'flat']), orderBy: zod_1.z.enum(['manual', 'updated']),
    groupExpansion: zod_1.z.record(zod_1.z.string(), zod_1.z.boolean()),
    sessionOrderByAccount: zod_1.z.record(zod_1.z.string(), zod_1.z.array(zod_1.z.string())),
    sessionUpdatedAtByAccount: zod_1.z.record(zod_1.z.string(), zod_1.z.record(zod_1.z.string(), zod_1.z.number())),
});
function isWorkspaceViewState(value) {
    return workspaceViewSchema.safeParse(value).success;
}
/** Complete v5 persisted currency; valid saved order and foreign keys survive verbatim. */
function decodeWorkspaceViewState(value) {
    if (!isWorkspaceViewState(value))
        throw new TypeError('Invalid workspace view v5 state');
    return value;
}
/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
function createWorkspaceViewStore() {
    return (0, runtime_1.defineStore)({
        init: () => ({
            groupBy: 'workspace',
            orderBy: 'updated',
            groupExpansion: {},
            sessionOrderByAccount: {},
            sessionUpdatedAtByAccount: {},
        }),
        persist: 'dsh.workspace.view.v5',
        decode: decodeWorkspaceViewState,
        bake: (bind, actions) => ({
            setGroupBy: bind(actions.setGroupBy), setOrderBy: bind(actions.setOrderBy),
            setGroupExpanded: bind(actions.setGroupExpanded), retainAccountKeys: bind(actions.retainAccountKeys),
            syncSessionOrderAccount: bind(actions.syncSessionOrderAccount), setSessionOrder: bind(actions.setSessionOrder),
        }),
        actions: {
            setGroupBy: (d, mode) => { d.groupBy = mode; },
            setOrderBy: (d, mode) => { d.orderBy = mode; },
            setGroupExpanded: (d, key, expanded) => { d.groupExpansion[key] = expanded; },
            retainAccountKeys: (d, workspaceKeys) => {
                const retained = new Set(workspaceKeys);
                d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));
                d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));
                d.sessionUpdatedAtByAccount = Object.fromEntries(Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)));
            },
            syncSessionOrderAccount: (d, accountKey, order, updatedAt) => {
                d.sessionOrderByAccount[accountKey] = order;
                d.sessionUpdatedAtByAccount[accountKey] = updatedAt;
            },
            setSessionOrder: (d, accountKey, order) => {
                d.sessionOrderByAccount[accountKey] = order;
            },
        },
    });
}

},
"src/modules/workspace/runtime.js": function(module, exports, require) {
// source: src/modules/workspace/runtime.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.abbreviateHomePath = exports.indexSubagentDescendants = exports.defineStore = void 0;
var client_1 = require("@xharness/dsh-client-runtime/client");
Object.defineProperty(exports, "defineStore", { enumerable: true, get: function () { return client_1.defineStore; } });
Object.defineProperty(exports, "indexSubagentDescendants", { enumerable: true, get: function () { return client_1.indexSubagentDescendants; } });
Object.defineProperty(exports, "abbreviateHomePath", { enumerable: true, get: function () { return client_1.abbreviateHomePath; } });

},
"src/modules/workspace/WorkspaceBrowser.js": function(module, exports, require) {
// source: src/modules/workspace/WorkspaceBrowser.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceBrowser = WorkspaceBrowser;
exports.sanitizeSearchQuery = sanitizeSearchQuery;
exports.reconciledSessionOrder = reconciledSessionOrder;
exports.nextSessionOrderAccount = nextSessionOrderAccount;
const jsx_runtime_1 = require("react/jsx-runtime");
const shell_route_1 = require("../shared/shell-route");
require("./WorkNavigation.styles");
const primitives_1 = require("./primitives");
/**
 * The workspace/session browsing region filling the sidebar shell's
 * `sidebar.workspaces` hole: section header (title + view options + add
 * workspace), the grouped tree or flat list, and the workspace dialogs.
 * Wide state renders the full browser; rail state keeps the workspace,
 * Plugins and Tasks controls. Adding
 * is the header button's one action, so it raises the directory flow with no
 * menu in between; the flow and its error dialog live in WorkspacePicker
 * (same package — direct composition, no slot between them).
 */
const react_1 = require("react");
const class_names_1 = __importDefault(require("./class-names"));
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const tree_1 = require("./tree");
const Rows_1 = require("./rows/Rows");
const stores_1 = require("./stores");
const WorkspacePicker_1 = require("./WorkspacePicker");
const WorkspaceBrowser_styles_1 = __importDefault(require("./WorkspaceBrowser.styles"));
/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 500;
/** Session rows visible per Workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5;
/** Bound session.search payloads; retained for the existing module contract. */
function sanitizeSearchQuery(value) {
    const withoutNul = value.replaceAll('\0', '');
    if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS)
        return withoutNul;
    let end = SEARCH_QUERY_MAX_CODE_UNITS;
    const last = withoutNul.charCodeAt(end - 1);
    const next = withoutNul.charCodeAt(end);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF)
        end--;
    return withoutNul.slice(0, end);
}
/** Immutable membership toggle for the local expand-all array. */
function toggled(list, key) {
    return list.includes(key) ? list.filter(k => k !== key) : [...list, key];
}
/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker.
 */
function useNativeDragAcceptance(active) {
    (0, react_1.useEffect)(() => {
        if (!active)
            return;
        const acceptDrag = (event) => {
            event.preventDefault();
            if (event.dataTransfer !== null)
                event.dataTransfer.dropEffect = 'move';
        };
        const acceptDrop = (event) => { event.preventDefault(); };
        document.addEventListener('dragover', acceptDrag);
        document.addEventListener('drop', acceptDrop);
        return () => {
            document.removeEventListener('dragover', acceptDrag);
            document.removeEventListener('drop', acceptDrop);
        };
    }, [active]);
}
/** Reconcile a stored view order with the Workspace's current session account. */
function reconciledSessionOrder(sessionIds, stored) {
    if (stored === undefined)
        return [...sessionIds];
    const byId = new Map(sessionIds.map(id => [id, id]));
    const ordered = [];
    const included = new Set();
    for (const key of stored) {
        const id = byId.get(key);
        if (id === undefined || included.has(key))
            continue;
        ordered.push(id);
        included.add(key);
    }
    for (const id of sessionIds) {
        if (included.has(id))
            continue;
        ordered.push(id);
    }
    return ordered;
}
/** Newest update first with stable Session identity as the tie-break. */
function compareSessionRecency(a, b, byId) {
    const aUpdatedAt = byId[a]?.updatedAt ?? Number.NEGATIVE_INFINITY;
    const bUpdatedAt = byId[b]?.updatedAt ?? Number.NEGATIVE_INFINITY;
    if (aUpdatedAt !== bUpdatedAt)
        return bUpdatedAt - aUpdatedAt;
    return a < b ? -1 : 1;
}
/** Reconcile one editable order account and apply its activity-promotion policy. */
function nextSessionOrderAccount({ sessionIds, previousOrder, previousUpdatedAt, list, orderBy, sortByRecency, }) {
    let order = reconciledSessionOrder(sessionIds, previousOrder);
    if (sortByRecency) {
        order.sort((a, b) => compareSessionRecency(a, b, list.byId));
    }
    else if (orderBy === 'updated') {
        const promoted = sessionIds
            .filter((id) => {
            const session = list.byId[id];
            return session !== undefined
                && (previousUpdatedAt[id] === undefined || session.updatedAt > previousUpdatedAt[id]);
        })
            .sort((a, b) => compareSessionRecency(a, b, list.byId));
        if (promoted.length > 0) {
            const promotedIds = new Set(promoted);
            order = [...promoted, ...order.filter(id => !promotedIds.has(id))];
        }
    }
    const updatedAt = {};
    for (const id of sessionIds) {
        const session = list.byId[id];
        if (session !== undefined)
            updatedAt[id] = session.updatedAt;
    }
    const orderChanged = previousOrder === undefined
        || order.length !== previousOrder.length
        || order.some((id, index) => id !== previousOrder[index]);
    const timestampsChanged = Object.keys(updatedAt).length !== Object.keys(previousUpdatedAt).length
        || Object.entries(updatedAt).some(([id, timestamp]) => previousUpdatedAt[id] !== timestamp);
    return { order, updatedAt, changed: orderChanged || timestampsChanged };
}
/** Grouping and ordering menu; own open state so it resets with the wide chrome. */
function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick, t }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    return ((0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: open, onClose: () => { setOpen(false); }, items: [
            { type: 'label', id: 'group-by', text: t('groupBy.label') },
            { id: 'workspace', label: t('groupBy.workspace') },
            { id: 'flat', label: t('groupBy.flat') },
            { type: 'separator', id: 'order-by-separator' },
            { type: 'label', id: 'order-by', text: t('orderBy.label') },
            { id: 'manual', label: t('orderBy.manual') },
            { id: 'updated', label: t('orderBy.updated') },
        ], selectedIds: [groupBy, orderBy], onSelect: (id) => {
            if (id === 'workspace' || id === 'flat')
                onGroupPick(id);
            else if (id === 'manual' || id === 'updated')
                onOrderPick(id);
            setOpen(false);
        }, align: "end", dense: true,
        // Portal: the section header clips overflow, so an in-place list would
        // be cut off at the header's bounds.
        portal: true, anchor: ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('viewOptions.label'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.iconButton, WorkspaceBrowser_styles_1.default.wide), "aria-label": t('viewOptions.label'), onClick: () => { setOpen(v => !v); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconPersonalizationOutline16, {}) }) })) }));
}
/** Resolve an insertion side from the full rendered workspace group. */
function workspaceGroupHalf(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
/** The scrolling session tree; unmounting drops the sessions subscription and expand-all state. */
function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, }) {
    const list = useSessions(s => s);
    const current = list.current;
    const [expandedSessionGroups, setExpandedSessionGroups] = (0, react_1.useState)([]);
    // Transient drag marker state; the selected mode owns the resulting order.
    const [drag, setDrag] = (0, react_1.useState)(null);
    const sessionDropCommitted = (0, react_1.useRef)(false);
    const [workspaceDrag, setWorkspaceDrag] = (0, react_1.useState)(null);
    const workspaceDropCommitted = (0, react_1.useRef)(false);
    const previousOrderBy = (0, react_1.useRef)(orderBy);
    const nativeDragActive = drag !== null || workspaceDrag !== null;
    useNativeDragAcceptance(nativeDragActive);
    const currentGroup = current === undefined
        ? undefined
        : (workspaces.find(w => w.sessionIds.includes(current))?.workspaceId)
            ?? tree_1.UNGROUPED_KEY;
    (0, react_1.useEffect)(() => {
        if (current === undefined || currentGroup === undefined || Object.hasOwn(groupExpansion, currentGroup))
            return;
        setGroupExpanded(currentGroup, true);
    }, [current, currentGroup, setGroupExpanded, groupExpansion]);
    const expandedGroups = (0, react_1.useMemo)(() => Object.entries(groupExpansion).filter(([, expanded]) => expanded).map(([key]) => key), [groupExpansion]);
    const ungroupedSessionIds = (0, react_1.useMemo)(() => {
        const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds));
        return list.ids.filter(id => list.byId[id] !== undefined && !accounted.has(id));
    }, [list, workspaces]);
    (0, react_1.useEffect)(() => {
        if (list.phase !== 'ready')
            return;
        const switchedToUpdated = previousOrderBy.current !== 'updated' && orderBy === 'updated';
        previousOrderBy.current = orderBy;
        const accounts = [
            ...workspaces.map(workspace => ({
                key: workspace.workspaceId,
                sessionIds: workspace.sessionIds.filter(id => list.byId[id] !== undefined),
            })),
            { key: tree_1.UNGROUPED_KEY, sessionIds: ungroupedSessionIds },
        ];
        for (const { key, sessionIds } of accounts) {
            const previousOrder = sessionOrderByAccount[key];
            const previousUpdatedAt = sessionUpdatedAtByAccount[key] ?? {};
            const next = nextSessionOrderAccount({
                sessionIds,
                previousOrder,
                previousUpdatedAt,
                list,
                orderBy,
                sortByRecency: orderBy === 'updated' && (previousOrder === undefined || switchedToUpdated),
            });
            if (next.changed) {
                syncSessionOrderAccount(key, next.order.map(id => id), next.updatedAt);
            }
        }
    }, [list, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, ungroupedSessionIds, workspaces]);
    const orderedWorkspaces = (0, react_1.useMemo)(() => {
        return workspaces.map((workspace) => {
            const stored = sessionOrderByAccount[workspace.workspaceId];
            const sessionIds = reconciledSessionOrder(workspace.sessionIds, stored);
            return { ...workspace, sessionIds };
        });
    }, [sessionOrderByAccount, workspaces]);
    const orderedUngroupedSessionIds = (0, react_1.useMemo)(() => reconciledSessionOrder(ungroupedSessionIds, sessionOrderByAccount[tree_1.UNGROUPED_KEY]), [sessionOrderByAccount, ungroupedSessionIds]);
    const groups = (0, react_1.useMemo)(() => (0, tree_1.deriveGroups)(list, orderedWorkspaces, archivedSessionIds, {
        expandedGroups,
        ...(sessionOrderByAccount[tree_1.UNGROUPED_KEY] === undefined
            ? {}
            : { ungroupedOrder: sessionOrderByAccount[tree_1.UNGROUPED_KEY] }),
    }), [list, orderedWorkspaces, archivedSessionIds, expandedGroups, sessionOrderByAccount]);
    const now = Date.now();
    const commitSessionDrag = (activeDrag, over) => {
        if (sessionDropCommitted.current)
            return;
        sessionDropCommitted.current = true;
        setDrag(null);
        const group = groups.find(candidate => candidate.key === activeDrag.accountKey);
        if (group === undefined)
            return;
        const targetIndex = group.sessions.findIndex(session => session.id === over.id);
        if (targetIndex === -1)
            return;
        const anchor = over.half === 'before' ? over.id : group.sessions[targetIndex + 1]?.id;
        if (anchor === activeDrag.sessionId)
            return;
        const sourceIndex = group.sessions.findIndex(session => session.id === activeDrag.sessionId);
        const anchorIndex = anchor === undefined
            ? group.sessions.length
            : group.sessions.findIndex(session => session.id === anchor);
        if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1))
            return;
        const accountSessionIds = activeDrag.accountKey === tree_1.UNGROUPED_KEY
            ? orderedUngroupedSessionIds
            : orderedWorkspaces.find(workspace => workspace.workspaceId === activeDrag.accountKey)?.sessionIds;
        if (accountSessionIds === undefined)
            return;
        const nextOrder = accountSessionIds.filter(id => id !== activeDrag.sessionId);
        const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor);
        nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
        setSessionOrder(activeDrag.accountKey, nextOrder.map(id => id));
        if (orderBy === 'updated' || activeDrag.accountKey === tree_1.UNGROUPED_KEY)
            return;
        insertSessionBefore(activeDrag.accountKey, activeDrag.sessionId, anchor).catch((reason) => {
            console.warn('session reorder rejected:', reason);
        });
    };
    const commitWorkspaceDrag = (activeDrag, over) => {
        if (workspaceDropCommitted.current)
            return;
        workspaceDropCommitted.current = true;
        setWorkspaceDrag(null);
        const rowIndex = workspaces.findIndex(workspace => workspace.workspaceId === over.id);
        if (rowIndex === -1)
            return;
        const anchor = over.half === 'before' ? over.id : workspaces[rowIndex + 1]?.workspaceId;
        if (anchor === activeDrag.workspaceId)
            return;
        const sourceIndex = workspaces.findIndex(workspace => workspace.workspaceId === activeDrag.workspaceId);
        const anchorIndex = anchor === undefined
            ? workspaces.length
            : workspaces.findIndex(workspace => workspace.workspaceId === anchor);
        if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1))
            return;
        insertWorkspaceBefore(activeDrag.workspaceId, anchor).catch((reason) => {
            console.warn('workspace reorder rejected:', reason);
        });
    };
    const workspaceDropAtListStart = groups[0]?.workspaceId !== undefined
        && workspaceDrag?.over?.id === groups[0].workspaceId
        && workspaceDrag.over.half === 'before';
    return ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.treeBody, WorkspaceBrowser_styles_1.default.wide), children: [workspaceDropAtListStart && (0, jsx_runtime_1.jsx)("span", { className: WorkspaceBrowser_styles_1.default.listTopDropIndicator, "aria-hidden": "true" }), (0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.list, workspaceDropAtListStart && WorkspaceBrowser_styles_1.default.listTopDropActive), role: "tree", "aria-label": t('section.sessions'), children: [groups.length === 0 && ((0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.empty, children: t('empty.none') })), groups.map((group) => {
                        const workspaceId = group.workspaceId;
                        const workspaceMarker = workspaceId !== undefined && workspaceDrag?.over?.id === workspaceId
                            ? workspaceDrag.over.half
                            : null;
                        const workspaceDragProps = workspaceId === undefined ? undefined : {
                            start: () => {
                                workspaceDropCommitted.current = false;
                                setWorkspaceDrag({ workspaceId, over: null });
                            },
                            end: () => {
                                if (workspaceDrag?.over !== null && workspaceDrag?.over !== undefined) {
                                    commitWorkspaceDrag(workspaceDrag, workspaceDrag.over);
                                }
                                else {
                                    setWorkspaceDrag(null);
                                }
                                workspaceDropCommitted.current = false;
                            },
                        };
                        const hoverWorkspace = workspaceId === undefined
                            ? undefined
                            : (half) => {
                                setWorkspaceDrag(active => active === null
                                    ? active
                                    : { ...active, over: { id: workspaceId, half } });
                            };
                        const dropWorkspace = workspaceId === undefined
                            ? undefined
                            : (half) => {
                                if (workspaceDrag === null)
                                    return;
                                commitWorkspaceDrag(workspaceDrag, { id: workspaceId, half });
                            };
                        return (
                        // Group section: header row + expanded top-level session rows. The
                        // inter-group breathing room is the section's own margin
                        // (WorkspaceBrowser.styles).
                        (0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.groupSection, workspaceMarker === 'before' && WorkspaceBrowser_styles_1.default.workspaceDropBefore, workspaceMarker === 'after' && WorkspaceBrowser_styles_1.default.workspaceDropAfter), onDragOver: workspaceDrag === null || hoverWorkspace === undefined
                                ? undefined
                                : (e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    hoverWorkspace(workspaceGroupHalf(e));
                                }, onDrop: workspaceDrag === null || dropWorkspace === undefined
                                ? undefined
                                : (e) => {
                                    e.preventDefault();
                                    dropWorkspace(workspaceGroupHalf(e));
                                }, children: [(0, jsx_runtime_1.jsx)(Rows_1.ProjectRowItem, { group: group, home: home, t: t, onToggle: () => {
                                        if (group.expanded) {
                                            setExpandedSessionGroups(keys => keys.filter(key => key !== group.key));
                                        }
                                        setGroupExpanded(group.key, !group.expanded);
                                    }, onCreate: () => {
                                        if (group.workspaceId !== undefined) {
                                            setGroupExpanded(group.key, true);
                                            startSession(group.workspaceId);
                                        }
                                    }, drag: workspaceDragProps, actions: group.workspaceId === undefined
                                        ? undefined
                                        : {
                                            rename: () => {
                                                /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                                                if (group.workspaceId !== undefined)
                                                    onRenameRequest(group.workspaceId, group.label);
                                            },
                                            delete: () => {
                                                /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                                                if (group.workspaceId !== undefined)
                                                    onDeleteRequest(group.workspaceId, group.label);
                                            },
                                        } }), (expandedSessionGroups.includes(group.key)
                                    ? group.sessions
                                    : group.sessions.slice(0, COLLAPSED_SESSION_LIMIT)).map((node) => {
                                    // Session drag never leaves its group. Ungrouped writes only the
                                    // browser-local account; real Workspaces may also write Host order.
                                    const sameGroupDrag = drag !== null && drag.accountKey === group.key;
                                    const dragProps = {
                                        start: () => {
                                            sessionDropCommitted.current = false;
                                            setDrag({ accountKey: group.key, sessionId: node.id, over: null });
                                        },
                                        active: sameGroupDrag,
                                        marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
                                        hover: (half) => {
                                            /* v8 ignore next -- narrowing guard: Rows gates hover on `active`, which is false while the drag state is null. */
                                            setDrag(d => (d === null ? d : { ...d, over: { id: node.id, half } }));
                                        },
                                        drop: (half) => {
                                            /* v8 ignore next -- narrowing guard: Rows gates drop on `active`, which is false while the drag state is null. */
                                            if (drag === null)
                                                return;
                                            commitSessionDrag(drag, { id: node.id, half });
                                        },
                                        end: () => {
                                            if (drag?.over !== null && drag?.over !== undefined)
                                                commitSessionDrag(drag, drag.over);
                                            else
                                                setDrag(null);
                                            sessionDropCommitted.current = false;
                                        },
                                    };
                                    return ((0, jsx_runtime_1.jsx)(Rows_1.SessionNodeItem, { node: node, currentId: current, now: now, onOpen: open, onRename: onSessionRename, onFork: forkSession, onArchive: onSessionArchive, drag: dragProps, t: t }, node.id));
                                }), group.sessions.length > COLLAPSED_SESSION_LIMIT && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: WorkspaceBrowser_styles_1.default.sessionOverflowButton, "aria-expanded": expandedSessionGroups.includes(group.key), onClick: () => { setExpandedSessionGroups(keys => toggled(keys, group.key)); }, children: expandedSessionGroups.includes(group.key)
                                        ? t('sessions.collapse')
                                        : t('sessions.expand', { n: group.sessions.length - COLLAPSED_SESSION_LIMIT }) }))] }, group.key));
                    })] }), (0, jsx_runtime_1.jsx)("span", { className: WorkspaceBrowser_styles_1.default.fade })] }));
}
/** The flat "In one list" body: every session is one draggable top-level row. */
function FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t, }) {
    const list = useSessions(s => s);
    const baseRows = (0, react_1.useMemo)(() => (0, tree_1.deriveFlat)(list, archivedSessionIds), [list, archivedSessionIds]);
    const sessionIds = (0, react_1.useMemo)(() => baseRows.map(row => row.id), [baseRows]);
    const previousOrderBy = (0, react_1.useRef)(orderBy);
    (0, react_1.useEffect)(() => {
        if (list.phase !== 'ready')
            return;
        const previousOrder = sessionOrderByAccount[stores_1.FLAT_SESSION_ORDER_KEY];
        const previousUpdatedAt = sessionUpdatedAtByAccount[stores_1.FLAT_SESSION_ORDER_KEY] ?? {};
        const switchedToUpdated = previousOrderBy.current !== 'updated' && orderBy === 'updated';
        previousOrderBy.current = orderBy;
        const next = nextSessionOrderAccount({
            sessionIds,
            previousOrder,
            previousUpdatedAt,
            list,
            orderBy,
            sortByRecency: orderBy === 'updated' && (previousOrder === undefined || switchedToUpdated),
        });
        if (next.changed) {
            syncSessionOrderAccount(stores_1.FLAT_SESSION_ORDER_KEY, next.order.map(id => id), next.updatedAt);
        }
    }, [list, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, sessionIds, syncSessionOrderAccount]);
    const rows = (0, react_1.useMemo)(() => {
        const byId = new Map(baseRows.map(row => [row.id, row]));
        return reconciledSessionOrder(sessionIds, sessionOrderByAccount[stores_1.FLAT_SESSION_ORDER_KEY])
            .flatMap((id) => {
            const row = byId.get(id);
            return row === undefined ? [] : [row];
        });
    }, [baseRows, sessionOrderByAccount, sessionIds]);
    const [drag, setDrag] = (0, react_1.useState)(null);
    const dropCommitted = (0, react_1.useRef)(false);
    useNativeDragAcceptance(drag !== null);
    const commitDrag = (activeDrag, over) => {
        if (dropCommitted.current)
            return;
        dropCommitted.current = true;
        setDrag(null);
        const targetIndex = rows.findIndex(row => row.id === over.id);
        if (targetIndex === -1)
            return;
        const anchor = over.half === 'before' ? over.id : rows[targetIndex + 1]?.id;
        if (anchor === activeDrag.sessionId)
            return;
        const sourceIndex = rows.findIndex(row => row.id === activeDrag.sessionId);
        const anchorIndex = anchor === undefined ? rows.length : rows.findIndex(row => row.id === anchor);
        if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1))
            return;
        const nextOrder = rows.map(row => row.id).filter(id => id !== activeDrag.sessionId);
        const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor);
        nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
        setSessionOrder(stores_1.FLAT_SESSION_ORDER_KEY, nextOrder.map(id => id));
    };
    const now = Date.now();
    return ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.treeBody, WorkspaceBrowser_styles_1.default.wide), children: [(0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.list, WorkspaceBrowser_styles_1.default.flatList), role: "tree", "aria-label": t('section.sessions'), children: [rows.length === 0 && ((0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.empty, children: t('empty.none') })), rows.map((node) => {
                        const active = drag !== null;
                        return ((0, jsx_runtime_1.jsx)(Rows_1.SessionNodeItem, { node: node, currentId: list.current, now: now, onOpen: open, onRename: onSessionRename, onFork: forkSession, onArchive: onSessionArchive, flat: true, drag: {
                                start: () => {
                                    dropCommitted.current = false;
                                    setDrag({ accountKey: stores_1.FLAT_SESSION_ORDER_KEY, sessionId: node.id, over: null });
                                },
                                active,
                                marker: active && drag.over?.id === node.id ? drag.over.half : null,
                                hover: (half) => {
                                    setDrag(current => current === null ? current : { ...current, over: { id: node.id, half } });
                                },
                                drop: (half) => {
                                    if (drag !== null)
                                        commitDrag(drag, { id: node.id, half });
                                },
                                end: () => {
                                    if (drag?.over !== null && drag?.over !== undefined)
                                        commitDrag(drag, drag.over);
                                    else
                                        setDrag(null);
                                    dropCommitted.current = false;
                                },
                            }, t: t }, node.id));
                    })] }), (0, jsx_runtime_1.jsx)("span", { className: WorkspaceBrowser_styles_1.default.fade })] }));
}
/** Same native navigation size as Plugins; opens the shell-owned work page. */
function WorkClock({ wide, active, buttonClassName, t }) {
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('work.open'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: buttonClassName, "data-xharness-work-nav": true, "aria-label": t('work.open'), "aria-current": active ? 'page' : undefined, style: active ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined, onClick: () => window.dispatchEvent(new Event('xharness:work:open')), children: (0, jsx_runtime_1.jsxs)("svg", { width: wide ? 20 : 22, height: wide ? 20 : 22, viewBox: "2 2 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("path", { d: "M20 12a8 8 0 1 1-2.34-5.66" }), (0, jsx_runtime_1.jsx)("path", { d: "M14.4 6.34h3.26V3.1" }), (0, jsx_runtime_1.jsx)("path", { d: "M12 7.5V12l3 1.8" })] }) }) });
}
/** Current product plugin-center navigation glyph (first-class wide/rail entry). */
function PluginOutline16({ size = 16 }) {
    return (0, jsx_runtime_1.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("path", { d: "M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z", transform: "translate(0 -0.75) scale(1.2)", stroke: "currentColor", strokeWidth: 1.15, strokeLinecap: "round", strokeLinejoin: "round" }) });
}
/**
 * Render the browsing region.
 * @param props - composed slot props (shell owner share + store + injected actions).
 * @returns the region element tree.
 */
function WorkspaceBrowser({ wide, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore, createWorkspace, useDirectoryFlow, useHostDescription, renderSlot, t, }) {
    const home = useHostDescription(description => description?.home);
    const workspaces = useWorkspaces(state => state.items);
    const workspacePhase = useWorkspaces(state => state.phase);
    const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds);
    // Live occupancy of this surface's directory-flow hole (the same source the
    // flow reads): a composition without a picking affordance can add nothing.
    const directoryFlowAvailable = useDirectoryFlow(occupied => occupied);
    const groupBy = useStore(s => s.groupBy);
    const orderBy = useStore(s => s.orderBy);
    const groupExpansion = useStore(s => s.groupExpansion);
    const sessionOrderByAccount = useStore(s => s.sessionOrderByAccount);
    const sessionUpdatedAtByAccount = useStore(s => s.sessionUpdatedAtByAccount);
    (0, react_1.useEffect)(() => {
        if (workspacePhase !== 'ready')
            return;
        actions.retainAccountKeys([
            tree_1.UNGROUPED_KEY,
            stores_1.FLAT_SESSION_ORDER_KEY,
            ...workspaces.map(workspace => workspace.workspaceId),
        ]);
    }, [actions.retainAccountKeys, workspacePhase, workspaces]);
    // Section-header ＋ opens the picker menu (same popover in wide and rail
    // states; the menu anchors on this button).
    const [wsPickerOpen, setWsPickerOpen] = (0, react_1.useState)(false);
    const [pluginCenterOpen, setPluginCenterOpen] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => (0, shell_route_1.observeShellPage)('plugins', setPluginCenterOpen), []);
    (0, react_1.useEffect)(() => {
        const openRequestedSession = (event) => { if (event instanceof CustomEvent && typeof event.detail === 'string')
            open(event.detail); };
        window.addEventListener('xharness:work:open-session', openRequestedSession);
        return () => window.removeEventListener('xharness:work:open-session', openRequestedSession);
    }, [open]);
    // Keep navigation state in the region owner so wide/rail remounts retain it.
    const [workCenterOpen, setWorkCenterOpen] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => (0, shell_route_1.observeShellPage)('work', setWorkCenterOpen), []);
    const wsPlusRef = (0, react_1.useRef)(null);
    const composingRef = (0, react_1.useRef)(false);
    // Rename dialog (browser-owned so it outlives row unmounts during collapse).
    const [renameTarget, setRenameTarget] = (0, react_1.useState)(null);
    const [renameDraft, setRenameDraft] = (0, react_1.useState)('');
    const [renaming, setRenaming] = (0, react_1.useState)(false);
    const [renameError, setRenameError] = (0, react_1.useState)(null);
    const renameTrimmed = renameDraft.trim();
    const renameDuplicate = renameTarget !== null && renameTrimmed !== '' && renameTrimmed !== renameTarget.currentTitle
        && workspaces.some(w => w.title === renameTrimmed);
    const renameBlocked = renaming || renameTrimmed === ''
        || renameTarget === null || renameTrimmed === renameTarget.currentTitle || renameDuplicate;
    const closeRename = () => {
        if (renaming)
            return;
        setRenameTarget(null);
        setRenameError(null);
    };
    const confirmRename = () => {
        if (renameBlocked)
            return;
        setRenaming(true);
        setRenameError(null);
        renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
            setRenaming(false);
            setRenameTarget(null);
        }).catch((reason) => {
            setRenaming(false);
            setRenameError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    // Session rename dialog (same browser-owned pattern as workspace rename;
    // sessions have no client-side name-conflict rule — the host normalizes).
    // Unlike workspace rename, an unchanged title is NOT blocked: confirming
    // the current automatic title is the gesture that pins it.
    const [sessionRenameTarget, setSessionRenameTarget] = (0, react_1.useState)(null);
    const [sessionRenameDraft, setSessionRenameDraft] = (0, react_1.useState)('');
    const [sessionRenaming, setSessionRenaming] = (0, react_1.useState)(false);
    const [sessionRenameError, setSessionRenameError] = (0, react_1.useState)(null);
    const sessionRenameTrimmed = sessionRenameDraft.trim();
    const sessionRenameBlocked = sessionRenaming || sessionRenameTrimmed === '' || sessionRenameTarget === null;
    const closeSessionRename = () => {
        if (sessionRenaming)
            return;
        setSessionRenameTarget(null);
        setSessionRenameError(null);
    };
    const confirmSessionRename = () => {
        if (sessionRenameBlocked)
            return;
        setSessionRenaming(true);
        setSessionRenameError(null);
        renameSession(sessionRenameTarget.sessionId, sessionRenameTrimmed).then(() => {
            setSessionRenaming(false);
            setSessionRenameTarget(null);
        }).catch((reason) => {
            setSessionRenaming(false);
            setSessionRenameError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    const onSessionRename = (sessionId, currentTitle) => {
        setSessionRenameTarget({ sessionId, currentTitle });
        setSessionRenameDraft(currentTitle);
        setSessionRenameError(null);
    };
    // Archive is dialog-free: not destructive (the log and the accounting slot
    // remain), so the menu action commits directly; the row disappears when the
    // archive-set echo lands. Failures are non-fatal console diagnostics, the
    // same posture as reorder rejections.
    const onSessionArchive = (sessionId) => {
        archiveSession(sessionId).catch((reason) => {
            console.warn('session archive rejected:', reason);
        });
    };
    // Delete dialog is separate from the row so a successful removal can
    // unmount that row without tearing down the in-flight confirmation state.
    const [deleteTarget, setDeleteTarget] = (0, react_1.useState)(null);
    const [deleting, setDeleting] = (0, react_1.useState)(false);
    const [deleteCommittedId, setDeleteCommittedId] = (0, react_1.useState)(null);
    const [deleteError, setDeleteError] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        if (deleteCommittedId === null
            || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId))
            return;
        setDeleting(false);
        setDeleteCommittedId(null);
        setDeleteTarget(null);
    }, [deleteCommittedId, workspaces]);
    const closeDelete = () => {
        if (deleting)
            return;
        setDeleteTarget(null);
        setDeleteError(null);
    };
    const confirmDelete = () => {
        /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
        if (deleting || deleteTarget === null)
            return;
        setDeleting(true);
        setDeleteCommittedId(null);
        setDeleteError(null);
        deleteWorkspace(deleteTarget.workspaceId).then(() => {
            // Keep the confirmation pending until this component has rendered the
            // committed list projection without the deleted id. Closing earlier
            // exposes one stale React frame to the next Create Workspace gesture.
            setDeleteCommittedId(deleteTarget.workspaceId);
        }).catch((reason) => {
            setDeleting(false);
            setDeleteError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.root, !wide && WorkspaceBrowser_styles_1.default.rail, 'xhwork-browser'), children: [(0, jsx_runtime_1.jsxs)("div", { className: WorkspaceBrowser_styles_1.default.sectionHeader, children: [wide && ((0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.default)(WorkspaceBrowser_styles_1.default.sectionLabel, WorkspaceBrowser_styles_1.default.wide), children: groupBy === 'flat' ? t('section.sessions') : t('section.workspaces') })), (0, jsx_runtime_1.jsxs)("div", { className: WorkspaceBrowser_styles_1.default.headerActions, children: [wide && ((0, jsx_runtime_1.jsx)(ViewOptionsMenu, { groupBy: groupBy, orderBy: orderBy, onGroupPick: (mode) => { actions.setGroupBy(mode); }, onOrderPick: (mode) => { actions.setOrderBy(mode); }, t: t })), directoryFlowAvailable && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('workspace.add'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { ref: wsPlusRef, type: "button", className: WorkspaceBrowser_styles_1.default.iconButton, "aria-label": t('workspace.add'), onClick: () => {
                                        setWsPickerOpen(v => !v);
                                    }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconProjectAddOutline16, { size: wide ? 16 : 18 }) }) })), wide && (0, jsx_runtime_1.jsx)(WorkClock, { wide: wide, active: workCenterOpen, buttonClassName: WorkspaceBrowser_styles_1.default.iconButton, t: t }), wide && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('plugins.open'), side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: WorkspaceBrowser_styles_1.default.iconButton, "data-xharness-plugin-nav": true, "aria-label": t('plugins.open'), "aria-current": pluginCenterOpen ? 'page' : undefined, style: pluginCenterOpen ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined, onClick: () => window.dispatchEvent(new Event('xharness:plugins:open')), children: (0, jsx_runtime_1.jsx)(PluginOutline16, { size: 20 }) }) })] }), (0, jsx_runtime_1.jsx)(WorkspacePicker_1.WorkspacePickFlow, { t: t, open: wsPickerOpen, anchorRef: wsPlusRef, useWorkspaces: useWorkspaces, createWorkspace: createWorkspace, useDirectoryFlow: useDirectoryFlow, renderDirectoryFlow: owner => renderSlot('sidebar.workspaces.directoryFlow', owner), addOnly: true, side: "right", onPick: (workspaceId) => {
                            setWsPickerOpen(false);
                            startSession(workspaceId);
                        }, onClose: () => { setWsPickerOpen(false); } })] }), !wide && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.search, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('plugins.open'), children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: WorkspaceBrowser_styles_1.default.searchButton, "data-xharness-plugin-nav": true, "aria-label": t('plugins.open'), "aria-current": pluginCenterOpen ? 'page' : undefined, style: pluginCenterOpen ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined, onClick: () => window.dispatchEvent(new Event('xharness:plugins:open')), children: (0, jsx_runtime_1.jsx)(PluginOutline16, { size: 22 }) }) }) }), !wide && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.search, children: (0, jsx_runtime_1.jsx)(WorkClock, { wide: wide, active: workCenterOpen, buttonClassName: WorkspaceBrowser_styles_1.default.searchButton, t: t }) }), (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.listArea, children: wide && (groupBy === 'flat'
                    ? ((0, jsx_runtime_1.jsx)(FlatList, { useSessions: useSessions, open: open, forkSession: forkSession, onSessionRename: onSessionRename, onSessionArchive: onSessionArchive, archivedSessionIds: archivedSessionIds, orderBy: orderBy, sessionOrderByAccount: sessionOrderByAccount, sessionUpdatedAtByAccount: sessionUpdatedAtByAccount, syncSessionOrderAccount: actions.syncSessionOrderAccount, setSessionOrder: actions.setSessionOrder, t: t }))
                    : ((0, jsx_runtime_1.jsx)(SessionTree, { useSessions: useSessions, onSessionRename: onSessionRename, onSessionArchive: onSessionArchive, forkSession: forkSession, workspaces: workspaces, groupExpansion: groupExpansion, setGroupExpanded: actions.setGroupExpanded, sessionOrderByAccount: sessionOrderByAccount, sessionUpdatedAtByAccount: sessionUpdatedAtByAccount, syncSessionOrderAccount: actions.syncSessionOrderAccount, setSessionOrder: actions.setSessionOrder, archivedSessionIds: archivedSessionIds, startSession: startSession, open: open, insertWorkspaceBefore: insertWorkspaceBefore, insertSessionBefore: insertSessionBefore, orderBy: orderBy, home: home, t: t, onRenameRequest: (workspaceId, currentTitle) => {
                            setRenameTarget({ workspaceId, currentTitle });
                            setRenameDraft(currentTitle);
                            setRenameError(null);
                        }, onDeleteRequest: (workspaceId, title) => {
                            setDeleteTarget({ workspaceId, title });
                            setDeleteError(null);
                        } }))) }), (0, jsx_runtime_1.jsxs)(primitives_1.Modal, { open: renameTarget !== null, onClose: closeRename, closeLabel: t('close'), title: t('rename.workspace.title'), footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", disabled: renaming, onClick: closeRename, children: t('cancel') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", disabled: renameBlocked, onClick: confirmRename, children: t('rename') })] })), children: [(0, jsx_runtime_1.jsx)("input", { className: WorkspaceBrowser_styles_1.default.renameInput, value: renameDraft, "aria-label": t('field.workspaceName'), autoFocus: true, disabled: renaming, onFocus: (e) => { e.target.select(); }, onChange: (e) => { setRenameDraft(e.target.value); setRenameError(null); }, onCompositionStart: () => { composingRef.current = true; }, onCompositionEnd: () => { composingRef.current = false; }, onKeyDown: (e) => {
                            if (e.key === 'Enter' && !composingRef.current) {
                                e.preventDefault();
                                confirmRename();
                            }
                        } }), renameDuplicate && ((0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.renameError, role: "alert", children: t('conflict.named', { name: renameTrimmed }) })), renameError !== null && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.renameError, role: "alert", children: renameError })] }), (0, jsx_runtime_1.jsxs)(primitives_1.Modal, { open: sessionRenameTarget !== null, onClose: closeSessionRename, closeLabel: t('close'), title: t('rename.session.title'), footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", disabled: sessionRenaming, onClick: closeSessionRename, children: t('cancel') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", disabled: sessionRenameBlocked, onClick: confirmSessionRename, children: t('rename') })] })), children: [(0, jsx_runtime_1.jsx)("input", { className: WorkspaceBrowser_styles_1.default.renameInput, value: sessionRenameDraft, "aria-label": t('field.sessionName'), autoFocus: true, disabled: sessionRenaming, onFocus: (e) => { e.target.select(); }, onChange: (e) => { setSessionRenameDraft(e.target.value); setSessionRenameError(null); }, onCompositionStart: () => { composingRef.current = true; }, onCompositionEnd: () => { composingRef.current = false; }, onKeyDown: (e) => {
                            if (e.key === 'Enter' && !composingRef.current) {
                                e.preventDefault();
                                confirmSessionRename();
                            }
                        } }), sessionRenameError !== null && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.renameError, role: "alert", children: sessionRenameError })] }), (0, jsx_runtime_1.jsxs)(primitives_1.Modal, { open: deleteTarget !== null, onClose: closeDelete, closeLabel: t('close'), title: t('delete.workspace'), ...deleteTarget === null
                    ? {}
                    : { description: t('delete.desc', { name: deleteTarget.title }) }, footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", disabled: deleting, onClick: closeDelete, children: t('cancel') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", className: WorkspaceBrowser_styles_1.default.deleteAction, disabled: deleting, onClick: confirmDelete, children: t('delete.workspace') })] })), children: [deleting && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.deleteStatus, role: "status", children: t('delete.pending') }), deleteError !== null && (0, jsx_runtime_1.jsx)("div", { className: WorkspaceBrowser_styles_1.default.renameError, role: "alert", children: deleteError })] })] }));
}

},
"src/modules/shared/shell-route.js": function(module, exports, require) {
// source: src/modules/shared/shell-route.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHELL_ROUTE_REQUESTED = exports.SHELL_ROUTE_CHANGED = void 0;
exports.observeShellPage = observeShellPage;
/** A display projection, never an instruction to re-run a page's action. */
exports.SHELL_ROUTE_CHANGED = 'xharness:shell-route-changed';
exports.SHELL_ROUTE_REQUESTED = 'xharness:shell-route-requested';
function observeShellPage(page, setActive) {
    const changed = (event) => {
        if (!(event instanceof CustomEvent))
            return;
        const detail = event.detail;
        if (typeof detail === 'object' && detail !== null && 'page' in detail && typeof detail.page === 'string') {
            setActive(detail.page === page);
        }
    };
    window.addEventListener(exports.SHELL_ROUTE_CHANGED, changed);
    // A compact/wide sidebar remount must hydrate its active marker without
    // replaying a feature's ':open' operation or waiting for another visit.
    window.dispatchEvent(new Event(exports.SHELL_ROUTE_REQUESTED));
    return () => window.removeEventListener(exports.SHELL_ROUTE_CHANGED, changed);
}

},
"src/modules/workspace/WorkNavigation.styles.js": function(module, exports, require) {
// source: src/modules/workspace/WorkNavigation.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const WorkNavigation_css_1 = __importDefault(require("./WorkNavigation.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/dsh-client-ui-workspace/WorkNavigation.css', '@xharness/dsh-client-ui-workspace', WorkNavigation_css_1.default);

},
"src/modules/workspace/WorkNavigation.css": function(module, exports, require) {
// source: src/modules/workspace/WorkNavigation.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "/* Reserve room for the new clock without defeating the existing search transition. */\n.xhwork-browser .w3qmIq_headerActions:not(.w3qmIq_headerActionsHidden){max-width:none}\n.xhwork-browser [data-xharness-work-nav]:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}\n";

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
"src/modules/workspace/primitives.js": function(module, exports, require) {
// source: src/modules/workspace/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconSearchOutline16 = exports.IconPersonalizationOutline16 = exports.HoverCard = exports.IconPlusOutline16 = exports.Modal = exports.Menu = void 0;
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "Menu", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Menu; } });
Object.defineProperty(exports, "Modal", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Modal; } });
Object.defineProperty(exports, "IconPlusOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconPlusOutline16; } });
Object.defineProperty(exports, "HoverCard", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.HoverCard; } });
Object.defineProperty(exports, "IconPersonalizationOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconPersonalizationOutline16; } });
Object.defineProperty(exports, "IconSearchOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSearchOutline16; } });

},
"src/modules/workspace/class-names.js": function(module, exports, require) {
// source: src/modules/workspace/class-names.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = clsx;
function isClassArray(value) { return Array.isArray(value); }
/** Complete class-list composition for the migrated presentation-only surfaces. */
function clsx(...values) {
    const output = [];
    const add = (value) => {
        if (!value)
            return;
        if (typeof value === 'string' || typeof value === 'number')
            output.push(String(value));
        else if (isClassArray(value)) {
            for (const child of value)
                add(child);
        }
        else if (typeof value === 'object') {
            for (const key of Object.keys(value))
                if (value[key])
                    output.push(key);
        }
    };
    for (const value of values)
        add(value);
    return output.join(' ');
}

},
"src/modules/workspace/tree.js": function(module, exports, require) {
// source: src/modules/workspace/tree.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNGROUPED_LABEL = exports.UNGROUPED_KEY = void 0;
exports.workspaceLabel = workspaceLabel;
exports.deriveGroups = deriveGroups;
exports.deriveFlat = deriveFlat;
exports.deriveSearchResults = deriveSearchResults;
exports.relativeTime = relativeTime;
const timestamp_1 = require("./timestamp");
const runtime_1 = require("./runtime");
/** Group key for Sessions outside every Workspace. */
exports.UNGROUPED_KEY = '';
/** Display label for the ungrouped bucket row. */
exports.UNGROUPED_LABEL = 'Ungrouped';
/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or the ungrouped label.
 */
function workspaceLabel(cwd) {
    if (cwd === undefined || cwd === '')
        return exports.UNGROUPED_LABEL;
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return base !== undefined && base !== '' ? base : cwd;
}
/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
function byRecency(a, b) {
    if (b.updatedAt !== a.updatedAt)
        return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : 1;
}
/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions are visible nowhere, while their accounting slots remain so
 * unarchiving restores position.
 */
function sessionVisible(session, current, archived) {
    return session.origin !== 'subagent'
        && !archived.has(session.id)
        && (!session.blank || session.id === current);
}
/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session) {
    return session.blank ? 'New Session' : session.displayTitle;
}
/** Build one group without projecting session lineage into presentation. */
function buildGroup(key, workspaceId, cwd, createdAt, label, members, order) {
    const sessions = [...members];
    // Real Workspace order comes from sessionIds. Ungrouped falls back to
    // recency until the browser supplies its persisted local order.
    if (order === 'recency')
        sessions.sort(byRecency);
    return { key, workspaceId, cwd, createdAt, label, sessions };
}
/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(members, stored) {
    const byId = new Map(members.map(session => [session.id, session]));
    const included = new Set();
    const ordered = [];
    for (const key of stored) {
        const session = byId.get(key);
        if (session === undefined || included.has(key))
            continue;
        ordered.push(session);
        included.add(key);
    }
    for (const session of [...members].sort(byRecency)) {
        if (included.has(session.id))
            continue;
        ordered.push(session);
    }
    return ordered;
}
/**
 * Group Sessions by Host Workspace: one group per entity in stable Host
 * order, with members resolved from sessionIds in their stored order. Sessions
 * outside every Workspace trail in the browser-local Ungrouped order, which
 * falls back to recency before that order is initialized.
 */
function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
    const groups = [];
    const accounted = new Set();
    for (const workspace of workspaces) {
        const members = [];
        for (const id of workspace.sessionIds) {
            const summary = list.byId[id];
            if (summary === undefined)
                continue; // account may lead the list pull; the row appears when the summary lands
            accounted.add(id);
            if (!sessionVisible(summary, list.current, archived))
                continue;
            members.push(summary);
        }
        groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, (0, timestamp_1.xhEpochMs)(workspace.createdAt), workspace.title, members, 'account'));
    }
    const stray = list.ids
        .map(id => list.byId[id])
        .filter((s) => s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
    if (stray.length > 0) {
        groups.push(buildGroup(exports.UNGROUPED_KEY, undefined, undefined, undefined, exports.UNGROUPED_LABEL, ungroupedOrder === undefined ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === undefined ? 'recency' : 'account'));
    }
    return groups;
}
function sessionNode(s, descendants) {
    return {
        id: s.id,
        title: sessionTitle(s),
        blank: s.blank,
        running: s.running,
        runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
        completed: s.completed === true,
        updatedAt: s.updatedAt,
        ...(s.pendingInteraction === undefined ? {} : { pendingInteraction: s.pendingInteraction }),
    };
}
/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. Blank sessions are excluded except for the selected
 * provisional New Session row; archived sessions are excluded everywhere.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
function deriveGroups(list, workspaces, archivedSessionIds, view) {
    const archived = new Set(archivedSessionIds);
    const expandedGroups = new Set(view.expandedGroups);
    const descendants = (0, runtime_1.indexSubagentDescendants)(list.byId);
    const current = list.current;
    const currentGroup = current === undefined
        ? undefined
        : (workspaces.find(w => current !== undefined && w.sessionIds.includes(current))?.workspaceId)
            ?? exports.UNGROUPED_KEY;
    const groups = [];
    for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder)) {
        const expanded = expandedGroups.has(g.key);
        groups.push({
            key: g.key,
            workspaceId: g.workspaceId,
            cwd: g.cwd,
            createdAt: g.createdAt,
            label: g.label,
            sessionCount: g.sessions.length,
            expanded,
            containsCurrent: g.key === currentGroup,
            sessions: expanded ? g.sessions.map(session => sessionNode(session, descendants)) : [],
        });
    }
    return groups;
}
/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency. Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns flat rows in render order.
 */
function deriveFlat(list, archivedSessionIds) {
    const archived = new Set(archivedSessionIds);
    const descendants = (0, runtime_1.indexSubagentDescendants)(list.byId);
    const rows = [];
    for (const id of list.ids) {
        const s = list.byId[id];
        if (s === undefined || !sessionVisible(s, list.current, archived))
            continue;
        rows.push(s);
    }
    rows.sort(byRecency);
    return rows.map(session => sessionNode(session, descendants));
}
/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
function deriveSearchResults(list, workspaces, query, archivedSessionIds, content, limit) {
    const q = query.trim().toLowerCase();
    if (q === '')
        return { items: [], hasMore: false };
    const archived = new Set(archivedSessionIds);
    const descendants = (0, runtime_1.indexSubagentDescendants)(list.byId);
    const workspaceBySession = new Map();
    for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds) {
            if (!workspaceBySession.has(sessionId))
                workspaceBySession.set(sessionId, workspace.title);
        }
    }
    const labelOf = (summary) => workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd);
    const contentBySession = new Map();
    for (const item of content.items) {
        if (!contentBySession.has(item.sessionId))
            contentBySession.set(item.sessionId, item);
    }
    const local = [];
    for (const id of list.ids) {
        const summary = list.byId[id];
        // Blank placeholders never match a query (their canonical title displays
        // localized, so matching it would tie search to one language).
        if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived))
            continue;
        if (sessionTitle(summary).toLowerCase().includes(q)
            || labelOf(summary).toLowerCase().includes(q)) {
            local.push(summary);
        }
    }
    local.sort(byRecency);
    const ordered = [];
    const included = new Set();
    const include = (summary) => {
        if (included.has(summary.id))
            return;
        included.add(summary.id);
        ordered.push(summary);
    };
    for (const summary of local)
        include(summary);
    for (const item of content.items) {
        const summary = list.byId[item.sessionId];
        if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived))
            include(summary);
    }
    return {
        items: ordered.slice(0, limit).map((summary) => {
            const match = contentBySession.get(summary.id);
            return {
                id: summary.id,
                title: sessionTitle(summary),
                workspace: labelOf(summary),
                running: summary.running,
                runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
                ...(summary.pendingInteraction === undefined
                    ? {}
                    : { pendingInteraction: summary.pendingInteraction }),
                completed: summary.completed === true,
                ...match === undefined ? {} : { snippet: match.snippet },
            };
        }),
        hasMore: content.hasMore || ordered.length > limit,
    };
}
/**
 * Compact relative time for session rows, as a structured bucket the
 * renderer localizes ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time bucket and magnitude.
 */
function relativeTime(updatedAt, now) {
    const MIN = 60000;
    const HOUR = 3600000;
    const DAY = 86400000;
    const diff = Math.max(0, now - updatedAt);
    if (diff < MIN)
        return { unit: 'now', n: 0 };
    if (diff < HOUR)
        return { unit: 'minutes', n: Math.floor(diff / MIN) };
    if (diff < DAY)
        return { unit: 'hours', n: Math.floor(diff / HOUR) };
    if (diff < 30 * DAY)
        return { unit: 'days', n: Math.floor(diff / DAY) };
    if (diff < 365 * DAY)
        return { unit: 'months', n: Math.floor(diff / (30 * DAY)) };
    return { unit: 'years', n: Math.floor(diff / (365 * DAY)) };
}

},
"src/modules/workspace/timestamp.js": function(module, exports, require) {
// source: src/modules/workspace/timestamp.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhEpochMs = xhEpochMs;
/** Current product parser: Host decimal milliseconds and later ISO timestamps share one ordering/display boundary. */
function xhEpochMs(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : NaN;
    if (typeof value !== 'string')
        return NaN;
    const text = value.trim();
    if (text === '')
        return NaN;
    if (/^-?\d+$/.test(text)) {
        const numeric = Number(text);
        return Number.isSafeInteger(numeric) ? numeric : NaN;
    }
    return Date.parse(text);
}

},
"src/modules/workspace/rows/Rows.js": function(module, exports, require) {
// source: src/modules/workspace/rows/Rows.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectRowItem = ProjectRowItem;
exports.SearchResultItem = SearchResultItem;
exports.SessionNodeItem = SessionNodeItem;
exports.createdLabel = createdLabel;
exports.WorkspaceHoverContent = WorkspaceHoverContent;
const jsx_runtime_1 = require("react/jsx-runtime");
const timestamp_1 = require("../timestamp");
const primitives_1 = require("../primitives");
/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only. Row ... menus are visual-only
 * except workspace Rename/Delete and session Rename/Fork/Archive; the session
 * and workspace hover cards are suppressed while a menu is open.
 */
const react_1 = require("react");
const class_names_1 = __importDefault(require("../class-names"));
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const runtime_1 = require("../runtime");
const tree_1 = require("../tree");
const Rows_styles_1 = __importDefault(require("./Rows.styles"));
/** Row display title: blank rows show the localized New Session label. */
function displayTitle(node, t) {
    return node.blank ? t('session.new') : node.title;
}
/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
function timeLabel(updatedAt, now, t) {
    const { unit, n } = (0, tree_1.relativeTime)(updatedAt, now);
    return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n });
}
/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
function hoverTimeLabel(updatedAt, now, t) {
    const { unit, n } = (0, tree_1.relativeTime)(updatedAt, now);
    return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) });
}
/**
 * Absolute creation time through the dictionary's date template (the message
 * clock pattern): `toLocaleString` would follow the browser language, not the
 * app locale, and produce mixed-language text after a switch.
 */
function createdLabel(createdAt, t) {
    const d = new Date((0, timestamp_1.xhEpochMs)(createdAt));
    if (!Number.isFinite(d.getTime()))
        return undefined;
    const pad2 = (v) => String(v).padStart(2, '0');
    const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
    return t('hover.created', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
}
/** Hover-card body: workspace title, display directory path, absolute creation time. */
function WorkspaceHoverContent({ label, cwd, createdAt, t }) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: Rows_styles_1.default.hoverContent, children: [(0, jsx_runtime_1.jsx)("div", { className: Rows_styles_1.default.hoverTitle, children: label }), (0, jsx_runtime_1.jsx)("div", { className: Rows_styles_1.default.hoverPath, children: cwd }), createdLabel(createdAt, t) === undefined ? null : (0, jsx_runtime_1.jsx)("div", { className: Rows_styles_1.default.hoverTime, children: createdLabel(createdAt, t) })] }));
}
/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
/**
 * Project (workspace) header row: folder + title;
 * hover reveals the chevron and create button, and dwelling on a real
 * Workspace shows its hover card (the ungrouped bucket has none).
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @param props.drag - optional workspace-row drag wiring.
 * @param props.home - host account home for POSIX hover-path abbreviation.
 * @param props.t - the browser root's locale seat.
 * @returns the row element.
 */
function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {
    const row = group;
    // The ungrouped bucket has no workspace title: its label is dictionary copy.
    const label = row.workspaceId === undefined ? t('group.ungrouped') : row.label;
    const active = group.expanded && group.containsCurrent;
    const [menuOpen, setMenuOpen] = (0, react_1.useState)(false);
    const workspaceMenuItems = [
        { id: 'rename', label: t('rename'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, {}) },
        { id: 'delete', label: t('delete.workspace'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTrashOutline16, {}), danger: true },
    ];
    const ownRow = ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(Rows_styles_1.default.projectRow, menuOpen && Rows_styles_1.default.menuOpen), role: "treeitem", "aria-expanded": row.expanded, onClick: onToggle, draggable: drag !== undefined, onDragStart: drag === undefined
            ? undefined
            : (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.key);
                drag.start();
            }, onDragEnd: drag?.end, children: [(0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.default)(Rows_styles_1.default.slot, Rows_styles_1.default.folder, active && Rows_styles_1.default.folderActive), children: row.expanded ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFolderOpen16, {}) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFolderClose16, {}) }), (0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.default)(Rows_styles_1.default.slot, Rows_styles_1.default.chevron), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTriangleRightFill14, { className: (0, class_names_1.default)(Rows_styles_1.default.arrow, row.expanded && Rows_styles_1.default.arrowOpen) }) }), (0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.projectText, children: (0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.title, children: label }) }), (0, jsx_runtime_1.jsxs)("span", { className: Rows_styles_1.default.rowActions, children: [actions !== undefined && ((0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: menuOpen, onClose: () => { setMenuOpen(false); }, items: workspaceMenuItems, onSelect: (id) => {
                            setMenuOpen(false);
                            // Unknown ids leave before the dispatch: a future menu row must
                            // not inherit the destructive branch as an else fallback.
                            /* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */
                            if (id !== 'rename' && id !== 'delete')
                                return;
                            if (id === 'rename')
                                actions.rename();
                            else
                                actions.delete();
                        }, portal: true, closeOnPointerLeave: true, anchor: ((0, jsx_runtime_1.jsx)("button", { type: "button", className: Rows_styles_1.default.iconButton, "aria-label": t('actions.workspace.aria', { name: label }), onClick: (e) => { e.stopPropagation(); setMenuOpen(v => !v); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEllipsisOutline16, {}) })) })), (0, jsx_runtime_1.jsx)("button", { type: "button", className: Rows_styles_1.default.iconButton, "aria-label": t('actions.newSession.aria', { name: label }), onClick: (e) => { e.stopPropagation(); onCreate(); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, {}) })] })] }));
    // The ungrouped bucket has no backing Workspace: no card to show.
    if (row.createdAt === undefined)
        return ownRow;
    return ((0, jsx_runtime_1.jsx)(primitives_1.HoverCard, { anchor: ownRow, content: (0, jsx_runtime_1.jsx)(WorkspaceHoverContent, { label: row.label, cwd: row.cwd === undefined ? undefined : (0, runtime_1.abbreviateHomePath)(row.cwd, home), createdAt: row.createdAt, t: t }), disabled: menuOpen, copyText: row.cwd, copyLabel: t('copy'), copiedLabel: t('hover.copied') }));
}
/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
function assertNever(value) {
    throw new Error(`unknown pending interaction: ${String(value)}`);
}
/**
 * Session status presentation; pending interaction is primary and live activity
 * outranks completion reminders.
 */
function sessionStatuses(node, t) {
    const subagents = node.runningSubagentCount === 0
        ? undefined
        : {
            state: 'ongoing',
            label: t(node.runningSubagentCount === 1
                ? 'status.subagentsRunning.one'
                : 'status.subagentsRunning.other', { n: node.runningSubagentCount }),
        };
    let pending;
    switch (node.pendingInteraction) {
        case 'approval':
            pending = { state: 'warning', label: t('status.waitingApproval') };
            break;
        case 'plan-review':
            pending = { state: 'warning', label: t('status.planReview') };
            break;
        case 'question':
            pending = { state: 'warning', label: t('status.waitingAnswer') };
            break;
        case undefined: break;
        /* v8 ignore next -- closed PendingInteractionStatus union */
        default: return assertNever(node.pendingInteraction);
    }
    if (pending !== undefined)
        return subagents === undefined ? [pending] : [pending, subagents];
    if (node.running) {
        const primary = { state: 'ongoing', label: t('status.running') };
        return subagents === undefined ? [primary] : [primary, subagents];
    }
    if (subagents !== undefined)
        return [subagents];
    if (node.completed)
        return [{ state: 'done', label: t('status.completed') }];
    return [{ state: 'done', label: t('status.idle') }];
}
/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
function SessionStatusDots({ statuses }) {
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: statuses[0].state }), statuses.map(status => ((0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.visuallyHidden, children: status.label }, status.label)))] }));
}
/** Hover-card body: full title, relative time, and every relevant live status. */
function SessionHoverContent({ node, now, t }) {
    const statuses = sessionStatuses(node, t);
    return ((0, jsx_runtime_1.jsxs)("div", { className: Rows_styles_1.default.hoverContent, children: [(0, jsx_runtime_1.jsx)("div", { className: Rows_styles_1.default.hoverTitle, children: displayTitle(node, t) }), !node.blank && (0, jsx_runtime_1.jsx)("div", { className: Rows_styles_1.default.hoverTime, children: hoverTimeLabel(node.updatedAt, now, t) }), statuses.map(status => ((0, jsx_runtime_1.jsxs)("div", { className: Rows_styles_1.default.hoverStatus, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: status.state }), (0, jsx_runtime_1.jsx)("span", { children: status.label })] }, status.label)))] }));
}
/**
 * One flat search result: title, Workspace context, and optional content
 * excerpt. Search navigation opens the session only; it does not address an
 * event inside the conversation.
 * @param props.result - merged local/content search row.
 * @param props.currentId - selected session id.
 * @param props.onOpen - open the selected session.
 * @param props.t - Workspace-browser translation seat.
 * @returns the result button.
 */
function SearchResultItem({ result, currentId, onOpen, t }) {
    const selected = result.id === currentId;
    const statuses = sessionStatuses(result, t);
    const primaryStatus = statuses[0];
    return ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, class_names_1.default)(Rows_styles_1.default.searchResultRow, selected && Rows_styles_1.default.selected), role: "treeitem", "aria-selected": selected, onClick: () => { onOpen(result.id); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: Rows_styles_1.default.searchResultHeading, children: [(0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.slot, children: (primaryStatus.state !== 'done' || result.completed) && ((0, jsx_runtime_1.jsx)(SessionStatusDots, { statuses: statuses })) }), (0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.searchResultTitle, children: result.title })] }), (0, jsx_runtime_1.jsxs)("span", { className: Rows_styles_1.default.searchResultMeta, children: [(0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.searchResultWorkspace, children: result.workspace }), result.snippet !== undefined && ((0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.searchResultSnippet, children: result.snippet }))] })] }));
}
/**
 * One top-level 34px session row: status dot (pending user interaction outranks
 * own or descendant activity), title, relative time, and the row actions menu.
 * @param props.node - derived session node.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @param props.onRename - open the session rename dialog (id + current title).
 * @param props.onFork - fork a session at its last completed turn.
 * @param props.onArchive - archive a session by id.
 * @param props.drag - optional draggable-row wiring.
 * @param props.flat - omit the empty status slot in the hierarchy-free flat list.
 * @param props.t - the browser root's locale seat.
 * @returns the session row.
 */
function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {
    const row = node;
    const title = displayTitle(node, t);
    const selected = node.id === currentId;
    const statuses = sessionStatuses(node, t);
    const primaryStatus = statuses[0];
    const showStatus = primaryStatus.state !== 'done' || row.completed;
    const [menuOpen, setMenuOpen] = (0, react_1.useState)(false);
    // Archive hides the row through the registry-global archive set and never
    // touches the session log, so it is not styled as destructive and needs no
    // confirmation dialog.
    const sessionMenuItems = [
        { id: 'rename', label: t('rename'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, {}) },
        { id: 'fork', label: t('menu.fork'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, {}) },
        // 20-native glyph in the menu's 16px icon slot (Menu.styles .itemIcon).
        { id: 'archive', label: t('menu.archiveSession'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconArchiveOutline20, { size: 16 }) },
    ];
    // Figma session cell: pad 8, status slot 16, then a 4px title gap.
    const ownRow = ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.default)(Rows_styles_1.default.sessionRow, selected && Rows_styles_1.default.selected, menuOpen && Rows_styles_1.default.menuOpen, flat && !showStatus && Rows_styles_1.default.flatSessionRowWithoutStatus, drag?.marker === 'before' && Rows_styles_1.default.dropBefore, drag?.marker === 'after' && Rows_styles_1.default.dropAfter), role: "treeitem", "aria-selected": selected, onClick: () => { onOpen(node.id); }, draggable: drag !== undefined, onDragStart: drag === undefined
            ? undefined
            : (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.id);
                drag.start();
            }, onDragEnd: drag?.end, onDragOver: drag === undefined
            ? undefined
            : (e) => {
                if (!drag.active)
                    return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                drag.hover(rowHalf(e));
            }, onDrop: drag === undefined
            ? undefined
            : (e) => {
                if (!drag.active)
                    return;
                e.preventDefault();
                drag.drop(rowHalf(e));
            }, children: [(!flat || showStatus) && ((0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.slot, children: showStatus && (0, jsx_runtime_1.jsx)(SessionStatusDots, { statuses: statuses }) })), (0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.title, children: title }), !row.blank && (0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.time, children: timeLabel(row.updatedAt, now, t) }), !row.blank && ((0, jsx_runtime_1.jsx)("span", { className: Rows_styles_1.default.rowActions, children: (0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: menuOpen, onClose: () => { setMenuOpen(false); }, items: sessionMenuItems, onSelect: (id) => {
                        setMenuOpen(false);
                        if (id === 'rename')
                            onRename(node.id, row.title);
                        if (id === 'fork')
                            onFork(node.id);
                        if (id === 'archive')
                            onArchive(node.id);
                    }, portal: true, closeOnPointerLeave: true, anchor: ((0, jsx_runtime_1.jsx)("button", { type: "button", className: Rows_styles_1.default.iconButton, "aria-label": t('actions.session.aria', { name: title }), onClick: (e) => { e.stopPropagation(); setMenuOpen(v => !v); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEllipsisOutline16, {}) })) }) }))] }));
    return ((0, jsx_runtime_1.jsx)(primitives_1.HoverCard, { anchor: ownRow, content: (0, jsx_runtime_1.jsx)(SessionHoverContent, { node: node, now: now, t: t }), disabled: menuOpen || drag?.active === true, copyText: row.blank ? undefined : row.title, copyLabel: t('copy'), copiedLabel: t('hover.copied') }));
}

},
"src/modules/workspace/rows/Rows.styles.js": function(module, exports, require) {
// source: src/modules/workspace/rows/Rows.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Rows_css_1 = __importDefault(require("./Rows.css"));
const foundation_styles_1 = require("../../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-workspace/Rows.module.css", "@xharness/dsh-client-ui-workspace", Rows_css_1.default);
const styles = {
    "arrow": "PT4Uyq_arrow",
    "arrowOpen": "PT4Uyq_arrowOpen",
    "chevron": "PT4Uyq_chevron",
    "dot": "PT4Uyq_dot",
    "dropAfter": "PT4Uyq_dropAfter",
    "dropBefore": "PT4Uyq_dropBefore",
    "flatSessionRowWithoutStatus": "PT4Uyq_flatSessionRowWithoutStatus",
    "folder": "PT4Uyq_folder",
    "folderActive": "PT4Uyq_folderActive",
    "hoverContent": "PT4Uyq_hoverContent",
    "hoverPath": "PT4Uyq_hoverPath",
    "hoverStatus": "PT4Uyq_hoverStatus",
    "hoverTime": "PT4Uyq_hoverTime",
    "hoverTitle": "PT4Uyq_hoverTitle",
    "iconButton": "PT4Uyq_iconButton",
    "menuOpen": "PT4Uyq_menuOpen",
    "meta": "PT4Uyq_meta",
    "projectRow": "PT4Uyq_projectRow",
    "projectText": "PT4Uyq_projectText",
    "renameInput": "PT4Uyq_renameInput",
    "row-in": "PT4Uyq_row-in",
    "rowActions": "PT4Uyq_rowActions",
    "searchResultHeading": "PT4Uyq_searchResultHeading",
    "searchResultMeta": "PT4Uyq_searchResultMeta",
    "searchResultRow": "PT4Uyq_searchResultRow",
    "searchResultSnippet": "PT4Uyq_searchResultSnippet",
    "searchResultTitle": "PT4Uyq_searchResultTitle",
    "searchResultWorkspace": "PT4Uyq_searchResultWorkspace",
    "selected": "PT4Uyq_selected",
    "sessionRow": "PT4Uyq_sessionRow",
    "slot": "PT4Uyq_slot",
    "time": "PT4Uyq_time",
    "title": "PT4Uyq_title",
    "visuallyHidden": "PT4Uyq_visuallyHidden"
};
exports.default = styles;

},
"src/modules/workspace/rows/Rows.css": function(module, exports, require) {
// source: src/modules/workspace/rows/Rows.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".PT4Uyq_projectRow,.PT4Uyq_sessionRow{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:6px;padding:0 8px;display:flex}.PT4Uyq_projectRow:hover,.PT4Uyq_sessionRow:hover,.PT4Uyq_sessionRow.PT4Uyq_selected{background:var(--dsw-alias-interactive-bg-hover)}.PT4Uyq_searchResultRow{box-sizing:border-box;cursor:pointer;text-align:left;width:100%;min-height:48px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:8px;flex-direction:column;align-items:stretch;padding:4px 8px;display:flex}.PT4Uyq_searchResultRow:hover,.PT4Uyq_searchResultRow.PT4Uyq_selected{background:var(--dsw-alias-interactive-bg-hover)}.PT4Uyq_searchResultHeading{align-items:center;min-width:0;display:flex}.PT4Uyq_searchResultTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden}.PT4Uyq_searchResultMeta{align-items:center;gap:6px;min-width:0;margin-left:20px;display:flex}.PT4Uyq_searchResultWorkspace,.PT4Uyq_searchResultSnippet{text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.PT4Uyq_searchResultWorkspace{max-width:40%;color:var(--dsw-alias-label-tertiary);flex:none}.PT4Uyq_searchResultSnippet{min-width:0;color:var(--dsw-alias-label-secondary);flex:1}.PT4Uyq_projectRow{box-sizing:border-box;align-items:center;height:34px}.PT4Uyq_projectRow .PT4Uyq_rowActions{height:20px}.PT4Uyq_sessionRow{height:32px;animation:PT4Uyq_row-in .15s var(--ds-ease-in-out);gap:0}.PT4Uyq_sessionRow .PT4Uyq_title{margin:0 6px 0 4px}.PT4Uyq_flatSessionRowWithoutStatus .PT4Uyq_title{margin-left:0}@keyframes PT4Uyq_row-in{0%{opacity:0}}.PT4Uyq_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.PT4Uyq_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.PT4Uyq_folderActive{color:var(--dsw-alias-state-business-primary)}.PT4Uyq_projectRow .PT4Uyq_chevron{display:none}.PT4Uyq_projectRow:hover .PT4Uyq_chevron{display:inline-flex}.PT4Uyq_projectRow:hover .PT4Uyq_folder{display:none}.PT4Uyq_arrow{transition:transform .15s var(--ds-ease-in-out)}.PT4Uyq_arrowOpen{transform:rotate(90deg)}.PT4Uyq_projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.PT4Uyq_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}.PT4Uyq_renameInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);min-width:0;color:inherit;border-radius:4px;outline:none;padding:0 2px;font-size:14px;line-height:20px}.PT4Uyq_sessionRow .PT4Uyq_title{flex:1}.PT4Uyq_meta{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden}.PT4Uyq_time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:20px}.PT4Uyq_dot{flex:none}.PT4Uyq_rowActions{flex:none;align-items:center;gap:12px;display:none}.PT4Uyq_projectRow:hover .PT4Uyq_rowActions,.PT4Uyq_sessionRow:hover .PT4Uyq_rowActions,.PT4Uyq_projectRow.PT4Uyq_menuOpen .PT4Uyq_rowActions,.PT4Uyq_sessionRow.PT4Uyq_menuOpen .PT4Uyq_rowActions{display:inline-flex}.PT4Uyq_sessionRow:hover .PT4Uyq_time,.PT4Uyq_sessionRow.PT4Uyq_menuOpen .PT4Uyq_time{display:none}.PT4Uyq_projectRow.PT4Uyq_menuOpen,.PT4Uyq_sessionRow.PT4Uyq_menuOpen{background:var(--dsw-alias-interactive-bg-hover)}.PT4Uyq_sessionRow.PT4Uyq_dropBefore,.PT4Uyq_sessionRow.PT4Uyq_dropAfter{position:relative}.PT4Uyq_sessionRow.PT4Uyq_dropBefore:before,.PT4Uyq_sessionRow.PT4Uyq_dropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:4px}.PT4Uyq_sessionRow.PT4Uyq_dropBefore:before{top:-7px}.PT4Uyq_sessionRow.PT4Uyq_dropAfter:after{bottom:-7px}.PT4Uyq_hoverContent{flex-direction:column;gap:8px;display:flex}.PT4Uyq_hoverTitle{color:#fff;overflow-wrap:break-word;font-size:14px;line-height:20px}.PT4Uyq_hoverPath{color:#cfd3d6;word-break:break-all;font-size:12px;line-height:16px}.PT4Uyq_hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}.PT4Uyq_hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}.PT4Uyq_iconButton{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.PT4Uyq_iconButton:hover{color:var(--dsw-alias-label-primary)}.PT4Uyq_chevron{color:var(--dsw-alias-label-caption)}@media (prefers-reduced-motion:reduce){.PT4Uyq_sessionRow,.PT4Uyq_arrow{transition:none;animation:none}}";

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
"src/modules/workspace/WorkspacePicker.js": function(module, exports, require) {
// source: src/modules/workspace/WorkspacePicker.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspacePickFlow = WorkspacePickFlow;
exports.WorkspacePicker = WorkspacePicker;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const WorkspacePicker_styles_1 = __importDefault(require("./WorkspacePicker.styles"));
const ADD_WORKSPACE = '::add-workspace';
/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
function WorkspacePickFlow({ t, open, anchorRef, useWorkspaces, createWorkspace, useDirectoryFlow, renderDirectoryFlow, onPick, onClose, addOnly = false, side = 'bottom', selectedId, }) {
    const workspaceSnapshot = useWorkspaces(state => state);
    const workspaces = workspaceSnapshot.items;
    const getAnchorRect = (0, react_1.useCallback)(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef]);
    const [errorOpen, setErrorOpen] = (0, react_1.useState)(false);
    const [modalError, setModalError] = (0, react_1.useState)(null);
    const [flowOpen, setFlowOpen] = (0, react_1.useState)(false);
    const [pickingFolder, setPickingFolder] = (0, react_1.useState)(false);
    // One picking interaction at a time: while the flow is open (native chooser
    // pending, browse dialog up) or its pick is being adopted, every other
    // menu action stays disabled — a late outcome must not race a concurrent
    // selection or adoption.
    const flowBusy = flowOpen || pickingFolder;
    // The occupied hole gates the picking affordance: with no composed flow the
    // entry simply is not there (the seam's documented no-flow default). The
    // framework-bound hook keeps occupancy live: flow plugins activate (and
    // HMR-reload) independently of this menu's renders.
    const flowAvailable = useDirectoryFlow(occupied => occupied);
    // An occupant that unloads mid-interaction leaves nobody to cancel: an
    // open flow over an empty hole withdraws so the menu actions come back.
    // flowOpen is a dependency because the flow can also OPEN over an already
    // empty hole (Choose again after the occupant unloaded with the error
    // dialog up) — that transition must snap back too, not just occupancy loss.
    (0, react_1.useEffect)(() => {
        if (flowOpen && !flowAvailable)
            setFlowOpen(false);
    }, [flowOpen, flowAvailable]);
    const addEntries = flowAvailable
        ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: (0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, { size: 16 }), disabled: flowBusy }]
        : [];
    // With workspaces listed, the add action pins below the scroll region
    // (divider + always visible); otherwise it IS the menu.
    const pinAdd = !addOnly && workspaces.length > 0;
    const items = pinAdd
        ? workspaces.map(workspace => ({
            id: workspace.workspaceId,
            label: workspace.title,
            icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFolderClose16, { size: 16 }),
            disabled: flowBusy,
        }))
        : addEntries;
    // Nothing listed and nothing to add with (a composition that mounts this
    // package without any directory-picker): an empty popover would claim a
    // choice that does not exist, so the anchor gesture shows nothing at all.
    const menuIsEmpty = items.length === 0;
    const closeModal = () => {
        setErrorOpen(false);
        setModalError(null);
    };
    /** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
    const adoptDirectory = (path) => createWorkspace({ path }).then((workspace) => {
        setFlowOpen(false);
        onPick(workspace.workspaceId);
    }).catch((reason) => {
        setModalError(reason instanceof Error ? reason.message : String(reason));
        setFlowOpen(false);
        setErrorOpen(true);
    });
    const openDirectoryFlow = (0, react_1.useCallback)(() => {
        onClose();
        setErrorOpen(false);
        setModalError(null);
        setFlowOpen(true);
    }, [onClose]);
    // A menu exists to disambiguate between targets. With no workspaces listed
    // and the add action the only entry left, the anchor gesture IS that action:
    // a one-row popover would cost a click and offer nothing to choose between.
    // The owner's open request is consumed the same way selecting the entry
    // would consume it (close the popover, raise the flow). An empty list is
    // only final once the baseline lands — until then the menu stays up with its
    // loading status instead of jumping into a flow the arriving list would have
    // made unnecessary; the add-only surface lists nothing and never waits.
    const listSettled = addOnly || workspaceSnapshot.phase === 'ready';
    const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1;
    // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
    // pick still being adopted owns the surface until it settles.
    (0, react_1.useEffect)(() => {
        if (open && addIsTheOnlyEntry && !flowBusy)
            openDirectoryFlow();
    }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow]);
    /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
    const flowOwner = {
        open: flowOpen,
        busy: pickingFolder,
        onPicked: (path) => {
            setPickingFolder(true);
            void adoptDirectory(path).finally(() => { setPickingFolder(false); });
        },
        onCancel: () => { setFlowOpen(false); },
        onError: (message) => {
            setFlowOpen(false);
            setModalError(message);
            setErrorOpen(true);
        },
    };
    const handleSelect = (id) => {
        if (id === ADD_WORKSPACE) {
            openDirectoryFlow();
            return;
        }
        onPick(id);
    };
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Menu, { open: open && !addIsTheOnlyEntry && !menuIsEmpty, anchor: null, items: items, ...pinAdd ? { footer: addEntries } : {}, selectedId: selectedId, onSelect: handleSelect, onClose: onClose, side: side, portal: true, getAnchorRect: getAnchorRect }), open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && (0, jsx_runtime_1.jsx)("div", { className: WorkspacePicker_styles_1.default.menuStatus, role: "status", children: t('picker.loading') }), renderDirectoryFlow(flowOwner), (0, jsx_runtime_1.jsx)(primitives_1.Modal, { open: errorOpen, onClose: closeModal, closeLabel: t('close'), title: t('folderError.title'), footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", className: WorkspacePicker_styles_1.default.modalAction, onClick: closeModal, children: t('cancel') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", className: WorkspacePicker_styles_1.default.modalAction, disabled: !flowAvailable, onClick: openDirectoryFlow, children: t('folderError.retry') })] })), children: (0, jsx_runtime_1.jsx)("div", { className: WorkspacePicker_styles_1.default.modalError, role: "alert", children: modalError }) })] }));
}
/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
function WorkspacePicker({ open, anchorRef, useWorkspaces, selectedId, onPick, onClose, createWorkspace, useDirectoryFlow, renderSlot, t, }) {
    return ((0, jsx_runtime_1.jsx)(WorkspacePickFlow, { t: t, open: open, anchorRef: anchorRef, useWorkspaces: useWorkspaces, createWorkspace: createWorkspace, useDirectoryFlow: useDirectoryFlow, renderDirectoryFlow: owner => renderSlot('conversation.hero.workspace.directoryFlow', owner), selectedId: selectedId, onPick: onPick, onClose: onClose }));
}

},
"src/modules/workspace/WorkspacePicker.styles.js": function(module, exports, require) {
// source: src/modules/workspace/WorkspacePicker.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const WorkspacePicker_css_1 = __importDefault(require("./WorkspacePicker.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-workspace/WorkspacePicker.module.css", "@xharness/dsh-client-ui-workspace", WorkspacePicker_css_1.default);
const styles = {
    "menuStatus": "b5KM_q_menuStatus",
    "modalAction": "b5KM_q_modalAction",
    "modalError": "b5KM_q_modalError"
};
exports.default = styles;

},
"src/modules/workspace/WorkspacePicker.css": function(module, exports, require) {
// source: src/modules/workspace/WorkspacePicker.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".b5KM_q_modalAction{min-width:72px}.b5KM_q_modalError,.b5KM_q_menuStatus{margin-top:8px;font-size:12px;line-height:18px}.b5KM_q_modalError{color:var(--dsw-alias-state-error-primary)}.b5KM_q_menuStatus{color:var(--dsw-alias-label-secondary)}";

},
"src/modules/workspace/WorkspaceBrowser.styles.js": function(module, exports, require) {
// source: src/modules/workspace/WorkspaceBrowser.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const WorkspaceBrowser_css_1 = __importDefault(require("./WorkspaceBrowser.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-workspace/WorkspaceBrowser.module.css", "@xharness/dsh-client-ui-workspace", WorkspaceBrowser_css_1.default);
const styles = {
    "clearButton": "w3qmIq_clearButton",
    "deleteAction": "w3qmIq_deleteAction",
    "deleteStatus": "w3qmIq_deleteStatus",
    "empty": "w3qmIq_empty",
    "fade": "w3qmIq_fade",
    "flatList": "w3qmIq_flatList",
    "groupSection": "w3qmIq_groupSection",
    "headerActions": "w3qmIq_headerActions",
    "headerActionsHidden": "w3qmIq_headerActionsHidden",
    "iconButton": "w3qmIq_iconButton",
    "list": "w3qmIq_list",
    "listArea": "w3qmIq_listArea",
    "listTopDropActive": "w3qmIq_listTopDropActive",
    "listTopDropIndicator": "w3qmIq_listTopDropIndicator",
    "rail": "w3qmIq_rail",
    "renameError": "w3qmIq_renameError",
    "renameInput": "w3qmIq_renameInput",
    "root": "w3qmIq_root",
    "search": "w3qmIq_search",
    "searchButton": "w3qmIq_searchButton",
    "searchExpanded": "w3qmIq_searchExpanded",
    "searchInput": "w3qmIq_searchInput",
    "searchSlot": "w3qmIq_searchSlot",
    "searchSlotExpanded": "w3qmIq_searchSlotExpanded",
    "searchStatus": "w3qmIq_searchStatus",
    "searchTree": "w3qmIq_searchTree",
    "searchWarning": "w3qmIq_searchWarning",
    "sectionHeader": "w3qmIq_sectionHeader",
    "sectionLabel": "w3qmIq_sectionLabel",
    "sectionLabelHidden": "w3qmIq_sectionLabelHidden",
    "sessionOverflowButton": "w3qmIq_sessionOverflowButton",
    "treeBody": "w3qmIq_treeBody",
    "wide": "w3qmIq_wide",
    "wide-in": "w3qmIq_wide-in",
    "workspaceDropAfter": "w3qmIq_workspaceDropAfter",
    "workspaceDropBefore": "w3qmIq_workspaceDropBefore"
};
exports.default = styles;

},
"src/modules/workspace/WorkspaceBrowser.css": function(module, exports, require) {
// source: src/modules/workspace/WorkspaceBrowser.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".w3qmIq_root{--dsh-session-list-edge-inset:var(--dsh-sidebar-inline-padding);--dsh-session-list-scrollbar-width:8px;--dsh-session-list-scrollbar-offset:2px;box-sizing:border-box;min-height:0;padding-right:var(--dsh-session-list-edge-inset);flex-direction:column;flex:1;display:flex}.w3qmIq_root.w3qmIq_rail{padding-right:0}.w3qmIq_iconButton{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.w3qmIq_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.w3qmIq_sectionHeader{box-sizing:border-box;height:36px;color:var(--dsw-alias-label-tertiary);border-radius:12px;flex:none;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px;padding-left:4px;display:flex;overflow:hidden}.w3qmIq_root:not(.w3qmIq_rail) .w3qmIq_sectionHeader{margin-top:2px;margin-right:-4px}.w3qmIq_sectionLabel{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;margin-right:auto;transition:max-width .18s var(--ds-ease-in-out), margin-right .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:0 1 auto;text-overflow:ellipsis;line-height:20px;overflow:hidden}.w3qmIq_sectionLabelHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px;transition-delay:0s,0s,0s,0s,.18s;transform:translate(-4px)}.w3qmIq_searchSlot{box-sizing:border-box;min-width:0;max-width:28px;transition:max-width .18s var(--ds-ease-in-out), padding-left .18s var(--ds-ease-in-out);flex:1;align-items:center;margin-left:auto;padding-left:0;display:flex}.w3qmIq_searchSlotExpanded{max-width:100%;padding-left:0}.w3qmIq_headerActions{opacity:1;visibility:visible;max-width:60px;transition:max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}.w3qmIq_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0;transition-delay:0s,0s,0s,.18s;transform:translate(4px)}.w3qmIq_search{box-sizing:border-box;cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);transition:width .18s var(--ds-ease-in-out), padding .18s var(--ds-ease-in-out), border-color .18s var(--ds-ease-in-out), background-color .18s var(--ds-ease-in-out);background:0 0;border:none;border-radius:50%;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}.w3qmIq_searchExpanded{border:1px solid var(--dsw-alias-border-l2);width:calc(100% + 4px);height:30px;color:var(--dsw-alias-label-caption);background:0 0;border-radius:10px;margin-inline:-2px;padding:0 4px 0 0}.w3qmIq_searchButton{cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.w3qmIq_searchExpanded .w3qmIq_searchButton{width:28px;height:30px}.w3qmIq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.w3qmIq_searchExpanded .w3qmIq_searchButton:hover{background:0 0}.w3qmIq_searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);transition:opacity .12s var(--ds-ease-in-out);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}.w3qmIq_searchExpanded .w3qmIq_searchInput{opacity:1;pointer-events:auto;margin-left:-2px}.w3qmIq_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}.w3qmIq_clearButton{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.w3qmIq_clearButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.w3qmIq_rail .w3qmIq_sectionHeader{justify-content:flex-start;gap:0;margin-bottom:12px;padding-left:0}.w3qmIq_rail .w3qmIq_headerActions{max-width:none}.w3qmIq_rail .w3qmIq_iconButton{width:36px;height:36px;color:var(--dsw-alias-label-primary)}.w3qmIq_rail .w3qmIq_search{background:0 0;border-color:#0000;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.w3qmIq_rail .w3qmIq_searchButton{width:36px;height:36px;color:var(--dsw-alias-label-primary)}.w3qmIq_rail .w3qmIq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.w3qmIq_listArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-session-list-edge-inset));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:visible}.w3qmIq_rail .w3qmIq_listArea{margin-left:0;margin-right:0;padding-left:0}.w3qmIq_treeBody{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.w3qmIq_fade{left:0;right:var(--dsh-session-list-edge-inset);background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill));pointer-events:none;height:24px;position:absolute;bottom:0}.w3qmIq_wide{animation:w3qmIq_wide-in .2s var(--ds-ease-in-out)}@keyframes w3qmIq_wide-in{0%{opacity:0}}.w3qmIq_list{min-height:0;margin-left:-4px;margin-right:var(--dsh-session-list-scrollbar-offset);padding-left:4px;padding-right:calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));scrollbar-gutter:stable;flex:1;padding-bottom:16px;overflow-y:auto}.w3qmIq_flatList>*+*,.w3qmIq_searchTree>[role=treeitem]+[role=treeitem],.w3qmIq_groupSection>*+*{margin-top:2px}.w3qmIq_searchStatus,.w3qmIq_searchWarning{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.w3qmIq_searchWarning{color:var(--dsw-alias-label-secondary)}.w3qmIq_groupSection{position:relative}.w3qmIq_groupSection+.w3qmIq_groupSection{margin-top:4px}.w3qmIq_listTopDropIndicator,.w3qmIq_workspaceDropBefore:before,.w3qmIq_workspaceDropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:0}.w3qmIq_listTopDropIndicator{top:-8px;left:0;right:var(--dsh-session-list-edge-inset)}.w3qmIq_listTopDropActive>.w3qmIq_workspaceDropBefore:first-child:before{display:none}.w3qmIq_workspaceDropBefore:before{top:-8px}.w3qmIq_workspaceDropAfter:after{bottom:-8px}.w3qmIq_sessionOverflowButton{cursor:pointer;text-align:left;width:100%;height:28px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:8px;padding:0 12px 0 28px;font-size:12px}.w3qmIq_groupSection>.w3qmIq_sessionOverflowButton{margin-top:0}.w3qmIq_sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary);background:0 0}.w3qmIq_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}.w3qmIq_renameInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;border-radius:22px;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.w3qmIq_renameInput:disabled{color:var(--dsw-alias-label-dimmed)}.w3qmIq_renameError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.w3qmIq_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.w3qmIq_deleteStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}@media (prefers-reduced-motion:reduce){.w3qmIq_wide{animation:none}.w3qmIq_search,.w3qmIq_sectionLabel,.w3qmIq_searchSlot,.w3qmIq_searchInput,.w3qmIq_headerActions{transition:none}}";

},
"src/modules/workspace/locales.js": function(module, exports, require) {
// source: src/modules/workspace/locales.ts

"use strict";
/**
 * `workspace` namespace dictionaries: the browsing region (section header,
 * search, tree rows, dialogs) and the pick/add flow. Runtime failure
 * messages (wire error strings) pass through untranslated by policy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'work.label': '工作',
    'work.open': '任务与自动化',
    'work.tasks': '任务',
    'work.automations': '自动化',
    'plugins.open': '插件',
    'group.ungrouped': '未分组',
    'session.new': '新会话',
    'section.workspaces': '工作区',
    'section.sessions': '会话',
    'viewOptions.label': '视图选项',
    'groupBy.label': '分组方式',
    'groupBy.workspace': '按工作区',
    'groupBy.flat': '单列表',
    'orderBy.label': '排序方式',
    'orderBy.manual': '手动排序',
    'orderBy.updated': '最近更新',
    'sessions.expand': '展开其余 {n} 个会话',
    'sessions.collapse': '收起',
    'empty.none': '暂无会话',
    'empty.noMatches': '无匹配结果',
    'workspace.add': '添加工作区',
    'search.sessions.aria': '搜索会话',
    'search.placeholder': '搜索会话…',
    'search.clear': '清除搜索',
    'search.results.aria': '搜索结果',
    'search.pending': '正在搜索会话历史…',
    'search.unavailable': '内容搜索暂不可用，仅显示名称匹配。',
    'search.noMatches': '无匹配会话',
    'search.hasMore': '仅显示前 {n} 条结果，请缩小搜索范围。',
    'menu.addWorkspace': '添加工作区…',
    'picker.loading': '正在加载工作区…',
    'conflict.named': '已存在名为“{name}”的工作区。',
    'folderError.title': '无法打开文件夹',
    'folderError.retry': '重新选择',
    'rename': '重命名',
    'rename.workspace.title': '重命名工作区',
    'rename.session.title': '重命名会话',
    'field.workspaceName': '工作区名称',
    'field.sessionName': '会话名称',
    'delete.workspace': '删除工作区',
    'delete.desc': '将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。',
    'delete.pending': '正在删除工作区…',
    'menu.fork': '分叉会话',
    'menu.archiveSession': '归档会话',
    'sessions.count.one': '{n} 个会话',
    'sessions.count.other': '{n} 个会话',
    'actions.workspace.aria': '工作区“{name}”的操作',
    'actions.session.aria': '会话“{name}”的操作',
    'actions.newSession.aria': '在“{name}”中新建会话',
    'status.running': '进行中',
    'status.subagentsRunning.one': '{n} 个子代理运行中',
    'status.subagentsRunning.other': '{n} 个子代理运行中',
    'status.idle': '空闲',
    'status.waitingApproval': '等待审批',
    'status.planReview': '计划待审',
    'status.waitingAnswer': '等待回答',
    'status.completed': '已完成',
    'hover.created': '创建于 {time}',
    'hover.copied': '已复制',
    'date.ymd': '{y}年{m}月{d}日',
    'time.now': '刚刚',
    'time.minutes': '{n}分钟',
    'time.hours': '{n}小时',
    'time.days': '{n}天',
    'time.months': '{n}个月',
    'time.years': '{n}年',
    'time.ago': '{t}前',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'work.label': 'Work',
    'work.open': 'Tasks and automations',
    'work.tasks': 'Tasks',
    'work.automations': 'Automations',
    'plugins.open': 'Plugins',
    'group.ungrouped': 'Ungrouped',
    'session.new': 'New Session',
    'section.workspaces': 'Workspaces',
    'section.sessions': 'Sessions',
    'viewOptions.label': 'View options',
    'groupBy.label': 'Group by',
    'groupBy.workspace': 'WorkSpace',
    'groupBy.flat': 'In one list',
    'orderBy.label': 'Order by',
    'orderBy.manual': 'Manual',
    'orderBy.updated': 'Last updated',
    'sessions.expand': 'Show {n} more sessions',
    'sessions.collapse': 'Show less',
    'empty.none': 'No sessions yet',
    'empty.noMatches': 'No matches',
    'workspace.add': 'Add workspace',
    'search.sessions.aria': 'Search sessions',
    'search.placeholder': 'Search sessions...',
    'search.clear': 'Clear search',
    'search.results.aria': 'Search results',
    'search.pending': 'Searching session history…',
    'search.unavailable': 'Content search is temporarily unavailable. Showing name matches.',
    'search.noMatches': 'No matching sessions',
    'search.hasMore': 'Showing the first {n} results. Narrow your search.',
    'menu.addWorkspace': 'Add workspace…',
    'picker.loading': 'Loading workspaces…',
    'conflict.named': 'A workspace named “{name}” already exists.',
    'folderError.title': 'Couldn’t open folder',
    'folderError.retry': 'Choose again',
    'rename': 'Rename',
    'rename.workspace.title': 'Rename workspace',
    'rename.session.title': 'Rename session',
    'field.workspaceName': 'Workspace name',
    'field.sessionName': 'Session name',
    'delete.workspace': 'Delete workspace',
    'delete.desc': 'This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
    'delete.pending': 'Deleting workspace…',
    'menu.fork': 'Fork session',
    'menu.archiveSession': 'Archive session',
    'sessions.count.one': '{n} session',
    'sessions.count.other': '{n} sessions',
    'actions.workspace.aria': 'Workspace actions for {name}',
    'actions.session.aria': 'Session actions for {name}',
    'actions.newSession.aria': 'New session in {name}',
    'status.running': 'Running',
    'status.subagentsRunning.one': '{n} subagent running',
    'status.subagentsRunning.other': '{n} subagents running',
    'status.idle': 'Idle',
    'status.waitingApproval': 'Waiting for approval',
    'status.planReview': 'Plan awaiting review',
    'status.waitingAnswer': 'Waiting for answer',
    'status.completed': 'Completed',
    'hover.created': 'Created {time}',
    'hover.copied': 'Copied',
    'date.ymd': '{y}-{m}-{d}',
    'time.now': 'now',
    'time.minutes': '{n}min',
    'time.hours': '{n}h',
    'time.days': '{n}d',
    'time.months': '{n}mo',
    'time.years': '{n}y',
    'time.ago': '{t} ago',
};

}
};
const __dependencies = {"src/modules/workspace/index.js":{"./stores":"src/modules/workspace/stores.js","./WorkspaceBrowser":"src/modules/workspace/WorkspaceBrowser.js","./WorkspacePicker":"src/modules/workspace/WorkspacePicker.js","./locales":"src/modules/workspace/locales.js"},"src/modules/workspace/stores.js":{"./runtime":"src/modules/workspace/runtime.js"},"src/modules/workspace/runtime.js":{},"src/modules/workspace/WorkspaceBrowser.js":{"../shared/shell-route":"src/modules/shared/shell-route.js","./WorkNavigation.styles":"src/modules/workspace/WorkNavigation.styles.js","./primitives":"src/modules/workspace/primitives.js","./class-names":"src/modules/workspace/class-names.js","./tree":"src/modules/workspace/tree.js","./rows/Rows":"src/modules/workspace/rows/Rows.js","./stores":"src/modules/workspace/stores.js","./WorkspacePicker":"src/modules/workspace/WorkspacePicker.js","./WorkspaceBrowser.styles":"src/modules/workspace/WorkspaceBrowser.styles.js"},"src/modules/shared/shell-route.js":{},"src/modules/workspace/WorkNavigation.styles.js":{"./WorkNavigation.css":"src/modules/workspace/WorkNavigation.css","../views-types":"src/modules/views-types.js"},"src/modules/workspace/WorkNavigation.css":{},"src/modules/views-types.js":{},"src/modules/workspace/primitives.js":{},"src/modules/workspace/class-names.js":{},"src/modules/workspace/tree.js":{"./timestamp":"src/modules/workspace/timestamp.js","./runtime":"src/modules/workspace/runtime.js"},"src/modules/workspace/timestamp.js":{},"src/modules/workspace/rows/Rows.js":{"../timestamp":"src/modules/workspace/timestamp.js","../primitives":"src/modules/workspace/primitives.js","../class-names":"src/modules/workspace/class-names.js","../runtime":"src/modules/workspace/runtime.js","../tree":"src/modules/workspace/tree.js","./Rows.styles":"src/modules/workspace/rows/Rows.styles.js"},"src/modules/workspace/rows/Rows.styles.js":{"./Rows.css":"src/modules/workspace/rows/Rows.css","../../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/workspace/rows/Rows.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/workspace/WorkspacePicker.js":{"./primitives":"src/modules/workspace/primitives.js","./WorkspacePicker.styles":"src/modules/workspace/WorkspacePicker.styles.js"},"src/modules/workspace/WorkspacePicker.styles.js":{"./WorkspacePicker.css":"src/modules/workspace/WorkspacePicker.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/workspace/WorkspacePicker.css":{},"src/modules/workspace/WorkspaceBrowser.styles.js":{"./WorkspaceBrowser.css":"src/modules/workspace/WorkspaceBrowser.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/workspace/WorkspaceBrowser.css":{},"src/modules/workspace/locales.js":{}};
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
return __load("src/modules/workspace/index.js");
}
});
