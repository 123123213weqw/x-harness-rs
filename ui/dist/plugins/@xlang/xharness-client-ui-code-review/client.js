// Generated from src/modules/code-review/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-code-review",
factory: (__externalRequire) => {
const __units = {
"src/modules/code-review/index.js": function(module, exports, require) {
// source: src/modules/code-review/index.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportIsStale = exports.diffLines = exports.decodeReviewReport = exports.inject = void 0;
exports.CodeReview = CodeReview;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/// <reference path="../shared/assets.d.ts" />
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const CodeReview_css_1 = __importDefault(require("./CodeReview.css"));
const EvidencePanel_1 = require("./EvidencePanel");
const contracts_1 = require("../assistant/contracts");
const assistant_reference_1 = require("./assistant-reference");
const ReviewPanel_1 = require("./ReviewPanel");
const structured_1 = require("./structured");
const diff_rows_1 = require("./diff-rows");
const client_1 = require("./client");
const cache_1 = require("./cache");
const storage_1 = require("./storage");
const preferences_1 = require("./preferences");
const RepositoryPicker_1 = require("./RepositoryPicker");
const idle_1 = require("./idle");
const data_1 = require("./data");
const zh = navigator.language.startsWith('zh');
function text(en, cn) { return zh ? cn : en; }
function message(error) { return error instanceof client_1.GitHubError ? `${error.message} (${error.kind})` : error instanceof Error ? error.message : text('GitHub request failed', 'GitHub 请求失败'); }
function ReviewNavigation({ wide }) {
    const [active, setActive] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => { const opened = () => setActive(true), closed = () => setActive(false); window.addEventListener('xharness:review:open', opened); window.addEventListener('xharness:review:closed', closed); return () => { window.removeEventListener('xharness:review:open', opened); window.removeEventListener('xharness:review:closed', closed); }; }, []);
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: "Code Review", side: "right", children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhreview-nav", "data-xharness-review-nav": true, "aria-label": "Code Review", "aria-current": active ? 'page' : undefined, onClick: () => window.dispatchEvent(new Event('xharness:review:open')), children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 22 }), wide && (0, jsx_runtime_1.jsx)("span", { children: "Code Review" })] }) });
}
function Avatar({ author }) { return (0, jsx_runtime_1.jsx)("span", { className: "xhreview-avatar", "aria-hidden": "true", children: author.slice(0, 1).toUpperCase() }); }
function StatusIcon({ state }) { return (0, jsx_runtime_1.jsx)("span", { className: `xhreview-state ${state}`, "aria-label": state, children: state === 'failed' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 14 }) : state === 'passed' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 14 }) : '·' }); }
/** Keep closed notes/diffs out of the DOM, not merely hidden inside details. */
function ReadonlyNote({ label, body }) { const [open, setOpen] = (0, react_1.useState)(false); return (0, jsx_runtime_1.jsxs)("details", { open: open, onToggle: event => setOpen(event.currentTarget.open), children: [(0, jsx_runtime_1.jsx)("summary", { children: label }), open && (0, jsx_runtime_1.jsx)("div", { className: "xhreview-comment", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: body }) })] }); }
function FileDiff({ file, initiallyOpen, focus, reference }) {
    const [open, setOpen] = (0, react_1.useState)(initiallyOpen), node = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => { if (focus?.path === file.path)
        setOpen(true); }, [focus, file.path]);
    (0, react_1.useEffect)(() => { if (!open || focus?.path !== file.path)
        return; const frame = requestAnimationFrame(() => { const line = node.current?.querySelector(`[data-side="${focus.side}"][data-line="${focus.line}"]`); if (line instanceof HTMLElement) {
        line.scrollIntoView({ block: 'center' });
        line.focus();
    } }); return () => cancelAnimationFrame(frame); }, [open, focus, file.path]);
    const lines = (0, diff_rows_1.diffRows)(file.patch);
    return (0, jsx_runtime_1.jsxs)("details", { ref: node, open: open, onToggle: event => setOpen(event.currentTarget.open), children: [(0, jsx_runtime_1.jsxs)("summary", { children: [file.path, " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-add", children: ["+", file.additions] }), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-remove", children: ["\u2212", file.deletions] })] }), open && (file.patch !== null ? (0, jsx_runtime_1.jsx)("pre", { children: lines.length ? lines.map((line, index) => (0, jsx_runtime_1.jsxs)("span", { className: `xhreview-diff-line ${line.kind === 'added' ? 'xhreview-added' : line.kind === 'removed' ? 'xhreview-removed' : ''}`, children: [(0, jsx_runtime_1.jsx)("span", { className: "xhreview-line-number", "data-side": "left", "data-line": line.left ?? undefined, tabIndex: -1, children: line.left ?? ' ' }), (0, jsx_runtime_1.jsx)("span", { className: "xhreview-line-number", "data-side": "right", "data-line": line.right ?? undefined, tabIndex: -1, children: line.right ?? ' ' }), line.text, reference && (line.left !== null || line.right !== null) && (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhreview-code-reference", "aria-label": `${text('Reference line', '引用行')} ${line.right ?? line.left}`, onClick: () => { const n = line.right ?? line.left; if (n !== null)
                                reference({ path: file.path, side: line.right !== null ? 'right' : 'left', line: n }); }, children: "\u2197" }), '\n'] }, index)) : file.patch }) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('Diff unavailable (binary or large file). Open GitHub.', 'Diff 未提供（二进制或大文件），请在 GitHub 查看。') }))] });
}
function Metadata({ record, more, busy, client, account, jump, revision }) {
    return (0, jsx_runtime_1.jsxs)("aside", { className: "xhreview-metadata", "aria-label": text('Pull request status', 'PR 状态'), children: [(0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Merge status', '合并状态') }), (0, jsx_runtime_1.jsx)("p", { children: record.mergeable === null ? text('GitHub is calculating mergeability', 'GitHub 正在计算合并状态') : record.mergeable ? text('No merge conflicts', '无合并冲突') : text('Merge conflicts', '存在合并冲突') }), (0, jsx_runtime_1.jsx)("small", { className: "xhreview-muted", children: record.mergeableState })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsxs)("h3", { children: [text('Comments', '评论'), " \u00B7 ", record.commentCount] }), record.comments.length ? record.comments.map(item => (0, jsx_runtime_1.jsx)(ReadonlyNote, { label: item.author, body: item.body }, item.id)) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No conversation comments', '暂无对话评论') }), record.commentsHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => more('comments'), children: text('Load more', '加载更多') })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Reviews', '审核') }), record.reviews.length ? record.reviews.map(item => (0, jsx_runtime_1.jsx)(ReadonlyNote, { label: `${item.author} · ${item.state}`, body: item.body }, item.id)) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No submitted reviews', '暂无审核记录') }), record.reviewsHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => more('reviews'), children: text('Load more', '加载更多') })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Checks', '检查') }), (0, jsx_runtime_1.jsx)("small", { className: "xhreview-sha", title: record.headSha, children: record.headSha.slice(0, 8) }), record.checks.map(item => { const url = (0, data_1.checkSourceUrl)(item.url); return (0, jsx_runtime_1.jsxs)("details", { className: "xhreview-check", children: [(0, jsx_runtime_1.jsxs)("summary", { children: [(0, jsx_runtime_1.jsx)(StatusIcon, { state: (0, data_1.checkState)(item) }), (0, jsx_runtime_1.jsx)("span", { children: item.name })] }), (0, jsx_runtime_1.jsx)("p", { children: item.conclusion ?? item.status }), item.description && (0, jsx_runtime_1.jsx)("p", { children: item.description }), url && (0, jsx_runtime_1.jsxs)("a", { href: url, target: "_blank", rel: "noopener noreferrer", children: [text('Open check', '查看检查'), " \u2197"] })] }, item.id); }), !record.checks.length && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No reported checks', '暂无检查结果') }), record.checksTruncated && (0, jsx_runtime_1.jsx)("p", { role: "status", children: text('Check list incomplete. Open GitHub for all checks.', '检查列表不完整，请在 GitHub 查看全部检查。') })] }), (0, jsx_runtime_1.jsx)(EvidencePanel_1.EvidencePanel, { client: client, account: account, record: record, zh: zh, jump: jump }, `${account}:${(0, data_1.recordKey)(record)}:${record.headSha}:${revision}`)] });
}
/** GitHub reads plus explicit handoff to the global assistant; no PR chat binding. */
function CodeReview({ close, client, cache, preferences }) {
    const [identity, setIdentity] = (0, react_1.useState)(null), [repos, setRepos] = (0, react_1.useState)([]), [repository, setRepository] = (0, react_1.useState)(''), [repoMore, setRepoMore] = (0, react_1.useState)(false), [repoPage, setRepoPage] = (0, react_1.useState)(1);
    const [query, setQuery] = (0, react_1.useState)(''), [mine, setMine] = (0, react_1.useState)(false), [pulls, setPulls] = (0, react_1.useState)([]), [pullMore, setPullMore] = (0, react_1.useState)(false), [pullPage, setPullPage] = (0, react_1.useState)(1);
    const [selected, setSelected] = (0, react_1.useState)(null), [record, setRecord] = (0, react_1.useState)(null), [tab, setTab] = (0, react_1.useState)('summary');
    const [epoch, setEpoch] = (0, react_1.useState)(0), [authEpoch, setAuthEpoch] = (0, react_1.useState)(0), [loading, setLoading] = (0, react_1.useState)(''), [listBusy, setListBusy] = (0, react_1.useState)(false), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(''), [listError, setListError] = (0, react_1.useState)(''), [repoError, setRepoError] = (0, react_1.useState)(''), [detailError, setDetailError] = (0, react_1.useState)(''), [stale, setStale] = (0, react_1.useState)(false);
    const [focus, setFocus] = (0, react_1.useState)(null);
    const [recent, setRecent] = (0, react_1.useState)([]);
    const [pages, setPages] = (0, react_1.useState)({ files: 1, comments: 1, reviews: 1 });
    const listRefreshEpoch = (0, react_1.useRef)(0), detailRefreshEpoch = (0, react_1.useRef)(0);
    const [authLane] = (0, react_1.useState)(() => new data_1.RequestLane()), [listLane] = (0, react_1.useState)(() => new data_1.RequestLane()), [detailLane] = (0, react_1.useState)(() => new data_1.RequestLane()), [moreLane] = (0, react_1.useState)(() => new data_1.RequestLane());
    (0, react_1.useEffect)(() => {
        const request = authLane.start();
        setLoading(text('Connecting to GitHub…', '连接 GitHub…'));
        setError('');
        setRepoError('');
        setIdentity(null);
        setRepository('');
        setRepos([]);
        setRecent([]);
        setMine(false);
        setPulls([]);
        setSelected(null);
        setRecord(null);
        listLane.cancel();
        detailLane.cancel();
        moreLane.cancel();
        setBusy(false);
        async function connect() {
            try {
                const user = await client.auth(request.signal);
                if (!request.current())
                    return;
                await cache.activate(user.account);
                if (!request.current())
                    return;
                const choice = await preferences.activate(user.account);
                if (!request.current())
                    return;
                setMine(choice.mine);
                setRecent(choice.recent);
                const cached = cache.bootstrap(user.account);
                const show = (data) => { setIdentity(user); setRepos(choice.repository && !data.items.includes(choice.repository) ? [choice.repository, ...data.items] : data.items); setRepoPage(1); setRepoMore(data.hasMore); setRepository(old => old || choice.repository || data.items[0] || ''); };
                if (cached) {
                    show(cached.repos);
                    setLoading('');
                }
                if (!cached || !cache.bootstrapFresh(user.account)) {
                    try {
                        const data = await client.repos(user.account, 1, request.signal);
                        if (request.current()) {
                            cache.putBootstrap(user, data);
                            show(data);
                            setRepoError('');
                        }
                    }
                    catch (e) {
                        if (!cached)
                            throw e;
                        if (request.current())
                            setRepoError(message(e));
                    }
                }
            }
            catch (e) {
                if (request.current()) {
                    setError(message(e));
                    if (e instanceof client_1.GitHubError && ['authentication', 'permission', 'account_changed'].includes(e.kind))
                        cache.clear();
                }
            }
            finally {
                if (request.current())
                    setLoading('');
            }
        }
        void connect();
        return () => authLane.cancel();
    }, [client, cache, preferences, authEpoch, authLane, listLane, detailLane, moreLane]);
    (0, react_1.useEffect)(() => {
        if (!identity || !repository)
            return;
        const account = identity.account, request = listLane.start();
        moreLane.cancel();
        setBusy(false);
        setListError('');
        const force = epoch !== listRefreshEpoch.current;
        listRefreshEpoch.current = epoch;
        const cached = cache.list(account, repository);
        if (cached) {
            setPulls(cached.items);
            setPullPage(1);
            setPullMore(cached.hasMore);
            cache.scheduleDetails(account, cached.items);
        }
        if (!force && cache.listFresh(account, repository)) {
            setListBusy(false);
            return () => listLane.cancel();
        }
        setListBusy(true);
        async function read() { try {
            const page = await client.pulls(account, repository, 1, request.signal);
            if (request.current()) {
                cache.putList(account, repository, page);
                cache.scheduleDetails(account, page.items);
                setPulls(page.items);
                setPullPage(1);
                setPullMore(page.hasMore);
            }
        }
        catch (e) {
            if (request.current()) {
                setListError(message(e));
                if (e instanceof client_1.GitHubError && ['authentication', 'permission', 'account_changed'].includes(e.kind)) {
                    cache.clear();
                    setPulls([]);
                    setRecord(null);
                }
            }
        }
        finally {
            if (request.current())
                setListBusy(false);
        } }
        void read();
        return () => listLane.cancel();
    }, [client, cache, identity, repository, epoch, listLane, moreLane]);
    const selectedHead = selected ? pulls.find(item => (0, data_1.recordKey)(item) === `${selected.repository.toLowerCase()}#${selected.id}`)?.headSha : undefined;
    (0, react_1.useEffect)(() => {
        if (!identity || !selected)
            return;
        const account = identity.account, link = selected, request = detailLane.start();
        setDetailError('');
        moreLane.cancel();
        setBusy(false);
        const force = epoch !== detailRefreshEpoch.current;
        detailRefreshEpoch.current = epoch;
        const cached = cache.detail(account, link, selectedHead);
        setRecord(old => cached ?? (old && old.repository.toLowerCase() === link.repository.toLowerCase() && old.id === link.id && (selectedHead === undefined || selectedHead === old.headSha) ? old : null));
        setPages({ files: 1, comments: 1, reviews: 1 });
        if (cached && !force && cache.detailFresh(account, link, selectedHead)) {
            setLoading('');
            setStale(false);
            return () => detailLane.cancel();
        }
        setLoading(text('Loading pull request…', '加载 PR…'));
        setStale(true);
        async function read() { try {
            const data = await client.detail(account, link.repository, link.id, request.signal);
            if (request.current()) {
                cache.putDetail(account, data);
                setPulls(items => items.map(item => item.id === data.id && item.repository.toLowerCase() === data.repository.toLowerCase() ? { ...item, headSha: data.headSha } : item));
                setRecord(data);
                setStale(false);
                setPages({ files: 1, comments: 1, reviews: 1 });
            }
        }
        catch (e) {
            if (request.current()) {
                setDetailError(message(e));
                if (e instanceof client_1.GitHubError && ['authentication', 'permission', 'account_changed', 'not_found'].includes(e.kind)) {
                    cache.clear();
                    setRecord(null);
                }
            }
        }
        finally {
            if (request.current())
                setLoading('');
        } }
        void read();
        return () => detailLane.cancel();
    }, [client, cache, identity, selected, selectedHead, epoch, detailLane, moreLane]);
    function choose(item) { if (identity)
        cache.viewed(identity.account, item); detailLane.cancel(); moreLane.cancel(); cache.cancelPrefetch(); const listed = pulls.find(pull => (0, data_1.recordKey)(pull) === `${item.repository.toLowerCase()}#${item.id}`); setRecord(identity ? cache.detail(identity.account, item, listed?.headSha) ?? null : null); setStale(true); setDetailError(''); setBusy(false); setSelected(item); setTab('summary'); }
    function changeRepository(value) { if (identity)
        setRecent(preferences.select(identity.account, value, mine).recent); if (value === repository)
        return; cache.cancelPrefetch(); listLane.cancel(); detailLane.cancel(); moreLane.cancel(); setPulls([]); setSelected(null); setRecord(null); setLoading(''); setDetailError(''); setBusy(false); setRepository(value); }
    function changeAuthor(value) { setMine(value); if (identity)
        setRecent(preferences.select(identity.account, repository, value).recent); }
    function openLink() { if (!identity)
        return; const link = (0, data_1.parsePullLink)(query); if (!link)
        return; changeRepository(link.repository); setRepos(items => items.includes(link.repository) ? items : [link.repository, ...items]); choose(link); }
    async function more(kind) {
        if (!identity || busy)
            return;
        const request = moreLane.start();
        setBusy(true);
        setError('');
        try {
            if (kind === 'repos') {
                const page = await client.repos(identity.account, repoPage + 1, request.signal);
                if (request.current()) {
                    setRepos(items => [...new Set([...items, ...page.items])]);
                    setRepoPage(index => index + 1);
                    setRepoMore(page.hasMore);
                }
            }
            else if (kind === 'pulls') {
                const page = await client.pulls(identity.account, repository, pullPage + 1, request.signal);
                if (request.current()) {
                    setPulls(items => { const keys = new Set(items.map(data_1.recordKey)); return [...items, ...page.items.filter(item => !keys.has((0, data_1.recordKey)(item)))]; });
                    setPullPage(index => index + 1);
                    setPullMore(page.hasMore);
                }
            }
            else if (record) {
                const index = pages[kind] + 1;
                if (index > 60)
                    throw new client_1.GitHubError('limit', text('Pagination limit reached; open GitHub for more', '分页上限已到，请在 GitHub 查看更多'));
                if (kind === 'files') {
                    const page = await client.files(identity.account, record, index, request.signal);
                    if (request.current())
                        setRecord(old => old ? { ...old, files: [...old.files, ...page.items.filter(item => !old.files.some(file => file.path === item.path))], filesHasMore: page.hasMore } : old);
                }
                if (kind === 'comments') {
                    const page = await client.comments(identity.account, record, index, request.signal);
                    if (request.current())
                        setRecord(old => old ? { ...old, comments: [...old.comments, ...page.items.filter(item => !old.comments.some(comment => comment.id === item.id))], commentsHasMore: page.hasMore } : old);
                }
                if (kind === 'reviews') {
                    const page = await client.reviews(identity.account, record, index, request.signal);
                    if (request.current())
                        setRecord(old => old ? { ...old, reviews: [...old.reviews, ...page.items.filter(item => !old.reviews.some(review => review.id === item.id))], reviewsHasMore: page.hasMore } : old);
                }
                if (request.current())
                    setPages(old => ({ ...old, [kind]: index }));
            }
        }
        catch (e) {
            if (request.current()) {
                setError(message(e));
                if (e instanceof client_1.GitHubError && ['head_changed', 'account_changed'].includes(e.kind))
                    setStale(true);
            }
        }
        finally {
            if (request.current())
                setBusy(false);
        }
    }
    (0, react_1.useEffect)(() => () => { authLane.cancel(); listLane.cancel(); detailLane.cancel(); moreLane.cancel(); cache.cancelPrefetch(); }, [cache, authLane, listLane, detailLane, moreLane]);
    const filtered = (0, data_1.filterPulls)(pulls, query, mine ? identity?.account ?? '' : null);
    const selectedSummary = selected ? pulls.find(item => (0, data_1.recordKey)(item) === `${selected.repository.toLowerCase()}#${selected.id}`) : undefined;
    function jump(location) { const file = record?.files.find(f => f.path === location.path); if (!file || !(0, structured_1.diffLines)(file.patch).some(line => line.side === location.side && line.line === location.line)) {
        setDetailError(text('Location is outside the loaded diff. Load more files or open GitHub.', '位置不在已加载 Diff 内，请加载更多文件或在 GitHub 查看。'));
        return;
    } setFocus(location); setTab('changes'); }
    function switchTab(event) { const tabs = ['summary', 'changes', 'review']; const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0; const next = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'review' : offset ? tabs[(tabs.indexOf(tab) + offset + 3) % 3] : undefined; if (next !== undefined) {
        event.preventDefault();
        setTab(next);
        document.getElementById(`xhreview-tab-${next}`)?.focus();
    } }
    return (0, jsx_runtime_1.jsxs)("main", { className: "xhreview", "data-selected": selected !== null, "aria-label": "Code Review workspace", children: [(0, jsx_runtime_1.jsxs)("nav", { className: "xhreview-list", "aria-label": text('Pull requests', 'PR 列表'), children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("h1", { children: "Code Review" }), (0, jsx_runtime_1.jsx)("button", { className: "xhreview-close", type: "button", "aria-label": text('Back to chat', '返回对话'), onClick: close, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 18 }) })] }), (0, jsx_runtime_1.jsxs)("label", { className: "xhreview-search", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSearchOutline16, { size: 18 }), (0, jsx_runtime_1.jsx)("input", { type: "search", "aria-label": text('Search or paste a PR link', '搜索或粘贴 PR 链接'), placeholder: text('Search or paste a PR link', '搜索或粘贴 PR 链接'), value: query, onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Enter')
                                    openLink(); } })] }), (0, data_1.parsePullLink)(query) && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-action", disabled: !identity, onClick: openLink, children: text('Open PR', '打开 PR') }), identity && (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-filters", children: [(0, jsx_runtime_1.jsx)(RepositoryPicker_1.RepositoryPicker, { repository: repository, repositories: repos, recent: recent, hasMore: repoMore, busy: busy, change: changeRepository, more: () => void more('repos'), zh: zh }), (0, jsx_runtime_1.jsx)(RepositoryPicker_1.AuthorFilter, { mine: mine, change: changeAuthor, zh: zh })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-rows", children: [!identity && (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-connect", children: [(0, jsx_runtime_1.jsx)("p", { children: loading || text("Uses GitHub CLI login on the Host computer.", "使用 Host 所在电脑的 GitHub CLI 登录。") }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: error })] }), repoError && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: repoError }), listBusy && (0, jsx_runtime_1.jsx)("p", { role: "status", className: "xhreview-muted", children: pulls.length ? text('Refreshing…', '刷新中…') : text('Loading…', '加载中…') }), listError && (0, jsx_runtime_1.jsxs)("p", { role: "alert", className: "xhreview-error", children: [listError, " ", text('List may be stale.', '列表可能过期。')] }), filtered.map(item => (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhreview-row", "aria-current": selected?.repository === item.repository && selected.id === item.id ? 'true' : undefined, onMouseEnter: () => identity && cache.prefetch(client, identity.account, item), onFocus: () => identity && cache.prefetch(client, identity.account, item), onMouseLeave: () => cache.cancelPrefetch(), onBlur: () => cache.cancelPrefetch(), onClick: () => choose({ repository: item.repository, id: item.id }), children: [(0, jsx_runtime_1.jsx)("span", { className: "xhreview-row-title", children: item.title }), (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-row-meta", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: item.author }), (0, jsx_runtime_1.jsxs)("span", { children: ["#", item.id, " \u00B7 ", (0, data_1.age)(item.updatedAt)] })] })] }, (0, data_1.recordKey)(item))), identity && !listBusy && filtered.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-empty-list", role: "status", children: text('No matching pull requests', '没有匹配的 PR') }), pullMore && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-action", disabled: busy || listBusy, onClick: () => void more('pulls'), children: text('Load more', '加载更多') })] }), (0, jsx_runtime_1.jsxs)("footer", { className: "xhreview-account", children: [(0, jsx_runtime_1.jsx)("span", { children: identity?.account ?? 'GitHub' }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: !!loading, onClick: () => identity ? setEpoch(value => value + 1) : setAuthEpoch(value => value + 1), children: text('Refresh', '刷新') }), identity && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { cache.clear(); setAuthEpoch(value => value + 1); }, children: text('Reconnect', '重新连接') })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-detail", children: [(error || detailError) && (0, jsx_runtime_1.jsx)("div", { role: "alert", className: "xhreview-error", children: error || detailError }), loading && (0, jsx_runtime_1.jsx)("div", { role: "status", className: "xhreview-loading", children: loading }), record ? (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhreview-toolbar", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhreview-list-back", onClick: () => { detailLane.cancel(); moreLane.cancel(); setSelected(null); setRecord(null); setLoading(''); }, children: text('Pull requests', 'PR 列表') }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-tabs", role: "tablist", "aria-label": text('Pull request content', 'PR 内容'), children: [(0, jsx_runtime_1.jsx)("button", { type: "button", id: "xhreview-tab-summary", role: "tab", "aria-selected": tab === 'summary', "aria-controls": "xhreview-panel", tabIndex: tab === 'summary' ? 0 : -1, onKeyDown: switchTab, onClick: () => setTab('summary'), children: text('Summary', '概述') }), (0, jsx_runtime_1.jsxs)("button", { type: "button", id: "xhreview-tab-changes", role: "tab", "aria-selected": tab === 'changes', "aria-controls": "xhreview-panel", tabIndex: tab === 'changes' ? 0 : -1, onKeyDown: switchTab, onClick: () => setTab('changes'), children: [text('Changes', '变更'), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-add", children: ["+", record.additions] }), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-remove", children: ["\u2212", record.deletions] })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", id: "xhreview-tab-review", role: "tab", "aria-selected": tab === 'review', "aria-controls": "xhreview-panel", tabIndex: tab === 'review' ? 0 : -1, onKeyDown: switchTab, onClick: () => setTab('review'), children: text('Review', '审核') })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhreview-handoff", disabled: stale, onClick: () => { try {
                                            (0, contracts_1.openAssistant)((0, assistant_reference_1.pullReference)(record));
                                        }
                                        catch (e) {
                                            setError(message(e));
                                        } }, children: text('Ask Little X', '交给小 X') }), (0, jsx_runtime_1.jsx)("a", { className: "xhreview-github", href: `https://github.com/${record.repository}/pull/${record.id}`, target: "_blank", rel: "noopener noreferrer", children: "GitHub \u2197" })] }), stale && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-error", role: "status", children: loading ? text('Refreshing cached data…', '正在刷新缓存数据…') : text('Cached data. Refresh required.', '缓存数据，需要刷新。') }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-content", children: [(0, jsx_runtime_1.jsxs)("section", { id: "xhreview-panel", className: "xhreview-body", role: "tabpanel", "aria-labelledby": `xhreview-tab-${tab}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhreview-identity", children: [(0, jsx_runtime_1.jsxs)("span", { className: "xhreview-open", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 16 }), " ", record.draft ? text('Draft', '草稿') : record.state] }), (0, jsx_runtime_1.jsxs)("span", { children: [record.repository, " #", record.id] })] }), (0, jsx_runtime_1.jsx)("h2", { children: record.title }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-author", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: record.author }), (0, jsx_runtime_1.jsx)("strong", { children: record.author }), (0, jsx_runtime_1.jsx)("span", { children: (0, data_1.age)(record.updatedAt) }), (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-branch", title: record.branch, children: ["\u00B7 ", record.branch, " \u2192 ", record.baseBranch] })] }), tab === 'summary' ? (0, jsx_runtime_1.jsx)("article", { className: "xhreview-description", children: record.body ? (0, jsx_runtime_1.jsx)("div", { className: "xhreview-description-body", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: record.body }) }) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No description', '暂无说明') }) }) : tab === 'review' ? (0, jsx_runtime_1.jsx)(ReviewPanel_1.ReviewPanel, { account: identity?.account ?? '', client: client, record: record, zh: zh, disabled: stale, jump: jump, reference: (location) => { try {
                                                    (0, contracts_1.openAssistant)((0, assistant_reference_1.pullReference)(record, location));
                                                }
                                                catch (e) {
                                                    setError(message(e));
                                                } } }, `${identity?.account}:${(0, data_1.recordKey)(record)}`) : (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-files", children: [(0, jsx_runtime_1.jsxs)("p", { className: "xhreview-muted", children: [record.files.length, " / ", record.changedFiles, " ", text('files', '个文件')] }), record.files.map((file, index) => (0, jsx_runtime_1.jsx)(FileDiff, { file: file, initiallyOpen: index === 0, focus: focus, reference: !stale ? (location) => { try {
                                                            (0, contracts_1.openAssistant)((0, assistant_reference_1.pullReference)(record, location));
                                                        }
                                                        catch (e) {
                                                            setError(message(e));
                                                        } } : undefined }, file.path)), record.filesHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy || stale, onClick: () => void more('files'), children: text('Load more files', '加载更多文件') }), !record.filesHasMore && record.files.length < record.changedFiles && (0, jsx_runtime_1.jsx)("p", { role: "status", children: text('GitHub file limit reached. Open GitHub for the remaining files.', 'GitHub 文件上限已到，请在 GitHub 查看其余文件。') })] })] }, `${(0, data_1.recordKey)(record)}:${tab}`), (0, jsx_runtime_1.jsx)(Metadata, { revision: epoch, record: record, more: kind => void more(kind), busy: busy || stale, account: identity?.account ?? '', client: client, jump: jump })] })] }) : selectedSummary ? (0, jsx_runtime_1.jsxs)("section", { className: "xhreview-pending", "aria-busy": !!loading, children: [(0, jsx_runtime_1.jsx)("div", { className: "xhreview-identity", children: (0, jsx_runtime_1.jsxs)("span", { children: [selectedSummary.repository, " #", selectedSummary.id] }) }), (0, jsx_runtime_1.jsx)("h2", { children: selectedSummary.title }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-author", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: selectedSummary.author }), (0, jsx_runtime_1.jsx)("strong", { children: selectedSummary.author }), (0, jsx_runtime_1.jsx)("span", { children: selectedSummary.branch })] }), (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: loading ? text('Loading description and changes…', '正在加载说明和变更…') : text('Details unavailable. Retry refresh.', '详情暂不可用，请刷新重试。') })] }) : (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-empty", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 32 }), (0, jsx_runtime_1.jsx)("h2", { children: identity ? text('Select a pull request', '选择一个 PR') : text('Connect GitHub', '连接 GitHub') }), (0, jsx_runtime_1.jsx)("p", { children: identity ? text('Choose one from the sidebar to review its changes', '从左侧选择 PR 查看变更') : text('Uses GitHub CLI login on the Host computer.', '使用 Host 所在电脑的 GitHub CLI 登录。') }), !identity && !loading && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { cache.clear(); setAuthEpoch(value => value + 1); }, children: text('Retry connection', '重试连接') }), selected && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-list-back", onClick: () => { setSelected(null); setLoading(''); }, children: text('Pull requests', 'PR 列表') })] })] })] });
}
exports.inject = ['slots', 'connection'];
function apply(ctx) {
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.xharnessCodeReview = ''; style.textContent = CodeReview_css_1.default; document.head.append(style); return () => style.remove(); }, 'code-review: scoped styles');
    const rpc = ctx.get('connection').rpc, cache = new cache_1.ReviewCache(Date.now, typeof indexedDB === 'undefined' ? undefined : new storage_1.BrowserReviewStorage(indexedDB));
    const preferences = new preferences_1.ReviewPreferences(typeof indexedDB === 'undefined' ? undefined : new storage_1.BrowserReviewStorage(indexedDB, 'preferences'));
    const client = new client_1.GitHubClient(rpc, () => cache.foreground()), backgroundClient = new client_1.GitHubClient(rpc);
    ctx.effect(() => { cache.startIdle(backgroundClient, new idle_1.BrowserIdleEnvironment()); return () => cache.dispose(); }, 'code-review: cooperative idle preloading');
    ctx.slots.inject('review.center', () => ctx.slots.register({ name: 'review.center', id: 'code-review', inject: () => ({ client, cache, preferences }) }, CodeReview));
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'code-review-navigation', order: 0 }, ReviewNavigation));
}
var structured_2 = require("./structured");
Object.defineProperty(exports, "decodeReviewReport", { enumerable: true, get: function () { return structured_2.decodeReviewReport; } });
Object.defineProperty(exports, "diffLines", { enumerable: true, get: function () { return structured_2.diffLines; } });
Object.defineProperty(exports, "reportIsStale", { enumerable: true, get: function () { return structured_2.reportIsStale; } });

},
"src/modules/code-review/CodeReview.css": function(module, exports, require) {
// source: src/modules/code-review/CodeReview.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhreview{display:flex;flex:1;min-width:0;min-height:0;height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px}.xhreview *{box-sizing:border-box}.xhreview button,.xhreview input,.xhreview select{font:inherit;color:inherit}.xhreview button,.xhreview summary{cursor:pointer}.xhreview button:focus-visible,.xhreview select:focus-visible,.xhreview summary:focus-visible,.xhreview-nav:focus-visible{outline:2px solid currentColor;outline-offset:2px}\n.xhreview-list{flex:0 0 280px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);padding:18px 10px 12px}.xhreview-list header{display:flex;align-items:center;justify-content:space-between;padding:0 9px;margin-bottom:20px;gap:10px}.xhreview-list h1{font-size:21px;font-weight:650;letter-spacing:-.3px;margin:0}.xhreview-close{border:0;background:none;display:grid;place-items:center;padding:6px;color:var(--dsw-alias-label-tertiary)!important;border-radius:6px}.xhreview-close:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-search{display:flex;align-items:center;gap:10px;min-width:0;border-radius:24px;padding:13px 14px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}.xhreview-search input{padding:0;border:0;outline:0;min-width:0;width:100%;background:none;font-size:15px}.xhreview-search:focus-within{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}.xhreview-search input::placeholder{color:var(--dsw-alias-label-tertiary)}.xhreview-list select{align-self:flex-start;max-width:100%;margin:17px 5px 12px;padding:0 4px;background:transparent;border:0;font-size:15px;color:var(--dsw-alias-label-secondary)}.xhreview-rows{flex:1;overflow:auto;min-height:0}.xhreview-row{display:block;position:relative;width:100%;text-align:left;background:none;border:0;border-radius:12px;padding:8px 10px 10px}.xhreview-row:hover,.xhreview-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:16px;line-height:1.4}.xhreview-row-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:7px}.xhreview-row-meta img,.xhreview-author img{border-radius:50%;flex-shrink:0}.xhreview-row-meta .xhreview-state{margin-left:auto}.xhreview-preview{color:var(--dsw-alias-label-tertiary);font-size:11px}.xhreview-list>.xhreview-preview{padding:12px 10px 0}\n.xhreview-detail{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;container-type:inline-size;container-name:review-detail}.xhreview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 16px}.xhreview-tabs{display:flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);padding:3px;border-radius:24px;gap:3px;max-width:100%}.xhreview-tabs button{border:0;background:transparent;border-radius:20px;padding:7px 11px;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:14px}.xhreview-tabs button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhreview-add{color:#268d49}.xhreview-remove{color:#ce4e52}.xhreview-content{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:32px;overflow:auto;flex:1;min-height:0;padding:8px 26px 48px}.xhreview-body{min-width:0}.xhreview-identity{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 12px}.xhreview-open{display:inline-flex;align-items:center;gap:6px;background:#24a95813;color:#1c9747;border-radius:20px;padding:7px 14px}.xhreview-body>h2{margin:0 0 16px;font-size:27px;line-height:1.26;letter-spacing:-.6px;font-weight:650;overflow-wrap:anywhere}.xhreview-author{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:13px;white-space:nowrap}.xhreview-author strong{font-weight:550;color:var(--dsw-alias-label-primary)}.xhreview-branch{overflow:hidden;text-overflow:ellipsis;min-width:0}.xhreview-description{font-size:17px;line-height:1.75}.xhreview-description h3{font-size:21px;margin:26px 0 10px;font-weight:600}.xhreview-description p{margin:0 0 20px;overflow-wrap:anywhere}.xhreview-metadata{padding-top:2px;min-width:0}.xhreview-metadata section{padding:0 0 18px;margin-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhreview-metadata section:last-child{border-bottom:0}.xhreview-metadata h3{font-size:14px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin:0 0 15px}.xhreview-metadata p{margin:0;font-size:14px}.xhreview-muted{color:var(--dsw-alias-label-tertiary)}.xhreview-check{margin:0 0 12px}.xhreview-check summary{display:flex;gap:13px;align-items:center;list-style:none;font-size:15px}.xhreview-check summary::-webkit-details-marker{display:none}.xhreview-state{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;flex-shrink:0}.xhreview-state.passed{color:white;background:#0aa443}.xhreview-state.failed{color:#d64b52;border:1px solid currentColor}.xhreview pre{font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;margin:12px 0 0;max-width:100%;overflow:auto;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:12px}.xhreview-check pre{white-space:pre-wrap;overflow-wrap:anywhere}.xhreview-files{margin-top:28px}.xhreview-files details{margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}.xhreview-files summary{padding:12px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.xhreview-files pre{margin:0;border-radius:0}.xhreview-files pre>.xhreview-diff-line{display:block;min-width:max-content}.xhreview-added{background:#24974718}.xhreview-removed{background:#ce4e5218}.xhreview-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--dsw-alias-label-tertiary);gap:10px}.xhreview-empty h2{font-size:18px;margin:14px 0 0;color:var(--dsw-alias-label-primary);font-weight:550}.xhreview-empty p{margin:0;font-size:15px}.xhreview-empty-list{padding:10px;font-size:13px;color:var(--dsw-alias-label-tertiary)}.xhreview-list-back{display:none}.xhreview-nav{display:flex;align-items:center;justify-content:center;gap:8px;min-height:32px;width:100%;border:0;background:none;border-radius:8px;padding:5px 8px;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px}.xhreview-nav:hover,.xhreview-nav[aria-current=page]{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-nav svg{flex-shrink:0}\n@container review-detail (max-width:740px){.xhreview-content{grid-template-columns:minmax(0,1fr);gap:24px}.xhreview-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xhreview-body>h2{font-size:25px}.xhreview-description{font-size:16px}.xhreview-metadata section{margin:0}}\n@media(max-width:920px){.xhreview-list{flex-basis:240px}.xhreview-list h1{font-size:19px}.xhreview-row-title{font-size:15px}.xhreview-content{padding:8px 20px 32px}}\n@media(max-width:650px){.xhreview-list{flex:1}.xhreview[data-selected=true] .xhreview-list{display:none}.xhreview[data-selected=false] .xhreview-detail{display:none}.xhreview-list-back{display:block;border:0;background:none;padding:6px;color:var(--dsw-alias-label-secondary)}.xhreview-toolbar{flex-wrap:wrap;gap:8px;padding:12px}.xhreview-toolbar>.xhreview-preview{display:none}.xhreview-tabs button{font-size:13px;padding:7px 9px}.xhreview-author{flex-wrap:wrap;white-space:normal}.xhreview-branch{flex-basis:100%}.xhreview-content{padding:8px 16px 32px}.xhreview-metadata{grid-template-columns:minmax(0,1fr)}}\n.xhreview-account{display:flex;align-items:center;gap:8px;padding:12px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;flex-wrap:wrap}.xhreview-account span{flex:1}.xhreview-account button,.xhreview-action{border:0;background:none;border-radius:6px;padding:6px;font-size:12px}.xhreview-action{margin:0 4px 6px}.xhreview-account button:hover,.xhreview-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-avatar{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);flex-shrink:0}.xhreview-error{padding:12px;overflow-wrap:anywhere;font-size:13px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}.xhreview-loading{padding:10px 26px;color:var(--dsw-alias-label-tertiary);font-size:13px}.xhreview-comment,.xhreview-description-body{white-space:pre-wrap;overflow-wrap:anywhere}.xhreview-description-body{margin-top:26px!important}.xhreview-github{font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none}.xhreview-sha{display:block;color:var(--dsw-alias-label-tertiary);margin-bottom:14px;font-family:monospace}.xhreview-state.pending,.xhreview-state.neutral{color:var(--dsw-alias-label-tertiary);border:1px solid currentColor}.xhreview-metadata details:not(.xhreview-check){font-size:13px;margin-bottom:12px}.xhreview-metadata button,.xhreview-files>button,.xhreview-empty button{border:1px solid var(--dsw-alias-border-l1);background:none;border-radius:8px;padding:8px 12px}.xhreview button:disabled{cursor:default;opacity:.5}\n.xhreview-connect{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary);padding:8px}.xhreview-connect .xhreview-error{padding:0;border:0}\n.xhreview-comment,.xhreview-description-body{white-space:normal}\n.xhreview-pending{padding:32px;max-width:820px}.xhreview-pending h2{font-size:28px;line-height:1.35;margin:16px 0}.xhreview-pending .xhreview-muted{margin-top:32px}\n\n/* Compact monochrome filters; popover belongs to the list, not PR content. */\n.xhreview-filters{display:flex;flex-direction:column;gap:10px;padding:12px 4px 14px;flex-shrink:0;position:relative;z-index:2}\n.xhreview-repository{position:relative;min-width:0}\n.xhreview-repository-trigger{width:100%;height:36px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:none;text-align:left;font-size:14px;font-weight:550;color:var(--dsw-alias-label-secondary)}\n.xhreview-repository-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.xhreview-repository-trigger svg{flex-shrink:0}\n.xhreview-repository-trigger:hover,.xhreview-repository-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}\n.xhreview-repository-popover{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:10;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-sidebar-fill);box-shadow:0 10px 28px #00000018;padding:6px;overflow:hidden}\n.xhreview-repository-search{display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}\n.xhreview-repository-search input{width:100%;min-width:0;border:0;outline:none;background:none;font-size:13px}.xhreview-repository-search:focus-within{box-shadow:inset 0 -2px var(--dsw-alias-label-secondary)}\n.xhreview-repository-options{max-height:min(320px,45vh);overflow:auto;overscroll-behavior:contain;padding-top:4px;scrollbar-width:thin}\n.xhreview-repository-group{padding:8px 8px 5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}\n.xhreview-repository-option{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:none;border-radius:7px;padding:8px;text-align:left;min-height:48px}\n.xhreview-repository-option[data-highlighted=true],.xhreview-repository-option:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.xhreview-repository-option>span{display:flex;flex-direction:column;gap:3px;min-width:0}.xhreview-repository-option strong{font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhreview-repository-option small{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhreview-repository-option svg{flex-shrink:0}\n.xhreview-repository-none{font-size:12px;padding:8px;color:var(--dsw-alias-label-tertiary)}.xhreview-repository-more{border:0;border-top:1px solid var(--dsw-alias-border-l1);width:100%;background:none;padding:10px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}\n.xhreview-author-filter{display:flex;gap:3px;border-radius:9px;padding:3px;background:var(--dsw-alias-interactive-bg-hover);height:36px;box-sizing:border-box}\n.xhreview-author-filter button{flex:1;min-width:0;border:0;border-radius:6px;background:none;font-size:12px;color:var(--dsw-alias-label-tertiary);padding:0 8px;white-space:nowrap}\n.xhreview-author-filter button[aria-checked=true]{background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px #0000000d}\n.xhreview-repository input:focus-visible,.xhreview-author-filter button:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:1px}\n.xhreview-model{display:flex;flex-direction:column;gap:16px;padding-top:20px;min-width:0}.xhreview-model header{display:flex;align-items:center;gap:12px}.xhreview-model select{max-width:100%;padding:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit}.xhreview-composer{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px;position:sticky;bottom:0;background:var(--dsw-alias-bg-base)}.xhreview-composer textarea{resize:vertical;min-height:65px;background:transparent;color:inherit;border:0;padding:8px;font:inherit}.xhreview-composer>div{display:flex;gap:10px;flex-wrap:wrap}.xhreview-finding{border-top:1px solid var(--dsw-alias-border-l1);padding:18px 0}.xhreview-finding h3 span{display:inline-block;padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px}.xhreview-finding p{white-space:pre-wrap;overflow-wrap:anywhere}.xhreview-finding pre,.xhreview-model-result pre,.xhreview-log{max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.xhreview-thread,.xhreview-workflow{margin:10px 0;overflow-wrap:anywhere}.xhreview-workflow ol{padding-left:18px;font-size:12px}.xhreview-line-number{display:inline-block;min-width:62px;user-select:none;opacity:.5}.xhreview-diff-line{display:block}.xhreview-diff-line:focus{outline:2px solid currentColor;outline-offset:-2px}\n\n.xhreview-model button{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;background:transparent;color:inherit}.xhreview-model button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}\n\n\n.xhreview-code-reference{float:right;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}.xhreview-handoff{font:inherit;white-space:nowrap;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 10px;cursor:pointer}.xhreview-handoff:disabled{opacity:.5;cursor:default}\n";

},
"src/modules/code-review/EvidencePanel.js": function(module, exports, require) {
// source: src/modules/code-review/EvidencePanel.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidencePanel = EvidencePanel;
const react_1 = require("react");
const jsx_runtime_1 = require("react/jsx-runtime");
const react_2 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const data_1 = require("./data");
const err = (e) => e instanceof Error ? e.message : 'GitHub request failed';
function Thread({ thread, client, account, record, zh, jump }) {
    const [open, setOpen] = (0, react_2.useState)(false), [comments, setComments] = (0, react_2.useState)(thread.comments), [busy, setBusy] = (0, react_2.useState)(false), [error, setError] = (0, react_2.useState)(''), [lane] = (0, react_2.useState)(() => new data_1.RequestLane());
    (0, react_2.useEffect)(() => () => lane.cancel(), [lane]);
    async function more() { const req = lane.start(); setBusy(true); setError(''); try {
        const page = await client.threadComments(account, record, thread.id, comments.cursor, req.signal);
        if (req.current())
            setComments(old => ({ ...page, items: [...old.items, ...page.items.filter(n => !old.items.some(o => o.id === n.id))] }));
    }
    catch (e) {
        if (req.current())
            setError(err(e));
    }
    finally {
        if (req.current())
            setBusy(false);
    } }
    return (0, jsx_runtime_1.jsxs)("details", { open: open, onToggle: event => setOpen(event.currentTarget.open), className: "xhreview-thread", children: [(0, jsx_runtime_1.jsxs)("summary", { children: [thread.path, ":", thread.line ?? '—', " \u00B7 ", thread.outdated ? (zh ? '已过期' : 'Outdated') : thread.resolved ? (zh ? '已解决' : 'Resolved') : (zh ? '未解决' : 'Unresolved')] }), open && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [!thread.outdated && thread.line !== null && (0, jsx_runtime_1.jsx)("button", { onClick: () => jump({ path: thread.path, side: thread.side, line: thread.line ?? 1 }), children: zh ? '定位代码' : 'Show code' }), comments.items.map(c => (0, jsx_runtime_1.jsxs)("article", { className: "xhreview-comment", children: [(0, jsx_runtime_1.jsx)("strong", { children: c.author }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: c.body })] }, c.id)), comments.hasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void more(), children: zh ? '更多回复' : 'More replies' }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: error })] })] });
}
function Jobs({ run, client, account, record, zh }) {
    const [jobs, setJobs] = (0, react_2.useState)([]), [more, setMore] = (0, react_2.useState)(false), [page, setPage] = (0, react_2.useState)(0), [busy, setBusy] = (0, react_2.useState)(false), [error, setError] = (0, react_2.useState)(''), [logs, setLogs] = (0, react_2.useState)([]), [openJobs, setOpenJobs] = (0, react_2.useState)(() => new Set()), [lane] = (0, react_2.useState)(() => new data_1.RequestLane());
    (0, react_2.useEffect)(() => () => lane.cancel(), [lane]);
    async function read(job) {
        const req = lane.start();
        setBusy(true);
        setError('');
        try {
            if (job !== undefined) {
                const result = await client.logs(account, record, run, job, req.signal);
                if (req.current())
                    setLogs(old => [...old.filter(item => item.job !== job), { job, value: result }].slice(-3));
            }
            else {
                const result = await client.jobs(account, record, run, page + 1, req.signal);
                if (req.current()) {
                    setJobs(old => [...old, ...result.items.filter(n => !old.some(o => o.id === n.id))]);
                    setPage(old => old + 1);
                    setMore(result.hasMore);
                }
            }
        }
        catch (e) {
            if (req.current())
                setError(err(e));
        }
        finally {
            if (req.current())
                setBusy(false);
        }
    }
    return (0, jsx_runtime_1.jsxs)("details", { onToggle: e => { if (e.currentTarget.open && page === 0 && !busy)
            void read(); }, className: "xhreview-workflow", children: [(0, jsx_runtime_1.jsxs)("summary", { children: [run.name, " \u00B7 ", run.conclusion ?? run.status, " \u00B7 #", run.attempt, run.mergeTest ? ` · ${zh ? '合并测试提交' : 'merge-test commit'}` : ''] }), jobs.map(job => { const log = logs.find(item => item.job === job.id)?.value; return (0, jsx_runtime_1.jsxs)("details", { onToggle: event => { const open = event.currentTarget.open; setOpenJobs(old => { const next = new Set(old); if (open)
                    next.add(job.id);
                else
                    next.delete(job.id); return next; }); }, children: [(0, jsx_runtime_1.jsxs)("summary", { children: [job.name, " \u00B7 ", job.conclusion ?? job.status] }), openJobs.has(job.id) && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("ol", { children: job.steps.map(step => (0, jsx_runtime_1.jsxs)("li", { children: [step.name, " \u00B7 ", step.conclusion ?? step.status] }, step.number)) }), (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void read(job.id), children: zh ? '加载日志' : 'Load logs' }), log && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("pre", { className: "xhreview-log", children: log.text }), log.truncated && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '日志超过显示上限，内容不完整。' : 'Log exceeds the display bound; content is incomplete.' })] })] })] }, job.id); }), busy && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '加载中…' : 'Loading…' }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: error }), more && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void read(), children: zh ? '更多任务' : 'More jobs' }), page > 0 && !jobs.length && (0, jsx_runtime_1.jsx)("p", { children: zh ? '暂无任务' : 'No jobs' })] });
}
function EvidencePanel(props) {
    const { client, account, record, zh } = props;
    const [threads, setThreads] = (0, react_2.useState)(null), [runs, setRuns] = (0, react_2.useState)([]), [runMore, setRunMore] = (0, react_2.useState)(false), [runPage, setRunPage] = (0, react_2.useState)(0), [busy, setBusy] = (0, react_2.useState)(''), [error, setError] = (0, react_2.useState)(''), [lane] = (0, react_2.useState)(() => new data_1.RequestLane());
    (0, react_2.useEffect)(() => () => lane.cancel(), [lane]);
    async function read(kind) {
        const req = lane.start();
        setBusy(kind);
        setError('');
        try {
            if (kind === 'threads') {
                const result = await client.threads(account, record, threads?.cursor ?? null, req.signal);
                if (req.current())
                    setThreads(old => ({ ...result, items: [...(old?.items ?? []), ...result.items.filter(n => !old?.items.some(o => o.id === n.id))] }));
            }
            else {
                const result = await client.runs(account, record, runPage + 1, req.signal);
                if (req.current()) {
                    setRuns(old => [...old, ...result.items.filter(n => !old.some(o => o.id === n.id))]);
                    setRunMore(result.hasMore);
                    setRunPage(old => old + 1);
                }
            }
        }
        catch (e) {
            if (req.current())
                setError(err(e));
        }
        finally {
            if (req.current())
                setBusy('');
        }
    }
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: zh ? '行内讨论' : 'Inline discussions' }), threads?.items.map(thread => (0, react_1.createElement)(Thread, { ...props, thread: thread, key: thread.id })), threads && !threads.items.length && (0, jsx_runtime_1.jsx)("p", { children: zh ? '暂无行内讨论' : 'No inline discussions' }), (!threads || threads.hasMore) && (0, jsx_runtime_1.jsx)("button", { disabled: !!busy, onClick: () => void read('threads'), children: threads ? (zh ? '更多讨论' : 'More discussions') : (zh ? '加载讨论' : 'Load discussions') })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: "Actions" }), runs.map(run => (0, jsx_runtime_1.jsx)(Jobs, { ...props, run: run }, run.id)), runPage > 0 && !runs.length && (0, jsx_runtime_1.jsx)("p", { children: zh ? '当前提交暂无运行记录' : 'No runs for this commit' }), (runPage === 0 || runMore) && (0, jsx_runtime_1.jsx)("button", { disabled: !!busy, onClick: () => void read('runs'), children: runPage ? (zh ? '更多运行' : 'More runs') : (zh ? '加载任务与步骤' : 'Load jobs and steps') })] }), busy && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '加载中…' : 'Loading…' }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: error })] });
}

},
"src/modules/code-review/data.js": function(module, exports, require) {
// source: src/modules/code-review/data.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestLane = void 0;
exports.recordKey = recordKey;
exports.parsePullLink = parsePullLink;
exports.filterPulls = filterPulls;
exports.checkState = checkState;
exports.age = age;
exports.checkSourceUrl = checkSourceUrl;
function recordKey(record) { return `${record.repository.toLowerCase()}#${record.id}`; }
function parsePullLink(query) {
    const match = /^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/(\d+)\/?$/i.exec(query.trim());
    if (!match || !match[1] || !match[2])
        return null;
    const id = Number(match[2]);
    return Number.isSafeInteger(id) && id > 0 ? { repository: match[1], id } : null;
}
function filterPulls(list, query, author) { const text = query.trim().toLowerCase(), link = parsePullLink(query); return list.filter(item => (author === null || item.author === author) && (link ? item.repository.toLowerCase() === link.repository.toLowerCase() && item.id === link.id : `${item.title} ${item.repository} #${item.id}`.toLowerCase().includes(text))); }
function checkState(check) { if (check.status !== 'completed')
    return 'pending'; if (check.conclusion === 'success')
    return 'passed'; if (['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(check.conclusion ?? ''))
    return 'failed'; return 'neutral'; }
function age(updatedAt) { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 60000)); return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
/** Each async lane owns a cancellable generation; late old responses cannot
 * replace a newer repository/PR selection, even if transport ignores abort. */
class RequestLane {
    constructor() {
        this.generation = 0;
        this.controller = new AbortController();
    }
    start() { this.controller.abort(); this.controller = new AbortController(); const generation = ++this.generation; return { signal: this.controller.signal, current: () => generation === this.generation && !this.controller.signal.aborted }; }
    cancel() { this.generation++; this.controller.abort(); }
}
exports.RequestLane = RequestLane;
/** Vendor check URLs are navigation only, never credentialed log fetches. */
function checkSourceUrl(value) {
    if (typeof value !== 'string')
        return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    }
    catch {
        return null;
    }
}

},
"src/modules/assistant/contracts.js": function(module, exports, require) {
// source: src/modules/assistant/contracts.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSISTANT_OPEN = void 0;
exports.assistantReference = assistantReference;
exports.openAssistant = openAssistant;
exports.ASSISTANT_OPEN = 'xharness:assistant:open';
function assistantReference(value) {
    if (typeof value !== 'object' || value === null || !('key' in value) || !('text' in value))
        return null;
    const { key, text } = value;
    if (typeof key !== 'string' || !key || key.length > 8000 || /[\x00-\x1f]/.test(key)
        || typeof text !== 'string' || !text.trim() || text.length > 8000 || text.includes('\0'))
        return null;
    return { key, text };
}
function openAssistant(reference) {
    if (reference && !assistantReference(reference))
        throw new Error('Reference is invalid or exceeds the context limit');
    window.dispatchEvent(new CustomEvent(exports.ASSISTANT_OPEN, { detail: reference ?? null }));
}

},
"src/modules/code-review/assistant-reference.js": function(module, exports, require) {
// source: src/modules/code-review/assistant-reference.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pullReference = pullReference;
const diff_rows_1 = require("./diff-rows");
/** Explicit, commit-pinned reference. Never copy PR descriptions or full diffs. */
function pullReference(record, location) {
    const lines = [`PR: https://github.com/${record.repository}/pull/${record.id}`, `Commit: ${record.headSha}`, `Title (quoted reference material): ${JSON.stringify(record.title.slice(0, 1000))}`];
    if (location) {
        const file = record.files.find(file => file.path === location.path);
        const line = file ? (0, diff_rows_1.diffRows)(file.patch).find(row => (location.side === 'left' ? row.left : row.right) === location.line) : undefined;
        if (!line)
            throw new Error('Referenced line is outside the loaded diff');
        lines.push(`File (quoted): ${JSON.stringify(location.path)}`, `Side: ${location.side}`, `Line: ${location.line}`, `Quoted code (reference material): ${JSON.stringify(line.text.slice(0, 1200))}${line.text.length > 1200 ? ' (truncated; read the pinned commit for the full line)' : ''}`);
    }
    return { key: JSON.stringify([record.repository.toLowerCase(), record.id, record.headSha, location?.path, location?.side, location?.line]), text: lines.join('\n') };
}

},
"src/modules/code-review/diff-rows.js": function(module, exports, require) {
// source: src/modules/code-review/diff-rows.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffRows = diffRows;
const structured_1 = require("./structured");
/** Rendering uses the same validated coordinates as evidence validation. */
function diffRows(patch) {
    const lines = (0, structured_1.diffLines)(patch);
    if (!lines.length || patch === null)
        return [];
    const rows = [];
    let index = 0, inHunk = false;
    for (const row of patch.replaceAll('\r\n', '\n').split('\n')) {
        if (row.startsWith('@@ ')) {
            inHunk = true;
            continue;
        }
        if (!inHunk)
            continue;
        const line = lines[index];
        if (!line)
            continue;
        if (row[0] === ' ') {
            const right = lines[index + 1];
            if (!right)
                return [];
            rows.push({ left: line.line, right: right.line, text: line.text, kind: 'context' });
            index += 2;
        }
        else if (row[0] === '-') {
            rows.push({ left: line.line, right: null, text: line.text, kind: 'removed' });
            index++;
        }
        else if (row[0] === '+') {
            rows.push({ left: null, right: line.line, text: line.text, kind: 'added' });
            index++;
        }
    }
    return rows;
}

},
"src/modules/code-review/structured.js": function(module, exports, require) {
// source: src/modules/code-review/structured.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffLines = diffLines;
exports.decodeReviewReport = decodeReviewReport;
exports.reportIsStale = reportIsStale;
const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const lineNumber = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const safePath = (value) => bounded(value, 2048) && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f]/.test(value) && value.split('/').every(part => part !== '.' && part !== '..' && part.length > 0);
const priority = (value) => value === 0 || value === 1 || value === 2 || value === 3;
const side = (value) => value === 'left' || value === 'right';
/** Parse actual hunk coordinates, not patch-array offsets. Malformed/truncated
 * hunks have no trustworthy coordinates and fail closed. No full-file guesses. */
function diffLines(patch) {
    if (patch === null || patch.length > 4 * 1024 * 1024)
        return [];
    const result = [];
    let old = 0, next = 0, oldRemaining = 0, newRemaining = 0, inHunk = false;
    for (const row of patch.replaceAll('\r\n', '\n').split('\n')) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
        if (header) {
            if (inHunk && (oldRemaining !== 0 || newRemaining !== 0))
                return [];
            old = Number(header[1]);
            next = Number(header[3]);
            oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
            newRemaining = header[4] === undefined ? 1 : Number(header[4]);
            inHunk = true;
            if (![old, next, oldRemaining, newRemaining].every(Number.isSafeInteger) || oldRemaining < 0 || newRemaining < 0 || (oldRemaining > 0 && old < 1) || (newRemaining > 0 && next < 1))
                return [];
            continue;
        }
        if (!inHunk)
            continue;
        if (row === '\\ No newline at end of file')
            continue;
        if (row === '' && oldRemaining === 0 && newRemaining === 0)
            continue;
        const marker = row[0], text = row.slice(1);
        if (marker === ' ') {
            if (oldRemaining < 1 || newRemaining < 1)
                return [];
            result.push({ side: 'left', line: old++, text }, { side: 'right', line: next++, text });
            oldRemaining--;
            newRemaining--;
        }
        else if (marker === '-') {
            if (oldRemaining < 1)
                return [];
            result.push({ side: 'left', line: old++, text });
            oldRemaining--;
        }
        else if (marker === '+') {
            if (newRemaining < 1)
                return [];
            result.push({ side: 'right', line: next++, text });
            newRemaining--;
        }
        else
            return [];
    }
    return inHunk && oldRemaining === 0 && newRemaining === 0 ? result : [];
}
function finding(raw, snapshot, index) {
    if (!object(raw) || !priority(raw.priority) || !bounded(raw.title, 160) || !bounded(raw.explanation, 4000) || !safePath(raw.path) || !side(raw.side) || !lineNumber(raw.startLine) || !lineNumber(raw.endLine) || raw.endLine < raw.startLine || raw.endLine - raw.startLine > 39 || !bounded(raw.evidence, 8000))
        throw Error('Invalid finding fields');
    const { path, side: whichSide, startLine, endLine } = raw;
    const file = snapshot.files.find(file => file.path === path);
    if (!file)
        throw Error('File was not supplied to this review');
    const lines = diffLines(file.patch).filter(line => line.side === whichSide && line.line >= startLine && line.line <= endLine);
    if (lines.length !== endLine - startLine + 1 || lines.some((line, offset) => line.line !== startLine + offset))
        throw Error('Location is outside the supplied diff');
    if (raw.evidence.replaceAll('\r\n', '\n') !== lines.map(line => line.text).join('\n'))
        throw Error('Evidence does not match the supplied code');
    return { id: `finding-${index + 1}`, priority: raw.priority, title: raw.title, explanation: raw.explanation, path: raw.path, side: raw.side, startLine: raw.startLine, endLine: raw.endLine, evidence: raw.evidence, validation: 'evidence-linked', disposition: 'needs-confirmation' };
}
/** Complete JSON only; partial streaming JSON is never promoted to a report.
 * Metadata, coverage and display identities are derived from the trusted snapshot. */
function decodeReviewReport(raw, snapshot) {
    if (raw.length > 1024 * 1024)
        throw Error('Review report exceeds the response bound');
    const value = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.findings) || value.findings.length > 100)
        throw Error('Invalid review report');
    const items = value.findings;
    const findings = [], rejected = [], seen = new Set();
    const suppliedFiles = snapshot.files.filter(file => diffLines(file.patch).length > 0).map(file => file.path);
    const unavailableFiles = snapshot.files.filter(file => !suppliedFiles.includes(file.path)).map(file => file.path);
    for (const [index, item] of items.entries()) {
        try {
            const next = finding(item, snapshot, index), key = JSON.stringify([next.path, next.side, next.startLine, next.endLine, next.title, next.explanation]);
            if (seen.has(key)) {
                rejected.push({ index, reason: 'Duplicate finding' });
                continue;
            }
            seen.add(key);
            findings.push(next);
        }
        catch (error) {
            rejected.push({ index, reason: error instanceof Error ? error.message : 'Invalid finding' });
        }
    }
    return { target: { account: snapshot.account, repository: snapshot.repository, number: snapshot.number, headSha: snapshot.headSha }, findings, rejected, suppliedFiles, unavailableFiles, scopeIncomplete: snapshot.filesHasMore || snapshot.files.length < snapshot.changedFiles || unavailableFiles.length > 0, outcome: findings.length ? 'findings' : rejected.length ? 'invalid-findings' : 'no-findings-in-supplied-scope' };
}
function reportIsStale(report, target) {
    return report.target.account !== target.account || report.target.repository.toLowerCase() !== target.repository.toLowerCase() || report.target.number !== target.number || report.target.headSha !== target.headSha;
}

},
"src/modules/code-review/ReviewPanel.js": function(module, exports, require) {
// source: src/modules/code-review/ReviewPanel.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewPanel = ReviewPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const data_1 = require("./data");
const structured_1 = require("./structured");
const message = (e) => e instanceof Error ? e.message : 'Review request failed';
function Findings({ run, zh, jump, stale, reference }) {
    let report;
    try {
        report = (0, structured_1.decodeReviewReport)(run.text, run.snapshot);
    }
    catch (e) {
        return (0, jsx_runtime_1.jsx)("p", { role: "alert", children: message(e) });
    }
    return (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-findings", children: [(0, jsx_runtime_1.jsxs)("p", { className: "xhreview-muted", children: [zh ? 'AI 发现 · 待确认' : 'AI findings · Needs confirmation', " \u00B7 ", report.suppliedFiles.length, "/", run.snapshot.changedFiles, " ", zh ? '个文件' : 'files'] }), report.scopeIncomplete && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '审核范围不完整，部分文件或 Diff 未提供。' : 'Review scope is incomplete; some files or diffs were not supplied.' }), report.findings.map(f => (0, jsx_runtime_1.jsxs)("article", { className: "xhreview-finding", children: [(0, jsx_runtime_1.jsxs)("h3", { children: [(0, jsx_runtime_1.jsxs)("span", { children: ["P", f.priority] }), " ", f.title] }), (0, jsx_runtime_1.jsxs)("button", { disabled: stale, onClick: () => jump({ path: f.path, side: f.side, line: f.startLine }), children: [f.path, ":", f.startLine, f.endLine !== f.startLine ? `–${f.endLine}` : '', " \u00B7 ", f.side] }), (0, jsx_runtime_1.jsx)("p", { children: f.explanation }), reference && (0, jsx_runtime_1.jsx)("button", { disabled: stale, onClick: () => reference({ path: f.path, side: f.side, line: f.startLine }), children: zh ? '交给小 X' : 'Ask Little X' }), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: zh ? '代码证据' : 'Code evidence' }), (0, jsx_runtime_1.jsx)("pre", { children: f.evidence })] })] }, f.id)), !report.findings.length && (0, jsx_runtime_1.jsx)("p", { role: "status", children: report.outcome === 'invalid-findings' ? (zh ? '模型发现均未通过证据校验，不能作为无问题结论。' : 'All findings failed evidence validation; this is not a clean result.') : (zh ? '所提供范围内未发现问题，不代表审核通过。' : 'No findings in the supplied scope; this is not approval.') }), !!report.rejected.length && (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsxs)("summary", { children: [report.rejected.length, " ", zh ? '项未通过校验' : 'rejected findings'] }), (0, jsx_runtime_1.jsx)("ul", { children: report.rejected.map(f => (0, jsx_runtime_1.jsxs)("li", { children: ["#", f.index + 1, ": ", f.reason] }, f.index)) })] })] });
}
function ReviewPanel({ client, account, record, zh, disabled, jump, reference }) {
    const [models, setModels] = (0, react_1.useState)([]), [choice, setChoice] = (0, react_1.useState)(''), [runs, setRuns] = (0, react_1.useState)([]), [selected, setSelected] = (0, react_1.useState)(''), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)('');
    const [lane] = (0, react_1.useState)(() => new data_1.RequestLane()), [poll] = (0, react_1.useState)(() => new data_1.RequestLane()), [modelLane] = (0, react_1.useState)(() => new data_1.RequestLane());
    (0, react_1.useEffect)(() => { const req = modelLane.start(); void client.reviewModels(req.signal).then(items => { if (req.current()) {
        setModels(items);
        setChoice(items[0] ? JSON.stringify([items[0].provider, items[0].model]) : '');
    } }).catch((e) => { if (req.current())
        setError(message(e)); }); return () => modelLane.cancel(); }, [client, modelLane]);
    (0, react_1.useEffect)(() => { const req = lane.start(); setBusy(false); setError(''); void client.reviewHistory(account, record, req.signal).then(items => { if (req.current()) {
        setRuns(items);
        setSelected(items[0]?.id ?? '');
    } }).catch((e) => { if (req.current())
        setError(message(e)); }); return () => { lane.cancel(); poll.cancel(); }; }, [client, account, record.headSha, lane, poll]);
    const current = runs.find(run => run.id === selected), active = runs.find(run => run.status === 'running');
    (0, react_1.useEffect)(() => {
        if (!active)
            return;
        const req = poll.start();
        let timer;
        async function read() { try {
            if (!active)
                return;
            const result = await client.reviewStatus(active, 'status', req.signal);
            if (!req.current())
                return;
            setRuns(old => old.map(r => r.id === result.id ? result : r));
            if (result.status === 'running')
                timer = setTimeout(() => void read(), 1500);
        }
        catch (e) {
            if (req.current()) {
                setError(message(e));
                timer = setTimeout(() => void read(), 5000);
            }
        } }
        timer = setTimeout(() => void read(), 1000);
        return () => { if (timer !== undefined)
            clearTimeout(timer); poll.cancel(); };
    }, [client, active?.id, poll]);
    function save(run) { setRuns(old => [run, ...old.filter(r => r.id !== run.id)].slice(0, 30)); setSelected(run.id); }
    async function start() { const model = models.find(m => JSON.stringify([m.provider, m.model]) === choice); if (!model)
        return; const req = lane.start(); setBusy(true); setError(''); try {
        const run = await client.startReview(account, record, model, 'review', '', req.signal);
        if (req.current()) {
            save(run);
        }
    }
    catch (e) {
        if (req.current())
            setError(message(e));
    }
    finally {
        if (req.current())
            setBusy(false);
    } }
    async function cancel() { if (!active)
        return; const req = lane.start(); setBusy(true); setError(''); try {
        const run = await client.reviewStatus(active, 'cancel', req.signal);
        if (req.current())
            save(run);
    }
    catch (e) {
        if (req.current())
            setError(message(e));
    }
    finally {
        if (req.current())
            setBusy(false);
    } }
    const stale = current && (current.stale || current.target.sha !== record.headSha);
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhreview-model", "aria-label": zh ? '模型审核' : 'Model review', children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("h3", { children: zh ? '模型审核' : 'Model review' }), (0, jsx_runtime_1.jsx)("span", { className: "xhreview-sha", children: record.headSha.slice(0, 8) })] }), runs.length > 0 && (0, jsx_runtime_1.jsxs)("label", { children: [zh ? '审核记录' : 'Review history', " ", (0, jsx_runtime_1.jsx)("select", { "aria-label": zh ? '审核记录' : 'Review history', value: selected, onChange: e => setSelected(e.target.value), children: runs.map(r => (0, jsx_runtime_1.jsxs)("option", { value: r.id, children: [r.model, " \u00B7 ", r.target.sha.slice(0, 8), " \u00B7 ", r.status, " \u00B7 ", r.mode] }, r.id)) })] }), current && (0, jsx_runtime_1.jsxs)("article", { className: "xhreview-model-result", children: [(0, jsx_runtime_1.jsxs)("p", { children: [current.model, " \u00B7 ", current.status, " \u00B7 ", current.target.sha.slice(0, 8)] }), stale && (0, jsx_runtime_1.jsx)("p", { role: "status", className: "xhreview-error", children: zh ? '此结果已过期或当前提交无法确认，请重新审核。' : 'This result is stale or current head could not be verified. Review again.' }), current.question && (0, jsx_runtime_1.jsx)("blockquote", { children: current.question }), current.status === 'running' ? (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("p", { role: "status", children: [zh ? '正在审核…' : 'Reviewing…', " \u00B7 ", current.text.length, " ", zh ? '字符已接收' : 'characters received'] }), current.mode === 'question' && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: current.text })] }) : current.status === 'completed' ? (current.mode === 'review' ? (0, jsx_runtime_1.jsx)(Findings, { run: current, zh: zh, stale: !!stale, jump: jump, reference: reference }) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: current.text })) : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("p", { role: "alert", children: current.error ?? current.status }), current.text && (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: zh ? '未完成输出' : 'Incomplete output' }), (0, jsx_runtime_1.jsx)("pre", { children: current.text })] })] })] }), !runs.length && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: zh ? '选择模型审核当前变更，或交给全局助手讨论。' : 'Select a model to review these changes, or discuss them with the assistant.' }), busy && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '正在准备请求…' : 'Preparing request…' }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: error }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-composer", children: [(0, jsx_runtime_1.jsxs)("label", { children: [zh ? '模型' : 'Model', " ", (0, jsx_runtime_1.jsx)("select", { "aria-label": zh ? '审核模型' : 'Review model', value: choice, onChange: e => setChoice(e.target.value), disabled: busy || !!active, children: models.map(m => (0, jsx_runtime_1.jsxs)("option", { value: JSON.stringify([m.provider, m.model]), children: [m.name, " \u00B7 ", m.provider] }, JSON.stringify([m.provider, m.model]))) })] }), !models.length && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '没有可用模型，请先配置 provider。' : 'No available models. Configure a provider first.' }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("button", { disabled: disabled || busy || !!active || !choice, onClick: () => void start(), children: zh ? '审核变更' : 'Review changes' }), active && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void cancel(), children: zh ? '停止' : 'Stop' })] })] })] });
}

},
"src/modules/code-review/client.js": function(module, exports, require) {
// source: src/modules/code-review/client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubClient = exports.GitHubError = void 0;
exports.summary = summary;
exports.detail = detail;
exports.page = page;
exports.parseThreads = parseThreads;
exports.parseRuns = parseRuns;
exports.parseJobs = parseJobs;
exports.reviewRun = reviewRun;
exports.unwrap = unwrap;
class GitHubError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'GitHubError';
    }
}
exports.GitHubError = GitHubError;
function invalid() { throw new GitHubError('protocol', 'Invalid GitHub response'); }
function isObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function object(v) { if (!isObject(v))
    return invalid(); return v; }
function string(v) { if (typeof v !== 'string')
    return invalid(); return v; }
function bool(v) { if (typeof v !== 'boolean')
    return invalid(); return v; }
function number(v) { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    return invalid(); return v; }
function nullableString(v) { return v === null ? null : string(v); }
function nullableBool(v) { return v === null ? null : bool(v); }
function list(v, parse) { if (!Array.isArray(v))
    return invalid(); return v.map((item) => parse(item)); }
function summary(value) { const v = object(value); const updatedAt = string(v.updatedAt); if (!Number.isFinite(Date.parse(updatedAt)))
    return invalid(); const id = number(v.id); if (!id)
    return invalid(); return { id, repository: string(v.repository), title: string(v.title), author: string(v.author), updatedAt, state: string(v.state), draft: bool(v.draft), headSha: string(v.headSha), branch: string(v.branch) }; }
function file(value) { const v = object(value); return { path: string(v.path), status: string(v.status), patch: nullableString(v.patch), additions: number(v.additions), deletions: number(v.deletions) }; }
function comment(value) { const v = object(value); return { id: number(v.id), author: string(v.author), body: string(v.body), createdAt: string(v.createdAt) }; }
function review(value) { const v = object(value); return { id: number(v.id), author: string(v.author), state: string(v.state), body: string(v.body) }; }
function check(value) { const v = object(value); return { id: string(v.id), name: string(v.name), status: string(v.status), conclusion: nullableString(v.conclusion), description: string(v.description), url: v.url === undefined ? null : nullableString(v.url) }; }
function detail(value) { const v = object(value); return { ...summary(v), body: string(v.body), baseBranch: string(v.baseBranch), additions: number(v.additions), deletions: number(v.deletions), changedFiles: number(v.changedFiles), mergeable: nullableBool(v.mergeable), mergeableState: nullableString(v.mergeableState), files: list(v.files, file), comments: list(v.comments, comment), reviews: list(v.reviews, review), checks: list(v.checks, check), filesHasMore: bool(v.filesHasMore), commentsHasMore: bool(v.commentsHasMore), reviewsHasMore: bool(v.reviewsHasMore), checksTruncated: bool(v.checksTruncated), inlineCommentCount: number(v.inlineCommentCount), commentCount: number(v.commentCount) }; }
function page(v, parse) { const value = object(v); return { items: list(value.items, parse), hasMore: bool(value.hasMore) }; }
function nullableNumber(v) { return v === null ? null : number(v); }
function cursorPage(value, parse) { const v = object(value); const result = { ...page(v, parse), cursor: nullableString(v.cursor) }; if (result.hasMore && !result.cursor)
    return invalid(); return result; }
function threadComment(value) { const v = object(value); return { id: string(v.id), author: string(v.author), body: string(v.body), createdAt: string(v.createdAt), url: string(v.url) }; }
function thread(value) { const v = object(value), side = string(v.side); if (side !== 'left' && side !== 'right')
    return invalid(); return { id: string(v.id), path: string(v.path), side, line: nullableNumber(v.line), startLine: nullableNumber(v.startLine), resolved: bool(v.resolved), outdated: bool(v.outdated), comments: cursorPage(v.comments, threadComment) }; }
function run(value) { const v = object(value); return { id: number(v.id), name: string(v.name), status: string(v.status), conclusion: nullableString(v.conclusion), headSha: string(v.headSha), attempt: number(v.attempt), mergeTest: bool(v.mergeTest) }; }
function step(value) { const v = object(value); return { number: number(v.number), name: string(v.name), status: string(v.status), conclusion: nullableString(v.conclusion) }; }
function job(value) { const v = object(value); return { id: number(v.id), name: string(v.name), status: string(v.status), conclusion: nullableString(v.conclusion), steps: list(v.steps, step) }; }
function parseThreads(value) { return cursorPage(value, thread); }
function parseRuns(value) { return page(value, run); }
function parseJobs(value) { return page(value, job); }
function reviewRun(value) {
    const v = object(value), t = object(v.target), snap = object(v.snapshot), mode = string(v.mode), status = string(v.status);
    if (mode !== 'review' && mode !== 'question' || status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'cancelled')
        return invalid();
    const target = { account: string(t.account), repository: string(t.repository), number: number(t.number), sha: string(t.sha) };
    const snapshot = { account: string(snap.account), repository: string(snap.repository), number: number(snap.number), headSha: string(snap.headSha), files: list(snap.files, file), filesHasMore: bool(snap.filesHasMore), changedFiles: number(snap.changedFiles) };
    if (snapshot.account !== target.account || snapshot.repository.toLowerCase() !== target.repository.toLowerCase() || snapshot.number !== target.number || snapshot.headSha !== target.sha)
        return invalid();
    return { ...(v.sessionId === undefined ? {} : { sessionId: nullableString(v.sessionId) }), id: string(v.id), target, provider: string(v.provider), model: string(v.model), mode, status, question: string(v.question), text: string(v.text), snapshot, error: nullableString(v.error), stale: bool(v.stale) };
}
function unwrap(value) { const v = object(value); if (v.ok === true) {
    if ('error' in v)
        return invalid();
    return v.value;
} if (v.ok === false) {
    const error = object(v.error), details = object(error.details);
    throw new GitHubError(typeof details.kind === 'string' ? details.kind : string(error.code), string(error.message));
} return invalid(); }
class GitHubClient {
    constructor(rpc, foreground) {
        this.rpc = rpc;
        this.foreground = foreground;
    }
    async read(endpoint, args, signal) { const release = this.foreground?.(); let success = false; try {
        const result = unwrap(await this.rpc.call('/api', endpoint, { args }, signal));
        success = true;
        return result;
    }
    finally {
        release?.(success);
    } }
    async auth(signal) { const v = object(await this.read('github/auth', {}, signal)); return { account: string(v.account), source: string(v.source) }; }
    async repos(account, index, signal) { return page(await this.read('github/repos', { account, page: index }, signal), string); }
    async pulls(account, repository, index, signal) { return page(await this.read('github/pulls', { account, repository, page: index }, signal), summary); }
    async detail(account, repository, id, signal) { return detail(await this.read('github/detail', { account, repository, number: id }, signal)); }
    async files(account, record, index, signal) { return page(await this.read('github/files', { account, repository: record.repository, number: record.id, sha: record.headSha, page: index }, signal), file); }
    async comments(account, record, index, signal) { return page(await this.read('github/comments', { account, repository: record.repository, number: record.id, sha: record.headSha, page: index }, signal), comment); }
    async reviews(account, record, index, signal) { return page(await this.read('github/reviews', { account, repository: record.repository, number: record.id, sha: record.headSha, page: index }, signal), review); }
    evidenceArgs(account, record) { return { account, repository: record.repository, number: record.id, sha: record.headSha }; }
    async threads(account, record, cursor, signal) { return parseThreads(await this.read('github/threads', { ...this.evidenceArgs(account, record), cursor }, signal)); }
    async threadComments(account, record, thread, cursor, signal) { return cursorPage(await this.read('github/thread-comments', { ...this.evidenceArgs(account, record), thread, cursor }, signal), threadComment); }
    async runs(account, record, index, signal) { return parseRuns(await this.read('github/runs', { ...this.evidenceArgs(account, record), page: index }, signal)); }
    async jobs(account, record, run, index, signal) { return parseJobs(await this.read('github/jobs', { ...this.evidenceArgs(account, record), run: run.id, attempt: run.attempt, page: index }, signal)); }
    async logs(account, record, run, job, signal) { const v = object(await this.read('github/logs', { ...this.evidenceArgs(account, record), run: run.id, attempt: run.attempt, job }, signal)); return { text: string(v.text), truncated: bool(v.truncated) }; }
    async reviewModels(signal) { const v = object(await this.read('github/review-models', {}, signal)); return list(v.items, item => { const m = object(item); return { provider: string(m.provider), model: string(m.model), name: string(m.name) }; }); }
    async reviewHistory(account, record, signal) { const v = object(await this.read('github/review-history', this.evidenceArgs(account, record), signal)); return list(v.items, reviewRun); }
    async startReview(account, record, model, mode, question, signal) { return reviewRun(await this.read('github/review-start', { ...this.evidenceArgs(account, record), provider: model.provider, model: model.model, mode, question }, signal)); }
    async reviewStatus(run, action, signal) { const value = object(await this.read(`github/review-${action}`, { ...run.target, id: run.id }, signal)); return reviewRun({ ...value, snapshot: value.snapshot === null ? run.snapshot : value.snapshot }); }
}
exports.GitHubClient = GitHubClient;

},
"src/modules/code-review/cache.js": function(module, exports, require) {
// source: src/modules/code-review/cache.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewCache = void 0;
const client_1 = require("./client");
const idle_1 = require("./idle");
const LIST_TTL = 60000, DETAIL_TTL = 30000, RETENTION = 24 * 60 * 60 * 1000;
const MAX_DETAIL_BYTES = 2 * 1024 * 1024, MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const key = (account, link) => `${account}:${link.repository.toLowerCase()}#${link.id}`;
function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function object(value) { if (!isObject(value))
    throw new Error('Invalid cache'); return value; }
function string(value) { if (typeof value !== 'string')
    throw new Error('Invalid cache'); return value; }
function rows(value) { if (!Array.isArray(value))
    throw new Error('Invalid cache'); return value; }
/** Fresh data is reused; expired data remains displayable for one day while
 * refreshing. No cached identity grants access: activate follows live auth.
 */
class ReviewCache {
    constructor(now = Date.now, storage) {
        this.now = now;
        this.storage = storage;
        this.lists = new Map();
        this.details = new Map();
        this.generation = 0;
        this.loaded = false;
        this.storageQueue = Promise.resolve();
    }
    retained(expires) { return Number.isFinite(expires) && expires > this.now() - RETENTION && expires <= this.now() + LIST_TTL; }
    /** Hydrate only after /user verifies the account. Corrupt/foreign/old snapshots
     * are removed, not trusted. Late restore cannot undo reconnect/account switch.
     */
    async activate(account) {
        if (this.account !== undefined && this.account !== account)
            this.clear();
        this.account = account;
        if (this.loaded) {
            await this.restore;
            return;
        }
        this.loaded = true;
        const pending = this.hydrate(account, this.generation);
        this.restore = pending;
        await pending;
        if (this.restore === pending)
            this.restore = undefined;
    }
    async hydrate(account, generation) {
        try {
            const raw = await this.storage?.read();
            if (generation !== this.generation || this.account !== account || raw === undefined)
                return;
            if (raw.length * 2 > MAX_SNAPSHOT_BYTES)
                throw new Error('Oversized cache');
            const snapshot = object(JSON.parse(raw));
            if (snapshot.version !== 1 || snapshot.account !== account)
                throw new Error('Foreign cache');
            const expiry = (value) => { if (typeof value !== 'number' || !this.retained(value))
                throw new Error('Expired cache'); return value; };
            // Validate every row before installing any of it.
            const boot = snapshot.boot === null ? undefined : object(snapshot.boot);
            const restoredBoot = boot ? { value: { identity: { account, source: 'github-cli' }, repos: (0, client_1.page)(boot.value, string) }, expires: expiry(boot.expires) } : undefined;
            const listRows = rows(snapshot.lists), detailRows = rows(snapshot.details);
            if (listRows.length > 3 || detailRows.length > 3)
                throw new Error('Too many cache entries');
            const lists = new Map(), details = new Map();
            for (const row of listRows) {
                const entry = object(row), repository = string(entry.repository), value = (0, client_1.page)(entry.value, client_1.summary);
                if (value.items.some(item => item.repository.toLowerCase() !== repository.toLowerCase()))
                    throw new Error('Repository mismatch');
                lists.set(`${account}:${repository.toLowerCase()}`, { value, expires: expiry(entry.expires) });
            }
            for (const row of detailRows) {
                const entry = object(row), value = (0, client_1.detail)(entry.value);
                details.set(key(account, value), { value, expires: expiry(entry.expires), bytes: JSON.stringify(value).length * 2 });
            }
            if (restoredBoot && !this.boot)
                this.boot = restoredBoot;
            for (const [id, value] of lists)
                if (!this.lists.has(id))
                    this.lists.set(id, value);
            for (const [id, value] of details)
                if (!this.details.has(id))
                    this.details.set(id, value);
        }
        catch {
            if (generation === this.generation)
                this.enqueue(undefined);
        }
    }
    bootstrap(account) { if (!this.boot || !this.retained(this.boot.expires) || this.boot.value.identity.account !== account)
        return undefined; return this.boot.value; }
    bootstrapFresh(account) { return this.bootstrap(account) !== undefined && (this.boot?.expires ?? 0) > this.now(); }
    putBootstrap(identity, repos) { if (this.account !== undefined && this.account !== identity.account)
        this.clear(); this.account = identity.account; if (JSON.stringify(repos).length * 2 > 128 * 1024)
        return; this.boot = { value: { identity, repos }, expires: this.now() + LIST_TTL }; this.scheduleSave(); }
    list(account, repository) { const entry = this.lists.get(`${account}:${repository.toLowerCase()}`); if (!entry || !this.retained(entry.expires))
        return undefined; return entry.value; }
    listFresh(account, repository) { return this.list(account, repository) !== undefined && (this.lists.get(`${account}:${repository.toLowerCase()}`)?.expires ?? 0) > this.now(); }
    putList(account, repository, value) {
        const id = `${account}:${repository.toLowerCase()}`;
        this.lists.delete(id);
        if (JSON.stringify(value).length * 2 > 512 * 1024)
            return;
        this.lists.set(id, { value, expires: this.now() + LIST_TTL });
        while (this.lists.size > 3) {
            const oldest = this.lists.keys().next().value;
            if (oldest === undefined)
                break;
            this.lists.delete(oldest);
        }
        // A known new head immediately invalidates the old diff, not just its TTL.
        for (const item of value.items) {
            const entry = this.details.get(key(account, item));
            if (entry && entry.value.headSha !== item.headSha)
                this.details.delete(key(account, item));
        }
        this.scheduleSave();
    }
    detail(account, link, headSha) {
        const id = key(account, link), entry = this.details.get(id);
        if (!entry)
            return undefined;
        if (!this.retained(entry.expires) || (headSha !== undefined && entry.value.headSha !== headSha)) {
            this.details.delete(id);
            this.scheduleSave();
            return undefined;
        }
        this.details.delete(id);
        this.details.set(id, entry);
        return entry.value;
    }
    detailFresh(account, link, headSha) { return this.detail(account, link, headSha) !== undefined && (this.details.get(key(account, link))?.expires ?? 0) > this.now(); }
    putDetail(account, value) {
        const id = key(account, value), bytes = JSON.stringify(value).length * 2;
        this.details.delete(id);
        if (bytes > MAX_DETAIL_BYTES)
            return;
        this.details.set(id, { value, bytes, expires: this.now() + DETAIL_TTL });
        // A verified detail may observe a commit before the list refresh does.
        const listId = `${account}:${value.repository.toLowerCase()}`, listed = this.lists.get(listId);
        if (listed)
            this.lists.set(listId, { ...listed, value: { ...listed.value, items: listed.value.items.map(item => item.id === value.id ? { ...item, headSha: value.headSha } : item) } });
        while (this.details.size > 3 || [...this.details.values()].reduce((sum, row) => sum + row.bytes, 0) > MAX_DETAIL_BYTES) {
            const oldest = this.details.keys().next().value;
            if (oldest === undefined)
                break;
            this.details.delete(oldest);
        }
        this.scheduleSave();
    }
    enqueue(value) { this.storageQueue = this.storageQueue.then(() => this.storage?.write(value)).catch(() => { }); }
    scheduleSave() { if (!this.storage || this.saveTimer !== undefined)
        return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.persist(); }, 200); }
    /** Persist a bounded newest-first snapshot, never the full pagination history. */
    persist() {
        if (this.saveTimer !== undefined)
            clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        if (this.storage && this.account) {
            const account = this.account, prefix = `${account}:`;
            const lists = [...this.lists].filter(([id, row]) => id.startsWith(prefix) && this.retained(row.expires)).map(([id, row]) => ({ repository: id.slice(prefix.length), ...row }));
            const details = [...this.details].filter(([id, row]) => id.startsWith(prefix) && this.retained(row.expires)).map(([, row]) => ({ value: row.value, expires: row.expires }));
            const boot = this.boot && this.retained(this.boot.expires) ? { value: this.boot.value.repos, expires: this.boot.expires } : null;
            let raw = JSON.stringify({ version: 1, account, boot, lists, details });
            while (raw.length * 2 > MAX_SNAPSHOT_BYTES && (details.length || lists.length)) {
                if (details.length)
                    details.shift();
                else
                    lists.shift();
                raw = JSON.stringify({ version: 1, account, boot, lists, details });
            }
            this.enqueue(raw.length * 2 <= MAX_SNAPSHOT_BYTES ? raw : undefined);
        }
        return this.storageQueue;
    }
    flush() { return this.persist(); }
    clear() {
        this.generation++;
        this.warmController?.abort();
        this.warmController = undefined;
        this.cancelPrefetch();
        this.idle?.reset();
        if (this.saveTimer !== undefined)
            clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        this.account = undefined;
        this.loaded = false;
        this.restore = undefined;
        this.boot = undefined;
        this.lists.clear();
        this.details.clear();
        this.enqueue(undefined);
    }
    /** Module disposal cancels work, but preserves the bounded disk snapshot. */
    skipSpeculative(account, item) {
        const cached = this.details.get(key(account, item));
        // An older queued/list hint must not evict a newer foreground-verified diff.
        return cached !== undefined && this.retained(cached.expires) && (cached.value.headSha !== item.headSha || cached.expires > this.now());
    }
    dispose() { void this.flush(); this.generation++; this.warmController?.abort(); this.idle?.dispose(); this.idle = undefined; this.idleClient = undefined; }
    startIdle(client, environment) {
        this.idle?.dispose();
        this.idleClient = client;
        this.idle = new idle_1.ReviewIdleQueue(environment, error => !(error instanceof client_1.GitHubError) || !['head_changed', 'not_found'].includes(error.kind));
        this.idle.enqueue('bootstrap', signal => this.warm(client, signal));
    }
    foreground() { return this.idle?.foreground() ?? (() => { }); }
    viewed(account, item) { this.lastViewed = key(account, item); this.cancelPrefetch(); }
    /** At most two automatic details from the loaded first page, recent PR first.
     * No polling, page walking, all-repository or all-PR downloads.
     */
    scheduleDetails(account, items) {
        const client = this.idleClient, queue = this.idle;
        if (!client || !queue)
            return;
        const recent = items.find(item => key(account, item) === this.lastViewed);
        const shortlist = (recent ? [recent, ...items.filter(item => item !== recent)] : items).slice(0, 2);
        queue.remove('auto-0');
        queue.remove('auto-1');
        for (const [index, item] of shortlist.entries())
            if (!this.skipSpeculative(account, item))
                queue.enqueue(`auto-${index}`, signal => this.readSpeculative(client, account, item, signal));
    }
    async readSpeculative(client, account, item, signal) {
        if (this.skipSpeculative(account, item))
            return;
        const generation = this.generation, value = await client.detail(account, item.repository, item.id, signal);
        if (!signal.aborted && generation === this.generation && this.account === account && value.headSha === item.headSha)
            this.putDetail(account, value);
    }
    async warm(client, signal) {
        this.warmController?.abort();
        const controller = new AbortController(), generation = this.generation;
        this.warmController = controller;
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
        const current = () => generation === this.generation && !controller.signal.aborted;
        try {
            const identity = await client.auth(controller.signal);
            if (!current())
                return;
            await this.activate(identity.account);
            if (!current())
                return;
            const cached = this.bootstrap(identity.account);
            const repos = this.bootstrapFresh(identity.account) && cached ? cached.repos : await client.repos(identity.account, 1, controller.signal);
            if (!current())
                return;
            if (!this.bootstrapFresh(identity.account))
                this.putBootstrap(identity, repos);
            const repository = repos.items[0];
            if (repository) {
                let value = this.list(identity.account, repository);
                if (!this.listFresh(identity.account, repository)) {
                    value = await client.pulls(identity.account, repository, 1, controller.signal);
                    if (current())
                        this.putList(identity.account, repository, value);
                }
                if (current() && value)
                    this.scheduleDetails(identity.account, value.items);
            }
        }
        catch (error) {
            if (current())
                throw error;
        }
        finally {
            signal?.removeEventListener('abort', abort);
        }
    }
    prefetch(client, account, item) {
        this.cancelPrefetch();
        if (this.skipSpeculative(account, item))
            return;
        this.idle?.enqueue('hover', signal => this.readSpeculative(this.idleClient ?? client, account, item, signal), 10, 350);
    }
    cancelPrefetch() { this.idle?.remove('hover'); }
}
exports.ReviewCache = ReviewCache;

},
"src/modules/code-review/idle.js": function(module, exports, require) {
// source: src/modules/code-review/idle.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserIdleEnvironment = exports.ReviewIdleQueue = void 0;
class ReviewIdleQueue {
    constructor(env, shouldStop = () => true) {
        this.env = env;
        this.shouldStop = shouldStop;
        this.jobs = new Map();
        this.foregroundCount = 0;
        this.stopped = false;
        this.blocked = false;
        this.quietUntil = env.now() + 1500;
        this.unlisten = env.listen(() => { if (!env.ready())
            this.yield();
        else
            this.schedule(); }, () => this.input());
    }
    enqueue(key, run, priority = 0, delayMs = 0) {
        if (this.stopped)
            return;
        if (this.active?.job.key === key)
            this.active.controller.abort();
        this.jobs.delete(key);
        this.jobs.set(key, { key, run, priority, notBefore: this.env.now() + delayMs });
        while (this.jobs.size > 6) {
            const oldest = [...this.jobs.values()].find(job => job !== this.active?.job);
            if (!oldest)
                break;
            this.jobs.delete(oldest.key);
        }
        this.schedule();
    }
    remove(key) { this.jobs.delete(key); if (this.active?.job.key === key)
        this.active.controller.abort(); }
    yield() { this.cancelScheduled?.(); this.cancelScheduled = undefined; this.active?.controller.abort(); }
    input() { this.quietUntil = this.env.now() + 1500; this.yield(); this.schedule(); }
    /** Frontend requests do not wait for speculative requests to settle. */
    foreground() {
        this.foregroundCount++;
        this.input();
        let released = false;
        return success => { if (released)
            return; released = true; this.foregroundCount--; if (success)
            this.blocked = false; this.quietUntil = this.env.now() + 1500; this.schedule(); };
    }
    reset() { this.yield(); this.jobs.clear(); this.blocked = false; this.quietUntil = this.env.now() + 1500; }
    schedule() {
        if (this.stopped || this.blocked || this.foregroundCount || this.active || this.cancelScheduled || !this.jobs.size || !this.env.ready())
            return;
        const wait = Math.max(this.quietUntil - this.env.now(), Math.min(...[...this.jobs.values()].map(job => job.notBefore)) - this.env.now());
        if (wait > 0) {
            this.cancelScheduled = this.env.delay(() => { this.cancelScheduled = undefined; this.schedule(); }, wait);
            return;
        }
        this.cancelScheduled = this.env.request(budget => {
            this.cancelScheduled = undefined;
            if (!this.env.ready() || this.foregroundCount || this.stopped || this.blocked)
                return;
            if (budget.timeRemaining() < 8) {
                this.quietUntil = this.env.now() + 250;
                this.schedule();
                return;
            }
            const job = [...this.jobs.values()].filter(job => job.notBefore <= this.env.now()).sort((a, b) => b.priority - a.priority)[0];
            if (!job)
                return;
            const controller = new AbortController();
            this.active = { job, controller };
            void job.run(controller.signal).catch((error) => {
                if (!controller.signal.aborted && this.shouldStop(error)) {
                    this.blocked = true;
                    this.jobs.clear();
                }
            }).finally(() => {
                if (!controller.signal.aborted && this.jobs.get(job.key) === job)
                    this.jobs.delete(job.key);
                this.active = undefined;
                this.quietUntil = Math.max(this.quietUntil, this.env.now() + 250);
                this.schedule();
            });
        });
    }
    dispose() { this.stopped = true; this.yield(); this.jobs.clear(); this.unlisten(); }
}
exports.ReviewIdleQueue = ReviewIdleQueue;
class BrowserIdleEnvironment {
    now() { return performance.now(); }
    ready() { return document.visibilityState === 'visible' && navigator.onLine; }
    delay(run, ms) { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); }
    request(run) {
        if (typeof window.requestIdleCallback === 'function') {
            const id = window.requestIdleCallback(run);
            return () => window.cancelIdleCallback(id);
        }
        // WebKit fallback: defer, then measure a frame. Background tabs never force it.
        let frame;
        const timer = window.setTimeout(() => { frame = window.requestAnimationFrame(start => run({ timeRemaining: () => Math.max(0, 16 - (performance.now() - start)) })); }, 80);
        return () => { window.clearTimeout(timer); if (frame !== undefined)
            window.cancelAnimationFrame(frame); };
    }
    listen(change, input) {
        const events = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];
        for (const name of events)
            document.addEventListener(name, input, { capture: true, passive: true });
        document.addEventListener('visibilitychange', change);
        window.addEventListener('online', change);
        window.addEventListener('offline', change);
        return () => { for (const name of events)
            document.removeEventListener(name, input, true); document.removeEventListener('visibilitychange', change); window.removeEventListener('online', change); window.removeEventListener('offline', change); };
    }
}
exports.BrowserIdleEnvironment = BrowserIdleEnvironment;

},
"src/modules/code-review/storage.js": function(module, exports, require) {
// source: src/modules/code-review/storage.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserReviewStorage = void 0;
class BrowserReviewStorage {
    constructor(factory, key = 'snapshot') {
        this.factory = factory;
        this.key = key;
    }
    async transaction(write, value) {
        return new Promise((resolve, reject) => {
            const opening = this.factory.open('xharness-code-review-v1', 1);
            let settled = false;
            let database, transaction;
            const timer = setTimeout(() => fail(), 1000);
            const fail = () => { if (!settled) {
                settled = true;
                clearTimeout(timer);
                try {
                    transaction?.abort();
                }
                catch { /* Already completed. */ }
                database?.close();
                reject(new Error('Review cache unavailable'));
            } };
            opening.onerror = fail;
            opening.onblocked = fail;
            opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains('cache'))
                opening.result.createObjectStore('cache'); };
            opening.onsuccess = () => {
                const db = opening.result;
                database = db;
                if (settled) {
                    db.close();
                    return;
                }
                db.onversionchange = () => db.close();
                try {
                    const tx = db.transaction('cache', write ? 'readwrite' : 'readonly'), store = tx.objectStore('cache');
                    transaction = tx;
                    let result;
                    if (write) {
                        if (value === undefined)
                            store.delete(this.key);
                        else
                            store.put(value, this.key);
                    }
                    else {
                        const request = store.get(this.key);
                        request.onsuccess = () => { const data = request.result; if (typeof data === 'string')
                            result = data; };
                    }
                    tx.oncomplete = () => { db.close(); if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve(result);
                    } };
                    tx.onerror = tx.onabort = () => { db.close(); fail(); };
                }
                catch {
                    db.close();
                    fail();
                }
            };
        });
    }
    read() { return this.transaction(false); }
    async write(value) { await this.transaction(true, value); }
}
exports.BrowserReviewStorage = BrowserReviewStorage;

},
"src/modules/code-review/preferences.js": function(module, exports, require) {
// source: src/modules/code-review/preferences.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewPreferences = void 0;
exports.validRepository = validRepository;
exports.repositoryGroups = repositoryGroups;
const empty = () => ({ repository: '', mine: false, recent: [] });
function validRepository(value) { return typeof value === 'string' && value.length <= 201 && value.split('/').length === 2 && value.split('/').every(part => part.length > 0 && part.length <= 100 && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part)); }
function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function decode(raw, account) {
    if (raw.length > 8192)
        return empty();
    const value = JSON.parse(raw);
    if (!isObject(value) || value.version !== 1 || value.account !== account || !validRepository(value.repository) || typeof value.mine !== 'boolean' || !Array.isArray(value.recent) || value.recent.length > 6)
        return empty();
    const recent = value.recent;
    if (!recent.every(validRepository))
        return empty();
    return { repository: value.repository, mine: value.mine, recent: [...new Set(recent)] };
}
/** Account-scoped UI choices only. Separate from response-cache invalidation;
 * no credential, token, PR body or permission grant is persisted here.
 */
class ReviewPreferences {
    constructor(storage) {
        this.storage = storage;
        this.value = empty();
        this.generation = 0;
        this.operations = Promise.resolve();
    }
    async activate(account) {
        if (account === this.account) {
            await this.operations;
            return this.current(account);
        }
        this.account = account;
        this.value = empty();
        const generation = ++this.generation;
        this.operations = this.operations.then(async () => {
            if (this.account !== account || this.generation !== generation)
                return;
            try {
                const raw = await this.storage?.read();
                if (this.account === account && this.generation === generation && raw !== undefined)
                    this.value = decode(raw, account);
            }
            catch { /* Storage is optional. */ }
        });
        await this.operations;
        return this.current(account);
    }
    current(account) { return this.account === account ? { ...this.value, recent: [...this.value.recent] } : empty(); }
    select(account, repository, mine) {
        if (this.account !== account || !validRepository(repository))
            return this.current(account);
        this.generation++;
        this.value = { repository, mine, recent: [repository, ...this.value.recent.filter(item => item !== repository)].slice(0, 6) };
        const raw = JSON.stringify({ version: 1, account, ...this.value });
        this.operations = this.operations.then(() => this.storage?.write(raw)).catch(() => { });
        return this.current(account);
    }
    flush() { return this.operations; }
}
exports.ReviewPreferences = ReviewPreferences;
function repositoryGroups(repositories, recent, query) {
    const match = query.trim().toLowerCase(), all = [...new Set(repositories)].filter(item => item.toLowerCase().includes(match));
    const known = new Set(all), recentItems = [...new Set(recent)].filter(item => known.has(item)).slice(0, 6), recentSet = new Set(recentItems);
    const groups = [{ label: 'recent', items: recentItems }, { label: 'other', items: all.filter(item => !recentSet.has(item)) }];
    return groups.filter(group => group.items.length > 0);
}

},
"src/modules/code-review/RepositoryPicker.js": function(module, exports, require) {
// source: src/modules/code-review/RepositoryPicker.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepositoryPicker = RepositoryPicker;
exports.AuthorFilter = AuthorFilter;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const preferences_1 = require("./preferences");
function RepositoryPicker({ repository, repositories, recent, hasMore, busy, change, more, zh }) {
    const [open, setOpen] = (0, react_1.useState)(false), [query, setQuery] = (0, react_1.useState)(''), [active, setActive] = (0, react_1.useState)(0);
    const root = (0, react_1.useRef)(null), trigger = (0, react_1.useRef)(null), search = (0, react_1.useRef)(null), list = (0, react_1.useRef)(null);
    const id = (0, react_1.useId)(), groups = (0, preferences_1.repositoryGroups)(repositories, recent, query), items = groups.flatMap(group => group.items), index = Math.min(active, Math.max(0, items.length - 1));
    const words = (en, cn) => zh ? cn : en;
    const dismiss = () => { setOpen(false); trigger.current?.focus(); };
    const choose = (value) => { change(value); dismiss(); };
    const show = () => { setQuery(''); setActive(Math.max(0, (0, preferences_1.repositoryGroups)(repositories, recent, '').flatMap(group => group.items).indexOf(repository))); setOpen(true); };
    (0, react_1.useEffect)(() => { if (!open)
        return; search.current?.focus(); const outside = (event) => { if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false); }; document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside); }, [open]);
    (0, react_1.useEffect)(() => { if (open)
        list.current?.querySelector('[data-highlighted=true]')?.scrollIntoView({ block: 'nearest' }); }, [open, index, query]);
    function keys(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(value => items.length ? (Math.min(value, items.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : 0);
        }
        else if (event.key === 'Enter') {
            event.preventDefault();
            const item = items[index];
            if (item !== undefined)
                choose(item);
        }
    }
    const slash = repository.indexOf('/'), name = slash < 0 ? repository : repository.slice(slash + 1);
    return (0, jsx_runtime_1.jsxs)("div", { ref: root, className: "xhreview-repository", onBlur: event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget))
            setOpen(false); }, children: [(0, jsx_runtime_1.jsxs)("button", { ref: trigger, type: "button", className: "xhreview-repository-trigger", "aria-label": `${words('Repository', '仓库')}: ${repository || words('Select repository', '选择仓库')}`, "aria-haspopup": "dialog", "aria-expanded": open, "aria-controls": id, title: repository, onClick: () => open ? dismiss() : show(), onKeyDown: event => { if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    show();
                } }, children: [(0, jsx_runtime_1.jsx)("span", { children: name || words('Select repository', '选择仓库') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 14 })] }), open && (0, jsx_runtime_1.jsxs)("section", { id: id, role: "dialog", "aria-label": words('Choose repository', '选择仓库'), className: "xhreview-repository-popover", onKeyDown: event => { if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    dismiss();
                } }, children: [(0, jsx_runtime_1.jsxs)("label", { className: "xhreview-repository-search", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSearchOutline16, { size: 16 }), (0, jsx_runtime_1.jsx)("input", { ref: search, type: "search", role: "combobox", "aria-label": words('Search repositories', '搜索仓库'), placeholder: words('Search repositories…', '搜索仓库…'), value: query, "aria-expanded": "true", "aria-autocomplete": "list", "aria-controls": `${id}-list`, "aria-activedescendant": items.length ? `${id}-option-${index}` : undefined, onChange: event => { setQuery(event.target.value); setActive(0); }, onKeyDown: keys })] }), (0, jsx_runtime_1.jsxs)("div", { ref: list, id: `${id}-list`, className: "xhreview-repository-options", role: "listbox", "aria-label": words('Repositories', '仓库列表'), children: [groups.map(group => (0, jsx_runtime_1.jsxs)("div", { role: "group", "aria-label": group.label === 'recent' ? words('Recently used', '最近使用') : words('Repositories', '仓库'), children: [(0, jsx_runtime_1.jsx)("div", { className: "xhreview-repository-group", "aria-hidden": "true", children: group.label === 'recent' ? words('Recently used', '最近使用') : words('Repositories', '仓库') }), group.items.map(repo => { const rowIndex = items.indexOf(repo), split = repo.indexOf('/'); return (0, jsx_runtime_1.jsxs)("button", { id: `${id}-option-${rowIndex}`, type: "button", role: "option", "aria-label": repo, "aria-selected": repo === repository, tabIndex: -1, "data-highlighted": rowIndex === index, className: "xhreview-repository-option", title: repo, onPointerMove: () => setActive(rowIndex), onMouseDown: event => event.preventDefault(), onClick: () => choose(repo), children: [(0, jsx_runtime_1.jsxs)("span", { children: [(0, jsx_runtime_1.jsx)("strong", { children: repo.slice(split + 1) }), (0, jsx_runtime_1.jsx)("small", { children: repo.slice(0, split) })] }), repo === repository && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 16 })] }, repo); })] }, group.label)), !items.length && (0, jsx_runtime_1.jsx)("p", { role: "status", className: "xhreview-repository-none", children: words('No matching repositories', '没有匹配的仓库') })] }), hasMore && (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhreview-repository-more", disabled: busy, onClick: more, children: busy ? words('Loading…', '加载中…') : words('Load more repositories', '加载更多仓库') })] })] });
}
function AuthorFilter({ mine, change, zh }) {
    const all = (0, react_1.useRef)(null), own = (0, react_1.useRef)(null);
    function keys(event) { const value = event.key === 'ArrowLeft' || event.key === 'Home' ? false : event.key === 'ArrowRight' || event.key === 'End' ? true : undefined; if (value !== undefined) {
        event.preventDefault();
        change(value);
        (value ? own : all).current?.focus();
    } }
    return (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-author-filter", role: "radiogroup", "aria-label": zh ? '筛选当前仓库的开放 PR' : 'Filter open pull requests in this repository', children: [(0, jsx_runtime_1.jsx)("button", { ref: all, type: "button", role: "radio", "aria-checked": !mine, tabIndex: !mine ? 0 : -1, onKeyDown: keys, onClick: () => change(false), children: zh ? '全部' : 'All' }), (0, jsx_runtime_1.jsx)("button", { ref: own, type: "button", role: "radio", "aria-checked": mine, tabIndex: mine ? 0 : -1, onKeyDown: keys, onClick: () => change(true), children: zh ? '由我创建' : 'Authored by me' })] });
}

}
};
const __dependencies = {"src/modules/code-review/index.js":{"./CodeReview.css":"src/modules/code-review/CodeReview.css","./EvidencePanel":"src/modules/code-review/EvidencePanel.js","../assistant/contracts":"src/modules/assistant/contracts.js","./assistant-reference":"src/modules/code-review/assistant-reference.js","./ReviewPanel":"src/modules/code-review/ReviewPanel.js","./structured":"src/modules/code-review/structured.js","./diff-rows":"src/modules/code-review/diff-rows.js","./client":"src/modules/code-review/client.js","./cache":"src/modules/code-review/cache.js","./storage":"src/modules/code-review/storage.js","./preferences":"src/modules/code-review/preferences.js","./RepositoryPicker":"src/modules/code-review/RepositoryPicker.js","./idle":"src/modules/code-review/idle.js","./data":"src/modules/code-review/data.js"},"src/modules/code-review/CodeReview.css":{},"src/modules/code-review/EvidencePanel.js":{"./data":"src/modules/code-review/data.js"},"src/modules/code-review/data.js":{},"src/modules/assistant/contracts.js":{},"src/modules/code-review/assistant-reference.js":{"./diff-rows":"src/modules/code-review/diff-rows.js"},"src/modules/code-review/diff-rows.js":{"./structured":"src/modules/code-review/structured.js"},"src/modules/code-review/structured.js":{},"src/modules/code-review/ReviewPanel.js":{"./data":"src/modules/code-review/data.js","./structured":"src/modules/code-review/structured.js"},"src/modules/code-review/client.js":{},"src/modules/code-review/cache.js":{"./client":"src/modules/code-review/client.js","./idle":"src/modules/code-review/idle.js"},"src/modules/code-review/idle.js":{},"src/modules/code-review/storage.js":{},"src/modules/code-review/preferences.js":{},"src/modules/code-review/RepositoryPicker.js":{"./preferences":"src/modules/code-review/preferences.js"}};
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
return __load("src/modules/code-review/index.js");
}
});
