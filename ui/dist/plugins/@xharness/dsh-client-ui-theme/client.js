// Generated from src/modules/theme/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-theme",
factory: (__externalRequire) => {
const __units = {
"src/modules/theme/index.js": function(module, exports, require) {
// source: src/modules/theme/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.ThemeRuntime = exports.SETTINGS_NS = void 0;
exports.apply = apply;
/**
 * Browser theme registry over the `--dsw-*` token stylesheets. The service
 * owns the live theme preference (light/dark/system), resolves `system` through
 * `prefers-color-scheme`, and publishes immutable snapshots; it never touches
 * the DOM — ui-layout's presenter consumes the resolved snapshot. The Host
 * settings scope loads and stores the preference in the user-settings
 * document. The plugin also registers the Appearance preference row into the
 * settings General section — the theme feature owns its own settings surface.
 */
const runtime_types_1 = require("../shared/runtime-types");
const AppearanceRow_1 = require("./AppearanceRow");
const settings_store_1 = require("./settings-store");
const styles_1 = require("./styles");
const locales_1 = require("./locales");
const theme_settings_1 = require("./theme-settings");
/** Namespace owning this feature's settings-row copy. */
exports.SETTINGS_NS = 'settings.theme';
const BUILTIN_THEMES = Object.freeze([
    Object.freeze({ id: 'light', colorScheme: 'light', tokens: Object.freeze({}) }),
    Object.freeze({ id: 'dark', colorScheme: 'dark', tokens: Object.freeze({}) }),
]);
const BUILTIN_INSPECT_TOKENS = Object.freeze([
    { name: '--dsw-alias-bg-base', description: 'Application base background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-base' },
    { name: '--dsw-alias-bg-layer-1', description: 'Primary raised surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-1' },
    { name: '--dsw-alias-bg-layer-2', description: 'Secondary nested surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-2' },
    { name: '--dsw-alias-bg-overlay', description: 'Overlay and popover background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-overlay' },
    { name: '--dsw-alias-border-l1', description: 'Primary subtle border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l1' },
    { name: '--dsw-alias-border-l2', description: 'Secondary stronger border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l2' },
    { name: '--dsw-alias-brand-primary', description: 'Primary brand accent.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-brand-primary' },
    { name: '--dsw-alias-label-primary', description: 'Primary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-primary' },
    { name: '--dsw-alias-label-secondary', description: 'Secondary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-secondary' },
    { name: '--dsw-alias-state-error-primary', description: 'Primary error state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-error-primary' },
    { name: '--dsw-alias-state-success-primary', description: 'Primary success state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-success-primary' },
    { name: '--dsw-alias-state-warn-primary', description: 'Primary warning state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-warn-primary' },
    { name: '--dsw-specific-sidebar-fill', description: 'Sidebar column and title-row background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-specific-sidebar-fill' },
]);
/**
 * Theme registry and preference owner. `light`/`dark` are built in (the base
 * stylesheets carry both palettes); third-party themes register alias-layer
 * overrides. Reads go through {@link getTheme}; preference writes only
 * through {@link setTheme}; continuous sync only through the `theme/change`
 * event. {@link overrideTokens} stacks partial token layers over the active
 * theme without touching the registry.
 * The service holds the `prefers-color-scheme` media query (environment
 * sensing, not presentation) and re-emits when the OS scheme flips while the
 * preference is `system`.
 */
class ThemeRuntime {
    /**
     * @param ctx - owning context (change events are emitted on it; the
     * media-query and scope listeners are released through ctx.effect on dispose).
     * @param host - durable preference scope owned by the same plugin.
     */
    constructor(ctx, host) {
        this.themes = [...BUILTIN_THEMES];
        this.revision = 0;
        /** Override layers by source; seq (monotonic) is the stacking order. */
        this.overrides = new Map();
        this.overrideSeq = 0;
        this.ctx = ctx;
        this.host = host;
        this.preference = theme_settings_1.DEFAULT_PREFERENCE;
        // Non-browser runs (node e2e booting the client tree) have no matchMedia.
        this.media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');
        this.snapshot = this.buildSnapshot();
        if (this.media !== undefined) {
            const media = this.media;
            const onChange = () => {
                if (this.preference !== 'system')
                    return;
                this.publish();
            };
            ctx.effect(() => {
                media.addEventListener('change', onChange);
                return () => { media.removeEventListener('change', onChange); };
            }, 'ui-theme: prefers-color-scheme listener');
        }
        ctx.effect(() => host.subscribe(() => { this.adopt(); }), 'ui-theme: settings scope adoption');
        this.adopt();
    }
    /**
     * Read the current immutable theme snapshot.
     * @returns the current snapshot (stable reference until the next change).
     */
    getTheme() {
        return this.snapshot;
    }
    /**
     * Export the current token directory without reading DOM or computed styles.
     * @returns stable JSON-safe token descriptions, including registered and override-only names.
     */
    exportInspectTokens() {
        const tokens = new Map(BUILTIN_INSPECT_TOKENS.map(token => [token.name, token]));
        for (const theme of this.themes) {
            for (const name of Object.keys(theme.tokens)) {
                if (!tokens.has(name))
                    tokens.set(name, dynamicToken(name));
            }
        }
        for (const layer of this.overrides.values()) {
            for (const name of Object.keys(layer.tokens)) {
                if (!tokens.has(name))
                    tokens.set(name, dynamicToken(name));
            }
        }
        return [...tokens.values()].map(token => ({ ...token })).sort((left, right) => left.name.localeCompare(right.name));
    }
    /**
     * Switch the theme preference — the only user preference write entry.
     * Built-in preferences are written through the settings scope and every
     * accepted value emits `theme/change`.
     * @param id - a registered theme id or `system`; unknown ids throw.
     */
    setTheme(id) {
        if (id !== 'system' && !this.themes.some(t => t.id === id)) {
            throw new Error(`theme "${id}" is not registered`);
        }
        if (this.preference === id)
            return;
        this.preference = id;
        if ((0, theme_settings_1.isThemePreference)(id))
            void this.host.set(theme_settings_1.THEME_PREFERENCE_FIELD, id);
        this.publish();
    }
    /** Adopt the scope's accepted durable preference without writing it back. */
    adopt() {
        const section = this.host.getSnapshot().value;
        if (section === undefined || this.preference === section.preference)
            return;
        this.preference = section.preference;
        this.publish();
    }
    /**
     * Register a theme. Duplicate id throws (single occupant per id; the
     * built-in pair counts; `system` is a preference, not a registrable id).
     * @param definition - theme id, colorScheme, and alias-token overrides.
     * @returns disposer. Disposing the theme backing the active preference
     * resets the preference to the default so the UI never keeps tokens of an
     * unregistered theme.
     */
    register(definition) {
        if (definition.id === 'system')
            throw new Error('"system" is a preference, not a registrable theme id');
        if (this.themes.some(t => t.id === definition.id)) {
            throw new Error(`theme "${definition.id}" is already registered`);
        }
        this.themes = [...this.themes, definition];
        this.publish();
        return () => {
            if (!this.themes.some(t => t.id === definition.id))
                return;
            this.themes = this.themes.filter(t => t.id !== definition.id);
            if (this.preference === definition.id) {
                this.preference = theme_settings_1.DEFAULT_PREFERENCE;
            }
            this.publish();
        };
    }
    /**
     * Stack a token override layer on top of the active theme — the token-level
     * analogue of slot shading: the base theme stays untouched, layers compose
     * in seq order with later layers winning per-token, and removing a layer
     * restores whatever it covered. Calling again with the same source replaces
     * that source's whole layer and restacks it on top (effect re-registration
     * semantics). Emits `theme/change` with the recomposed snapshot.
     * @param source - layer identity; one layer per source (dynamic packages
     * pass their package id — the façade pins it, so it also names the layer's
     * origin for inspection).
     * @param tokens - token-name → `{ light, dark }` value pairs. Validated at
     * runtime (model-authored callers reach this boundary with untyped JS);
     * a bare string value throws a teaching error.
     * @returns disposer removing exactly the layer this call created; a no-op
     * once the source has re-overridden (the newer layer is not torn down).
     */
    overrideTokens(source, tokens) {
        const layer = { seq: this.overrideSeq++, tokens: validateOverrides(source, tokens) };
        this.overrides.set(source, layer);
        this.publish();
        return () => {
            if (this.overrides.get(source) !== layer)
                return;
            this.overrides.delete(source);
            this.publish();
        };
    }
    buildSnapshot() {
        const resolvedId = this.preference === 'system'
            ? (this.media?.matches === true ? 'dark' : 'light')
            : this.preference;
        // Both built-ins always exist; a registered preference id resolves or has
        // been reset by its disposer, so the lookup cannot miss.
        const active = this.themes.find(t => t.id === resolvedId);
        /* v8 ignore next 2 -- needs a registry without light/dark, which register()/dispose() cannot produce */
        if (active === undefined)
            throw new Error(`theme registry lost "${resolvedId}"`);
        return Object.freeze({
            preference: this.preference,
            active: this.composeActive(active),
            themes: Object.freeze([...this.themes]),
            revision: this.revision,
        });
    }
    /**
     * Fold the override layers into the active definition: seq order, later
     * layers win per-token, each value picked for the active color scheme (the
     * presenter consumes the composed snapshot and needs no override awareness).
     * Without layers the registered definition passes through by identity.
     */
    composeActive(active) {
        if (this.overrides.size === 0)
            return active;
        const tokens = { ...active.tokens };
        for (const layer of [...this.overrides.values()].sort((a, b) => a.seq - b.seq)) {
            for (const [name, modes] of Object.entries(layer.tokens)) {
                tokens[name] = modes[active.colorScheme];
            }
        }
        return Object.freeze({ ...active, tokens: Object.freeze(tokens) });
    }
    publish() {
        this.revision += 1;
        this.snapshot = this.buildSnapshot();
        this.ctx.emit('theme/change', this.snapshot);
    }
}
exports.ThemeRuntime = ThemeRuntime;
/**
 * Runtime shape check for one override layer (model-authored callers pass
 * untyped JS through the dynamic-package façade, so the static type cannot
 * enforce the pair shape there). Returns a defensive per-token copy so later
 * caller mutation cannot reach the stored layer.
 */
function validateOverrides(source, tokens) {
    const validated = {};
    for (const [name, value] of Object.entries(tokens)) {
        if (typeof value === 'string') {
            throw new TypeError(`theme override "${name}" from "${source}" is a bare string — pass { light: ${JSON.stringify(value)}, dark: ${JSON.stringify(value)} } `
                + '(repeat the value when it is the same in both palettes); a single value goes illegible when the user switches color scheme');
        }
        if (typeof value !== 'object' || value === null
            || !('light' in value) || typeof value.light !== 'string'
            || !('dark' in value) || typeof value.dark !== 'string') {
            throw new TypeError(`theme override "${name}" from "${source}" must map to a { light, dark } pair of strings — one value per color scheme`);
        }
        validated[name] = { light: value.light, dark: value.dark };
    }
    return validated;
}
function dynamicToken(name) {
    return {
        name,
        description: 'Theme token registered by the current Client composition.',
        valueType: 'CSS value',
        requiresLightAndDark: true,
        ...(name.startsWith('--') ? { cssVariable: name } : {}),
    };
}
/**
 * Required services: settings transport plus slots/locale for the Appearance
 * row. `remote` carries the forwarded settings invalidation that
 * `ctx.settingsScope.bind(spec)` subscribes to on this context.
 */
exports.inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];
/**
 * Client plugin body: provide the theme service and register the
 * feature-owned Appearance preference row into the General section's item
 * slot (a feature owns its settings surface).
 * @param ctx - client cordis context.
 */
function apply(ctx) {
    (0, styles_1.installThemeStyles)(ctx);
    const host = ctx.settingsScope.bind({ namespace: theme_settings_1.THEME_SETTINGS_NAMESPACE,
        decode: section => (0, runtime_types_1.isObjectRecord)(section) && (0, theme_settings_1.isThemePreference)(section.preference) ? { preference: section.preference } : undefined,
    });
    const theme = new ThemeRuntime(ctx, host);
    ctx.provide('theme', theme);
    ctx.effect(() => ctx.locale.register(exports.SETTINGS_NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-theme: settings row dictionaries');
    const store = (0, settings_store_1.createAppearanceRowStore)();
    let bound;
    const sync = (snapshot) => {
        bound?.sync(snapshot.preference, snapshot.revision);
    };
    ctx.on('theme/change', sync);
    const injected = (actions) => {
        bound = actions;
        // Re-sync from the getter so no event is lost between registration and
        // first render (the store's revision guard drops stale duplicates).
        sync(theme.getTheme());
        return {
            setTheme: (id) => { theme.setTheme(id); },
        };
    };
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'appearance',
        order: 10,
        store,
        locale: exports.SETTINGS_NS,
        inject: injected,
    }, AppearanceRow_1.AppearanceRow));
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
"src/modules/theme/AppearanceRow.js": function(module, exports, require) {
// source: src/modules/theme/AppearanceRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppearanceRow = AppearanceRow;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Appearance preference row registered into the General section item slot
 * (figma 501:30012 'Frame 2117131228'): title + three preference cubes.
 * Registered by this package — the theme feature owns its own settings
 * surface. Selection follows the persisted preference, never the resolved
 * active theme.
 */
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const AppearanceRow_styles_1 = __importDefault(require("./AppearanceRow.styles"));
/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES = [
    { id: 'light', labelKey: 'appearance.light', Icon: dsh_client_ui_primitives_1.IconLightOutline16 },
    { id: 'dark', labelKey: 'appearance.dark', Icon: dsh_client_ui_primitives_1.IconDarkOutline16 },
    { id: 'system', labelKey: 'appearance.system', Icon: dsh_client_ui_primitives_1.IconFollowsystemOutline16 },
];
/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
function AppearanceRow({ t, setTheme, useStore }) {
    const preference = useStore(s => s.preference);
    return ((0, jsx_runtime_1.jsxs)("div", { className: AppearanceRow_styles_1.default.group, children: [(0, jsx_runtime_1.jsx)("div", { className: AppearanceRow_styles_1.default.title, children: t('appearance.title') }), (0, jsx_runtime_1.jsx)("div", { className: AppearanceRow_styles_1.default.cubeRow, children: CUBES.map(({ id, labelKey, Icon }) => ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, views_types_1.classNames)(AppearanceRow_styles_1.default.themeCube, preference === id && AppearanceRow_styles_1.default.selected), "aria-pressed": preference === id, onClick: () => { setTheme(id); }, children: [(0, jsx_runtime_1.jsx)(Icon, {}), t(labelKey)] }, id))) })] }));
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
"src/modules/theme/AppearanceRow.styles.js": function(module, exports, require) {
// source: src/modules/theme/AppearanceRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AppearanceRow_css_1 = __importDefault(require("./AppearanceRow.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-theme/AppearanceRow.module.css", "@xharness/dsh-client-ui-theme", AppearanceRow_css_1.default);
const styles = {
    "cubeRow": "GDmieW_cubeRow",
    "group": "GDmieW_group",
    "selected": "GDmieW_selected",
    "themeCube": "GDmieW_themeCube",
    "title": "GDmieW_title"
};
exports.default = styles;

},
"src/modules/theme/AppearanceRow.css": function(module, exports, require) {
// source: src/modules/theme/AppearanceRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".GDmieW_group{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}.GDmieW_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.GDmieW_cubeRow{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}.GDmieW_themeCube{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:16px;flex-direction:column;flex:180px;justify-content:center;align-items:center;gap:4px;padding:20px 32px;font-size:14px;line-height:22px;display:flex}.GDmieW_themeCube:hover:not(.GDmieW_selected){background:var(--dsw-alias-interactive-bg-hover)}.GDmieW_selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}\n";

},
"src/modules/theme/settings-store.js": function(module, exports, require) {
// source: src/modules/theme/settings-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAppearanceRowStore = createAppearanceRowStore;
/**
 * Appearance row slot store: a mirror of the theme service snapshot. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
const client_1 = require("@xharness/dsh-client-runtime/client");
/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
function createAppearanceRowStore() {
    return (0, client_1.defineStore)({
        bake: (bind, actions) => ({ sync: bind(actions.sync) }),
        init: () => ({ preference: 'system', revision: -1 }),
        actions: {
            sync: (d, preference, revision) => {
                if (revision <= d.revision)
                    return;
                d.preference = preference;
                d.revision = revision;
            },
        },
    });
}

},
"src/modules/theme/styles.js": function(module, exports, require) {
// source: src/modules/theme/styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.installThemeStyles = installThemeStyles;
const base_css_1 = __importDefault(require("./base.css"));
const design_platform_css_1 = __importDefault(require("./design-platform.css"));
const scrollbar_css_1 = __importDefault(require("./scrollbar.css"));
const gradient_shadow_text_css_1 = __importDefault(require("./gradient-shadow-text.css"));
const shiki_css_1 = __importDefault(require("./shiki.css"));
const PLUGIN_ID = '@xharness/dsh-client-ui-theme';
const STYLES = [
    ['base.css', base_css_1.default],
    ['design-platform.css', design_platform_css_1.default],
    ['scrollbar.css', scrollbar_css_1.default],
    ['gradient-shadow-text.css', gradient_shadow_text_css_1.default],
    ['shiki.css', shiki_css_1.default],
];
/**
 * Mount the global theme sheets for exactly the owning plugin lifetime.
 * @param ctx - Owning plugin context.
 */
function installThemeStyles(ctx) {
    if (typeof document === 'undefined')
        return;
    for (const [name, css] of STYLES) {
        ctx.effect(() => {
            const tag = document.createElement('style');
            tag.dataset.plugin = PLUGIN_ID;
            tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`;
            tag.textContent = css;
            document.head.appendChild(tag);
            return () => { tag.remove(); };
        }, `ui-theme: ${name} stylesheet`);
    }
}

},
"src/modules/theme/base.css": function(module, exports, require) {
// source: src/modules/theme/base.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ":root{--dsw-font-family:-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif;--ds-font-family-code:\"SF Mono\", \"JetBrains Mono\", \"Fira Code\", Consolas, \"Liberation Mono\", Menlo, Courier, \"PingFang SC\", \"Microsoft YaHei\";--ds-ease-in-out:cubic-bezier(.4, 0, .2, 1);--ds-transition-duration:.2s;--ds-transition-duration-fast:.1s;--ds-transition-duration-slow:.3s}\n";

},
"src/modules/theme/design-platform.css": function(module, exports, require) {
// source: src/modules/theme/design-platform.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "body{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#679efe;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f5f6f7;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-900:#570c0c}body[data-ds-dark-theme]{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#679efe;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-900:#570c0c}body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-mask-1:#0000003d;--dsw-alias-bg-mask-2:#0000001f;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#ffffffb3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-150);--dsw-alias-bg-skeleton:#0000000a;--dsw-alias-border-inverted2:#0000;--dsw-alias-border-inverted:#0000;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2-darkmode-thin:#0000001a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-primary-new-colorprimary-new-color:#4176e6;--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-1000);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-75);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-500);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-150);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-500);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-400);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#2631481a;--dsw-alias-interactive-bg-hover-accent:#26314824;--dsw-alias-interactive-bg-hover-danger:#ec13130d;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-75);--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-100);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-00);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-75);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-bluish-100);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-60);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-75);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-300);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-300);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-500);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-state-error-primary:var(--dsw-static-red-600);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-100);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-100);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-800);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-850);--dsw-specific-bubble-highlight:var(--dsw-static-deepseek-200);--dsw-specific-bubble:var(--dsw-static-deepseek-50);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-00);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-50);--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-specific-selector:var(--dsw-static-neutral-bluish-60);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-50);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-deepseek-100);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-100);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-75);--dsw-specific-tip:var(--dsw-static-neutral-bluish-60)}body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble-highlight:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble:var(--dsw-static-neutral-bluish-850);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-900);--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-specific-selector:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-900);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-750);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-850);--dsw-specific-tip:var(--dsw-static-neutral-bluish-800)}\n";

},
"src/modules/theme/scrollbar.css": function(module, exports, require) {
// source: src/modules/theme/scrollbar.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "body{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l1);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l1);--dsh-scrollbar-width:8px}@supports not selector(::-webkit-scrollbar){body,body *{scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb) transparent}}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:0 0}::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover)}::-webkit-scrollbar-corner{background:0 0}\n";

},
"src/modules/theme/gradient-shadow-text.css": function(module, exports, require) {
// source: src/modules/theme/gradient-shadow-text.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "body{--dsw-linear-gradient-think:linear-gradient(180deg, #fff 20.19%, #fff0 100%);--dsw-linear-think-select:linear-gradient(180deg, #f5f6f7 20.19%, #f5f6f700 100%);--dsw-shadow-lv1:0 2px 4px 0 #0000000d;--dsw-shadow-lv1-blur:0 4px 12px 0 #00000005;--dsw-shadow-lv2:0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a;--dsw-shadow-lv3:0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014;--dsw-mask-blur:blur(2px)}body[data-ds-dark-theme]{--dsw-linear-gradient-think:linear-gradient(180deg, #151517 20.19%, #15151700 100%);--dsw-linear-think-select:linear-gradient(180deg, #232325 20.19%, #23232500 100%)}body{--dsw-font-markdown-h1:700 24px/34px var(--dsw-font-family);--dsw-font-markdown-h1-font-family:var(--dsw-font-family);--dsw-font-markdown-h1-font-weight:700;--dsw-font-markdown-h1-line-height:34px;--dsw-font-markdown-h1-font-size:24px;--dsw-font-markdown-h1-font-style:normal;--dsw-font-markdown-h2:700 22px/32px var(--dsw-font-family);--dsw-font-markdown-h2-font-family:var(--dsw-font-family);--dsw-font-markdown-h2-font-weight:700;--dsw-font-markdown-h2-line-height:32px;--dsw-font-markdown-h2-font-size:22px;--dsw-font-markdown-h2-font-style:normal;--dsw-font-markdown-h3:700 20px/30px var(--dsw-font-family);--dsw-font-markdown-h3-font-family:var(--dsw-font-family);--dsw-font-markdown-h3-font-weight:700;--dsw-font-markdown-h3-line-height:30px;--dsw-font-markdown-h3-font-size:20px;--dsw-font-markdown-h3-font-style:normal;--dsw-font-markdown-h4:600 16px/28px var(--dsw-font-family);--dsw-font-markdown-h4-font-family:var(--dsw-font-family);--dsw-font-markdown-h4-font-weight:600;--dsw-font-markdown-h4-line-height:28px;--dsw-font-markdown-h4-font-size:16px;--dsw-font-markdown-h4-font-style:normal;--dsw-font-markdown-base:16px/28px var(--dsw-font-family);--dsw-font-markdown-base-font-family:var(--dsw-font-family);--dsw-font-markdown-base-font-weight:400;--dsw-font-markdown-base-line-height:28px;--dsw-font-markdown-base-font-size:16px;--dsw-font-markdown-base-font-style:normal;--dsw-font-markdown-base-strong:600 16px/28px var(--dsw-font-family);--dsw-font-markdown-base-strong-font-family:var(--dsw-font-family);--dsw-font-markdown-base-strong-font-weight:600;--dsw-font-markdown-base-strong-line-height:28px;--dsw-font-markdown-base-strong-font-size:16px;--dsw-font-markdown-base-strong-font-style:normal;--dsw-font-markdown-base-italic:italic 16px/28px var(--dsw-font-family);--dsw-font-markdown-base-italic-font-family:var(--dsw-font-family);--dsw-font-markdown-base-italic-font-weight:400;--dsw-font-markdown-base-italic-line-height:28px;--dsw-font-markdown-base-italic-font-size:16px;--dsw-font-markdown-base-italic-font-style:italic;--dsw-font-markdown-base-strong-italic:italic 600 16px/28px var(--dsw-font-family);--dsw-font-markdown-base-strong-italic-font-family:var(--dsw-font-family);--dsw-font-markdown-base-strong-italic-font-weight:600;--dsw-font-markdown-base-strong-italic-line-height:28px;--dsw-font-markdown-base-strong-italic-font-size:16px;--dsw-font-markdown-base-strong-italic-font-style:italic;--dsw-font-markdown-table:15px/25px var(--dsw-font-family);--dsw-font-markdown-table-font-family:var(--dsw-font-family);--dsw-font-markdown-table-font-weight:400;--dsw-font-markdown-table-line-height:25px;--dsw-font-markdown-table-font-size:15px;--dsw-font-markdown-table-font-style:normal;--dsw-font-markdown-table-head:500 15px/25px var(--dsw-font-family);--dsw-font-markdown-table-head-font-family:var(--dsw-font-family);--dsw-font-markdown-table-head-font-weight:500;--dsw-font-markdown-table-head-line-height:25px;--dsw-font-markdown-table-head-font-size:15px;--dsw-font-markdown-table-head-font-style:normal;--dsw-font-markdown-small:14px/24px var(--dsw-font-family);--dsw-font-markdown-small-font-family:var(--dsw-font-family);--dsw-font-markdown-small-font-weight:400;--dsw-font-markdown-small-line-height:24px;--dsw-font-markdown-small-font-size:14px;--dsw-font-markdown-small-font-style:normal;--dsw-font-markdown-small-strong:600 14px/24px var(--dsw-font-family);--dsw-font-markdown-small-strong-font-family:var(--dsw-font-family);--dsw-font-markdown-small-strong-font-weight:600;--dsw-font-markdown-small-strong-line-height:24px;--dsw-font-markdown-small-strong-font-size:14px;--dsw-font-markdown-small-strong-font-style:normal;--dsw-font-markdown-small-italic:italic 14px/24px var(--dsw-font-family);--dsw-font-markdown-small-italic-font-family:var(--dsw-font-family);--dsw-font-markdown-small-italic-font-weight:400;--dsw-font-markdown-small-italic-line-height:24px;--dsw-font-markdown-small-italic-font-size:14px;--dsw-font-markdown-small-italic-font-style:italic;--dsw-font-markdown-small-strong-italic:italic 600 14px/24px var(--dsw-font-family);--dsw-font-markdown-small-strong-italic-font-family:var(--dsw-font-family);--dsw-font-markdown-small-strong-italic-font-weight:600;--dsw-font-markdown-small-strong-italic-line-height:24px;--dsw-font-markdown-small-strong-italic-font-size:14px;--dsw-font-markdown-small-strong-italic-font-style:italic;--dsw-font-markdown-code:14px/22px var(--ds-font-family-code);--dsw-font-markdown-code-font-family:var(--ds-font-family-code);--dsw-font-markdown-code-font-weight:400;--dsw-font-markdown-code-line-height:22px;--dsw-font-markdown-code-font-size:14px;--dsw-font-markdown-code-font-style:normal;--dsw-font-markdown-code-block:13px/22px var(--ds-font-family-code);--dsw-font-markdown-code-block-font-family:var(--ds-font-family-code);--dsw-font-markdown-code-block-font-weight:400;--dsw-font-markdown-code-block-line-height:22px;--dsw-font-markdown-code-block-font-size:13px;--dsw-font-markdown-code-block-font-style:normal;--dsw-font-markdown-code-block-small:12px/18px var(--ds-font-family-code);--dsw-font-markdown-code-block-small-font-family:var(--ds-font-family-code);--dsw-font-markdown-code-block-small-font-weight:400;--dsw-font-markdown-code-block-small-line-height:18px;--dsw-font-markdown-code-block-small-font-size:12px;--dsw-font-markdown-code-block-small-font-style:normal;--dsw-font-xl-24:600 24px/32px var(--dsw-font-family);--dsw-font-xl-24-font-family:var(--dsw-font-family);--dsw-font-xl-24-font-weight:600;--dsw-font-xl-24-line-height:32px;--dsw-font-xl-24-font-size:24px;--dsw-font-xl-24-font-style:normal;--dsw-font-l-20:500 20px/28px var(--dsw-font-family);--dsw-font-l-20-font-family:var(--dsw-font-family);--dsw-font-l-20-font-weight:500;--dsw-font-l-20-line-height:28px;--dsw-font-l-20-font-size:20px;--dsw-font-l-20-font-style:normal;--dsw-font-m-18:500 16px/28px var(--dsw-font-family);--dsw-font-m-18-font-family:var(--dsw-font-family);--dsw-font-m-18-font-weight:500;--dsw-font-m-18-line-height:28px;--dsw-font-m-18-font-size:16px;--dsw-font-m-18-font-style:normal;--dsw-font-base-16:16px/24px var(--dsw-font-family);--dsw-font-base-16-font-family:var(--dsw-font-family);--dsw-font-base-16-font-weight:400;--dsw-font-base-16-line-height:24px;--dsw-font-base-16-font-size:16px;--dsw-font-base-16-font-style:normal;--dsw-font-base-strong-16:500 16px/24px var(--dsw-font-family);--dsw-font-base-strong-16-font-family:var(--dsw-font-family);--dsw-font-base-strong-16-font-weight:500;--dsw-font-base-strong-16-line-height:24px;--dsw-font-base-strong-16-font-size:16px;--dsw-font-base-strong-16-font-style:normal;--dsw-font-s-14:14px/22px var(--dsw-font-family);--dsw-font-s-14-font-family:var(--dsw-font-family);--dsw-font-s-14-font-weight:400;--dsw-font-s-14-line-height:22px;--dsw-font-s-14-font-size:14px;--dsw-font-s-14-font-style:normal;--dsw-font-s-strong-14:500 14px/22px var(--dsw-font-family);--dsw-font-s-strong-14-font-family:var(--dsw-font-family);--dsw-font-s-strong-14-font-weight:500;--dsw-font-s-strong-14-line-height:22px;--dsw-font-s-strong-14-font-size:14px;--dsw-font-s-strong-14-font-style:normal;--dsw-font-xs-13:13px/20px var(--dsw-font-family);--dsw-font-xs-13-font-family:var(--dsw-font-family);--dsw-font-xs-13-font-weight:400;--dsw-font-xs-13-line-height:20px;--dsw-font-xs-13-font-size:13px;--dsw-font-xs-13-font-style:normal;--dsw-font-xs-strong-13:500 13px/20px var(--dsw-font-family);--dsw-font-xs-strong-13-font-family:var(--dsw-font-family);--dsw-font-xs-strong-13-font-weight:500;--dsw-font-xs-strong-13-line-height:20px;--dsw-font-xs-strong-13-font-size:13px;--dsw-font-xs-strong-13-font-style:normal;--dsw-font-xxs-12:12px/18px var(--dsw-font-family);--dsw-font-xxs-12-font-family:var(--dsw-font-family);--dsw-font-xxs-12-font-weight:400;--dsw-font-xxs-12-line-height:18px;--dsw-font-xxs-12-font-size:12px;--dsw-font-xxs-12-font-style:normal;--dsw-font-xxs-strong-12:500 12px/18px var(--dsw-font-family);--dsw-font-xxs-strong-12-font-family:var(--dsw-font-family);--dsw-font-xxs-strong-12-font-weight:500;--dsw-font-xxs-strong-12-line-height:18px;--dsw-font-xxs-strong-12-font-size:12px;--dsw-font-xxs-strong-12-font-style:normal;--dsw-font-xxxs-11:11px/14px var(--dsw-font-family);--dsw-font-xxxs-11-font-family:var(--dsw-font-family);--dsw-font-xxxs-11-font-weight:400;--dsw-font-xxxs-11-line-height:14px;--dsw-font-xxxs-11-font-size:11px;--dsw-font-xxxs-11-font-style:normal;--dsw-font-xxxs-strong-11:500 11px/14px var(--dsw-font-family);--dsw-font-xxxs-strong-11-font-family:var(--dsw-font-family);--dsw-font-xxxs-strong-11-font-weight:500;--dsw-font-xxxs-strong-11-line-height:14px;--dsw-font-xxxs-strong-11-font-size:11px;--dsw-font-xxxs-strong-11-font-style:normal}\n";

},
"src/modules/theme/shiki.css": function(module, exports, require) {
// source: src/modules/theme/shiki.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ":root{--shiki-foreground:var(--dsw-alias-label-primary);--shiki-background:var(--dsw-alias-markdown-code-block);--shiki-token-constant:#1c7ed6;--shiki-token-string:#2f9e44;--shiki-token-comment:#868e96;--shiki-token-keyword:#d6336c;--shiki-token-parameter:#e8590c;--shiki-token-function:#6741d9;--shiki-token-string-expression:#2b8a3e;--shiki-token-punctuation:#495057;--shiki-token-link:#1971c2}body[data-ds-dark-theme]{--shiki-token-constant:#4dabf7;--shiki-token-string:#69db7c;--shiki-token-comment:#adb5bd;--shiki-token-keyword:#faa2c1;--shiki-token-parameter:#ffa94d;--shiki-token-function:#b197fc;--shiki-token-string-expression:#8ce99a;--shiki-token-punctuation:#ced4da;--shiki-token-link:#74c0fc}\n";

},
"src/modules/theme/locales.js": function(module, exports, require) {
// source: src/modules/theme/locales.ts

"use strict";
/** `settings.theme` namespace dictionaries (the Appearance row's copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'appearance.title': '外观',
    'appearance.light': '浅色',
    'appearance.dark': '深色',
    'appearance.system': '跟随系统',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'appearance.title': 'Appearance',
    'appearance.light': 'Light',
    'appearance.dark': 'Dark',
    'appearance.system': 'System',
};

},
"src/modules/theme/theme-settings.js": function(module, exports, require) {
// source: src/modules/theme/theme-settings.ts

"use strict";
/** Theme preferences stored in the Host user-settings document. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PREFERENCE = exports.THEME_PREFERENCE_FIELD = exports.THEME_SETTINGS_NAMESPACE = exports.THEME_PREFERENCES = void 0;
exports.isThemePreference = isThemePreference;
/** Built-in preferences accepted at the registry and settings boundaries. */
exports.THEME_PREFERENCES = ['light', 'dark', 'system'];
/** Settings namespace owned by the theme plugin. */
exports.THEME_SETTINGS_NAMESPACE = 'ui-theme';
/** Field carrying the selected built-in theme preference. */
exports.THEME_PREFERENCE_FIELD = 'preference';
/** Default preference when the user-settings document has no override. */
exports.DEFAULT_PREFERENCE = 'system';
/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
function isThemePreference(value) {
    return exports.THEME_PREFERENCES.some(preference => preference === value);
}

}
};
const __dependencies = {"src/modules/theme/index.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./AppearanceRow":"src/modules/theme/AppearanceRow.js","./settings-store":"src/modules/theme/settings-store.js","./styles":"src/modules/theme/styles.js","./locales":"src/modules/theme/locales.js","./theme-settings":"src/modules/theme/theme-settings.js"},"src/modules/shared/runtime-types.js":{},"src/modules/theme/AppearanceRow.js":{"../views-types":"src/modules/views-types.js","./AppearanceRow.styles":"src/modules/theme/AppearanceRow.styles.js"},"src/modules/views-types.js":{},"src/modules/theme/AppearanceRow.styles.js":{"./AppearanceRow.css":"src/modules/theme/AppearanceRow.css","../views-types":"src/modules/views-types.js"},"src/modules/theme/AppearanceRow.css":{},"src/modules/theme/settings-store.js":{},"src/modules/theme/styles.js":{"./base.css":"src/modules/theme/base.css","./design-platform.css":"src/modules/theme/design-platform.css","./scrollbar.css":"src/modules/theme/scrollbar.css","./gradient-shadow-text.css":"src/modules/theme/gradient-shadow-text.css","./shiki.css":"src/modules/theme/shiki.css"},"src/modules/theme/base.css":{},"src/modules/theme/design-platform.css":{},"src/modules/theme/scrollbar.css":{},"src/modules/theme/gradient-shadow-text.css":{},"src/modules/theme/shiki.css":{},"src/modules/theme/locales.js":{},"src/modules/theme/theme-settings.js":{}};
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
return __load("src/modules/theme/index.js");
}
});
