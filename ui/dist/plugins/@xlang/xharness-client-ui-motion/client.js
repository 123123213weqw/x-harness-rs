// Generated from src/modules/motion/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-motion",
factory: (__externalRequire) => {
const __units = {
"src/modules/motion/index.js": function(module, exports, require) {
// source: src/modules/motion/index.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHURN_WINDOW_MS = exports.STREAM_TAGS = exports.inject = void 0;
exports.apply = apply;
exports.planStreamAnimations = planStreamAnimations;
/// <reference path="../shared/assets.d.ts" />
const Motion_css_1 = __importDefault(require("./Motion.css"));
const STYLE_ID = 'xharness-stream-motion-style';
// Markdown block tags whose first appearance is animated. Inline churn
// (spans re-rendered as text grows) never matches, so only new blocks
// fade — the effect is paragraph-level, like ZCode's.
const STREAM_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'UL', 'OL',
    'TABLE', 'BLOCKQUOTE', 'IMG', 'HR',
]);
exports.STREAM_TAGS = STREAM_TAGS;
const STAGGER_MS = 45;
const MAX_STAGGER_STEPS = 5;
// React re-renders a growing block by replacing it; consecutive additions
// into the same parent within this window are treated as that churn.
const CHURN_WINDOW_MS = 300;
exports.CHURN_WINDOW_MS = CHURN_WINDOW_MS;
// ---------------------------------------------------------------- core --
// Pure planner so the selection rules are testable without a DOM. The
// Element interface used: tagName, parentElement, contains, closest.
function hasElementShape(value) {
    return typeof value === 'object' && value !== null && 'tagName' in value && typeof value.tagName === 'string';
}
function planStreamAnimations(added, lastRow, now, recent) {
    const candidates = [];
    for (const node of added) {
        if (node === null || node === undefined)
            continue;
        if (!hasElementShape(node))
            continue;
        if (lastRow === null || lastRow === undefined)
            continue;
        if (!lastRow.contains(node))
            continue;
        if (node.closest('[data-transcript-mounted="false"]') !== null)
            continue;
        if (node.closest('[data-xh-stream-animate="true"]') !== null)
            continue;
        // The source Markdown renderer owns append-only prose motion. Never fade
        // its whole paragraph again, including at finish or history restoration.
        if (node.closest('[data-xh-stream-owned]') !== null)
            continue;
        if (!STREAM_TAGS.has(node.tagName))
            continue;
        candidates.push(node);
    }
    // Nested targets (a P inside an added LI) animate once, on the ancestor.
    const deduped = [];
    for (const node of candidates) {
        if (candidates.some((other) => other !== node && other.contains(node)))
            continue;
        deduped.push(node);
    }
    // Churn suppression is cross-batch only: siblings arriving in the same
    // batch stagger together, while re-renders of the same parent within
    // the window stay suppressed (the window refreshes on every hit).
    const kept = [];
    const touched = new Set();
    for (const node of deduped) {
        const parent = node.parentElement;
        if (parent !== null && !touched.has(parent)) {
            const last = recent.get(parent) ?? 0;
            if (now - last < CHURN_WINDOW_MS) {
                recent.set(parent, now);
                touched.add(parent);
                continue;
            }
        }
        kept.push(node);
    }
    for (const node of kept) {
        const parent = node.parentElement;
        if (parent !== null) {
            recent.set(parent, now);
            touched.add(parent);
        }
    }
    return kept.map((node, index) => ({
        node,
        delayMs: Math.min(index, MAX_STAGGER_STEPS) * STAGGER_MS,
    }));
}
// ---------------------------------------------------------- wiring --
function lastTranscriptRow(root) {
    const rows = root.querySelectorAll('[data-transcript-mounted]');
    return rows.length > 0 ? rows[rows.length - 1] ?? null : null;
}
function turnActive() {
    // The upstream turn-status bar only exists while a turn runs; its
    // hashed class keeps the semantic `turnStatus` suffix.
    return document.querySelector('[class*="_turnStatus"]') !== null;
}
function applyAnimation(node, delayMs) {
    node.setAttribute('data-xh-stream-animate', 'true');
    if (delayMs > 0)
        node.style.setProperty('--xh-stream-delay', `${delayMs}ms`);
    const done = (event) => {
        if (event.target !== node)
            return;
        node.removeEventListener('animationend', done);
        node.removeAttribute('data-xh-stream-animate');
        node.style.removeProperty('--xh-stream-delay');
    };
    node.addEventListener('animationend', done);
}
function observeRoot(root) {
    if (roots.has(root))
        return;
    roots.add(root);
    // Weak keys avoid retaining every replaced markdown parent for the
    // lifetime of a long-running conversation.
    const recent = new WeakMap();
    let pending = [];
    let flush = 0;
    const drain = () => {
        flush = 0;
        if (reduced()) {
            pending = [];
            return;
        }
        if (!turnActive()) {
            pending = [];
            return;
        }
        const added = pending;
        pending = [];
        for (const { node, delayMs } of planStreamAnimations(added, lastTranscriptRow(root), Date.now(), recent)) {
            applyAnimation(node, delayMs);
        }
    };
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes)
                pending.push(node);
        }
        if (pending.length > 0 && flush === 0)
            flush = setTimeout(drain, 40);
    });
    observer.observe(root, { childList: true, subtree: true });
    teardown.set(root, () => {
        observer.disconnect();
        roots.delete(root);
        if (flush !== 0)
            clearTimeout(flush);
    });
}
const roots = new Set();
const teardown = new Map();
let rootFinder = null;
function reduced() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}
const inject = [];
exports.inject = inject;
function apply(ctx) {
    ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID);
        if (existing !== null)
            return () => { };
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = Motion_css_1.default;
        document.head.append(style);
        return () => { style.remove(); };
    }, 'xharness-ui-motion: styles');
    ctx.effect(() => {
        for (const node of document.querySelectorAll('[data-conversation-scroll]')) {
            observeRoot(node);
        }
        // The transcript mounts long after the plugin loads; follow the body
        // until every scroller has been claimed, then stop looking.
        rootFinder = new MutationObserver((records) => {
            // Conversation scrollers are remounted on navigation. Release their
            // observers rather than retaining detached transcript trees forever.
            for (const root of roots) {
                if (!root.isConnected) {
                    teardown.get(root)?.();
                    teardown.delete(root);
                }
            }
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (!(node instanceof Element))
                        continue;
                    if (node.hasAttribute('data-conversation-scroll'))
                        observeRoot(node);
                    for (const found of node.querySelectorAll('[data-conversation-scroll]')) {
                        observeRoot(found);
                    }
                }
            }
        });
        rootFinder.observe(document.body, { childList: true, subtree: true });
        return () => {
            rootFinder?.disconnect();
            rootFinder = null;
            for (const dispose of teardown.values())
                dispose();
            teardown.clear();
            roots.clear();
        };
    }, 'xharness-ui-motion: stream observer');
}

},
"src/modules/motion/Motion.css": function(module, exports, require) {
// source: src/modules/motion/Motion.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "\n@keyframes xh-stream-in{from{opacity:0}to{opacity:1}}\n[data-xh-stream-animate=\"true\"]{animation:xh-stream-in var(--xh-duration-stream-in,900ms) var(--xh-ease-stream,cubic-bezier(.16,1,.3,1)) both;animation-delay:var(--xh-stream-delay,0ms);will-change:opacity}\n@media (prefers-reduced-motion:reduce){[data-xh-stream-animate=\"true\"]{animation:none}}\n";

}
};
const __dependencies = {"src/modules/motion/index.js":{"./Motion.css":"src/modules/motion/Motion.css"},"src/modules/motion/Motion.css":{}};
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
return __load("src/modules/motion/index.js");
}
});
