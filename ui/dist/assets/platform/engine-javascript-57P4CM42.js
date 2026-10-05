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

// node_modules/@shikijs/engine-javascript/dist/scanner-DX8LRFGE.mjs
init_define_process_execArgv();
var MAX = 4294967295;
var JavaScriptScanner = class {
  patterns;
  options;
  regexps;
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
  }
  findNextMatchSync(string, startPosition, _options) {
    const str = typeof string === "string" ? string : string.content;
    const pending = [];
    function toResult(index, match, offset = 0) {
      return {
        index,
        captureIndices: match.indices.map((indice) => {
          if (indice == null) return {
            start: MAX,
            end: MAX,
            length: 0
          };
          return {
            start: indice[0] + offset,
            end: indice[1] + offset,
            length: indice[1] - indice[0]
          };
        })
      };
    }
    for (let i = 0; i < this.regexps.length; i++) {
      const regexp = this.regexps[i];
      if (!regexp) continue;
      try {
        regexp.lastIndex = startPosition;
        const match = regexp.exec(str);
        if (!match) continue;
        if (match.index === startPosition) return toResult(i, match, 0);
        pending.push([
          i,
          match,
          0
        ]);
      } catch (e) {
        if (this.options.forgiving) continue;
        throw e;
      }
    }
    if (pending.length) {
      const minIndex = Math.min(...pending.map((m) => m[1].index));
      for (const [i, match, offset] of pending) if (match.index === minIndex) return toResult(i, match, offset);
    }
    return null;
  }
};

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
    createString(s) {
      return { content: s };
    }
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
    createString(s) {
      return { content: s };
    }
  };
}
export {
  JavaScriptScanner,
  createJavaScriptRawEngine,
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor
};
//# sourceMappingURL=engine-javascript-57P4CM42.js.map
