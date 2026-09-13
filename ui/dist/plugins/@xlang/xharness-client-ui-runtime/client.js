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
const EnvironmentPicker_1 = require("./EnvironmentPicker");
const locales_1 = require("./locales");
exports.inject = ['slots', 'locale'];
exports.ENVIRONMENT_SLOT = 'conversation.hero.runtimeEnvironment';
/** Owned source-module registration, not a patch of a generated JS bundle. */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { en: locales_1.en, zh: locales_1.zh }), 'runtime-environment: dictionaries');
    ctx.slots.inject(exports.ENVIRONMENT_SLOT, () => ctx.slots.register({ name: exports.ENVIRONMENT_SLOT, locale: locales_1.NS }, EnvironmentPicker_1.EnvironmentPicker));
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
"src/modules/runtime-environment/locales.js": function(module, exports, require) {
// source: src/modules/runtime-environment/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.NS = void 0;
exports.NS = 'runtime.environment';
exports.en = {
    choose: 'Choose execution environment', local: 'Local', cloud: 'Cloud',
    unavailable: 'Cloud execution is not connected yet. Tasks still run on the current Host.',
    bound: 'This conversation keeps its existing environment. Start a new task to choose another.',
    unknown: 'Conversation history has not been confirmed. Its environment cannot be changed.',
};
exports.zh = {
    choose: '选择执行环境', local: '本机', cloud: 'Cloud',
    unavailable: '云端执行尚未接入。任务仍在当前 Host 上运行。',
    bound: '此对话保持原执行环境。切换环境需要新建任务。',
    unknown: '尚未确认对话历史，不能更改其执行环境。',
};

}
};
const __dependencies = {"src/modules/runtime-environment/index.js":{"./EnvironmentPicker":"src/modules/runtime-environment/EnvironmentPicker.js","./locales":"src/modules/runtime-environment/locales.js"},"src/modules/runtime-environment/EnvironmentPicker.js":{"./policy":"src/modules/runtime-environment/policy.js"},"src/modules/runtime-environment/policy.js":{},"src/modules/runtime-environment/locales.js":{}};
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
