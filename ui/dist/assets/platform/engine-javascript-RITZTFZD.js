import {
  toRegExp
} from "./chunk-CT2UBRMN.js";
import {
  init_define_process_execArgv
} from "./chunk-YOCBWPQK.js";

// node_modules/shiki/dist/engine-javascript.mjs
init_define_process_execArgv();

// node_modules/@shikijs/engine-javascript/dist/index.mjs
init_define_process_execArgv();

// node_modules/@shikijs/engine-javascript/dist/string-TLTPtCPs.mjs
init_define_process_execArgv();
var MAX = 4294967295;
function isSearchCacheable(regexp) {
  return !regexp.sticky && !regexp.rawOptions?.strategy;
}
function toResult(index, indices) {
  return {
    index,
    captureIndices: indices.map((indice) => {
      if (indice == null) return {
        start: MAX,
        end: MAX,
        length: 0
      };
      return {
        start: indice[0],
        end: indice[1],
        length: indice[1] - indice[0]
      };
    })
  };
}
var JavaScriptScanner = class {
  patterns;
  options;
  regexps;
  /**
  * Last search of each regexp on the current string, reused the way `vscode-oniguruma` does.
  * `null` for regexps whose searches can't be reused.
  */
  lastSearches;
  constructor(patterns, options = {}) {
    this.patterns = patterns;
    this.options = options;
    const { forgiving = false, cache, regexConstructor } = options;
    if (!regexConstructor) throw new Error("Option `regexConstructor` is not provided");
    this.regexps = patterns.map((p) => {
      if (typeof p !== "string") return p;
      const cached = cache?.get(p);
      if (cached) {
        if (cached instanceof RegExp) return cached;
        if (forgiving) return null;
        throw cached;
      }
      try {
        const regex = regexConstructor(p);
        cache?.set(p, regex);
        return regex;
      } catch (e) {
        cache?.set(p, e);
        if (forgiving) return null;
        throw e;
      }
    });
    this.lastSearches = this.regexps.map((regexp) => regexp && isSearchCacheable(regexp) ? {
      strId: 0,
      searchedFrom: 0,
      matchIndex: -1,
      indices: null
    } : null);
  }
  findNextMatchSync(string, startPosition, _options) {
    const str = typeof string === "string" ? string : string.content;
    const strId = typeof string === "string" ? 0 : string.id || 0;
    let bestIndex = -1;
    let bestMatchIndex = 0;
    let bestIndices = null;
    for (let i = 0; i < this.regexps.length; i++) {
      const regexp = this.regexps[i];
      if (!regexp) continue;
      try {
        const last = strId ? this.lastSearches[i] : null;
        let matchIndex;
        let indices;
        if (last && last.strId === strId && last.searchedFrom <= startPosition && (last.matchIndex === -1 || last.matchIndex >= startPosition)) {
          matchIndex = last.matchIndex;
          indices = last.indices;
        } else {
          regexp.lastIndex = startPosition;
          const match = regexp.exec(str);
          matchIndex = match ? match.index : -1;
          indices = match ? match.indices : null;
          if (last) {
            last.strId = strId;
            last.searchedFrom = startPosition;
            last.matchIndex = matchIndex;
            last.indices = indices;
          }
        }
        if (matchIndex === -1) continue;
        if (matchIndex === startPosition) return toResult(i, indices);
        if (bestIndex === -1 || matchIndex < bestMatchIndex) {
          bestIndex = i;
          bestMatchIndex = matchIndex;
          bestIndices = indices;
        }
      } catch (e) {
        if (this.options.forgiving) continue;
        throw e;
      }
    }
    return bestIndex === -1 ? null : toResult(bestIndex, bestIndices);
  }
};
var lastStringId = 0;
function createJavaScriptEngineString(content) {
  return {
    content,
    id: ++lastStringId
  };
}

// node_modules/@shikijs/engine-javascript/dist/engine-compile.mjs
init_define_process_execArgv();
function defaultJavaScriptRegexConstructor(pattern, options) {
  return toRegExp(pattern, {
    global: true,
    hasIndices: true,
    lazyCompileLength: 3e3,
    rules: {
      allowOrphanBackrefs: true,
      asciiWordBoundaries: true,
      captureGroup: true,
      recursionLimit: 5,
      singleline: true
    },
    ...options
  });
}
function createJavaScriptRegexEngine(options = {}) {
  const _options = {
    target: "auto",
    cache: /* @__PURE__ */ new Map(),
    ...options
  };
  _options.regexConstructor ||= (pattern) => defaultJavaScriptRegexConstructor(pattern, { target: _options.target });
  return {
    createScanner(patterns) {
      return new JavaScriptScanner(patterns, _options);
    },
    createString: createJavaScriptEngineString
  };
}

// node_modules/@shikijs/engine-javascript/dist/engine-raw.mjs
init_define_process_execArgv();
function createJavaScriptRawEngine() {
  const options = {
    cache: /* @__PURE__ */ new Map(),
    regexConstructor: () => {
      throw new Error("JavaScriptRawEngine: only support precompiled grammar");
    }
  };
  return {
    createScanner(patterns) {
      return new JavaScriptScanner(patterns, options);
    },
    createString: createJavaScriptEngineString
  };
}
export {
  JavaScriptScanner,
  createJavaScriptRawEngine,
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor
};
//# sourceMappingURL=engine-javascript-RITZTFZD.js.map
