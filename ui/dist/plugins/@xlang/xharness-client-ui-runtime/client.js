// Generated from src/modules/runtime-environment/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-runtime",
factory: (__externalRequire) => {
const __units = {
"src/modules/runtime-environment/index.js": function(module, exports, require) {
// source: src/modules/runtime-environment/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENVIRONMENT_SLOT = exports.inject = void 0;
exports.apply = apply;
const react_1 = require("react");
const GatewayEnvironment_1 = require("./GatewayEnvironment");
const locales_1 = require("./locales");
exports.inject = ['slots', 'locale', 'connection'];
exports.ENVIRONMENT_SLOT = 'conversation.hero.runtimeEnvironment';
/** Owned source-module registration, not a patch of a generated JS bundle. */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { en: locales_1.en, zh: locales_1.zh }), 'runtime-environment: dictionaries');
    ctx.slots.inject(exports.ENVIRONMENT_SLOT, () => ctx.slots.register({ name: exports.ENVIRONMENT_SLOT, locale: locales_1.NS }, (props) => (0, react_1.createElement)(GatewayEnvironment_1.GatewayHero, { ...props, catalogueClient: ctx.get('connection').environmentCatalogue })));
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'environment-gateway', order: -20, locale: locales_1.NS }, (props) => (0, react_1.createElement)(GatewayEnvironment_1.GatewayHeader, { ...props, catalogueClient: ctx.get('connection').environmentCatalogue })));
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'environment-cloud-status', order: -20, locale: locales_1.NS }, (props) => (0, react_1.createElement)(GatewayEnvironment_1.GatewayCloudStatus, { t: props.t, description: ctx.get('connection').hostDescription, catalogueClient: ctx.get('connection').environmentCatalogue })));
}

},
"src/modules/runtime-environment/GatewayEnvironment.js": function(module, exports, require) {
// source: src/modules/runtime-environment/GatewayEnvironment.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayCreationPicker = GatewayCreationPicker;
exports.GatewayHeader = GatewayHeader;
exports.GatewayHero = GatewayHero;
exports.GatewayCloudStatus = GatewayCloudStatus;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const EnvironmentPicker_1 = require("./EnvironmentPicker");
const gateway_1 = require("./gateway");
function useCatalogue(client) {
    const [catalogue, setCatalogue] = (0, react_1.useState)();
    (0, react_1.useEffect)(() => {
        if (client === undefined)
            return;
        const controller = new AbortController();
        let timer;
        const refresh = async () => {
            try {
                const raw = await client.read(controller.signal);
                const parsed = (0, gateway_1.parseCatalogue)(raw, location.origin);
                if (!controller.signal.aborted && parsed !== undefined)
                    setCatalogue(previous => previous ?? parsed);
            }
            catch { /* Discovery is optional. Retain this page's immutable validated identity; live connectivity is owned by ConnectionController. */ }
            if (!controller.signal.aborted)
                timer = setTimeout(() => { void refresh(); }, 30000);
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [client]);
    return catalogue;
}
function GatewayCreationPicker({ catalogue, t, sessionId, appearance }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const [blocked, setBlocked] = (0, react_1.useState)(false);
    const eligible = (0, react_1.useRef)(sessionId === undefined);
    eligible.current = sessionId === undefined;
    (0, react_1.useEffect)(() => {
        eligible.current = sessionId === undefined;
        setOpen(false);
        setBlocked(false);
        return () => { eligible.current = false; };
    }, [sessionId]);
    const current = catalogue.entries.find(e => e.id === catalogue.current);
    const Icon = current?.kind === 'cloud' ? dsh_client_ui_primitives_1.IconGlobeOutline14 : dsh_client_ui_primitives_1.IconFollowsystemOutline16;
    if (sessionId !== undefined)
        return (0, jsx_runtime_1.jsx)(EnvironmentLabel, { catalogue: catalogue, t: t });
    return (0, jsx_runtime_1.jsxs)("span", { "data-xh-environment-create-picker": "", style: { display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', flexWrap: 'wrap' }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: open, portal: true, side: "bottom", selectedId: catalogue.current, onClose: () => { setOpen(false); }, onSelect: id => {
                    if (!eligible.current)
                        return;
                    setOpen(false);
                    if (id === catalogue.current)
                        return;
                    setBlocked(!(0, gateway_1.openNewTaskEnvironment)(catalogue, eligible.current, id, href => { const page = window.open('about:blank', '_blank'); if (page !== null) {
                        page.opener = null;
                        page.location.replace(href);
                    } ; return page; }));
                }, items: catalogue.entries.map(e => ({ id: e.id, label: e.label, disabled: e.id === catalogue.current,
                    icon: e.kind === 'cloud' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconGlobeOutline14, { size: 16, "aria-hidden": "true" }) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFollowsystemOutline16, { size: 16, "aria-hidden": "true" }) })), anchor: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: appearance?.trigger, "aria-label": t('choose'), "aria-haspopup": "menu", "aria-expanded": open, title: t('separate'), onClick: () => { setOpen(value => !value); }, style: appearance ? undefined : { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid currentColor', borderRadius: 8, padding: '5px 9px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }, children: [(0, jsx_runtime_1.jsx)(Icon, { size: 16, className: appearance?.icon, "aria-hidden": "true" }), (0, jsx_runtime_1.jsx)("span", { className: appearance?.label, children: current?.label }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 12, className: appearance?.chevron, "aria-hidden": "true" })] }) }), blocked && (0, jsx_runtime_1.jsx)("span", { role: "alert", children: t('popupBlocked') })] });
}
function EnvironmentLabel({ catalogue, t }) {
    const current = catalogue.entries.find(e => e.id === catalogue.current);
    if (current === undefined)
        return null;
    const Icon = current.kind === 'cloud' ? dsh_client_ui_primitives_1.IconGlobeOutline14 : dsh_client_ui_primitives_1.IconFollowsystemOutline16;
    return (0, jsx_runtime_1.jsxs)("span", { "data-xh-environment-bound": "", title: t('bound'), style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }, children: [(0, jsx_runtime_1.jsx)(Icon, { size: 14, "aria-hidden": "true" }), (0, jsx_runtime_1.jsx)("span", { children: current.label })] });
}
/** Existing chats show their immutable environment, never a switch control. */
function GatewayHeader({ t, catalogueClient }) {
    const catalogue = useCatalogue(catalogueClient);
    return catalogue === undefined ? null : (0, jsx_runtime_1.jsx)(EnvironmentLabel, { catalogue: catalogue, t: t });
}
function GatewayHero({ t, catalogueClient, ...owner }) {
    const catalogue = useCatalogue(catalogueClient);
    return catalogue === undefined ? (0, jsx_runtime_1.jsx)(EnvironmentPicker_1.EnvironmentPicker, { ...owner, t: t }) : (0, jsx_runtime_1.jsx)(GatewayCreationPicker, { catalogue: catalogue, t: t, sessionId: owner.sessionId, appearance: owner.appearance });
}
/** No “takeover” or “synced” claim: v1 only provides real isolated connections. */
function GatewayCloudStatus({ t, description, catalogueClient }) {
    const catalogue = useCatalogue(catalogueClient);
    const connected = (0, react_1.useSyncExternalStore)(description.subscribe, description.getSnapshot, () => undefined) !== undefined;
    const current = catalogue?.entries.find(e => e.id === catalogue.current);
    if (current?.kind !== 'cloud')
        return null;
    return (0, jsx_runtime_1.jsxs)("div", { "data-xh-cloud-status": "", role: "status", style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, padding: '7px 10px', border: '1px solid currentColor', borderRadius: 8, opacity: 0.8 }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconGlobeOutline14, { size: 14, "aria-hidden": "true" }), (0, jsx_runtime_1.jsx)("strong", { children: current.label }), (0, jsx_runtime_1.jsx)("span", { children: connected ? t('connected') : t('disconnected') }), (0, jsx_runtime_1.jsx)("span", { children: t('notSynced') })] });
}

},
"src/modules/runtime-environment/EnvironmentPicker.js": function(module, exports, require) {
// source: src/modules/runtime-environment/EnvironmentPicker.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvironmentPicker = EnvironmentPicker;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const policy_1 = require("./policy");
/** Presentation only: never route a cloud pick to the local Host as fallback. */
function EnvironmentPicker({ t, appearance, ...owner }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const trigger = (0, react_1.useRef)(null);
    const localLabel = (0, react_1.useRef)(null);
    const presentation = (0, policy_1.environmentPresentation)(owner);
    const reason = presentation === 'draft' ? undefined : t(presentation);
    // An old menu must not survive a workspace/session/history-state transition.
    (0, react_1.useEffect)(() => { setOpen(false); }, [owner.sessionId, presentation, owner.openState]);
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const frame = requestAnimationFrame(() => {
            const item = localLabel.current?.closest('[role="menuitem"]');
            if (item !== undefined && item !== null && !item.disabled)
                item.focus({ preventScroll: true });
        });
        const keydown = (event) => {
            const list = localLabel.current?.closest('[role="menu"]');
            if (!(event.target instanceof Node)
                || !(list?.contains(event.target) === true || trigger.current?.contains(event.target) === true))
                return;
            if (event.key === 'Tab') {
                setOpen(false);
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                return;
            event.preventDefault();
            const item = localLabel.current?.closest('[role="menuitem"]');
            if (item !== undefined && item !== null && !item.disabled)
                item.focus({ preventScroll: true });
        };
        document.addEventListener('keydown', keydown);
        return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); };
    }, [open]);
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: open, portal: true, side: "bottom", selectedId: "local", onClose: () => { setOpen(false); }, onSelect: id => {
            if (!(0, policy_1.canAcknowledgeLocalPick)(presentation, id))
                return;
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
        }, items: [
            { id: 'local', disabled: presentation !== 'draft',
                icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFollowsystemOutline16, { size: 16, "aria-hidden": "true" }),
                label: (0, jsx_runtime_1.jsx)("span", { ref: localLabel, children: t('local') }) },
            { id: 'cloud', disabled: true,
                icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconGlobeOutline14, { size: 16, "aria-hidden": "true" }),
                label: (0, jsx_runtime_1.jsxs)("span", { children: [t('cloud'), (0, jsx_runtime_1.jsx)("span", { style: { display: 'block', maxWidth: 280, whiteSpace: 'normal' }, children: t('unavailable') })] }) },
            ...(reason === undefined ? [] : [{ type: 'label', id: 'binding-reason', text: reason }]),
        ], anchor: (0, jsx_runtime_1.jsxs)("button", { ref: trigger, type: "button", className: appearance.trigger, "data-xh-runtime-environment": "", "data-xh-environment-presentation": presentation, "aria-label": t('choose'), "aria-haspopup": "menu", "aria-expanded": open, title: reason ?? t('unavailable'), onClick: () => { setOpen(value => !value); }, onKeyDown: event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setOpen(true);
                }
            }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFollowsystemOutline16, { className: appearance.icon, size: 16, "aria-hidden": "true" }), (0, jsx_runtime_1.jsx)("span", { className: appearance.label, children: t('local') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: appearance.chevron, size: 12, "aria-hidden": "true" })] }) });
}

},
"src/modules/runtime-environment/policy.js": function(module, exports, require) {
// source: src/modules/runtime-environment/policy.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.environmentPresentation = environmentPresentation;
exports.canAcknowledgeLocalPick = canAcknowledgeLocalPick;
/** Only a confirmed cold/open blank composer is eligible for a future pick. */
function environmentPresentation(owner) {
    if (owner.sessionId === undefined)
        return 'draft';
    if (owner.summaryBlank === true && owner.composerPhase === 'blank'
        && (owner.openState === 'cold' || owner.openState === 'open'))
        return 'draft';
    if (owner.openState === 'open' && owner.composerPhase === 'active')
        return 'bound';
    return 'unknown';
}
/** Fail closed even if a disabled menu dispatches a forged/obsolete item ID. */
function canAcknowledgeLocalPick(presentation, id) {
    return presentation === 'draft' && id === 'local';
}

},
"src/modules/runtime-environment/gateway.js": function(module, exports, require) {
// source: src/modules/runtime-environment/gateway.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCatalogue = void 0;
exports.openNewTaskEnvironment = openNewTaskEnvironment;
const environment_catalogue_1 = require("../client-connection/contracts/environment-catalogue");
var environment_catalogue_2 = require("../client-connection/contracts/environment-catalogue");
Object.defineProperty(exports, "parseCatalogue", { enumerable: true, get: function () { return environment_catalogue_2.parseCatalogue; } });
/** A new-task pick opens another origin. It never rebinds a SessionManager or copies its
 * draft/history/attachment cache. A blocked popup is not a successful switch. */
function openNewTaskEnvironment(catalogue, canChoose, id, open) {
    if (!canChoose)
        return false;
    const target = catalogue.entries.find(e => e.id === id);
    if (target === undefined || id === catalogue.current || !(0, environment_catalogue_1.validEnvironmentEntry)(target))
        return false;
    // The target runtime consumes only this navigation intent, never a backend URL.
    return open(target.href + '#new-task') !== null;
}

},
"src/modules/client-connection/contracts/environment-catalogue.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/environment-catalogue.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validEnvironmentEntry = validEnvironmentEntry;
exports.parseCatalogue = parseCatalogue;
function object(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validEnvironmentEntry(value) {
    if (!object(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id', 'label', 'kind', 'href'].includes(key)) || typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.id)
        || typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 80 || /[\x00-\x1f\x7f]/.test(value.label)
        || (value.kind !== 'local' && value.kind !== 'cloud') || typeof value.href !== 'string')
        return false;
    try {
        const url = new URL(value.href);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash && url.href === value.href;
    }
    catch {
        return false;
    }
}
function parseCatalogue(value, origin) {
    if (!object(value) || Object.keys(value).length !== 5 || Object.keys(value).some(key => !['version', 'current', 'entries', 'sessionMigration', 'workspaceSync'].includes(key)) || value.version !== 1 || typeof value.current !== 'string'
        || value.sessionMigration !== false || value.workspaceSync !== false || !Array.isArray(value.entries)
        || !value.entries.length || value.entries.length > 8 || !value.entries.every(validEnvironmentEntry))
        return undefined;
    const entries = value.entries;
    if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(entries.map(e => e.href)).size !== entries.length
        || entries.filter(e => e.kind === 'local').length !== 1 || entries.find(e => e.id === value.current)?.href !== origin + '/')
        return undefined;
    return { version: 1, current: value.current, entries, sessionMigration: false, workspaceSync: false };
}

},
"src/modules/runtime-environment/locales.js": function(module, exports, require) {
// source: src/modules/runtime-environment/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.NS = void 0;
exports.NS = 'runtime.environment';
exports.en = {
    separate: 'Start a new chat in the selected environment. Existing chats and drafts stay here.',
    popupBlocked: 'Browser blocked the new environment tab. Allow popups and try again.',
    connected: 'Cloud Host connected', disconnected: 'Cloud connection unavailable',
    notSynced: 'Independent workspace · session transfer and file sync are not enabled',
    choose: 'Choose execution environment', local: 'Local', cloud: 'Cloud',
    unavailable: 'Cloud execution is not connected yet. Tasks still run on the current Host.',
    bound: 'This conversation keeps its existing environment. Start a new task to choose another.',
    unknown: 'Conversation history has not been confirmed. Its environment cannot be changed.',
};
exports.zh = {
    separate: '在所选环境新建聊天；已有聊天和草稿保持不变。',
    popupBlocked: '新环境标签页被浏览器拦截，请允许弹出窗口后重试。',
    connected: '云端 Host 已连接', disconnected: '云端连接不可用',
    notSynced: '独立工作区 · 尚未启用会话迁移与文件同步',
    choose: '选择执行环境', local: '本机', cloud: 'Cloud',
    unavailable: '云端执行尚未接入。任务仍在当前 Host 上运行。',
    bound: '此对话保持原执行环境。切换环境需要新建任务。',
    unknown: '尚未确认对话历史，不能更改其执行环境。',
};

}
};
const __dependencies = {"src/modules/runtime-environment/index.js":{"./GatewayEnvironment":"src/modules/runtime-environment/GatewayEnvironment.js","./locales":"src/modules/runtime-environment/locales.js"},"src/modules/runtime-environment/GatewayEnvironment.js":{"./EnvironmentPicker":"src/modules/runtime-environment/EnvironmentPicker.js","./gateway":"src/modules/runtime-environment/gateway.js"},"src/modules/runtime-environment/EnvironmentPicker.js":{"./policy":"src/modules/runtime-environment/policy.js"},"src/modules/runtime-environment/policy.js":{},"src/modules/runtime-environment/gateway.js":{"../client-connection/contracts/environment-catalogue":"src/modules/client-connection/contracts/environment-catalogue.js"},"src/modules/client-connection/contracts/environment-catalogue.js":{},"src/modules/runtime-environment/locales.js":{}};
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
return __load("src/modules/runtime-environment/index.js");
}
});
