// Generated from src/modules/settings/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings/index.js": function(module, exports, require) {
// source: src/modules/settings/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// Type-only pair supplying `$on` and its key face without dragging a build
// artifact into the Host graph (rationale beside the same pair in
// settings-scope.ts).
const schema_1 = require("./schema");
const settings_scope_1 = require("./settings-scope");
const settings_mirror_1 = require("./settings-mirror");
/**
 * Required services: the wire handle for the mirror's reads and the forwarded
 * settings invalidation the mirror refreshes on.
 */
exports.inject = ['connection', 'remote'];
/**
 * Provide the settings-namespace scope service over one shared describe
 * mirror, and keep that mirror fresh on the two signals that can move the
 * settings document: a document commit and a (re)connect.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const schema = new schema_1.SettingsSchemaService(ctx);
    const connection = ctx.get('connection');
    const mirror = new settings_mirror_1.SettingsDescribeMirror(connection.api, connection.isLoopback ? 'host' : 'memory');
    ctx.effect(() => {
        const disposers = [
            (ctx.get('remote')).$on('settings/document-updated', () => { void mirror.load(); }),
            ctx.on('connection/reset', () => { void mirror.load(); }),
        ];
        // The first connection also emits connection/reset, so startup normally
        // costs two reads (budgeted in startup-rpc-budget.e2e.ts). The in-flight
        // fold does not merge them into one; it guarantees at most one pending
        // read at a time and that no invalidation arriving mid-read is lost.
        void mirror.ensure();
        return () => { for (const dispose of disposers)
            dispose(); };
    }, 'ui-settings: describe mirror invalidations');
    new settings_scope_1.SettingsScopeBinder(ctx, { mirror, schema });
}

},
"src/modules/settings/schema.js": function(module, exports, require) {
// source: src/modules/settings/schema.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsSchemaService = void 0;
/** Synchronous schema introspection and immutable settings-draft edits. */
const context_1 = require("./context");
const cordis_1 = require("@xharness/cordis");
const index_1 = __importDefault(require("./vendor/schemastery/index"));
const serialized_schema_1 = require("./serialized-schema");
const runtime_types_1 = require("../shared/runtime-types");
function cloneContainer(container, key) {
    if (Array.isArray(container))
        return [...container];
    if ((0, runtime_types_1.isObjectRecord)(container))
        return { ...container };
    return /^\d+$/.test(key) ? [] : {};
}
function cloneSpine(root, path) {
    const result = { ...root };
    let target = result;
    for (let index = 0; index < path.length - 1; index++) {
        const key = path[index];
        const next = path[index + 1];
        if (key === undefined || next === undefined)
            throw new Error('ui-settings: invalid path');
        const child = cloneContainer(Array.isArray(target) ? target[Number(key)] : target[key], next);
        if (Array.isArray(target))
            target[Number(key)] = child;
        else
            target[key] = child;
        target = child;
    }
    const leaf = path.at(-1);
    if (leaf === undefined)
        throw new Error('ui-settings: empty path');
    return { result, parent: target, leaf };
}
const Service = cordis_1.Service;
/**
 * Settings-owned synchronous schema service. Dynamic client plugins receive
 * this Cordis entity instead of importing executable helpers from one another.
 */
class SettingsSchemaService extends Service {
    /** @param ctx - providing ui-settings context. */
    constructor(ctx) {
        super((0, context_1.cordisSettingsContext)(ctx), 'settingsSchema');
    }
    /**
     * Rehydrate one serialized `schema.toJSON()` envelope.
     * @param serialized - serialized Schemastery node.
     * @returns live schema node.
     */
    rehydrate(serialized) {
        return new index_1.default((0, serialized_schema_1.serializedSchemaEnvelope)(serialized));
    }
    /**
     * Validate a settings draft.
     * @param schema - live schema node.
     * @param draft - candidate settings value.
     * @returns validation failure text, or `undefined` when valid.
     */
    validate(schema, draft) {
        try {
            ;
            schema(draft);
            return undefined;
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }
    /**
     * Resolve an object, dict, or array schema node at a settings path.
     * @param root - schema node to traverse.
     * @param path - object keys or array indexes.
     * @returns the resolved node, or `undefined` when the path is absent.
     */
    nodeAtPath(root, path) {
        let node = root;
        for (const key of path) {
            if (node === undefined)
                return undefined;
            if (node.type === 'object')
                node = node.dict?.[key];
            else if (node.type === 'dict' || node.type === 'array')
                node = node.inner;
            else
                return undefined;
        }
        return node;
    }
    /**
     * Read a nested value by a string-key or array-index path.
     * @param value - value to traverse.
     * @param path - object keys or array indexes.
     * @returns the resolved value, or `undefined` when the path is absent.
     */
    getPath(value, path) {
        let current = value;
        for (const key of path) {
            if (Array.isArray(current)) {
                current = current[Number(key)];
                continue;
            }
            if (!(0, runtime_types_1.isObjectRecord)(current))
                return undefined;
            current = current[key];
        }
        return current;
    }
    /**
     * Report whether the final path key exists independently of its value.
     * @param value - value to traverse.
     * @param path - object keys or array indexes.
     * @returns whether the path exists.
     */
    hasPath(value, path) {
        if (path.length === 0)
            return value !== undefined;
        const parent = this.getPath(value, path.slice(0, -1));
        const key = path.at(-1);
        if (key === undefined)
            return false;
        if (Array.isArray(parent))
            return Number(key) < parent.length;
        if (typeof parent !== 'object' || parent === null)
            return false;
        return key in parent;
    }
    /**
     * Immutably set a nested value, materializing missing containers.
     * @param root - settings object to copy.
     * @param path - non-empty object-key or array-index path.
     * @param value - replacement value.
     * @returns copied root containing the replacement.
     * @throws when `path` is empty.
     */
    setPath(root, path, value) {
        if (path.length === 0)
            throw new Error('ui-settings: setPath needs a non-empty path');
        const { result, parent, leaf } = cloneSpine(root, path);
        if (Array.isArray(parent))
            parent[Number(leaf)] = value;
        else
            parent[leaf] = value;
        return result;
    }
    /**
     * Immutably remove a nested key, preserving an unchanged missing root.
     * @param root - settings object to copy.
     * @param path - non-empty object-key or array-index path.
     * @returns copied root without the key, or `root` when the path is absent.
     * @throws when `path` is empty.
     */
    deletePath(root, path) {
        if (path.length === 0)
            throw new Error('ui-settings: deletePath needs a non-empty path');
        if (!this.hasPath(root, path))
            return root;
        const { result, parent, leaf } = cloneSpine(root, path);
        if (Array.isArray(parent))
            parent.splice(Number(leaf), 1);
        else
            Reflect.deleteProperty(parent, leaf);
        return result;
    }
}
exports.SettingsSchemaService = SettingsSchemaService;

},
"src/modules/settings/context.js": function(module, exports, require) {
// source: src/modules/settings/context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cordisSettingsContext = cordisSettingsContext;
exports.settingsContext = settingsContext;
const cordis_1 = require("@xharness/cordis");
const runtime_types_1 = require("../shared/runtime-types");
/** Only the real Cordis constructor establishes the superclass ABI. */
function cordisSettingsContext(value) {
    if (!cordis_1.Context.is(value))
        throw new TypeError('ui-settings: expected a Cordis context');
    return value;
}
function isOwnedSettingsContext(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value) || !cordis_1.Context.is(value))
        return false;
    const remote = value.remote;
    return typeof value.effect === 'function' && typeof value.on === 'function' && typeof value.get === 'function'
        && (0, runtime_types_1.isObjectRecord)(remote) && typeof remote.$on === 'function';
}
/** Read the dynamically traced receiver, never the context captured at
 * registration time. Registered injection establishes each service's API. */
function settingsContext(value) {
    if (!isOwnedSettingsContext(value))
        throw new TypeError('ui-settings: missing injected settings Context');
    return value;
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
"src/modules/settings/vendor/schemastery/index.js": function(module, exports, require) {
// source: src/modules/settings/vendor/schemastery/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../cosmokit/index");
const kSchema = Symbol.for('schemastery');
const kValidationError = Symbol.for('ValidationError');
globalThis.__schemastery_index__ ?? (globalThis.__schemastery_index__ = 0);
globalThis.__schemastery_refs__ = undefined;
class ValidationError extends TypeError {
    constructor(message, options) {
        let prefix = '$';
        for (const segment of options.path || []) {
            if (typeof segment === 'string') {
                prefix += '.' + segment;
            }
            else if (typeof segment === 'number') {
                prefix += '[' + segment + ']';
            }
            else if (typeof segment === 'symbol') {
                prefix += `[Symbol(${segment.toString()})]`;
            }
        }
        if (prefix.startsWith('.'))
            prefix = prefix.slice(1);
        super((prefix === '$' ? '' : `${prefix} `) + message);
        this.options = options;
        this.name = 'ValidationError';
    }
    static is(error) {
        return !!error?.[kValidationError];
    }
}
Object.defineProperty(ValidationError.prototype, kValidationError, {
    value: true,
});
const Schema = function (options) {
    const schema = function (data, options = {}) {
        return Schema.resolve(data, schema, options)[0];
    };
    if (options.refs) {
        const refs = (0, index_1.valueMap)(options.refs, options => new Schema(options));
        const getRef = (uid) => refs[uid];
        for (const key in refs) {
            const options = refs[key];
            options.sKey = getRef(options.sKey);
            options.inner = getRef(options.inner);
            if (options.list)
                options.list = options.list.map(getRef);
            if (options.dict)
                options.dict = (0, index_1.valueMap)(options.dict, getRef);
        }
        return refs[options.uid];
    }
    Object.assign(schema, options);
    if (typeof schema.callback === 'string') {
        try {
            // eslint-disable-next-line no-new-func
            schema.callback = new Function('return ' + schema.callback)();
        }
        catch { }
    }
    Object.defineProperty(schema, 'uid', { value: globalThis.__schemastery_index__++ });
    Object.setPrototypeOf(schema, Schema.prototype);
    schema.meta || (schema.meta = {});
    schema.toString = schema.toString.bind(schema);
    return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, '~standard', {
    get() {
        return {
            version: 1,
            vendor: 'schemastery',
            validate: (value) => {
                try {
                    return { value: Schema.resolve(value, this, {})[0] };
                }
                catch (error) {
                    if (ValidationError.is(error)) {
                        return { issues: [{ message: error.message, path: error.options.path }] };
                    }
                    throw error;
                }
            },
        };
    },
});
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
    var _a, _b;
    if (globalThis.__schemastery_refs__) {
        (_a = globalThis.__schemastery_refs__)[_b = this.uid] ?? (_a[_b] = JSON.parse(JSON.stringify({ ...this })));
        return this.uid;
    }
    globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
    globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
    const result = { uid: this.uid, refs: globalThis.__schemastery_refs__ };
    globalThis.__schemastery_refs__ = undefined;
    return result;
};
Schema.prototype.set = function set(key, value) {
    this.dict[key] = value;
    return this;
};
Schema.prototype.push = function push(value) {
    this.list.push(value);
    return this;
};
function mergeDesc(original, messages) {
    const result = typeof original === 'string' ? { '': original } : { ...original };
    for (const locale in messages) {
        const value = messages[locale];
        if (value?.$description || value?.$desc) {
            result[locale] = value.$description || value.$desc;
        }
        else if (typeof value === 'string') {
            result[locale] = value;
        }
    }
    return result;
}
function getInner(value) {
    return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
    return (0, index_1.filterKeys)(data ?? {}, key => !key.startsWith('$'));
}
Schema.prototype.i18n = function i18n(messages) {
    const schema = Schema(this);
    const desc = mergeDesc(schema.meta.description, messages);
    if (Object.keys(desc).length)
        schema.meta.description = desc;
    if (schema.dict) {
        schema.dict = (0, index_1.valueMap)(schema.dict, (inner, key) => {
            return inner.i18n((0, index_1.valueMap)(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
        });
    }
    if (schema.list) {
        schema.list = schema.list.map((inner, index) => {
            return inner.i18n((0, index_1.valueMap)(messages, (data = {}) => {
                if (Array.isArray(getInner(data)))
                    return getInner(data)[index];
                if (Array.isArray(data))
                    return data[index];
                return extractKeys(data);
            }));
        });
    }
    if (schema.inner) {
        schema.inner = schema.inner.i18n((0, index_1.valueMap)(messages, (data) => {
            if (getInner(data))
                return getInner(data);
            return extractKeys(data);
        }));
    }
    if (schema.sKey) {
        schema.sKey = schema.sKey.i18n((0, index_1.valueMap)(messages, (data) => data?.$key));
    }
    return schema;
};
Schema.prototype.extra = function extra(key, value) {
    const schema = Schema(this);
    schema.meta = { ...schema.meta, [key]: value };
    return schema;
};
for (const key of ['required', 'disabled', 'collapse', 'hidden', 'loose']) {
    Object.assign(Schema.prototype, {
        [key](value = true) {
            const schema = Schema(this);
            schema.meta = { ...schema.meta, [key]: value };
            return schema;
        },
    });
}
Schema.prototype.deprecated = function deprecated() {
    var _a;
    const schema = Schema(this);
    (_a = schema.meta).badges || (_a.badges = []);
    schema.meta.badges.push({ text: 'deprecated', type: 'danger' });
    return schema;
};
Schema.prototype.experimental = function experimental() {
    var _a;
    const schema = Schema(this);
    (_a = schema.meta).badges || (_a.badges = []);
    schema.meta.badges.push({ text: 'experimental', type: 'warning' });
    return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
    const schema = Schema(this);
    const pattern = (0, index_1.pick)(regexp, ['source', 'flags']);
    schema.meta = { ...schema.meta, pattern };
    return schema;
};
Schema.prototype.simplify = function simplify(value) {
    if ((0, index_1.deepEqual)(value, this.meta.default, this.type === 'dict'))
        return null;
    if ((0, index_1.isNullable)(value))
        return value;
    if (this.type === 'object' || this.type === 'dict') {
        const result = {};
        for (const key in value) {
            const schema = this.type === 'object' ? this.dict[key] : this.inner;
            const item = schema?.simplify(value[key]);
            if (this.type === 'dict' || !(0, index_1.isNullable)(item))
                result[key] = item;
        }
        if ((0, index_1.deepEqual)(result, this.meta.default, this.type === 'dict'))
            return null;
        return result;
    }
    else if (this.type === 'array' || this.type === 'tuple') {
        const result = [];
        value.forEach((value, index) => {
            const schema = this.type === 'array' ? this.inner : this.list[index];
            const item = schema ? schema.simplify(value) : value;
            result.push(item);
        });
        return result;
    }
    else if (this.type === 'intersect') {
        const result = {};
        for (const item of this.list) {
            Object.assign(result, item.simplify(value));
        }
        return result;
    }
    else if (this.type === 'union') {
        for (const schema of this.list) {
            try {
                Schema.resolve(value, schema, {});
                return schema.simplify(value);
            }
            catch { }
        }
    }
    return value;
};
Schema.prototype.toString = function toString(inline) {
    return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
    const schema = Schema(this);
    schema.meta = { ...schema.meta, role, extra };
    return schema;
};
for (const key of ['default', 'link', 'comment', 'description', 'max', 'min', 'step']) {
    Object.assign(Schema.prototype, {
        [key](value) {
            const schema = Schema(this);
            schema.meta = { ...schema.meta, [key]: value };
            return schema;
        },
    });
}
const resolvers = {};
Schema.extend = function extend(type, resolve) {
    resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
    if (!schema)
        return [data];
    if (options.ignore?.(data, schema))
        return [data];
    if ((0, index_1.isNullable)(data) && schema.type !== 'lazy') {
        if (schema.meta.required)
            throw new ValidationError(`missing required value`, options);
        let current = schema;
        let fallback = schema.meta.default;
        while (current?.type === 'intersect' && (0, index_1.isNullable)(fallback)) {
            current = current.list[0];
            fallback = current?.meta.default;
        }
        if ((0, index_1.isNullable)(fallback))
            return [data];
        data = (0, index_1.clone)(fallback);
    }
    const callback = resolvers[schema.type];
    if (!callback)
        throw new ValidationError(`unsupported type "${schema.type}"`, options);
    try {
        return callback(data, schema, options, strict);
    }
    catch (error) {
        if (!schema.meta.loose)
            throw error;
        return [schema.meta.default];
    }
};
Schema.from = function from(source) {
    if ((0, index_1.isNullable)(source)) {
        return Schema.any();
    }
    else if (['string', 'number', 'boolean'].includes(typeof source)) {
        return Schema.const(source).required();
    }
    else if (source[kSchema]) {
        return source;
    }
    else if (typeof source === 'function') {
        switch (source) {
            case String: return Schema.string().required();
            case Number: return Schema.number().required();
            case Boolean: return Schema.boolean().required();
            case Function: return Schema.function().required();
            default: return Schema.is(source).required();
        }
    }
    else {
        throw new TypeError(`cannot infer schema from ${source}`);
    }
};
Schema.lazy = function lazy(builder) {
    const toJSON = () => {
        if (!schema.inner[kSchema]) {
            schema.inner = schema.builder();
            schema.inner.meta = { ...schema.meta, ...schema.inner.meta };
        }
        return schema.inner.toJSON();
    };
    const schema = new Schema({ type: 'lazy', builder, inner: { toJSON } });
    return schema;
};
Schema.natural = function natural() {
    return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
    return Schema.number().step(0.01).min(0).max(1).role('slider');
};
Schema.date = function date() {
    return Schema.union([
        Schema.is(Date),
        Schema.transform(Schema.string().role('datetime'), (value, options) => {
            const date = new Date(value);
            if (isNaN(+date))
                throw new ValidationError(`invalid date "${value}"`, options);
            return date;
        }, true),
    ]);
};
Schema.regExp = function regExp(flag = '') {
    return Schema.union([
        Schema.is(RegExp),
        Schema.transform(Schema.string().role('regexp', { flag }), (value, options) => {
            try {
                return new RegExp(value, flag);
            }
            catch (e) {
                throw new ValidationError(e.message, options);
            }
        }, true),
    ]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
    return Schema.union([
        Schema.is(ArrayBuffer),
        Schema.is(SharedArrayBuffer),
        Schema.transform(Schema.any(), (value, options) => {
            if (index_1.Binary.isSource(value))
                return index_1.Binary.fromSource(value);
            throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
        }, true),
        ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
                try {
                    return encoding === 'base64'
                        ? index_1.Binary.fromBase64(value)
                        : index_1.Binary.fromHex(value);
                }
                catch (e) {
                    throw new ValidationError(e.message, options);
                }
            }, true)] : [],
    ]);
};
Schema.extend('lazy', (data, schema, options, strict) => {
    if (!schema.inner[kSchema]) {
        schema.inner = schema.builder();
        schema.inner.meta = { ...schema.meta, ...schema.inner.meta };
    }
    return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend('any', (data) => {
    return [data];
});
Schema.extend('never', (data, _, options) => {
    throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend('const', (data, { value }, options) => {
    if ((0, index_1.deepEqual)(data, value))
        return [value];
    throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
    const { max = Infinity, min = -Infinity } = meta;
    if (data > max)
        throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
    if (data < min && !skipMin)
        throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend('string', (data, { meta }, options) => {
    if (typeof data !== 'string')
        throw new ValidationError(`expected string but got ${data}`, options);
    if (meta.pattern) {
        const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
        if (!regexp.test(data))
            throw new ValidationError(`expect string to match regexp ${regexp}`, options);
    }
    checkWithinRange(data.length, meta, 'string length', options);
    return [data];
});
function decimalShift(data, digits) {
    const str = data.toString();
    if (str.includes('e'))
        return data * Math.pow(10, digits);
    const index = str.indexOf('.');
    if (index === -1)
        return data * Math.pow(10, digits);
    const frac = str.slice(index + 1);
    const integer = str.slice(0, index);
    if (frac.length <= digits)
        return +(integer + frac.padEnd(digits, '0'));
    return +(integer + frac.slice(0, digits) + '.' + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
    step = Math.abs(step);
    if (!/^\d+\.\d+$/.test(step.toString())) {
        return (data - min) % step === 0;
    }
    const index = step.toString().indexOf('.');
    const digits = step.toString().slice(index + 1).length;
    return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend('number', (data, { meta }, options) => {
    if (typeof data !== 'number')
        throw new ValidationError(`expected number but got ${data}`, options);
    checkWithinRange(data, meta, 'number', options);
    const { step } = meta;
    if (step && !isMultipleOf(data, meta.min ?? 0, step)) {
        throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
    }
    return [data];
});
Schema.extend('boolean', (data, _, options) => {
    if (typeof data === 'boolean')
        return [data];
    throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend('bitset', (data, { bits, meta }, options) => {
    let value = 0, keys = [];
    if (typeof data === 'number') {
        value = data;
        for (const key in bits) {
            if (data & bits[key]) {
                keys.push(key);
            }
        }
    }
    else if (Array.isArray(data)) {
        keys = data;
        for (const key of keys) {
            if (typeof key !== 'string')
                throw new ValidationError(`expected string but got ${key}`, options);
            if (key in bits)
                value |= bits[key];
        }
    }
    else {
        throw new ValidationError(`expected number or array but got ${data}`, options);
    }
    if (value === meta.default)
        return [value];
    return [value, keys];
});
Schema.extend('function', (data, _, options) => {
    if (typeof data === 'function')
        return [data];
    throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend('is', (data, { constructor }, options) => {
    if (typeof constructor === 'function') {
        if (data instanceof constructor)
            return [data];
        throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
    }
    else {
        if ((0, index_1.isNullable)(data)) {
            throw new ValidationError(`expected ${constructor} but got ${data}`, options);
        }
        let prototype = Object.getPrototypeOf(data);
        while (prototype) {
            if (prototype.constructor?.name === constructor)
                return [data];
            prototype = Object.getPrototypeOf(prototype);
        }
        throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    }
});
function property(data, key, schema, options) {
    try {
        const [value, adapted] = Schema.resolve(data[key], schema, {
            ...options,
            path: [...options.path || [], key],
        });
        if (adapted !== undefined)
            data[key] = adapted;
        return value;
    }
    catch (e) {
        if (!options?.autofix)
            throw e;
        delete data[key];
        return schema.meta.default;
    }
}
Schema.extend('array', (data, { inner, meta }, options) => {
    if (!Array.isArray(data))
        throw new ValidationError(`expected array but got ${data}`, options);
    checkWithinRange(data.length, meta, 'array length', options, !(0, index_1.isNullable)(inner.meta.default));
    return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend('dict', (data, { inner, sKey }, options, strict) => {
    if (!(0, index_1.isPlainObject)(data))
        throw new ValidationError(`expected object but got ${data}`, options);
    const result = {};
    for (const key in data) {
        let rKey;
        try {
            rKey = Schema.resolve(key, sKey, options)[0];
        }
        catch (error) {
            if (strict)
                continue;
            throw error;
        }
        result[rKey] = property(data, key, inner, options);
        data[rKey] = data[key];
        if (key !== rKey)
            delete data[key];
    }
    return [result];
});
Schema.extend('tuple', (data, { list }, options, strict) => {
    if (!Array.isArray(data))
        throw new ValidationError(`expected array but got ${data}`, options);
    const result = list.map((inner, index) => property(data, index, inner, options));
    if (strict)
        return [result];
    result.push(...data.slice(list.length));
    return [result];
});
function merge(result, data) {
    for (const key in data) {
        if (key in result)
            continue;
        result[key] = data[key];
    }
}
Schema.extend('object', (data, { dict }, options, strict) => {
    if (!(0, index_1.isPlainObject)(data))
        throw new ValidationError(`expected object but got ${data}`, options);
    const result = {};
    for (const key in dict) {
        const value = property(data, key, dict[key], options);
        if (!(0, index_1.isNullable)(value) || key in data) {
            result[key] = value;
        }
    }
    if (!strict)
        merge(result, data);
    return [result];
});
Schema.extend('union', (data, { list, toString }, options, strict) => {
    const messages = [];
    for (const inner of list) {
        try {
            return Schema.resolve(data, inner, options, strict);
        }
        catch (error) {
            messages.push(error);
        }
    }
    throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend('intersect', (data, { list, toString }, options, strict) => {
    if (!list.length)
        return [data];
    let result;
    for (const inner of list) {
        const value = Schema.resolve(data, inner, options, true)[0];
        if ((0, index_1.isNullable)(value))
            continue;
        if ((0, index_1.isNullable)(result)) {
            result = value;
        }
        else if (typeof result !== typeof value) {
            throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
        }
        else if (typeof value === 'object') {
            merge(result ?? (result = {}), value);
        }
        else if (result !== value) {
            throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
        }
    }
    if (!strict && (0, index_1.isPlainObject)(data))
        merge(result, data);
    return [result];
});
Schema.extend('transform', (data, { inner, callback, preserve }, options) => {
    const [result, adapted = data] = Schema.resolve(data, inner, options, true);
    if (preserve) {
        return [callback(result)];
        // } else if (isPlainObject(data)) {
        //   const temp: any = {}
        //   for (const key in result) {
        //     if (!(key in data)) continue
        //     temp[key] = data[key]
        //     delete data[key]
        //   }
        //   Object.assign(data, callback!(temp))
        //   return [callback!(result)]
    }
    else {
        return [callback(result), callback(adapted)];
    }
});
const formatters = {};
function defineMethod(name, keys, format) {
    formatters[name] = format;
    Object.assign(Schema, {
        [name](...args) {
            const schema = new Schema({ type: name });
            keys.forEach((key, index) => {
                switch (key) {
                    case 'sKey':
                        schema.sKey = args[index] ?? Schema.string();
                        break;
                    case 'inner':
                        schema.inner = Schema.from(args[index]);
                        break;
                    case 'list':
                        schema.list = args[index].map(Schema.from);
                        break;
                    case 'dict':
                        schema.dict = (0, index_1.valueMap)(args[index], Schema.from);
                        break;
                    case 'bits': {
                        schema.bits = {};
                        for (const key in args[index]) {
                            if (typeof args[index][key] !== 'number')
                                continue;
                            schema.bits[key] = args[index][key];
                        }
                        break;
                    }
                    case 'callback': {
                        const callback = schema.callback = args[index];
                        callback['toJSON'] || (callback['toJSON'] = () => callback.toString());
                        break;
                    }
                    case 'constructor': {
                        const constructor = schema.constructor = args[index];
                        if (typeof constructor === 'function') {
                            ;
                            constructor['toJSON'] || (constructor['toJSON'] = () => constructor['name']);
                        }
                        break;
                    }
                    default: schema[key] = args[index];
                }
            });
            if (name === 'object' || name === 'dict') {
                schema.meta.default = {};
            }
            else if (name === 'array' || name === 'tuple') {
                schema.meta.default = [];
            }
            else if (name === 'bitset') {
                schema.meta.default = 0;
            }
            return schema;
        },
    });
}
defineMethod('is', ['constructor'], ({ constructor }) => {
    if (typeof constructor === 'function') {
        return constructor.name;
    }
    else {
        return constructor;
    }
});
defineMethod('any', [], () => 'any');
defineMethod('never', [], () => 'never');
defineMethod('const', ['value'], ({ value }) => typeof value === 'string' ? JSON.stringify(value) : value);
defineMethod('string', [], () => 'string');
defineMethod('number', [], () => 'number');
defineMethod('boolean', [], () => 'boolean');
defineMethod('bitset', ['bits'], () => 'bitset');
defineMethod('function', [], () => 'function');
defineMethod('array', ['inner'], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod('dict', ['inner', 'sKey'], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod('tuple', ['list'], ({ list }) => `[${list.map((inner) => inner.toString()).join(', ')}]`);
defineMethod('object', ['dict'], ({ dict }) => {
    if (Object.keys(dict).length === 0)
        return '{}';
    return `{ ${Object.entries(dict).map(([key, inner]) => {
        return `${key}${inner.meta.required ? '' : '?'}: ${inner.toString()}`;
    }).join(', ')} }`;
});
defineMethod('union', ['list'], ({ list }, inline) => {
    const result = list.map(({ toString: format }) => format()).join(' | ');
    return inline ? `(${result})` : result;
});
defineMethod('intersect', ['list'], ({ list }) => {
    return `${list.map((inner) => inner.toString(true)).join(' & ')}`;
});
defineMethod('transform', ['inner', 'callback', 'preserve'], ({ inner }, isInner) => inner.toString(isInner));
exports.default = Schema;

},
"src/modules/settings/vendor/cosmokit/index.js": function(module, exports, require) {
// source: src/modules/settings/vendor/cosmokit/index.ts

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
/** Browser schema dependency subset; same implementations, no unused entry exports. */
__exportStar(require("./misc"), exports);
__exportStar(require("./types"), exports);

},
"src/modules/settings/vendor/cosmokit/misc.js": function(module, exports, require) {
// source: src/modules/settings/vendor/cosmokit/misc.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noop = noop;
exports.isNullable = isNullable;
exports.isNonNullable = isNonNullable;
exports.isPlainObject = isPlainObject;
exports.filterKeys = filterKeys;
exports.mapValues = mapValues;
exports.valueMap = mapValues;
exports.pick = pick;
exports.omit = omit;
exports.defineProperty = defineProperty;
/** No-op callback returning `undefined` at runtime and `any` at type level. */
function noop() { }
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
    return value === null || value === undefined;
}
/** Return true when a value is neither `null` nor `undefined`. */
function isNonNullable(value) {
    return !isNullable(value);
}
/** Return true for non-array object values. */
function isPlainObject(data) {
    return data && typeof data === 'object' && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
    return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
    return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
    if (!keys)
        return { ...source };
    const result = {};
    for (const key of keys) {
        if (forced || source[key] !== undefined)
            result[key] = source[key];
    }
    return result;
}
/** Omit selected keys from a shallow object copy. */
function omit(source, keys) {
    if (!keys)
        return { ...source };
    const result = { ...source };
    for (const key of keys) {
        Reflect.deleteProperty(result, key);
    }
    return result;
}
/** Define a non-enumerable writable property and return the object. */
function defineProperty(object, key, value) {
    return Object.defineProperty(object, key, { writable: true, value, enumerable: false });
}

},
"src/modules/settings/vendor/cosmokit/types.js": function(module, exports, require) {
// source: src/modules/settings/vendor/cosmokit/types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.arrayBufferToHex = exports.hexToArrayBuffer = exports.arrayBufferToBase64 = exports.base64ToArrayBuffer = exports.Binary = void 0;
exports.is = is;
exports.clone = clone;
exports.deepEqual = deepEqual;
const misc_1 = require("./misc");
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
    if (arguments.length === 1)
        return (value) => is(type, value);
    return type in globalThis && value instanceof globalThis[type]
        || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
    return is('ArrayBuffer', value) || is('SharedArrayBuffer', value);
}
function isArrayBufferSource(value) {
    return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function (Binary) {
    Binary.is = isArrayBufferLike;
    Binary.isSource = isArrayBufferSource;
    function fromSource(source) {
        if (ArrayBuffer.isView(source)) {
            // https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer#answer-31394257
            return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        }
        else {
            return source;
        }
    }
    Binary.fromSource = fromSource;
    function toBase64(source) {
        source = fromSource(source);
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(source).toString('base64');
        }
        let binary = '';
        const bytes = new Uint8Array(source);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
    Binary.toBase64 = toBase64;
    function fromBase64(source) {
        if (typeof Buffer !== 'undefined')
            return fromSource(Buffer.from(source, 'base64'));
        return Uint8Array.from(atob(source), c => c.charCodeAt(0));
    }
    Binary.fromBase64 = fromBase64;
    function toHex(source) {
        source = fromSource(source);
        if (typeof Buffer !== 'undefined')
            return Buffer.from(source).toString('hex');
        return Array.from(new Uint8Array(source), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    Binary.toHex = toHex;
    function fromHex(source) {
        if (typeof Buffer !== 'undefined')
            return fromSource(Buffer.from(source, 'hex'));
        const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
        const buffer = [];
        for (let i = 0; i < hex.length; i += 2) {
            buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
        }
        return Uint8Array.from(buffer).buffer;
    }
    Binary.fromHex = fromHex;
})(Binary || (exports.Binary = Binary = {}));
/** Decode a base64 string into binary data. */
exports.base64ToArrayBuffer = Binary.fromBase64;
/** Encode binary data as base64. */
exports.arrayBufferToBase64 = Binary.toBase64;
/** Decode a hex string into binary data. */
exports.hexToArrayBuffer = Binary.fromHex;
/** Encode binary data as hex. */
exports.arrayBufferToHex = Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = new Map()) {
    if (!source || typeof source !== 'object')
        return source;
    if (is('Date', source))
        return new Date(source.valueOf());
    if (is('RegExp', source))
        return new RegExp(source.source, source.flags);
    if (isArrayBufferLike(source))
        return source.slice(0);
    if (ArrayBuffer.isView(source))
        return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    const cached = refs.get(source);
    if (cached)
        return cached;
    if (Array.isArray(source)) {
        const result = [];
        refs.set(source, result);
        source.forEach((value, index) => {
            result[index] = Reflect.apply(clone, null, [value, refs]);
        });
        return result;
    }
    const result = Object.create(Object.getPrototypeOf(source));
    refs.set(source, result);
    for (const key of Reflect.ownKeys(source)) {
        const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
        if ('value' in descriptor) {
            descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
        }
        Reflect.defineProperty(result, key, descriptor);
    }
    return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
    if (a === b)
        return true;
    if (!strict && (0, misc_1.isNullable)(a) && (0, misc_1.isNullable)(b))
        return true;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return false;
    if (!a || !b)
        return false;
    function check(test, then) {
        return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : undefined;
    }
    return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index])))
        ?? check(is('Date'), (a, b) => a.valueOf() === b.valueOf())
        ?? check(is('RegExp'), (a, b) => a.source === b.source && a.flags === b.flags)
        ?? check(isArrayBufferLike, (a, b) => {
            if (a.byteLength !== b.byteLength)
                return false;
            const viewA = new Uint8Array(a);
            const viewB = new Uint8Array(b);
            for (let i = 0; i < viewA.length; i++) {
                if (viewA[i] !== viewB[i])
                    return false;
            }
            return true;
        })
        ?? Object.keys({ ...a, ...b }).every(key => deepEqual(a[key], b[key], strict));
}

},
"src/modules/settings/serialized-schema.js": function(module, exports, require) {
// source: src/modules/settings/serialized-schema.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializedSchemaEnvelope = serializedSchemaEnvelope;
const runtime_types_1 = require("../shared/runtime-types");
function isNode(raw, refs) {
    if (!(0, runtime_types_1.isObjectRecord)(raw) || typeof raw.type !== 'string')
        return false;
    if (raw.meta !== undefined && !(0, runtime_types_1.isObjectRecord)(raw.meta))
        return false;
    const child = (value) => value === undefined || (refs === undefined
        ? isNode(value) : typeof value === 'number' && Number.isSafeInteger(value) && (0, runtime_types_1.isObjectRecord)(refs[value]));
    if (!child(raw.inner) || !child(raw.sKey))
        return false;
    if (raw.list !== undefined && (!Array.isArray(raw.list) || !raw.list.every(child)))
        return false;
    if (raw.dict !== undefined && (!(0, runtime_types_1.isObjectRecord)(raw.dict) || !Object.values(raw.dict).every(child)))
        return false;
    return true;
}
function isEnvelope(raw) {
    if (!(0, runtime_types_1.isObjectRecord)(raw))
        return false;
    if (raw.refs === undefined)
        return isNode(raw);
    if (!(0, runtime_types_1.isObjectRecord)(raw.refs) || typeof raw.uid !== 'number' || !Number.isSafeInteger(raw.uid) || !(0, runtime_types_1.isObjectRecord)(raw.refs[raw.uid]))
        return false;
    const refs = raw.refs;
    return Object.values(refs).every(value => isNode(value, refs));
}
function serializedSchemaEnvelope(raw) {
    if (!isEnvelope(raw))
        throw new TypeError('ui-settings: malformed serialized schema envelope');
    return raw;
}

},
"src/modules/settings/settings-scope.js": function(module, exports, require) {
// source: src/modules/settings/settings-scope.ts

"use strict";
/**
 * Host transport for the settings-namespace scope contract. The contract types
 * live in `dsh-client-runtime` (the common dependency of every feature that
 * owns a preference); this file owns the per-namespace derivation over the
 * shared {@link SettingsDescribeMirror} and the serialized write path, both of
 * which are Settings-surface concerns. Reads never touch the wire here: the
 * mirror is the one `settings.describe` reader, and every scope is a selector
 * over its snapshot.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsScopeBinder = exports.SettingsScopeController = void 0;
const context_1 = require("./context");
const cordis_1 = require("@xharness/cordis");
const client_1 = require("@xharness/dsh-client-runtime/client");
const save_feedback_1 = require("./save-feedback");
const Service = cordis_1.Service;
/**
 * One namespace's derived view over the shared describe mirror, plus that
 * namespace's serialized Host writes. Writes carry the latest known namespace
 * revision, fold their answers back into the mirror, and teardown waits for
 * the operation already crossing the wire.
 */
class SettingsScopeBase {
    /**
     * @param api - settings wire face (writes only; reads ride the mirror).
     * @param spec - namespace identity and optional narrowing decoder.
     * @param mirror - the shared describe mirror this scope derives from.
     * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
     * @param schema - settings-owned schema operations.
     */
    constructor(api, spec, mirror, persistence, schema) {
        this.api = api;
        this.spec = spec;
        this.mirror = mirror;
        this.persistence = persistence;
        this.schema = schema;
        this.tail = Promise.resolve();
        this.writeGeneration = 0;
        this.disposed = false;
        this.store = (0, client_1.createSnapshotStore)({
            status: persistence === 'host' ? 'loading' : 'unavailable',
            value: undefined,
            base: undefined,
            user: undefined,
            revision: undefined,
            writable: false,
            mode: persistence,
        });
        if (persistence === 'host') {
            this.unsubscribe = mirror.subscribe(() => { this.derive(); });
            this.derive();
        }
    }
    /** @returns the current sync snapshot (stable reference until the next change). */
    getSnapshot() {
        return this.store.getSnapshot();
    }
    /**
     * Observe snapshot replacements.
     * @param listener - invoked after each snapshot change.
     * @returns the disposer removing this listener.
     */
    subscribe(listener) {
        return this.store.subscribe(listener);
    }
    /**
     * Queue one field write; see {@link SettingsScope.set} for the ordering,
     * revision, and recovery contract.
     * @param field - scalar field inside the namespace section.
     * @param value - JSON-shaped value selected by the user.
     * @returns settlement after the write and any latest-write recovery read.
     */
    set(field, value) {
        return this.write({ op: 'set', path: [field], value });
    }
    /**
     * Queue one field clear; see {@link SettingsScope.unset} for the ordering,
     * revision, and recovery contract.
     * @param field - scalar field inside the namespace section.
     * @returns settlement after the clear and any latest-write recovery read.
     */
    unset(field) {
        return this.write({ op: 'unset', path: [field] });
    }
    write(op) {
        const generation = ++this.writeGeneration;
        return this.enqueue(async () => {
            const revision = this.pendingRevision ?? this.getSnapshot().revision;
            let response;
            try {
                response = await this.api.settings.mutate({
                    ns: this.spec.namespace,
                    ops: [op],
                    ...(revision === undefined ? {} : { expectedRevision: revision }),
                });
            }
            catch (_settingsWriteFailure) {
                await this.recover(generation);
                return;
            }
            if (!response.result.ok) {
                await this.recover(generation);
                return;
            }
            if (this.disposed)
                return;
            if (generation === this.writeGeneration) {
                this.pendingRevision = undefined;
                this.mirror.acceptView(response.result.value);
                (0, save_feedback_1.settingsSaveFeedback)(this.spec.namespace, false);
            }
            else {
                this.pendingRevision = response.result.value.revision;
            }
        });
    }
    /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
    async recover(generation) {
        if (this.disposed || generation !== this.writeGeneration)
            return;
        this.pendingRevision = undefined;
        try {
            await this.mirror.load();
        }
        catch { /* A failed reread is still a failed save. */ }
        if (!this.disposed && generation === this.writeGeneration)
            (0, save_feedback_1.settingsSaveFeedback)(this.spec.namespace, true);
    }
    /**
     * Stop queued operations, stop deriving, and wait for the current wire call
     * to settle.
     * @returns settlement after the controller reaches quiescence.
     */
    async dispose() {
        this.disposed = true;
        this.writeGeneration += 1;
        this.unsubscribe?.();
        await this.tail;
    }
    enqueue(operation) {
        if (this.persistence === 'memory' || this.disposed)
            return Promise.resolve();
        const task = this.tail.then(async () => {
            if (this.disposed)
                return;
            await operation();
        });
        // The returned task carries its own settlement to the caller; the queue
        // tail is kept fulfilled so one failed subscriber cannot strand later operations.
        this.tail = task.catch(() => { });
        return task;
    }
    derive() {
        if (this.disposed)
            return;
        const mirrored = this.mirror.getSnapshot();
        if (mirrored.view === undefined)
            return;
        const { writable } = mirrored.view;
        const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace);
        if (view === undefined) {
            this.store.update((draft) => {
                draft.status = 'unavailable';
                draft.writable = writable;
            });
            return;
        }
        const decoded = this.decode(view);
        const previous = this.store.getSnapshot();
        const next = {
            ...previous, revision: view.revision, base: view.base, user: view.user, writable,
            ...(decoded === undefined ? {} : { status: 'ready', value: decoded }),
        };
        // A decoded generic value is a replacement, never an unproved Immer Draft<T>.
        // Preserve the recipe's no-op identity/notification behavior when every field
        // is unchanged; the store remains the only publication boundary.
        if (next.revision !== previous.revision || next.base !== previous.base
            || next.user !== previous.user || next.writable !== previous.writable
            || next.status !== previous.status || next.value !== previous.value)
            this.store.set(next);
    }
}
/** Default public JS controller preserves optional-decoder behavior. Without a
 * domain decoder it validates a record, never promises an arbitrary T. */
class SettingsScopeController extends SettingsScopeBase {
    decode(view) {
        if (this.spec.decode !== undefined)
            return this.spec.decode(view.value);
        // Sections are plain objects by construction; schemastery alone would
        // resolve null or an array through object defaults instead of refusing.
        if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value))
            return undefined;
        let failure;
        try {
            failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value);
        }
        catch (_malformedSchemaEnvelope) {
            // A schema envelope this client cannot rehydrate vouches for no section;
            // the value is treated exactly like a schema-invalid one.
            return undefined;
        }
        return failure === undefined ? view.value : undefined;
    }
}
exports.SettingsScopeController = SettingsScopeController;
class DecodedSettingsScopeController extends SettingsScopeBase {
    constructor(api, spec, mirror, persistence, schema) {
        super(api, spec, mirror, persistence, schema);
    }
    decode(view) {
        return this.spec.decode?.(view.value);
    }
}
/**
 * The settings domain's base service. Features that own a preference reach the
 * settings transport through this service rather than a shared function: the
 * client bundle purity gate forbids cross-plugin value imports and directs
 * cross-plugin collaboration through cordis services
 * (`packages/client/tsdown.client.ts`).
 */
class SettingsScopeBinder extends Service {
    /**
     * @param ctx - the providing plugin's context.
     * @param config - the shared describe mirror every bound scope derives from,
     * plus the settings-owned schema operations.
     */
    constructor(ctx, config) {
        super((0, context_1.cordisSettingsContext)(ctx), 'settingsScope');
        this.mirror = config.mirror;
        this.schema = config.schema;
    }
    /**
     * The shared mirror's read/fold face for cross-namespace surfaces (schema
     * introspection, the served-namespace directory). Per-namespace consumers
     * use {@link bind}; both derive from the same snapshot, so they can never
     * disagree about the document.
     * @returns the describe face over the shared mirror.
     */
    describe() {
        return this.mirror;
    }
    bind(spec) {
        const traced = this.ctx;
        const ctx = (0, context_1.settingsContext)(traced);
        const connection = ctx.get('connection');
        const persistence = connection.isLoopback ? 'host' : 'memory';
        const controller = spec.decode === undefined
            ? new SettingsScopeController(connection.api, spec, this.mirror, persistence, this.schema)
            : new DecodedSettingsScopeController(connection.api, { namespace: spec.namespace, decode: spec.decode }, this.mirror, persistence, this.schema);
        ctx.effect(() => {
            void this.mirror.ensure();
            return async () => {
                await controller.dispose();
            };
        }, `ui-settings: ${spec.namespace} settings scope`);
        return controller;
    }
}
exports.SettingsScopeBinder = SettingsScopeBinder;

},
"src/modules/settings/save-feedback.js": function(module, exports, require) {
// source: src/modules/settings/save-feedback.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsSaveFeedback = settingsSaveFeedback;
/** One bounded notice; never display provider errors, preference values or HTML. */
function settingsSaveFeedback(namespace, failed) {
    if (typeof document === 'undefined')
        return;
    const id = 'xharness-settings-save-failure';
    let notice = document.getElementById(id);
    if (!failed) {
        if (notice?.dataset.namespace === namespace)
            notice.remove();
        return;
    }
    if (!document.body)
        return;
    const zh = (document.documentElement.lang || navigator.language || 'en').startsWith('zh');
    const messages = zh
        ? ['设置未保存，请检查连接后重试。', '关闭提示']
        : ['Settings were not saved. Check the connection and try again.', 'Dismiss notice'];
    if (!notice) {
        notice = document.createElement('div');
        notice.id = id;
        notice.setAttribute('role', 'alert');
        notice.setAttribute('aria-atomic', 'true');
        notice.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1000;box-sizing:border-box;max-width:calc(100vw - 32px);width:max-content;display:flex;align-items:center;gap:16px;padding:12px 16px;border-radius:10px;background:#323232;color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 4px 20px #0003;';
        const message = document.createElement('span');
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.style.cssText = 'flex:none;border:1px solid #ffffff70;border-radius:6px;background:transparent;color:inherit;padding:4px 8px;font:inherit;cursor:pointer;';
        dismiss.addEventListener('click', () => notice?.remove());
        notice.append(message, dismiss);
    }
    notice.dataset.namespace = namespace;
    if (notice.children[0])
        notice.children[0].textContent = messages[0];
    if (notice.children[1])
        notice.children[1].textContent = messages[1];
    // Keep the notice inside an active modal's layer, without moving user focus.
    const modal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .filter(node => node.getClientRects().length > 0).at(-1);
    (modal || document.body).append(notice);
}

},
"src/modules/settings/settings-mirror.js": function(module, exports, require) {
// source: src/modules/settings/settings-mirror.ts

"use strict";
/**
 * Client mirror of the Host settings document: the one `settings.describe`
 * reader in the browser. Every settings consumer derives from this store —
 * per-namespace scopes through `SettingsScopeBinder.bind`, cross-namespace
 * surfaces through the binder's shared describe face — so startup cost and
 * freshness are properties of this class, not of how many features own a
 * preference. The Host stays the fact source: the mirror re-reads on the
 * invalidations its owning plugin subscribes to and folds write answers in
 * through {@link SettingsDescribeMirror.acceptView}.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsDescribeMirror = void 0;
const client_1 = require("@xharness/dsh-client-runtime/client");
/**
 * Serializes every Host `settings.describe` read behind one snapshot store.
 * Concurrent {@link load} calls fold into the in-flight read plus one rerun,
 * so an invalidation arriving mid-read is never lost and never duplicated.
 */
class SettingsDescribeMirror {
    /**
     * @param api - settings wire face.
     * @param persistence - remote browsers stay process-local because settings RPCs are loopback-only.
     */
    constructor(api, persistence = 'host') {
        this.api = api;
        this.persistence = persistence;
        this.rerun = false;
        this.generation = 0;
        this.store = (0, client_1.createSnapshotStore)({
            status: persistence === 'host' ? 'idle' : 'unavailable',
            view: undefined,
            error: null,
        });
    }
    /** @returns the current sync snapshot (stable reference until the next change). */
    getSnapshot() {
        return this.store.getSnapshot();
    }
    /**
     * Observe snapshot replacements.
     * @param listener - invoked after each snapshot change.
     * @returns the disposer removing this listener.
     */
    subscribe(listener) {
        return this.store.subscribe(listener);
    }
    /**
     * Refresh from the Host. A call during an in-flight read marks one rerun
     * after it settles instead of racing a second wire read.
     * @returns settlement after this call's freshness is reflected.
     */
    load() {
        if (this.persistence === 'memory')
            return Promise.resolve();
        if (this.inFlight !== undefined) {
            this.rerun = true;
            return this.inFlight;
        }
        // Own the slot before the loading publication can synchronously reenter load().
        const run = Promise.resolve().then(() => this.run());
        this.inFlight = run;
        return run;
    }
    /**
     * Resolve once an answer is held (or the mirror is terminally unavailable),
     * reading only from `idle`. The cheap idempotent entry for surfaces that
     * render on first use.
     * @returns settlement of the current or newly started read, if any.
     */
    ensure() {
        if (this.persistence === 'memory')
            return Promise.resolve();
        if (this.inFlight !== undefined)
            return this.inFlight;
        if (this.getSnapshot().status === 'idle')
            return this.load();
        return Promise.resolve();
    }
    /**
     * Fold one write answer's namespace view into the held view without a wire
     * read, and invalidate any read still in flight. With no held document, the
     * answer is not published as a partial document; an in-flight read reruns so
     * it cannot publish a document fetched before the write committed.
     * @param view - the namespace view a settings write answered with.
     */
    acceptView(view) {
        const before = this.store.getSnapshot();
        this.generation += 1;
        if (this.inFlight !== undefined)
            this.rerun = true;
        if (before.view === undefined)
            return;
        const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
            ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
            : [...before.view.namespaces, view];
        this.store.set({ ...before, view: { ...before.view, namespaces } });
    }
    /**
     * Convenience row lookup on the held view.
     * @param ns - namespace identity.
     * @returns the namespace view, or undefined while unanswered or unregistered.
     */
    namespace(ns) {
        return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns);
    }
    async run() {
        // The in-flight slot must clear in the same synchronous segment that
        // observes `rerun` false (and on abrupt exit): a `.finally()` on the
        // returned promise runs one microtask later, and a `load()` landing in
        // that gap would mark a rerun nobody reads, losing the read.
        try {
            do {
                const before = this.store.getSnapshot();
                if (before.status === 'idle')
                    this.store.set({ ...before, status: 'loading' });
                // Cleared immediately before the wire read goes out: a load() marked
                // earlier (including one reentering from the loading publish above)
                // is covered by this very read, while one landing after needs the
                // rerun.
                this.rerun = false;
                const generation = ++this.generation;
                let outcome;
                try {
                    const response = await this.api.settings.describe({});
                    outcome = response.result.ok
                        ? { view: response.result.value }
                        : { failure: response.result.error.message };
                }
                catch (error) {
                    outcome = { failure: error instanceof Error ? error.message : String(error) };
                }
                // A write answer invalidates a document read before that write committed.
                if (generation !== this.generation)
                    continue;
                if ('view' in outcome) {
                    this.store.set({ status: 'ready', view: outcome.view, error: null });
                }
                else {
                    const held = this.store.getSnapshot();
                    // No answer yet: fall back to idle so `ensure` retries; with one, the
                    // held view keeps serving and only the error field reports the miss.
                    this.store.set({
                        status: held.view === undefined ? 'idle' : 'ready',
                        view: held.view,
                        error: outcome.failure,
                    });
                }
            } while (this.shouldRerun());
        }
        finally {
            this.inFlight = undefined;
        }
    }
    shouldRerun() {
        return this.rerun;
    }
}
exports.SettingsDescribeMirror = SettingsDescribeMirror;

}
};
const __dependencies = {"src/modules/settings/index.js":{"./schema":"src/modules/settings/schema.js","./settings-scope":"src/modules/settings/settings-scope.js","./settings-mirror":"src/modules/settings/settings-mirror.js"},"src/modules/settings/schema.js":{"./context":"src/modules/settings/context.js","./vendor/schemastery/index":"src/modules/settings/vendor/schemastery/index.js","./serialized-schema":"src/modules/settings/serialized-schema.js","../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/settings/context.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/settings/vendor/schemastery/index.js":{"../cosmokit/index":"src/modules/settings/vendor/cosmokit/index.js"},"src/modules/settings/vendor/cosmokit/index.js":{"./misc":"src/modules/settings/vendor/cosmokit/misc.js","./types":"src/modules/settings/vendor/cosmokit/types.js"},"src/modules/settings/vendor/cosmokit/misc.js":{},"src/modules/settings/vendor/cosmokit/types.js":{"./misc":"src/modules/settings/vendor/cosmokit/misc.js"},"src/modules/settings/serialized-schema.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/settings/settings-scope.js":{"./context":"src/modules/settings/context.js","./save-feedback":"src/modules/settings/save-feedback.js"},"src/modules/settings/save-feedback.js":{},"src/modules/settings/settings-mirror.js":{}};
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
return __load("src/modules/settings/index.js");
}
});
