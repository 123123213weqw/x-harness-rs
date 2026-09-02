// Generated from src/modules/settings-general/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings-general",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings-general/index.js": function(module, exports, require) {
// source: src/modules/settings-general/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.SettingsDocumentStore = void 0;
exports.apply = apply;
const dsh_client_ui_slots_1 = require("@xharness/dsh-client-ui-slots");
const SettingsRoot_1 = require("./SettingsRoot");
const AccountEntry_1 = require("./AccountEntry");
const chrome_1 = require("./chrome");
const GeneralSection_1 = require("./GeneralSection");
const SettingsDocumentAction_1 = require("./SettingsDocumentAction");
const settings_document_store_1 = require("./settings-document-store");
const locales_1 = require("./locales");
var settings_document_store_2 = require("./settings-document-store");
Object.defineProperty(exports, "SettingsDocumentStore", { enumerable: true, get: function () { return settings_document_store_2.SettingsDocumentStore; } });
/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const settings_navigation_1 = require("../shared/settings-navigation");
const NS = 'settings';
/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registrations depend on their slots through `slots.inject()`.
 */
exports.inject = ['slots', 'locale', 'connection', 'settingsScope'];
/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-settings-general: dictionaries');
    // Copy freshness is framework-owned: components read the standard `t`
    // seat, and the nav label is a thunk the owner resolves per render — no
    // locale/change re-registration wiring.
    const t = ctx.locale.bind(NS);
    const connection = ctx.get('connection');
    // The action follows the shared describe mirror, whose owning plugin
    // already refreshes it on document commits and reconnects.
    const documentController = connection.isLoopback
        ? new settings_document_store_1.SettingsDocumentStore(connection.api, ctx.settingsScope.describe())
        : undefined;
    const documentInjected = documentController === undefined
        ? undefined
        : () => ({
            controller: documentController,
            hooks: { snapshot: documentController.store },
        });
    ctx.effect(() => () => { documentController?.dispose(); }, 'ui-settings-general: document action directory');
    // The settings shell: this package occupies the sidebar-owned hole and
    // declares the settings slots. Ledger → nav-row projection as an observable
    // source (uSES contract: getSnapshot returns the cached rows until the
    // ledger version moves). Labels may be locale-following thunks, so the cache
    // key includes the locale revision and subscribers ride both sources.
    let rowsVersion = -1;
    let rowsRevision = -1;
    let rows = [];
    let onboardingVersion = -1;
    let onboardingSteps = [];
    const shellInjected = () => ({
        subscribeOpenSection: listener => ctx.on(settings_navigation_1.OPEN_SETTINGS_SECTION, listener),
        hooks: {
            sections: {
                getSnapshot: () => {
                    const version = ctx.slots.getVersion('settings.section');
                    const revision = ctx.locale.getSnapshot().revision;
                    if (version !== rowsVersion || revision !== rowsRevision) {
                        rowsVersion = version;
                        rowsRevision = revision;
                        rows = ctx.slots.entries('settings.section')
                            .map(e => ({
                            /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                            id: e.options.id ?? '',
                            order: e.options.order ?? 0,
                            label: (0, dsh_client_ui_slots_1.resolveSlotLabel)(e.options.label) ?? '',
                        }))
                            .sort((a, b) => a.order - b.order);
                    }
                    return rows;
                },
                subscribe: (listener) => {
                    const offLedger = ctx.slots.subscribe('settings.section', listener);
                    const offLocale = ctx.locale.subscribe(listener);
                    return () => {
                        offLedger();
                        offLocale();
                    };
                },
            },
            onboardingSteps: {
                getSnapshot: () => {
                    const version = ctx.slots.getVersion('settings.onboarding');
                    if (version !== onboardingVersion) {
                        onboardingVersion = version;
                        onboardingSteps = ctx.slots.entries('settings.onboarding')
                            .map(e => ({
                            /* v8 ignore next -- list-slot registration requires id */
                            id: e.options.id ?? '',
                            order: e.options.order ?? 0,
                        }))
                            .sort((a, b) => a.order - b.order);
                    }
                    return onboardingSteps;
                },
                subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
            },
        },
    });
    ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
        name: 'sidebar.settings',
        children: {
            'settings.trigger': { kind: 'single', scope: 'root' },
            'settings.account-entry': { kind: 'single', scope: 'root' },
            'settings.header': { kind: 'single', scope: 'root' },
            'settings.action': { kind: 'list', scope: 'root' },
            'settings.close': { kind: 'single', scope: 'root' },
            'settings.section': { kind: 'list', scope: 'root' },
            'settings.onboarding': { kind: 'list', scope: 'root' },
        },
        inject: shellInjected,
    }, SettingsRoot_1.SettingsRoot));
    ctx.slots.inject('settings.trigger', () => ctx.slots.register({ name: 'settings.trigger', locale: NS }, chrome_1.TriggerContent));
    ctx.slots.inject('settings.account-entry', () => ctx.slots.register({ name: 'settings.account-entry', locale: NS }, AccountEntry_1.AccountEntry));
    ctx.slots.inject('settings.header', () => ctx.slots.register({ name: 'settings.header', locale: NS }, chrome_1.HeaderContent));
    if (documentInjected !== undefined) {
        ctx.slots.inject('settings.action', () => ctx.slots.register({
            name: 'settings.action',
            id: 'open-document',
            order: 0,
            locale: NS,
            inject: documentInjected,
        }, SettingsDocumentAction_1.SettingsDocumentAction));
    }
    ctx.slots.inject('settings.close', () => ctx.slots.register({ name: 'settings.close', locale: NS }, chrome_1.CloseLabel));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: () => t('general.nav'),
        locale: NS,
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
    }, GeneralSection_1.GeneralSection));
}

},
"src/modules/settings-general/SettingsRoot.js": function(module, exports, require) {
// source: src/modules/settings-general/SettingsRoot.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsRoot = SettingsRoot;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
const react_1 = require("react");
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const SettingsRoot_styles_1 = __importDefault(require("./SettingsRoot.styles"));
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id) {
    if (id === 'models')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDataOutline16, { className: SettingsRoot_styles_1.default.navIcon, size: 16 });
    if (id === 'agent-presets')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconAgentPresetOutline16, { className: SettingsRoot_styles_1.default.navIcon, size: 16 });
    if (id === 'plugins')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPersonalizationOutline16, { className: SettingsRoot_styles_1.default.navIcon, size: 16 });
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSettingsOutline16, { className: SettingsRoot_styles_1.default.navIcon, size: 16 });
}
/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and native top-layer cancel. Menus can consume
 * Escape without closing this surface; background controls remain inert.
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }) {
    // Entries can unmount underneath the requested id, so the render-time
    // projection falls back to the first row when the id is gone.
    const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id;
    const titleId = (0, react_1.useId)();
    // DialogSurface owns native modality and restores the opening trigger.
    const closeButton = (0, react_1.useRef)(null);
    return ((0, jsx_runtime_1.jsxs)(dsh_client_ui_primitives_1.DialogSurface, { className: SettingsRoot_styles_1.default.overlay, labelledBy: titleId, onClose: onClose, initialFocus: closeButton, children: [(0, jsx_runtime_1.jsx)("div", { className: SettingsRoot_styles_1.default.mask, "aria-hidden": "true", onClick: onClose }), (0, jsx_runtime_1.jsxs)("div", { className: SettingsRoot_styles_1.default.panel, "data-xh-settings-panel": "", children: [(0, jsx_runtime_1.jsxs)("nav", { className: SettingsRoot_styles_1.default.nav, children: [(0, jsx_runtime_1.jsx)("div", { className: SettingsRoot_styles_1.default.navTitle, id: titleId, children: renderSlot('settings.header', {}) }), (0, jsx_runtime_1.jsx)("div", { className: SettingsRoot_styles_1.default.navList, children: rows.map(row => ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, views_types_1.classNames)(SettingsRoot_styles_1.default.navCell, row.id === active && SettingsRoot_styles_1.default.active), "aria-current": row.id === active ? 'true' : undefined, onClick: () => { onSelect(row.id); }, children: [navIcon(row.id), (0, jsx_runtime_1.jsx)("span", { className: SettingsRoot_styles_1.default.navLabel, children: row.label })] }, row.id))) })] }), (0, jsx_runtime_1.jsxs)("div", { className: SettingsRoot_styles_1.default.content, children: [(0, jsx_runtime_1.jsxs)("div", { className: SettingsRoot_styles_1.default.header, children: [(0, jsx_runtime_1.jsx)("div", { className: SettingsRoot_styles_1.default.actions, children: renderSlot('settings.action', {}) }), (0, jsx_runtime_1.jsxs)("button", { ref: closeButton, type: "button", className: SettingsRoot_styles_1.default.close, onClick: onClose, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 14 }), (0, jsx_runtime_1.jsx)("span", { className: SettingsRoot_styles_1.default.hiddenLabel, children: renderSlot('settings.close', {}) })] })] }), (0, jsx_runtime_1.jsx)("div", { className: SettingsRoot_styles_1.default.options, children: active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active }) })] })] })] }));
}
/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
function SettingsRoot(props) {
    const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props;
    const [open, setOpen] = (0, react_1.useState)(false);
    const [activeId, setActiveId] = (0, react_1.useState)(undefined);
    const [completedOnboarding, setCompletedOnboarding] = (0, react_1.useState)(() => new Set());
    const close = (0, react_1.useCallback)(() => {
        setOpen(false);
        setActiveId(undefined);
    }, []);
    const openSection = (0, react_1.useCallback)((id) => {
        setActiveId(id);
        setOpen(true);
    }, []);
    (0, react_1.useEffect)(() => props.subscribeOpenSection?.(openSection), [props.subscribeOpenSection, openSection]);
    // The ledger tick keeps the nav rows fresh: registrants re-register with
    // freshly localized text on locale change, and the trigger/header/close
    // seats re-render through their own outlets' subscriptions.
    const rows = useSections(s => s);
    const onboardingSteps = useOnboardingSteps(s => s);
    const onboardingActive = useSessions(state => state.phase === 'ready'
        && (state.current === undefined || state.byId[state.current]?.blank === true));
    const onboardingStep = onboardingActive
        ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
        : undefined;
    (0, react_1.useEffect)(() => {
        if (onboardingActive)
            return;
        setCompletedOnboarding(new Set());
    }, [onboardingActive]);
    const completeOnboardingStep = (0, react_1.useCallback)((id) => {
        setCompletedOnboarding((previous) => {
            if (previous.has(id))
                return previous;
            return new Set([...previous, id]);
        });
    }, []);
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [renderSlot('settings.account-entry', { wide, rows, openSection }, { fallback: (0, jsx_runtime_1.jsx)("button", { type: "button", className: (0, views_types_1.classNames)(SettingsRoot_styles_1.default.trigger, !wide && SettingsRoot_styles_1.default.rail), "aria-haspopup": "dialog", "aria-expanded": open, onClick: () => { setOpen(true); }, children: renderSlot('settings.trigger', { wide }) }) }), open && ((0, jsx_runtime_1.jsx)(SettingsPanel, { rows: rows, renderSlot: renderSlot, activeId: activeId, onSelect: setActiveId, onClose: close })), onboardingStep !== undefined && renderSlot('settings.onboarding', {
                stepId: onboardingStep.id,
                complete: () => { completeOnboardingStep(onboardingStep.id); },
                openSection,
            }, { only: onboardingStep.id })] }));
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
"src/modules/settings-general/SettingsRoot.styles.js": function(module, exports, require) {
// source: src/modules/settings-general/SettingsRoot.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SettingsRoot_css_1 = __importDefault(require("./SettingsRoot.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-general/SettingsRoot.module.css", "@xharness/dsh-client-ui-settings-general", SettingsRoot_css_1.default);
const styles = {
    "actions": "_8OspXW_actions",
    "active": "_8OspXW_active",
    "close": "_8OspXW_close",
    "content": "_8OspXW_content",
    "header": "_8OspXW_header",
    "hiddenLabel": "_8OspXW_hiddenLabel",
    "mask": "_8OspXW_mask",
    "nav": "_8OspXW_nav",
    "navCell": "_8OspXW_navCell",
    "navIcon": "_8OspXW_navIcon",
    "navLabel": "_8OspXW_navLabel",
    "navList": "_8OspXW_navList",
    "navTitle": "_8OspXW_navTitle",
    "options": "_8OspXW_options",
    "overlay": "_8OspXW_overlay",
    "panel": "_8OspXW_panel",
    "rail": "_8OspXW_rail",
    "trigger": "_8OspXW_trigger",
    "triggerLabel": "_8OspXW_triggerLabel"
};
exports.default = styles;

},
"src/modules/settings-general/SettingsRoot.css": function(module, exports, require) {
// source: src/modules/settings-general/SettingsRoot.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._8OspXW_trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}._8OspXW_trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}._8OspXW_trigger._8OspXW_rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}._8OspXW_triggerLabel{white-space:nowrap;overflow:hidden}._8OspXW_overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}._8OspXW_mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}._8OspXW_panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:800px;max-width:calc(100vw - 48px);height:min(800px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;position:relative;overflow:hidden}._8OspXW_nav{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex}._8OspXW_navTitle{color:var(--dsw-alias-label-primary);padding:0 12px;font-size:16px;font-weight:500;line-height:24px}._8OspXW_navList{flex-direction:column;gap:4px;display:flex}._8OspXW_navCell{box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex}._8OspXW_navCell:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}._8OspXW_navCell._8OspXW_active{background:var(--dsw-specific-sidebar-nav-item-active)}._8OspXW_navIcon{flex:none}._8OspXW_navLabel{white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden}._8OspXW_content{flex-direction:column;flex:1;min-width:0;display:flex}._8OspXW_header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:flex-start;gap:8px;height:54px;padding:20px 14px 8px 10px;display:flex}._8OspXW_actions{justify-content:flex-end;align-items:center;gap:8px;min-width:0;margin-left:auto;display:flex}._8OspXW_close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}._8OspXW_close:hover{background:var(--dsw-alias-interactive-bg-hover)}._8OspXW_options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}._8OspXW_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}\n@media(max-width:640px){._8OspXW_panel{max-width:calc(100vw - 24px);height:calc(100dvh - 24px);flex-direction:column;border-radius:20px}._8OspXW_nav{width:100%;padding:16px 16px 0;gap:12px}._8OspXW_navTitle{padding:0;min-height:28px}._8OspXW_navList{flex-direction:row;overflow-x:auto;gap:4px;padding-bottom:4px}._8OspXW_navCell{flex:none;height:36px;padding:8px 12px}._8OspXW_content{min-height:0}._8OspXW_header{position:absolute;top:0;right:0;height:56px;padding:14px 10px;z-index:2}._8OspXW_options{padding:16px}._8OspXW_actions{max-width:160px}}\n";

},
"src/modules/settings-general/AccountEntry.js": function(module, exports, require) {
// source: src/modules/settings-general/AccountEntry.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountMenuRows = accountMenuRows;
exports.AccountEntry = AccountEntry;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const AccountEntry_styles_1 = __importDefault(require("./AccountEntry.styles"));
/** Route by stable section IDs, never translated labels. Optional features
 * disappear with their slot registration; Settings stays usable without login.
 * This entry deliberately does not infer identity from a configured API key.
 */
function accountMenuRows(rows, t) {
    return [
        { id: 'managed-account', label: t('account.menu'), icon: 'account' },
        { id: 'profile', label: t('account.profile'), icon: 'profile' },
        { id: 'general', label: t('trigger'), icon: 'settings' },
    ].filter(item => rows.some(row => row.id === item.id));
}
/** A single sidebar entry, with an upward body-portal menu. Reuses Menu's
 * viewport clamp, outside-click/Escape handling and native-browser occlusion
 * semantics. Authentication continues in the existing account section.
 */
function AccountEntry({ wide, rows, openSection, t }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const root = (0, react_1.useRef)(null);
    const trigger = (0, react_1.useRef)(null);
    const labels = (0, react_1.useRef)(new Map());
    const firstFocus = (0, react_1.useRef)('first');
    const entries = accountMenuRows(rows, t);
    const buttons = () => entries.map(entry => labels.current.get(entry.id)?.closest('button'))
        .filter((button) => button != null && !button.disabled);
    const close = (0, react_1.useCallback)(() => setOpen(false), []);
    const getAnchorRect = (0, react_1.useCallback)(() => trigger.current?.getBoundingClientRect() ?? null, []);
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        // Menu measures its portal while hidden. Focus after placement is visible,
        // and cancel the frame if the entry closes/unmounts in the same commit.
        const frame = requestAnimationFrame(() => {
            if (document.activeElement !== trigger.current)
                return;
            const controls = buttons();
            const target = firstFocus.current === 'last' ? controls.at(-1) : controls[0];
            target?.focus();
        });
        return () => cancelAnimationFrame(frame);
        // Opening focus is a view transition, not a reaction to locale/ledger changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    (0, react_1.useEffect)(close, [wide, close]);
    return (0, jsx_runtime_1.jsx)("span", { ref: root, className: AccountEntry_styles_1.default.root, "data-xh-account-entry": "", onMouseDownCapture: event => {
            if (event.button !== 0 || !(event.target instanceof Node))
                return;
            const target = event.target;
            const button = trigger.current?.contains(target) ? trigger.current
                : buttons().find(control => control.contains(target));
            if (!button)
                return;
            // Normalize pointer focus before blur can dismiss the portal. Safari
            // otherwise blurs to the body and removes the item before its click.
            event.preventDefault();
            button.focus();
        }, onBlur: event => {
            const next = event.relatedTarget;
            if (next instanceof Node && (root.current?.contains(next) || buttons().some(button => button.contains(next))))
                return;
            close();
        }, onKeyDown: event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                return;
            event.preventDefault();
            if (!open) {
                firstFocus.current = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first';
                setOpen(true);
                return;
            }
            const controls = buttons();
            if (controls.length === 0)
                return;
            const current = controls.findIndex(button => button === document.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
                : current < 0 ? (event.key === 'ArrowDown' ? 0 : controls.length - 1)
                    : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
            controls[index]?.focus();
        }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: open, portal: true, side: "top", className: AccountEntry_styles_1.default.menuAnchor, getAnchorRect: getAnchorRect, onClose: close, onSelect: section => {
                if (!entries.some(entry => entry.id === section))
                    return;
                // The menu item is about to unmount. Give the modal a durable opener
                // so closing Settings restores focus to this sidebar entry.
                trigger.current?.focus();
                close();
                openSection(section);
            }, items: [
                { type: 'label', id: 'identity', text: t('account.local') },
                ...entries.map(entry => ({ id: entry.id,
                    label: (0, jsx_runtime_1.jsx)("span", { ref: element => { if (element)
                            labels.current.set(entry.id, element);
                        else
                            labels.current.delete(entry.id); }, className: AccountEntry_styles_1.default.menuLabel, children: entry.label }),
                    icon: entry.icon === 'account' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconUserOutline16, { size: 16 })
                        : entry.icon === 'profile' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDataOutline16, { size: 16 }) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSettingsOutline16, { size: 16 }),
                })),
            ], anchor: (0, jsx_runtime_1.jsxs)("button", { ref: trigger, type: "button", className: `${AccountEntry_styles_1.default.trigger} ${!wide ? AccountEntry_styles_1.default.rail : ''}`, "aria-label": t('account.trigger'), "aria-haspopup": "menu", "aria-expanded": open, title: !wide ? t('account.trigger') : undefined, "data-xh-account-trigger": "", onClick: () => {
                    // WebKit does not focus buttons on pointer clicks by default. Give
                    // the opening transition the same focus anchor as keyboard input.
                    trigger.current?.focus();
                    firstFocus.current = 'first';
                    setOpen(value => !value);
                }, children: [(0, jsx_runtime_1.jsx)("span", { className: AccountEntry_styles_1.default.avatar, "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconUserOutline16, { size: 18 }) }), wide && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("span", { className: AccountEntry_styles_1.default.identity, children: [(0, jsx_runtime_1.jsx)("span", { className: AccountEntry_styles_1.default.name, children: t('account.name') }), (0, jsx_runtime_1.jsx)("span", { className: AccountEntry_styles_1.default.caption, children: t('account.caption') })] }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 14, className: AccountEntry_styles_1.default.chevron })] })] }) }) });
}

},
"src/modules/settings-general/AccountEntry.styles.js": function(module, exports, require) {
// source: src/modules/settings-general/AccountEntry.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AccountEntry_css_1 = __importDefault(require("./AccountEntry.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/dsh-client-ui-settings-general/AccountEntry.module.css', '@xharness/dsh-client-ui-settings-general', AccountEntry_css_1.default);
const styles = {
    root: 'xhAccount_root', menuAnchor: 'xhAccount_anchor', trigger: 'xhAccount_trigger',
    rail: 'xhAccount_rail', avatar: 'xhAccount_avatar', identity: 'xhAccount_identity',
    name: 'xhAccount_name', caption: 'xhAccount_caption', chevron: 'xhAccount_chevron',
    menuLabel: 'xhAccount_menuLabel',
};
exports.default = styles;

},
"src/modules/settings-general/AccountEntry.css": function(module, exports, require) {
// source: src/modules/settings-general/AccountEntry.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhAccount_root,.xhAccount_anchor{display:flex;width:100%;min-width:0}\n.xhAccount_trigger{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;height:52px;margin:4px 0;padding:6px 8px;background:transparent;color:var(--dsw-alias-label-primary);border:0;border-radius:12px;font:inherit;text-align:left;cursor:pointer}\n.xhAccount_trigger:hover,.xhAccount_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}\n.xhAccount_trigger:focus-visible{outline:2px solid currentColor;outline-offset:2px}\n.xhAccount_avatar{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-2)}\n.xhAccount_identity{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}\n.xhAccount_name{font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.xhAccount_caption{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.xhAccount_chevron{flex:none;color:var(--dsw-alias-label-secondary)}\n.xhAccount_rail{width:36px;height:36px;padding:0;justify-content:center;border-radius:50%;margin:8px 0 10px}\n.xhAccount_menuLabel{display:block;min-width:204px;max-width:calc(100vw - 76px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\nbutton[role=menuitem]:has(.xhAccount_menuLabel):focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}\n";

},
"src/modules/settings-general/chrome.js": function(module, exports, require) {
// source: src/modules/settings-general/chrome.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TriggerContent = TriggerContent;
exports.HeaderContent = HeaderContent;
exports.CloseLabel = CloseLabel;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Shell chrome content registered into the shell's trigger/header seats: the
 * trigger row icon + label (figma sidebar foot) and the panel title text.
 * The shell renders the surrounding chrome (button, nav heading row) and
 * reads each entry's `label` option for aria text.
 */
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const chrome_styles_1 = __importDefault(require("./chrome.styles"));
/**
 * Render the trigger row content (icon; label only in the wide column).
 * @param props - composed slot props.
 * @returns the trigger content fragment.
 */
function TriggerContent({ wide, t }) {
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [wide ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSettingsOutline16, { size: 16 }) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSettingsOutline14, { size: 18 }), (0, jsx_runtime_1.jsx)("span", { className: wide ? chrome_styles_1.default.triggerLabel : chrome_styles_1.default.hiddenLabel, children: t('trigger') })] }));
}
/**
 * Render the panel title text.
 * @param props - composed slot props.
 * @returns the title text node.
 */
function HeaderContent({ t }) {
    return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: t('title') });
}
/**
 * Render the close button's visually-hidden label text.
 * @param props - composed slot props.
 * @returns the label text node.
 */
function CloseLabel({ t }) {
    return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: t('close') });
}

},
"src/modules/settings-general/chrome.styles.js": function(module, exports, require) {
// source: src/modules/settings-general/chrome.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const chrome_css_1 = __importDefault(require("./chrome.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-general/chrome.module.css", "@xharness/dsh-client-ui-settings-general", chrome_css_1.default);
const styles = {
    "triggerLabel": "GHoW-q_triggerLabel",
    "hiddenLabel": "GHoW-q_hiddenLabel"
};
exports.default = styles;

},
"src/modules/settings-general/chrome.css": function(module, exports, require) {
// source: src/modules/settings-general/chrome.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".GHoW-q_triggerLabel{white-space:nowrap;overflow:hidden}\n.GHoW-q_hiddenLabel{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}\n";

},
"src/modules/settings-general/GeneralSection.js": function(module, exports, require) {
// source: src/modules/settings-general/GeneralSection.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeneralSection = GeneralSection;
const jsx_runtime_1 = require("react/jsx-runtime");
const GeneralSection_styles_1 = __importDefault(require("./GeneralSection.styles"));
/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
function GeneralSection({ renderSlot }) {
    return ((0, jsx_runtime_1.jsx)("div", { className: GeneralSection_styles_1.default.section, children: renderSlot('settings.general.item', {}) }));
}

},
"src/modules/settings-general/GeneralSection.styles.js": function(module, exports, require) {
// source: src/modules/settings-general/GeneralSection.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const GeneralSection_css_1 = __importDefault(require("./GeneralSection.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-general/GeneralSection.module.css", "@xharness/dsh-client-ui-settings-general", GeneralSection_css_1.default);
const styles = {
    "section": "C4ry3W_section"
};
exports.default = styles;

},
"src/modules/settings-general/GeneralSection.css": function(module, exports, require) {
// source: src/modules/settings-general/GeneralSection.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".C4ry3W_section{flex-direction:column;width:100%;display:flex}.C4ry3W_section>[data-slot=\"settings.general.item\"]>:last-child{border-bottom:none}\n";

},
"src/modules/settings-general/SettingsDocumentAction.js": function(module, exports, require) {
// source: src/modules/settings-general/SettingsDocumentAction.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsDocumentAction = SettingsDocumentAction;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Optional settings-header action for opening a file-backed Host document. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const SettingsDocumentAction_styles_1 = __importDefault(require("./SettingsDocumentAction.styles"));
/**
 * Render the open-document action only after Host metadata confirms document availability.
 * @param props - header owner props, localized copy, and injected document state.
 * @returns the action, or null while unavailable or unresolved.
 */
function SettingsDocumentAction({ controller, useSnapshot, t }) {
    const state = useSnapshot(snapshot => snapshot);
    (0, react_1.useEffect)(() => {
        void controller.load();
    }, [controller]);
    if (state.status !== 'ready')
        return null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: SettingsDocumentAction_styles_1.default.action, children: [state.error === null ? null : (0, jsx_runtime_1.jsx)("span", { className: SettingsDocumentAction_styles_1.default.error, role: "alert", children: t('openDocument.error') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", disabled: state.opening, onClick: () => { void controller.open(); }, children: t('openDocument') })] }));
}

},
"src/modules/settings-general/SettingsDocumentAction.styles.js": function(module, exports, require) {
// source: src/modules/settings-general/SettingsDocumentAction.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SettingsDocumentAction_css_1 = __importDefault(require("./SettingsDocumentAction.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-general/SettingsDocumentAction.module.css", "@xharness/dsh-client-ui-settings-general", SettingsDocumentAction_css_1.default);
const styles = {
    "action": "TdWx9W_action",
    "error": "TdWx9W_error"
};
exports.default = styles;

},
"src/modules/settings-general/SettingsDocumentAction.css": function(module, exports, require) {
// source: src/modules/settings-general/SettingsDocumentAction.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".TdWx9W_action{align-items:center;gap:8px;min-width:0;display:flex}.TdWx9W_error{max-width:180px;color:var(--dsw-alias-state-error-primary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}\n";

},
"src/modules/settings-general/settings-document-store.js": function(module, exports, require) {
// source: src/modules/settings-general/settings-document-store.ts

"use strict";
/** State owner for the optional local settings-document action. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsDocumentStore = void 0;
const client_1 = require("@xharness/dsh-client-runtime/client");
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Derives local-document availability from the shared mirror and invokes the pathless Host-owned open operation. */
class SettingsDocumentStore {
    /**
     * @param api - loopback settings wire face that opens the provider document.
     * @param describeFace - the shared mirror's describe face (`hasDocument` source).
     */
    constructor(api, describeFace) {
        this.api = api;
        this.describeFace = describeFace;
        /** uSES-safe state source shared by the registered header action. */
        this.store = (0, client_1.createSnapshotStore)({
            status: 'idle', opening: false, error: null,
        });
    }
    /**
     * Begin following the mirror (idempotent) and reflect whether the current
     * provider owns a local document.
     * @returns settlement once the snapshot reflects the mirror.
     */
    async load() {
        this.following ?? (this.following = this.describeFace.subscribe(() => { this.derive(); }));
        this.store.update((state) => {
            state.status = 'loading';
            state.error = null;
        });
        await this.describeFace.ensure();
        this.derive();
    }
    /**
     * Open the loaded document once; concurrent gestures collapse behind the in-flight action.
     * @returns after the native-open request settles, or immediately when unavailable/already opening.
     */
    async open() {
        const current = this.store.getSnapshot();
        if (current.status !== 'ready' || current.opening)
            return;
        this.store.update((state) => {
            state.opening = true;
            state.error = null;
        });
        try {
            const response = await this.api.settings.openDocument({});
            if (!response.result.ok)
                throw new Error(response.result.error.message);
        }
        catch (error) {
            this.store.update((state) => { state.error = messageOf(error); });
        }
        finally {
            this.store.update((state) => { state.opening = false; });
        }
    }
    /** Stop following the mirror. */
    dispose() {
        this.following?.();
        this.following = undefined;
    }
    derive() {
        const mirrored = this.describeFace.getSnapshot();
        if (mirrored.view === undefined) {
            // A held failure with no answer means the document cannot be located;
            // without one the read is still in flight and loading stands.
            if (mirrored.error !== null) {
                this.store.update((state) => {
                    state.status = 'unavailable';
                    state.error = mirrored.error;
                });
            }
            return;
        }
        const { hasDocument } = mirrored.view;
        this.store.update((state) => {
            state.status = hasDocument ? 'ready' : 'unavailable';
            state.error = null;
        });
    }
}
exports.SettingsDocumentStore = SettingsDocumentStore;

},
"src/modules/settings-general/locales.js": function(module, exports, require) {
// source: src/modules/settings-general/locales.ts

"use strict";
/** Shell chrome and General-nav dictionaries; feature rows own their copy. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'trigger': '设置',
    'title': '设置',
    'close': '关闭',
    'openDocument': '打开配置文件',
    'openDocument.error': '无法打开配置文件',
    'general.nav': '通用设置',
    'account.trigger': '账号与设置',
    'account.name': 'XHarness',
    'account.caption': '账号与设置',
    'account.local': '本机工作区',
    'account.menu': '账号与额度',
    'account.profile': '使用档案',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'trigger': 'Settings',
    'title': 'Settings',
    'close': 'Close',
    'openDocument': 'Open configuration file',
    'openDocument.error': 'Could not open configuration file',
    'general.nav': 'General',
    'account.trigger': 'Account & settings',
    'account.name': 'XHarness',
    'account.caption': 'Account & settings',
    'account.local': 'Local workspace',
    'account.menu': 'Account & allowance',
    'account.profile': 'Usage profile',
};

},
"src/modules/shared/settings-navigation.js": function(module, exports, require) {
// source: src/modules/shared/settings-navigation.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPEN_SETTINGS_SECTION = void 0;
/** Root-context event: the settings shell owns navigation and modal state. */
exports.OPEN_SETTINGS_SECTION = 'settings/open-section';

}
};
const __dependencies = {"src/modules/settings-general/index.js":{"./SettingsRoot":"src/modules/settings-general/SettingsRoot.js","./AccountEntry":"src/modules/settings-general/AccountEntry.js","./chrome":"src/modules/settings-general/chrome.js","./GeneralSection":"src/modules/settings-general/GeneralSection.js","./SettingsDocumentAction":"src/modules/settings-general/SettingsDocumentAction.js","./settings-document-store":"src/modules/settings-general/settings-document-store.js","./locales":"src/modules/settings-general/locales.js","../shared/settings-navigation":"src/modules/shared/settings-navigation.js"},"src/modules/settings-general/SettingsRoot.js":{"../views-types":"src/modules/views-types.js","./SettingsRoot.styles":"src/modules/settings-general/SettingsRoot.styles.js"},"src/modules/views-types.js":{},"src/modules/settings-general/SettingsRoot.styles.js":{"./SettingsRoot.css":"src/modules/settings-general/SettingsRoot.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-general/SettingsRoot.css":{},"src/modules/settings-general/AccountEntry.js":{"./AccountEntry.styles":"src/modules/settings-general/AccountEntry.styles.js"},"src/modules/settings-general/AccountEntry.styles.js":{"./AccountEntry.css":"src/modules/settings-general/AccountEntry.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-general/AccountEntry.css":{},"src/modules/settings-general/chrome.js":{"./chrome.styles":"src/modules/settings-general/chrome.styles.js"},"src/modules/settings-general/chrome.styles.js":{"./chrome.css":"src/modules/settings-general/chrome.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-general/chrome.css":{},"src/modules/settings-general/GeneralSection.js":{"./GeneralSection.styles":"src/modules/settings-general/GeneralSection.styles.js"},"src/modules/settings-general/GeneralSection.styles.js":{"./GeneralSection.css":"src/modules/settings-general/GeneralSection.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-general/GeneralSection.css":{},"src/modules/settings-general/SettingsDocumentAction.js":{"./SettingsDocumentAction.styles":"src/modules/settings-general/SettingsDocumentAction.styles.js"},"src/modules/settings-general/SettingsDocumentAction.styles.js":{"./SettingsDocumentAction.css":"src/modules/settings-general/SettingsDocumentAction.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-general/SettingsDocumentAction.css":{},"src/modules/settings-general/settings-document-store.js":{},"src/modules/settings-general/locales.js":{},"src/modules/shared/settings-navigation.js":{}};
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
return __load("src/modules/settings-general/index.js");
}
});
