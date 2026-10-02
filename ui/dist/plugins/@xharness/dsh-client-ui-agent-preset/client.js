// Generated from src/modules/agent-preset/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-agent-preset",
factory: (__externalRequire) => {
const __units = {
"src/modules/agent-preset/index.js": function(module, exports, require) {
// source: src/modules/agent-preset/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.writeDefaultPreset = exports.AGENT_PRESET_SETTINGS_NS = exports.draftBlocker = void 0;
exports.apply = apply;
/// <reference path="./externals.d.ts" />
require("./AgentPresetLabel.styles");
require("./AgentPresetRow.styles");
require("./AgentPresetSeat.styles");
require("./AgentPresetSection.styles");
const seat_store_1 = require("./seat-store");
const section_store_1 = require("./section-store");
const locales_1 = require("./locales");
const settings_store_1 = require("./settings-store");
var section_store_2 = require("./section-store");
Object.defineProperty(exports, "draftBlocker", { enumerable: true, get: function () { return section_store_2.draftBlocker; } });
var settings_store_2 = require("./settings-store");
Object.defineProperty(exports, "AGENT_PRESET_SETTINGS_NS", { enumerable: true, get: function () { return settings_store_2.AGENT_PRESET_SETTINGS_NS; } });
Object.defineProperty(exports, "writeDefaultPreset", { enumerable: true, get: function () { return settings_store_2.writeDefaultPreset; } });
/** Required services (cordis fiber inject). */
exports.inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];
/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
    const { api } = ctx.get('connection');
    const controller = new settings_store_1.AgentPresetSettingsController(api, ctx.settingsScope.describe());
    // One roster, four surfaces. The chip is registered in a later scope, so it
    // subscribes here rather than being reached from this one.
    const rosterReaders = new Set();
    const section = new section_store_1.AgentPresetSectionController(api, () => {
        void controller.load();
        for (const read of rosterReaders)
            read();
    });
    ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh: locales_1.zh, en: locales_1.en }), 'ui-agent-preset: settings row dictionaries');
    const injected = () => ({
        hooks: { agentPreset: controller.store },
        load: () => controller.load(),
        select: (id) => controller.select(id),
    });
    ctx.effect(() => {
        // The roster is a live directory and the default is a settings field, so
        // both an external settings edit and a reconnect can move this row.
        const refresh = () => {
            void controller.load();
            // The section reads the same roster and marks the same default, so a
            // change made from either surface converges both.
            if (section.store.getSnapshot().status !== 'idle')
                void section.load();
        };
        const disposers = [
            ctx.remote.$on('settings/document-updated', (ns) => {
                if (ns !== settings_store_1.AGENT_PRESET_SETTINGS_NS)
                    return;
                refresh();
            }),
            ctx.on('connection/reset', () => { refresh(); }),
        ];
        return () => { for (const dispose of disposers)
            dispose(); };
    }, 'ui-agent-preset: settings refresh');
    // The settings section's conversational authoring entry: stage the
    // self-referential preset and land a new session on it. Bound inside the
    // conversation scope below (the seat and the session flow live there) and
    // unbound with it, so the section's face reads the current binding per
    // render and simply hides the button while no flow exists.
    let creatorDraft;
    // The new-session chip and the header label: one controller, because the
    // staged choice belongs to the flow rather than to any one session.
    ctx.inject(['slots', 'conversation', 'sessions', 'workspaces'], (scope) => {
        const api = (scope.get('connection')).api;
        const seat = new seat_store_1.AgentPresetSeatController(api, () => {
            const state = scope.sessions.list.getSnapshot();
            const summary = state.current === undefined ? undefined : state.byId[state.current];
            return summary === undefined
                ? undefined
                : {
                    id: summary.id,
                    blank: summary.blank,
                    ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset },
                };
        }, (sessionId, agentPreset) => {
            scope.sessions.noteAgentPreset(sessionId, agentPreset);
        });
        const seatInjected = () => ({
            hooks: { agentPresetSeat: seat.store },
            load: () => seat.load(),
            select: (id) => seat.select(id),
            introduced: () => { seat.introduced(); },
        });
        const labelInjected = () => ({
            hooks: { agentPresets: controller.store },
            load: () => controller.load(),
        });
        scope.effect(() => {
            // Connecting a workspace either creates a blank session or reuses one,
            // and either way the chip's pick predates it — so the stage is applied
            // when the session arrives, not when it was made.
            const stop = scope.sessions.list.subscribe(() => { void seat.apply(); });
            // The chip opens on the deployment default, so a default changed from
            // the settings surface moves it too — otherwise the screen that starts
            // the next session keeps offering the previous default until a reload,
            // which is exactly the session the setting claims to govern. A staged
            // pick survives: `load()` prefers it over the refreshed fallback.
            const settingsMoved = scope.remote.$on('settings/document-updated', (ns) => {
                if (ns !== settings_store_1.AGENT_PRESET_SETTINGS_NS)
                    return;
                void seat.load();
            });
            // Every tab folds the committed preset into the shared session row; the
            // initiating tab may already have applied the RPC echo, which is idempotent.
            const presetSelected = scope.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
                scope.sessions.noteAgentPreset(sessionId, agentPreset);
            });
            // Authoring writes a FILE, not a setting, so nothing on the wire
            // announces it — without this the screen that starts the next session
            // keeps offering the roster as it stood when the chip first loaded, and
            // a preset authored to be used is missing from the one place it is used.
            const readRoster = () => { void seat.load(); };
            rosterReaders.add(readRoster);
            // Stage WITHOUT applying — the still-current running session would
            // refuse the swap and drop the stage — then start the session it lands
            // on: the chip's list-change applier composes the blank session the
            // workspace connect produces or reuses.
            creatorDraft = () => {
                // The introduce cue makes the chip announce the pick the user never
                // made on this screen — the stage happened back in settings.
                seat.stage('cordis', true);
                scope.workspaces.startSession();
            };
            // The default agent is Host-selected; mode entrypoints stay hidden.
            return () => {
                stop();
                settingsMoved();
                presetSelected();
                rosterReaders.delete(readRoster);
                creatorDraft = undefined;
            };
        }, 'ui-agent-preset: new-session chip and header label');
    });
    const sectionInjected = () => ({
        hooks: { agentPresetSection: section.store },
        load: () => section.load(),
        view: (id) => section.view(id),
        closeView: () => { section.closeView(); },
        beginCopy: (from) => { section.beginCopy(from); },
        cancelCopy: () => { section.cancelCopy(); },
        setCopyId: (id) => { section.setCopyId(id); },
        setCopyName: (name) => { section.setCopyName(name); },
        confirmCopy: () => section.confirmCopy(),
        openLocation: (id) => section.openLocation(id),
        ...creatorDraft === undefined ? {} : { startCreatorDraft: creatorDraft },
        confirmDelete: (id) => { section.confirmDelete(id); },
        remove: () => section.remove(),
        makeDefault: (id) => section.makeDefault(id),
    });
    // No agent-preset row in General settings or dedicated mode settings page.
}

},
"src/modules/agent-preset/AgentPresetLabel.styles.js": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetLabel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AgentPresetLabel_css_1 = __importDefault(require("./AgentPresetLabel.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-agent-preset/AgentPresetLabel.module.css", "@xharness/dsh-client-ui-agent-preset", AgentPresetLabel_css_1.default);
const styles = {
    "icon": "ie6uwG_icon",
    "label": "ie6uwG_label"
};
exports.default = styles;

},
"src/modules/agent-preset/AgentPresetLabel.css": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetLabel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".ie6uwG_label{background:var(--dsw-alias-fill-tsp-secondary);max-width:180px;height:22px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;border-radius:6px;align-items:center;gap:4px;padding:0 2px 0 0;font-size:12px;line-height:22px;display:inline-flex;overflow:hidden}.ie6uwG_icon{opacity:.7;flex:none}";

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
"src/modules/agent-preset/AgentPresetRow.styles.js": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AgentPresetRow_css_1 = __importDefault(require("./AgentPresetRow.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-agent-preset/AgentPresetRow.module.css", "@xharness/dsh-client-ui-agent-preset", AgentPresetRow_css_1.default);
const styles = {
    "chevron": "PfKHXa_chevron",
    "desc": "PfKHXa_desc",
    "row": "PfKHXa_row",
    "rowText": "PfKHXa_rowText",
    "selector": "PfKHXa_selector",
    "title": "PfKHXa_title"
};
exports.default = styles;

},
"src/modules/agent-preset/AgentPresetRow.css": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".PfKHXa_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.PfKHXa_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.PfKHXa_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.PfKHXa_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.PfKHXa_selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.PfKHXa_selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.PfKHXa_selector:disabled{cursor:default}.PfKHXa_chevron{flex:none}";

},
"src/modules/agent-preset/AgentPresetSeat.styles.js": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetSeat.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AgentPresetSeat_css_1 = __importDefault(require("./AgentPresetSeat.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-agent-preset/AgentPresetSeat.module.css", "@xharness/dsh-client-ui-agent-preset", AgentPresetSeat_css_1.default);
const styles = {
    "chevron": "l5wGwa_chevron",
    "introChar": "l5wGwa_introChar",
    "introIcon": "l5wGwa_introIcon",
    "introText": "l5wGwa_introText",
    "item": "l5wGwa_item",
    "itemDesc": "l5wGwa_itemDesc",
    "itemName": "l5wGwa_itemName",
    "seat": "l5wGwa_seat",
    "seat-char-in": "l5wGwa_seat-char-in",
    "seat-icon-in": "l5wGwa_seat-icon-in",
    "seatIcon": "l5wGwa_seatIcon"
};
exports.default = styles;

},
"src/modules/agent-preset/AgentPresetSeat.css": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetSeat.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".l5wGwa_seat{max-width:min(100%,240px);min-height:28px;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;overflow:hidden}.l5wGwa_seat:not(:disabled):hover,.l5wGwa_seat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.l5wGwa_seat:disabled{cursor:default;color:var(--dsw-alias-label-quaternary)}.l5wGwa_seatIcon{color:var(--dsw-alias-label-primary);flex:none}.l5wGwa_introIcon{animation:.15s cubic-bezier(.16,1,.3,1) both l5wGwa_seat-icon-in}@keyframes l5wGwa_seat-icon-in{0%{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}.l5wGwa_introText{white-space:pre;display:inline-block}.l5wGwa_introChar{white-space:pre;opacity:0;animation:.4s ease-out forwards l5wGwa_seat-char-in;display:inline-block}@keyframes l5wGwa_seat-char-in{0%{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){.l5wGwa_introIcon,.l5wGwa_introChar{opacity:1;animation:none}}.l5wGwa_chevron{color:var(--dsw-alias-label-caption);flex:none}.l5wGwa_item{flex-direction:column;gap:2px;max-width:280px;display:flex}.l5wGwa_itemName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.l5wGwa_itemDesc{color:var(--dsw-alias-label-caption);white-space:normal;font-size:12px;line-height:16px}";

},
"src/modules/agent-preset/AgentPresetSection.styles.js": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetSection.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AgentPresetSection_css_1 = __importDefault(require("./AgentPresetSection.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-agent-preset/AgentPresetSection.module.css", "@xharness/dsh-client-ui-agent-preset", AgentPresetSection_css_1.default);
const styles = {
    "badge": "_3zrGGG_badge",
    "brokenBadge": "_3zrGGG_brokenBadge",
    "card": "_3zrGGG_card",
    "cardActive": "_3zrGGG_cardActive",
    "cardBroken": "_3zrGGG_cardBroken",
    "cardBrokenReason": "_3zrGGG_cardBrokenReason",
    "cardDesc": "_3zrGGG_cardDesc",
    "cardFoot": "_3zrGGG_cardFoot",
    "cardHead": "_3zrGGG_cardHead",
    "cardId": "_3zrGGG_cardId",
    "cardMain": "_3zrGGG_cardMain",
    "cardName": "_3zrGGG_cardName",
    "cards": "_3zrGGG_cards",
    "creatorButton": "_3zrGGG_creatorButton",
    "deleteConfirm": "_3zrGGG_deleteConfirm",
    "deleteDialog": "_3zrGGG_deleteDialog",
    "dialog": "_3zrGGG_dialog",
    "dialogFields": "_3zrGGG_dialogFields",
    "error": "_3zrGGG_error",
    "field": "_3zrGGG_field",
    "fieldLabel": "_3zrGGG_fieldLabel",
    "group": "_3zrGGG_group",
    "groupHead": "_3zrGGG_groupHead",
    "iconButton": "_3zrGGG_iconButton",
    "iconDanger": "_3zrGGG_iconDanger",
    "inUse": "_3zrGGG_inUse",
    "input": "_3zrGGG_input",
    "intro": "_3zrGGG_intro",
    "revealedPath": "_3zrGGG_revealedPath",
    "revealedPathLabel": "_3zrGGG_revealedPathLabel",
    "secondaryButton": "_3zrGGG_secondaryButton",
    "section": "_3zrGGG_section",
    "title": "_3zrGGG_title",
    "viewerCode": "_3zrGGG_viewerCode"
};
exports.default = styles;

},
"src/modules/agent-preset/AgentPresetSection.css": function(module, exports, require) {
// source: src/modules/agent-preset/AgentPresetSection.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._3zrGGG_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}._3zrGGG_title{margin:0;font-size:18px;font-weight:600}._3zrGGG_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}._3zrGGG_group{flex-direction:column;gap:10px;display:flex}._3zrGGG_group+._3zrGGG_group{margin-top:20px}._3zrGGG_groupHead{letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;font-weight:600}._3zrGGG_cards{grid-template-columns:repeat(auto-fill,minmax(268px,1fr));grid-auto-rows:1fr;gap:12px;margin:0;padding:0;list-style:none;display:grid}._3zrGGG_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;flex-direction:column;transition:border-color .16s,background .16s;display:flex}._3zrGGG_card:hover:not(._3zrGGG_cardActive){border-color:var(--dsw-alias-label-dimmed)}._3zrGGG_cardActive{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-primary)}._3zrGGG_cardBroken,._3zrGGG_cardBroken:hover{border-color:var(--dsw-alias-state-error-primary)}._3zrGGG_brokenBadge{white-space:nowrap;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-3);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._3zrGGG_cardBrokenReason{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;font-size:12px;line-height:1.5}._3zrGGG_cardMain{appearance:none;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px 12px 0 0;flex-direction:column;flex:1;gap:8px;padding:14px 16px 12px;display:flex}._3zrGGG_cardMain:disabled{cursor:default}._3zrGGG_cardMain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._3zrGGG_cardHead{align-items:center;gap:8px;display:flex}._3zrGGG_cardName{font-size:15px;font-weight:600;line-height:1.4}._3zrGGG_badge,._3zrGGG_inUse{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._3zrGGG_badge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}._3zrGGG_inUse{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);margin-left:auto}._3zrGGG_cardDesc{color:var(--dsw-alias-label-secondary);-webkit-line-clamp:4;overflow-wrap:anywhere;-webkit-box-orient:vertical;min-height:42px;font-size:13px;line-height:1.55;display:-webkit-box;overflow:hidden}._3zrGGG_cardId{font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);color:var(--dsw-alias-label-dimmed);margin-top:auto;font-size:11px}._3zrGGG_cardFoot{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;gap:2px;padding:6px 10px;display:flex}._3zrGGG_iconButton{appearance:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:7px;align-items:center;padding:6px;display:inline-flex;position:relative}._3zrGGG_iconButton:disabled{opacity:.4;cursor:default}._3zrGGG_iconButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}._3zrGGG_iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}._3zrGGG_iconButton:after{content:attr(data-tip);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);white-space:nowrap;opacity:0;pointer-events:none;border-radius:6px;padding:3px 8px;font-size:11px;line-height:17px;transition:opacity .12s;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translate(-50%)}._3zrGGG_iconButton:hover:after,._3zrGGG_iconButton:focus-visible:after{opacity:1}._3zrGGG_iconDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}._3zrGGG_revealedPath{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:6px;margin:0;padding:6px 16px 10px;font-size:11px;display:flex}._3zrGGG_revealedPath code{font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);color:var(--dsw-alias-label-secondary);user-select:all;overflow-wrap:anywhere}._3zrGGG_revealedPathLabel{white-space:nowrap}._3zrGGG_secondaryButton{color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:7px;padding:5px 8px;font-size:12.5px}._3zrGGG_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}._3zrGGG_secondaryButton:disabled{opacity:.5;cursor:default}._3zrGGG_field{flex-direction:column;gap:6px;display:flex}._3zrGGG_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}._3zrGGG_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:9px 12px;font-size:13px}._3zrGGG_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}._3zrGGG_input::placeholder{color:var(--dsw-alias-label-dimmed)}._3zrGGG_dialog{width:min(560px,100%)}._3zrGGG_dialogFields{flex-direction:column;gap:12px;display:flex}._3zrGGG_viewerCode{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);max-height:min(52vh,480px);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);white-space:pre;tab-size:2;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:10px;margin:0;padding:12px;font-size:12.5px;line-height:1.5;overflow:auto}._3zrGGG_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}._3zrGGG_deleteDialog{width:min(480px,100%)}._3zrGGG_deleteConfirm:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}._3zrGGG_deleteConfirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}._3zrGGG_creatorButton{box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3);height:44px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:12px;justify-content:center;align-self:stretch;align-items:center;gap:6px;font-size:14px;line-height:22px;display:flex}._3zrGGG_creatorButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._3zrGGG_creatorButton:disabled{opacity:.4;cursor:default}";

},
"src/modules/agent-preset/seat-store.js": function(module, exports, require) {
// source: src/modules/agent-preset/seat-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPresetSeatController = void 0;
const client_1 = require("@xharness/dsh-client-runtime/client");
const settings_store_1 = require("./settings-store");
const INITIAL = {
    options: [], current: '', error: null, busy: false, introduce: false,
};
/** Stages the next session's preset and applies it when one appears. */
class AgentPresetSeatController {
    constructor(api,
    /** The session the hero is about to hand over to, when there is one. */
    currentSession,
    /**
     * Publish an applied switch into the session list, so the header label
     * moves with the composition instead of waiting for the next full list
     * refresh. Optional: a harness that renders no list omits it.
     */
    onApplied) {
        this.api = api;
        this.currentSession = currentSession;
        this.onApplied = onApplied;
        /** Chip snapshot the renderer subscribes to. */
        this.store = (0, client_1.createSnapshotStore)(INITIAL);
        /**
         * The deployment default, so a consumed stage can fall back to it without
         * re-reading the roster.
         */
        this.fallback = '';
    }
    set(patch) {
        this.store.set({ ...this.store.getSnapshot(), ...patch });
    }
    /**
     * Read the roster and open the chip on the deployment default.
     * @returns once the snapshot reflects the host.
     */
    async load() {
        try {
            const response = await this.api.agentPresets.list({});
            if (!response.result.ok) {
                this.set({ error: response.result.error.message });
                return;
            }
            const { presets } = response.result.value;
            this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? '';
            this.set({
                options: (0, settings_store_1.presetOptions)(presets),
                // Staged pick first, then the composition the current session
                // already carries, then the deployment default. The middle term is
                // what keeps a late-landing load from regressing the display after
                // an applied stage was consumed — the chip mounts (and loads) only
                // once the flow's session is current, so the reply can arrive after
                // apply() already composed it.
                current: this.staged ?? this.currentSession()?.agentPreset ?? this.fallback,
                error: null,
            });
        }
        catch (error) {
            this.set({ error: (0, settings_store_1.messageOf)(error) });
        }
    }
    /**
     * Stage one preset for the next session, applying it immediately when a
     * blank session is already current.
     * @param id - the preset to stage.
     * @returns once the stage settled, and the apply too when one happened.
     */
    async select(id) {
        if (this.store.getSnapshot().busy)
            return;
        this.stage(id);
        await this.apply();
    }
    /**
     * Stage a pick WITHOUT the immediate apply, for a flow that starts the
     * receiving session after the pick (the settings section's creator entry).
     * `select()`'s immediate apply would meet the still-current running session
     * and drop the stage as unservable; staging alone leaves it for the
     * list-change applier, which fires when the started session becomes
     * current.
     * @param id - the preset to stage.
     * @param introduce - true when the stage came from another screen and the
     * chip should announce itself on the session it lands on.
     */
    stage(id, introduce = false) {
        this.staged = id;
        this.set({ current: id, error: null, introduce });
    }
    /** Acknowledge the introduction cue once the chip has played it. */
    introduced() {
        if (!this.store.getSnapshot().introduce)
            return;
        this.set({ introduce: false });
    }
    /**
     * Hand the staged choice to the current session, if there is one to take it.
     *
     * Called both by `select()` and by whoever observes the current session
     * changing, because the session may appear either before or after the pick.
     * @returns once the switch settled, or immediately when there is nothing to do.
     */
    async apply() {
        const staged = this.staged;
        const session = this.currentSession();
        if (staged === undefined || session === undefined)
            return;
        // A started session's history was produced under its own composition; the
        // host refuses the swap, so the stage is no longer meaningful.
        if (!session.blank || session.agentPreset === staged) {
            this.staged = undefined;
            return;
        }
        this.set({ busy: true, error: null });
        try {
            const response = await this.api.agentPresets.select({ sessionId: session.id, agentPreset: staged });
            this.staged = undefined;
            if (!response.result.ok) {
                this.set({ busy: false, error: response.result.error.message, current: this.fallback });
                return;
            }
            // Consumed: the next new session opens on the deployment default again.
            this.set({ busy: false, current: response.result.value.agentPreset });
            this.onApplied?.(session.id, response.result.value.agentPreset);
        }
        catch (error) {
            this.staged = undefined;
            this.set({ busy: false, error: (0, settings_store_1.messageOf)(error), current: this.fallback });
        }
    }
}
exports.AgentPresetSeatController = AgentPresetSeatController;

},
"src/modules/agent-preset/settings-store.js": function(module, exports, require) {
// source: src/modules/agent-preset/settings-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPresetSettingsController = exports.AGENT_PRESET_SETTINGS_NS = void 0;
exports.messageOf = messageOf;
exports.writeDefaultPreset = writeDefaultPreset;
exports.readRoster = readRoster;
exports.beginRosterRead = beginRosterRead;
exports.presetOptions = presetOptions;
const client_1 = require("@xharness/dsh-client-runtime/client");
/** The agent-preset settings namespace on the host wire. */
exports.AGENT_PRESET_SETTINGS_NS = 'agent-presets';
/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the surface still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Persist one preset as the default for sessions created later.
 *
 * The default is a settings field rather than a preset property, so both the
 * General row and the management section write it here — one home for which
 * namespace and field the host resolves at session creation.
 * @param api - the settings wire face.
 * @param id - the preset to make default.
 * @returns the failure message, or undefined once the write landed.
 */
async function writeDefaultPreset(api, id) {
    let response;
    try {
        response = await api.settings.update({ ns: exports.AGENT_PRESET_SETTINGS_NS, patch: { default: id } });
    }
    catch (error) {
        // The transport rejected rather than answering; the caller must be able to
        // say so instead of the row silently snapping back.
        return messageOf(error);
    }
    return response.result.ok ? undefined : response.result.error.message;
}
/**
 * Read the roster, folding both refusal shapes into one message.
 *
 * The wire refuses in two ways — the transport rejects, or it answers an
 * `ok: false` envelope — and every surface treats them identically. Folding
 * them here keeps each store's `load` about what it does with a roster rather
 * than about how the call can fail.
 * @param api - the agent-preset wire face.
 * @returns the roster, or the message to show in its place.
 */
async function readRoster(api) {
    try {
        const response = await api.agentPresets.list({});
        return response.result.ok
            ? { ok: true, value: response.result.value }
            : { ok: false, error: response.result.error.message };
    }
    catch (error) {
        return { ok: false, error: messageOf(error) };
    }
}
/**
 * The opening move every roster-backed surface makes: refuse a read that is
 * already in flight, mark the store loading, then read.
 *
 * A surface that gets `undefined` returns without touching its snapshot
 * further — either another read owns it, or this one already wrote the
 * failure. What differs between surfaces starts after this.
 * @param api - the agent-preset wire face.
 * @param store - the surface's own snapshot store.
 * @returns the roster, or undefined when the caller should return.
 */
async function beginRosterRead(api, store) {
    const before = store.getSnapshot();
    if (before.status === 'loading')
        return undefined;
    store.set({ ...before, status: 'loading', error: null });
    const roster = await readRoster(api);
    if (roster.ok)
        return roster.value;
    store.set({ ...store.getSnapshot(), status: 'error', error: roster.error });
    return undefined;
}
/**
 * The roster entries as the pickers render them: healthy presets only.
 *
 * The chip and the row exist to choose the NEXT session's composition, and a
 * broken preset cannot compose one — offering it would defer the discovery
 * of that fact to a failed session start. The management section renders the
 * full roster (broken rows included) from its own store instead.
 *
 * The chip, the row, and the management section all show the same facts, and
 * `exactOptionalPropertyTypes` makes "absent" and "present as undefined"
 * different shapes — so the spread dance belongs in one place rather than
 * once per store.
 * @param presets - the roster the host answered with.
 * @returns one option per selectable preset, in roster order.
 */
function presetOptions(presets) {
    return presets.filter(preset => preset.broken === undefined).map(preset => ({
        id: preset.id,
        trust: preset.trust,
        ...preset.name === undefined ? {} : { name: preset.name },
        ...preset.description === undefined ? {} : { description: preset.description },
    }));
}
const INITIAL = {
    status: 'idle',
    error: null,
    // Assumed until `load()` asks; a row that has not read yet renders nothing
    // interactive anyway (status 'idle').
    writable: true,
    currentValue: '',
    options: [],
};
/** Reads the roster and persists the chosen default. */
class AgentPresetSettingsController {
    /**
     * @param api - the agent-preset and settings wire faces (roster and default write).
     * @param describeFace - the shared mirror's describe face (writability source).
     */
    constructor(api, describeFace) {
        this.api = api;
        this.describeFace = describeFace;
        /** Row snapshot the renderer subscribes to. */
        this.store = (0, client_1.createSnapshotStore)(INITIAL);
    }
    set(patch) {
        this.store.set({ ...this.store.getSnapshot(), ...patch });
    }
    /**
     * Load the roster. An empty roster means the deployment composes no
     * presets, which is a valid deployment rather than a failure — the row
     * reports `unavailable` and renders nothing.
     * @returns once the snapshot reflects the host.
     */
    async load() {
        const roster = await beginRosterRead(this.api, this.store);
        if (roster === undefined)
            return;
        const { presets } = roster;
        const [first] = presets;
        if (first === undefined) {
            this.set({ status: 'unavailable', options: [], currentValue: '' });
            return;
        }
        // The roster says what may be chosen; the shared mirror says whether this
        // browser may write the choice down. A non-loopback browser's mirror never
        // answers, so the row stays read-only rather than offering a control
        // whose write the Host would refuse.
        await this.describeFace.ensure();
        this.set({
            status: 'ready',
            error: null,
            writable: this.describeFace.getSnapshot().view?.writable ?? false,
            options: presetOptions(presets),
            // A roster can mark nothing default: settings can name a preset that
            // was since deleted, and the picker still has to show something.
            currentValue: presets.find(preset => preset.isDefault)?.id ?? first.id,
        });
    }
    /**
     * Persist one preset as the default for sessions created later. Running
     * sessions keep the composition they were created with, so this never
     * disturbs work in progress.
     * @param id - the preset to make default.
     * @returns once the write settled and the roster was re-read.
     */
    async select(id) {
        const before = this.store.getSnapshot();
        if (before.status === 'saving' || id === before.currentValue)
            return;
        this.set({ status: 'saving', error: null, currentValue: id });
        const failure = await writeDefaultPreset(this.api, id);
        if (failure !== undefined) {
            this.set({ status: 'ready', currentValue: before.currentValue, error: failure });
            return;
        }
        // Re-read rather than trust the patch: the host resolves the default
        // through the same roster the row displays.
        await this.load();
    }
}
exports.AgentPresetSettingsController = AgentPresetSettingsController;

},
"src/modules/agent-preset/section-store.js": function(module, exports, require) {
// source: src/modules/agent-preset/section-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPresetSectionController = void 0;
exports.draftBlocker = draftBlocker;
const client_1 = require("@xharness/dsh-client-runtime/client");
const settings_store_1 = require("./settings-store");
/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;
const INITIAL = {
    status: 'idle',
    error: null,
    authorable: false,
    hasDocument: false,
    rows: [],
    copy: null,
    view: null,
    pendingDelete: null,
    deleting: false,
    revealedPaths: {},
};
/**
 * Why this copy cannot be submitted yet, as a locale key, or undefined when
 * it can. Client-side only: the host re-checks the id and its answer is what
 * the dialog reports on failure.
 * @param draft - the open copy dialog.
 * @param rows - the roster, for the collision check.
 * @returns the blocking reason's locale key, or undefined when submittable.
 */
function draftBlocker(draft, rows) {
    if (draft.id === '')
        return 'idRequired';
    if (!PRESET_ID.test(draft.id))
        return 'idInvalid';
    // A copy never overwrites: landing on a name already in use would replace
    // something the user did not open.
    if (rows.some(row => row.id === draft.id))
        return 'idTaken';
    return undefined;
}
/** Reads the roster and drives the copy dialog, viewer, and location reveals. */
class AgentPresetSectionController {
    constructor(api,
    /**
     * Called after this page changes the roster DIRECTORY, so the other
     * surfaces reading the same roster re-read it. A settings field moving is
     * already announced by the host through the forwarded
     * `settings/document-updated`; a directory copied or deleted here is not,
     * and the new-session chip has no other way to learn a preset it should
     * offer now exists.
     */
    rosterChanged = () => { }) {
        this.api = api;
        this.rosterChanged = rosterChanged;
        /** Page snapshot the renderer subscribes to. */
        this.store = (0, client_1.createSnapshotStore)(INITIAL);
    }
    set(patch) {
        this.store.set({ ...this.store.getSnapshot(), ...patch });
    }
    patchCopy(patch) {
        const { copy } = this.store.getSnapshot();
        if (copy === null)
            return;
        this.set({ copy: { ...copy, ...patch } });
    }
    /**
     * Load the roster. An empty roster means the deployment composes no
     * presets, which is a valid deployment rather than a failure — the section
     * reports `unavailable` and renders nothing.
     * @returns once the snapshot reflects the host.
     */
    async load() {
        const roster = await (0, settings_store_1.beginRosterRead)(this.api, this.store);
        if (roster === undefined)
            return;
        const { presets, authorable, hasDocument } = roster;
        if (presets.length === 0) {
            // Nothing to manage leaves nothing to keep a dialog open over.
            this.set({ status: 'unavailable', rows: [], authorable, hasDocument, copy: null, view: null });
            return;
        }
        // A reveal outlives a reload but not its preset: a path for a row the
        // roster no longer lists would be a claim about a directory that is gone.
        const revealed = this.store.getSnapshot().revealedPaths;
        const kept = Object.fromEntries(Object.entries(revealed).filter(([id]) => presets.some(preset => preset.id === id)));
        this.set({
            status: 'ready',
            error: null,
            authorable,
            hasDocument,
            rows: presets.map(preset => ({ ...preset })),
            revealedPaths: kept,
        });
    }
    /**
     * Open one shipped preset's composition in the read-only viewer.
     * @param id - the preset to view.
     * @returns once the composition loaded or the failure is on the page.
     */
    async view(id) {
        this.set({ error: null });
        try {
            const response = await this.api.agentPresets.read({ agentPreset: id });
            if (!response.result.ok) {
                this.set({ error: response.result.error.message });
                return;
            }
            const { name, content } = response.result.value;
            this.set({ view: { id, title: name ?? id, content } });
        }
        catch (error) {
            this.set({ error: (0, settings_store_1.messageOf)(error) });
        }
    }
    /** Close the read-only viewer. */
    closeView() {
        this.set({ view: null });
    }
    /**
     * Open the copy dialog over one preset.
     * @param from - the preset the copy will start from.
     */
    beginCopy(from) {
        const row = this.store.getSnapshot().rows.find(candidate => candidate.id === from);
        this.set({
            error: null,
            copy: { from, fromTitle: row?.name ?? from, id: '', name: '', saving: false, error: null },
        });
    }
    /** Close the copy dialog, discarding whatever was typed. */
    cancelCopy() {
        this.set({ copy: null });
    }
    /**
     * Name the preset the copy creates.
     * @param id - the id typed into the dialog.
     */
    setCopyId(id) {
        this.patchCopy({ id, error: null });
    }
    /**
     * Name the copy's display name.
     * @param name - the display name typed into the dialog.
     */
    setCopyName(name) {
        this.patchCopy({ name, error: null });
    }
    /**
     * Submit the copy, re-read the roster, then take the user to the new
     * preset's files — the directory opens where the host has a desktop, and
     * its path appears on the new row where it does not.
     * @returns once the copy settled and the page reflects it.
     */
    async confirmCopy() {
        const draft = this.store.getSnapshot().copy;
        if (draft === null || draft.saving)
            return;
        if (draftBlocker(draft, this.store.getSnapshot().rows) !== undefined)
            return;
        this.patchCopy({ saving: true, error: null });
        try {
            const name = draft.name.trim();
            const response = await this.api.agentPresets.copy({
                from: draft.from,
                agentPreset: draft.id,
                ...name === '' ? {} : { name },
            });
            if (!response.result.ok) {
                this.patchCopy({ saving: false, error: response.result.error.message });
                return;
            }
            this.set({ copy: null });
            await this.load();
            this.rosterChanged();
            // A preset is its files from here on (the dialog collected nothing
            // else), so landing in them is the completion, not a follow-up.
            await this.openLocation(draft.id);
        }
        catch (error) {
            this.patchCopy({ saving: false, error: (0, settings_store_1.messageOf)(error) });
        }
    }
    /**
     * Open one preset's directory on the host desktop, or reveal its path on
     * the row where the deployment has no opener to hand it to.
     * @param id - the preset whose files the user wants.
     * @returns once the host answered and the page reflects it.
     */
    async openLocation(id) {
        try {
            const response = await this.api.agentPresets.openDocument({ agentPreset: id });
            if (!response.result.ok) {
                this.set({ error: response.result.error.message });
                return;
            }
            if (response.result.value.opened)
                return;
            const { path } = response.result.value;
            this.set({ revealedPaths: { ...this.store.getSnapshot().revealedPaths, [id]: path } });
        }
        catch (error) {
            this.set({ error: (0, settings_store_1.messageOf)(error) });
        }
    }
    /**
     * Ask for confirmation before deleting one preset.
     * @param id - the preset to delete, or null to dismiss the confirmation.
     */
    confirmDelete(id) {
        if (this.store.getSnapshot().deleting)
            return;
        this.set({ pendingDelete: id });
    }
    /**
     * Delete the preset awaiting confirmation, then re-read the roster.
     *
     * A session already composed from it keeps running: its composition was
     * mounted at creation and nothing re-reads the file.
     * @returns once the delete settled and the page reflects it.
     */
    async remove() {
        const { pendingDelete, deleting } = this.store.getSnapshot();
        if (pendingDelete === null || deleting)
            return;
        this.set({ deleting: true, error: null });
        try {
            const response = await this.api.agentPresets.remove({ agentPreset: pendingDelete });
            if (!response.result.ok) {
                this.set({ deleting: false, pendingDelete: null, error: response.result.error.message });
                return;
            }
            this.set({ deleting: false, pendingDelete: null });
            await this.load();
            this.rosterChanged();
        }
        catch (error) {
            this.set({ deleting: false, pendingDelete: null, error: (0, settings_store_1.messageOf)(error) });
        }
    }
    /**
     * Make one preset the default for sessions created later. Running sessions
     * keep the composition they began with, so this never disturbs work.
     * @param id - the preset to make default.
     * @returns once the write settled and the roster was re-read.
     */
    async makeDefault(id) {
        const failure = await (0, settings_store_1.writeDefaultPreset)(this.api, id);
        if (failure !== undefined) {
            this.set({ error: failure });
            return;
        }
        await this.load();
    }
}
exports.AgentPresetSectionController = AgentPresetSectionController;

},
"src/modules/agent-preset/locales.js": function(module, exports, require) {
// source: src/modules/agent-preset/locales.ts

"use strict";
/** Locale bundles for the agent-preset settings row, hero chip, header label, and management section. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = void 0;
exports.presetDisplayText = presetDisplayText;
/** English copy. */
exports.en = {
    title: 'Agent preset',
    description: 'Applies to sessions you start from now on. Running sessions keep the preset they began with.',
    loading: 'Loading presets…',
    error: 'Could not load agent presets.',
    userTrust: 'Custom',
    seatHint: 'Agent preset for the session you are about to start',
    headerHint: 'The agent preset this session runs, fixed when it started',
    nav: 'Agent presets',
    sectionIntro: 'A preset is the plugin composition one session\'s agent runs — its tools, prompt, and capabilities. '
        + 'Duplicate an existing one and make it yours, or let the agent draft one for you in Creator mode.',
    builtIn: 'Built-in',
    setDefault: 'Set as default',
    view: 'View',
    presetStandardName: 'Standard mode',
    presetStandardDescription: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
    presetCodeName: 'PTC mode',
    presetCodeDescription: 'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.',
    presetMinimalName: 'Minimal mode',
    presetMinimalDescription: 'Two-tool coding agent with persistent bash and str_replace_editor.',
    presetCordisName: 'Creator mode',
    presetCordisDescription: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
    duplicate: 'Duplicate',
    duplicateUnavailable: 'This deployment has no writable preset directory',
    delete: 'Delete',
    presetId: 'Identifier',
    presetIdPlaceholder: 'my-agent',
    displayName: 'Name',
    displayNamePlaceholder: 'Shown in the picker; defaults to the identifier',
    inUse: 'In use',
    builtInGroup: 'Built-in',
    customGroup: 'Custom',
    noDescription: 'No description.',
    brokenBadge: 'Failed to load',
    brokenNoCopy: 'A preset that failed to load cannot be duplicated',
    copyOf: 'Copied from',
    composition: 'Composition (agent.cordis.yml)',
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Retry',
    copyTitle: 'Duplicate preset',
    copyIntro: 'The whole preset is copied on this machine. The identifier becomes its directory name and cannot '
        + 'be changed later; everything else is edited in the preset\'s own files.',
    create: 'Create',
    creating: 'Creating…',
    creatorDraft: 'Draft a custom preset with Creator mode',
    openLocation: 'Open folder',
    showLocation: 'Show location',
    revealedPathLabel: 'Preset files:',
    idRequired: 'Give the preset an identifier.',
    idInvalid: 'Use lowercase letters, digits, and hyphens, starting with a letter or digit.',
    idTaken: 'A preset with this identifier already exists.',
    deleteTitle: 'Delete this preset?',
    deleteDescription: 'The preset directory is deleted. Sessions already running on it keep working; new sessions cannot select it.',
    deleteConfirm: 'Delete',
    deleting: 'Deleting…',
};
/** Simplified Chinese copy. */
exports.zh = {
    title: 'Agent 预设',
    description: '对此后新建的会话生效。运行中的会话保持它开始时的预设。',
    loading: '正在加载预设…',
    error: '无法加载 Agent 预设。',
    userTrust: '自定义',
    seatHint: '即将开始的这个会话所用的 Agent 预设',
    headerHint: '本会话运行的 Agent 预设，开始时即固定',
    nav: 'Agent 预设',
    sectionIntro: '预设即一个会话的 Agent 所运行的插件组装 —— 它的工具、提示词与能力。复制一份既有预设改成自己的，或用「创造模式」让 Agent 帮你创建。',
    builtIn: '内置',
    setDefault: '设为默认',
    view: '查看',
    presetStandardName: '标准模式',
    presetStandardDescription: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    presetCodeName: 'PTC 模式',
    presetCodeDescription: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
    presetMinimalName: '极简模式',
    presetMinimalDescription: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。',
    presetCordisName: '创造模式',
    presetCordisDescription: '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。',
    duplicate: '复制',
    duplicateUnavailable: '此部署未配置可写的预设目录',
    delete: '删除',
    presetId: '标识符',
    presetIdPlaceholder: 'my-agent',
    displayName: '名称',
    displayNamePlaceholder: '选择器中显示的名字，缺省用标识符',
    inUse: '当前使用',
    builtInGroup: '内置',
    customGroup: '自定义',
    noDescription: '暂无描述。',
    brokenBadge: '加载失败',
    brokenNoCopy: '预设加载失败，不能复制',
    copyOf: '复制自',
    composition: '组装（agent.cordis.yml）',
    cancel: '取消',
    close: '关闭',
    retry: '重试',
    copyTitle: '复制预设',
    copyIntro: '整个预设会在本机复制一份。标识符将成为目录名，事后无法更改；其余内容之后直接在预设自己的文件里编辑。',
    create: '创建',
    creating: '正在创建…',
    creatorDraft: '用「创造模式」创作自定义预设',
    openLocation: '打开目录',
    showLocation: '查看路径',
    revealedPathLabel: '预设文件：',
    idRequired: '请填写标识符。',
    idInvalid: '只能使用小写字母、数字与连字符，且以字母或数字开头。',
    idTaken: '该标识符已被占用。',
    deleteTitle: '删除该预设？',
    deleteDescription: '预设目录将被删除。已在其上运行的会话不受影响；新会话将无法再选择它。',
    deleteConfirm: '删除',
    deleting: '正在删除…',
};
const BUILT_IN_PRESET_KEYS = {
    standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
    code: { name: 'presetCodeName', description: 'presetCodeDescription' },
    minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
    cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
};
/**
 * Resolve preset display copy without making user-authored metadata translatable.
 * @param preset - roster row whose copy is being rendered.
 * @param t - active Web locale lookup.
 * @returns localized copy for a known shipped preset, otherwise file metadata.
 */
function presetDisplayText(preset, t) {
    const keys = preset.trust === 'system' ? BUILT_IN_PRESET_KEYS[preset.id] : undefined;
    if (keys !== undefined)
        return { name: t(keys.name), description: t(keys.description) };
    return {
        name: preset.name ?? preset.id,
        ...preset.description === undefined ? {} : { description: preset.description },
    };
}

}
};
const __dependencies = {"src/modules/agent-preset/index.js":{"./AgentPresetLabel.styles":"src/modules/agent-preset/AgentPresetLabel.styles.js","./AgentPresetRow.styles":"src/modules/agent-preset/AgentPresetRow.styles.js","./AgentPresetSeat.styles":"src/modules/agent-preset/AgentPresetSeat.styles.js","./AgentPresetSection.styles":"src/modules/agent-preset/AgentPresetSection.styles.js","./seat-store":"src/modules/agent-preset/seat-store.js","./section-store":"src/modules/agent-preset/section-store.js","./locales":"src/modules/agent-preset/locales.js","./settings-store":"src/modules/agent-preset/settings-store.js"},"src/modules/agent-preset/AgentPresetLabel.styles.js":{"./AgentPresetLabel.css":"src/modules/agent-preset/AgentPresetLabel.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/agent-preset/AgentPresetLabel.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/agent-preset/AgentPresetRow.styles.js":{"./AgentPresetRow.css":"src/modules/agent-preset/AgentPresetRow.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/agent-preset/AgentPresetRow.css":{},"src/modules/agent-preset/AgentPresetSeat.styles.js":{"./AgentPresetSeat.css":"src/modules/agent-preset/AgentPresetSeat.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/agent-preset/AgentPresetSeat.css":{},"src/modules/agent-preset/AgentPresetSection.styles.js":{"./AgentPresetSection.css":"src/modules/agent-preset/AgentPresetSection.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/agent-preset/AgentPresetSection.css":{},"src/modules/agent-preset/seat-store.js":{"./settings-store":"src/modules/agent-preset/settings-store.js"},"src/modules/agent-preset/settings-store.js":{},"src/modules/agent-preset/section-store.js":{"./settings-store":"src/modules/agent-preset/settings-store.js"},"src/modules/agent-preset/locales.js":{}};
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
return __load("src/modules/agent-preset/index.js");
}
});
