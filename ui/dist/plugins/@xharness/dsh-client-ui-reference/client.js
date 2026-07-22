// Generated from src/modules/reference/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-reference",
factory: (__externalRequire) => {
const __units = {
"src/modules/reference/index.js": function(module, exports, require) {
// source: src/modules/reference/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const runtime_types_1 = require("../shared/runtime-types");
const file_reference_grammar_1 = require("../shared/file-reference-grammar");
const locales_1 = require("./locales");
/** Required services: the trigger registry, the Remote namespaces, and the copy. */
exports.inject = [
    'inputTriggers', 'locale', 'remote', 'remote.fileReferences', 'remote.sessionReferenceResolver',
];
/**
 * Register the combined `@file` / `@session` source.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-reference: dictionaries');
    const t = ctx.locale.bind(locales_1.NS);
    const source = {
        trigger: '@',
        name: 'reference',
        showGroupTitle: false,
        async candidates(session, { query, quoted, signal }) {
            const files = ctx.remote.fileReferences.list(session.sessionId, query, signal).then(result => result.ok ? result.value : [], () => []);
            const sessions = quoted === true
                ? Promise.resolve([])
                : ctx.remote.sessionReferenceResolver.candidates(session.sessionId, query, signal).then(result => result.ok ? result.value : [], () => []);
            const [fileItems, sessionItems] = await Promise.all([files, sessions]);
            if (signal.aborted)
                return [];
            return [
                ...fileItems.flatMap(candidate => fileCandidate(candidate, quoted === true, t)),
                ...sessionItems.map(candidate => sessionCandidate(candidate, t)),
            ];
        },
        onPick({ candidate }) {
            const value = parseCandidate(candidate.value);
            if (value?.kind === 'file') {
                return value.fileKind === 'directory'
                    ? { text: value.mention, continue: true }
                    : {
                        insert: {
                            source: 'reference',
                            ref: value.mention,
                            label: value.label,
                            appearance: 'file',
                            clipboardText: value.mention,
                        },
                    };
            }
            if (value?.kind === 'session') {
                return {
                    insert: {
                        source: 'reference',
                        ref: value.mention,
                        label: value.label,
                        appearance: 'session',
                        clipboardText: value.mention,
                    },
                };
            }
            return undefined;
        },
        codec: {
            clipboardText: ref => ref,
            serialize: ref => Promise.resolve(ref),
        },
    };
    const inputTriggers = ctx.get('inputTriggers');
    ctx.effect(() => inputTriggers.registerSource(source), 'ui-reference: @ source');
}
function fileCandidate(candidate, preserveQuote, t) {
    const mention = (0, file_reference_grammar_1.formatFileMention)(candidate, preserveQuote);
    if (mention === undefined)
        return [];
    const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1);
    const directory = candidate.kind === 'directory';
    const value = {
        kind: 'file',
        fileKind: candidate.kind,
        label: name,
        mention,
    };
    return [{
            name: `${t(directory ? 'candidate.folder' : 'candidate.file')} · ${name}${directory ? '/' : ''}`,
            description: candidate.path,
            section: t('section.files'),
            value: JSON.stringify(value),
        }];
}
function sessionCandidate(candidate, t) {
    const location = candidate.cwd ?? t('candidate.noCwd');
    const description = `${candidate.label === candidate.sessionId ? '' : `${candidate.sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`;
    const value = {
        kind: 'session',
        label: candidate.label,
        mention: candidate.mention,
    };
    return {
        name: `${t('candidate.session')} · ${candidate.label}`,
        description,
        section: t('section.sessions'),
        value: JSON.stringify(value),
    };
}
function parseCandidate(value) {
    if (value === undefined)
        return undefined;
    const parsed = JSON.parse(value);
    if (!(0, runtime_types_1.isObjectRecord)(parsed) || typeof parsed.label !== 'string' || typeof parsed.mention !== 'string')
        return undefined;
    if (parsed.kind === 'session')
        return { kind: 'session', label: parsed.label, mention: parsed.mention };
    if (parsed.kind === 'file' && (parsed.fileKind === 'file' || parsed.fileKind === 'directory'))
        return { kind: 'file', fileKind: parsed.fileKind, label: parsed.label, mention: parsed.mention };
    return undefined;
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
"src/modules/shared/file-reference-grammar.js": function(module, exports, require) {
// source: src/modules/shared/file-reference-grammar.ts

"use strict";
/**
 * Browser-safe `@file` token grammar shared by terminal and web clients.
 *
 * @module @xharness/dsh-file-reference/grammar
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeAtToken = activeAtToken;
exports.formatFileMention = formatFileMention;
/**
 * Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
 * inside another token, such as an email address, is not a completion trigger.
 * @param line - current editor line.
 * @param cursorCol - cursor column within that line.
 * @returns the active token, or `undefined` outside an `@` token.
 */
function activeAtToken(line, cursorCol) {
    const beforeCursor = line.slice(0, cursorCol);
    const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
    if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
        return { prefix: quoted[1], query: quoted[2], quoted: true };
    }
    const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
    if (plain?.[1] === undefined || plain[2] === undefined)
        return undefined;
    return { prefix: plain[1], query: plain[2], quoted: false };
}
/**
 * Format a selected path as prompt text. Whitespace uses the quoted
 * `@"path"` grammar; a quoted directory keeps that quote open after its
 * trailing slash so completion can descend another level.
 * @param candidate - selected file or directory.
 * @param preserveQuote - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
 */
function formatFileMention(candidate, preserveQuote) {
    const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path))
        return undefined;
    const quoted = preserveQuote || /\s/u.test(path);
    if (!quoted)
        return `@${path}`;
    if (candidate.kind === 'directory')
        return `@"${path}`;
    return `@"${path}"`;
}

},
"src/modules/reference/locales.js": function(module, exports, require) {
// source: src/modules/reference/locales.ts

"use strict";
/** `reference` namespace dictionaries for the unified `@` source. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'reference';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'section.files': '文件与文件夹',
    'section.sessions': 'Session 对话',
    'candidate.file': '文件',
    'candidate.folder': '文件夹',
    'candidate.session': 'Session',
    'candidate.noCwd': '（无工作目录）',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'section.files': 'Files & folders',
    'section.sessions': 'Session conversations',
    'candidate.file': 'File',
    'candidate.folder': 'Folder',
    'candidate.session': 'Session',
    'candidate.noCwd': '(no cwd)',
};

}
};
const __dependencies = {"src/modules/reference/index.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","../shared/file-reference-grammar":"src/modules/shared/file-reference-grammar.js","./locales":"src/modules/reference/locales.js"},"src/modules/shared/runtime-types.js":{},"src/modules/shared/file-reference-grammar.js":{},"src/modules/reference/locales.js":{}};
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
return __load("src/modules/reference/index.js");
}
});
