// Generated from src/modules/settings-models/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings-models",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings-models/index.js": function(module, exports, require) {
// source: src/modules/settings-models/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.refreshIfLoaded = refreshIfLoaded;
exports.apply = apply;
/// <reference path="./external.d.ts" />
const ManagedAccount_1 = require("./ManagedAccount");
const ModelsSection_1 = require("./ModelsSection");
const store_1 = require("./store");
const schema_operations_1 = require("./schema-operations");
const welcome_store_1 = require("./welcome-store");
const onboarding_copy_1 = require("./onboarding-copy");
const locales_1 = require("./locales");
const NS = 'settings.models';
exports.inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema'];
function refreshIfLoaded(controller) {
    if (controller.store.getSnapshot().status === 'idle')
        return;
    void controller.load();
}
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-settings-models: copy dictionaries');
    const connection = ctx.get('connection'), schema = (0, schema_operations_1.createSettingsSchemaOperations)(ctx.settingsSchema);
    const controller = new store_1.ModelsSettingsStore(connection.api, schema, ctx.settingsScope.describe());
    ctx.effect(() => ctx.locale.register("xharness-managed-account", ManagedAccount_1.managedLabels), "managed-account: locale");
    ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "managed-account", order: 11, label: () => ctx.locale.bind("xharness-managed-account")("nav"), inject: () => ({ api: connection.api, describe: ctx.settingsScope.describe(), t: ctx.locale.bind("xharness-managed-account") }) }, ManagedAccount_1.ManagedAccount));
    const t = ctx.locale.bind(NS);
    const injected = () => ({ controller, hooks: { snapshot: controller.store }, api: connection.api, schema, t });
    // Retain the current bound scope's lifecycle, but do not reinstall removed
    // vendor welcome/onboarding dialogs during this source migration.
    const welcomeController = new welcome_store_1.WelcomeNoticeStore(ctx.settingsScope.bind({ namespace: onboarding_copy_1.WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: welcome_store_1.decodeWelcomeSection }));
    ctx.effect(() => {
        const refreshModels = () => { refreshIfLoaded(controller); };
        const disposers = [
            ctx.remote.$on('settings/document-updated', refreshModels), ctx.remote.$on('credentials/updated', refreshModels),
            ctx.remote.$on('llm/adapters-updated', refreshModels), ctx.on('connection/reset', refreshModels),
        ];
        return () => { welcomeController.dispose(); for (const dispose of disposers)
            dispose(); };
    }, 'ui-settings-models: pushed invalidations');
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'models', order: 10, label: () => t('nav'), inject: injected }, ModelsSection_1.ModelsSection));
}

},
"src/modules/settings-models/ManagedAccount.js": function(module, exports, require) {
// source: src/modules/settings-models/ManagedAccount.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.managedLabels = void 0;
exports.saveManagedAccess = saveManagedAccess;
exports.ManagedAccount = ManagedAccount;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const runtime_types_1 = require("../shared/runtime-types");
const REF = 'XHARNESS_MANAGED_API_TOKEN', ROUTE = 'xharness-managed', NS = 'llm-pi-ai';
exports.managedLabels = {
    zh: { nav: '账户与模型服务', title: 'XHarness 模型服务', intro: '连接管理员分配的模型额度。自有模型配置不会改变。', connect: '连接账号', open: '打开登录网页', code: '连接代码', waiting: '在网页确认连接后，软件会自动接入。', done: '已连接。请在模型选择中选择 XHarness 服务。', cancel: '取消', disconnect: '移除本机连接', disconnectConfirm: '移除本机密钥？已授权设备仍可在账户网页撤销。', web: '请在桌面软件中连接账号。', error: '连接未完成，请重试或检查账号额度。', retry: '重试保存', manage: '账户与额度', clear: '在账户网页可撤销已授权设备。' },
    en: { nav: 'Account & model service', title: 'XHarness model service', intro: 'Connect model allowance assigned by your administrator. Your own providers remain unchanged.', connect: 'Connect account', open: 'Open sign-in page', code: 'Connection code', waiting: 'Confirm in the website; the app will connect automatically.', done: 'Connected. Select XHarness in the model picker.', cancel: 'Cancel', disconnect: 'Remove local connection', disconnectConfirm: 'Remove this local credential? Authorized devices can still be revoked on the account website.', web: 'Connect your account in the desktop app.', error: 'Connection incomplete. Retry or check your model allowance.', retry: 'Retry saving', manage: 'Account & allowance', clear: 'Revoke authorized devices on the account website.' }
};
async function saveManagedAccess(api, describe, raw) {
    const v = (0, runtime_types_1.objectValue)(raw);
    if (v.status !== 'authorized' || typeof v.accessToken !== 'string' || typeof v.baseURL !== 'string' || !Array.isArray(v.models))
        throw Error('invalid_access');
    await describe.ensure();
    const snap = describe.getSnapshot();
    const ns = snap.view?.namespaces.find(n => n.ns === NS);
    if (snap.status !== 'ready' || !ns || !snap.view?.writable)
        throw Error('settings_unavailable');
    const existing = (0, runtime_types_1.objectValue)((0, runtime_types_1.objectValue)(ns.value).providers)[ROUTE];
    if (existing !== undefined) {
        const p = (0, runtime_types_1.objectValue)(existing);
        if (p.apiKeyEnv !== REF || p.baseURL !== v.baseURL || p.api !== 'openai-completions')
            throw Error('provider_conflict');
    }
    const profile = { displayName: 'XHarness', api: 'openai-completions', baseURL: v.baseURL, apiKeyEnv: REF, models: v.models };
    const write = await api.settings.mutate({ ns: NS, expectedRevision: ns.revision, ops: [{ op: 'set', path: ['providers', ROUTE], value: profile }] });
    if (!write.result.ok)
        throw Error('settings_write_failed');
    describe.acceptView(write.result.value);
    const stored = await api.credentials.set({ ref: REF, value: v.accessToken });
    if (!stored.result.ok)
        throw Error('credential_store_failed');
}
function ManagedAccount({ api, describe, t }) {
    const invoke = window.__TAURI__?.core?.invoke;
    const [flow, setFlow] = (0, react_1.useState)(null), [connected, setConnected] = (0, react_1.useState)(false), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(false), [retry, setRetry] = (0, react_1.useState)(false);
    const alive = (0, react_1.useRef)(true), saving = (0, react_1.useRef)(false), halted = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => { alive.current = true; if (invoke)
        void invoke('desktop_account_status').then(raw => { const v = (0, runtime_types_1.objectValue)(raw); if (alive.current && typeof v.userCode === 'string' && typeof v.verificationUri === 'string')
            setFlow({ code: v.userCode, uri: v.verificationUri }); }).catch(() => { if (alive.current)
            setError(true); }); void api.credentials.describe({ refs: [REF] }).then(r => { if (alive.current && r.result.ok)
        setConnected(r.result.value.credentials[REF]?.configured === true); }); return () => { alive.current = false; }; }, [api, invoke]);
    (0, react_1.useEffect)(() => { if (!flow || !invoke)
        return; let active = true; const tick = async () => { if (saving.current || halted.current)
        return; saving.current = true; try {
        const raw = await invoke('desktop_account_poll');
        if (!active)
            return;
        const v = (0, runtime_types_1.objectValue)(raw);
        if (v.status === 'authorized') {
            await saveManagedAccess(api, describe, raw);
            await invoke('desktop_account_finish', { saved: true });
            if (active) {
                setConnected(true);
                setFlow(null);
                setError(false);
                setRetry(false);
            }
        }
    }
    catch {
        if (active) {
            setError(true);
            setRetry(true);
            halted.current = true;
        }
    }
    finally {
        saving.current = false;
    } }; const timer = setInterval(() => { void tick(); }, 5000); return () => { active = false; clearInterval(timer); }; }, [flow, invoke, api, describe]);
    async function start() { if (!invoke || busy)
        return; setBusy(true); setError(false); try {
        const v = (0, runtime_types_1.objectValue)(await invoke('desktop_account_start'));
        if (typeof v.userCode !== 'string' || typeof v.verificationUri !== 'string')
            throw Error();
        if (alive.current)
            setFlow({ code: v.userCode, uri: v.verificationUri });
    }
    catch {
        if (alive.current)
            setError(true);
    }
    finally {
        if (alive.current)
            setBusy(false);
    } }
    async function cancel() { if (!invoke || saving.current || busy)
        return; setBusy(true); try {
        await invoke('desktop_account_finish', { saved: false });
        setFlow(null);
        setRetry(false);
        halted.current = false;
    }
    catch {
        setError(true);
    }
    finally {
        setBusy(false);
    } }
    async function disconnect() { if (busy || !confirm(t('disconnectConfirm')))
        return; setBusy(true); try {
        const r = await api.credentials.unset({ ref: REF });
        if (!r.result.ok)
            throw Error();
        setConnected(false);
    }
    catch {
        setError(true);
    }
    finally {
        setBusy(false);
    } }
    return (0, jsx_runtime_1.jsxs)("div", { className: "xhe-root", children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("p", { children: t('intro') })] }), !invoke ? (0, jsx_runtime_1.jsx)("p", { children: t('web') }) : flow ? (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("p", { children: [t('code'), ": ", (0, jsx_runtime_1.jsx)("strong", { children: flow.code })] }), (0, jsx_runtime_1.jsx)("button", { onClick: () => void invoke('desktop_account_open').catch(() => setError(true)), children: t('open') }), (0, jsx_runtime_1.jsx)("p", { children: t('waiting') }), (0, jsx_runtime_1.jsx)("button", { disabled: busy || saving.current, onClick: () => void cancel(), children: t('cancel') }), retry && (0, jsx_runtime_1.jsx)("button", { onClick: () => { halted.current = false; setRetry(false); setError(false); }, children: t('retry') })] }) : connected ? (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("p", { role: "status", children: t('done') }), (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void disconnect(), children: t('disconnect') }), (0, jsx_runtime_1.jsx)("p", { children: t('clear') })] }) : (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void start(), children: t('connect') }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: t('error') })] });
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
"src/modules/settings-models/ModelsSection.js": function(module, exports, require) {
// source: src/modules/settings-models/ModelsSection.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeProviderProfile = removeProviderProfile;
exports.needsSetup = needsSetup;
exports.providerTargetLabel = providerTargetLabel;
exports.providerCopy = providerCopy;
exports.ModelsSection = ModelsSection;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card; the add flow is a card carrying the
 * dormant-provider select. Each card kind owns its own open state, so closing
 * one never discards a draft in another. Every mutation writes through the
 * wire, while a provider removal first requires confirmation; the page
 * re-renders from pushed invalidations or the post-apply reload.
 */
const react_1 = require("react");
const primitives_1 = require("./primitives");
const CustomProviderCard_1 = require("./CustomProviderCard");
const store_1 = require("./store");
const ProviderEditor_1 = require("./ProviderEditor");
const styles_1 = require("./styles");
/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }) {
    return ((0, jsx_runtime_1.jsx)(ProviderEditor_1.ProviderEditor, { provider: target.provider, displayName: target.displayName, settingsPath: target.settingsPath, ...target.declared === true ? { declared: true } : {}, ...props }));
}
/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param api - settings and credential wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
async function removeProviderProfile(api, controller, target) {
    try {
        if (target.credentialRef !== undefined) {
            const credential = await api.credentials.unset({ ref: target.credentialRef });
            if (!credential.result.ok)
                return credential.result.error.message;
        }
        const response = await api.settings.mutate({
            ns: target.settingsNs,
            ops: [{ op: 'unset', path: [...target.settingsPath] }],
        });
        if (!response.result.ok)
            return response.result.error.message;
    }
    catch (error) {
        // The transport rejected rather than answering; the caller must be able
        // to retry the idempotent operation instead of the row silently staying.
        return (0, store_1.messageOf)(error);
    }
    await controller.load();
    return undefined;
}
/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
function needsSetup(row, anyUsable) {
    if (anyUsable)
        return false;
    if (row.entry.settingsPath.length > 0)
        return false;
    return row.credential?.configured !== true;
}
function targetOf(row) {
    const managedRef = (0, store_1.deriveKeyRef)(row.entry.provider);
    const credentialRef = row.apiKeyEnv === managedRef
        && row.credential?.configured === true
        && row.credential.writable
        ? managedRef
        : undefined;
    return {
        provider: row.entry.provider,
        displayName: row.entry.displayName,
        settingsNs: row.entry.settingsNs,
        settingsPath: row.entry.settingsPath,
        ...credentialRef === undefined ? {} : { credentialRef },
        // Absent is not "shipped": an adapter that answers nothing leaves the
        // route-level fields only a declared route owns off the card, exactly as
        // it leaves the custom tag off the row.
        ...row.entry.declared === true ? { declared: true } : {},
    };
}
/** Stable visible and accessible identity for one provider target. */
function providerTargetLabel(target) {
    return target.provider === target.displayName
        ? target.provider
        : `${target.displayName} (${target.provider})`;
}
/** Replace the one provider placeholder in localized destructive-action copy. */
function providerCopy(template, target) {
    return template.replace('{provider}', () => providerTargetLabel(target));
}
/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
function ModelsSection(props) {
    const { controller, useSnapshot, api, schema, t } = props;
    if (controller === undefined || useSnapshot === undefined || api === undefined
        || schema === undefined || t === undefined)
        return null;
    return (0, jsx_runtime_1.jsx)(Loaded, { injected: { controller, useSnapshot, api, schema, t } });
}
function Loaded({ injected }) {
    const { controller, api, schema, t } = injected;
    const state = injected.useSnapshot(snapshot => snapshot);
    const [editing, setEditing] = (0, react_1.useState)(undefined);
    const [adding, setAdding] = (0, react_1.useState)(false);
    const [deleteTarget, setDeleteTarget] = (0, react_1.useState)(undefined);
    const [deleting, setDeleting] = (0, react_1.useState)(false);
    const [deleteFailure, setDeleteFailure] = (0, react_1.useState)(undefined);
    const [savedTarget, setSavedTarget] = (0, react_1.useState)(undefined);
    const [declaring, setDeclaring] = (0, react_1.useState)(false);
    const [dismissedSetup, setDismissedSetup] = (0, react_1.useState)(() => new Set());
    const announceSaved = (target) => {
        // Announced only once the refreshed directory is in the snapshot the
        // notice reads its name from: an apply can rename the route, and the
        // target captured when the card opened still carries the old name.
        void controller.load().then(() => { setSavedTarget(target); });
    };
    const closeEditor = (changed, target) => {
        setEditing(undefined);
        setAdding(false);
        setDeclaring(false);
        if (changed)
            announceSaved(target);
    };
    /**
     * Close a setup card, which owns none of the state above: the row-editor,
     * add, and declare cards each own one of those, so clearing them here would
     * discard a draft the user opened beside this card. Dismissal is this card's
     * own — the provider falls back to an ordinary row for the rest of the
     * session, and reopens through Edit.
     */
    const closeSetup = (changed, target) => {
        setDismissedSetup(previous => new Set([...previous, target.provider]));
        if (changed)
            announceSaved(target);
    };
    const closeDelete = () => {
        if (deleting)
            return;
        setDeleteTarget(undefined);
        setDeleteFailure(undefined);
    };
    const confirmDelete = () => {
        /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
        if (deleteTarget === undefined || deleting)
            return;
        setDeleting(true);
        setDeleteFailure(undefined);
        void removeProviderProfile(api, controller, deleteTarget)
            .then((failure) => {
            if (failure !== undefined) {
                setDeleteFailure(failure);
                return;
            }
            setDeleteTarget(undefined);
        })
            .finally(() => { setDeleting(false); });
    };
    if (state.status === 'idle')
        void controller.load();
    if (state.status === 'error') {
        /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
        const errorText = state.error ?? '';
        return ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['section'], children: [(0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: `${t('loadFailed')}: ${errorText}` }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['secondaryButton'], onClick: () => { void controller.load(); }, children: t('retry') })] }));
    }
    // The saved provider as the directory currently names it. The route id is
    // what the apply cannot change, so it is what the notice is keyed by; a row
    // the same apply removed keeps the captured identity, since nothing newer
    // exists to name it with.
    const savedRow = savedTarget === undefined
        ? undefined
        : state.rows.find(row => row.entry.provider === savedTarget.provider);
    const savedIdentity = savedRow === undefined
        ? savedTarget
        : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName };
    // One fact decides both first-run postures on this page and the onboarding
    // step: whether the user already has a provider to talk to.
    const anyUsable = state.rows.some(store_1.providerUsable);
    const configured = state.rows.filter(row => row.configured);
    const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '');
    const addTarget = adding ? editing : undefined;
    const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs);
    // Hand-declared routes live in the pi-ai namespace, which is also the only
    // one whose schema names the protocols one may speak; without it mounted
    // there is nothing to declare and the entry point stays disabled.
    const protocols = (0, store_1.protocolChoices)(state.namespaces.get('llm-pi-ai'), schema);
    return ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['section'], children: [(0, jsx_runtime_1.jsx)("h2", { className: styles_1.ModelsSectionCss['title'], children: t('title') }), (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['intro'], children: t('intro') }), !state.writable && state.status === 'ready' ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['notice'], children: t('readOnly') }) : null, savedIdentity === undefined
                ? null
                : ((0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['savedNotice'], role: "status", "aria-live": "polite", children: providerCopy(t('savedProvider'), savedIdentity) })), (0, jsx_runtime_1.jsx)("ul", { className: styles_1.ModelsSectionCss['rows'], children: configured.map((row) => {
                    const target = targetOf(row);
                    const namespace = state.namespaces.get(target.settingsNs);
                    /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
                    if (namespace === undefined)
                        return null;
                    if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
                        // First-run posture: the provider exists but has no key — the
                        // setup card IS its presence on the page, until the user closes it.
                        return ((0, jsx_runtime_1.jsx)("li", { className: styles_1.ModelsSectionCss['setupCard'], children: renderProviderEditor({
                                target,
                                namespace,
                                schema,
                                api,
                                t,
                                readOnly: !state.writable,
                                onClose: (changed) => { closeSetup(changed, target); },
                            }) }, row.entry.provider));
                    }
                    const open = !adding && editing?.provider === row.entry.provider;
                    const credentialConfigured = row.credential?.configured === true;
                    const credentialMissing = !credentialConfigured
                        && row.apiKeyEnv !== undefined
                        && row.credential?.configured === false;
                    return ((0, jsx_runtime_1.jsxs)("li", { className: styles_1.ModelsSectionCss['rowCard'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['rowHead'], children: [(0, jsx_runtime_1.jsxs)("span", { className: styles_1.ModelsSectionCss['rowIdentity'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['rowName'], children: row.entry.displayName }), row.entry.declared === true
                                                ? (0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['rowTag'], children: t('customTag') })
                                                : null, credentialConfigured
                                                ? ((0, jsx_runtime_1.jsx)("span", { className: `${styles_1.ModelsSectionCss['credentialDot']} ${styles_1.ModelsSectionCss['credentialDotConfigured']}`, role: "img", "aria-label": t('credentialConfigured'), title: t('credentialConfigured') }))
                                                : credentialMissing
                                                    ? ((0, jsx_runtime_1.jsx)("span", { className: `${styles_1.ModelsSectionCss['credentialDot']} ${styles_1.ModelsSectionCss['credentialDotMissing']}`, role: "img", "aria-label": t('credentialMissing'), title: t('credentialMissing') }))
                                                    : null] }), (0, jsx_runtime_1.jsxs)("span", { className: styles_1.ModelsSectionCss['rowActions'], children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['secondaryButton'], "aria-label": providerCopy(t('editProvider'), target), onClick: () => {
                                                    setSavedTarget(undefined);
                                                    // One card at a time: leaving `declaring` set would show
                                                    // the create card beside this editor, and closing either
                                                    // one discards the other's draft.
                                                    setDeclaring(false);
                                                    setAdding(false);
                                                    setEditing(open ? undefined : target);
                                                }, children: t('edit') }), row.removable
                                                ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['dangerButton'], "aria-label": providerCopy(t('removeProvider'), target), disabled: !state.writable, onClick: () => {
                                                        setSavedTarget(undefined);
                                                        setDeleteFailure(undefined);
                                                        setDeleteTarget(target);
                                                    }, children: t('remove') }))
                                                : null] })] }), open
                                ? renderProviderEditor({
                                    target,
                                    namespace,
                                    schema,
                                    api,
                                    t,
                                    readOnly: !state.writable,
                                    onClose: (changed) => { closeEditor(changed, target); },
                                })
                                : null] }, row.entry.provider));
                }) }), (0, jsx_runtime_1.jsx)("div", { className: styles_1.ModelsSectionCss['addBlock'], children: addTarget !== undefined && addNamespace !== undefined
                    ? ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['addCard'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('provider') }), (0, jsx_runtime_1.jsx)("select", { className: `${styles_1.ModelsSectionCss['input']} ${styles_1.ModelsSectionCss['selectInput']}`, value: addTarget.provider, "aria-label": t('provider'), onChange: (event) => {
                                            const row = addable.find(candidate => candidate.entry.provider === event.target.value);
                                            /* v8 ignore next -- the select only lists addable rows */
                                            if (row === undefined)
                                                return;
                                            setEditing(targetOf(row));
                                        }, children: addable.map(row => ((0, jsx_runtime_1.jsx)("option", { value: row.entry.provider, children: row.entry.displayName }, row.entry.provider))) })] }), (0, jsx_runtime_1.jsx)(ProviderEditor_1.ProviderEditor, { provider: addTarget.provider, displayName: addTarget.displayName, hideTitle: true, namespace: addNamespace, schema: schema, settingsPath: addTarget.settingsPath, api: api, t: t, readOnly: !state.writable, onClose: (changed) => { closeEditor(changed, addTarget); } }, addTarget.provider)] }))
                    : declaring
                        ? ((0, jsx_runtime_1.jsx)("div", { className: styles_1.ModelsSectionCss['addCard'], children: (0, jsx_runtime_1.jsx)(CustomProviderCard_1.CustomProviderCard, { taken: state.rows.map(row => row.entry.provider), protocols: protocols,
                                /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                                revision: state.namespaces.get('llm-pi-ai')?.revision ?? 0, api: api, t: t, readOnly: !state.writable, onClose: (changed) => {
                                    setDeclaring(false);
                                    if (changed)
                                        void controller.load();
                                } }) }))
                        : (
                        // One row for the two ways to gain a provider: adopt one the
                        // adapter already knows, or declare one it does not. Side by side
                        // and equal-width so they read as siblings and line up with the
                        // rows above, rather than two pills of different lengths.
                        (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['addActions'], children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: styles_1.ModelsSectionCss['addButton'], disabled: addable.length === 0 || !state.writable, onClick: () => {
                                        const first = addable[0];
                                        /* v8 ignore next -- the button is disabled while nothing is addable */
                                        if (first === undefined)
                                            return;
                                        setSavedTarget(undefined);
                                        setDeclaring(false);
                                        setAdding(true);
                                        setEditing(targetOf(first));
                                    }, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, { size: 14 }), t('add')] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: styles_1.ModelsSectionCss['addButton'], disabled: protocols.length === 0 || !state.writable, onClick: () => {
                                        setSavedTarget(undefined);
                                        setAdding(false);
                                        setEditing(undefined);
                                        setDeclaring(true);
                                    }, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, { size: 14 }), t('customAdd')] })] })) }), (0, jsx_runtime_1.jsx)(primitives_1.Modal, { open: deleteTarget !== undefined, onClose: closeDelete, title: deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget), closeLabel: t('close'), description: deleteTarget === undefined
                    ? ''
                    : providerCopy(deleteTarget.credentialRef === undefined
                        ? t('deleteDescription')
                        : t('deleteDescriptionWithCredential'), deleteTarget), className: styles_1.ModelsSectionCss['deleteDialog'], footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", autoFocus: true, disabled: deleting, onClick: closeDelete, children: t('cancel') }), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", className: styles_1.ModelsSectionCss['deleteConfirm'], disabled: deleting, onClick: confirmDelete, children: deleteTarget === undefined
                                ? ''
                                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget) })] })), children: deleteFailure === undefined ? null : (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: deleteFailure }) })] }));
}

},
"src/modules/settings-models/primitives.js": function(module, exports, require) {
// source: src/modules/settings-models/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconTrashOutline16 = exports.IconChevronRightOutline14 = exports.IconChevronDownOutline14 = exports.IconPlusOutline16 = exports.Modal = exports.Button = void 0;
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "Button", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Button; } });
Object.defineProperty(exports, "Modal", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Modal; } });
Object.defineProperty(exports, "IconPlusOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconPlusOutline16; } });
Object.defineProperty(exports, "IconChevronDownOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronDownOutline14; } });
Object.defineProperty(exports, "IconChevronRightOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronRightOutline14; } });
Object.defineProperty(exports, "IconTrashOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconTrashOutline16; } });

},
"src/modules/settings-models/CustomProviderCard.js": function(module, exports, require) {
// source: src/modules/settings-models/CustomProviderCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomProviderCard = CustomProviderCard;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own card rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. One `settings.mutate`
 * sets the whole profile at `providers.<route>`; the key travels separately
 * through `credentials.set` under the reference the profile records, exactly as
 * an existing provider's key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * There is deliberately no reasoning-effort control, here or on the editor
 * card: effort is a per-MODEL capability, and the models under one provider
 * disagree about it, so a provider-scoped control can only be set to a value
 * some of them reject. The composer's model picker offers each model its own
 * levels instead.
 */
const react_1 = require("react");
const apiKey_1 = require("./apiKey");
const EditorFooter_1 = require("./EditorFooter");
const DeepSeekModelsEditor_1 = require("./DeepSeekModelsEditor");
const ModelListEditor_1 = require("./ModelListEditor");
const store_1 = require("./store");
const styles_1 = require("./styles");
/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai';
/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit. A
 * digit-leading id passes every check this card makes and then fails at the
 * credential seam with a raw regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
function CustomProviderCard(props) {
    const { taken, protocols, api, t } = props;
    // Captured at mount, like the editor's: the write must be judged against the
    // section this card was drafted over, not whatever it grew into meanwhile.
    const [openedAt] = (0, react_1.useState)(() => props.revision);
    const [route, setRoute] = (0, react_1.useState)('');
    const [displayName, setDisplayName] = (0, react_1.useState)('');
    const [baseURL, setBaseURL] = (0, react_1.useState)('');
    const [protocol, setProtocol] = (0, react_1.useState)(protocols[0] ?? '');
    const [keyDraft, setKeyDraft] = (0, react_1.useState)('');
    const [models, setModels] = (0, react_1.useState)([]);
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [failure, setFailure] = (0, react_1.useState)(undefined);
    /**
     * The profile write landed. Only the key write can still be outstanding, so
     * the fields that describe the provider are settled and the retry path is
     * the credential alone.
     */
    const [committed, setCommitted] = (0, react_1.useState)(false);
    const disabled = props.readOnly || busy;
    /** Everything but the key stops being editable once the provider exists. */
    const profileDisabled = disabled || committed;
    const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route);
    const routeTaken = taken.includes(route);
    // Rows are checked by the same per-row validator the editor cards use, so a
    // bad row is named by its position here too. Capacities have route-level
    // fallbacks; what a route cannot default is at least one model.
    const modelFailure = (0, DeepSeekModelsEditor_1.validateDeepSeekModels)(models);
    const keyFailure = (0, apiKey_1.apiKeyFailure)(keyDraft);
    // The typed key with paste whitespace removed. A blank field yields an empty
    // string, which the create path reads as "no key supplied" — a route may
    // legitimately authenticate through the provider's own ambient discovery.
    const keyValue = keyDraft.trim();
    const ready = route.length > 0 && !routeInvalid && !routeTaken
        && baseURL.length > 0 && models.length > 0 && modelFailure === undefined
        && keyFailure === undefined;
    // The one blocked gate worth a line under the form. A satisfied card says
    // nothing at all rather than printing an empty paragraph.
    const hint = failure !== undefined || ready
        // The key field prints its own failure directly beneath itself, so a card
        // blocked only by the key stays silent here rather than answering with the
        // next unmet gate — which is satisfied, and reads as a second, false fault.
        || keyFailure !== undefined
        // Same for the route id, and it must be tested rather than assumed: the
        // fallback arm below reads "no models yet", so an unmet route gate would
        // fall through to it and contradict the filled-in list right above.
        || route.length === 0 || routeInvalid || routeTaken
        ? undefined
        : baseURL.length === 0
            ? t('customNeedsBaseUrl')
            : modelFailure !== undefined
                ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
                : t('customNeedsModels');
    /** Perform the create, returning a failure message or undefined. */
    const createOnce = async () => {
        const keyRef = (0, store_1.deriveKeyRef)(route);
        const storesKey = keyValue.length > 0;
        if (!committed) {
            const profile = {
                ...displayName.length === 0 ? {} : { displayName },
                // The profile names the conventional reference only when this card is
                // about to store a key, matching the editor: a route declared with the
                // key left blank keeps its provider-native auth path (a credential
                // chain, ADC) instead of resolving a reference nothing ever sets.
                ...storesKey ? { apiKeyEnv: keyRef } : {},
                api: protocol,
                baseURL,
                models: models.map(model => ({ ...model })),
            };
            const response = await api.settings.mutate({
                ns: NS,
                ops: [{ op: 'set', path: ['providers', route], value: profile }],
                // `taken` is a snapshot too, so the id check alone cannot see a route
                // declared after this card opened; the revision makes that race a
                // `settings-conflict` instead of a write over the other profile.
                expectedRevision: openedAt,
            });
            if (!response.result.ok)
                return response.result.error.message;
            // The provider now exists. A retry after the key write below fails must
            // not re-run this mutate: the revision it holds is the one this write
            // just superseded, so the Host would answer `settings-conflict` and the
            // key could never be stored from this card at all.
            setCommitted(true);
        }
        if (storesKey) {
            const stored = await api.credentials.set({ ref: keyRef, value: keyValue });
            // The profile landed; saying the key did not is the only honest report,
            // and the retry above now goes straight back to this write.
            if (!stored.result.ok)
                return stored.result.error.message;
        }
        return undefined;
    };
    const create = async () => {
        setBusy(true);
        setFailure(undefined);
        try {
            const outcome = await createOnce();
            if (outcome !== undefined) {
                setFailure(outcome);
                return;
            }
            props.onClose(true);
        }
        catch (error) {
            // A transport failure rejects rather than answering; without this the
            // card would stay busy with nothing shown.
            setFailure((0, store_1.messageOf)(error));
        }
        finally {
            setBusy(false);
        }
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['editor'], children: [(0, jsx_runtime_1.jsx)("div", { className: styles_1.ModelsSectionCss['editorHeader'], children: (0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['editorTitle'], children: t('customTitle') }) }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('customRoute') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: route, placeholder: "acme-gateway", "aria-label": t('customRoute'), disabled: profileDisabled, onChange: (event) => { setRoute(event.target.value); } })] }), routeInvalid || routeTaken
                ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken') })
                : (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['advancedHint'], children: t('customRouteHint') }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('customDisplayName') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: displayName, placeholder: route.length === 0 ? t('customDisplayName') : route, "aria-label": t('customDisplayName'), disabled: profileDisabled, onChange: (event) => { setDisplayName(event.target.value); } })] }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('baseUrl') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: baseURL, placeholder: "https://gateway.example/v1", "aria-label": t('baseUrl'), disabled: profileDisabled, onChange: (event) => { setBaseURL(event.target.value); } })] }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('customApi') }), (0, jsx_runtime_1.jsx)("select", { className: `${styles_1.ModelsSectionCss['input']} ${styles_1.ModelsSectionCss['selectInput']}`, value: protocol, "aria-label": t('customApi'), disabled: profileDisabled, onChange: (event) => { setProtocol(event.target.value); }, children: protocols.map(choice => (0, jsx_runtime_1.jsx)("option", { value: choice, children: choice }, choice)) })] }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('keyInput') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "password", autoComplete: "off", value: keyDraft, placeholder: t('keyPlaceholder'), "aria-label": t('keyInput'), disabled: disabled, onChange: (event) => { setKeyDraft(event.target.value); } }), keyFailure === undefined
                        ? null
                        : (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure) })] }), (0, jsx_runtime_1.jsx)(ModelListEditor_1.ModelListEditor, { models: models, onChange: setModels, probe: {
                    settingsNs: NS,
                    baseURL,
                    api: protocol,
                    ...keyValue.length === 0 ? {} : { apiKey: keyValue },
                }, probeBlocked: keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure, api: api, t: t, disabled: profileDisabled }), failure !== undefined ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: failure }) : null, hint === undefined ? null : (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['advancedHint'], children: hint }), (0, jsx_runtime_1.jsx)(EditorFooter_1.EditorFooter, { t: t, busy: busy, submitDisabled: disabled || !ready, submitLabel: "create", submitBusyLabel: "creating", onCancel: () => { props.onClose(committed); }, onSubmit: () => { void create(); } })] }));
}

},
"src/modules/settings-models/apiKey.js": function(module, exports, require) {
// source: src/modules/settings-models/apiKey.ts

"use strict";
/**
 * Browser-side judgement of a typed API key.
 * @module @xharness/dsh-client-ui-settings-models/apiKey
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiKeyFailure = apiKeyFailure;
/**
 * UI-side key validation: printable ASCII, space excluded. This is a
 * browser boundary rule, not a runtime import from a provider SDK. Host-side
 * validation remains authoritative when the draft is saved.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
/**
 * A pasted `NAME=value` environment line. Two narrowings keep real keys clear
 * of it: the name must be upper-case, so `sk-` forms break at the hyphen, and
 * the `=` must be followed by something other than another `=`, so base64
 * padding on an all-upper-case key (`ABCD==`) is not mistaken for an
 * assignment. This heuristic runs only here — a resolver applying it could
 * lock a user out of a gateway whose key legitimately takes this shape, with
 * the environment refusing it too and no way through.
 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;
/** Whether a value is wrapped in one matching pair of quotes. */
function isQuoted(value) {
    const first = value[0];
    if (first !== '"' && first !== '\'' && first !== '`')
        return false;
    return value.length > 1 && value.endsWith(first);
}
/**
 * Judge the key input's current value.
 *
 * An empty field is not a failure: every card opens with it empty even when a
 * key is already stored, where it means keep that one. A field holding only
 * whitespace is a failure rather than an empty field, so typed input is never
 * silently discarded.
 * @param draft - the key input's current value, untrimmed.
 * @returns the copy key for a field-level failure, or `undefined` to allow submit.
 */
function apiKeyFailure(draft) {
    if (draft.length === 0)
        return undefined;
    const value = draft.trim();
    if (value.length === 0)
        return 'keyBlank';
    if (ENV_LINE.test(value) || isQuoted(value))
        return 'keyIllegalCharacters';
    if (!LEGAL_API_KEY.test(value))
        return 'keyIllegalCharacters';
    return undefined;
}

},
"src/modules/settings-models/EditorFooter.js": function(module, exports, require) {
// source: src/modules/settings-models/EditorFooter.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditorFooter = EditorFooter;
const jsx_runtime_1 = require("react/jsx-runtime");
const styles_1 = require("./styles");
/**
 * Render one provider card's action row.
 * @param props - the labels, commit gating, and handlers the owning card supplies.
 * @returns the cancel/commit row.
 */
function EditorFooter(props) {
    const { t } = props;
    return ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['editorActions'], children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['secondaryButton'], disabled: props.busy, onClick: props.onCancel, children: t(props.cancelLabel ?? 'cancel') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['primaryButton'], disabled: props.submitDisabled, onClick: props.onSubmit, children: props.busy ? t(props.submitBusyLabel) : t(props.submitLabel) })] }));
}

},
"src/modules/settings-models/styles.js": function(module, exports, require) {
// source: src/modules/settings-models/styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WelcomeNoticeCss = exports.DeepSeekOnboardingDialogCss = exports.OnboardingModalCss = exports.ModelsSectionCss = void 0;
const ModelsSection_css_1 = __importDefault(require("./ModelsSection.css"));
const OnboardingModal_css_1 = __importDefault(require("./OnboardingModal.css"));
const DeepSeekOnboardingDialog_css_1 = __importDefault(require("./DeepSeekOnboardingDialog.css"));
const WelcomeNotice_css_1 = __importDefault(require("./WelcomeNotice.css"));
exports.ModelsSectionCss = {
    "addActions": "HGcBra_addActions",
    "addBlock": "HGcBra_addBlock",
    "addButton": "HGcBra_addButton",
    "addCard": "HGcBra_addCard",
    "addModelButton": "HGcBra_addModelButton",
    "advancedHint": "HGcBra_advancedHint",
    "candidate": "HGcBra_candidate",
    "candidateActions": "HGcBra_candidateActions",
    "candidateId": "HGcBra_candidateId",
    "candidateLabel": "HGcBra_candidateLabel",
    "candidateList": "HGcBra_candidateList",
    "credentialDot": "HGcBra_credentialDot",
    "credentialDotConfigured": "HGcBra_credentialDotConfigured",
    "credentialDotMissing": "HGcBra_credentialDotMissing",
    "customized": "HGcBra_customized",
    "customizedBody": "HGcBra_customizedBody",
    "customizedSummary": "HGcBra_customizedSummary",
    "dangerButton": "HGcBra_dangerButton",
    "deleteConfirm": "HGcBra_deleteConfirm",
    "deleteDialog": "HGcBra_deleteDialog",
    "editor": "HGcBra_editor",
    "editorActions": "HGcBra_editorActions",
    "editorHeader": "HGcBra_editorHeader",
    "editorRoute": "HGcBra_editorRoute",
    "editorTitle": "HGcBra_editorTitle",
    "error": "HGcBra_error",
    "fetchDialog": "HGcBra_fetchDialog",
    "field": "HGcBra_field",
    "fieldLabel": "HGcBra_fieldLabel",
    "hiddenLabel": "HGcBra_hiddenLabel",
    "iconButton": "HGcBra_iconButton",
    "iconButtonDanger": "HGcBra_iconButtonDanger",
    "input": "HGcBra_input",
    "intro": "HGcBra_intro",
    "linkButton": "HGcBra_linkButton",
    "modelAdvanced": "HGcBra_modelAdvanced",
    "modelCatalog": "HGcBra_modelCatalog",
    "modelCatalogHeading": "HGcBra_modelCatalogHeading",
    "modelCatalogMeta": "HGcBra_modelCatalogMeta",
    "modelCatalogTitle": "HGcBra_modelCatalogTitle",
    "modelEmpty": "HGcBra_modelEmpty",
    "modelEntry": "HGcBra_modelEntry",
    "modelField": "HGcBra_modelField",
    "modelFieldLabel": "HGcBra_modelFieldLabel",
    "modelList": "HGcBra_modelList",
    "modelListHead": "HGcBra_modelListHead",
    "modelRow": "HGcBra_modelRow",
    "notice": "HGcBra_notice",
    "primaryButton": "HGcBra_primaryButton",
    "rowActions": "HGcBra_rowActions",
    "rowCard": "HGcBra_rowCard",
    "rowHead": "HGcBra_rowHead",
    "rowIdentity": "HGcBra_rowIdentity",
    "rowName": "HGcBra_rowName",
    "rowTag": "HGcBra_rowTag",
    "rows": "HGcBra_rows",
    "savedNotice": "HGcBra_savedNotice",
    "secondaryButton": "HGcBra_secondaryButton",
    "section": "HGcBra_section",
    "selectInput": "HGcBra_selectInput",
    "setupCard": "HGcBra_setupCard",
    "title": "HGcBra_title"
};
exports.OnboardingModalCss = {
    "body": "_5TDjIa_body",
    "content": "_5TDjIa_content",
    "dialog": "_5TDjIa_dialog",
    "title": "_5TDjIa_title"
};
exports.DeepSeekOnboardingDialogCss = {
    "description": "_2WZCNq_description",
    "editor": "_2WZCNq_editor"
};
exports.WelcomeNoticeCss = {
    "actions": "tKGJdq_actions",
    "copy": "tKGJdq_copy",
    "error": "tKGJdq_error",
    "primary": "tKGJdq_primary"
};
for (const [tagId, css] of [['@xharness/dsh-client-ui-settings-models/ModelsSection.module.css', ModelsSection_css_1.default],
    ['@xharness/dsh-client-ui-settings-models/OnboardingModal.module.css', OnboardingModal_css_1.default],
    ['@xharness/dsh-client-ui-settings-models/DeepSeekOnboardingDialog.module.css', DeepSeekOnboardingDialog_css_1.default],
    ['@xharness/dsh-client-ui-settings-models/WelcomeNotice.module.css', WelcomeNotice_css_1.default]]) {
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-settings-models';
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
    }
}

},
"src/modules/settings-models/ModelsSection.css": function(module, exports, require) {
// source: src/modules/settings-models/ModelsSection.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".HGcBra_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.HGcBra_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}.HGcBra_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}.HGcBra_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}.HGcBra_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}.HGcBra_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}.HGcBra_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.HGcBra_rowHead{align-items:center;gap:10px;display:flex}.HGcBra_rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}.HGcBra_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.HGcBra_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}.HGcBra_credentialDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}.HGcBra_credentialDotConfigured{background:var(--dsw-alias-state-success-primary)}.HGcBra_credentialDotMissing{background:var(--dsw-alias-state-error-primary)}.HGcBra_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}.HGcBra_primaryButton,.HGcBra_secondaryButton,.HGcBra_addButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.HGcBra_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.HGcBra_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.HGcBra_secondaryButton,.HGcBra_addButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.HGcBra_secondaryButton:hover:not(:disabled),.HGcBra_addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.HGcBra_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.HGcBra_dangerButton{box-sizing:border-box;height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.HGcBra_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.HGcBra_rowActions .HGcBra_secondaryButton,.HGcBra_rowActions .HGcBra_dangerButton{border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.HGcBra_primaryButton:disabled,.HGcBra_secondaryButton:disabled,.HGcBra_dangerButton:disabled,.HGcBra_addButton:disabled,.HGcBra_linkButton:disabled,.HGcBra_addModelButton:disabled{opacity:.4;cursor:default}.HGcBra_primaryButton:focus-visible,.HGcBra_secondaryButton:focus-visible,.HGcBra_dangerButton:focus-visible,.HGcBra_addButton:focus-visible,.HGcBra_linkButton:focus-visible,.HGcBra_addModelButton:focus-visible,.HGcBra_iconButton:focus-visible,.HGcBra_customizedSummary:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.HGcBra_editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}.HGcBra_editorHeader{align-items:baseline;gap:8px;display:flex}.HGcBra_editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.HGcBra_editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.HGcBra_field{flex-direction:column;gap:6px;display:flex}.HGcBra_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}.HGcBra_linkButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.HGcBra_linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.HGcBra_advancedHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.HGcBra_editorActions{justify-content:flex-end;gap:8px;display:flex}.HGcBra_addBlock{flex-direction:column;gap:12px;display:flex}.HGcBra_addActions{flex-wrap:wrap;gap:10px;display:flex}.HGcBra_addButton{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px}.HGcBra_addCard,.HGcBra_setupCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}.HGcBra_addCard .HGcBra_editor,.HGcBra_setupCard .HGcBra_editor{background:0 0;padding:0}.HGcBra_customized{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}.HGcBra_customizedSummary{cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);border-radius:6px;align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}.HGcBra_customizedSummary::-webkit-details-marker{display:none}.HGcBra_customizedSummary:before{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg)translate(-1px,-1px)}.HGcBra_customized[open]>.HGcBra_customizedSummary:before{transform:rotate(45deg)translate(-1px,-1px)}.HGcBra_customizedSummary:hover{color:var(--dsw-alias-label-primary)}.HGcBra_customizedBody{flex-direction:column;gap:12px;padding-top:12px;display:flex}.HGcBra_modelCatalog{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}.HGcBra_modelCatalogHeading{flex-direction:column;gap:2px;display:flex}.HGcBra_modelCatalogTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}.HGcBra_modelCatalogMeta,.HGcBra_modelEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.HGcBra_modelList{flex-direction:column;gap:8px;display:flex}.HGcBra_modelListHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.HGcBra_modelEntry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}.HGcBra_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px;display:grid}.HGcBra_iconButton{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex}.HGcBra_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.HGcBra_iconButton:disabled{cursor:default;opacity:.4}.HGcBra_iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.HGcBra_modelAdvanced{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;padding:8px 4px 2px;display:grid}.HGcBra_modelField{flex-direction:column;gap:4px;display:flex}.HGcBra_modelFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.HGcBra_modelEmpty{border:1px dashed var(--dsw-alias-border-l3);text-align:center;border-radius:8px;padding:12px}.HGcBra_addModelButton{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.HGcBra_addModelButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.HGcBra_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}select.HGcBra_input{cursor:pointer;max-width:240px}.HGcBra_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}.HGcBra_input::placeholder{color:var(--dsw-alias-label-dimmed)}.HGcBra_input:disabled{opacity:.6;cursor:default}.HGcBra_selectInput{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}.HGcBra_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}.HGcBra_deleteDialog{width:min(480px,100%)}.HGcBra_deleteConfirm:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.HGcBra_deleteConfirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.HGcBra_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:reduce){.HGcBra_customizedSummary:before{transition:none}}.HGcBra_fetchDialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:520px}.HGcBra_candidateActions{justify-content:flex-end;margin-bottom:6px;display:flex}.HGcBra_candidateList{flex-direction:column;gap:2px;max-height:320px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.HGcBra_candidate{border-radius:6px}.HGcBra_candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}.HGcBra_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}";

},
"src/modules/settings-models/OnboardingModal.css": function(module, exports, require) {
// source: src/modules/settings-models/OnboardingModal.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._5TDjIa_dialog{width:min(600px,100%);padding:0}._5TDjIa_content{box-sizing:border-box;flex-direction:column;max-height:calc(100vh - 48px);padding:28px;display:flex;overflow-y:auto}._5TDjIa_title{color:var(--dsw-alias-label-primary);outline:none;margin:0;font-size:20px;font-weight:500;line-height:28px}._5TDjIa_body{margin-top:20px}@media (width<=560px){._5TDjIa_content{padding:24px}}";

},
"src/modules/settings-models/DeepSeekOnboardingDialog.css": function(module, exports, require) {
// source: src/modules/settings-models/DeepSeekOnboardingDialog.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._2WZCNq_description{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;line-height:24px}._2WZCNq_editor{margin-top:24px}@media (width<=560px){._2WZCNq_editor{margin-top:20px}}";

},
"src/modules/settings-models/WelcomeNotice.css": function(module, exports, require) {
// source: src/modules/settings-models/WelcomeNotice.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".tKGJdq_copy{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}.tKGJdq_copy p{margin:0}.tKGJdq_copy p+p{margin-top:12px}.tKGJdq_error{color:var(--dsw-alias-state-error-primary);margin:16px 0 0;font-size:14px;line-height:22px}.tKGJdq_actions{justify-content:flex-end;margin-top:24px;display:flex}.tKGJdq_primary{min-width:120px}@media (width<=560px){.tKGJdq_primary{width:100%}}";

},
"src/modules/settings-models/DeepSeekModelsEditor.js": function(module, exports, require) {
// source: src/modules/settings-models/DeepSeekModelsEditor.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCapacity = parseCapacity;
exports.formatCapacity = formatCapacity;
exports.modelDrafts = modelDrafts;
exports.validateDeepSeekModels = validateDeepSeekModels;
exports.DeepSeekModelsEditor = DeepSeekModelsEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../shared/runtime-types");
/**
 * Curated editor for the direct DeepSeek adapter's advisory model catalog.
 * The settings layer replaces `models` as one array, so the parent supplies
 * the effective inherited rows until the first edit materializes a user
 * override; reset removes that override instead of copying defaults into it.
 */
const react_1 = require("react");
const primitives_1 = require("./primitives");
const styles_1 = require("./styles");
/** Row index encoded in an editing-buffer key. */
function rowOf(key) {
    return Number(key.slice(0, key.indexOf(':')));
}
/** Accepted capacity spellings: a decimal count with an optional K/M suffix. */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
/** Decimal suffix scales — `1M` is 1000K, matching how model capacities are quoted. */
const CAPACITY_SCALE = { k: 1000, m: 1000000 };
/**
 * Read a typed capacity, so a user can write `256K` or `1M` instead of counting
 * zeroes. The stored value stays a plain token count.
 * @param text - raw field text.
 * @returns the count; `undefined` when blank (inherit), `NaN` when unreadable
 * (rejected by {@link validateDeepSeekModels} before any write).
 */
function parseCapacity(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return undefined;
    const match = CAPACITY_PATTERN.exec(trimmed);
    if (match === null)
        return Number.NaN;
    const suffix = match[2]?.toLowerCase();
    const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
    const scaled = Number(match[1]) * scale;
    // A decimal multiple is exact in intent but not in binary floating point
    // (2.3 * 1e6 lands a few ULPs high), so an integral intent snaps back.
    const rounded = Math.round(scaled);
    return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}
/**
 * Spell a stored count back in the shortest form that survives a round trip
 * through {@link parseCapacity}; a count that is not a whole number of
 * thousands stays written out.
 * @param value - stored capacity.
 * @returns the field text.
 */
function formatCapacity(value) {
    if (!Number.isInteger(value) || value <= 0)
        return String(value);
    if (value % CAPACITY_SCALE.m === 0)
        return `${String(value / CAPACITY_SCALE.m)}M`;
    if (value % CAPACITY_SCALE.k === 0)
        return `${String(value / CAPACITY_SCALE.k)}K`;
    return String(value);
}
/** Convert a schema-validated catalog value into records without dropping hidden fields. */
function modelDrafts(value) {
    if (!isUnknownArray(value))
        return [];
    return value.map(entry => (0, runtime_types_1.isObjectRecord)(entry)
        ? entry
        : {});
}
/**
 * Validate adapter constraints that the serialized schema cannot express.
 * @param value - user-owned `models` value, or undefined while inherited.
 * @returns the first invalid row, or undefined when the adapter will accept it.
 */
function validateDeepSeekModels(value) {
    if (value === undefined)
        return undefined;
    const models = modelDrafts(value);
    const seen = new Set();
    for (const [index, model] of models.entries()) {
        // Compared trimmed: surrounding whitespace is a paste artifact the adapter
        // would never match, and an untrimmed compare lets `model ` slip past the
        // duplicate check against its own twin.
        const id = model['id'];
        const trimmed = typeof id === 'string' ? id.trim() : undefined;
        if (trimmed === undefined || trimmed.length === 0)
            return { index, key: 'modelIdRequired' };
        if (seen.has(trimmed))
            return { index, key: 'modelIdDuplicate' };
        seen.add(trimmed);
        const name = model['name'];
        if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
            return { index, key: 'modelNameInvalid' };
        }
        const contextWindow = model['contextWindow'];
        if (contextWindow !== undefined
            && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
            return { index, key: 'modelContextInvalid' };
        }
        const maxTokens = model['maxTokens'];
        if (maxTokens !== undefined
            && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
            return { index, key: 'modelMaxTokensInvalid' };
        }
    }
    return undefined;
}
/**
 * Render the direct DeepSeek adapter's model catalog: id and display name on
 * each row, capacities behind the row's own disclosure.
 * @param props - effective rows plus the array-level override actions.
 * @returns the catalog editor.
 */
function DeepSeekModelsEditor(props) {
    // Capacities are edited as text, so a field's keystrokes are held here
    // rather than re-derived from the parsed count on every change, which would
    // rewrite `1000` to `1K` mid-word. Unreadable text is kept past blur so the
    // save-time rejection names a row the user can still see — which is why
    // this is one entry PER FIELD: a single active buffer would be displaced by
    // editing any other field, and the abandoned one would fall back to
    // rendering its stored NaN as the literal `NaN`.
    //
    // Keys carry the row index, so the two operations that move indexes maintain
    // them: `remove` re-keys around the dropped row, and reset clears them all
    // because the rows they annotated are gone.
    const [editing, setEditing] = (0, react_1.useState)(() => new Map());
    const [expanded, setExpanded] = (0, react_1.useState)(() => new Set());
    const update = (index, key, value) => {
        const next = props.models.map((model, at) => {
            const copy = { ...model };
            if (at !== index)
                return copy;
            if (value === undefined)
                Reflect.deleteProperty(copy, key);
            else
                copy[key] = value;
            return copy;
        });
        props.onChange(next);
    };
    const remove = (index) => {
        setEditing((current) => {
            const next = new Map();
            for (const [key, text] of current) {
                const at = rowOf(key);
                if (at === index)
                    continue;
                // Only the row number moves; the field half of the key is untouched.
                next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, text);
            }
            return next;
        });
        setExpanded((current) => {
            const next = new Set();
            for (const at of current) {
                if (at === index)
                    continue;
                next.add(at > index ? at - 1 : at);
            }
            return next;
        });
        props.onChange(props.models.filter((_model, at) => at !== index).map(model => ({ ...model })));
    };
    const reset = () => {
        setEditing(new Map());
        setExpanded(new Set());
        props.onReset();
    };
    const toggle = (index) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(index))
                next.add(index);
            return next;
        });
    };
    /** The field's text: its live keystrokes, else the stored count spelled short. */
    const capacityText = (model, index, field) => {
        const typed = editing.get(`${String(index)}:${field}`);
        if (typed !== undefined)
            return typed;
        const value = model[field];
        return typeof value === 'number' ? formatCapacity(value) : '';
    };
    const settleCapacity = (index, field) => {
        const key = `${String(index)}:${field}`;
        const typed = editing.get(key);
        if (typed === undefined)
            return;
        // Unreadable text stays on screen: the save-time rejection names a row the
        // user can still see and correct.
        const parsed = parseCapacity(typed);
        if (parsed !== undefined && Number.isNaN(parsed))
            return;
        setEditing((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
        });
    };
    /** One capacity field of one row, rendered inside the row's disclosure. */
    const capacityField = (model, index, field, fallback) => ((0, jsx_runtime_1.jsxs)("label", { className: styles_1.ModelsSectionCss['modelField'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelFieldLabel'], children: props.t(field === 'contextWindow' ? 'contextWindow' : 'maxTokens') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", inputMode: "numeric", value: capacityText(model, index, field), placeholder: fallback === undefined
                    ? props.t(field === 'contextWindow' ? 'contextWindowPlaceholder' : 'maxTokensPlaceholder')
                    : formatCapacity(fallback), "aria-label": `${props.t(field === 'contextWindow' ? 'contextWindow' : 'maxTokens')} ${String(index + 1)}`, disabled: props.disabled, onChange: (event) => {
                    const text = event.target.value;
                    setEditing(current => new Map(current).set(`${String(index)}:${field}`, text));
                    update(index, field, parseCapacity(text));
                }, onBlur: () => { settleCapacity(index, field); } })] }));
    return ((0, jsx_runtime_1.jsxs)("section", { className: styles_1.ModelsSectionCss['modelCatalog'], "aria-label": props.t('models'), children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelListHead'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelCatalogHeading'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelCatalogTitle'], children: props.t('models') }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelCatalogMeta'], children: props.overridden ? props.t('modelsCustomized') : props.t('modelsInherited') })] }), props.overridden
                        ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['linkButton'], disabled: props.disabled, onClick: reset, children: props.t('resetModels') }))
                        : null] }), props.models.length === 0
                ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['modelEmpty'], children: props.t('modelsEmpty') })
                : ((0, jsx_runtime_1.jsx)("div", { className: styles_1.ModelsSectionCss['modelList'], children: props.models.map((model, index) => ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelEntry'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelRow'], children: [(0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: typeof model['id'] === 'string' ? model['id'] : '', placeholder: props.t('modelId'), "aria-label": `${props.t('modelId')} ${String(index + 1)}`, disabled: props.disabled, onChange: (event) => { update(index, 'id', event.target.value); }, onBlur: (event) => {
                                            // Settle a pasted id rather than trimming per keystroke,
                                            // which would stop the user typing an interior space.
                                            const trimmed = event.target.value.trim();
                                            if (trimmed !== event.target.value)
                                                update(index, 'id', trimmed);
                                        } }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: typeof model['name'] === 'string' ? model['name'] : '', placeholder: props.t('modelName'), "aria-label": `${props.t('modelName')} ${String(index + 1)}`, disabled: props.disabled, onChange: (event) => {
                                            update(index, 'name', event.target.value === '' ? undefined : event.target.value);
                                        } }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['iconButton'], "aria-label": `${props.t('modelAdvanced')} ${String(index + 1)}`, "aria-expanded": expanded.has(index), title: props.t('modelAdvanced'), onClick: () => { toggle(index); }, children: expanded.has(index) ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, {}) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: `${styles_1.ModelsSectionCss['iconButton']} ${styles_1.ModelsSectionCss['iconButtonDanger']}`, "aria-label": `${props.t('removeModel')} ${String(index + 1)}`, title: props.t('removeModel'), disabled: props.disabled, onClick: () => { remove(index); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconTrashOutline16, { size: 14 }) })] }), expanded.has(index)
                                ? ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelAdvanced'], children: [capacityField(model, index, 'contextWindow', props.defaultContextWindow), capacityField(model, index, 'maxTokens', props.defaultMaxTokens)] }))
                                : null] }, index))) })), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: styles_1.ModelsSectionCss['addModelButton'], disabled: props.disabled, onClick: () => { props.onChange([...props.models.map(model => ({ ...model })), { id: '' }]); }, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconPlusOutline16, { size: 14 }), props.t('addModel')] })] }));
}
function isUnknownArray(value) { return Array.isArray(value); }

},
"src/modules/settings-models/ModelListEditor.js": function(module, exports, require) {
// source: src/modules/settings-models/ModelListEditor.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adopt = adopt;
exports.ModelListEditor = ModelListEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * The model list of one pi-ai provider profile, plus the action that asks the
 * provider what it serves.
 *
 * The list is the profile's `models` array as the card holds it: an empty list
 * means "serve this route's built-in catalog", and any entry replaces that
 * catalog, so a row is only ever added deliberately. Fetching asks the endpoint
 * **the form currently shows** — including a key typed but not yet saved — so
 * adding a provider is one pass instead of save-then-return; the reply is
 * candidates the user picks from, never configuration written behind them.
 *
 * A provider that cannot be interrogated (an unreachable endpoint, a protocol
 * with no readable listing) is not a dead end: the failure is shown next to the
 * rows the user can still fill in by hand.
 */
const react_1 = require("react");
const primitives_1 = require("./primitives");
const DeepSeekModelsEditor_1 = require("./DeepSeekModelsEditor");
const store_1 = require("./store");
const styles_1 = require("./styles");
/** A row's text field, or the empty string when unset or not a string. */
function textOf(model, key) {
    const value = model[key];
    return typeof value === 'string' ? value : '';
}
/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model, key) {
    const value = model[key];
    return typeof value === 'number' ? value : undefined;
}
/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }) {
    return ((0, jsx_runtime_1.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, style: { transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }, children: (0, jsx_runtime_1.jsx)("path", { d: "M6 3.5L10.5 8L6 12.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
/** Removal glyph for one model row. */
function IconTrash() {
    return ((0, jsx_runtime_1.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: (0, jsx_runtime_1.jsx)("path", { d: "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them. They are a hint, not a mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT = {
    contextWindow: '256K',
    maxTokens: '32K',
};
/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value) {
    return value === undefined ? '' : (0, DeepSeekModelsEditor_1.formatCapacity)(value);
}
/** Adopt a candidate, keeping whatever capacities the provider disclosed. */
function adopt(candidate) {
    return {
        id: candidate.id,
        ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
        ...candidate.name === undefined ? {} : { name: candidate.name },
        ...(typeof candidate.imageInput === 'boolean' ? { imageInput: candidate.imageInput } : {}),
        ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
        ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    };
}
/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
function ModelListEditor(props) {
    const { models, onChange, probe, api, t, disabled } = props;
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [failure, setFailure] = (0, react_1.useState)(undefined);
    const [candidates, setCandidates] = (0, react_1.useState)(undefined);
    const [picked, setPicked] = (0, react_1.useState)(new Set());
    // Rows carry an id and a name; capacities are the exception, so they stay
    // folded until asked for rather than crowding every row with four inputs.
    const [expanded, setExpanded] = (0, react_1.useState)(new Set());
    // Capacities are edited as text, so a field's keystrokes are held here rather
    // than re-derived from the parsed count on every change — that would rewrite
    // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
    // names a row the user can still see, which is why this is one entry PER
    // FIELD: a single buffer would be displaced by editing any other field, and
    // the abandoned one would render its stored NaN as the literal `NaN`.
    const [editing, setEditing] = (0, react_1.useState)(new Map());
    /** Buffer key for one capacity field; the row half moves when rows do. */
    const bufferKey = (index, field) => `${String(index)}:${field}`;
    const editCapacity = (index, field, text) => {
        setEditing(current => new Map(current).set(bufferKey(index, field), text));
        patch(index, { [field]: (0, DeepSeekModelsEditor_1.parseCapacity)(text) });
    };
    /** What a capacity field shows: the buffer while typing, else the stored count. */
    const capacityText = (model, index, field) => editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field));
    /** Drop one row's entries and shift the rows after it down, in one pass. */
    const reindexOnRemove = (current, index) => {
        const next = new Map();
        for (const [key, value] of current) {
            const at = Number(key.slice(0, key.indexOf(':')));
            if (at === index)
                continue;
            // Only the row number moves; the field half of the key is untouched.
            next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value);
        }
        return next;
    };
    const toggleExpanded = (index) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(index))
                next.add(index);
            return next;
        });
    };
    const patch = (index, next) => {
        onChange(models.map((model, at) => {
            if (at !== index)
                return model;
            // Rebuilt rather than spread over: an emptied optional field has to leave
            // the profile, not be stored as a value its schema would reject.
            // Spread first so a field this card does not edit survives; an emptied
            // optional field is then dropped rather than stored as a value its
            // schema would reject.
            const cleared = new Set(Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key));
            return Object.fromEntries(Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)));
        }));
    };
    const fetchModels = async () => {
        setBusy(true);
        setFailure(undefined);
        try {
            const response = await api.llm.discoverModels({
                settingsNs: probe.settingsNs,
                ...probe.provider === undefined ? {} : { provider: probe.provider },
                ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
                ...probe.api === undefined ? {} : { api: probe.api },
                ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
            });
            if (!response.result.ok) {
                setFailure(response.result.error.message);
                return;
            }
            const found = response.result.value.models;
            if (found.length === 0) {
                setFailure(t('fetchEmpty'));
                return;
            }
            // Everything already configured starts unchecked, so adopting a
            // selection never silently rewrites a capacity the user corrected.
            const known = new Set(models.map(model => textOf(model, 'id')));
            setCandidates(found);
            setPicked(new Set(found.filter(model => !known.has(model.id)).map(model => model.id)));
        }
        catch (error) {
            // The transport rejected rather than answering; without this the button
            // would stay busy with nothing shown.
            setFailure((0, store_1.messageOf)(error));
        }
        finally {
            setBusy(false);
        }
    };
    const closePicker = () => {
        setCandidates(undefined);
        setPicked(new Set());
    };
    const adoptPicked = () => {
        /* v8 ignore next -- the dialog only renders with candidates loaded */
        if (candidates === undefined)
            return;
        const byId = new Map(models.map(model => [textOf(model, 'id'), model]));
        for (const candidate of candidates) {
            if (!picked.has(candidate.id))
                continue;
            // A row the user already tuned wins over the provider's own numbers.
            // Keyed by id, so a half-typed row whose id is still empty is not a
            // match and the candidate joins as its own row — correct, since a row
            // without an id is not yet a model and the create/apply gates refuse it.
            byId.set(candidate.id, byId.get(candidate.id) ?? adopt(candidate));
        }
        onChange([...byId.values()]);
        closePicker();
    };
    const toggle = (id) => {
        setPicked((current) => {
            const next = new Set(current);
            if (!next.delete(id))
                next.add(id);
            return next;
        });
    };
    const activeCandidates = candidates ?? [];
    const allCandidatesPicked = activeCandidates.length > 0
        && activeCandidates.every(candidate => picked.has(candidate.id));
    const toggleAllCandidates = () => {
        setPicked((current) => {
            return activeCandidates.every(candidate => current.has(candidate.id))
                ? new Set()
                : new Set(activeCandidates.map(candidate => candidate.id));
        });
    };
    // A route the adapter already describes answers without an endpoint; only a
    // draft with neither has nothing to ask about.
    const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0);
    return ((0, jsx_runtime_1.jsxs)("section", { className: styles_1.ModelsSectionCss['modelCatalog'], "aria-label": t('models'), children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelListHead'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelCatalogHeading'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelCatalogTitle'], children: t('models') }), props.overridden === undefined
                                ? null
                                : ((0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelCatalogMeta'], children: props.overridden ? t('modelsCustomized') : t('modelsInherited') }))] }), props.overridden === true && props.onReset !== undefined
                        ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['linkButton'], disabled: disabled, onClick: props.onReset, children: t('resetModels') }))
                        : null, (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['linkButton'], disabled: disabled || busy || !askable || props.probeBlocked !== undefined, title: props.probeBlocked !== undefined
                            ? t(props.probeBlocked)
                            : askable ? undefined : t('fetchNeedsBaseUrl'), onClick: () => { void fetchModels(); }, children: busy ? t('fetching') : t('fetchModels') })] }), models.length === 0 ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['modelEmpty'], children: t('modelsEmpty') }) : null, models.map((model, index) => ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelEntry'], children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelRow'], children: [(0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: textOf(model, 'id'), placeholder: t('modelId'), "aria-label": `${t('modelId')} ${index + 1}`, disabled: disabled, onChange: (event) => { patch(index, { id: event.target.value }); } }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: textOf(model, 'name'), placeholder: t('modelName'), "aria-label": `${t('modelName')} ${index + 1}`, disabled: disabled, onChange: (event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }); } }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['iconButton'], "aria-label": `${t('modelAdvanced')} ${index + 1}`, "aria-expanded": expanded.has(index), title: t('modelAdvanced'), onClick: () => { toggleExpanded(index); }, children: (0, jsx_runtime_1.jsx)(IconChevron, { open: expanded.has(index) }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: `${styles_1.ModelsSectionCss['iconButton']} ${styles_1.ModelsSectionCss['iconButtonDanger']}`, "aria-label": `${t('removeModel')} ${index + 1}`, title: t('removeModel'), disabled: disabled, onClick: () => {
                                    onChange(models.filter((_model, at) => at !== index));
                                    // Both stores are keyed by position, so every row after this
                                    // one shifts down and would otherwise inherit its neighbour's
                                    // state — a different row's capacities popping open, or its
                                    // half-typed text appearing in another row's field.
                                    setExpanded((current) => {
                                        const next = new Set();
                                        for (const at of current) {
                                            if (at < index)
                                                next.add(at);
                                            else if (at > index)
                                                next.add(at - 1);
                                        }
                                        return next;
                                    });
                                    setEditing(current => reindexOnRemove(current, index));
                                }, children: (0, jsx_runtime_1.jsx)(IconTrash, {}) })] }), expanded.has(index)
                        ? ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['modelAdvanced'], children: [(0, jsx_runtime_1.jsxs)("label", { className: styles_1.ModelsSectionCss['modelField'], children: [(0, jsx_runtime_1.jsx)("span", { children: "\u652F\u6301\u56FE\u7247\u8F93\u5165" }), (0, jsx_runtime_1.jsx)("input", { type: "checkbox", disabled: disabled, checked: model['imageInput'] === true, "aria-label": `支持图片输入 ${index + 1}`, onChange: event => { patch(index, { imageInput: event.target.checked }); } }), (0, jsx_runtime_1.jsx)("small", { children: model['imageInput'] === undefined
                                                ? '视觉能力未声明；请确认模型 API 支持后启用。'
                                                : '不支持视觉时明确报错，不自动丢弃图片。' })] }), (0, jsx_runtime_1.jsxs)("label", { className: styles_1.ModelsSectionCss['modelField'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelFieldLabel'], children: t('modelContextWindow') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", inputMode: "numeric", value: capacityText(model, index, 'contextWindow'), placeholder: CAPACITY_HINT.contextWindow, "aria-label": `${t('modelContextWindow')} ${index + 1}`, disabled: disabled, onChange: (event) => { editCapacity(index, 'contextWindow', event.target.value); } })] }), (0, jsx_runtime_1.jsxs)("label", { className: styles_1.ModelsSectionCss['modelField'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['modelFieldLabel'], children: t('modelMaxTokens') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", inputMode: "numeric", value: capacityText(model, index, 'maxTokens'), placeholder: CAPACITY_HINT.maxTokens, "aria-label": `${t('modelMaxTokens')} ${index + 1}`, disabled: disabled, onChange: (event) => { editCapacity(index, 'maxTokens', event.target.value); } })] })] }))
                        : null] }, index))), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.ModelsSectionCss['addModelButton'], disabled: disabled, onClick: () => { onChange([...models, { id: '' }]); }, children: t('addModel') }), failure !== undefined ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: failure }) : null, (0, jsx_runtime_1.jsxs)(primitives_1.Modal, { open: candidates !== undefined, onClose: closePicker, title: t('fetchTitle'), closeLabel: t('close'), description: t('fetchDescription'), className: styles_1.ModelsSectionCss['fetchDialog'], footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", onClick: closePicker, children: t('cancel') }), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", onClick: adoptPicked, children: t('fetchAdopt') })] })), children: [(0, jsx_runtime_1.jsx)("div", { className: styles_1.ModelsSectionCss['candidateActions'], children: (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "ghost", size: "sm", onClick: toggleAllCandidates, children: t(allCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll') }) }), (0, jsx_runtime_1.jsx)("ul", { className: styles_1.ModelsSectionCss['candidateList'], children: (candidates ?? []).map(candidate => ((0, jsx_runtime_1.jsx)("li", { className: styles_1.ModelsSectionCss['candidate'], children: (0, jsx_runtime_1.jsxs)("label", { className: styles_1.ModelsSectionCss['candidateLabel'], children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: picked.has(candidate.id), onChange: () => { toggle(candidate.id); } }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['candidateId'], children: candidate.id })] }) }, candidate.id))) })] })] }));
}

},
"src/modules/settings-models/store.js": function(module, exports, require) {
// source: src/modules/settings-models/store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelsSettingsStore = void 0;
exports.messageOf = messageOf;
exports.deriveKeyRef = deriveKeyRef;
exports.protocolChoices = protocolChoices;
exports.providerUsable = providerUsable;
exports.onboardingReadiness = onboardingReadiness;
const runtime_types_1 = require("../shared/runtime-types");
const snapshot_1 = require("./snapshot");
/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe';
/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
function deriveKeyRef(provider) {
    return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}
/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
function protocolChoices(namespace, schema) {
    if (namespace === undefined)
        return [];
    const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api']);
    const list = node;
    if (list?.type !== 'union' || list.list === undefined)
        return [];
    return list.list.map(entry => entry.value).filter((value) => typeof value === 'string');
}
/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace, path, schema) {
    if (namespace === undefined)
        return undefined;
    const profile = schema.getPath(namespace.value, path);
    if (!(0, runtime_types_1.isObjectRecord)(profile))
        return undefined;
    const ref = profile.apiKeyEnv;
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}
/** The models settings page controller (one per settings surface). */
class ModelsSettingsStore {
    /**
     * @param api - the wire face (credentials/llm domains, and settings writes).
     * @param describeFace - the shared mirror's describe face (namespace views and writability).
     */
    constructor(api, schema, describeFace) {
        this.api = api;
        this.schema = schema;
        this.describeFace = describeFace;
        /** The snapshot the section renders from (uSES-safe store). */
        this.store = (0, snapshot_1.createModelSettingsStore)({
            status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
        });
        /** Latest load wins; an older response never overwrites a newer one. */
        this.generation = 0;
    }
    /**
     * Refresh the whole page snapshot: the provider directory and the mirror's
     * settings answer in parallel, then one batched credential describe over
     * every referenced ref. Provider failure or absence of an initial settings
     * answer keeps the last good rows and surfaces an error; a failed settings
     * refresh reuses the mirror's held view.
     * @returns nothing; the snapshot carries the outcome.
     */
    async load() {
        const generation = ++this.generation;
        this.store.update((s) => { s.status = 'loading'; s.error = null; });
        let providers;
        let writable;
        let views;
        try {
            const [providersResponse] = await Promise.all([
                this.api.llm.providers({}),
                this.describeFace.ensure(),
            ]);
            if (!providersResponse.result.ok)
                throw new Error(providersResponse.result.error.message);
            const mirrored = this.describeFace.getSnapshot();
            if (mirrored.view === undefined) {
                throw new Error(mirrored.error ?? 'settings are unavailable in this browser');
            }
            providers = providersResponse.result.value.providers;
            writable = mirrored.view.writable;
            views = mirrored.view.namespaces;
        }
        catch (error) {
            if (generation !== this.generation)
                return;
            this.store.update((s) => {
                s.status = 'error';
                s.error = error instanceof Error ? error.message : String(error);
            });
            return;
        }
        const namespaces = new Map(views.map(view => [view.ns, view]));
        const rows = providers.map((entry) => {
            const namespace = namespaces.get(entry.settingsNs);
            const configured = namespace !== undefined
                && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined);
            const removable = namespace !== undefined
                && entry.settingsPath.length > 0
                && this.schema.hasPath(namespace.user, entry.settingsPath)
                && !this.schema.hasPath(namespace.base, entry.settingsPath);
            return {
                entry,
                configured,
                removable,
                apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
                credential: undefined,
            };
        });
        const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))];
        let credentials = {};
        let credentialError = null;
        if (refs.length > 0) {
            try {
                const response = await this.api.credentials.describe({ refs });
                // Credential state is an enrichment for the Models page: neither a
                // business rejection nor a transport failure fails the load. The
                // onboarding projection below retains the failure distinction.
                if (response.result.ok)
                    credentials = response.result.value.credentials;
                else
                    credentialError = response.result.error.message;
            }
            catch (error) {
                credentialError = messageOf(error);
            }
        }
        if (generation !== this.generation)
            return;
        this.store.update((s) => {
            s.status = 'ready';
            s.error = null;
            s.credentialError = credentialError;
            s.writable = writable;
            s.rows = rows.map(row => ({
                ...row,
                ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
                    ? { credential: credentials[row.apiKeyEnv] }
                    : {},
            }));
            s.namespaces = namespaces;
        });
    }
}
exports.ModelsSettingsStore = ModelsSettingsStore;
/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
function providerUsable(row) {
    if (!row.entry.active)
        return false;
    if (row.apiKeyEnv === undefined)
        return true;
    return row.credential?.configured === true;
}
/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
function onboardingReadiness(state) {
    if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
        return { kind: 'loading' };
    }
    if (state.status === 'error') {
        return {
            kind: 'unavailable',
            reason: 'load-failed',
        };
    }
    if (state.rows.some(providerUsable))
        return { kind: 'provider-ready' };
    const row = state.rows.find(candidate => candidate.entry.provider === 'deepseek-official'
        && candidate.entry.settingsNs === 'llm-deepseek'
        && candidate.entry.settingsPath.length === 0);
    if (row === undefined)
        return { kind: 'adapter-absent' };
    if (!row.entry.active) {
        return {
            kind: 'unavailable',
            reason: 'provider-inactive',
        };
    }
    // Past the usable gate an active route names a reference it has no stored
    // credential for, so the remaining questions are all about that credential.
    if (state.credentialError !== null || row.credential === undefined) {
        return {
            kind: 'unavailable',
            reason: 'credentials-unavailable',
        };
    }
    if (!state.writable) {
        return {
            kind: 'unavailable',
            reason: 'settings-read-only',
        };
    }
    if (!row.credential.writable) {
        return {
            kind: 'unavailable',
            reason: 'credential-read-only',
        };
    }
    return { kind: 'credential-missing' };
}

},
"src/modules/settings-models/snapshot.js": function(module, exports, require) {
// source: src/modules/settings-models/snapshot.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModelSettingsStore = void 0;
var client_1 = require("@xharness/dsh-client-runtime/client");
Object.defineProperty(exports, "createModelSettingsStore", { enumerable: true, get: function () { return client_1.createSnapshotStore; } });

},
"src/modules/settings-models/ProviderEditor.js": function(module, exports, require) {
// source: src/modules/settings-models/ProviderEditor.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pathOps = pathOps;
exports.ProviderEditor = ProviderEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../shared/runtime-types");
/**
 * One provider's editor card, hand-written per adapter family: the primary
 * field is a single write-only **API key** input (the page never asks for an
 * environment-variable name — a typed key stores through `credentials.set`
 * under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile
 * has none. The pi-ai profile records that derivation as `apiKeyEnv` only when
 * a key is entered; a blank key materializes a reference-free profile for
 * provider-native authentication);
 * the collapsed 自定义设置 area carries the per-family extras (`baseURL` for
 * both families, DeepSeek's id/name/context-window model catalog, and the
 * display name and wire protocol of a pi-ai route the adapter does not ship —
 * the two fields the create card asked that route for, editable here for the
 * same reason).
 * Reasoning effort is deliberately absent: it is a per-MODEL capability, and
 * the models under one provider disagree about it, so a provider-scoped
 * control can only be set to a value some of them reject. The composer's
 * model picker offers each model its own levels; `settings.yaml` keeps the
 * profile field for a deployment that knows its route. Everything else stays
 * owned by `settings.yaml`. Profile edits land as minimal `settings.mutate`
 * path ops against the stored section — the card names only the fields it can
 * see instead of rebuilding the whole subtree from a partial descriptor.
 */
const react_1 = require("react");
const DeepSeekModelsEditor_1 = require("./DeepSeekModelsEditor");
const apiKey_1 = require("./apiKey");
const EditorFooter_1 = require("./EditorFooter");
const ModelListEditor_1 = require("./ModelListEditor");
const store_1 = require("./store");
const styles_1 = require("./styles");
/** The public DeepSeek endpoint shown as the deepseek base-URL placeholder. */
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com';
/** A user-section subtree as a plain draft object (absent → empty). */
function draftAt(schema, namespace, path) {
    const subtree = schema.getPath(namespace.user, path);
    if (!(0, runtime_types_1.isObjectRecord)(subtree))
        return {};
    return structuredClone(subtree);
}
/**
 * The minimal path ops carrying `after` over `before`, both as the card sees
 * them. Only keys the card observed are named; fields absent from both sides
 * produce no op, which is why edits are path-addressed rather than a rebuilt
 * section.
 * @param base - path of the edited subtree inside the user section.
 * @param before - the subtree as loaded, or undefined when it is new.
 * @param after - the subtree as edited.
 * @returns ordered set/unset ops; empty when nothing changed.
 */
function pathOps(base, before, after) {
    const previous = (0, runtime_types_1.isObjectRecord)(before)
        ? before
        : {};
    const ops = [];
    for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(previous[key]) === JSON.stringify(value))
            continue;
        ops.push({ op: 'set', path: [...base, key], value });
    }
    for (const key of Object.keys(previous)) {
        if (!(key in after))
            ops.push({ op: 'unset', path: [...base, key] });
    }
    return ops;
}
/** The editor layout the owning namespace selects. */
function layoutOf(ns) {
    if (ns === 'llm-deepseek')
        return 'deepseek';
    if (ns === 'llm-pi-ai')
        return 'pi-ai';
    return 'unknown';
}
/** The credential reference this profile resolves keys through. */
function refFor(schema, namespace, path, provider) {
    const profile = schema.getPath(namespace.value, path);
    const named = (0, runtime_types_1.isObjectRecord)(profile)
        ? profile.apiKeyEnv
        : undefined;
    return typeof named === 'string' && named.length > 0 ? named : (0, store_1.deriveKeyRef)(provider);
}
/**
 * Render one provider's editing card.
 * @param props - the addressed profile plus wire faces and copy.
 * @returns the editor card.
 */
function ProviderEditor(props) {
    const { namespace, schema, settingsPath, api, t } = props;
    const [draft, setDraft] = (0, react_1.useState)(() => draftAt(schema, namespace, settingsPath));
    const [keyDraft, setKeyDraft] = (0, react_1.useState)('');
    const [keyState, setKeyState] = (0, react_1.useState)(undefined);
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [failure, setFailure] = (0, react_1.useState)(undefined);
    // A settings success advances both retry baselines immediately. Keeping the
    // derived fields in the draft prevents a pushed namespace refresh from
    // turning them into deletions when the following credential write is retried.
    const [committedOriginal, setCommittedOriginal] = (0, react_1.useState)(() => schema.getPath(namespace.user, settingsPath));
    const [expectedRevision, setExpectedRevision] = (0, react_1.useState)(() => namespace.revision);
    const root = (0, react_1.useMemo)(() => schema.rehydrate(namespace.schema), [namespace.schema, schema]);
    const node = (0, react_1.useMemo)(() => schema.nodeAtPath(root, settingsPath), [root, schema, settingsPath]);
    const fallback = schema.getPath(namespace.value, settingsPath);
    const disabled = props.readOnly || busy;
    const layout = layoutOf(namespace.ns);
    const keyRef = refFor(schema, namespace, settingsPath, props.provider);
    // The same schema read the create card makes, so the choices offered here
    // and there cannot drift apart: both come from the adapter's own `Config`.
    // Only the pi-ai layout has a per-route protocol for the read to find, and
    // it rehydrates the whole section schema, so the other layouts skip it.
    const protocols = (0, react_1.useMemo)(() => layout === 'pi-ai' ? (0, store_1.protocolChoices)(namespace, schema) : [], [layout, namespace, schema]);
    (0, react_1.useEffect)(() => {
        let stale = false;
        setKeyState(undefined);
        // The key state is a placeholder hint, not a precondition for editing:
        // neither a business rejection nor a transport failure may reach the
        // browser as an unhandled rejection, so the card simply renders without
        // the "already configured" hint.
        void api.credentials.describe({ refs: [keyRef] }).then((response) => {
            if (stale || !response.result.ok)
                return;
            setKeyState(response.result.value.credentials[keyRef]);
        }, () => undefined);
        return () => { stale = true; };
    }, [api.credentials, keyRef]);
    const stringAt = (source, key) => {
        const value = schema.getPath(source, [key]);
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    };
    const setField = (key, next) => {
        // A value of nothing but whitespace is cleared, not stored: `stringAt`
        // already reports it as absent, so the field would otherwise render empty
        // while the draft still carried the spaces into `settings.yaml`, where
        // both adapters would accept that non-empty string as a real value.
        const value = next === undefined || next.trim().length === 0 ? undefined : next;
        setDraft(current => value === undefined
            ? schema.deletePath(current, [key])
            : schema.setPath(current, [key], value));
    };
    // The model list is validated by the same per-row checker for both families,
    // so a bad row is named by its position rather than by a blanket message.
    const modelFailure = (0, DeepSeekModelsEditor_1.validateDeepSeekModels)(schema.getPath(draft, ['models']));
    const keyFailure = (0, apiKey_1.apiKeyFailure)(keyDraft);
    // What a probe or a write must carry: the typed key with paste whitespace
    // removed. A blank field yields an empty string, which both call sites read
    // as "no key supplied" rather than as a key — that is how a card whose
    // provider already has a stored key is edited without re-entering it.
    const keyValue = keyDraft.trim();
    const credentialRequiredFailure = props.credentialRequired === true
        && keyDraft.length > 0 && keyValue.length === 0
        ? 'keyRequired'
        : undefined;
    const shownKeyFailure = credentialRequiredFailure ?? keyFailure;
    // What the form currently shows, which is what an interrogation must ask:
    // an edited-but-unsaved endpoint, and a key typed but not yet stored.
    const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api');
    const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL');
    const probe = {
        settingsNs: namespace.ns,
        // Naming the route lets an adapter that already describes it answer from
        // its own registry — better metadata, no network call, no endpoint needed.
        provider: props.provider,
        ...probeBaseURL === undefined ? {} : { baseURL: probeBaseURL },
        ...probeApi === undefined ? {} : { api: probeApi },
        ...keyValue.length === 0 ? {} : { apiKey: keyValue },
    };
    /**
     * The write for this card, or a failure message. Every edit travels as
     * path ops against the STORED section: the draft comes from the redacted
     * descriptor, so a wholesale replace rebuilt from it could delete fields
     * outside the card. Ops name only the fields this card can see.
     */
    const applyOnce = async () => {
        const ns = namespace.ns;
        // A pi-ai profile names the conventional reference only when this page is
        // about to store a key. Otherwise the provider keeps its native auth path.
        const next = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined
            && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
            ? schema.setPath(draft, ['apiKeyEnv'], keyRef)
            : draft;
        if (props.credentialOnly !== true) {
            // The same checker gates the submit button, so a card cannot reach this
            // with a bad row; it stays because the schema check below would refuse
            // the write with a message naming a path instead of the row, and because
            // nothing but this function decides what is written.
            const failure = (0, DeepSeekModelsEditor_1.validateDeepSeekModels)(schema.getPath(next, ['models']));
            /* v8 ignore next 3 -- unreachable from the card: the same failure disables submit */
            if (failure !== undefined) {
                return `${t('model')} ${String(failure.index + 1)}: ${t(failure.key)}`;
            }
        }
        /* v8 ignore next -- apply is only reachable from the rendered card, which required a resolved node */
        if (props.credentialOnly !== true && node !== undefined && settingsPath.length === 0) {
            const sectionError = schema.validate(node, next);
            if (sectionError !== undefined)
                return sectionError;
        }
        const materializesNativeProfile = layout === 'pi-ai'
            && fallback === undefined
            && committedOriginal === undefined
            && Object.keys(next).length === 0;
        const ops = props.credentialOnly === true
            ? []
            : materializesNativeProfile
                ? [{ op: 'set', path: [...settingsPath], value: {} }]
                : pathOps(settingsPath, committedOriginal, next);
        if (ops.length > 0) {
            const response = await api.settings.mutate({ ns, ops, expectedRevision });
            if (!response.result.ok) {
                return response.result.error.code === 'settings-conflict'
                    ? t('conflict')
                    : response.result.error.message;
            }
            setCommittedOriginal(schema.getPath(response.result.value.user, settingsPath));
            setExpectedRevision(response.result.value.revision);
            setDraft(next);
        }
        if (keyValue.length > 0) {
            const stored = await api.credentials.set({ ref: keyRef, value: keyValue });
            if (!stored.result.ok)
                return stored.result.error.message;
        }
        setKeyDraft('');
        return undefined;
    };
    const apply = async () => {
        setBusy(true);
        setFailure(undefined);
        try {
            const failure = await applyOnce();
            if (failure !== undefined) {
                setFailure(failure);
                return;
            }
            props.onClose(true);
        }
        catch (error) {
            // A transport failure (disconnect, a request the host refuses) rejects
            // rather than answering; without this the card would stay busy forever
            // with no error shown.
            setFailure((0, store_1.messageOf)(error));
        }
        finally {
            setBusy(false);
        }
    };
    if (node === undefined) {
        // A directory entry addressing a position its schema cannot resolve is a
        // host-side inconsistency; showing it beats a blank card.
        return (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: `${props.provider}: unresolvable settings path` });
    }
    const keyLocked = keyState?.writable === false;
    /**
     * The catalog beneath the user layer: what the composition entry pinned, or
     * else the schema default that `resolve` would supply. The effective value
     * cannot answer this — it still carries the stored override until the unset
     * is applied, so reading it would echo that override straight back the
     * moment reset drops it, leaving the rows unchanged until a reload.
     */
    const inheritedModels = () => {
        const pinned = schema.getPath(namespace.base, [...settingsPath, 'models']);
        return pinned ?? schema.nodeAtPath(root, [...settingsPath, 'models'])?.meta.default;
    };
    /**
     * The curated fields of one known adapter family. The family arrives
     * narrowed so the per-family branches below are total: an unknown namespace
     * renders the hint instead and never reaches this body.
     */
    const curatedFields = (family) => {
        // What a hand-declared route names for itself and nothing else can supply.
        // A whole-section `llm-deepseek` profile is a composition fact with no
        // per-route identity for its schema to carry, hence the family test.
        const ownsIdentity = family === 'pi-ai' && props.declared === true;
        const customModels = schema.getPath(draft, ['models']);
        const modelsOverridden = schema.hasPath(draft, ['models']);
        const models = (0, DeepSeekModelsEditor_1.modelDrafts)(modelsOverridden ? customModels : inheritedModels());
        const defaultContextWindow = schema.getPath(fallback, ['defaultContextWindow']);
        const defaultMaxTokens = schema.getPath(fallback, ['maxTokens']);
        const keyPlaceholder = keyLocked
            ? t('keyEnvLocked')
            : keyState?.configured === true && props.credentialRequired !== true
                ? t('keyStored')
                : family === 'pi-ai' ? t('keyPlaceholderNative') : t('keyPlaceholder');
        /** What both family editors take: the rows, whose layer owns them, and the two writes. */
        const catalogProps = {
            models,
            overridden: modelsOverridden,
            t,
            disabled,
            onChange: (next) => {
                setDraft(current => schema.setPath(current, ['models'], next));
            },
            onReset: () => { setDraft(current => schema.deletePath(current, ['models'])); },
        };
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('keyInput') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "password", autoComplete: "off", value: keyDraft, placeholder: keyPlaceholder, "aria-label": t('keyInput'), "aria-invalid": shownKeyFailure !== undefined, required: props.credentialRequired === true, autoFocus: props.autoFocusCredential === true, disabled: disabled || keyLocked, onChange: (event) => { setKeyDraft(event.target.value); } }), shownKeyFailure === undefined ? null : (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: t(shownKeyFailure) })] }), props.credentialOnly === true ? null : (0, jsx_runtime_1.jsxs)("details", { className: styles_1.ModelsSectionCss['customized'], children: [(0, jsx_runtime_1.jsx)("summary", { className: styles_1.ModelsSectionCss['customizedSummary'], children: t('customized') }), (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['customizedBody'], children: [ownsIdentity
                                    ? ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('customDisplayName') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: stringAt(draft, 'displayName') ?? '',
                                                // What this route is called the moment the field is
                                                // cleared, which is the layer beneath the one this field
                                                // edits: a `cordis.yml` may pin a name for a route the
                                                // catalog does not ship, and only when nothing does is
                                                // the answer the route id. Reading the effective value
                                                // instead would echo the stored override back as the
                                                // thing clearing restores.
                                                placeholder: stringAt(schema.getPath(namespace.base, settingsPath), 'displayName')
                                                    ?? props.provider, "aria-label": t('customDisplayName'), disabled: disabled, onChange: (event) => { setField('displayName', event.target.value); } })] }))
                                    : null, (0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('baseUrl') }), (0, jsx_runtime_1.jsx)("input", { className: styles_1.ModelsSectionCss['input'], type: "text", value: stringAt(draft, 'baseURL') ?? '', placeholder: family === 'deepseek'
                                                ? DEEPSEEK_PUBLIC_BASE_URL
                                                : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault'), "aria-label": t('baseUrl'), disabled: disabled, onChange: (event) => {
                                                setField('baseURL', event.target.value === '' ? undefined : event.target.value);
                                            } })] }), ownsIdentity
                                    ? ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['field'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['fieldLabel'], children: t('customApi') }), (0, jsx_runtime_1.jsxs)("select", { className: `${styles_1.ModelsSectionCss['input']} ${styles_1.ModelsSectionCss['selectInput']}`, value: probeApi ?? '', "aria-label": t('customApi'), disabled: disabled, onChange: (event) => { setField('api', event.target.value); }, children: [probeApi === undefined ? (0, jsx_runtime_1.jsx)("option", { value: "", children: t('customApiUnset') }) : null, protocols.map(choice => (0, jsx_runtime_1.jsx)("option", { value: choice, children: choice }, choice))] })] }))
                                    : null, family === 'deepseek'
                                    ? ((0, jsx_runtime_1.jsx)(DeepSeekModelsEditor_1.DeepSeekModelsEditor, { ...catalogProps, defaultContextWindow: typeof defaultContextWindow === 'number'
                                            ? defaultContextWindow
                                            : undefined, defaultMaxTokens: typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined }))
                                    : (0, jsx_runtime_1.jsx)(ModelListEditor_1.ModelListEditor, { ...catalogProps, probe: probe, probeBlocked: keyFailure, api: api })] })] })] }));
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: props.credentialOnly === true ? styles_1.ModelsSectionCss['addBlock'] : styles_1.ModelsSectionCss['editor'], children: [props.hideTitle === true
                ? null
                : ((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ModelsSectionCss['editorHeader'], children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['editorTitle'], children: props.displayName }), props.provider !== props.displayName
                            ? (0, jsx_runtime_1.jsx)("span", { className: styles_1.ModelsSectionCss['editorRoute'], children: props.provider })
                            : null] })), layout === 'unknown'
                ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['advancedHint'], children: `${t('advancedHint')} (${namespace.ns})` })
                : curatedFields(layout), failure !== undefined ? (0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['error'], children: failure }) : null, props.credentialOnly === true || modelFailure === undefined
                ? null
                : ((0, jsx_runtime_1.jsx)("p", { className: styles_1.ModelsSectionCss['advancedHint'], children: `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}` })), (0, jsx_runtime_1.jsx)(EditorFooter_1.EditorFooter, { t: t, busy: busy, submitDisabled: disabled || layout === 'unknown'
                    || (props.credentialOnly !== true && modelFailure !== undefined)
                    || shownKeyFailure !== undefined
                    || (props.credentialRequired === true && keyValue.length === 0), submitLabel: props.submitLabel ?? 'apply', submitBusyLabel: props.submitBusyLabel ?? 'applying', ...props.cancelLabel === undefined ? {} : { cancelLabel: props.cancelLabel }, onCancel: () => { props.onClose(false); }, onSubmit: () => { void apply(); } })] }));
}

},
"src/modules/settings-models/schema-operations.js": function(module, exports, require) {
// source: src/modules/settings-models/schema-operations.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsSchemaOperations = createSettingsSchemaOperations;
/**
 * Hide the Cordis service identity behind bound schema callbacks.
 * @param service - settings-owned schema service available in the apply context.
 * @returns callbacks that cannot expose the service context to React components.
 */
function createSettingsSchemaOperations(service) {
    return {
        rehydrate: serialized => service.rehydrate(serialized),
        validate: (schema, draft) => service.validate(schema, draft),
        nodeAtPath: (root, path) => service.nodeAtPath(root, path),
        getPath: (value, path) => service.getPath(value, path),
        hasPath: (value, path) => service.hasPath(value, path),
        setPath: (root, path, value) => service.setPath(root, path, value),
        deletePath: (root, path) => service.deletePath(root, path),
    };
}

},
"src/modules/settings-models/welcome-store.js": function(module, exports, require) {
// source: src/modules/settings-models/welcome-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WelcomeNoticeStore = void 0;
exports.decodeWelcomeSection = decodeWelcomeSection;
const runtime_types_1 = require("../shared/runtime-types");
const snapshot_1 = require("./snapshot");
const onboarding_copy_1 = require("./onboarding-copy");
/**
 * Accept any object section verbatim; a malformed durable value reads as an
 * empty section, so the notice treats it as unacknowledged instead of leaving
 * the scope stuck on its previous value.
 * @param section - the wire section value.
 * @returns the section object, or an empty one for non-object values.
 */
function decodeWelcomeSection(section) {
    return (0, runtime_types_1.isObjectRecord)(section)
        ? section
        : {};
}
/* v8 ignore next 3 -- closed-union default only defends future source widening */
function assertNever(_value) {
    throw new Error('unexpected welcome settings status');
}
/** Coordinates durable Host acknowledgement or a process-local remote fallback. */
class WelcomeNoticeStore {
    /**
     * @param scope - the welcome settings namespace scope; its memory mode is
     * what keeps a remote browser process-local.
     */
    constructor(scope) {
        this.scope = scope;
        /** uSES-safe state source shared by the registered welcome step. */
        this.store = (0, snapshot_1.createModelSettingsStore)({
            status: 'idle', acknowledged: false, error: null,
        });
        this.localAcknowledged = false;
        this.saving = false;
    }
    /**
     * Begin following the bound scope (idempotent) and publish its current answer.
     * @returns settlement after the current answer is published.
     */
    load() {
        this.following ?? (this.following = this.scope.subscribe(() => { this.derive(); }));
        this.derive();
        return Promise.resolve();
    }
    /**
     * Persist this copy version, or advance only this process for a remote
     * browser. Success is judged against the state the write left behind, so a
     * refused or failed write reports false after its recovery read settles.
     * @returns true when the selected persistence mode holds the acknowledgement.
     */
    async acknowledge() {
        if (this.scope.getSnapshot().mode === 'memory') {
            this.localAcknowledged = true;
            this.derive();
            return true;
        }
        this.saving = true;
        this.store.update((state) => { state.status = 'saving'; state.error = null; });
        try {
            await this.scope.set(onboarding_copy_1.WELCOME_NOTICE_ACK_FIELD, onboarding_copy_1.WELCOME_NOTICE_VERSION);
        }
        finally {
            this.saving = false;
        }
        this.derive();
        const { acknowledged } = this.store.getSnapshot();
        if (!acknowledged) {
            this.store.update((state) => {
                state.status = 'error';
                state.error = 'the acknowledgement did not persist';
            });
        }
        return acknowledged;
    }
    /** Stop following the scope. */
    dispose() {
        this.following?.();
        this.following = undefined;
    }
    derive() {
        if (this.saving)
            return;
        const scope = this.scope.getSnapshot();
        if (scope.mode === 'memory') {
            this.store.update((state) => {
                state.status = 'ready';
                state.acknowledged = this.localAcknowledged;
                state.error = null;
            });
            return;
        }
        switch (scope.status) {
            case 'loading':
                this.store.update((state) => { state.status = 'loading'; state.error = null; });
                return;
            case 'unavailable':
                this.store.update((state) => {
                    state.status = 'error';
                    state.acknowledged = false;
                    state.error = 'welcome acknowledgement settings are unavailable';
                });
                return;
            case 'ready': {
                const acknowledged = scope.value?.[onboarding_copy_1.WELCOME_NOTICE_ACK_FIELD] === onboarding_copy_1.WELCOME_NOTICE_VERSION;
                this.store.update((state) => {
                    state.status = 'ready';
                    state.acknowledged = acknowledged;
                    state.error = null;
                });
                return;
            }
            /* v8 ignore next -- every current settings scope status is handled above */
            default: return assertNever(scope.status);
        }
    }
}
exports.WelcomeNoticeStore = WelcomeNoticeStore;

},
"src/modules/settings-models/onboarding-copy.js": function(module, exports, require) {
// source: src/modules/settings-models/onboarding-copy.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WELCOME_NOTICE_COPY = exports.WELCOME_NOTICE_VERSION = exports.WELCOME_NOTICE_ACK_FIELD = exports.WELCOME_NOTICE_SETTINGS_NAMESPACE = void 0;
/** Durable settings namespace for product-wide GUI onboarding facts. */
exports.WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding';
/** Field storing the last welcome notice version the user acknowledged. */
exports.WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion';
/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
exports.WELCOME_NOTICE_VERSION = '2026-08-13.1';
/** The complete editable internal-testing notice in both supported GUI locales. */
exports.WELCOME_NOTICE_COPY = {
    zh: {
        title: '内测声明',
        body: '',
        continueLabel: '继续',
    },
    en: {
        title: 'Internal Testing Notice',
        body: '',
        continueLabel: 'Continue',
    },
};

},
"src/modules/settings-models/locales.js": function(module, exports, require) {
// source: src/modules/settings-models/locales.ts

"use strict";
/** Copy dictionaries for the Models settings section. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = void 0;
const onboarding_copy_1 = require("./onboarding-copy");
/** English strings (the key-set source of truth for this pair). */
exports.en = {
    nav: 'Models',
    title: 'Models',
    intro: 'Enter your API keys to use models from the following providers.',
    edit: 'Edit',
    editProvider: 'Edit {provider}',
    remove: 'Delete',
    removeProvider: 'Delete {provider}',
    deleteTitle: 'Delete {provider}?',
    deleteDescription: 'Deleting {provider} removes its configuration. Any credential it uses is managed elsewhere and will be kept.',
    deleteDescriptionWithCredential: 'Deleting {provider} removes its configuration and stored API key.',
    deleteConfirm: 'Delete {provider}',
    deleting: 'Deleting {provider}…',
    add: 'Add provider',
    provider: 'Provider',
    close: 'Close',
    cancel: 'Cancel',
    apply: 'Apply',
    applying: 'Applying…',
    savedProvider: 'Saved {provider}.',
    credentialConfigured: 'API key configured',
    credentialMissing: 'API key missing',
    readOnly: 'The settings document is read-only in this deployment.',
    loadFailed: 'Loading the provider directory failed',
    conflict: 'Someone else changed these settings while this card was open. Close it and reopen to edit the current values.',
    retry: 'Retry',
    keyInput: 'API key',
    keyPlaceholder: 'Enter your API key',
    keyPlaceholderNative: 'Enter an API key, or leave blank to use environment authentication',
    keyStored: 'Configured — enter a new value to replace',
    keyEnvLocked: 'Provided by the launch environment (read-only)',
    customized: 'Customized settings',
    baseUrl: 'Base URL',
    baseUrlDefault: 'Provider default',
    models: 'Models',
    modelsInherited: 'Using the adapter defaults',
    modelsCustomized: 'Customized model catalog',
    resetModels: 'Restore defaults',
    model: 'Model',
    modelId: 'Model ID',
    modelName: 'Display name',
    modelNamePlaceholder: 'Uses the model ID when empty',
    contextWindow: 'Context window',
    contextWindowPlaceholder: 'Uses the provider default',
    maxTokens: 'Max output tokens',
    maxTokensPlaceholder: 'Uses the provider default',
    modelAdvanced: 'Capacities',
    addModel: 'Add model',
    removeModel: 'Delete model',
    modelsEmpty: 'No models will be shown in the selector. Unlisted IDs can still be sent directly.',
    keyBlank: 'Enter the API key, or leave the field empty to keep the stored one.',
    keyBlankNew: 'Enter the API key, or leave the field empty if this provider authenticates another way.',
    keyIllegalCharacters: 'This API key is not in a valid format. Please check it.',
    modelIdRequired: 'Model ID is required.',
    modelIdDuplicate: 'Model ID must be unique.',
    modelNameInvalid: 'Display name cannot be empty.',
    modelContextInvalid: 'Context window must be a positive count, like 131072, 256K, or 1M.',
    modelMaxTokensInvalid: 'Max output tokens must be a positive count, like 8192, 64K, or 1M.',
    advancedHint: 'Other fields live in settings.yaml; edit that section directly.',
    modelCapacityInvalid: 'A capacity must be a number, optionally suffixed K or M.',
    modelDuplicate: 'Each model ID may appear once.',
    modelContextWindow: 'Context window',
    modelMaxTokens: 'Max output tokens',
    fetchModels: 'Fetch available models',
    fetching: 'Asking the provider\u2026',
    fetchNeedsBaseUrl: 'Enter the base URL first, then fetch.',
    fetchEmpty: 'The provider listed no models. Add them by hand.',
    fetchTitle: 'Choose models to add',
    fetchDescription: 'These are the models this provider has available. Choose the ones to add.',
    fetchSelectAll: 'Select all',
    fetchDeselectAll: 'Deselect all',
    fetchAdopt: 'Add selected',
    customAdd: 'Add a custom provider',
    customTitle: 'Custom provider',
    customTag: 'Custom',
    customRoute: 'Provider ID',
    customRouteHint: 'Lowercase identifier, starting with a letter, that uniquely names this provider in requests and as its credential name.',
    customRouteInvalid: 'Start with a lowercase letter; then lowercase letters, digits, and dashes.',
    customRouteTaken: 'A provider already uses this ID.',
    customDisplayName: 'Display name',
    customApi: 'API protocol',
    customApiUnset: 'Not selected',
    customNeedsBaseUrl: 'A custom provider needs a base URL.',
    customNeedsModels: 'A custom provider needs at least one model.',
    create: 'Create provider',
    creating: 'Creating\u2026',
    welcomeTitle: onboarding_copy_1.WELCOME_NOTICE_COPY.en.title,
    welcomeBody: onboarding_copy_1.WELCOME_NOTICE_COPY.en.body,
    welcomeContinue: onboarding_copy_1.WELCOME_NOTICE_COPY.en.continueLabel,
    welcomeError: 'The acknowledgement could not be saved. Please try again.',
    onboardingTitle: 'Add an API key to get started',
    onboardingDescription: 'Add a provider API key to get started.',
    onboardingLater: 'Configure later',
    onboardingSave: 'Save and continue',
    onboardingSaving: 'Saving…',
    keyRequired: 'Enter an API key to continue.',
};
/** Chinese strings (same keys as {@link en}). */
exports.zh = {
    nav: '模型',
    title: '模型',
    intro: '填入各提供方的 API 密钥即可使用其模型。',
    edit: '编辑',
    editProvider: '编辑 {provider}',
    remove: '删除',
    removeProvider: '删除 {provider}',
    deleteTitle: '删除 {provider}？',
    deleteDescription: '删除 {provider} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。',
    deleteDescriptionWithCredential: '删除 {provider} 会移除其配置和存储的 API 密钥。',
    deleteConfirm: '删除 {provider}',
    deleting: '正在删除 {provider}…',
    add: '添加提供方',
    provider: '提供方',
    close: '关闭',
    cancel: '取消',
    apply: '保存',
    applying: '保存中…',
    savedProvider: '已保存 {provider}。',
    credentialConfigured: 'API 密钥已配置',
    credentialMissing: 'API 密钥缺失',
    readOnly: '当前部署的设置文档为只读。',
    loadFailed: '加载提供方目录失败',
    conflict: '这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。',
    retry: '重试',
    keyInput: 'API 密钥',
    keyPlaceholder: '输入 API 密钥',
    keyPlaceholderNative: '输入 API 密钥，或留空使用环境认证',
    keyStored: '已配置——输入新值可替换',
    keyEnvLocked: '由启动环境提供（只读）',
    customized: '自定义设置',
    baseUrl: 'API 地址',
    baseUrlDefault: '提供方默认',
    models: '模型目录',
    modelsInherited: '正在使用适配器默认模型',
    modelsCustomized: '已自定义模型目录',
    resetModels: '恢复默认模型',
    model: '模型',
    modelId: '模型 ID',
    modelName: '显示名称',
    modelNamePlaceholder: '留空时使用模型 ID',
    contextWindow: '上下文窗口',
    contextWindowPlaceholder: '使用提供方默认值',
    maxTokens: '最大输出 token 数',
    maxTokensPlaceholder: '使用提供方默认值',
    modelAdvanced: '容量',
    addModel: '添加模型',
    removeModel: '删除模型',
    modelsEmpty: '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。',
    keyBlank: '请输入 API 密钥；留空则保持已存储的密钥。',
    keyBlankNew: '请输入 API 密钥；若该提供方以其他方式鉴权，可以留空。',
    keyIllegalCharacters: '该 API 密钥格式错误，请检查。',
    modelIdRequired: '模型 ID 不能为空。',
    modelIdDuplicate: '模型 ID 不能重复。',
    modelNameInvalid: '显示名称不能为空。',
    modelContextInvalid: '上下文窗口必须是正数，例如 131072、256K 或 1M。',
    modelMaxTokensInvalid: '最大输出 token 数必须是正数，例如 8192、64K 或 1M。',
    advancedHint: '其余字段在 settings.yaml 中，请直接编辑对应段。',
    modelCapacityInvalid: '容量需为数字，可加 K 或 M 后缀。',
    modelDuplicate: '每个模型 ID 只能出现一次。',
    modelContextWindow: '上下文窗口',
    modelMaxTokens: '最大输出 token',
    fetchModels: '获取可用模型',
    fetching: '正在询问提供方\u2026',
    fetchNeedsBaseUrl: '请先填写 API 地址，再获取。',
    fetchEmpty: '该提供方没有列出任何模型，请手动添加。',
    fetchTitle: '选择要添加的模型',
    fetchDescription: '以下是模型提供方的可用模型，勾选要添加的模型。',
    fetchSelectAll: '全选',
    fetchDeselectAll: '取消全选',
    fetchAdopt: '添加所选',
    customAdd: '添加自定义提供方',
    customTitle: '自定义提供方',
    customTag: '自定义',
    customRoute: 'Provider ID',
    customRouteHint: '以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。',
    customRouteInvalid: '需以小写字母开头，之后可用小写字母、数字和短横线。',
    customRouteTaken: '已有提供方使用了这个 ID。',
    customDisplayName: '显示名称',
    customApi: 'API 协议',
    customApiUnset: '未选择',
    customNeedsBaseUrl: '自定义提供方需要填写 API 地址。',
    customNeedsModels: '自定义提供方至少需要一个模型。',
    create: '创建提供方',
    creating: '创建中\u2026',
    welcomeTitle: onboarding_copy_1.WELCOME_NOTICE_COPY.zh.title,
    welcomeBody: onboarding_copy_1.WELCOME_NOTICE_COPY.zh.body,
    welcomeContinue: onboarding_copy_1.WELCOME_NOTICE_COPY.zh.continueLabel,
    welcomeError: '暂时无法保存确认状态，请重试。',
    onboardingTitle: '添加一个 API Key 开始使用',
    onboardingDescription: '添加模型提供方的 API 密钥即可开始使用。',
    onboardingLater: '稍后配置',
    onboardingSave: '保存并继续',
    onboardingSaving: '保存中…',
    keyRequired: '请输入 API 密钥后继续。',
};

}
};
const __dependencies = {"src/modules/settings-models/index.js":{"./ManagedAccount":"src/modules/settings-models/ManagedAccount.js","./ModelsSection":"src/modules/settings-models/ModelsSection.js","./store":"src/modules/settings-models/store.js","./schema-operations":"src/modules/settings-models/schema-operations.js","./welcome-store":"src/modules/settings-models/welcome-store.js","./onboarding-copy":"src/modules/settings-models/onboarding-copy.js","./locales":"src/modules/settings-models/locales.js"},"src/modules/settings-models/ManagedAccount.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/settings-models/ModelsSection.js":{"./primitives":"src/modules/settings-models/primitives.js","./CustomProviderCard":"src/modules/settings-models/CustomProviderCard.js","./store":"src/modules/settings-models/store.js","./ProviderEditor":"src/modules/settings-models/ProviderEditor.js","./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/primitives.js":{},"src/modules/settings-models/CustomProviderCard.js":{"./apiKey":"src/modules/settings-models/apiKey.js","./EditorFooter":"src/modules/settings-models/EditorFooter.js","./DeepSeekModelsEditor":"src/modules/settings-models/DeepSeekModelsEditor.js","./ModelListEditor":"src/modules/settings-models/ModelListEditor.js","./store":"src/modules/settings-models/store.js","./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/apiKey.js":{},"src/modules/settings-models/EditorFooter.js":{"./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/styles.js":{"./ModelsSection.css":"src/modules/settings-models/ModelsSection.css","./OnboardingModal.css":"src/modules/settings-models/OnboardingModal.css","./DeepSeekOnboardingDialog.css":"src/modules/settings-models/DeepSeekOnboardingDialog.css","./WelcomeNotice.css":"src/modules/settings-models/WelcomeNotice.css"},"src/modules/settings-models/ModelsSection.css":{},"src/modules/settings-models/OnboardingModal.css":{},"src/modules/settings-models/DeepSeekOnboardingDialog.css":{},"src/modules/settings-models/WelcomeNotice.css":{},"src/modules/settings-models/DeepSeekModelsEditor.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./primitives":"src/modules/settings-models/primitives.js","./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/ModelListEditor.js":{"./primitives":"src/modules/settings-models/primitives.js","./DeepSeekModelsEditor":"src/modules/settings-models/DeepSeekModelsEditor.js","./store":"src/modules/settings-models/store.js","./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/store.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./snapshot":"src/modules/settings-models/snapshot.js"},"src/modules/settings-models/snapshot.js":{},"src/modules/settings-models/ProviderEditor.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./DeepSeekModelsEditor":"src/modules/settings-models/DeepSeekModelsEditor.js","./apiKey":"src/modules/settings-models/apiKey.js","./EditorFooter":"src/modules/settings-models/EditorFooter.js","./ModelListEditor":"src/modules/settings-models/ModelListEditor.js","./store":"src/modules/settings-models/store.js","./styles":"src/modules/settings-models/styles.js"},"src/modules/settings-models/schema-operations.js":{},"src/modules/settings-models/welcome-store.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./snapshot":"src/modules/settings-models/snapshot.js","./onboarding-copy":"src/modules/settings-models/onboarding-copy.js"},"src/modules/settings-models/onboarding-copy.js":{},"src/modules/settings-models/locales.js":{"./onboarding-copy":"src/modules/settings-models/onboarding-copy.js"}};
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
return __load("src/modules/settings-models/index.js");
}
});
