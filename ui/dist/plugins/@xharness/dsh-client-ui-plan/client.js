// Generated from src/modules/plan/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-plan",
factory: (__externalRequire) => {
const __units = {
"src/modules/plan/index.js": function(module, exports, require) {
// source: src/modules/plan/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat).
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
const PlanModeControl_1 = require("./PlanModeControl");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin. */
const NS = 'plan';
/** Required services: the seat's slot registry, commands Remote, and locale registry. */
exports.inject = ['slots', 'remote', 'remote.commands', 'locale'];
/**
 * Client plugin body: register the plan chip over the command channel.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-plan: dictionaries');
    ctx.slots.inject('conversation.input.plan', () => ctx.slots.register({
        name: 'conversation.input.plan',
        locale: NS,
        inject: (sessionId) => ({
            // Failure strings stay English (error-surface policy: not localized).
            exitPlanMode: async () => {
                const result = await ctx.remote.commands.execute(sessionId, '/plan off', []);
                if (!result.ok)
                    return `${result.error.message} (${result.error.code})`;
                if (result.value === undefined)
                    return 'unknown command: /plan off';
                return null;
            },
        }),
    }, PlanModeControl_1.PlanChip));
}

},
"src/modules/plan/PlanModeControl.js": function(module, exports, require) {
// source: src/modules/plan/PlanModeControl.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlanChip = PlanChip;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const PlanModeControl_styles_1 = __importDefault(require("./PlanModeControl.styles"));
/**
 * Plan-mode status over the host-computed `plan` projection. The chip renders
 * only while the effective target is plan mode (`pending ? !active : active`
 * — a folded host value, not client optimism) and executes /plan off.
 */
function PlanChip({ useProjection, locked, exitPlanMode, t }) {
    const plan = useProjection('plan');
    const [leaving, setLeaving] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const aliveRef = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);
    if (plan === undefined)
        return null;
    const target = plan.pending ? !plan.active : plan.active;
    if (!target)
        return null;
    const off = () => {
        // No leaving/locked guard: both disable the button, so no click arrives.
        setLeaving(true);
        setError(null);
        void exitPlanMode().then((failure) => {
            if (!aliveRef.current)
                return;
            setLeaving(false);
            setError(failure);
        }, (reason) => {
            if (!aliveRef.current)
                return;
            setLeaving(false);
            setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    return ((0, jsx_runtime_1.jsxs)("span", { className: PlanModeControl_styles_1.default.wrap, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: PlanModeControl_styles_1.default.chip, "aria-label": t('chip.on.aria'), title: t('chip.on.title'), disabled: locked || leaving, onClick: off, children: ["Plan", (0, jsx_runtime_1.jsx)("span", { className: PlanModeControl_styles_1.default.close, "aria-hidden": true, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseFill14, { size: 12 }) })] }), error !== null && (0, jsx_runtime_1.jsx)("span", { className: PlanModeControl_styles_1.default.error, role: "status", title: error, children: "failed to exit plan mode" })] }));
}

},
"src/modules/plan/PlanModeControl.styles.js": function(module, exports, require) {
// source: src/modules/plan/PlanModeControl.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PlanModeControl_css_1 = __importDefault(require("./PlanModeControl.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-plan/PlanModeControl.module.css", "@xharness/dsh-client-ui-plan", PlanModeControl_css_1.default);
const styles = {
    "chip": "_NETUa_chip",
    "close": "_NETUa_close",
    "error": "_NETUa_error",
    "wrap": "_NETUa_wrap"
};
exports.default = styles;

},
"src/modules/plan/PlanModeControl.css": function(module, exports, require) {
// source: src/modules/plan/PlanModeControl.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._NETUa_wrap{align-items:center;gap:6px;display:inline-flex}._NETUa_chip{background:var(--dsw-alias-state-warn-tertiary);min-width:34px;color:var(--dsw-alias-state-warn-label);cursor:pointer;border:none;border-radius:999px;align-items:center;gap:4px;padding:2px 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}._NETUa_chip:hover:not(:disabled){color:var(--dsw-alias-state-warn-primary)}._NETUa_chip:focus-visible{outline:2px solid var(--dsw-alias-state-warn-label);outline-offset:2px}._NETUa_chip:disabled{opacity:.6;cursor:default}._NETUa_close{color:currentColor;align-items:center;display:inline-flex}._NETUa_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}\n";

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
"src/modules/plan/locales.js": function(module, exports, require) {
// source: src/modules/plan/locales.ts

"use strict";
/** `plan` namespace dictionaries (the composer plan chip's copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'chip.on.aria': 'plan mode 已开启，按下关闭',
    'chip.on.title': 'plan mode 已开启 — 点击关闭（/plan off）',
    'chip.off.aria': 'plan mode 已关闭，按下开启',
    'chip.off.title': 'plan mode 已关闭 — 点击开启（/plan）',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'chip.on.aria': 'Plan mode on, press to turn off',
    'chip.on.title': 'Plan mode on — click to turn off (/plan off)',
    'chip.off.aria': 'Plan mode off, press to turn on',
    'chip.off.title': 'Plan mode off — click to turn on (/plan)',
};

}
};
const __dependencies = {"src/modules/plan/index.js":{"./PlanModeControl":"src/modules/plan/PlanModeControl.js","./locales":"src/modules/plan/locales.js"},"src/modules/plan/PlanModeControl.js":{"./PlanModeControl.styles":"src/modules/plan/PlanModeControl.styles.js"},"src/modules/plan/PlanModeControl.styles.js":{"./PlanModeControl.css":"src/modules/plan/PlanModeControl.css","../views-types":"src/modules/views-types.js"},"src/modules/plan/PlanModeControl.css":{},"src/modules/views-types.js":{},"src/modules/plan/locales.js":{}};
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
return __load("src/modules/plan/index.js");
}
});
