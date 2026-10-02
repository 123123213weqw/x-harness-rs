// Generated from src/modules/user-questions/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-user-questions",
factory: (__externalRequire) => {
const __units = {
"src/modules/user-questions/index.js": function(module, exports, require) {
// source: src/modules/user-questions/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.PendingQuestion = void 0;
exports.apply = apply;
const QuestionComposer_1 = require("./QuestionComposer");
const locales_1 = require("./locales");
var slots_1 = require("./contract/slots");
Object.defineProperty(exports, "PendingQuestion", { enumerable: true, get: function () { return slots_1.PendingQuestion; } });
/** Dictionary namespace owned by this plugin. */
const NS = 'question';
/** Required services: the slot registry and the question composer's copy. */
exports.inject = ['slots', 'locale'];
/** Chain routing: claim the composer while a question wait is pending (pure — owner props only). */
function selectQuestion({ interactions }) {
    return interactions.find((i) => i.kind === 'question') ?? null;
}
/**
 * Client plugin body: register the `question` dictionaries and the question
 * composer into the composer chain. Zero business face — data and verbs live
 * on the matched carrier; t rides the standard locale seat.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-user-questions: dictionaries');
    ctx.slots.inject('conversation.composer', () => ctx.slots.register({ name: 'conversation.composer', select: selectQuestion, locale: NS }, QuestionComposer_1.QuestionComposer));
}

},
"src/modules/user-questions/QuestionComposer.js": function(module, exports, require) {
// source: src/modules/user-questions/QuestionComposer.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRecommendedLabel = parseRecommendedLabel;
exports.isComposing = isComposing;
exports.QuestionComposer = QuestionComposer;
exports.QuestionFlow = QuestionFlow;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const class_names_1 = require("./class-names");
const primitives_1 = require("./primitives");
const slots_1 = require("./contract/slots");
const PlanReviewPanel_1 = require("./PlanReviewPanel");
const QuestionComposer_styles_1 = __importDefault(require("./QuestionComposer.styles"));
/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
function parseRecommendedLabel(label) {
    const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
    return suffix.test(label)
        ? { label: label.replace(suffix, ''), recommended: true }
        : { label, recommended: false };
}
/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event) {
    // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
    // oxlint-disable-next-line typescript/no-deprecated
    return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}
/**
 * Composer takeover boundary; the carrier key keys local drafts, so a
 * same-request replay (same key, new carrier object) preserves them.
 *
 * One takeover, two shapes: a request that declares a presentation intent this
 * package renders takes that shape (a plan review is one decision over one
 * plan, not a question set), and every other request takes the generic flow.
 * The routing lives here, at the one entry that owns the composer seat, so
 * neither shape can claim a request the other is already rendering.
 *
 * @param props - the selector-matched pending question carrier plus the framework standard kit.
 * @returns The question flow, or the intent's own surface, for this request.
 */
function QuestionComposer(props) {
    // Domain-face mint rides the carrier's stable identity (never minted in a
    // select/render dispatch — per-dispatch minting would churn memo identity).
    const question = (0, react_1.useMemo)(() => new slots_1.PendingQuestion(props.matched), [props.matched]);
    const review = (0, react_1.useMemo)(() => (0, slots_1.planReviewOf)(question.questions), [question]);
    return review === undefined
        ? (0, jsx_runtime_1.jsx)(QuestionFlow, { pending: question, t: props.t }, question.key)
        : (0, jsx_runtime_1.jsx)(PlanReviewPanel_1.PlanReviewPanel, { pending: question, review: review, t: props.t }, question.key);
}
function QuestionFlow({ pending, t }) {
    const questions = pending.questions;
    const [index, setIndex] = (0, react_1.useState)(0);
    const [drafts, setDrafts] = (0, react_1.useState)(() => questions.map(() => ({
        selected: [], custom: '', skipped: false,
    })));
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    // Collapsed to the header strip so the conversation above stays readable
    // while the user decides; the drafts survive because the state lives here.
    const [minimized, setMinimized] = (0, react_1.useState)(pending.deferred);
    const deferredSeen = (0, react_1.useRef)(pending.deferred);
    (0, react_1.useEffect)(() => {
        if (pending.deferred && !deferredSeen.current)
            setMinimized(true);
        deferredSeen.current = pending.deferred;
    }, [pending.deferred]);
    // The free-form textarea autofocuses on first presentation; re-expanding a
    // collapsed question must not steal focus from the expand toggle back into
    // the input, so focus is granted once per question index.
    const focusedQuestions = (0, react_1.useRef)(new Set());
    const question = questions[index];
    const draft = drafts[index];
    // Same-key carrier replay can temporarily provide an empty or shortened
    // question set. Preserve local drafts and hooks, but never read a missing row.
    if (question === undefined || draft === undefined)
        return null;
    const hasOptions = (question.options?.length ?? 0) > 0;
    const cancelFlow = () => {
        setBusy('cancel');
        setError(null);
        void pending.cancel().catch((cause) => {
            setBusy(null);
            setError({ text: cause instanceof Error ? cause.message : String(cause) });
        });
    };
    const updateDraft = (update) => {
        setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item));
        setError(null);
    };
    const choose = (label) => {
        updateDraft((current) => {
            if (question.multiSelect === true) {
                const selected = current.selected.includes(label)
                    ? current.selected.filter(item => item !== label)
                    : [...current.selected, label];
                return { ...current, selected, skipped: false };
            }
            return { selected: [label], custom: '', skipped: false };
        });
        if (question.multiSelect !== true && index < questions.length - 1) {
            setIndex(current => current + 1);
        }
    };
    const answered = (item) => item.selected.length > 0 || item.custom.trim() !== '';
    const completed = (item) => answered(item) || item.skipped;
    const submitDrafts = (values) => {
        const missing = values.findIndex(item => !completed(item));
        if (missing >= 0) {
            setIndex(missing);
            setError({ key: 'error.incomplete' });
            return;
        }
        const answer = {
            answers: questions.map((item, itemIndex) => {
                const value = values[itemIndex];
                if (value === undefined)
                    throw new Error('question draft no longer matches the request');
                if (value.skipped)
                    return { id: item.id, selected: [] };
                const custom = value.custom.trim();
                return {
                    id: item.id,
                    selected: custom === '' || item.multiSelect === true ? value.selected : [],
                    ...(custom === '' ? {} : { custom }),
                };
            }),
        };
        setBusy('answer');
        setError(null);
        void pending.answer(answer).catch((cause) => {
            setBusy(null);
            setError({ text: cause instanceof Error ? cause.message : String(cause) });
        });
    };
    const continueFlow = () => {
        if (!answered(draft)) {
            setError({ key: 'error.unanswered' });
            return;
        }
        if (index < questions.length - 1) {
            setIndex(current => current + 1);
            setError(null);
            return;
        }
        submitDrafts(drafts);
    };
    // Shared by the inline custom input and the optionless textarea: a
    // multi-select draft retains checked labels, while a single-select custom
    // answer replaces its selection. Enter continues the flow (Shift+Enter
    // stays a newline in the textarea; on the single-line input it is inert).
    const draftCustom = (event) => {
        const value = event.target.value;
        updateDraft(current => ({
            ...current,
            selected: question.multiSelect === true ? current.selected : [],
            custom: value,
            skipped: false,
        }));
    };
    const continueFromCustom = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || isComposing(event))
            return;
        event.preventDefault();
        continueFlow();
    };
    const skipQuestion = () => {
        const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
            ? { selected: [], custom: '', skipped: true }
            : item);
        setDrafts(nextDrafts);
        setError(null);
        if (index < questions.length - 1) {
            setIndex(current => current + 1);
            return;
        }
        submitDrafts(nextDrafts);
    };
    return ((0, jsx_runtime_1.jsx)("div", { className: QuestionComposer_styles_1.default.frame, "data-question-key": pending.key, "data-question-deferred": pending.deferred ? 'true' : 'false', "data-question-minimized": minimized ? 'true' : 'false', children: (0, jsx_runtime_1.jsxs)("section", { className: (0, class_names_1.clsx)(QuestionComposer_styles_1.default.card, minimized && QuestionComposer_styles_1.default.cardMinimized), "aria-labelledby": `question-${pending.key}-${String(index)}`, children: [(0, jsx_runtime_1.jsxs)("header", { className: QuestionComposer_styles_1.default.header, children: [(0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.headingBlock, children: [pending.deferred && (0, jsx_runtime_1.jsx)("div", { role: "status", children: minimized ? '待回答 · 不阻塞当前对话' : '等待回答 · 可继续不依赖答案的工作；未回答不代表同意' }), question.header !== undefined && (0, jsx_runtime_1.jsx)("div", { className: QuestionComposer_styles_1.default.eyebrow, children: question.header }), (0, jsx_runtime_1.jsx)("h2", { className: QuestionComposer_styles_1.default.title, id: `question-${pending.key}-${String(index)}`, children: question.question })] }), (0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.headerActions, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: QuestionComposer_styles_1.default.iconButton, "aria-label": pending.deferred && minimized ? '展开待回答问题' : t(minimized ? 'nav.maximize' : 'nav.minimize'), title: t(minimized ? 'nav.maximize' : 'nav.minimize'), "aria-expanded": !minimized, disabled: busy !== null, onClick: () => { setMinimized(current => !current); }, children: minimized ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronUpOutline14, {}) : (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, {}) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: QuestionComposer_styles_1.default.iconButton, "aria-label": t('nav.cancel'), title: t('nav.cancel'), disabled: busy !== null, onClick: cancelFlow, children: (0, jsx_runtime_1.jsx)(primitives_1.IconCloseOutline16, {}) })] })] }), !minimized && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.body, "data-question-scroll": true, children: [question.detail !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: QuestionComposer_styles_1.default.detail, children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: question.detail }) })), (0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.options, role: question.multiSelect === true ? 'group' : 'radiogroup', children: [(question.options ?? []).map((option, optionIndex) => {
                                            const selected = draft.selected.includes(option.label);
                                            const display = parseRecommendedLabel(option.label);
                                            return ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, class_names_1.clsx)(QuestionComposer_styles_1.default.option, selected && question.multiSelect !== true && QuestionComposer_styles_1.default.optionSelected), role: question.multiSelect === true ? 'checkbox' : 'radio', "aria-checked": selected, "aria-label": display.label, disabled: busy !== null, onClick: () => { choose(option.label); }, onKeyDown: (event) => {
                                                    if (event.key !== 'Enter' || !drafts.every(completed))
                                                        return;
                                                    event.preventDefault();
                                                    submitDrafts(drafts);
                                                }, children: [question.multiSelect === true
                                                        ? ((0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.clsx)(QuestionComposer_styles_1.default.checkbox, selected && QuestionComposer_styles_1.default.checkboxChecked), "aria-hidden": "true", children: selected && (0, jsx_runtime_1.jsx)(primitives_1.IconCheckOutline14, { size: 12 }) }))
                                                        : (0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.number, children: optionIndex + 1 }), (0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.optionCopy, children: (0, jsx_runtime_1.jsxs)("span", { className: QuestionComposer_styles_1.default.optionLine, children: [(0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.optionLabel, children: display.label }), display.recommended && ((0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.badge, children: t('option.recommended') })), option.description !== undefined && ((0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.description, children: option.description }))] }) })] }, `${option.label}-${String(optionIndex)}`));
                                        }), hasOptions
                                            ? ((0, jsx_runtime_1.jsxs)("div", { className: (0, class_names_1.clsx)(QuestionComposer_styles_1.default.customRow, draft.custom !== '' && QuestionComposer_styles_1.default.customRowActive), children: [question.multiSelect === true
                                                        ? ((0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.clsx)(QuestionComposer_styles_1.default.checkbox, draft.custom !== '' && QuestionComposer_styles_1.default.checkboxChecked), "aria-hidden": "true", children: draft.custom !== '' && (0, jsx_runtime_1.jsx)(primitives_1.IconCheckOutline14, { size: 12 }) }))
                                                        : ((0, jsx_runtime_1.jsx)("span", { className: QuestionComposer_styles_1.default.number, "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 12 }) })), (0, jsx_runtime_1.jsx)("input", { type: "text", className: QuestionComposer_styles_1.default.customInput, value: draft.custom, disabled: busy !== null, placeholder: t('custom.placeholder'), onChange: draftCustom, onKeyDown: continueFromCustom })] }))
                                            : ((0, jsx_runtime_1.jsx)("textarea", { autoFocus: !focusedQuestions.current.has(index), className: QuestionComposer_styles_1.default.customTextarea, value: draft.custom, disabled: busy !== null, rows: 2, placeholder: t('custom.placeholder'), onFocus: () => { focusedQuestions.current.add(index); }, onChange: draftCustom, onKeyDown: continueFromCustom }))] })] }), (0, jsx_runtime_1.jsxs)("footer", { className: QuestionComposer_styles_1.default.footer, children: [(0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.pager, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: QuestionComposer_styles_1.default.iconButton, "aria-label": t('nav.prev'), disabled: index === 0 || busy !== null, onClick: () => { setIndex(index - 1); setError(null); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChevronLeftOutline14, {}) }), (0, jsx_runtime_1.jsxs)("span", { className: QuestionComposer_styles_1.default.progress, children: [index + 1, " / ", questions.length] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: QuestionComposer_styles_1.default.iconButton, "aria-label": t('nav.next'), disabled: index === questions.length - 1 || busy !== null, onClick: () => { setIndex(index + 1); setError(null); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, {}) })] }), (0, jsx_runtime_1.jsx)("div", { className: QuestionComposer_styles_1.default.feedback, role: "status", children: error === null ? null : 'key' in error ? t(error.key) : error.text }), (0, jsx_runtime_1.jsxs)("div", { className: QuestionComposer_styles_1.default.footerActions, children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", disabled: busy !== null, onClick: skipQuestion, children: t('action.skip') }), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "primary", disabled: busy !== null || !answered(draft), onClick: continueFlow, children: busy === 'answer'
                                                ? t('submitting')
                                                : index === questions.length - 1 ? t('submit') : t('action.next') })] })] })] }))] }) }));
}

},
"src/modules/user-questions/class-names.js": function(module, exports, require) {
// source: src/modules/user-questions/class-names.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clsx = clsx;
/** The consumed clsx surface is boolean/undefined string composition only. */
function clsx(...values) {
    return values.filter(value => typeof value === 'string' && value.length > 0).join(' ');
}

},
"src/modules/user-questions/primitives.js": function(module, exports, require) {
// source: src/modules/user-questions/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconEditOutline16 = exports.IconCloseOutline16 = exports.IconChevronUpOutline14 = exports.IconChevronRightOutline14 = exports.IconChevronLeftOutline14 = exports.IconChevronDownOutline14 = exports.IconCheckOutline14 = exports.MarkdownText = exports.Button = void 0;
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "Button", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Button; } });
Object.defineProperty(exports, "MarkdownText", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.MarkdownText; } });
Object.defineProperty(exports, "IconCheckOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconCheckOutline14; } });
Object.defineProperty(exports, "IconChevronDownOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronDownOutline14; } });
Object.defineProperty(exports, "IconChevronLeftOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronLeftOutline14; } });
Object.defineProperty(exports, "IconChevronRightOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronRightOutline14; } });
Object.defineProperty(exports, "IconChevronUpOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronUpOutline14; } });
Object.defineProperty(exports, "IconCloseOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconCloseOutline16; } });
Object.defineProperty(exports, "IconEditOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconEditOutline16; } });

},
"src/modules/user-questions/contract/slots.js": function(module, exports, require) {
// source: src/modules/user-questions/contract/slots.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingQuestion = void 0;
exports.planReviewOf = planReviewOf;
/**
 * Narrow a request to a renderable plan review, or return undefined to leave it
 * to the generic question flow.
 *
 * The card is one decision over one plan, and it claims a request only when it
 * can send every answer that request allows — an intent changes the layout,
 * never which answers are reachable. So the batch must be a single question
 * that declares the intent, carries the plan as its detail, offers the approve
 * label the intent names, and is a binary single choice: at most one option
 * besides approve, and not multi-select. A third option or a multi-select batch
 * has answers two buttons cannot express, so the generic flow keeps it — as it
 * keeps any request whose intent the asker's own service would have rejected,
 * because the client sits downstream of a wire boundary and every request must
 * stay answerable.
 *
 * @param questions - the request's whole question batch.
 * @returns The narrowed review, or undefined when the generic flow owns it.
 */
function planReviewOf(questions) {
    if (questions.length !== 1)
        return undefined;
    // Length-checked above; the index read is the narrowing tax, not a guess.
    const question = questions[0];
    if (question === undefined)
        return undefined;
    const intent = question.intent;
    if (intent?.kind !== 'plan-review' || question.detail === undefined)
        return undefined;
    if (question.multiSelect === true)
        return undefined;
    const options = question.options ?? [];
    if (options.length > 2)
        return undefined;
    const approve = options.find(option => option.label === intent.approve);
    if (approve === undefined)
        return undefined;
    const decline = options.find(option => option.label !== intent.approve);
    return {
        id: question.id,
        question: question.question,
        plan: question.detail,
        approve,
        ...(decline === undefined ? {} : { decline }),
    };
}
/**
 * Question domain face over the carrier: render identity and questions
 * transparently forwarded; answer/cancel own the wire encoding (the success
 * fields and the cancelled error) and turn a rejected carrier receipt into a
 * thrown error. Components mint one per carrier via useMemo (never inside a
 * select — a per-dispatch mint would churn identity and break memoization).
 */
class PendingQuestion {
    /**
     * @param wait - the runtime carrier for one pending question request.
     */
    constructor(wait) {
        this.wait = wait;
    }
    /** Opaque render identity (React key / draft remount axis), forwarded from the carrier. */
    get key() {
        return this.wait.key;
    }
    get deferred() { return this.wait.payload.deferred === true; }
    /** The request's question list, forwarded from the carrier payload. */
    get questions() {
        return this.wait.payload.questions;
    }
    /**
     * Deliver the whole answer batch; a rejected carrier receipt throws.
     * @param answer - complete structured answer batch.
     */
    async answer(answer) {
        const receipt = await this.wait.respond({
            ok: true, value: { sessionId: this.wait.sessionId, answer },
        });
        if (!receipt.accepted) {
            throw new Error(`question response rejected: ${receipt.reason}`);
        }
    }
    /** Reject the whole wait (the host resolves the tool call as cancelled); a rejected receipt throws. */
    async cancel() {
        const receipt = await this.wait.respond({
            ok: false,
            error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
        });
        if (!receipt.accepted) {
            throw new Error(`question cancellation rejected: ${receipt.reason}`);
        }
    }
}
exports.PendingQuestion = PendingQuestion;
/**
 * Full component props: the framework runtime share (chain currency +
 * session/global standard kit) plus the chain `matched` share — the entry's
 * selector result, already narrowed to the question carrier — plus the
 * standard locale seat; the carrier plus the domain face above carry the
 * whole behavior surface.
 */

},
"src/modules/user-questions/PlanReviewPanel.js": function(module, exports, require) {
// source: src/modules/user-questions/PlanReviewPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlanReviewPanel = PlanReviewPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
// PlanReviewPanel: the composer takeover for a question carrying the
// `plan-review` presentation intent. A plan under review is one decision over
// one body of markdown, so it takes the waiting-approval card shape — tinted
// strip, content, right-aligned action row — instead of the generic question
// flow's pager, numbered options, skip and custom-answer affordances, which
// read as a quiz the user is being graded on.
//
// The three actions are the whole decision surface: approve and decline answer
// the question with the option labels the asker offered (localised copy on the
// buttons, the asker's descriptions as their tooltips), while "discuss"
// dismisses the request so the composer returns and the user can simply say
// what they want. Dismissal is the generic flow's own cancel verb, promoted to
// a labelled button because in a two-outcome decision it is the third real
// answer, not an escape hatch.
const react_1 = require("react");
const primitives_1 = require("./primitives");
const PlanReviewPanel_styles_1 = __importDefault(require("./PlanReviewPanel.styles"));
/**
 * Optional-prop spread for a decision button's tooltip: `title` is optional on
 * the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
 *
 * @param description - the asker's option description, when it carries one.
 * @returns The `title` prop to spread, or nothing.
 */
function tooltip(description) {
    return description === undefined ? {} : { title: description };
}
/**
 * Render a plan review as a decision card.
 *
 * @param props - the question domain face, the narrowed plan review, and `t`.
 * @returns The plan-review takeover for this request.
 */
function PlanReviewPanel({ pending, review, t }) {
    // One-shot latch shaped like the approval takeover's: the panel leaves only
    // when the host's resolved frame lands, so until then a second click must
    // not re-fire. A failed send (rejected receipt / transport) re-arms it and
    // shows why, since nothing else would tell the user the click was lost.
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const settle = (send) => {
        setBusy(true);
        setError(null);
        void send().catch((cause) => {
            setBusy(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    const decide = (label) => {
        settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }));
    };
    const decline = review.decline;
    return ((0, jsx_runtime_1.jsx)("div", { className: PlanReviewPanel_styles_1.default.frame, "data-plan-review-key": pending.key, children: (0, jsx_runtime_1.jsxs)("section", { className: PlanReviewPanel_styles_1.default.card, "aria-label": review.question, children: [(0, jsx_runtime_1.jsxs)("div", { className: PlanReviewPanel_styles_1.default.strip, children: [(0, jsx_runtime_1.jsx)("span", { className: PlanReviewPanel_styles_1.default.dot }), t('plan.header')] }), (0, jsx_runtime_1.jsx)("div", { className: PlanReviewPanel_styles_1.default.body, "data-plan-review-scroll": true, children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: review.plan }) }), (0, jsx_runtime_1.jsxs)("div", { className: PlanReviewPanel_styles_1.default.footer, children: [(0, jsx_runtime_1.jsx)("div", { className: PlanReviewPanel_styles_1.default.feedback, role: "status", children: error }), (0, jsx_runtime_1.jsxs)("div", { className: PlanReviewPanel_styles_1.default.actions, children: [(0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "ghost", className: PlanReviewPanel_styles_1.default.discuss, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 14 }), disabled: busy, onClick: () => { settle(() => pending.cancel()); }, children: t('plan.discuss') }), decline !== undefined && ((0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "outline", ...tooltip(decline.description), disabled: busy, onClick: () => { decide(decline.label); }, children: t('plan.decline') })), (0, jsx_runtime_1.jsx)(primitives_1.Button, { variant: "primary", ...tooltip(review.approve.description), disabled: busy, onClick: () => { decide(review.approve.label); }, children: t('plan.approve') })] })] })] }) }));
}

},
"src/modules/user-questions/PlanReviewPanel.styles.js": function(module, exports, require) {
// source: src/modules/user-questions/PlanReviewPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PlanReviewPanel_css_1 = __importDefault(require("./PlanReviewPanel.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-user-questions/PlanReviewPanel.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-user-questions';
        tag.dataset.pluginCss = id;
        tag.textContent = PlanReviewPanel_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "actions": "BA8zDq_actions",
    "body": "BA8zDq_body",
    "card": "BA8zDq_card",
    "discuss": "BA8zDq_discuss",
    "dot": "BA8zDq_dot",
    "feedback": "BA8zDq_feedback",
    "footer": "BA8zDq_footer",
    "frame": "BA8zDq_frame",
    "strip": "BA8zDq_strip"
};

},
"src/modules/user-questions/PlanReviewPanel.css": function(module, exports, require) {
// source: src/modules/user-questions/PlanReviewPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".BA8zDq_frame{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;justify-content:center;display:flex}.BA8zDq_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;display:flex;overflow:hidden}.BA8zDq_card,.BA8zDq_card *{box-sizing:border-box}.BA8zDq_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);flex-shrink:0;align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}.BA8zDq_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}.BA8zDq_body{overscroll-behavior:contain;flex:auto;min-height:0;padding:12px 16px 4px;font-size:14px;line-height:22px;overflow-y:auto}.BA8zDq_footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;padding:8px 16px 12px;display:flex}.BA8zDq_feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.BA8zDq_actions{flex-shrink:0;align-items:center;gap:8px;display:flex}.BA8zDq_discuss{color:var(--dsw-alias-label-secondary);gap:6px}.BA8zDq_discuss:hover:not(:disabled){color:var(--dsw-alias-label-primary)}@media (width<=720px){.BA8zDq_card{border-radius:16px}.BA8zDq_body{padding:10px 12px 4px}.BA8zDq_footer{align-items:flex-end;padding:8px 12px 10px}}";

},
"src/modules/user-questions/QuestionComposer.styles.js": function(module, exports, require) {
// source: src/modules/user-questions/QuestionComposer.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const QuestionComposer_css_1 = __importDefault(require("./QuestionComposer.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-user-questions/QuestionComposer.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-user-questions';
        tag.dataset.pluginCss = id;
        tag.textContent = QuestionComposer_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "badge": "r3cF6q_badge",
    "body": "r3cF6q_body",
    "card": "r3cF6q_card",
    "cardMinimized": "r3cF6q_cardMinimized",
    "checkbox": "r3cF6q_checkbox",
    "checkboxChecked": "r3cF6q_checkboxChecked",
    "customInput": "r3cF6q_customInput",
    "customRow": "r3cF6q_customRow",
    "customRowActive": "r3cF6q_customRowActive",
    "customTextarea": "r3cF6q_customTextarea",
    "description": "r3cF6q_description",
    "detail": "r3cF6q_detail",
    "eyebrow": "r3cF6q_eyebrow",
    "feedback": "r3cF6q_feedback",
    "footer": "r3cF6q_footer",
    "footerActions": "r3cF6q_footerActions",
    "frame": "r3cF6q_frame",
    "header": "r3cF6q_header",
    "headerActions": "r3cF6q_headerActions",
    "headingBlock": "r3cF6q_headingBlock",
    "iconButton": "r3cF6q_iconButton",
    "number": "r3cF6q_number",
    "option": "r3cF6q_option",
    "optionCopy": "r3cF6q_optionCopy",
    "optionLabel": "r3cF6q_optionLabel",
    "optionLine": "r3cF6q_optionLine",
    "optionSelected": "r3cF6q_optionSelected",
    "options": "r3cF6q_options",
    "pager": "r3cF6q_pager",
    "progress": "r3cF6q_progress",
    "title": "r3cF6q_title"
};

},
"src/modules/user-questions/QuestionComposer.css": function(module, exports, require) {
// source: src/modules/user-questions/QuestionComposer.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".r3cF6q_frame{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;justify-content:center;display:flex}.r3cF6q_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;padding:0 0 10px;display:flex;overflow:hidden}.r3cF6q_card,.r3cF6q_card *{box-sizing:border-box}.r3cF6q_cardMinimized{max-height:none}.r3cF6q_cardMinimized .r3cF6q_header{padding-bottom:14px}.r3cF6q_headerActions{flex-shrink:0;align-items:center;gap:4px;display:flex}.r3cF6q_header{flex-shrink:0;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px;display:flex}.r3cF6q_headingBlock{min-width:0}.r3cF6q_eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:11px;line-height:16px}.r3cF6q_title{margin:0;font-size:16px;font-weight:500;line-height:22px}.r3cF6q_detail{margin:0 2px 8px}.r3cF6q_footerActions{flex-shrink:0;align-items:center;gap:12px;display:flex}.r3cF6q_pager{flex-shrink:0;align-items:center;gap:6px;display:flex}.r3cF6q_progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}.r3cF6q_iconButton{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid}.r3cF6q_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.r3cF6q_iconButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.r3cF6q_body{overscroll-behavior:contain;flex-direction:column;flex:auto;min-height:0;display:flex;overflow-y:auto}.r3cF6q_options{flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px;display:flex}.r3cF6q_option{width:100%;min-height:40px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:12px;flex-shrink:0;align-items:flex-start;gap:8px;padding:8px 12px 8px 8px;transition:background-color .12s,border-color .12s;display:flex}.r3cF6q_option:hover:not(:disabled),.r3cF6q_optionSelected{background:var(--dsw-alias-interactive-bg-hover)}.r3cF6q_optionSelected{border-color:var(--dsw-alias-border-l2)}.r3cF6q_option:disabled{cursor:default}.r3cF6q_number{background:var(--dsw-alias-bg-overlay);width:20px;height:20px;color:var(--dsw-alias-label-secondary);border-radius:6px;flex:0 0 20px;place-items:center;margin-top:2px;font-size:12px;font-weight:500;line-height:18px;display:grid}.r3cF6q_checkbox{flex:0 0 20px;place-items:center;width:20px;height:20px;margin-top:2px;display:grid}.r3cF6q_checkbox:before{content:\"\";border:1px solid var(--dsw-alias-border-l4);border-radius:4px;grid-area:1/1;width:14px;height:14px;transition:background-color .12s,border-color .12s}.r3cF6q_checkbox>svg{grid-area:1/1}.r3cF6q_checkboxChecked{color:var(--dsw-alias-label-primary-foreground)}.r3cF6q_checkboxChecked:before{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary)}.r3cF6q_optionCopy{flex:1;min-width:0}.r3cF6q_optionLine{flex-wrap:wrap;align-items:baseline;gap:2px 6px;display:flex}.r3cF6q_optionLabel{font-size:14px;font-weight:500;line-height:24px}.r3cF6q_badge{background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-button-info-fill);border-radius:6px;padding:0 4px;font-size:11px;font-weight:600;line-height:18px}.r3cF6q_description{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:24px}.r3cF6q_customRow{border:1px solid #0000;border-radius:12px;flex-shrink:0;align-items:flex-start;gap:8px;width:100%;min-height:40px;padding:8px 12px 8px 8px;transition:background-color .12s,border-color .12s;display:flex}.r3cF6q_customRow:hover,.r3cF6q_customRow:focus-within,.r3cF6q_customRowActive{background:var(--dsw-alias-interactive-bg-hover)}.r3cF6q_customRow:focus-within,.r3cF6q_customRowActive{border-color:var(--dsw-alias-border-l2)}.r3cF6q_customInput{min-width:0;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font:inherit;background:0 0;border:none;outline:none;flex:1;padding:0;font-size:14px;line-height:24px}.r3cF6q_customInput::placeholder{color:var(--dsw-alias-label-caption)}.r3cF6q_customTextarea{resize:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);min-height:64px;max-height:140px;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font:inherit;border-radius:10px;outline:none;flex-shrink:0;margin:0 12px;padding:8px 12px;font-size:14px;line-height:24px;display:block}.r3cF6q_customTextarea:focus{border-color:var(--dsw-alias-state-business-primary)}.r3cF6q_customTextarea::placeholder{color:var(--dsw-alias-label-caption)}.r3cF6q_footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 10px 0 18px;display:flex}.r3cF6q_feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);text-align:right;flex:1;font-size:11px;line-height:16px}@media (width<=720px){.r3cF6q_card{border-radius:16px}.r3cF6q_header{padding:10px 12px 0 18px}.r3cF6q_options{padding:4px 8px}.r3cF6q_title{font-size:15px;line-height:21px}.r3cF6q_option,.r3cF6q_customRow{padding:8px 6px}.r3cF6q_footer{align-items:flex-end;padding:0 10px}.r3cF6q_footerActions{flex-shrink:0}}@media (prefers-reduced-motion:reduce){.r3cF6q_option,.r3cF6q_customRow{transition:none}}\n [data-composer-seat]:has([data-question-deferred=\"true\"]) [data-chain-overlay-fallback=\"conversation.composer\"]{display:contents!important}\n [data-composer-seat]:has([data-question-deferred=\"true\"]) [data-slot=\"conversation.composer\"]{display:flex;flex-direction:column}\n [data-composer-seat]:has([data-question-deferred=\"true\"]) [data-chain-overlay-fallback=\"conversation.composer\"]>*{order:2}\n [data-question-deferred=\"true\"]{order:1;flex-shrink:0}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_card{padding:0;box-shadow:none;border-radius:12px}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_header{padding:8px 12px;align-items:center;gap:8px}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_headingBlock{display:flex;align-items:center;gap:10px;min-width:0}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] [role=\"status\"]{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_eyebrow{display:none}\n [data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_title{font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}\n @media(max-width:520px){[data-question-deferred=\"true\"][data-question-minimized=\"true\"] .r3cF6q_title{display:none}}\n ";

},
"src/modules/user-questions/locales.js": function(module, exports, require) {
// source: src/modules/user-questions/locales.ts

"use strict";
/** `question` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'error.incomplete': '请先完成这道问题。',
    'error.unanswered': '请选择一个选项或填写自定义答案。',
    'nav.prev': '上一题',
    'nav.next': '下一题',
    'nav.minimize': '收起问题卡片',
    'nav.maximize': '展开问题卡片',
    'nav.cancel': '放弃整组问题',
    'option.recommended': '推荐',
    'custom.placeholder': '输入你的答案',
    'action.skip': '跳过本题',
    'action.next': '下一题',
    'plan.header': '计划待审',
    'plan.approve': '确认执行',
    'plan.decline': '拒绝',
    'plan.discuss': '去聊天里说',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'error.incomplete': 'Please complete this question first.',
    'error.unanswered': 'Please select an option or enter a custom answer.',
    'nav.prev': 'Previous question',
    'nav.next': 'Next question',
    'nav.minimize': 'Collapse the question card',
    'nav.maximize': 'Expand the question card',
    'nav.cancel': 'Dismiss all questions',
    'option.recommended': 'Recommended',
    'custom.placeholder': 'Type your answer',
    'action.skip': 'Skip this question',
    'action.next': 'Next',
    'plan.header': 'Plan review',
    'plan.approve': 'Approve',
    'plan.decline': 'Refuse',
    'plan.discuss': 'Chat about it',
};

}
};
const __dependencies = {"src/modules/user-questions/index.js":{"./QuestionComposer":"src/modules/user-questions/QuestionComposer.js","./locales":"src/modules/user-questions/locales.js","./contract/slots":"src/modules/user-questions/contract/slots.js"},"src/modules/user-questions/QuestionComposer.js":{"./class-names":"src/modules/user-questions/class-names.js","./primitives":"src/modules/user-questions/primitives.js","./contract/slots":"src/modules/user-questions/contract/slots.js","./PlanReviewPanel":"src/modules/user-questions/PlanReviewPanel.js","./QuestionComposer.styles":"src/modules/user-questions/QuestionComposer.styles.js"},"src/modules/user-questions/class-names.js":{},"src/modules/user-questions/primitives.js":{},"src/modules/user-questions/contract/slots.js":{},"src/modules/user-questions/PlanReviewPanel.js":{"./primitives":"src/modules/user-questions/primitives.js","./PlanReviewPanel.styles":"src/modules/user-questions/PlanReviewPanel.styles.js"},"src/modules/user-questions/PlanReviewPanel.styles.js":{"./PlanReviewPanel.css":"src/modules/user-questions/PlanReviewPanel.css"},"src/modules/user-questions/PlanReviewPanel.css":{},"src/modules/user-questions/QuestionComposer.styles.js":{"./QuestionComposer.css":"src/modules/user-questions/QuestionComposer.css"},"src/modules/user-questions/QuestionComposer.css":{},"src/modules/user-questions/locales.js":{}};
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
return __load("src/modules/user-questions/index.js");
}
});
