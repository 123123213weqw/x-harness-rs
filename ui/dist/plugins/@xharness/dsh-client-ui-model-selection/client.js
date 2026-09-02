// Generated from src/modules/model-selection/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-model-selection",
factory: (__externalRequire) => {
const __units = {
"src/modules/model-selection/index.js": function(module, exports, require) {
// source: src/modules/model-selection/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.xhReasoningStatus = exports.xhContextSelection = exports.xhModelInfo = exports.XHarnessModelSelect = exports.ModelDirectoryResolver = exports.ModelDirectory = void 0;
exports.apply = apply;
/// <reference path="./external.d.ts" />
const service_1 = require("./service");
const ModelSelect_1 = require("./ModelSelect");
const locales_1 = require("./locales");
var directory_1 = require("./directory");
Object.defineProperty(exports, "ModelDirectory", { enumerable: true, get: function () { return directory_1.ModelDirectory; } });
var service_2 = require("./service");
Object.defineProperty(exports, "ModelDirectoryResolver", { enumerable: true, get: function () { return service_2.ModelDirectoryResolver; } });
var ModelSelect_2 = require("./ModelSelect");
Object.defineProperty(exports, "XHarnessModelSelect", { enumerable: true, get: function () { return ModelSelect_2.XHarnessModelSelect; } });
var ContextPane_1 = require("./ContextPane");
Object.defineProperty(exports, "xhModelInfo", { enumerable: true, get: function () { return ContextPane_1.xhModelInfo; } });
Object.defineProperty(exports, "xhContextSelection", { enumerable: true, get: function () { return ContextPane_1.xhContextSelection; } });
Object.defineProperty(exports, "xhReasoningStatus", { enumerable: true, get: function () { return ContextPane_1.xhReasoningStatus; } });
const settings_navigation_1 = require("../shared/settings-navigation");
const NS = 'model';
function rowId(provider, model) { return `${provider}/${model}`; }
function optionsOf(directory, t) {
    const rows = [];
    for (const group of directory.groups)
        for (const model of group.models)
            rows.push({
                id: rowId(group.id, model.id), label: model.name,
                detail: model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
                ...(directory.current.provider === group.id && directory.current.model === model.id ? { active: true } : {}),
            });
    for (const failure of directory.failures)
        rows.push({ id: `failure/${failure.id}`, label: failure.name, detail: t('option.loadError', { message: failure.message }) });
    return rows;
}
function selectionOf(state, id) {
    for (const group of state.groups)
        for (const model of group.models) {
            if (rowId(group.id, model.id) !== id)
                continue;
            const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
            return { provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
        }
    return undefined;
}
exports.inject = ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote'];
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-model-selection: dictionaries');
    const t = ctx.locale.bind(NS);
    ctx.plugin(service_1.ModelDirectoryResolver, { blockReason: () => t('blocked.composer') });
    ctx.inject(['commandUi', 'modelDirectories'], scope => {
        const command = scope.get('commandUi'), models = scope.modelDirectories, sessions = scope.sessions;
        scope.effect(() => command.register({
            name: 'model', description: t('command.description'), available: session => sessions.subagentAddress(session.sessionId) === undefined,
            ui: { kind: 'popupSelect', options: async (session) => {
                    if (sessions.subagentAddress(session.sessionId) !== undefined)
                        throw new Error('model selection is unavailable for addressed subagent sessions');
                    return optionsOf(await models.directoryFor(session.sessionId).load(), t);
                }, onSelect: async (option, session) => {
                    if (sessions.subagentAddress(session.sessionId) !== undefined)
                        throw new Error('model selection is unavailable for addressed subagent sessions');
                    const directory = models.directoryFor(session.sessionId);
                    const selection = selectionOf(directory.store.getSnapshot(), option.id);
                    if (selection === undefined)
                        throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
                    await directory.select(selection);
                } },
        }), 'ui-model-selection: /model contribution');
    });
    ctx.inject(['slots', 'modelDirectories'], scope => {
        const models = scope.modelDirectories, sessions = scope.sessions;
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
            name: 'conversation.input.model', locale: NS, inject: (sessionId) => {
                const directory = models.directoryFor(sessionId), available = sessions.subagentAddress(sessionId) === undefined;
                return { available, directory: directory.store, manageModels: () => { ctx.emit(settings_navigation_1.OPEN_SETTINGS_SECTION, 'models'); },
                    load: (refreshCapabilities = false) => { if (available)
                        return directory.load(refreshCapabilities).catch(() => { }); },
                    select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
                };
            },
        }, ModelSelect_1.XHarnessModelSelect));
    });
}

},
"src/modules/model-selection/service.js": function(module, exports, require) {
// source: src/modules/model-selection/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelDirectoryResolver = void 0;
const core_context_1 = require("./core-context");
const cordis_1 = require("@xharness/cordis");
const directory_1 = require("./directory");
// Cordis is dynamically injected; narrow its constructor to the context this
// service actually consumes, rather than leaking its open service registry.
const ContextService = cordis_1.Service;
class ModelDirectoryResolver extends ContextService {
    constructor(ctx, config) {
        super((0, core_context_1.requireCoreContext)(ctx), 'modelDirectories');
        this.live = { directories: new Map() };
        this.blockReason = config.blockReason;
        ctx.on('connection/reset', () => { for (const directory of this.live.directories.values())
            directory.resetConnected(); });
        const refresh = () => { for (const directory of this.live.directories.values())
            void directory.load().catch(() => { }); };
        ctx.remote.$on('llm/adapters-updated', refresh);
        ctx.remote.$on('settings/document-updated', refresh);
    }
    directoryFor(sessionId) {
        const existing = this.live.directories.get(sessionId);
        if (existing !== undefined)
            return existing;
        const sessions = this.ctx.get('sessions');
        if (!(0, core_context_1.isSessions)(sessions))
            throw new Error('model-selection sessions service is unavailable');
        const scope = sessions.scope(sessionId);
        if (scope === undefined)
            throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`);
        const connection = this.ctx.get('connection');
        if (!(0, core_context_1.isConnection)(connection))
            throw new Error('model-selection connection service is unavailable');
        const directory = new directory_1.ModelDirectory(connection.api.sessions, sessionId, () => sessions.subagentAddress(sessionId) === undefined);
        this.live.directories.set(sessionId, directory);
        const conversation = this.ctx.get('conversation');
        if ((0, core_context_1.isConversation)(conversation)) {
            const publish = () => conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false ? { reason: this.blockReason() } : undefined);
            publish();
            scope.effect(() => {
                const stop = directory.store.subscribe(publish);
                return () => { stop(); conversation.blocks.set(sessionId, undefined); };
            }, 'ui-model-selection: composer block');
        }
        scope.effect(() => () => { directory.dispose(); this.live.directories.delete(sessionId); }, 'ui-model-selection: session directory');
        return directory;
    }
}
exports.ModelDirectoryResolver = ModelDirectoryResolver;
ModelDirectoryResolver.inject = ['connection', 'sessions', 'remote'];

},
"src/modules/model-selection/core-context.js": function(module, exports, require) {
// source: src/modules/model-selection/core-context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCoreContext = requireCoreContext;
exports.isSessions = isSessions;
exports.isConnection = isConnection;
exports.isConversation = isConversation;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
function requireCoreContext(value) {
    if (!cordis_1.Context.is(value))
        throw new Error('model-selection requires a Cordis Context');
    return value;
}
function isSessions(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.scope === 'function' && typeof value.subagentAddress === 'function';
}
function isConnection(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && (0, runtime_types_1.isObjectRecord)(value.api) && (0, runtime_types_1.isObjectRecord)(value.api.sessions)
        && typeof value.api.sessions.models === 'function' && typeof value.api.sessions.selectModel === 'function';
}
function isConversation(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && (0, runtime_types_1.isObjectRecord)(value.blocks) && typeof value.blocks.set === 'function';
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
"src/modules/model-selection/directory.js": function(module, exports, require) {
// source: src/modules/model-selection/directory.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelDirectory = void 0;
const immer_1 = require("immer");
const client_1 = require("@xharness/dsh-client-runtime/client");
const runtime_types_1 = require("../shared/runtime-types");
const modelStore = client_1.createSnapshotStore;
/** Reports network errors only to the operation that still owns the directory. */
async function modelRequest(directory, generation, request) {
    try {
        return await request;
    }
    catch (error) {
        if (!directory.disposed && directory.generation === generation) {
            directory.store.update(state => { state.status = 'error'; state.error = (0, runtime_types_1.errorText)(error); });
        }
        throw error;
    }
}
/** Both /model and the composer resolve this same per-session state. */
class ModelDirectory {
    constructor(sessions, sessionId, available) {
        this.sessions = sessions;
        this.sessionId = sessionId;
        this.available = available;
        this.store = modelStore({
            current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
        });
        this.generation = 0;
        this.disposed = false;
    }
    async load(refreshCapabilities = false) {
        this.assertAvailable();
        const generation = ++this.generation;
        this.store.update(state => { state.status = 'loading'; state.error = null; });
        const { result } = await modelRequest(this, generation, this.sessions.models({ sessionId: this.sessionId, refreshCapabilities }));
        if (this.disposed || generation !== this.generation) {
            if (!result.ok)
                throw new Error(`${result.error.code}: ${result.error.message}`);
            return result.value;
        }
        if (!result.ok) {
            this.store.update(state => { state.status = 'error'; state.error = `${result.error.code}: ${result.error.message}`; });
            throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`);
        }
        const { current, routable, groups, failures } = result.value;
        this.store.update(state => {
            state.current = current;
            state.routable = routable;
            state.groups = (0, immer_1.castDraft)(groups);
            state.failures = (0, immer_1.castDraft)(failures);
            state.status = 'ready';
            state.error = null;
        });
        return result.value;
    }
    async select(selection) {
        this.assertAvailable();
        const generation = ++this.generation;
        this.store.update(state => { state.status = 'selecting'; state.error = null; });
        const { result } = await modelRequest(this, generation, this.sessions.selectModel({
            sessionId: this.sessionId, provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            ...(selection.contextWindowTokens === undefined ? {} : { contextWindowTokens: selection.contextWindowTokens }),
        }));
        if (this.disposed || generation !== this.generation) {
            if (!result.ok)
                throw new Error(`${result.error.code}: ${result.error.message}`);
            return;
        }
        if (!result.ok) {
            this.store.update(state => { state.status = 'error'; state.error = `${result.error.code}: ${result.error.message}`; });
            throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`);
        }
        this.store.update(state => { state.current = result.value.selected; state.routable = true; state.status = 'ready'; state.error = null; });
    }
    resetConnected() {
        if (this.disposed)
            return;
        ++this.generation;
        this.store.update(state => {
            state.current = null;
            state.routable = null;
            state.groups = [];
            state.failures = [];
            state.status = 'idle';
            state.error = null;
        });
        if (this.available())
            void this.load().catch(() => { });
    }
    dispose() { this.disposed = true; }
    assertAvailable() {
        if (!this.available())
            throw new Error('model selection is unavailable for addressed subagent sessions');
    }
}
exports.ModelDirectory = ModelDirectory;

},
"vendor/immer.js": function(module, exports, require) {
// source: vendor:immer@10.2.0

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/modules/client-runtime/vendor/immer/src/immer.ts
var immer_exports = {};
__export(immer_exports, {
  Immer: () => Immer2,
  applyPatches: () => applyPatches,
  castDraft: () => castDraft,
  castImmutable: () => castImmutable,
  createDraft: () => createDraft,
  current: () => current,
  enableMapSet: () => enableMapSet,
  enablePatches: () => enablePatches,
  finishDraft: () => finishDraft,
  freeze: () => freeze,
  immerable: () => DRAFTABLE,
  isDraft: () => isDraft,
  isDraftable: () => isDraftable,
  nothing: () => NOTHING,
  original: () => original,
  produce: () => produce,
  produceWithPatches: () => produceWithPatches,
  setAutoFreeze: () => setAutoFreeze,
  setUseStrictIteration: () => setUseStrictIteration,
  setUseStrictShallowCopy: () => setUseStrictShallowCopy
});
module.exports = __toCommonJS(immer_exports);

// src/modules/client-runtime/vendor/immer/src/utils/env.ts
var NOTHING = /* @__PURE__ */ Symbol.for("immer-nothing");
var DRAFTABLE = /* @__PURE__ */ Symbol.for("immer-draftable");
var DRAFT_STATE = /* @__PURE__ */ Symbol.for("immer-state");

// src/modules/client-runtime/vendor/immer/src/utils/errors.ts
function die(error, ...args) {
  if (false) {
    const e = errors[error];
    const msg = typeof e === "function" ? e.apply(null, args) : e;
    throw new Error(`[Immer] ${msg}`);
  }
  throw new Error(
    `[Immer] minified error nr: ${error}. Full error at: https://bit.ly/3cXEKWf`
  );
}

// src/modules/client-runtime/vendor/immer/src/utils/common.ts
var getPrototypeOf = Object.getPrototypeOf;
function isDraft(value) {
  return !!value && !!value[DRAFT_STATE];
}
function isDraftable(value) {
  if (!value) return false;
  return isPlainObject(value) || Array.isArray(value) || !!value[DRAFTABLE] || !!value.constructor?.[DRAFTABLE] || isMap(value) || isSet(value);
}
var objectCtorString = Object.prototype.constructor.toString();
var cachedCtorStrings = /* @__PURE__ */ new WeakMap();
function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const Ctor = Object.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  if (Ctor === Object) return true;
  if (typeof Ctor !== "function") return false;
  let ctorString = cachedCtorStrings.get(Ctor);
  if (ctorString === void 0) {
    ctorString = Function.toString.call(Ctor);
    cachedCtorStrings.set(Ctor, ctorString);
  }
  return ctorString === objectCtorString;
}
function original(value) {
  if (!isDraft(value)) die(15, value);
  return value[DRAFT_STATE].base_;
}
function each(obj, iter, strict = true) {
  if (getArchtype(obj) === 0 /* Object */) {
    const keys = strict ? Reflect.ownKeys(obj) : Object.keys(obj);
    keys.forEach((key) => {
      iter(key, obj[key], obj);
    });
  } else {
    obj.forEach((entry, index) => iter(index, entry, obj));
  }
}
function getArchtype(thing) {
  const state = thing[DRAFT_STATE];
  return state ? state.type_ : Array.isArray(thing) ? 1 /* Array */ : isMap(thing) ? 2 /* Map */ : isSet(thing) ? 3 /* Set */ : 0 /* Object */;
}
function has(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.has(prop) : Object.prototype.hasOwnProperty.call(thing, prop);
}
function get(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.get(prop) : thing[prop];
}
function set(thing, propOrOldValue, value) {
  const t = getArchtype(thing);
  if (t === 2 /* Map */) thing.set(propOrOldValue, value);
  else if (t === 3 /* Set */) {
    thing.add(value);
  } else thing[propOrOldValue] = value;
}
function is(x, y) {
  if (x === y) {
    return x !== 0 || 1 / x === 1 / y;
  } else {
    return x !== x && y !== y;
  }
}
function isMap(target) {
  return target instanceof Map;
}
function isSet(target) {
  return target instanceof Set;
}
function latest(state) {
  return state.copy_ || state.base_;
}
function shallowCopy(base, strict) {
  if (isMap(base)) {
    return new Map(base);
  }
  if (isSet(base)) {
    return new Set(base);
  }
  if (Array.isArray(base)) return Array.prototype.slice.call(base);
  const isPlain = isPlainObject(base);
  if (strict === true || strict === "class_only" && !isPlain) {
    const descriptors = Object.getOwnPropertyDescriptors(base);
    delete descriptors[DRAFT_STATE];
    let keys = Reflect.ownKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const desc = descriptors[key];
      if (desc.writable === false) {
        desc.writable = true;
        desc.configurable = true;
      }
      if (desc.get || desc.set)
        descriptors[key] = {
          configurable: true,
          writable: true,
          // could live with !!desc.set as well here...
          enumerable: desc.enumerable,
          value: base[key]
        };
    }
    return Object.create(getPrototypeOf(base), descriptors);
  } else {
    const proto = getPrototypeOf(base);
    if (proto !== null && isPlain) {
      return { ...base };
    }
    const obj = Object.create(proto);
    return Object.assign(obj, base);
  }
}
function freeze(obj, deep = false) {
  if (isFrozen(obj) || isDraft(obj) || !isDraftable(obj)) return obj;
  if (getArchtype(obj) > 1) {
    Object.defineProperties(obj, {
      set: dontMutateMethodOverride,
      add: dontMutateMethodOverride,
      clear: dontMutateMethodOverride,
      delete: dontMutateMethodOverride
    });
  }
  Object.freeze(obj);
  if (deep)
    Object.values(obj).forEach((value) => freeze(value, true));
  return obj;
}
function dontMutateFrozenCollections() {
  die(2);
}
var dontMutateMethodOverride = {
  value: dontMutateFrozenCollections
};
function isFrozen(obj) {
  if (obj === null || typeof obj !== "object") return true;
  return Object.isFrozen(obj);
}

// src/modules/client-runtime/vendor/immer/src/utils/plugins.ts
var plugins = {};
function getPlugin(pluginKey) {
  const plugin = plugins[pluginKey];
  if (!plugin) {
    die(0, pluginKey);
  }
  return plugin;
}
function loadPlugin(pluginKey, implementation) {
  if (!plugins[pluginKey]) plugins[pluginKey] = implementation;
}

// src/modules/client-runtime/vendor/immer/src/core/scope.ts
var currentScope;
function getCurrentScope() {
  return currentScope;
}
function createScope(parent_, immer_) {
  return {
    drafts_: [],
    parent_,
    immer_,
    // Whenever the modified draft contains a draft from another scope, we
    // need to prevent auto-freezing so the unowned draft can be finalized.
    canAutoFreeze_: true,
    unfinalizedDrafts_: 0
  };
}
function usePatchesInScope(scope, patchListener) {
  if (patchListener) {
    getPlugin("Patches");
    scope.patches_ = [];
    scope.inversePatches_ = [];
    scope.patchListener_ = patchListener;
  }
}
function revokeScope(scope) {
  leaveScope(scope);
  scope.drafts_.forEach(revokeDraft);
  scope.drafts_ = null;
}
function leaveScope(scope) {
  if (scope === currentScope) {
    currentScope = scope.parent_;
  }
}
function enterScope(immer2) {
  return currentScope = createScope(currentScope, immer2);
}
function revokeDraft(draft) {
  const state = draft[DRAFT_STATE];
  if (state.type_ === 0 /* Object */ || state.type_ === 1 /* Array */)
    state.revoke_();
  else state.revoked_ = true;
}

// src/modules/client-runtime/vendor/immer/src/core/finalize.ts
function processResult(result, scope) {
  scope.unfinalizedDrafts_ = scope.drafts_.length;
  const baseDraft = scope.drafts_[0];
  const isReplaced = result !== void 0 && result !== baseDraft;
  if (isReplaced) {
    if (baseDraft[DRAFT_STATE].modified_) {
      revokeScope(scope);
      die(4);
    }
    if (isDraftable(result)) {
      result = finalize(scope, result);
      if (!scope.parent_) maybeFreeze(scope, result);
    }
    if (scope.patches_) {
      getPlugin("Patches").generateReplacementPatches_(
        baseDraft[DRAFT_STATE].base_,
        result,
        scope.patches_,
        scope.inversePatches_
      );
    }
  } else {
    result = finalize(scope, baseDraft, []);
  }
  revokeScope(scope);
  if (scope.patches_) {
    scope.patchListener_(scope.patches_, scope.inversePatches_);
  }
  return result !== NOTHING ? result : void 0;
}
function finalize(rootScope, value, path) {
  if (isFrozen(value)) return value;
  const useStrictIteration = rootScope.immer_.shouldUseStrictIteration();
  const state = value[DRAFT_STATE];
  if (!state) {
    each(
      value,
      (key, childValue) => finalizeProperty(rootScope, state, value, key, childValue, path),
      useStrictIteration
    );
    return value;
  }
  if (state.scope_ !== rootScope) return value;
  if (!state.modified_) {
    maybeFreeze(rootScope, state.base_, true);
    return state.base_;
  }
  if (!state.finalized_) {
    state.finalized_ = true;
    state.scope_.unfinalizedDrafts_--;
    const result = state.copy_;
    let resultEach = result;
    let isSet2 = false;
    if (state.type_ === 3 /* Set */) {
      resultEach = new Set(result);
      result.clear();
      isSet2 = true;
    }
    each(
      resultEach,
      (key, childValue) => finalizeProperty(
        rootScope,
        state,
        result,
        key,
        childValue,
        path,
        isSet2
      ),
      useStrictIteration
    );
    maybeFreeze(rootScope, result, false);
    if (path && rootScope.patches_) {
      getPlugin("Patches").generatePatches_(
        state,
        path,
        rootScope.patches_,
        rootScope.inversePatches_
      );
    }
  }
  return state.copy_;
}
function finalizeProperty(rootScope, parentState, targetObject, prop, childValue, rootPath, targetIsSet) {
  if (childValue == null) {
    return;
  }
  if (typeof childValue !== "object" && !targetIsSet) {
    return;
  }
  const childIsFrozen = isFrozen(childValue);
  if (childIsFrozen && !targetIsSet) {
    return;
  }
  if (false)
    die(5);
  if (isDraft(childValue)) {
    const path = rootPath && parentState && parentState.type_ !== 3 /* Set */ && // Set objects are atomic since they have no keys.
    !has(parentState.assigned_, prop) ? rootPath.concat(prop) : void 0;
    const res = finalize(rootScope, childValue, path);
    set(targetObject, prop, res);
    if (isDraft(res)) {
      rootScope.canAutoFreeze_ = false;
    } else return;
  } else if (targetIsSet) {
    targetObject.add(childValue);
  }
  if (isDraftable(childValue) && !childIsFrozen) {
    if (!rootScope.immer_.autoFreeze_ && rootScope.unfinalizedDrafts_ < 1) {
      return;
    }
    if (parentState && parentState.base_ && parentState.base_[prop] === childValue && childIsFrozen) {
      return;
    }
    finalize(rootScope, childValue);
    if ((!parentState || !parentState.scope_.parent_) && typeof prop !== "symbol" && (isMap(targetObject) ? targetObject.has(prop) : Object.prototype.propertyIsEnumerable.call(targetObject, prop)))
      maybeFreeze(rootScope, childValue);
  }
}
function maybeFreeze(scope, value, deep = false) {
  if (!scope.parent_ && scope.immer_.autoFreeze_ && scope.canAutoFreeze_) {
    freeze(value, deep);
  }
}

// src/modules/client-runtime/vendor/immer/src/core/proxy.ts
function createProxyProxy(base, parent) {
  const isArray = Array.isArray(base);
  const state = {
    type_: isArray ? 1 /* Array */ : 0 /* Object */,
    // Track which produce call this is associated with.
    scope_: parent ? parent.scope_ : getCurrentScope(),
    // True for both shallow and deep changes.
    modified_: false,
    // Used during finalization.
    finalized_: false,
    // Track which properties have been assigned (true) or deleted (false).
    assigned_: {},
    // The parent draft state.
    parent_: parent,
    // The base state.
    base_: base,
    // The base proxy.
    draft_: null,
    // set below
    // The base copy with any updated values.
    copy_: null,
    // Called by the `produce` function.
    revoke_: null,
    isManual_: false
  };
  let target = state;
  let traps = objectTraps;
  if (isArray) {
    target = [state];
    traps = arrayTraps;
  }
  const { revoke, proxy } = Proxy.revocable(target, traps);
  state.draft_ = proxy;
  state.revoke_ = revoke;
  return proxy;
}
var objectTraps = {
  get(state, prop) {
    if (prop === DRAFT_STATE) return state;
    const source = latest(state);
    if (!has(source, prop)) {
      return readPropFromProto(state, source, prop);
    }
    const value = source[prop];
    if (state.finalized_ || !isDraftable(value)) {
      return value;
    }
    if (value === peek(state.base_, prop)) {
      prepareCopy(state);
      return state.copy_[prop] = createProxy(value, state);
    }
    return value;
  },
  has(state, prop) {
    return prop in latest(state);
  },
  ownKeys(state) {
    return Reflect.ownKeys(latest(state));
  },
  set(state, prop, value) {
    const desc = getDescriptorFromProto(latest(state), prop);
    if (desc?.set) {
      desc.set.call(state.draft_, value);
      return true;
    }
    if (!state.modified_) {
      const current2 = peek(latest(state), prop);
      const currentState = current2?.[DRAFT_STATE];
      if (currentState && currentState.base_ === value) {
        state.copy_[prop] = value;
        state.assigned_[prop] = false;
        return true;
      }
      if (is(value, current2) && (value !== void 0 || has(state.base_, prop)))
        return true;
      prepareCopy(state);
      markChanged(state);
    }
    if (state.copy_[prop] === value && // special case: handle new props with value 'undefined'
    (value !== void 0 || prop in state.copy_) || // special case: NaN
    Number.isNaN(value) && Number.isNaN(state.copy_[prop]))
      return true;
    state.copy_[prop] = value;
    state.assigned_[prop] = true;
    return true;
  },
  deleteProperty(state, prop) {
    if (peek(state.base_, prop) !== void 0 || prop in state.base_) {
      state.assigned_[prop] = false;
      prepareCopy(state);
      markChanged(state);
    } else {
      delete state.assigned_[prop];
    }
    if (state.copy_) {
      delete state.copy_[prop];
    }
    return true;
  },
  // Note: We never coerce `desc.value` into an Immer draft, because we can't make
  // the same guarantee in ES5 mode.
  getOwnPropertyDescriptor(state, prop) {
    const owner = latest(state);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc) return desc;
    return {
      writable: true,
      configurable: state.type_ !== 1 /* Array */ || prop !== "length",
      enumerable: desc.enumerable,
      value: owner[prop]
    };
  },
  defineProperty() {
    die(11);
  },
  getPrototypeOf(state) {
    return getPrototypeOf(state.base_);
  },
  setPrototypeOf() {
    die(12);
  }
};
var arrayTraps = {};
each(objectTraps, (key, fn) => {
  arrayTraps[key] = function() {
    arguments[0] = arguments[0][0];
    return fn.apply(this, arguments);
  };
});
arrayTraps.deleteProperty = function(state, prop) {
  if (false)
    die(13);
  return arrayTraps.set.call(this, state, prop, void 0);
};
arrayTraps.set = function(state, prop, value) {
  if (false)
    die(14);
  return objectTraps.set.call(this, state[0], prop, value, state[0]);
};
function peek(draft, prop) {
  const state = draft[DRAFT_STATE];
  const source = state ? latest(state) : draft;
  return source[prop];
}
function readPropFromProto(state, source, prop) {
  const desc = getDescriptorFromProto(source, prop);
  return desc ? `value` in desc ? desc.value : (
    // This is a very special case, if the prop is a getter defined by the
    // prototype, we should invoke it with the draft as context!
    desc.get?.call(state.draft_)
  ) : void 0;
}
function getDescriptorFromProto(source, prop) {
  if (!(prop in source)) return void 0;
  let proto = getPrototypeOf(source);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = getPrototypeOf(proto);
  }
  return void 0;
}
function markChanged(state) {
  if (!state.modified_) {
    state.modified_ = true;
    if (state.parent_) {
      markChanged(state.parent_);
    }
  }
}
function prepareCopy(state) {
  if (!state.copy_) {
    state.copy_ = shallowCopy(
      state.base_,
      state.scope_.immer_.useStrictShallowCopy_
    );
  }
}

// src/modules/client-runtime/vendor/immer/src/core/immerClass.ts
var Immer2 = class {
  constructor(config) {
    this.autoFreeze_ = true;
    this.useStrictShallowCopy_ = false;
    this.useStrictIteration_ = true;
    /**
     * The `produce` function takes a value and a "recipe function" (whose
     * return value often depends on the base state). The recipe function is
     * free to mutate its first argument however it wants. All mutations are
     * only ever applied to a __copy__ of the base state.
     *
     * Pass only a function to create a "curried producer" which relieves you
     * from passing the recipe function every time.
     *
     * Only plain objects and arrays are made mutable. All other objects are
     * considered uncopyable.
     *
     * Note: This function is __bound__ to its `Immer` instance.
     *
     * @param {any} base - the initial state
     * @param {Function} recipe - function that receives a proxy of the base state as first argument and which can be freely modified
     * @param {Function} patchListener - optional function that will be called with all the patches produced here
     * @returns {any} a new state, or the initial state if nothing was modified
     */
    this.produce = (base, recipe, patchListener) => {
      if (typeof base === "function" && typeof recipe !== "function") {
        const defaultBase = recipe;
        recipe = base;
        const self = this;
        return function curriedProduce(base2 = defaultBase, ...args) {
          return self.produce(base2, (draft) => recipe.call(this, draft, ...args));
        };
      }
      if (typeof recipe !== "function") die(6);
      if (patchListener !== void 0 && typeof patchListener !== "function")
        die(7);
      let result;
      if (isDraftable(base)) {
        const scope = enterScope(this);
        const proxy = createProxy(base, void 0);
        let hasError = true;
        try {
          result = recipe(proxy);
          hasError = false;
        } finally {
          if (hasError) revokeScope(scope);
          else leaveScope(scope);
        }
        usePatchesInScope(scope, patchListener);
        return processResult(result, scope);
      } else if (!base || typeof base !== "object") {
        result = recipe(base);
        if (result === void 0) result = base;
        if (result === NOTHING) result = void 0;
        if (this.autoFreeze_) freeze(result, true);
        if (patchListener) {
          const p = [];
          const ip = [];
          getPlugin("Patches").generateReplacementPatches_(base, result, p, ip);
          patchListener(p, ip);
        }
        return result;
      } else die(1, base);
    };
    this.produceWithPatches = (base, recipe) => {
      if (typeof base === "function") {
        return (state, ...args) => this.produceWithPatches(state, (draft) => base(draft, ...args));
      }
      let patches, inversePatches;
      const result = this.produce(base, recipe, (p, ip) => {
        patches = p;
        inversePatches = ip;
      });
      return [result, patches, inversePatches];
    };
    if (typeof config?.autoFreeze === "boolean")
      this.setAutoFreeze(config.autoFreeze);
    if (typeof config?.useStrictShallowCopy === "boolean")
      this.setUseStrictShallowCopy(config.useStrictShallowCopy);
    if (typeof config?.useStrictIteration === "boolean")
      this.setUseStrictIteration(config.useStrictIteration);
  }
  createDraft(base) {
    if (!isDraftable(base)) die(8);
    if (isDraft(base)) base = current(base);
    const scope = enterScope(this);
    const proxy = createProxy(base, void 0);
    proxy[DRAFT_STATE].isManual_ = true;
    leaveScope(scope);
    return proxy;
  }
  finishDraft(draft, patchListener) {
    const state = draft && draft[DRAFT_STATE];
    if (!state || !state.isManual_) die(9);
    const { scope_: scope } = state;
    usePatchesInScope(scope, patchListener);
    return processResult(void 0, scope);
  }
  /**
   * Pass true to automatically freeze all copies created by Immer.
   *
   * By default, auto-freezing is enabled.
   */
  setAutoFreeze(value) {
    this.autoFreeze_ = value;
  }
  /**
   * Pass true to enable strict shallow copy.
   *
   * By default, immer does not copy the object descriptors such as getter, setter and non-enumrable properties.
   */
  setUseStrictShallowCopy(value) {
    this.useStrictShallowCopy_ = value;
  }
  /**
   * Pass false to use faster iteration that skips non-enumerable properties
   * but still handles symbols for compatibility.
   *
   * By default, strict iteration is enabled (includes all own properties).
   */
  setUseStrictIteration(value) {
    this.useStrictIteration_ = value;
  }
  shouldUseStrictIteration() {
    return this.useStrictIteration_;
  }
  applyPatches(base, patches) {
    let i;
    for (i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.path.length === 0 && patch.op === "replace") {
        base = patch.value;
        break;
      }
    }
    if (i > -1) {
      patches = patches.slice(i + 1);
    }
    const applyPatchesImpl = getPlugin("Patches").applyPatches_;
    if (isDraft(base)) {
      return applyPatchesImpl(base, patches);
    }
    return this.produce(
      base,
      (draft) => applyPatchesImpl(draft, patches)
    );
  }
};
function createProxy(value, parent) {
  const draft = isMap(value) ? getPlugin("MapSet").proxyMap_(value, parent) : isSet(value) ? getPlugin("MapSet").proxySet_(value, parent) : createProxyProxy(value, parent);
  const scope = parent ? parent.scope_ : getCurrentScope();
  scope.drafts_.push(draft);
  return draft;
}

// src/modules/client-runtime/vendor/immer/src/core/current.ts
function current(value) {
  if (!isDraft(value)) die(10, value);
  return currentImpl(value);
}
function currentImpl(value) {
  if (!isDraftable(value) || isFrozen(value)) return value;
  const state = value[DRAFT_STATE];
  let copy;
  let strict = true;
  if (state) {
    if (!state.modified_) return state.base_;
    state.finalized_ = true;
    copy = shallowCopy(value, state.scope_.immer_.useStrictShallowCopy_);
    strict = state.scope_.immer_.shouldUseStrictIteration();
  } else {
    copy = shallowCopy(value, true);
  }
  each(
    copy,
    (key, childValue) => {
      set(copy, key, currentImpl(childValue));
    },
    strict
  );
  if (state) {
    state.finalized_ = false;
  }
  return copy;
}

// src/modules/client-runtime/vendor/immer/src/plugins/patches.ts
function enablePatches() {
  const errorOffset = 16;
  if (false) {
    errors.push(
      'Sets cannot have "replace" patches.',
      function(op) {
        return "Unsupported patch operation: " + op;
      },
      function(path) {
        return "Cannot apply patch, path doesn't resolve: " + path;
      },
      "Patching reserved attributes like __proto__, prototype and constructor is not allowed"
    );
  }
  const REPLACE = "replace";
  const ADD = "add";
  const REMOVE = "remove";
  function generatePatches_(state, basePath, patches, inversePatches) {
    switch (state.type_) {
      case 0 /* Object */:
      case 2 /* Map */:
        return generatePatchesFromAssigned(
          state,
          basePath,
          patches,
          inversePatches
        );
      case 1 /* Array */:
        return generateArrayPatches(state, basePath, patches, inversePatches);
      case 3 /* Set */:
        return generateSetPatches(
          state,
          basePath,
          patches,
          inversePatches
        );
    }
  }
  function generateArrayPatches(state, basePath, patches, inversePatches) {
    let { base_, assigned_ } = state;
    let copy_ = state.copy_;
    if (copy_.length < base_.length) {
      ;
      [base_, copy_] = [copy_, base_];
      [patches, inversePatches] = [inversePatches, patches];
    }
    for (let i = 0; i < base_.length; i++) {
      if (assigned_[i] && copy_[i] !== base_[i]) {
        const path = basePath.concat([i]);
        patches.push({
          op: REPLACE,
          path,
          // Need to maybe clone it, as it can in fact be the original value
          // due to the base/copy inversion at the start of this function
          value: clonePatchValueIfNeeded(copy_[i])
        });
        inversePatches.push({
          op: REPLACE,
          path,
          value: clonePatchValueIfNeeded(base_[i])
        });
      }
    }
    for (let i = base_.length; i < copy_.length; i++) {
      const path = basePath.concat([i]);
      patches.push({
        op: ADD,
        path,
        // Need to maybe clone it, as it can in fact be the original value
        // due to the base/copy inversion at the start of this function
        value: clonePatchValueIfNeeded(copy_[i])
      });
    }
    for (let i = copy_.length - 1; base_.length <= i; --i) {
      const path = basePath.concat([i]);
      inversePatches.push({
        op: REMOVE,
        path
      });
    }
  }
  function generatePatchesFromAssigned(state, basePath, patches, inversePatches) {
    const { base_, copy_ } = state;
    each(state.assigned_, (key, assignedValue) => {
      const origValue = get(base_, key);
      const value = get(copy_, key);
      const op = !assignedValue ? REMOVE : has(base_, key) ? REPLACE : ADD;
      if (origValue === value && op === REPLACE) return;
      const path = basePath.concat(key);
      patches.push(op === REMOVE ? { op, path } : { op, path, value });
      inversePatches.push(
        op === ADD ? { op: REMOVE, path } : op === REMOVE ? { op: ADD, path, value: clonePatchValueIfNeeded(origValue) } : { op: REPLACE, path, value: clonePatchValueIfNeeded(origValue) }
      );
    });
  }
  function generateSetPatches(state, basePath, patches, inversePatches) {
    let { base_, copy_ } = state;
    let i = 0;
    base_.forEach((value) => {
      if (!copy_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: REMOVE,
          path,
          value
        });
        inversePatches.unshift({
          op: ADD,
          path,
          value
        });
      }
      i++;
    });
    i = 0;
    copy_.forEach((value) => {
      if (!base_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: ADD,
          path,
          value
        });
        inversePatches.unshift({
          op: REMOVE,
          path,
          value
        });
      }
      i++;
    });
  }
  function generateReplacementPatches_(baseValue, replacement, patches, inversePatches) {
    patches.push({
      op: REPLACE,
      path: [],
      value: replacement === NOTHING ? void 0 : replacement
    });
    inversePatches.push({
      op: REPLACE,
      path: [],
      value: baseValue
    });
  }
  function applyPatches_(draft, patches) {
    patches.forEach((patch) => {
      const { path, op } = patch;
      let base = draft;
      for (let i = 0; i < path.length - 1; i++) {
        const parentType = getArchtype(base);
        let p = path[i];
        if (typeof p !== "string" && typeof p !== "number") {
          p = "" + p;
        }
        if ((parentType === 0 /* Object */ || parentType === 1 /* Array */) && (p === "__proto__" || p === "constructor"))
          die(errorOffset + 3);
        if (typeof base === "function" && p === "prototype")
          die(errorOffset + 3);
        base = get(base, p);
        if (typeof base !== "object") die(errorOffset + 2, path.join("/"));
      }
      const type = getArchtype(base);
      const value = deepClonePatchValue(patch.value);
      const key = path[path.length - 1];
      switch (op) {
        case REPLACE:
          switch (type) {
            case 2 /* Map */:
              return base.set(key, value);
            /* istanbul ignore next */
            case 3 /* Set */:
              die(errorOffset);
            default:
              return base[key] = value;
          }
        case ADD:
          switch (type) {
            case 1 /* Array */:
              return key === "-" ? base.push(value) : base.splice(key, 0, value);
            case 2 /* Map */:
              return base.set(key, value);
            case 3 /* Set */:
              return base.add(value);
            default:
              return base[key] = value;
          }
        case REMOVE:
          switch (type) {
            case 1 /* Array */:
              return base.splice(key, 1);
            case 2 /* Map */:
              return base.delete(key);
            case 3 /* Set */:
              return base.delete(patch.value);
            default:
              return delete base[key];
          }
        default:
          die(errorOffset + 1, op);
      }
    });
    return draft;
  }
  function deepClonePatchValue(obj) {
    if (!isDraftable(obj)) return obj;
    if (Array.isArray(obj)) return obj.map(deepClonePatchValue);
    if (isMap(obj))
      return new Map(
        Array.from(obj.entries()).map(([k, v]) => [k, deepClonePatchValue(v)])
      );
    if (isSet(obj)) return new Set(Array.from(obj).map(deepClonePatchValue));
    const cloned = Object.create(getPrototypeOf(obj));
    for (const key in obj) cloned[key] = deepClonePatchValue(obj[key]);
    if (has(obj, DRAFTABLE)) cloned[DRAFTABLE] = obj[DRAFTABLE];
    return cloned;
  }
  function clonePatchValueIfNeeded(obj) {
    if (isDraft(obj)) {
      return deepClonePatchValue(obj);
    } else return obj;
  }
  loadPlugin("Patches", {
    applyPatches_,
    generatePatches_,
    generateReplacementPatches_
  });
}

// src/modules/client-runtime/vendor/immer/src/plugins/mapset.ts
function enableMapSet() {
  class DraftMap extends Map {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 2 /* Map */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        assigned_: void 0,
        base_: target,
        draft_: this,
        isManual_: false,
        revoked_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(key) {
      return latest(this[DRAFT_STATE]).has(key);
    }
    set(key, value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!latest(state).has(key) || latest(state).get(key) !== value) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_.set(key, true);
        state.copy_.set(key, value);
        state.assigned_.set(key, true);
      }
      return this;
    }
    delete(key) {
      if (!this.has(key)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareMapCopy(state);
      markChanged(state);
      if (state.base_.has(key)) {
        state.assigned_.set(key, false);
      } else {
        state.assigned_.delete(key);
      }
      state.copy_.delete(key);
      return true;
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_ = /* @__PURE__ */ new Map();
        each(state.base_, (key) => {
          state.assigned_.set(key, false);
        });
        state.copy_.clear();
      }
    }
    forEach(cb, thisArg) {
      const state = this[DRAFT_STATE];
      latest(state).forEach((_value, key, _map) => {
        cb.call(thisArg, this.get(key), key, this);
      });
    }
    get(key) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      const value = latest(state).get(key);
      if (state.finalized_ || !isDraftable(value)) {
        return value;
      }
      if (value !== state.base_.get(key)) {
        return value;
      }
      const draft = createProxy(value, state);
      prepareMapCopy(state);
      state.copy_.set(key, draft);
      return draft;
    }
    keys() {
      return latest(this[DRAFT_STATE]).keys();
    }
    values() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.values(),
        next: () => {
          const r = iterator.next();
          if (r.done) return r;
          const value = this.get(r.value);
          return {
            done: false,
            value
          };
        }
      };
    }
    entries() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.entries(),
        next: () => {
          const r = iterator.next();
          if (r.done) return r;
          const value = this.get(r.value);
          return {
            done: false,
            value: [r.value, value]
          };
        }
      };
    }
    [(DRAFT_STATE, Symbol.iterator)]() {
      return this.entries();
    }
  }
  function proxyMap_(target, parent) {
    return new DraftMap(target, parent);
  }
  function prepareMapCopy(state) {
    if (!state.copy_) {
      state.assigned_ = /* @__PURE__ */ new Map();
      state.copy_ = new Map(state.base_);
    }
  }
  class DraftSet extends Set {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 3 /* Set */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        base_: target,
        draft_: this,
        drafts_: /* @__PURE__ */ new Map(),
        revoked_: false,
        isManual_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!state.copy_) {
        return state.base_.has(value);
      }
      if (state.copy_.has(value)) return true;
      if (state.drafts_.has(value) && state.copy_.has(state.drafts_.get(value)))
        return true;
      return false;
    }
    add(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!this.has(value)) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.add(value);
      }
      return this;
    }
    delete(value) {
      if (!this.has(value)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      markChanged(state);
      return state.copy_.delete(value) || (state.drafts_.has(value) ? state.copy_.delete(state.drafts_.get(value)) : (
        /* istanbul ignore next */
        false
      ));
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.clear();
      }
    }
    values() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.values();
    }
    entries() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.entries();
    }
    keys() {
      return this.values();
    }
    [(DRAFT_STATE, Symbol.iterator)]() {
      return this.values();
    }
    forEach(cb, thisArg) {
      const iterator = this.values();
      let result = iterator.next();
      while (!result.done) {
        cb.call(thisArg, result.value, result.value, this);
        result = iterator.next();
      }
    }
  }
  function proxySet_(target, parent) {
    return new DraftSet(target, parent);
  }
  function prepareSetCopy(state) {
    if (!state.copy_) {
      state.copy_ = /* @__PURE__ */ new Set();
      state.base_.forEach((value) => {
        if (isDraftable(value)) {
          const draft = createProxy(value, state);
          state.drafts_.set(value, draft);
          state.copy_.add(draft);
        } else {
          state.copy_.add(value);
        }
      });
    }
  }
  function assertUnrevoked(state) {
    if (state.revoked_) die(3, JSON.stringify(latest(state)));
  }
  loadPlugin("MapSet", { proxyMap_, proxySet_ });
}

// src/modules/client-runtime/vendor/immer/src/immer.ts
var immer = new Immer2();
var produce = immer.produce;
var produceWithPatches = /* @__PURE__ */ immer.produceWithPatches.bind(
  immer
);
var setAutoFreeze = /* @__PURE__ */ immer.setAutoFreeze.bind(immer);
var setUseStrictShallowCopy = /* @__PURE__ */ immer.setUseStrictShallowCopy.bind(
  immer
);
var setUseStrictIteration = /* @__PURE__ */ immer.setUseStrictIteration.bind(
  immer
);
var applyPatches = /* @__PURE__ */ immer.applyPatches.bind(immer);
var createDraft = /* @__PURE__ */ immer.createDraft.bind(immer);
var finishDraft = /* @__PURE__ */ immer.finishDraft.bind(immer);
function castDraft(value) {
  return value;
}
function castImmutable(value) {
  return value;
}

},
"src/modules/model-selection/ModelSelect.js": function(module, exports, require) {
// source: src/modules/model-selection/ModelSelect.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.XHarnessModelSelect = XHarnessModelSelect;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const ContextPane_1 = require("./ContextPane");
const styles_1 = require("./styles");
const ContextPane_css_1 = __importDefault(require("./ContextPane.css"));
const managed_models_1 = require("../shared/managed-models");
function classes(...values) { return values.filter(Boolean).join(' '); }
/** One composer trigger; model, effort and context live in its nested menu. */
function ModelSelect({ locked, available, directory, load, select, manageModels, t }) {
    const state = (0, react_1.useSyncExternalStore)(fn => directory.subscribe(fn), () => directory.getSnapshot());
    const [open, setOpen] = (0, react_1.useState)(false);
    const [pane, setPane] = (0, react_1.useState)('root');
    const lastActionRef = (0, react_1.useRef)('load');
    (0, react_1.useEffect)(() => { setPane('root'); }, [state.current?.provider, state.current?.model]);
    const [toast, setToast] = (0, react_1.useState)(null);
    const toastSeq = (0, react_1.useRef)(0);
    const rootRef = (0, react_1.useRef)(null);
    const triggerRef = (0, react_1.useRef)(null);
    const itemRefs = (0, react_1.useRef)([]);
    const id = (0, react_1.useId)();
    const choices = (0, react_1.useMemo)(() => state.groups.flatMap(group => group.models.map(model => ({ group, model }))), [state.groups]);
    const currentChoice = choices.find(choice => choice.group.id === state.current?.provider && choice.model.id === state.current?.model);
    const reasoning = currentChoice?.model.reasoning;
    const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
    const effortLabel = reasoning === undefined ? undefined : effectiveEffort === undefined ? t('effort.providerDefault') : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort;
    const effortChoices = (0, react_1.useMemo)(() => reasoning === undefined ? [] : [
        ...(reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }] : []),
        ...reasoning.efforts.map(effort => ({ key: `effort:${effort.id}`, effort: effort.id, label: effort.name, ...(effort.description === undefined ? {} : { description: effort.description }) })),
    ], [reasoning, t]);
    const visibleGroups = state.groups.filter(group => (0, managed_models_1.isManagedModelProvider)(group.id) === (pane !== 'custom'));
    const customSelected = state.current !== null && !(0, managed_models_1.isManagedModelProvider)(state.current.provider);
    const busy = state.status === 'selecting';
    const reload = () => { lastActionRef.current = 'load'; load(); };
    (0, react_1.useEffect)(() => { if (available) {
        lastActionRef.current = 'load';
        load();
    } }, [available, load]);
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const closeOutside = (event) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target))
            setOpen(false); };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside); };
    }, [open]);
    (0, react_1.useEffect)(() => {
        if (open && pane !== 'root' && pane !== 'context')
            itemRefs.current.find(item => item !== null && !item.disabled)?.focus();
    }, [open, pane]);
    if (!available)
        return null;
    const close = (restoreFocus = false) => {
        setOpen(false);
        setPane('root');
        if (restoreFocus)
            queueMicrotask(() => { triggerRef.current?.focus(); });
    };
    const show = () => { setPane('root'); setOpen(true); reload(); };
    const moveFocus = (offset) => {
        const items = itemRefs.current.filter((item) => item !== null && !item.disabled);
        if (items.length === 0)
            return;
        const active = items.findIndex(item => item === document.activeElement);
        items[active < 0 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length]?.focus();
    };
    const onKeyDown = (event) => {
        if ((event.key === 'Escape' || (event.key === 'ArrowLeft' && pane !== 'root' && pane !== 'context')) && open) {
            event.preventDefault();
            if (pane !== 'root')
                setPane(pane === 'custom' ? 'model' : 'root');
            else
                close(true);
            queueMicrotask(() => { itemRefs.current.find(item => item !== null)?.focus(); });
            return;
        }
        if (!open || pane === 'context')
            return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
    };
    const onBlur = (event) => {
        // WebKit may report null before a nonfocusable menu button's click.
        // Outside pointer handling is authoritative in that case.
        if (event.relatedTarget === null)
            return;
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))
            return;
        close();
    };
    const settleSelection = (accepted) => {
        if (accepted) {
            if (rootRef.current !== null)
                close(true);
            return;
        }
        const message = directory.getSnapshot().error;
        if (message !== null) {
            ++toastSeq.current;
            setToast({ seq: toastSeq.current, text: t('error.action', { message }) });
        }
    };
    const choose = (selection) => {
        if (state.current?.provider === selection.provider && state.current.model === selection.model) {
            close(true);
            return;
        }
        lastActionRef.current = 'select';
        void select(selection).then(settleSelection);
    };
    const chooseEffort = (effort) => {
        if (state.current === null)
            return;
        if (effectiveEffort === effort) {
            close(true);
            return;
        }
        const selection = { provider: state.current.provider, model: state.current.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            ...(state.current.contextWindowTokens === undefined ? {} : { contextWindowTokens: state.current.contextWindowTokens }),
        };
        lastActionRef.current = 'select';
        void select(selection).then(settleSelection);
    };
    const modelLabel = currentChoice?.model.name ?? t('trigger.fallback');
    const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
    const triggerAria = currentChoice === undefined ? t('trigger.selectAria') : effortLabel === undefined ? t('trigger.aria', { model: modelLabel }) : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel });
    itemRefs.current = [];
    let itemIndex = 0;
    const itemRef = () => { const at = itemIndex++; return node => { itemRefs.current[at] = node; }; };
    const loadError = (retryLabel) => state.error !== null && lastActionRef.current === 'load' && (0, jsx_runtime_1.jsxs)("div", { className: styles_1.css.error, children: [(0, jsx_runtime_1.jsx)("span", { children: t('error.action', { message: state.error }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.css.retry, onClick: reload, children: t(retryLabel) })] });
    return (0, jsx_runtime_1.jsxs)("div", { ref: rootRef, className: styles_1.css.root, onKeyDown: onKeyDown, onBlur: onBlur, children: [(0, jsx_runtime_1.jsxs)("button", { ref: triggerRef, type: "button", className: styles_1.css.trigger, "aria-label": triggerAria, "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": open ? `${id}-menu` : undefined, title: triggerLabel, disabled: locked, onClick: () => { if (open)
                    close();
                else
                    show(); }, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.triggerLabel, children: modelLabel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: classes(styles_1.css.chevron, open && styles_1.css.chevronOpen) })] }), open && (0, jsx_runtime_1.jsxs)("div", { id: `${id}-menu`, className: styles_1.css.menu, role: pane === 'context' ? 'dialog' : 'menu', "aria-label": pane === 'context' ? '调整上下文容量' : t('menu.aria'), "aria-busy": state.status === 'loading' || busy, children: [pane === 'root' && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitem", className: styles_1.css.cell, onClick: () => { setPane('model'); }, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellLabel, children: t('menu.model') }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellValue, children: modelLabel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, { className: styles_1.css.cellChevron })] }), reasoning !== undefined && (0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitem", className: styles_1.css.cell, onClick: () => { setPane('effort'); }, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellLabel, children: t('menu.effort') }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellValue, children: effortLabel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, { className: styles_1.css.cellChevron })] }), (0, jsx_runtime_1.jsx)(ContextPane_1.ReasoningStatus, { state: state, load: load, itemRef: itemRef() }), (0, jsx_runtime_1.jsx)(ContextPane_1.ContextRow, { state: state, itemRef: itemRef(), open: () => { setPane('context'); } })] }), pane === 'context' && (0, jsx_runtime_1.jsx)(ContextPane_1.ContextPane, { locked: locked, directory: directory, load: reload, select: select, back: () => { setPane('root'); }, saved: () => { close(true); } }), (pane === 'model' || pane === 'custom') && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [pane === 'custom' && (0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitem", className: styles_1.css.cell, "aria-label": t('menu.back'), onClick: () => { setPane('model'); }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, { className: styles_1.css.backChevron }), (0, jsx_runtime_1.jsx)("span", { children: t('menu.custom') })] }), state.status === 'loading' && (0, jsx_runtime_1.jsx)("div", { className: styles_1.css.status, children: t('status.loading') }), loadError('retry'), state.failures.map(failure => (0, jsx_runtime_1.jsxs)("div", { className: styles_1.css.warning, children: [(0, jsx_runtime_1.jsx)("span", { children: t('warning.groupLoad', { name: failure.name, message: failure.message }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.css.retry, onClick: reload, children: t('retry') })] }, failure.id)), (0, jsx_runtime_1.jsx)("div", { className: classes(styles_1.css.groups, 'scrollable'), children: visibleGroups.map(group => (0, jsx_runtime_1.jsxs)("section", { role: "group", "aria-labelledby": `${id}-${group.id}`, className: styles_1.css.group, children: [(0, jsx_runtime_1.jsxs)("div", { className: styles_1.css.groupTitle, id: `${id}-${group.id}`, children: [(0, jsx_runtime_1.jsx)("span", { children: (0, managed_models_1.isManagedModelProvider)(group.id) ? 'XHarness' : group.name }), (0, managed_models_1.isManagedModelProvider)(group.id) && (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.sourceBadge, title: t('source.accountHint'), children: t('source.account') })] }), group.models.map(model => {
                                            const selected = state.current?.provider === group.id && state.current.model === model.id;
                                            return (0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": selected, className: classes(styles_1.css.option, selected && styles_1.css.selected), title: model.name, disabled: busy, onClick: () => { choose({ provider: group.id, model: model.id }); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: styles_1.css.optionCopy, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.modelName, children: model.name }), model.description !== undefined && (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.description, children: model.description })] }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.check, children: selected ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, {}) : null })] }, model.id);
                                        })] }, group.id)) }), state.status === 'ready' && pane === 'custom' && visibleGroups.every(group => group.models.length === 0) && (0, jsx_runtime_1.jsx)("div", { className: styles_1.css.empty, children: t('empty.custom') }), pane === 'model' && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { role: "separator", className: styles_1.css.separator }), (0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitem", className: styles_1.css.cell, onClick: () => { setPane('custom'); }, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellLabel, children: t('menu.custom') }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellValue }), customSelected && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { className: styles_1.css.check }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, { className: styles_1.css.cellChevron })] })] }), manageModels !== undefined && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { role: "separator", className: styles_1.css.separator }), (0, jsx_runtime_1.jsx)("button", { ref: itemRef(), type: "button", role: "menuitem", className: styles_1.css.cell, onClick: () => { close(true); queueMicrotask(manageModels); }, children: t('menu.manage') })] })] }), pane === 'effort' && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [loadError('action.reload'), effortChoices.length === 0 ? (0, jsx_runtime_1.jsx)("div", { className: styles_1.css.empty, children: t('empty.efforts') }) : effortChoices.map(level => (0, jsx_runtime_1.jsxs)("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": effectiveEffort === level.effort, className: classes(styles_1.css.option, effectiveEffort === level.effort && styles_1.css.selected), disabled: busy, onClick: () => { chooseEffort(level.effort); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: styles_1.css.optionCopy, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.modelName, children: level.label }), level.description !== undefined && (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.description, children: level.description })] }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.check, children: effectiveEffort === level.effort ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, {}) : null })] }, level.key))] })] }), toast !== null && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Toast, { text: toast.text, icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconWarningOutline16, {}), anchor: rootRef.current?.closest('[data-composer-card]') ?? null, onDone: () => { setToast(null); } }, toast.seq)] });
}
function XHarnessModelSelect(props) { return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("style", { children: ContextPane_css_1.default }), (0, jsx_runtime_1.jsx)(ModelSelect, { ...props })] }); }

},
"src/modules/model-selection/ContextPane.js": function(module, exports, require) {
// source: src/modules/model-selection/ContextPane.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhModelInfo = xhModelInfo;
exports.xhContextSelection = xhContextSelection;
exports.xhReasoningStatus = xhReasoningStatus;
exports.ReasoningStatus = ReasoningStatus;
exports.ContextRow = ContextRow;
exports.ContextPane = ContextPane;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const runtime_types_1 = require("../shared/runtime-types");
const styles_1 = require("./styles");
/** No client-owned maximum: only the exact selected model's reported limit. */
function xhModelInfo(state) {
    const current = state.current;
    const model = state.groups.find(group => group.id === current?.provider)?.models.find(entry => entry.id === current?.model);
    const maximum = model?.contextWindow !== undefined && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined;
    return { current, model, maximum, effort: current?.reasoningEffort ?? model?.reasoning?.defaultEffort };
}
function xhContextSelection(state, raw) {
    const { current, maximum } = xhModelInfo(state);
    if (!current || !maximum)
        throw new Error('当前模型未提供上下文上限，无法调整。');
    if (!/^\d+$/.test(raw.trim()))
        throw new Error('请输入正整数 Token 数量。');
    const tokens = Number(raw);
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > maximum)
        throw new Error(`请输入 1–${maximum.toLocaleString()} 之间的 Token 数量。`);
    return { ...current, contextWindowTokens: tokens };
}
function tokenLabel(value) {
    if (value === undefined || !Number.isSafeInteger(value) || value < 1)
        return '未知';
    return value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString();
}
function xhReasoningStatus(state) {
    const { model } = xhModelInfo(state);
    const capability = model?.reasoningCapability;
    if (capability?.state === 'disabled')
        return '已禁用配置';
    if (!model?.reasoning)
        return '能力未知';
    if (capability?.stale)
        return '沿用上次能力 · 待刷新';
    const sources = { configured: '已配置', documented: '厂商文档', provider_reported: '服务端提供', last_known_good: '上次有效能力' };
    return sources[capability?.source ?? ''] ?? '已配置';
}
function ReasoningStatus({ state, load, itemRef }) {
    const busy = state.status === 'loading' || state.status === 'selecting';
    return (0, jsx_runtime_1.jsxs)("button", { type: "button", role: "menuitem", disabled: busy, style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 12px', width: '100%', fontSize: 12 }, ref: itemRef, "aria-label": "\u5237\u65B0\u6A21\u578B\u80FD\u529B", onClick: () => { void Promise.resolve(load(true)).catch(() => { }); }, children: [(0, jsx_runtime_1.jsxs)("span", { children: ["\u601D\u8003\u80FD\u529B\uFF1A", xhReasoningStatus(state)] }), (0, jsx_runtime_1.jsx)("span", { children: busy ? '获取中…' : '刷新' })] });
}
function ContextRow({ state, itemRef, open }) {
    const { current, maximum } = xhModelInfo(state);
    return (0, jsx_runtime_1.jsxs)("button", { ref: itemRef, type: "button", role: "menuitem", className: styles_1.css.cell, onClick: open, children: [(0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellLabel, children: "\u4E0A\u4E0B\u6587\u5BB9\u91CF" }), (0, jsx_runtime_1.jsx)("span", { className: styles_1.css.cellValue, children: tokenLabel(current?.contextWindowTokens ?? maximum) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, { className: styles_1.css.cellChevron })] });
}
function ContextPane({ locked, directory, load, select, back, saved }) {
    const state = (0, react_1.useSyncExternalStore)(fn => directory.subscribe(fn), () => directory.getSnapshot());
    const { current, model, maximum } = xhModelInfo(state);
    const currentTokens = current?.contextWindowTokens ?? maximum;
    const [draft, setDraft] = (0, react_1.useState)(String(currentTokens ?? ''));
    const [error, setError] = (0, react_1.useState)(null);
    const [saving, setSaving] = (0, react_1.useState)(false);
    const version = (0, react_1.useRef)(0);
    const busy = saving || state.status === 'loading' || state.status === 'selecting';
    const identity = JSON.stringify([current, maximum]);
    (0, react_1.useEffect)(() => { setDraft(String(currentTokens ?? '')); setError(null); setSaving(false); }, [identity]);
    (0, react_1.useEffect)(() => { ++version.current; }, [current?.provider, current?.model]);
    (0, react_1.useEffect)(() => () => { ++version.current; }, []);
    async function submit(event) {
        event.preventDefault();
        if (locked || busy || !maximum)
            return;
        let selection;
        try {
            selection = xhContextSelection(directory.getSnapshot(), draft);
        }
        catch (cause) {
            setError((0, runtime_types_1.errorText)(cause));
            return;
        }
        const generation = version.current;
        setSaving(true);
        setError(null);
        try {
            const ok = await select(selection);
            if (generation !== version.current)
                return;
            if (!ok)
                throw new Error(directory.getSnapshot().error ?? '保存失败，请重试。');
            const actual = directory.getSnapshot().current;
            // A late save for another model must never close a newly edited form.
            const keys = ['provider', 'model', 'reasoningEffort', 'contextWindowTokens'];
            if (keys.every(key => actual?.[key] === selection[key]))
                saved();
        }
        catch (cause) {
            if (generation === version.current)
                setError((0, runtime_types_1.errorText)(cause));
        }
        finally {
            if (generation === version.current)
                setSaving(false);
        }
    }
    return (0, jsx_runtime_1.jsxs)("form", { className: "xh-context-form", onSubmit: event => { void submit(event); }, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", onClick: back, children: "\u2190 \u8FD4\u56DE\u6A21\u578B\u8BBE\u7F6E" }), (0, jsx_runtime_1.jsx)("h3", { children: "\u4E0A\u4E0B\u6587\u5BB9\u91CF" }), (0, jsx_runtime_1.jsx)("p", { children: "\u4EC5\u5F71\u54CD\u540E\u7EED\u8BF7\u6C42\uFF0C\u4E0D\u6539\u53D8\u6B63\u5728\u8FD0\u884C\u7684\u8BF7\u6C42\u3002" }), (0, jsx_runtime_1.jsxs)("label", { children: ["Token \u6570\u91CF", (0, jsx_runtime_1.jsx)("input", { autoFocus: true, type: "text", inputMode: "numeric", "aria-label": "\u4E0A\u4E0B\u6587 Token \u6570\u91CF", value: draft, readOnly: busy, disabled: locked, onChange: event => { setDraft(event.target.value); setError(null); } })] }), (0, jsx_runtime_1.jsxs)("p", { children: ["\u5F53\u524D\u6A21\u578B\u6709\u6548\u4E0A\u9650\uFF1A", maximum?.toLocaleString() ?? '未知', " tokens\uFF08", model?.contextWindowSource ?? '来源未标注', "\uFF09"] }), !maximum && (0, jsx_runtime_1.jsx)("p", { children: "\u5F53\u524D\u6A21\u578B\u672A\u63D0\u4F9B\u4E0A\u9650\uFF0C\u6682\u65F6\u65E0\u6CD5\u8C03\u6574\u3002" }), (error || state.error) && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: error || state.error }), state.status === 'error' && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { load(); }, children: "\u91CD\u65B0\u83B7\u53D6" }), (0, jsx_runtime_1.jsxs)("div", { className: "xh-context-actions", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy || locked || !maximum, onClick: () => { setDraft(String(maximum)); setError(null); }, children: "\u586B\u5165\u4E0A\u9650" }), (0, jsx_runtime_1.jsx)("button", { type: "submit", disabled: busy || locked || !maximum, children: saving ? '保存中…' : '保存' })] })] });
}

},
"src/modules/model-selection/styles.js": function(module, exports, require) {
// source: src/modules/model-selection/styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.css = void 0;
const ModelSelect_css_1 = __importDefault(require("./ModelSelect.css"));
exports.css = {
    sourceBadge: "AbPDjW_sourceBadge", separator: "AbPDjW_separator", backChevron: "AbPDjW_backChevron",
    "cell": "AbPDjW_cell",
    "cellChevron": "AbPDjW_cellChevron",
    "cellLabel": "AbPDjW_cellLabel",
    "cellValue": "AbPDjW_cellValue",
    "check": "AbPDjW_check",
    "chevron": "AbPDjW_chevron",
    "chevronOpen": "AbPDjW_chevronOpen",
    "description": "AbPDjW_description",
    "empty": "AbPDjW_empty",
    "error": "AbPDjW_error",
    "group": "AbPDjW_group",
    "groupTitle": "AbPDjW_groupTitle",
    "groups": "AbPDjW_groups",
    "menu": "AbPDjW_menu",
    "modelName": "AbPDjW_modelName",
    "option": "AbPDjW_option",
    "optionCopy": "AbPDjW_optionCopy",
    "retry": "AbPDjW_retry",
    "root": "AbPDjW_root",
    "selected": "AbPDjW_selected",
    "status": "AbPDjW_status",
    "trigger": "AbPDjW_trigger",
    "triggerEffort": "AbPDjW_triggerEffort",
    "triggerLabel": "AbPDjW_triggerLabel",
    "warning": "AbPDjW_warning"
};
const tagId = '@xharness/dsh-client-ui-model-selection/ModelSelect.module.css';
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@xharness/dsh-client-ui-model-selection';
    tag.dataset.pluginCss = tagId;
    tag.textContent = ModelSelect_css_1.default;
    document.head.appendChild(tag);
}

},
"src/modules/model-selection/ModelSelect.css": function(module, exports, require) {
// source: src/modules/model-selection/ModelSelect.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".AbPDjW_root{min-width:0;position:relative}.AbPDjW_trigger{min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.AbPDjW_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.AbPDjW_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.AbPDjW_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.AbPDjW_triggerEffort{color:var(--dsw-alias-label-caption);flex:none}.AbPDjW_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.AbPDjW_chevronOpen{transform:rotate(180deg)}.AbPDjW_menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.AbPDjW_status,.AbPDjW_empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.AbPDjW_error,.AbPDjW_warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}.AbPDjW_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.AbPDjW_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.AbPDjW_groups{min-height:0;overflow-y:auto}.AbPDjW_group+.AbPDjW_group{margin-top:4px}.AbPDjW_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.AbPDjW_option{box-sizing:border-box;width:auto;min-width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.AbPDjW_option:hover:not(:disabled),.AbPDjW_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_selected{background:0 0}.AbPDjW_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.AbPDjW_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}.AbPDjW_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.AbPDjW_description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.AbPDjW_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.AbPDjW_cell{box-sizing:border-box;width:auto;min-width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}.AbPDjW_cell:hover{background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_cellLabel{white-space:nowrap;flex:none}.AbPDjW_cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}.AbPDjW_cellChevron{color:var(--dsw-alias-label-tertiary);flex:none}\n.AbPDjW_groupTitle{display:flex;align-items:center;gap:8px;padding:8px 10px 4px}.AbPDjW_sourceBadge{border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);padding:1px 7px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}.AbPDjW_separator{height:1px;flex:none;background:var(--dsw-alias-border-l3);margin:4px -4px}.AbPDjW_backChevron{transform:rotate(180deg);flex:none;color:var(--dsw-alias-label-tertiary)}.AbPDjW_cell:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}\n";

},
"src/modules/model-selection/ContextPane.css": function(module, exports, require) {
// source: src/modules/model-selection/ContextPane.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xh-context-form{box-sizing:border-box;width:300px;max-width:calc(100vw - 48px);padding:10px;font-size:13px;overflow:auto}.xh-context-form h3{font-size:14px;margin:12px 0 6px}.xh-context-form p{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:8px 0}.xh-context-form input{display:block;box-sizing:border-box;width:100%;padding:8px;margin-top:6px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#aaa);border-radius:6px}.xh-context-form button{padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:transparent;color:inherit;cursor:pointer}.xh-context-form button:disabled{opacity:.5;cursor:default}.xh-context-form [role=alert]{color:var(--dsw-alias-state-error-label,#c33)}.xh-context-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}";

},
"src/modules/shared/managed-models.js": function(module, exports, require) {
// source: src/modules/shared/managed-models.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANAGED_MODEL_CREDENTIAL = exports.MANAGED_MODEL_NAMESPACE = exports.MANAGED_MODEL_ROUTE = void 0;
exports.isManagedModelProvider = isManagedModelProvider;
exports.isManagedModelProfile = isManagedModelProfile;
/** Stable route reserved by account connection; presentation provenance, not authorization. */
exports.MANAGED_MODEL_ROUTE = 'xharness-managed';
exports.MANAGED_MODEL_NAMESPACE = 'llm-pi-ai';
exports.MANAGED_MODEL_CREDENTIAL = 'XHARNESS_MANAGED_API_TOKEN';
function isManagedModelProvider(provider) { return provider === exports.MANAGED_MODEL_ROUTE; }
function isManagedModelProfile(namespace, path) {
    return namespace === exports.MANAGED_MODEL_NAMESPACE && path.length === 2 && path[0] === 'providers' && path[1] === exports.MANAGED_MODEL_ROUTE;
}

},
"src/modules/model-selection/locales.js": function(module, exports, require) {
// source: src/modules/model-selection/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = {
    'menu.back': '返回模型',
    'menu.custom': '自定义',
    'menu.manage': '管理模型',
    'source.account': '账号服务',
    'source.accountHint': '由 XHarness 提供，使用账号额度',
    'empty.custom': '没有自定义模型。请在管理模型中添加。',
    "command.description": "选择本会话使用的模型",
    "option.loadError": "目录加载失败：{message}",
    "trigger.fallback": "选择模型",
    "trigger.selectAria": "选择模型",
    "trigger.aria": "选择模型，当前 {model}",
    "trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",
    "menu.aria": "模型与推理等级",
    "menu.model": "模型",
    "menu.effort": "推理等级",
    "effort.providerDefault": "Default",
    "status.loading": "正在刷新模型列表…",
    "error.action": "模型操作失败：{message}",
    "action.reload": "重新加载",
    "warning.groupLoad": "{name} 加载失败：{message}",
    "empty.models": "没有可用的模型。",
    "blocked.composer": "当前模型不可用，请先选择模型",
    "empty.efforts": "当前模型未提供推理等级。"
};
exports.en = {
    'menu.back': 'Back to models',
    'menu.custom': 'Custom',
    'menu.manage': 'Manage models',
    'source.account': 'Account service',
    'source.accountHint': 'Provided by XHarness, uses account credits',
    'empty.custom': 'No custom models. Add one in Manage models.',
    "command.description": "Select the model for this conversation",
    "option.loadError": "Catalog failed to load: {message}",
    "trigger.fallback": "Select model",
    "trigger.selectAria": "Select model",
    "trigger.aria": "Select model, current {model}",
    "trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",
    "menu.aria": "Model and reasoning effort",
    "menu.model": "Model",
    "menu.effort": "Effort",
    "effort.providerDefault": "Default",
    "status.loading": "Refreshing model list…",
    "error.action": "Model operation failed: {message}",
    "action.reload": "Reload",
    "warning.groupLoad": "{name} failed to load: {message}",
    "empty.models": "No models available.",
    "blocked.composer": "This model is unavailable — select one to continue",
    "empty.efforts": "This model provides no reasoning effort levels."
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
const __dependencies = {"src/modules/model-selection/index.js":{"./service":"src/modules/model-selection/service.js","./ModelSelect":"src/modules/model-selection/ModelSelect.js","./locales":"src/modules/model-selection/locales.js","./directory":"src/modules/model-selection/directory.js","./ContextPane":"src/modules/model-selection/ContextPane.js","../shared/settings-navigation":"src/modules/shared/settings-navigation.js"},"src/modules/model-selection/service.js":{"./core-context":"src/modules/model-selection/core-context.js","./directory":"src/modules/model-selection/directory.js"},"src/modules/model-selection/core-context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/model-selection/directory.js":{"immer":"vendor/immer.js","../shared/runtime-types":"src/modules/shared/runtime-types.js"},"vendor/immer.js":{},"src/modules/model-selection/ModelSelect.js":{"./ContextPane":"src/modules/model-selection/ContextPane.js","./styles":"src/modules/model-selection/styles.js","./ContextPane.css":"src/modules/model-selection/ContextPane.css","../shared/managed-models":"src/modules/shared/managed-models.js"},"src/modules/model-selection/ContextPane.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./styles":"src/modules/model-selection/styles.js"},"src/modules/model-selection/styles.js":{"./ModelSelect.css":"src/modules/model-selection/ModelSelect.css"},"src/modules/model-selection/ModelSelect.css":{},"src/modules/model-selection/ContextPane.css":{},"src/modules/shared/managed-models.js":{},"src/modules/model-selection/locales.js":{},"src/modules/shared/settings-navigation.js":{}};
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
return __load("src/modules/model-selection/index.js");
}
});
