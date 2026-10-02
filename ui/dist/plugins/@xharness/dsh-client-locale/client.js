// Generated from src/modules/client-locale/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-locale",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-locale/index.js": function(module, exports, require) {
// source: src/modules/client-locale/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.LocaleRuntime = exports.SETTINGS_NS = exports.COMMON_NS = exports.FALLBACK_LOCALE = void 0;
exports.apply = apply;
const locale_settings_1 = require("./locale-settings");
const locales_1 = require("./locales");
const settings_1 = require("./locales/settings");
const LanguageRow_1 = require("./LanguageRow");
const settings_store_1 = require("./settings-store");
/**
 * English is both the locale the UI opens in when the browser names no shipped
 * language (and for non-browser runs), and the dictionary consulted after the
 * active locale misses a key. One constant serves both because the shipped
 * `zh`/`en` dictionaries carry identical key sets, so neither direction can
 * leave a key unresolved; the residual case points at English rather than
 * zh because a browser naming neither shipped language is the reader least
 * likely to read Chinese.
 */
exports.FALLBACK_LOCALE = 'en';
/** Shared namespace for shell-level texts. */
exports.COMMON_NS = 'common';
/** Namespace owning this feature's settings-row copy. */
exports.SETTINGS_NS = 'settings.locale';
/** The two shipped locales. */
const LOCALES = Object.freeze([
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
]);
/**
 * `<html lang>` tag per shipped locale. The locale id is the app's own
 * vocabulary (primary subtag); the document attribute wants a BCP 47 tag,
 * which assistive technology and browser features (pronunciation rules,
 * translation offers, font fallback, spell check) read to pick their own
 * behavior. `zh` alone leaves the script ambiguous, so the shipped Chinese
 * copy names the variant it actually is.
 */
const DOCUMENT_LANGUAGE = { zh: 'zh-CN', en: 'en' };
/**
 * Point `<html lang>` at the active locale. Called on every locale change,
 * so the attribute tracks the UI instead of standing at whatever the served
 * markup happened to declare.
 * @param active - the active locale id.
 */
function syncDocumentLanguage(active) {
    // Non-browser runs (node boots of the client tree) have no document.
    if (typeof document === 'undefined')
        return;
    document.documentElement.lang = DOCUMENT_LANGUAGE[active];
}
/**
 * Dictionary registry plus locale preference. Lookup chain per key: the
 * entry's namespace in the active locale -> that namespace's en fallback ->
 * the shared common namespace (active, then en) -> the key itself (missing
 * text stays visible, fail loud in the UI rather than blank). Reads go
 * through {@link getLocale}; writes only through {@link setLocale};
 * continuous sync through the `locale/change` event, or through the
 * LocaleFace getSnapshot/subscribe pair the render machinery consumes
 * (installed via `ctx.slots.installLocale`).
 */
class LocaleRuntime {
    /**
     * @param ctx - owning context (change events are emitted on it; the scope
     * listener is released through ctx.effect on dispose).
     * @param host - durable preference scope owned by the providing plugin;
     * absent compositions (standalone dictionary registries) stay process-local.
     */
    constructor(ctx, host) {
        this.dicts = new Map();
        this.bound = new Map();
        this.listeners = new Set();
        this.ctx = ctx;
        this.host = host;
        this.provisional = resolveInitialLocale();
        this.snapshot = Object.freeze({ active: this.provisional, locales: LOCALES, revision: 0 });
        if (host !== undefined) {
            ctx.effect(() => host.subscribe(() => { this.adopt(host); }), 'locale: settings scope adoption');
            this.adopt(host);
        }
    }
    /**
     * Read the current immutable locale snapshot.
     * @returns the current snapshot (stable reference until the next change).
     */
    getLocale() {
        return this.snapshot;
    }
    /**
     * LocaleFace getSnapshot: the current snapshot (carries `revision`; stable
     * reference between changes, uSES-safe).
     * @returns the current snapshot.
     */
    getSnapshot() {
        return this.snapshot;
    }
    /**
     * LocaleFace subscribe: notified on every snapshot change (locale switch
     * or dictionary registration — registrations bump the revision so already
     * rendered outlets pick up late-arriving dictionaries).
     * @param fn - change callback.
     * @returns unsubscribe.
     */
    subscribe(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }
    /**
     * Switch the active locale — the only user preference write entry.
     *
     * The durable write happens even when the id already matches the active
     * locale, because the active value may be a provisional browser-derived or
     * fallback resolution that nothing has stored yet. Picking the language
     * already on screen is still an explicit choice, and it must survive a
     * different browser sharing the same DSH home. Only the render notification
     * is conditional: republishing an unchanged locale would churn every
     * subscriber for nothing.
     * @param id - a registered locale id; unknown ids throw.
     */
    setLocale(id) {
        const match = this.snapshot.locales.find(l => l.id === id);
        if (match === undefined)
            throw new Error(`locale "${id}" is not registered`);
        if (this.snapshot.active !== match.id)
            this.publish(match.id, true);
        void this.host?.set(locale_settings_1.LOCALE_PREFERENCE_FIELD, match.id);
    }
    /**
     * Adopt the scope's accepted durable selection without writing it back; an
     * absent selection returns to the browser-derived locale.
     * @param host - the constructor-narrowed scope driving this adoption.
     */
    adopt(host) {
        const section = host.getSnapshot().value;
        if (section === undefined)
            return;
        const target = section.preference ?? this.provisional;
        if (this.snapshot.active === target)
            return;
        this.publish(target, true);
    }
    register(ns, localeOrDicts, dict) {
        if (typeof localeOrDicts === 'string' && dict === undefined)
            throw new Error('locale dictionary is required');
        const pairs = typeof localeOrDicts === 'string'
            // Overload guarantees dict on the single-locale arm.
            ? dict === undefined ? [] : [[localeOrDicts, dict]]
            : Object.entries(localeOrDicts);
        let locales = this.dicts.get(ns);
        if (!locales) {
            locales = new Map();
            this.dicts.set(ns, locales);
        }
        for (const [locale] of pairs) {
            if (locales.has(locale))
                throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
        }
        for (const [locale, entries] of pairs)
            locales.set(locale, entries);
        this.publish(this.snapshot.active, false);
        return () => {
            const owner = this.dicts.get(ns);
            /* v8 ignore next -- defensive: a namespace's locales map is created on
             * first register and never removed, so the disposer always finds it. */
            if (!owner)
                return;
            let removed = false;
            for (const [locale, entries] of pairs) {
                if (owner.get(locale) === entries) {
                    owner.delete(locale);
                    removed = true;
                }
            }
            if (removed)
                this.publish(this.snapshot.active, false);
        };
    }
    bind(ns) {
        let t = this.bound.get(ns);
        if (!t) {
            t = (key, params) => this.translate(ns, key, params);
            this.bound.set(ns, t);
            return t;
        }
        return t;
    }
    translate(ns, key, params) {
        const template = this.lookup(ns, key)
            ?? (ns !== exports.COMMON_NS ? this.lookup(exports.COMMON_NS, key) : undefined)
            ?? key;
        if (!params)
            return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }
    lookup(ns, key) {
        const locales = this.dicts.get(ns);
        return locales?.get(this.snapshot.active)?.[key] ?? locales?.get(exports.FALLBACK_LOCALE)?.[key];
    }
    /**
     * Advance the snapshot revision and notify LocaleFace subscribers (render
     * refresh). Only an active-locale switch additionally emits
     * `locale/change` — dictionary registrations stay off the event so
     * registration-heavy boot cannot storm event listeners (which may
     * re-register slots in response).
     */
    publish(active, localeChanged) {
        this.snapshot = Object.freeze({
            active,
            locales: this.snapshot.locales,
            revision: this.snapshot.revision + 1,
        });
        if (localeChanged)
            this.ctx.emit('locale/change', this.snapshot);
        for (const fn of [...this.listeners]) {
            try {
                fn();
            }
            catch (error) {
                // One throwing subscriber must not strand the rest on a stale
                // revision (outlets would keep the previous language).
                console.error('locale subscriber crashed:', error);
            }
        }
    }
}
exports.LocaleRuntime = LocaleRuntime;
/**
 * The browser's own language wins over {@link FALLBACK_LOCALE}; an explicit
 * Host preference may replace this provisional value after plugin activation.
 */
function resolveInitialLocale() {
    return detectBrowserLocale() ?? exports.FALLBACK_LOCALE;
}
/**
 * The first shipped locale the browser asks for, matched on the primary
 * subtag so every regional variant lands on its language (`zh-Hans-CN` -> zh,
 * `en-GB` -> en). `window` is the browser test, not `navigator`: Node exposes
 * a global `navigator` reporting the machine's own language, which would
 * otherwise decide the locale for non-browser runs (node e2e booting the
 * client tree). `navigator.language` trails the ordered `languages` list and
 * covers its absence on hosts that expose only the single tag.
 */
function detectBrowserLocale() {
    if (typeof window === 'undefined')
        return undefined;
    /* oxlint-disable-next-line typescript/no-unnecessary-condition --
     * The DOM lib types `languages` as always present; embedders and older
     * WebViews ship a Navigator without it, and spreading undefined would
     * throw at boot. */
    for (const tag of [...(navigator.languages ?? []), navigator.language]) {
        const primary = tag.toLowerCase().split('-')[0];
        const match = LOCALES.find(locale => locale.id === primary);
        if (match)
            return match.id;
    }
    return undefined;
}
/** Required services: slot registration plus the settings transport. */
exports.inject = ['slots', 'connection', 'remote', 'settingsScope'];
/**
 * Client plugin body: provide the locale service with base dictionaries and
 * register the feature-owned Language preference row into the General
 * section's item slot (a feature owns its settings surface).
 * @param ctx - client cordis context.
 */
function apply(ctx) {
    const host = ctx.settingsScope.bind({ namespace: locale_settings_1.LOCALE_SETTINGS_NAMESPACE });
    const locale = new LocaleRuntime(ctx, host);
    locale.register(exports.COMMON_NS, { zh: locales_1.zh, en: locales_1.en });
    locale.register(exports.SETTINGS_NS, { zh: settings_1.zh, en: settings_1.en });
    ctx.provide('locale', locale);
    // The service IS the LocaleFace (bind + getSnapshot/subscribe): install it
    // so the render machinery can synthesize the `t` standard seat.
    ctx.slots.installLocale(locale);
    const store = (0, settings_store_1.createLanguageRowStore)();
    let bound;
    const sync = (snapshot) => {
        syncDocumentLanguage(snapshot.active);
        bound?.sync(snapshot.active, snapshot.locales.map(l => ({ id: l.id, label: l.label })), snapshot.revision);
    };
    ctx.on('locale/change', sync);
    // The served markup declares one language; the resolved locale may differ
    // (browser detection, or a stored preference adopted after activation), so
    // state it once at activation rather than waiting for the first change.
    syncDocumentLanguage(locale.getLocale().active);
    const injected = (actions) => {
        bound = actions;
        // Re-sync from the getter so no event is lost between registration and
        // first render (the store's revision guard drops stale duplicates).
        sync(locale.getLocale());
        return {
            setLocale: (id) => { locale.setLocale(id); },
        };
    };
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'language',
        order: 0,
        store,
        locale: exports.SETTINGS_NS,
        inject: injected,
    }, LanguageRow_1.LanguageRow));
}

},
"src/modules/client-locale/locale-settings.js": function(module, exports, require) {
// source: src/modules/client-locale/locale-settings.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCALE_IDS = exports.LOCALE_PREFERENCE_FIELD = exports.LOCALE_SETTINGS_NAMESPACE = void 0;
/** Preference constants consumed by the browser. The Host owns schema validation. */
exports.LOCALE_SETTINGS_NAMESPACE = 'locale';
exports.LOCALE_PREFERENCE_FIELD = 'preference';
exports.LOCALE_IDS = ['zh', 'en'];

},
"src/modules/client-locale/locales/index.js": function(module, exports, require) {
// source: src/modules/client-locale/locales/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/**
 * The common-namespace dictionary pair. zh is the source of truth for the
 * key set (Chinese-first repo convention); en is checked complete against it
 * — a missing or extra en key is a compile error.
 */
var zh_1 = require("./zh");
Object.defineProperty(exports, "zh", { enumerable: true, get: function () { return zh_1.zh; } });
var en_1 = require("./en");
Object.defineProperty(exports, "en", { enumerable: true, get: function () { return en_1.en; } });

},
"src/modules/client-locale/locales/zh.js": function(module, exports, require) {
// source: src/modules/client-locale/locales/zh.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = void 0;
/** zh base dictionary for the common namespace: cross-feature standard words. */
exports.zh = {
    'ok': '确定',
    'cancel': '取消',
    'close': '关闭',
    'copy': '复制',
    'copied': '复制成功',
    'retry': '重试',
    'loading': '加载中…',
    'load.failed': '加载失败',
    'submit': '提交',
    'submitting': '正在提交…',
    'next': '下一步',
    'previous': '上一步',
    'skip': '跳过',
    'delete': '删除',
    'edit': '编辑',
    'save': '保存',
    'search': '搜索',
    'more': '更多',
    'collapse': '收起',
    'expand': '展开',
    'back': '返回',
    'unknown': '未知',
    'none': '无',
    'truncated': '已截断',
};

},
"src/modules/client-locale/locales/en.js": function(module, exports, require) {
// source: src/modules/client-locale/locales/en.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = void 0;
/** en base dictionary for the common namespace, checked complete against the zh key set. */
exports.en = {
    'ok': 'OK',
    'cancel': 'Cancel',
    'close': 'Close',
    'copy': 'Copy',
    'copied': 'Copied',
    'retry': 'Retry',
    'loading': 'Loading…',
    'load.failed': 'Failed to load',
    'submit': 'Submit',
    'submitting': 'Submitting…',
    'next': 'Next',
    'previous': 'Previous',
    'skip': 'Skip',
    'delete': 'Delete',
    'edit': 'Edit',
    'save': 'Save',
    'search': 'Search',
    'more': 'More',
    'collapse': 'Collapse',
    'expand': 'Expand',
    'back': 'Back',
    'unknown': 'Unknown',
    'none': 'None',
    'truncated': 'Truncated',
};

},
"src/modules/client-locale/locales/settings.js": function(module, exports, require) {
// source: src/modules/client-locale/locales/settings.ts

"use strict";
/** `settings.locale` namespace dictionaries (the Language row's copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'language.title': '语言',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'language.title': 'Language',
};

},
"src/modules/client-locale/LanguageRow.js": function(module, exports, require) {
// source: src/modules/client-locale/LanguageRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LanguageRow = LanguageRow;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Language preference row registered into the General section item slot
 * (figma 501:30011 'Setting-Cell'): title + selector pill opening the locale
 * menu. Registered by this package — the locale feature owns its own
 * settings surface.
 */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const LanguageRow_styles_1 = __importDefault(require("./LanguageRow.styles"));
/** Full component props: runtime share + store share + locale seat + injected face. */
/**
 * Render the Language row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
function LanguageRow({ t, setLocale, useStore }) {
    const active = useStore(s => s.active);
    const options = useStore(s => s.options);
    const [open, setOpen] = (0, react_1.useState)(false);
    const activeLabel = options.find(o => o.id === active)?.label ?? active;
    return ((0, jsx_runtime_1.jsxs)("div", { className: LanguageRow_styles_1.default.row, children: [(0, jsx_runtime_1.jsx)("div", { className: LanguageRow_styles_1.default.rowText, children: (0, jsx_runtime_1.jsx)("div", { className: LanguageRow_styles_1.default.title, children: t('language.title') }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: open, onClose: () => { setOpen(false); }, items: options.map(o => ({ id: o.id, label: o.label })), selectedId: active, onSelect: (id) => {
                    setLocale(id);
                    setOpen(false);
                }, align: "end", portal: true, anchor: ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: LanguageRow_styles_1.default.selector, "aria-haspopup": "menu", "aria-expanded": open, onClick: () => { setOpen(v => !v); }, children: [activeLabel, (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: LanguageRow_styles_1.default.chevron })] })) })] }));
}

},
"src/modules/client-locale/LanguageRow.styles.js": function(module, exports, require) {
// source: src/modules/client-locale/LanguageRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const foundation_styles_1 = require("../shared/foundation-styles");
const LanguageRow_css_1 = __importDefault(require("./LanguageRow.css"));
(0, foundation_styles_1.installStyles)('@xharness/dsh-client-locale/LanguageRow.module.css', '@xharness/dsh-client-locale', LanguageRow_css_1.default);
exports.default = { "row": "_6PhFsW_row", "rowText": "_6PhFsW_rowText", "title": "_6PhFsW_title", "selector": "_6PhFsW_selector", "chevron": "_6PhFsW_chevron" };

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
"src/modules/client-locale/LanguageRow.css": function(module, exports, require) {
// source: src/modules/client-locale/LanguageRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "/* Language row (figma 'Setting-Cell': gap 8, pad 16/0, hairline separator;\n * the section column removes the separator on its last child). */\n\n._6PhFsW_row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 16px 0;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n}\n\n._6PhFsW_rowText {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding-right: 48px;\n}\n\n._6PhFsW_title {\n  font-size: 14px;\n  font-weight: 400;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Selector pill (figma 'Selector': h36 r18, fill #F5F6F7, pad 0/14, gap 12). */\n._6PhFsW_selector {\n  display: inline-flex;\n  align-items: center;\n  gap: 12px;\n  height: 36px;\n  padding: 0 14px;\n  border: none;\n  border-radius: 18px;\n  background: var(--dsw-alias-bg-module-platform);\n  font: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n._6PhFsW_selector:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n._6PhFsW_chevron {\n  flex: none;\n}\n";

},
"src/modules/client-locale/settings-store.js": function(module, exports, require) {
// source: src/modules/client-locale/settings-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLanguageRowStore = createLanguageRowStore;
/**
 * Language row slot store: a mirror of the locale service snapshot. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
const client_1 = require("@xharness/dsh-client-runtime/client");
/**
 * Declares the Language row state and write surface.
 * @returns the store handle.
 */
function createLanguageRowStore() {
    return (0, client_1.defineStore)({
        init: () => ({ active: '', options: [], revision: -1 }),
        bake: (bind, actions) => ({ sync: bind(actions.sync) }),
        actions: {
            sync: (d, active, options, revision) => {
                if (revision <= d.revision)
                    return;
                d.active = active;
                d.options = options;
                d.revision = revision;
            },
        },
    });
}

}
};
const __dependencies = {"src/modules/client-locale/index.js":{"./locale-settings":"src/modules/client-locale/locale-settings.js","./locales":"src/modules/client-locale/locales/index.js","./locales/settings":"src/modules/client-locale/locales/settings.js","./LanguageRow":"src/modules/client-locale/LanguageRow.js","./settings-store":"src/modules/client-locale/settings-store.js"},"src/modules/client-locale/locale-settings.js":{},"src/modules/client-locale/locales/index.js":{"./zh":"src/modules/client-locale/locales/zh.js","./en":"src/modules/client-locale/locales/en.js"},"src/modules/client-locale/locales/zh.js":{},"src/modules/client-locale/locales/en.js":{},"src/modules/client-locale/locales/settings.js":{},"src/modules/client-locale/LanguageRow.js":{"./LanguageRow.styles":"src/modules/client-locale/LanguageRow.styles.js"},"src/modules/client-locale/LanguageRow.styles.js":{"../shared/foundation-styles":"src/modules/shared/foundation-styles.js","./LanguageRow.css":"src/modules/client-locale/LanguageRow.css"},"src/modules/shared/foundation-styles.js":{},"src/modules/client-locale/LanguageRow.css":{},"src/modules/client-locale/settings-store.js":{}};
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
return __load("src/modules/client-locale/index.js");
}
});
