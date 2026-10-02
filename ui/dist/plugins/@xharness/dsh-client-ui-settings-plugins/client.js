// Generated from src/modules/settings-plugins/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings-plugins",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings-plugins/index.js": function(module, exports, require) {
// source: src/modules/settings-plugins/index.ts

"use strict";
/// <reference path="./externals.d.ts" />
/**
 * Plugins settings surface, browser half — one section whose feature-owned
 * tabs include configurable Host plugin cards and read-only inventory.
 *
 * The section declares `settings.plugins.tab`; its own `configurable` tab then
 * declares `settings.plugin.item` and renders whatever cards were registered
 * into it. The three cards this package ships are the host-plane sections the
 * deployment already exposes; each binds its namespace through the client
 * settings scope, which keeps them unaware of one another and of other tabs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const dsh_client_ui_slots_1 = require("@xharness/dsh-client-ui-slots");
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
const AgentLoopCard_1 = require("./AgentLoopCard");
const BashCard_1 = require("./BashCard");
const ConfigurablePluginsTab_1 = require("./ConfigurablePluginsTab");
const PluginsSettingsSection_1 = require("./PluginsSettingsSection");
const WebSearchCard_1 = require("./WebSearchCard");
const agent_loop_card_controller_1 = require("./agent-loop-card-controller");
const bash_card_controller_1 = require("./bash-card-controller");
const tab_store_1 = require("./tab-store");
const web_search_card_controller_1 = require("./web-search-card-controller");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins';
/** Required services (cordis fiber inject). */
exports.inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];
/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
    const { api } = ctx.get('connection');
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-settings-plugins: section dictionaries');
    const bash = new bash_card_controller_1.BashCardController(ctx.settingsScope.bind({ namespace: bash_card_controller_1.SHELL_NS }));
    const agentLoop = new agent_loop_card_controller_1.AgentLoopCardController(ctx.settingsScope.bind({ namespace: agent_loop_card_controller_1.AGENT_LOOP_NS }));
    const webSearch = new web_search_card_controller_1.WebSearchCardController(ctx.settingsScope.bind({ namespace: web_search_card_controller_1.WEB_SEARCH_NS }), api);
    // The credential a card reports is not part of any settings section, so its
    // scope publishes nothing when one is written. This is the only signal that
    // a key written on another surface reached the Host.
    ctx.effect(() => ctx.remote.$on('credentials/updated', (ref) => { webSearch.refreshCredential(ref); }), 'ui-settings-plugins: credential invalidations');
    // Which namespaces the Host serves comes from the shared describe mirror,
    // whose owning plugin already refreshes it on document commits and
    // reconnects — the tab only derives.
    const configurable = new tab_store_1.ConfigurablePluginsTabController(ctx.settingsScope.describe(), () => ctx.slots.entries('settings.plugin.item'));
    ctx.effect(() => () => { configurable.dispose(); }, 'ui-settings-plugins: tab directory');
    // A card registered after the first read joins the list without a wire call.
    ctx.effect(() => ctx.slots.subscribe('settings.plugin.item', () => { configurable.refresh(); }), 'ui-settings-plugins: card ledger');
    let tabsVersion = -1;
    let tabsRevision = -1;
    let tabs = [];
    const sectionInjected = () => ({
        hooks: {
            tabs: {
                getSnapshot: () => {
                    const version = ctx.slots.getVersion('settings.plugins.tab');
                    const revision = ctx.locale.getSnapshot().revision;
                    if (version !== tabsVersion || revision !== tabsRevision) {
                        tabsVersion = version;
                        tabsRevision = revision;
                        tabs = ctx.slots.entries('settings.plugins.tab')
                            .map(entry => ({
                            /* v8 ignore next -- list-slot registration requires id */
                            id: entry.options.id ?? '',
                            order: entry.options.order ?? 0,
                            label: (0, dsh_client_ui_slots_1.resolveSlotLabel)(entry.options.label) ?? '',
                        }))
                            .sort((a, b) => a.order - b.order);
                    }
                    return tabs;
                },
                subscribe: (listener) => {
                    const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener);
                    const offLocale = ctx.locale.subscribe(listener);
                    return () => {
                        offLedger();
                        offLocale();
                    };
                },
            },
        },
    });
    // This package owns the one Plugins navigation entry and the tab chrome;
    // feature plugins contribute pages without competing for Settings nav rows.
    ctx.slots.inject('plugins.advanced', () => ctx.slots.register({
        name: 'plugins.advanced',
        id: 'plugins',
        order: 15,
        label: () => t('nav'),
        locale: NS,
        inject: sectionInjected,
        children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
    }, PluginsSettingsSection_1.PluginsSettingsSection));
    // The existing configuration page is one ordinary tab. It keeps ownership
    // of the card slot and the three shipped card contributions below.
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'configurable',
        order: 0,
        label: () => t('configurableTab'),
        locale: NS,
        inject: () => configurable.inject(),
        children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
    }, ConfigurablePluginsTab_1.ConfigurablePluginsTab));
    ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
            name: 'settings.plugin.item',
            key: bash_card_controller_1.SHELL_NS,
            locale: NS,
            inject: () => bash.inject(),
        }, BashCard_1.BashCard);
        yield ctx.slots.register({
            name: 'settings.plugin.item',
            key: agent_loop_card_controller_1.AGENT_LOOP_NS,
            locale: NS,
            inject: () => agentLoop.inject(),
        }, AgentLoopCard_1.AgentLoopCard);
        yield ctx.slots.register({
            name: 'settings.plugin.item',
            key: web_search_card_controller_1.WEB_SEARCH_NS,
            locale: NS,
            inject: () => webSearch.inject(),
        }, WebSearchCard_1.WebSearchCard);
    });
}

},
"src/modules/settings-plugins/AgentLoopCard.js": function(module, exports, require) {
// source: src/modules/settings-plugins/AgentLoopCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentLoopCard = AgentLoopCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const fields_1 = require("./fields");
const PluginCard_1 = require("./PluginCard");
/**
 * Render the agent-loop card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
function AgentLoopCard(props) {
    const { t } = props;
    const state = props.useAgentLoopCard(snapshot => snapshot);
    return ((0, jsx_runtime_1.jsx)(PluginCard_1.PluginCard, { t: t, titleKey: "agentLoopTitle", descriptionKey: "agentLoopDescription", state: state, onSave: props.save, onDiscard: props.discard, children: (0, jsx_runtime_1.jsx)(fields_1.ValueField, { id: "plugin-config-agent-loop-parallel", label: t('agentLoopMaxParallel'), hint: t('agentLoopMaxParallelHint'), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), numeric: true, disabled: !state.writable, ...state.maxParallelToolCalls, onEdit: (text) => { props.edit('maxParallelToolCalls', text); }, onReset: () => { props.resetField('maxParallelToolCalls'); } }) }));
}

},
"src/modules/settings-plugins/fields.js": function(module, exports, require) {
// source: src/modules/settings-plugins/fields.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValueField = ValueField;
exports.SecretField = SecretField;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */
const fields_styles_1 = __importDefault(require("./fields.styles"));
/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
function ValueField(props) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: fields_styles_1.default.field, children: [(0, jsx_runtime_1.jsxs)("div", { className: fields_styles_1.default.head, children: [(0, jsx_runtime_1.jsx)("label", { className: fields_styles_1.default.label, htmlFor: props.id, children: props.label }), props.overridden
                        ? ((0, jsx_runtime_1.jsxs)("span", { className: fields_styles_1.default.badges, children: [(0, jsx_runtime_1.jsx)("span", { className: fields_styles_1.default.badge, children: props.overriddenLabel }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: fields_styles_1.default.reset, disabled: props.disabled, onClick: props.onReset, children: props.resetLabel })] }))
                        : null] }), (0, jsx_runtime_1.jsx)("input", { id: props.id, className: props.invalid ? fields_styles_1.default.inputInvalid : fields_styles_1.default.input, type: "text", ...props.numeric === true ? { inputMode: 'numeric' } : {}, ...props.invalid ? { 'aria-invalid': true } : {}, value: props.text, placeholder: props.placeholder ?? '', disabled: props.disabled, onChange: (event) => { props.onEdit(event.target.value); } }), (0, jsx_runtime_1.jsx)("p", { className: props.invalid ? fields_styles_1.default.invalid : fields_styles_1.default.hint, children: props.invalid ? props.invalidLabel : props.hint })] }));
}
/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
function SecretField(props) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: fields_styles_1.default.field, children: [(0, jsx_runtime_1.jsxs)("div", { className: fields_styles_1.default.head, children: [(0, jsx_runtime_1.jsx)("label", { className: fields_styles_1.default.label, htmlFor: props.id, children: props.label }), (0, jsx_runtime_1.jsx)("span", { className: fields_styles_1.default.badges, children: (0, jsx_runtime_1.jsx)("span", { className: props.configured ? fields_styles_1.default.badge : fields_styles_1.default.badgeMuted, children: props.stateLabel }) })] }), (0, jsx_runtime_1.jsx)("input", { id: props.id, className: fields_styles_1.default.input, type: "password", autoComplete: "off", value: props.text, disabled: props.disabled, onChange: (event) => { props.onEdit(event.target.value); } }), (0, jsx_runtime_1.jsx)("p", { className: fields_styles_1.default.hint, children: props.hint })] }));
}

},
"src/modules/settings-plugins/fields.styles.js": function(module, exports, require) {
// source: src/modules/settings-plugins/fields.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fields_css_1 = __importDefault(require("./fields.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-plugins/fields.module.css", "@xharness/dsh-client-ui-settings-plugins", fields_css_1.default);
const styles = {
    "badge": "vaLO0G_badge",
    "badgeMuted": "vaLO0G_badgeMuted",
    "badges": "vaLO0G_badges",
    "field": "vaLO0G_field",
    "head": "vaLO0G_head",
    "hint": "vaLO0G_hint",
    "input": "vaLO0G_input",
    "inputInvalid": "vaLO0G_inputInvalid",
    "invalid": "vaLO0G_invalid",
    "label": "vaLO0G_label",
    "reset": "vaLO0G_reset"
};
exports.default = styles;

},
"src/modules/settings-plugins/fields.css": function(module, exports, require) {
// source: src/modules/settings-plugins/fields.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".vaLO0G_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.vaLO0G_field+.vaLO0G_field{border-top:1px solid var(--dsw-alias-border-l2)}.vaLO0G_head{align-items:center;gap:8px;display:flex}.vaLO0G_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.vaLO0G_badges{align-items:center;gap:8px;display:inline-flex}.vaLO0G_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.vaLO0G_badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}.vaLO0G_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.vaLO0G_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.vaLO0G_reset:disabled{cursor:default}.vaLO0G_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.vaLO0G_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.vaLO0G_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.vaLO0G_inputInvalid{border-color:var(--dsw-alias-label-error);}.vaLO0G_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.vaLO0G_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}";

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
"src/modules/settings-plugins/PluginCard.js": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginCard.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginCard = PluginCard;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * One plugin's card: a header naming the plugin and what its settings govern,
 * disclosing that plugin's controls in place, with the save that writes them.
 *
 * The header is its own button rather than a shared disclosure row because a
 * card stacks its name over its description, while that row lays the two side
 * by side — the layout, not the behavior, is what differs. Disclosure is
 * card-local state: which card a user has open is a reading gesture, not
 * something the Host or the section has any stake in. Staged edits outlive
 * collapsing, so the header marks a card holding unsaved edits.
 *
 * A card renders nothing while its namespace is unavailable: a deployment that
 * does not compose the owning plugin should show no trace of it, rather than a
 * disabled card the user cannot act on.
 */
const react_1 = require("react");
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const PluginCard_styles_1 = __importDefault(require("./PluginCard.styles"));
/**
 * Render one plugin card.
 * @param props - the plugin's copy keys, its form state, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
function PluginCard(props) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const { state } = props;
    if (!state.available)
        return null;
    const title = props.t(props.titleKey);
    const blocked = !state.dirty || state.invalid || state.saving;
    return ((0, jsx_runtime_1.jsxs)("li", { className: (0, views_types_1.classNames)(PluginCard_styles_1.default.card, open && PluginCard_styles_1.default.cardOpen), children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: PluginCard_styles_1.default.header, "aria-expanded": open, "aria-label": `${props.t(open ? 'collapse' : 'expand')}: ${title}`, onClick: () => { setOpen(!open); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: PluginCard_styles_1.default.headText, children: [(0, jsx_runtime_1.jsx)("span", { className: PluginCard_styles_1.default.name, children: title }), (0, jsx_runtime_1.jsx)("span", { className: PluginCard_styles_1.default.description, children: props.t(props.descriptionKey) })] }), state.dirty ? (0, jsx_runtime_1.jsx)("span", { className: PluginCard_styles_1.default.pending, children: props.t('unsaved') }) : null, (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: (0, views_types_1.classNames)(PluginCard_styles_1.default.chevron, open && PluginCard_styles_1.default.chevronOpen) })] }), open
                ? ((0, jsx_runtime_1.jsxs)("div", { className: PluginCard_styles_1.default.body, children: [!state.writable ? (0, jsx_runtime_1.jsx)("p", { className: PluginCard_styles_1.default.readOnly, role: "status", children: props.t('readOnly') }) : null, props.children, (0, jsx_runtime_1.jsxs)("div", { className: PluginCard_styles_1.default.footer, children: [state.failed ? (0, jsx_runtime_1.jsx)("p", { className: PluginCard_styles_1.default.failed, role: "status", children: props.t('saveFailed') }) : null, (0, jsx_runtime_1.jsx)("button", { type: "button", className: PluginCard_styles_1.default.discard, disabled: !state.dirty || state.saving, onClick: props.onDiscard, children: props.t('discard') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: PluginCard_styles_1.default.save, disabled: blocked, onClick: props.onSave, children: props.t(state.saving ? 'saving' : 'save') })] })] }))
                : null] }));
}

},
"src/modules/settings-plugins/PluginCard.styles.js": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginCard.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PluginCard_css_1 = __importDefault(require("./PluginCard.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-plugins/PluginCard.module.css", "@xharness/dsh-client-ui-settings-plugins", PluginCard_css_1.default);
const styles = {
    "body": "QOwM_q_body",
    "card": "QOwM_q_card",
    "cardOpen": "QOwM_q_cardOpen",
    "chevron": "QOwM_q_chevron",
    "chevronOpen": "QOwM_q_chevronOpen",
    "description": "QOwM_q_description",
    "discard": "QOwM_q_discard",
    "failed": "QOwM_q_failed",
    "footer": "QOwM_q_footer",
    "headText": "QOwM_q_headText",
    "header": "QOwM_q_header",
    "name": "QOwM_q_name",
    "pending": "QOwM_q_pending",
    "readOnly": "QOwM_q_readOnly",
    "save": "QOwM_q_save"
};
exports.default = styles;

},
"src/modules/settings-plugins/PluginCard.css": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginCard.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".QOwM_q_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.QOwM_q_card:hover{border-color:var(--dsw-alias-label-dimmed)}.QOwM_q_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.QOwM_q_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.QOwM_q_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.QOwM_q_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.QOwM_q_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.QOwM_q_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.QOwM_q_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.QOwM_q_chevronOpen{transform:rotate(180deg)}.QOwM_q_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.QOwM_q_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.QOwM_q_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.QOwM_q_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.QOwM_q_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}.QOwM_q_discard,.QOwM_q_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.QOwM_q_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.QOwM_q_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.QOwM_q_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.QOwM_q_discard:disabled,.QOwM_q_save:disabled{opacity:.4;cursor:default}.QOwM_q_discard:focus-visible,.QOwM_q_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";

},
"src/modules/settings-plugins/BashCard.js": function(module, exports, require) {
// source: src/modules/settings-plugins/BashCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BashCard = BashCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const fields_1 = require("./fields");
const PluginCard_1 = require("./PluginCard");
/**
 * Render the shell card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
function BashCard(props) {
    const { t } = props;
    const state = props.useBashCard(snapshot => snapshot);
    const disabled = !state.writable;
    return ((0, jsx_runtime_1.jsxs)(PluginCard_1.PluginCard, { t: t, titleKey: "bashTitle", descriptionKey: "bashDescription", state: state, onSave: props.save, onDiscard: props.discard, children: [(0, jsx_runtime_1.jsx)(fields_1.ValueField, { id: "plugin-config-bash-timeout", label: t('bashTimeoutMs'), hint: t('bashTimeoutMsHint'), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), numeric: true, disabled: disabled, ...state.timeoutMs, onEdit: (text) => { props.edit('timeoutMs', text); }, onReset: () => { props.resetField('timeoutMs'); } }), (0, jsx_runtime_1.jsx)(fields_1.ValueField, { id: "plugin-config-bash-output", label: t('bashMaxOutputBytes'), hint: t('bashMaxOutputBytesHint'), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), numeric: true, disabled: disabled, ...state.maxOutputBytes, onEdit: (text) => { props.edit('maxOutputBytes', text); }, onReset: () => { props.resetField('maxOutputBytes'); } })] }));
}

},
"src/modules/settings-plugins/ConfigurablePluginsTab.js": function(module, exports, require) {
// source: src/modules/settings-plugins/ConfigurablePluginsTab.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigurablePluginsTab = ConfigurablePluginsTab;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch.
 */
const react_1 = require("react");
const PluginsSettingsSection_styles_1 = __importDefault(require("./PluginsSettingsSection.styles"));
/**
 * Render cards registered by plugins that expose editable settings.
 * @param props - locale copy, slot rendering, and the namespaces to dispatch.
 * @returns the card list, or the empty line once the Host has answered.
 */
function ConfigurablePluginsTab(props) {
    const { t, renderSlot } = props;
    const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot);
    if (namespaces.length > 0) {
        return ((0, jsx_runtime_1.jsx)("ul", { className: PluginsSettingsSection_styles_1.default.cards, children: namespaces.map(ns => (
            // One dispatch per namespace, so the list identity is the namespace
            // rather than a position that shifts as cards arrive.
            (0, jsx_runtime_1.jsx)(react_1.Fragment, { children: renderSlot('settings.plugin.item', {}, { entryKey: ns }) }, ns))) }));
    }
    return loaded ? (0, jsx_runtime_1.jsx)("p", { className: PluginsSettingsSection_styles_1.default.empty, children: t('empty') }) : null;
}

},
"src/modules/settings-plugins/PluginsSettingsSection.styles.js": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginsSettingsSection.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PluginsSettingsSection_css_1 = __importDefault(require("./PluginsSettingsSection.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-plugins/PluginsSettingsSection.module.css", "@xharness/dsh-client-ui-settings-plugins", PluginsSettingsSection_css_1.default);
const styles = {
    "cards": "_0lNWtG_cards",
    "empty": "_0lNWtG_empty",
    "heading": "_0lNWtG_heading",
    "intro": "_0lNWtG_intro",
    "panel": "_0lNWtG_panel",
    "section": "_0lNWtG_section",
    "tab": "_0lNWtG_tab",
    "tabs": "_0lNWtG_tabs"
};
exports.default = styles;

},
"src/modules/settings-plugins/PluginsSettingsSection.css": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginsSettingsSection.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._0lNWtG_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}._0lNWtG_heading{margin:0;font-size:18px;font-weight:600}._0lNWtG_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}._0lNWtG_tabs{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:22px;margin-top:2px;display:flex}._0lNWtG_tab{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}._0lNWtG_tab:hover,._0lNWtG_tab[data-active=true]{color:var(--dsw-alias-label-primary)}._0lNWtG_tab[data-active=true]:after,._0lNWtG_tab:focus-visible:after{background:var(--dsw-alias-label-primary);content:\"\";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}._0lNWtG_tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;color:var(--dsw-alias-label-primary);border-radius:2px}._0lNWtG_panel{min-width:0;padding-top:2px}._0lNWtG_cards{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}._0lNWtG_empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}";

},
"src/modules/settings-plugins/PluginsSettingsSection.js": function(module, exports, require) {
// source: src/modules/settings-plugins/PluginsSettingsSection.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginsSettingsSection = PluginsSettingsSection;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Plugins settings section: localized tabs around feature-owned pages. */
const react_1 = require("react");
const PluginsSettingsSection_styles_1 = __importDefault(require("./PluginsSettingsSection.styles"));
/** Render one Plugins page whose contents arrive from feature-owned tabs. */
function PluginsSettingsSection({ t, renderSlot, useTabs }) {
    const tabsId = (0, react_1.useId)();
    const tabRefs = (0, react_1.useRef)([]);
    const rows = useTabs(value => value);
    const [activeId, setActiveId] = (0, react_1.useState)();
    const [visitedIds, setVisitedIds] = (0, react_1.useState)(() => new Set());
    const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id;
    // A tab mounts only when first selected, then stays mounted while hidden so
    // local drafts, disclosure state, search, and the inventory snapshot survive
    // switching between the two views.
    (0, react_1.useEffect)(() => {
        if (active === undefined)
            return;
        setVisitedIds((previous) => {
            if (previous.has(active))
                return previous;
            return new Set([...previous, active]);
        });
    }, [active]);
    return ((0, jsx_runtime_1.jsxs)("div", { className: PluginsSettingsSection_styles_1.default.section, children: [(0, jsx_runtime_1.jsx)("h2", { className: PluginsSettingsSection_styles_1.default.heading, children: t('title') }), (0, jsx_runtime_1.jsx)("p", { className: PluginsSettingsSection_styles_1.default.intro, children: t('intro') }), rows.length === 0 ? (0, jsx_runtime_1.jsx)("p", { className: PluginsSettingsSection_styles_1.default.empty, children: t('empty') }) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: PluginsSettingsSection_styles_1.default.tabs, role: "tablist", "aria-label": t('tabs'), children: rows.map((row, index) => {
                            const selected = row.id === active;
                            return ((0, jsx_runtime_1.jsx)("button", { ref: (element) => { tabRefs.current[index] = element; }, id: `${tabsId}-tab-${row.id}`, type: "button", role: "tab", className: PluginsSettingsSection_styles_1.default.tab, "aria-selected": selected, "aria-controls": `${tabsId}-panel-${row.id}`, "data-active": selected ? 'true' : undefined, tabIndex: selected ? 0 : -1, onClick: () => { setActiveId(row.id); }, onKeyDown: (event) => {
                                    let nextIndex;
                                    switch (event.key) {
                                        case 'ArrowRight':
                                            nextIndex = (index + 1) % rows.length;
                                            break;
                                        case 'ArrowLeft':
                                            nextIndex = (index - 1 + rows.length) % rows.length;
                                            break;
                                        case 'Home':
                                            nextIndex = 0;
                                            break;
                                        case 'End':
                                            nextIndex = rows.length - 1;
                                            break;
                                        default: return;
                                    }
                                    event.preventDefault();
                                    const nextRow = rows[nextIndex];
                                    const nextTab = tabRefs.current[nextIndex];
                                    if (nextRow === undefined || nextTab == null)
                                        return;
                                    setActiveId(nextRow.id);
                                    nextTab.focus();
                                }, children: row.label }, row.id));
                        }) }), rows
                        .filter(row => row.id === active || visitedIds.has(row.id))
                        .map((row) => {
                        const selected = row.id === active;
                        return ((0, jsx_runtime_1.jsx)("div", { id: `${tabsId}-panel-${row.id}`, className: PluginsSettingsSection_styles_1.default.panel, role: "tabpanel", "aria-labelledby": `${tabsId}-tab-${row.id}`, hidden: !selected, children: renderSlot('settings.plugins.tab', {}, { only: row.id }) }, row.id));
                    })] }))] }));
}

},
"src/modules/settings-plugins/WebSearchCard.js": function(module, exports, require) {
// source: src/modules/settings-plugins/WebSearchCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSearchCard = WebSearchCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const fields_1 = require("./fields");
const PluginCard_1 = require("./PluginCard");
/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
function WebSearchCard(props) {
    const { t } = props;
    const state = props.useWebSearchCard(snapshot => snapshot);
    const disabled = !state.writable;
    return ((0, jsx_runtime_1.jsxs)(PluginCard_1.PluginCard, { t: t, titleKey: "webSearchTitle", descriptionKey: "webSearchDescription", state: state, onSave: props.save, onDiscard: props.discard, children: [(0, jsx_runtime_1.jsx)(fields_1.SecretField, { id: "plugin-config-web-search-key", label: t('webSearchApiKey'), hint: t('webSearchApiKeyHint'),
                // The credentials domain accepts a key even when the settings document
                // itself is read-only; they are separate stores with separate refusals.
                // Its own writability is what disables this control — a key sourced
                // from the process environment cannot be written from here.
                disabled: !state.apiKeyWritable, text: state.apiKey.text, configured: state.apiKeyConfigured, stateLabel: state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset'), onEdit: (text) => { props.edit('apiKey', text); } }), (0, jsx_runtime_1.jsx)(fields_1.ValueField, { id: "plugin-config-web-search-endpoint", label: t('webSearchBaseUrl'), hint: t('webSearchBaseUrlHint'), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), disabled: disabled, ...state.baseURL, onEdit: (text) => { props.edit('baseURL', text); }, onReset: () => { props.resetField('baseURL'); } }), (0, jsx_runtime_1.jsx)(fields_1.ValueField, { id: "plugin-config-web-search-max-uses", label: t('webSearchMaxUses'), hint: t('webSearchMaxUsesHint'), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), numeric: true, disabled: disabled, ...state.maxUses, onEdit: (text) => { props.edit('maxUses', text); }, onReset: () => { props.resetField('maxUses'); } })] }));
}

},
"src/modules/settings-plugins/agent-loop-card-controller.js": function(module, exports, require) {
// source: src/modules/settings-plugins/agent-loop-card-controller.ts

"use strict";
/** The agent-loop card's staged form over the `agent-loop` settings namespace. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentLoopCardController = exports.AGENT_LOOP_NS = void 0;
const card_form_1 = require("./card-form");
/**
 * Namespace of the agent loop's user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
exports.AGENT_LOOP_NS = 'agent-loop';
/** Bridges the `agent-loop` scope onto the card's staged form. */
class AgentLoopCardController {
    /** @param scope - the bound settings scope for the `agent-loop` namespace. */
    constructor(scope) {
        this.form = new card_form_1.CardForm(scope, [(0, card_form_1.numberField)('maxParallelToolCalls')]);
        this.store = this.form.bind(() => this.projection());
    }
    projection() {
        return { ...this.form.shell(), maxParallelToolCalls: this.form.field('maxParallelToolCalls') };
    }
    /**
     * Build the face the card's slot registration injects.
     * @returns the card's snapshot and its form actions.
     */
    inject() {
        return { hooks: { agentLoopCard: this.store }, ...this.form.actions() };
    }
}
exports.AgentLoopCardController = AgentLoopCardController;

},
"src/modules/settings-plugins/card-form.js": function(module, exports, require) {
// source: src/modules/settings-plugins/card-form.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardForm = void 0;
exports.numberField = numberField;
exports.textField = textField;
const runtime_types_1 = require("../shared/runtime-types");
const client_1 = require("@xharness/dsh-client-runtime/client");
/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function numberField(field) {
    return {
        field,
        // A section that carries no number for this field renders empty rather
        // than as a value nobody chose.
        format: value => typeof value === 'number' ? String(value) : '',
        parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === '')
                return { kind: 'clear' };
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
        },
    };
}
/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function textField(field) {
    return {
        field,
        format: value => typeof value === 'string' ? value : '',
        parse: (text) => {
            const trimmed = text.trim();
            return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
        },
    };
}
/**
 * Stages one card's edits over one settings namespace and writes them on save.
 *
 * The form publishes through a snapshot store because slot components read
 * through a snapshot selector, while both the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together.
 */
class CardForm {
    /**
     * @param scope - the bound settings scope for this card's namespace.
     * @param specs - the section fields this card edits.
     * @param secrets - the card's write-only controls, written outside the section.
     */
    constructor(scope, specs, secrets = []) {
        this.scope = scope;
        this.staged = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        this.specs = new Map(specs.map(spec => [spec.field, spec]));
        this.secretSpecs = new Map(secrets.map(spec => [spec.field, spec]));
        scope.subscribe(() => { this.publish(); });
    }
    /**
     * Publish a projection of this form, rebuilt whenever the scope or a draft changes.
     * @param project - build the card's state from the form's current reads.
     * @returns the store the card's component reads through its bound selector.
     */
    bind(project) {
        const store = (0, client_1.createSnapshotStore)(project());
        this.listeners.add(() => { store.set(project()); });
        return store;
    }
    /**
     * Read the card-level state: what the Host serves, and what a save would do.
     * @returns the form state every card shares.
     */
    shell() {
        const snapshot = this.scope.getSnapshot();
        const plan = this.plan();
        return {
            available: snapshot.status === 'ready',
            writable: snapshot.writable,
            dirty: plan.length > 0,
            invalid: plan.some(item => item.run === undefined),
            saving: this.saving,
            failed: this.failed,
        };
    }
    /**
     * Read one control's state.
     * @param field - field name of a section field or of a write-only control.
     * @returns the draft text, whether a save would leave an override, and whether it is invalid.
     */
    field(field) {
        const staged = this.staged.get(field);
        if (this.secretSpecs.has(field)) {
            return { text: staged?.text ?? '', overridden: false, invalid: false };
        }
        const spec = this.spec(field);
        if (staged === undefined) {
            return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false };
        }
        const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text);
        return {
            text: staged.text,
            overridden: write?.kind === 'set',
            invalid: write === undefined,
        };
    }
    /**
     * Build the edit, reset, save, and discard actions bound to this form.
     * @returns the actions a card's slot entry injects.
     */
    actions() {
        return {
            edit: (field, text) => { this.stage(field, { text, clear: false }); },
            resetField: (field) => {
                this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
            },
            save: () => { void this.save(); },
            discard: () => {
                if (this.staged.size === 0 && !this.failed)
                    return;
                this.staged.clear();
                this.failed = false;
                this.publish();
            },
        };
    }
    /**
     * Write every staged edit, then re-seed from what the Host accepted.
     *
     * The Host is the only authority on whether a value was accepted — its
     * validators own the constraints no schema can express — so the outcome is
     * read back from the section rather than predicted here. A save that did not
     * land keeps its drafts, so the user can correct them instead of retyping.
     * @returns settlement after every write and the read-back.
     */
    async save() {
        const plan = this.plan();
        const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run]);
        if (plan.length === 0 || this.saving || writes.length !== plan.length)
            return;
        this.saving = true;
        this.failed = false;
        this.publish();
        let landed = true;
        for (const write of writes) {
            landed = await write() && landed;
        }
        if (landed)
            this.staged.clear();
        this.saving = false;
        this.failed = !landed;
        this.publish();
    }
    /**
     * Every staged edit a save would write. An entry whose draft is not a value
     * its field accepts carries no write: the form is still dirty, and the save
     * refuses rather than dropping the edit.
     * @returns the planned writes, in the order the fields were staged.
     */
    plan() {
        const plan = [];
        for (const [field, staged] of this.staged) {
            const secret = this.secretSpecs.get(field);
            if (secret !== undefined) {
                const value = staged.text.trim();
                if (value !== '')
                    plan.push({ field, run: () => secret.write(value) });
                continue;
            }
            const spec = this.spec(field);
            if (staged.clear) {
                if (this.stored(field))
                    plan.push({ field, run: () => this.clear(field) });
                continue;
            }
            if (staged.text === spec.format(this.sectionValue(field)))
                continue;
            const write = spec.parse(staged.text);
            if (write === undefined)
                plan.push({ field, run: undefined });
            else if (write.kind === 'clear')
                plan.push({ field, run: () => this.clear(field) });
            else
                plan.push({ field, run: () => this.store(field, write.value) });
        }
        return plan;
    }
    async clear(field) {
        await this.scope.unset(field);
        return !this.stored(field);
    }
    async store(field, value) {
        await this.scope.set(field, value);
        return this.userLayer()?.[field] === value;
    }
    stage(field, edit) {
        this.staged.set(field, edit);
        this.failed = false;
        this.publish();
    }
    spec(field) {
        const spec = this.specs.get(field);
        // Every call site names a field this card declared; a missing one is a
        // wiring mistake that must not degrade into a silently inert control.
        if (spec === undefined)
            throw new Error(`plugin card has no field ${field}`);
        return spec;
    }
    snapshotOf() {
        return this.scope.getSnapshot();
    }
    sectionValue(field) {
        const section = this.snapshotOf().value;
        return (0, runtime_types_1.isObjectRecord)(section) ? section[field] : undefined;
    }
    baseValue(field) {
        const section = this.snapshotOf().base;
        return (0, runtime_types_1.isObjectRecord)(section) ? section[field] : undefined;
    }
    userLayer() {
        const user = this.snapshotOf().user;
        return (0, runtime_types_1.isObjectRecord)(user) ? user : undefined;
    }
    stored(field) {
        const user = this.userLayer();
        return user !== undefined && Object.prototype.hasOwnProperty.call(user, field);
    }
    publish() {
        for (const listener of this.listeners)
            listener();
    }
}
exports.CardForm = CardForm;

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
"src/modules/settings-plugins/bash-card-controller.js": function(module, exports, require) {
// source: src/modules/settings-plugins/bash-card-controller.ts

"use strict";
/** The shell card's staged form over the `bash` settings namespace. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BashCardController = exports.SHELL_NS = void 0;
const card_form_1 = require("./card-form");
/**
 * Namespace of the shell capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the executor families
 * that own it spell the same value.
 */
exports.SHELL_NS = 'shell';
/** Bridges the `bash` scope onto the shell card's staged form. */
class BashCardController {
    /** @param scope - the bound settings scope for the `bash` namespace. */
    constructor(scope) {
        this.form = new card_form_1.CardForm(scope, [(0, card_form_1.numberField)('timeoutMs'), (0, card_form_1.numberField)('maxOutputBytes')]);
        this.store = this.form.bind(() => this.projection());
    }
    projection() {
        return {
            ...this.form.shell(),
            timeoutMs: this.form.field('timeoutMs'),
            maxOutputBytes: this.form.field('maxOutputBytes'),
        };
    }
    /**
     * Build the face the card's slot registration injects.
     * @returns the card's snapshot and its form actions.
     */
    inject() {
        return { hooks: { bashCard: this.store }, ...this.form.actions() };
    }
}
exports.BashCardController = BashCardController;

},
"src/modules/settings-plugins/tab-store.js": function(module, exports, require) {
// source: src/modules/settings-plugins/tab-store.ts

"use strict";
/**
 * The configurable-plugins tab's card list.
 *
 * The tab dispatches its slot by settings namespace, so what it renders is
 * the intersection of two ledgers: the namespaces the Host serves and the
 * cards registered into `settings.plugin.item`. A served namespace no card
 * claims renders nothing — another surface owns it, or this deployment ships
 * no browser half for it — and a card whose namespace the Host does not serve
 * is never dispatched, so a plugin this deployment did not compose leaves no
 * trace and does not count toward the empty line.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigurablePluginsTabController = void 0;
const client_1 = require("@xharness/dsh-client-runtime/client");
/** Derives the served namespaces from the shared describe mirror and pairs them with the cards that claim them. */
class ConfigurablePluginsTabController {
    /**
     * @param describeFace - the shared mirror's describe face; its refreshes
     * (document commits, reconnects) are what keep the served set current.
     * @param entries - reads the cards currently registered into the section's slot.
     */
    constructor(describeFace, entries) {
        this.describeFace = describeFace;
        this.entries = entries;
        this.store = (0, client_1.createSnapshotStore)({ loaded: false, namespaces: [] });
        this.disposed = false;
        this.unsubscribe = describeFace.subscribe(() => { this.publish(); });
        void describeFace.ensure();
        this.publish();
    }
    /** Republish after the slot ledger changed; a card registered late joins here. */
    refresh() {
        if (this.disposed)
            return;
        this.publish();
    }
    /** Stop publishing and stop following the mirror. */
    dispose() {
        this.disposed = true;
        this.unsubscribe();
    }
    /**
     * Build the face the tab's slot registration injects.
     * @returns the tab's snapshot source.
     */
    inject() {
        return { hooks: { configurablePlugins: this.store } };
    }
    publish() {
        if (this.disposed)
            return;
        const mirrored = this.describeFace.getSnapshot();
        const loaded = mirrored.view !== undefined;
        const served = new Set(mirrored.view?.namespaces.map(view => view.ns) ?? []);
        const namespaces = this.entries().flatMap(entry => entry.options.key !== undefined && served.has(entry.options.key) ? [entry.options.key] : []);
        const previous = this.store.getSnapshot();
        // Every settings-document commit refreshes the mirror, and most commits
        // change nothing this section shows. An observable source must keep its
        // snapshot reference until the fact moves, or each unrelated save
        // re-renders the whole card list (packages/client/AGENTS.md reactive rule 5).
        if (previous.loaded === loaded
            && previous.namespaces.length === namespaces.length
            && previous.namespaces.every((ns, index) => ns === namespaces[index]))
            return;
        this.store.set({ loaded, namespaces });
    }
}
exports.ConfigurablePluginsTabController = ConfigurablePluginsTabController;

},
"src/modules/settings-plugins/web-search-card-controller.js": function(module, exports, require) {
// source: src/modules/settings-plugins/web-search-card-controller.ts

"use strict";
/**
 * The web-search card's staged form over the `web-search-deepseek` settings
 * namespace.
 *
 * The key is the one control that does not live in the section: its literal
 * never rides a response, so the card learns only whether one is configured
 * and writes it through the credentials domain, addressed by the reference the
 * section names. It is still staged with the rest of the form, so one save
 * covers everything the card shows.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSearchCardController = exports.WEB_SEARCH_NS = void 0;
const card_form_1 = require("./card-form");
/**
 * Namespace of the DeepSeek search provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
exports.WEB_SEARCH_NS = 'web-search-deepseek';
/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY';
/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey';
/** Bridges the `web-search-deepseek` scope and the credentials domain onto the card. */
class WebSearchCardController {
    /**
     * @param scope - the bound settings scope for the `web-search-deepseek` namespace.
     * @param api - wire face used for the credential the section references.
     */
    constructor(scope, api) {
        this.scope = scope;
        this.api = api;
        this.credential = { ref: '', configured: false, writable: true };
        this.form = new card_form_1.CardForm(scope, [(0, card_form_1.textField)('baseURL'), (0, card_form_1.numberField)('maxUses')], [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }]);
        this.store = this.form.bind(() => this.projection());
        scope.subscribe(() => { void this.readCredential(); });
        void this.readCredential();
    }
    projection() {
        return {
            ...this.form.shell(),
            baseURL: this.form.field('baseURL'),
            maxUses: this.form.field('maxUses'),
            apiKey: this.form.field(API_KEY_FIELD),
            apiKeyConfigured: this.credential.configured,
            apiKeyWritable: this.credential.writable,
        };
    }
    /**
     * Ask the credentials domain about the reference the section currently names.
     *
     * The answer is stored with the reference it describes: `apiKeyEnv` can
     * change between the request and its response, and two reads can settle out
     * of order, so a response is published only while it still answers for the
     * reference in force.
     */
    async readCredential() {
        const ref = refOf(this.scope.getSnapshot());
        if (ref !== this.credential.ref) {
            // A new reference knows nothing yet; keeping the old answer would claim
            // the key is configured under a name nobody has checked.
            this.credential = { ref, configured: false, writable: true };
            this.store.set(this.projection());
        }
        let response;
        try {
            response = await this.api.credentials.describe({ refs: [ref] });
        }
        catch (_credentialReadFailure) {
            // The card stays usable without this: the key control simply reports the
            // last state it knew, and a write still reaches the Host.
            return;
        }
        if (!response.result.ok || ref !== refOf(this.scope.getSnapshot()))
            return;
        const view = response.result.value.credentials[ref];
        const next = {
            ref,
            configured: view?.configured ?? false,
            // An unknown reference is treated as writable: the control stays usable
            // and the Host is what refuses, rather than the card guessing a refusal.
            writable: view?.writable ?? true,
        };
        if (next.configured === this.credential.configured && next.writable === this.credential.writable)
            return;
        this.credential = next;
        this.store.set(this.projection());
    }
    /**
     * Re-read after the Host reports a change to the reference this card watches.
     *
     * A key can be written from somewhere else — the Models page addresses the
     * same reference — and the settings section does not change when it is, so
     * without this the badge keeps reporting a state the Host already replaced.
     * @param ref - the reference the Host reports as changed.
     */
    refreshCredential(ref) {
        if (ref !== this.credential.ref)
            return;
        void this.readCredential();
    }
    /**
     * Build the face the card's slot registration injects.
     * @returns the card's snapshot and its form actions.
     */
    inject() {
        return { hooks: { webSearchCard: this.store }, ...this.form.actions() };
    }
    /**
     * Write the staged key, then re-read whether the Host now holds one.
     * @param value - the staged credential literal.
     * @returns whether the Host reports a configured credential afterwards.
     */
    async writeKey(value) {
        try {
            await this.api.credentials.set({ ref: refOf(this.scope.getSnapshot()), value });
        }
        catch (_credentialWriteFailure) {
            // Refusals surface through the re-read below: the Host is the only
            // authority on whether the key now exists.
        }
        await this.readCredential();
        return this.credential.configured;
    }
}
exports.WebSearchCardController = WebSearchCardController;
/**
 * The credential reference the section names, or the provider's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot) {
    const declared = snapshot.value?.apiKeyEnv;
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
}

},
"src/modules/settings-plugins/locales.js": function(module, exports, require) {
// source: src/modules/settings-plugins/locales.ts

"use strict";
/** Locale bundles for the plugin configuration section and its plugin cards. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = void 0;
/** English copy. */
exports.en = {
    nav: 'Plugins',
    title: 'Plugins',
    intro: 'Configure and inspect the plugins installed in this deployment.',
    tabs: 'Plugin views',
    configurableTab: 'Plugin configuration',
    empty: 'This deployment exposes no plugin settings.',
    overridden: 'Overridden',
    reset: 'Reset to default',
    readOnly: 'This deployment stores settings read-only.',
    expand: 'Show settings',
    collapse: 'Hide settings',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard',
    unsaved: 'Unsaved',
    saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    invalidNumber: 'Enter a number, or leave blank to use the default.',
    bashTitle: 'Shell',
    bashDescription: 'Limits every command the agent runs.',
    bashTimeoutMs: 'Command timeout (ms)',
    bashTimeoutMsHint: 'How long one command may run before it is terminated.',
    bashMaxOutputBytes: 'Output cap per stream (bytes)',
    bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
    agentLoopTitle: 'Agent loop',
    agentLoopDescription: 'How the agent dispatches tool calls.',
    agentLoopMaxParallel: 'Parallel tool calls',
    agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
    webSearchTitle: 'Web search',
    webSearchDescription: 'Provider used for web search.',
    webSearchApiKey: 'API key',
    webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
    webSearchApiKeySet: 'A key is configured.',
    webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
    webSearchBaseUrl: 'Endpoint',
    webSearchBaseUrlHint: 'Leave blank to use the provider default.',
    webSearchMaxUses: 'Max searches per request',
    webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
};
/** Simplified Chinese copy. */
exports.zh = {
    nav: '插件',
    title: '插件',
    intro: '配置和查看本部署已安装的插件。',
    tabs: '插件视图',
    configurableTab: '插件配置',
    empty: '本部署没有开放任何插件设置。',
    overridden: '已覆盖',
    reset: '恢复默认',
    readOnly: '本部署的设置为只读。',
    expand: '展开设置',
    collapse: '收起设置',
    save: '保存',
    saving: '保存中…',
    discard: '放弃修改',
    unsaved: '未保存',
    saveFailed: '本部署没有接受这些值，已保留供你修改。',
    invalidNumber: '请填数字；留空表示使用默认值。',
    bashTitle: '终端',
    bashDescription: '限制 agent 运行的每一条命令。',
    bashTimeoutMs: '命令超时（毫秒）',
    bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
    bashMaxOutputBytes: '单流输出上限（字节）',
    bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
    agentLoopTitle: 'Agent 循环',
    agentLoopDescription: 'Agent 如何派发工具调用。',
    agentLoopMaxParallel: '并行工具调用数',
    agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
    webSearchTitle: '网页搜索',
    webSearchDescription: '用于网页搜索的提供方。',
    webSearchApiKey: 'API Key',
    webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
    webSearchApiKeySet: '已配置密钥。',
    webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
    webSearchBaseUrl: '接口地址',
    webSearchBaseUrlHint: '留空则使用提供方默认地址。',
    webSearchMaxUses: '单次请求最多搜索次数',
    webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
};

}
};
const __dependencies = {"src/modules/settings-plugins/index.js":{"./AgentLoopCard":"src/modules/settings-plugins/AgentLoopCard.js","./BashCard":"src/modules/settings-plugins/BashCard.js","./ConfigurablePluginsTab":"src/modules/settings-plugins/ConfigurablePluginsTab.js","./PluginsSettingsSection":"src/modules/settings-plugins/PluginsSettingsSection.js","./WebSearchCard":"src/modules/settings-plugins/WebSearchCard.js","./agent-loop-card-controller":"src/modules/settings-plugins/agent-loop-card-controller.js","./bash-card-controller":"src/modules/settings-plugins/bash-card-controller.js","./tab-store":"src/modules/settings-plugins/tab-store.js","./web-search-card-controller":"src/modules/settings-plugins/web-search-card-controller.js","./locales":"src/modules/settings-plugins/locales.js"},"src/modules/settings-plugins/AgentLoopCard.js":{"./fields":"src/modules/settings-plugins/fields.js","./PluginCard":"src/modules/settings-plugins/PluginCard.js"},"src/modules/settings-plugins/fields.js":{"./fields.styles":"src/modules/settings-plugins/fields.styles.js"},"src/modules/settings-plugins/fields.styles.js":{"./fields.css":"src/modules/settings-plugins/fields.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-plugins/fields.css":{},"src/modules/views-types.js":{},"src/modules/settings-plugins/PluginCard.js":{"../views-types":"src/modules/views-types.js","./PluginCard.styles":"src/modules/settings-plugins/PluginCard.styles.js"},"src/modules/settings-plugins/PluginCard.styles.js":{"./PluginCard.css":"src/modules/settings-plugins/PluginCard.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-plugins/PluginCard.css":{},"src/modules/settings-plugins/BashCard.js":{"./fields":"src/modules/settings-plugins/fields.js","./PluginCard":"src/modules/settings-plugins/PluginCard.js"},"src/modules/settings-plugins/ConfigurablePluginsTab.js":{"./PluginsSettingsSection.styles":"src/modules/settings-plugins/PluginsSettingsSection.styles.js"},"src/modules/settings-plugins/PluginsSettingsSection.styles.js":{"./PluginsSettingsSection.css":"src/modules/settings-plugins/PluginsSettingsSection.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-plugins/PluginsSettingsSection.css":{},"src/modules/settings-plugins/PluginsSettingsSection.js":{"./PluginsSettingsSection.styles":"src/modules/settings-plugins/PluginsSettingsSection.styles.js"},"src/modules/settings-plugins/WebSearchCard.js":{"./fields":"src/modules/settings-plugins/fields.js","./PluginCard":"src/modules/settings-plugins/PluginCard.js"},"src/modules/settings-plugins/agent-loop-card-controller.js":{"./card-form":"src/modules/settings-plugins/card-form.js"},"src/modules/settings-plugins/card-form.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/settings-plugins/bash-card-controller.js":{"./card-form":"src/modules/settings-plugins/card-form.js"},"src/modules/settings-plugins/tab-store.js":{},"src/modules/settings-plugins/web-search-card-controller.js":{"./card-form":"src/modules/settings-plugins/card-form.js"},"src/modules/settings-plugins/locales.js":{}};
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
return __load("src/modules/settings-plugins/index.js");
}
});
