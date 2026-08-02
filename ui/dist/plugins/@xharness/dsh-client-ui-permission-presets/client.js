// Generated from src/modules/permission-presets/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-permission-presets",
factory: (__externalRequire) => {
const __units = {
"src/modules/permission-presets/index.js": function(module, exports, require) {
// source: src/modules/permission-presets/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const PermissionRow_1 = require("./PermissionRow");
const locales_1 = require("./locales");
const presentation_1 = require("./presentation");
const settings_store_1 = require("./settings-store");
/** Required services (cordis fiber inject). */
exports.inject = ['commandUi', 'sessions', 'slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema'];
const ACCESS_NS = 'permission.access';
/** Read one session's current permissions projection value (undefined = capability absent). */
function selectOf(session) {
    return session?.projections.faceOf('permissions').getSnapshot();
}
/** Flatten the projection select into popup rows; `custom` is display state, never a target. */
function optionsOf(value, t) {
    return value.options
        .filter(option => option.value !== 'custom')
        .map(option => ({
        id: option.value,
        label: (0, presentation_1.displayPermissionPreset)(option.value, option.name),
        ...(option.description !== undefined ? { detail: option.description } : {}),
        ...(option.value === value.currentValue ? { active: true } : {}),
        ...(option.value === presentation_1.FULL_ACCESS_PRESET
            ? {
                confirmation: {
                    title: t('confirm.title'),
                    description: t('confirm.description'),
                    acknowledgeLabel: t('confirm.acknowledge'),
                    cancelLabel: t('confirm.cancel'),
                    confirmLabel: t('confirm.enable'),
                },
            }
            : {}),
    }));
}
/**
 * Client plugin body: register the /permission popup picker over the
 * permissions projection.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const command = ctx.get('commandUi');
    const sessions = ctx.sessions;
    // This optional bundle and ui-conversation can load independently, so each
    // owns the same safety copy under its own locale namespace.
    /* jscpd:ignore-start */
    ctx.effect(() => {
        const disposers = [
            ctx.locale.register(ACCESS_NS, 'zh', {
                'confirm.title': locales_1.accessZh['confirm.title'],
                'confirm.description': locales_1.accessZh['confirm.description'],
                'confirm.acknowledge': locales_1.accessZh['confirm.acknowledge'],
                'confirm.cancel': locales_1.accessZh['confirm.cancel'],
                'confirm.enable': locales_1.accessZh['confirm.enable'],
            }),
            ctx.locale.register(ACCESS_NS, 'en', {
                'confirm.title': locales_1.accessEn['confirm.title'],
                'confirm.description': locales_1.accessEn['confirm.description'],
                'confirm.acknowledge': locales_1.accessEn['confirm.acknowledge'],
                'confirm.cancel': locales_1.accessEn['confirm.cancel'],
                'confirm.enable': locales_1.accessEn['confirm.enable'],
            }),
        ];
        return () => { for (const dispose of disposers)
            dispose(); };
    }, 'ui-permission: Full access confirmation dictionaries');
    /* jscpd:ignore-end */
    const t = ctx.locale.bind(ACCESS_NS);
    const sessionFor = (session) => sessions.binding(session.sessionId)?.session;
    ctx.effect(() => ctx.locale.register('settings.permission', { zh: locales_1.zh, en: locales_1.en }), 'ui-permission: settings row dictionaries');
    const connection = ctx.get('connection');
    // The row follows the shared describe mirror, whose owning plugin already
    // refreshes it on document commits and reconnects.
    const controller = new settings_store_1.PermissionPresetSettingsController(ctx.settingsScope.describe(), connection.api, ctx.settingsSchema);
    const load = () => controller.load();
    const select = (preset) => controller.select(preset);
    const injected = () => ({
        hooks: { permission: controller.store },
        load,
        select,
    });
    ctx.effect(() => () => { controller.dispose(); }, 'ui-permission: settings row directory');
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'permission',
        order: -20,
        locale: 'settings.permission',
        inject: injected,
    }, PermissionRow_1.PermissionRow));
    ctx.effect(() => command.decorate({
        name: 'permission',
        // The picker exists exactly while the projection does: a permission-less
        // host serves no key and the bare invocation falls through to the host
        // command (which is absent too — the line simply misses).
        available: session => selectOf(sessionFor(session)) !== undefined,
        ui: {
            kind: 'popupSelect',
            options: (session) => {
                const value = selectOf(sessionFor(session));
                if (value === undefined)
                    throw new Error('permission presets are not available on this host');
                return Promise.resolve(optionsOf(value, t));
            },
            onSelect: async (option, session) => {
                const live = sessionFor(session);
                if (live === undefined)
                    throw new Error('this session is not materialized yet');
                const result = await live.command(`/permission ${option.id}`);
                if (!result.ok)
                    throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`);
                if (!result.value.matched)
                    throw new Error('the host offers no /permission command');
            },
        },
    }), 'ui-permission: /permission decoration');
}

},
"src/modules/permission-presets/PermissionRow.js": function(module, exports, require) {
// source: src/modules/permission-presets/PermissionRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionRow = PermissionRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
/**
 * Permission preference row: the default preset for subsequently created
 * sessions. Current-session switches remain on the composer `/permission`
 * control.
 */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const presentation_1 = require("./presentation");
const PermissionRow_styles_1 = __importDefault(require("./PermissionRow.styles"));
/**
 * Render the new-session Permission default selector.
 * @param props - composed slot props.
 * @returns the row, or null when the host does not expose permission settings.
 */
function PermissionRow({ load, select, usePermission, t }) {
    const state = usePermission(snapshot => snapshot);
    const [open, setOpen] = (0, react_1.useState)(false);
    const [confirmingFullAccess, setConfirmingFullAccess] = (0, react_1.useState)(false);
    const [acknowledged, setAcknowledged] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        void load();
    }, [load]);
    (0, react_1.useEffect)(() => {
        if (state.writable && state.status !== 'unavailable')
            return;
        setOpen(false);
        setAcknowledged(false);
        setConfirmingFullAccess(false);
    }, [state.status, state.writable]);
    if (state.status === 'unavailable')
        return null;
    const selected = state.options.find(option => option.id === state.currentValue);
    const busy = state.status === 'loading' || state.status === 'saving' || confirmingFullAccess;
    const label = selected?.label
        ?? (busy ? t('loading') : t('unavailable'));
    const description = state.error ?? t('description');
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: PermissionRow_styles_1.default.row, children: [(0, jsx_runtime_1.jsxs)("div", { className: PermissionRow_styles_1.default.rowText, children: [(0, jsx_runtime_1.jsx)("div", { className: PermissionRow_styles_1.default.title, children: t('title') }), (0, jsx_runtime_1.jsx)("div", { className: PermissionRow_styles_1.default.desc, role: state.error === null ? undefined : 'alert', children: description })] }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: open, onClose: () => { setOpen(false); }, items: state.options.map(option => ({ id: option.id, label: option.label })), selectedId: state.currentValue, onSelect: (id) => {
                            setOpen(false);
                            if (id === state.currentValue)
                                return;
                            if (id === presentation_1.FULL_ACCESS_PRESET) {
                                setAcknowledged(false);
                                setConfirmingFullAccess(true);
                                return;
                            }
                            void select(id);
                        }, align: "end", portal: true, anchor: ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: PermissionRow_styles_1.default.selector, "aria-haspopup": "menu", "aria-expanded": open, disabled: busy || !state.writable || state.options.length === 0, onClick: () => { setOpen(value => !value); }, children: [label, (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: PermissionRow_styles_1.default.chevron })] })) })] }), (0, jsx_runtime_1.jsx)(primitives_1.RiskConfirmation, { open: confirmingFullAccess, title: t('confirm.title'), description: t('confirm.description'), acknowledgeLabel: t('confirm.acknowledge'), cancelLabel: t('confirm.cancel'), confirmLabel: t('confirm.enable'), acknowledged: acknowledged, disabled: !state.writable || state.status === 'saving', onAcknowledgedChange: setAcknowledged, onCancel: () => {
                    setAcknowledged(false);
                    setConfirmingFullAccess(false);
                }, onConfirm: () => {
                    setAcknowledged(false);
                    setConfirmingFullAccess(false);
                    void select(presentation_1.FULL_ACCESS_PRESET);
                } })] }));
}

},
"src/modules/permission-presets/primitives.js": function(module, exports, require) {
// source: src/modules/permission-presets/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskConfirmation = void 0;
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "RiskConfirmation", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.RiskConfirmation; } });

},
"src/modules/permission-presets/presentation.js": function(module, exports, require) {
// source: src/modules/permission-presets/presentation.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FULL_ACCESS_PRESET = void 0;
exports.displayPresetName = displayPresetName;
exports.displayPermissionPreset = displayPermissionPreset;
/** Machine value of the preset that requires an explicit GUI risk gate. */
exports.FULL_ACCESS_PRESET = 'danger-full-access';
/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
function displayPresetName(name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
        return name;
    return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @returns the Full access product label or the conventional display name.
 */
function displayPermissionPreset(value, name) {
    return value === exports.FULL_ACCESS_PRESET ? 'Full access' : value === 'workspace-write-ai-review' ? 'AI 代审' : displayPresetName(name);
}

},
"src/modules/permission-presets/PermissionRow.styles.js": function(module, exports, require) {
// source: src/modules/permission-presets/PermissionRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PermissionRow_css_1 = __importDefault(require("./PermissionRow.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-permission-presets/PermissionRow.module.css", "@xharness/dsh-client-ui-permission-presets", PermissionRow_css_1.default);
const styles = {
    "chevron": "iYmhEW_chevron",
    "desc": "iYmhEW_desc",
    "row": "iYmhEW_row",
    "rowText": "iYmhEW_rowText",
    "selector": "iYmhEW_selector",
    "title": "iYmhEW_title"
};
exports.default = styles;

},
"src/modules/permission-presets/PermissionRow.css": function(module, exports, require) {
// source: src/modules/permission-presets/PermissionRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".iYmhEW_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.iYmhEW_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.iYmhEW_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.iYmhEW_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.iYmhEW_selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.iYmhEW_selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.iYmhEW_selector:disabled{cursor:default}.iYmhEW_chevron{flex:none}";

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
"src/modules/permission-presets/locales.js": function(module, exports, require) {
// source: src/modules/permission-presets/locales.ts

"use strict";
/** `settings.permission` namespace dictionaries (the Permission row's copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessEn = exports.accessZh = exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'title': '权限',
    'description': '选择新会话的默认权限模式',
    'loading': '加载中',
    'unavailable': '不可用',
    'confirm.title': '确认启用 Full access？',
    'confirm.description': '启用 Full access 后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
    'confirm.acknowledge': '我已了解风险，并愿意继续',
    'confirm.cancel': '取消',
    'confirm.enable': '启用 Full access',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'title': 'Permission',
    'description': 'Choose the default permission mode for new sessions',
    'loading': 'Loading',
    'unavailable': 'Unavailable',
    'confirm.title': 'Enable Full access?',
    'confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
    'confirm.acknowledge': 'I understand the risks and want to continue',
    'confirm.cancel': 'Cancel',
    'confirm.enable': 'Enable Full access',
};
/** Simplified Chinese dictionary for the current-session popup gate. */
exports.accessZh = {
    'confirm.title': '确认启用 Full access？',
    'confirm.description': '启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
    'confirm.acknowledge': '我已了解风险，并愿意继续',
    'confirm.cancel': '取消',
    'confirm.enable': '启用 Full access',
};
/** English dictionary for the current-session popup gate. */
exports.accessEn = {
    'confirm.title': 'Enable Full access?',
    'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
    'confirm.acknowledge': 'I understand the risks and want to continue',
    'confirm.cancel': 'Cancel',
    'confirm.enable': 'Enable Full access',
};

},
"src/modules/permission-presets/settings-store.js": function(module, exports, require) {
// source: src/modules/permission-presets/settings-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionPresetSettingsController = exports.PERMISSION_SETTINGS_NS = void 0;
exports.permissionDefaultOf = permissionDefaultOf;
const runtime_types_1 = require("../shared/runtime-types");
const client_1 = require("@xharness/dsh-client-runtime/client");
const presentation_1 = require("./presentation");
/** Permission's settings namespace on the host wire. */
exports.PERMISSION_SETTINGS_NS = 'permission';
/**
 * Read the dynamic preset enum encoded by the host's `defaultPreset` schema.
 * @param view - permission namespace descriptor.
 * @param schema - settings schema operations.
 * @returns current value and selectable options.
 */
function permissionDefaultOf(view, schema) {
    const value = (0, runtime_types_1.isObjectRecord)(view.value) ? view.value.defaultPreset : undefined;
    if (typeof value !== 'string')
        throw new Error('permission settings has no defaultPreset value');
    const node = schema.nodeAtPath(schema.rehydrate(view.schema), ['defaultPreset']);
    if (node === undefined)
        throw new Error('permission settings schema has no defaultPreset field');
    const rawChoices = node.type === 'union'
        ? node.list ?? []
        : [node];
    const options = rawChoices.flatMap((candidate) => {
        const choice = candidate;
        if (choice.type !== 'const' || typeof choice.value !== 'string')
            return [];
        const described = choice.meta?.description;
        return [{
                id: choice.value,
                label: typeof described === 'string' && described.length > 0
                    ? (0, presentation_1.displayPermissionPreset)(choice.value, described)
                    : (0, presentation_1.displayPermissionPreset)(choice.value, choice.value),
            }];
    });
    if (options.length === 0 || !options.some(option => option.id === value)) {
        throw new Error('permission settings schema does not advertise its current preset');
    }
    return { currentValue: value, options };
}
/** Controller deriving the row from the shared mirror and writing the default through it. */
class PermissionPresetSettingsController {
    /**
     * @param describeFace - the shared mirror's read/fold face (descriptor and schema source).
     * @param api - settings wire face for the `defaultPreset` write.
     * @param schema - settings-owned schema operations.
     */
    constructor(describeFace, api, schema) {
        this.describeFace = describeFace;
        this.api = api;
        this.schema = schema;
        /** Row snapshot consumed through a bound selector hook. */
        this.store = (0, client_1.createSnapshotStore)({
            status: 'idle',
            error: null,
            writable: false,
            currentValue: '',
            options: [],
            revision: 0,
        });
        this.saving = false;
        this.disposed = false;
    }
    /**
     * Begin following the mirror (idempotent) and reflect its current answer.
     * @returns settlement once the snapshot reflects the mirror.
     */
    async load() {
        if (this.disposed)
            return;
        this.following ?? (this.following = this.describeFace.subscribe(() => { this.derive(); }));
        this.store.update((state) => {
            state.status = 'loading';
            state.error = null;
        });
        await this.describeFace.ensure();
        this.derive();
    }
    /**
     * Persist one preset as the default for subsequently created sessions.
     * A selection made while one is already saving is ignored — the row's
     * control is disabled during the save, so this only drops programmatic
     * double-submits rather than user intent.
     * @param preset - advertised preset key.
     * @returns nothing; {@link store} carries success or failure.
     */
    async select(preset) {
        const state = this.store.getSnapshot();
        const view = this.describeFace.getSnapshot().view?.namespaces
            .find(entry => entry.ns === exports.PERMISSION_SETTINGS_NS);
        if (view === undefined || !state.writable || this.saving)
            return;
        this.saving = true;
        this.store.update((draft) => {
            draft.status = 'saving';
            draft.error = null;
        });
        try {
            const response = await this.api.settings.mutate({
                ns: exports.PERMISSION_SETTINGS_NS,
                ops: [{ op: 'set', path: ['defaultPreset'], value: preset }],
                expectedRevision: view.revision,
            });
            if (!response.result.ok)
                throw new Error(response.result.error.message);
            this.saving = false;
            if (this.disposed)
                return;
            // The mirror publish reaches this row's own subscription, so the fold
            // is also what republishes the accepted value here.
            this.describeFace.acceptView(response.result.value);
        }
        catch (error) {
            this.saving = false;
            if (this.disposed)
                return;
            this.fail(error);
        }
    }
    /** Stop following the mirror; later publishes leave the snapshot alone. */
    dispose() {
        this.disposed = true;
        this.following?.();
        this.following = undefined;
    }
    derive() {
        if (this.disposed || this.saving)
            return;
        const mirrored = this.describeFace.getSnapshot();
        if (mirrored.status === 'unavailable') {
            // The terminal non-loopback state: settings RPCs are loopback-only, so
            // the row hides itself exactly like an unserved namespace.
            this.store.update((state) => {
                state.status = 'unavailable';
                state.writable = false;
                state.currentValue = '';
                state.options = [];
            });
            return;
        }
        if (mirrored.view === undefined) {
            // A held failure with no answer is a failed row; without one the read
            // is still in flight and the row keeps its loading state.
            if (mirrored.error !== null)
                this.fail(new Error(mirrored.error));
            return;
        }
        const view = mirrored.view.namespaces.find(entry => entry.ns === exports.PERMISSION_SETTINGS_NS);
        if (view === undefined) {
            this.store.update((state) => {
                state.status = 'unavailable';
                state.writable = false;
                state.currentValue = '';
                state.options = [];
            });
            return;
        }
        try {
            const resolved = permissionDefaultOf(view, this.schema);
            const { writable } = mirrored.view;
            this.store.update((state) => {
                state.status = 'ready';
                state.error = null;
                state.writable = writable;
                state.currentValue = resolved.currentValue;
                state.options = resolved.options;
                state.revision = view.revision;
            });
        }
        catch (error) {
            this.fail(error);
        }
    }
    fail(error) {
        this.store.update((state) => {
            state.status = 'error';
            state.error = error instanceof Error ? error.message : String(error);
        });
    }
}
exports.PermissionPresetSettingsController = PermissionPresetSettingsController;

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

}
};
const __dependencies = {"src/modules/permission-presets/index.js":{"./PermissionRow":"src/modules/permission-presets/PermissionRow.js","./locales":"src/modules/permission-presets/locales.js","./presentation":"src/modules/permission-presets/presentation.js","./settings-store":"src/modules/permission-presets/settings-store.js"},"src/modules/permission-presets/PermissionRow.js":{"./primitives":"src/modules/permission-presets/primitives.js","./presentation":"src/modules/permission-presets/presentation.js","./PermissionRow.styles":"src/modules/permission-presets/PermissionRow.styles.js"},"src/modules/permission-presets/primitives.js":{},"src/modules/permission-presets/presentation.js":{},"src/modules/permission-presets/PermissionRow.styles.js":{"./PermissionRow.css":"src/modules/permission-presets/PermissionRow.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/permission-presets/PermissionRow.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/permission-presets/locales.js":{},"src/modules/permission-presets/settings-store.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./presentation":"src/modules/permission-presets/presentation.js"},"src/modules/shared/runtime-types.js":{}};
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
return __load("src/modules/permission-presets/index.js");
}
});
