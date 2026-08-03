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
exports.inject = void 0;
exports.CodeReview = CodeReview;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/// <reference path="../shared/assets.d.ts" />
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const CodeReview_css_1 = __importDefault(require("./CodeReview.css"));
const client_1 = require("./client");
const cache_1 = require("./cache");
const storage_1 = require("./storage");
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
function FileDiff({ file, initiallyOpen }) { const [open, setOpen] = (0, react_1.useState)(initiallyOpen); return (0, jsx_runtime_1.jsxs)("details", { open: open, onToggle: event => setOpen(event.currentTarget.open), children: [(0, jsx_runtime_1.jsxs)("summary", { children: [file.path, " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-add", children: ["+", file.additions] }), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-remove", children: ["\u2212", file.deletions] })] }), open && (file.patch !== null ? (0, jsx_runtime_1.jsx)("pre", { children: file.patch.split('\n').map((line, index) => (0, jsx_runtime_1.jsxs)("span", { className: line.startsWith('+') ? 'xhreview-added' : line.startsWith('-') ? 'xhreview-removed' : '', children: [line, '\n'] }, index)) }) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('Diff unavailable (binary or large file). Open GitHub.', 'Diff 未提供（二进制或大文件），请在 GitHub 查看。') }))] }); }
function Metadata({ record, more, busy }) {
    return (0, jsx_runtime_1.jsxs)("aside", { className: "xhreview-metadata", "aria-label": text('Pull request status', 'PR 状态'), children: [(0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Merge status', '合并状态') }), (0, jsx_runtime_1.jsx)("p", { children: record.mergeable === null ? text('GitHub is calculating mergeability', 'GitHub 正在计算合并状态') : record.mergeable ? text('No merge conflicts', '无合并冲突') : text('Merge conflicts', '存在合并冲突') }), (0, jsx_runtime_1.jsx)("small", { className: "xhreview-muted", children: record.mergeableState })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsxs)("h3", { children: [text('Comments', '评论'), " \u00B7 ", record.commentCount] }), record.comments.length ? record.comments.map(item => (0, jsx_runtime_1.jsx)(ReadonlyNote, { label: item.author, body: item.body }, item.id)) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No conversation comments', '暂无对话评论') }), record.commentsHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => more('comments'), children: text('Load more', '加载更多') }), record.inlineCommentCount > 0 && (0, jsx_runtime_1.jsxs)("p", { className: "xhreview-muted", children: [record.inlineCommentCount, " ", text('inline comments on GitHub', '条行内评论，见 GitHub')] })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Reviews', '审核') }), record.reviews.length ? record.reviews.map(item => (0, jsx_runtime_1.jsx)(ReadonlyNote, { label: `${item.author} · ${item.state}`, body: item.body }, item.id)) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No submitted reviews', '暂无审核记录') }), record.reviewsHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => more('reviews'), children: text('Load more', '加载更多') })] }), (0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { children: text('Checks', '检查') }), (0, jsx_runtime_1.jsx)("small", { className: "xhreview-sha", title: record.headSha, children: record.headSha.slice(0, 8) }), record.checks.map(item => (0, jsx_runtime_1.jsxs)("details", { className: "xhreview-check", children: [(0, jsx_runtime_1.jsxs)("summary", { children: [(0, jsx_runtime_1.jsx)(StatusIcon, { state: (0, data_1.checkState)(item) }), (0, jsx_runtime_1.jsx)("span", { children: item.name })] }), (0, jsx_runtime_1.jsx)("p", { children: item.conclusion ?? item.status }), item.description && (0, jsx_runtime_1.jsx)("p", { children: item.description })] }, item.id)), !record.checks.length && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No reported checks', '暂无检查结果') }), record.checksTruncated && (0, jsx_runtime_1.jsx)("p", { role: "status", children: text('Check list incomplete. Open GitHub for all checks.', '检查列表不完整，请在 GitHub 查看全部检查。') })] })] });
}
/** Read-only feature; each request lane rejects stale repository/PR responses. */
function CodeReview({ close, client, cache }) {
    const [identity, setIdentity] = (0, react_1.useState)(null), [repos, setRepos] = (0, react_1.useState)([]), [repository, setRepository] = (0, react_1.useState)(''), [repoMore, setRepoMore] = (0, react_1.useState)(false), [repoPage, setRepoPage] = (0, react_1.useState)(1);
    const [query, setQuery] = (0, react_1.useState)(''), [mine, setMine] = (0, react_1.useState)(false), [pulls, setPulls] = (0, react_1.useState)([]), [pullMore, setPullMore] = (0, react_1.useState)(false), [pullPage, setPullPage] = (0, react_1.useState)(1);
    const [selected, setSelected] = (0, react_1.useState)(null), [record, setRecord] = (0, react_1.useState)(null), [tab, setTab] = (0, react_1.useState)('summary');
    const [epoch, setEpoch] = (0, react_1.useState)(0), [authEpoch, setAuthEpoch] = (0, react_1.useState)(0), [loading, setLoading] = (0, react_1.useState)(''), [listBusy, setListBusy] = (0, react_1.useState)(false), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(''), [listError, setListError] = (0, react_1.useState)(''), [repoError, setRepoError] = (0, react_1.useState)(''), [detailError, setDetailError] = (0, react_1.useState)(''), [stale, setStale] = (0, react_1.useState)(false);
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
                const cached = cache.bootstrap(user.account);
                const show = (data) => { setIdentity(user); setRepos(data.items); setRepoPage(1); setRepoMore(data.hasMore); setRepository(old => old || data.items[0] || ''); };
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
    }, [client, cache, authEpoch, authLane, listLane, detailLane, moreLane]);
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
    function changeRepository(value) { cache.cancelPrefetch(); listLane.cancel(); detailLane.cancel(); moreLane.cancel(); setPulls([]); setSelected(null); setRecord(null); setLoading(''); setDetailError(''); setBusy(false); setRepository(value); }
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
    function switchTab(event) { const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'summary' : event.key === 'ArrowRight' || event.key === 'End' ? 'changes' : null; if (next !== null) {
        event.preventDefault();
        setTab(next);
        document.getElementById(`xhreview-tab-${next}`)?.focus();
    } }
    return (0, jsx_runtime_1.jsxs)("main", { className: "xhreview", "data-selected": selected !== null, "aria-label": "Code Review workspace", children: [(0, jsx_runtime_1.jsxs)("nav", { className: "xhreview-list", "aria-label": text('Pull requests', 'PR 列表'), children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("h1", { children: "Code Review" }), (0, jsx_runtime_1.jsx)("button", { className: "xhreview-close", type: "button", "aria-label": text('Back to chat', '返回对话'), onClick: close, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 18 }) })] }), (0, jsx_runtime_1.jsxs)("label", { className: "xhreview-search", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSearchOutline16, { size: 18 }), (0, jsx_runtime_1.jsx)("input", { type: "search", "aria-label": text('Search or paste a PR link', '搜索或粘贴 PR 链接'), placeholder: text('Search or paste a PR link', '搜索或粘贴 PR 链接'), value: query, onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Enter')
                                    openLink(); } })] }), (0, data_1.parsePullLink)(query) && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-action", disabled: !identity, onClick: openLink, children: text('Open PR', '打开 PR') }), identity && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("select", { "aria-label": text('Repository', '仓库'), value: repository, onChange: event => changeRepository(event.target.value), children: repos.map(repo => (0, jsx_runtime_1.jsx)("option", { children: repo }, repo)) }), repoMore && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-action", disabled: busy, onClick: () => void more('repos'), children: text('More repositories', '更多仓库') }), (0, jsx_runtime_1.jsxs)("select", { "aria-label": text('Pull request filter', '筛选 PR'), value: mine ? 'mine' : 'all', onChange: event => setMine(event.target.value === 'mine'), children: [(0, jsx_runtime_1.jsx)("option", { value: "all", children: text('Open pull requests', '打开的 PR') }), (0, jsx_runtime_1.jsx)("option", { value: "mine", children: text('Authored by me', '由我创建') })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-rows", children: [!identity && (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-connect", children: [(0, jsx_runtime_1.jsx)("p", { children: loading || text("Uses GitHub CLI login on the Host computer.", "使用 Host 所在电脑的 GitHub CLI 登录。") }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: error })] }), repoError && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhreview-error", children: repoError }), listBusy && (0, jsx_runtime_1.jsx)("p", { role: "status", className: "xhreview-muted", children: pulls.length ? text('Refreshing…', '刷新中…') : text('Loading…', '加载中…') }), listError && (0, jsx_runtime_1.jsxs)("p", { role: "alert", className: "xhreview-error", children: [listError, " ", text('List may be stale.', '列表可能过期。')] }), filtered.map(item => (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhreview-row", "aria-current": selected?.repository === item.repository && selected.id === item.id ? 'true' : undefined, onMouseEnter: () => identity && cache.prefetch(client, identity.account, item), onFocus: () => identity && cache.prefetch(client, identity.account, item), onMouseLeave: () => cache.cancelPrefetch(), onBlur: () => cache.cancelPrefetch(), onClick: () => choose({ repository: item.repository, id: item.id }), children: [(0, jsx_runtime_1.jsx)("span", { className: "xhreview-row-title", children: item.title }), (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-row-meta", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: item.author }), (0, jsx_runtime_1.jsxs)("span", { children: ["#", item.id, " \u00B7 ", (0, data_1.age)(item.updatedAt)] })] })] }, (0, data_1.recordKey)(item))), identity && !listBusy && filtered.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-empty-list", role: "status", children: text('No matching pull requests', '没有匹配的 PR') }), pullMore && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-action", disabled: busy || listBusy, onClick: () => void more('pulls'), children: text('Load more', '加载更多') })] }), (0, jsx_runtime_1.jsxs)("footer", { className: "xhreview-account", children: [(0, jsx_runtime_1.jsx)("span", { children: identity?.account ?? 'GitHub' }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: !!loading, onClick: () => identity ? setEpoch(value => value + 1) : setAuthEpoch(value => value + 1), children: text('Refresh', '刷新') }), identity && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { cache.clear(); setAuthEpoch(value => value + 1); }, children: text('Reconnect', '重新连接') })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-detail", children: [(error || detailError) && (0, jsx_runtime_1.jsx)("div", { role: "alert", className: "xhreview-error", children: error || detailError }), loading && (0, jsx_runtime_1.jsx)("div", { role: "status", className: "xhreview-loading", children: loading }), record ? (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhreview-toolbar", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhreview-list-back", onClick: () => { detailLane.cancel(); moreLane.cancel(); setSelected(null); setRecord(null); setLoading(''); }, children: text('Pull requests', 'PR 列表') }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-tabs", role: "tablist", "aria-label": text('Pull request content', 'PR 内容'), children: [(0, jsx_runtime_1.jsx)("button", { type: "button", id: "xhreview-tab-summary", role: "tab", "aria-selected": tab === 'summary', "aria-controls": "xhreview-panel", tabIndex: tab === 'summary' ? 0 : -1, onKeyDown: switchTab, onClick: () => setTab('summary'), children: text('Summary', '概述') }), (0, jsx_runtime_1.jsxs)("button", { type: "button", id: "xhreview-tab-changes", role: "tab", "aria-selected": tab === 'changes', "aria-controls": "xhreview-panel", tabIndex: tab === 'changes' ? 0 : -1, onKeyDown: switchTab, onClick: () => setTab('changes'), children: [text('Changes', '变更'), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-add", children: ["+", record.additions] }), " ", (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-remove", children: ["\u2212", record.deletions] })] })] }), (0, jsx_runtime_1.jsx)("a", { className: "xhreview-github", href: `https://github.com/${record.repository}/pull/${record.id}`, target: "_blank", rel: "noopener noreferrer", children: "GitHub \u2197" })] }), stale && (0, jsx_runtime_1.jsx)("p", { className: "xhreview-error", role: "status", children: loading ? text('Refreshing cached data…', '正在刷新缓存数据…') : text('Cached data. Refresh required.', '缓存数据，需要刷新。') }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-content", children: [(0, jsx_runtime_1.jsxs)("section", { id: "xhreview-panel", className: "xhreview-body", role: "tabpanel", "aria-labelledby": `xhreview-tab-${tab}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhreview-identity", children: [(0, jsx_runtime_1.jsxs)("span", { className: "xhreview-open", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 16 }), " ", record.draft ? text('Draft', '草稿') : record.state] }), (0, jsx_runtime_1.jsxs)("span", { children: [record.repository, " #", record.id] })] }), (0, jsx_runtime_1.jsx)("h2", { children: record.title }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-author", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: record.author }), (0, jsx_runtime_1.jsx)("strong", { children: record.author }), (0, jsx_runtime_1.jsx)("span", { children: (0, data_1.age)(record.updatedAt) }), (0, jsx_runtime_1.jsxs)("span", { className: "xhreview-branch", title: record.branch, children: ["\u00B7 ", record.branch, " \u2192 ", record.baseBranch] })] }), tab === 'summary' ? (0, jsx_runtime_1.jsx)("article", { className: "xhreview-description", children: record.body ? (0, jsx_runtime_1.jsx)("div", { className: "xhreview-description-body", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MarkdownText, { text: record.body }) }) : (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: text('No description', '暂无说明') }) }) : (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-files", children: [(0, jsx_runtime_1.jsxs)("p", { className: "xhreview-muted", children: [record.files.length, " / ", record.changedFiles, " ", text('files', '个文件')] }), record.files.map((file, index) => (0, jsx_runtime_1.jsx)(FileDiff, { file: file, initiallyOpen: index === 0 }, file.path)), record.filesHasMore && (0, jsx_runtime_1.jsx)("button", { disabled: busy || stale, onClick: () => void more('files'), children: text('Load more files', '加载更多文件') }), !record.filesHasMore && record.files.length < record.changedFiles && (0, jsx_runtime_1.jsx)("p", { role: "status", children: text('GitHub file limit reached. Open GitHub for the remaining files.', 'GitHub 文件上限已到，请在 GitHub 查看其余文件。') })] })] }, `${(0, data_1.recordKey)(record)}:${tab}`), (0, jsx_runtime_1.jsx)(Metadata, { record: record, more: kind => void more(kind), busy: busy || stale })] })] }) : selectedSummary ? (0, jsx_runtime_1.jsxs)("section", { className: "xhreview-pending", "aria-busy": !!loading, children: [(0, jsx_runtime_1.jsx)("div", { className: "xhreview-identity", children: (0, jsx_runtime_1.jsxs)("span", { children: [selectedSummary.repository, " #", selectedSummary.id] }) }), (0, jsx_runtime_1.jsx)("h2", { children: selectedSummary.title }), (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-author", children: [(0, jsx_runtime_1.jsx)(Avatar, { author: selectedSummary.author }), (0, jsx_runtime_1.jsx)("strong", { children: selectedSummary.author }), (0, jsx_runtime_1.jsx)("span", { children: selectedSummary.branch })] }), (0, jsx_runtime_1.jsx)("p", { className: "xhreview-muted", children: loading ? text('Loading description and changes…', '正在加载说明和变更…') : text('Details unavailable. Retry refresh.', '详情暂不可用，请刷新重试。') })] }) : (0, jsx_runtime_1.jsxs)("div", { className: "xhreview-empty", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 32 }), (0, jsx_runtime_1.jsx)("h2", { children: identity ? text('Select a pull request', '选择一个 PR') : text('Connect GitHub', '连接 GitHub') }), (0, jsx_runtime_1.jsx)("p", { children: identity ? text('Choose one from the sidebar to review its changes', '从左侧选择 PR 查看变更') : text('Uses GitHub CLI login on the Host computer.', '使用 Host 所在电脑的 GitHub CLI 登录。') }), !identity && !loading && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { cache.clear(); setAuthEpoch(value => value + 1); }, children: text('Retry connection', '重试连接') }), selected && (0, jsx_runtime_1.jsx)("button", { className: "xhreview-list-back", onClick: () => { setSelected(null); setLoading(''); }, children: text('Pull requests', 'PR 列表') })] })] })] });
}
exports.inject = ['slots', 'connection'];
function apply(ctx) {
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.xharnessCodeReview = ''; style.textContent = CodeReview_css_1.default; document.head.append(style); return () => style.remove(); }, 'code-review: scoped styles');
    const rpc = ctx.get('connection').rpc, cache = new cache_1.ReviewCache(Date.now, typeof indexedDB === 'undefined' ? undefined : new storage_1.BrowserReviewStorage(indexedDB));
    const client = new client_1.GitHubClient(rpc, () => cache.foreground()), backgroundClient = new client_1.GitHubClient(rpc);
    ctx.effect(() => { cache.startIdle(backgroundClient, new idle_1.BrowserIdleEnvironment()); return () => cache.dispose(); }, 'code-review: cooperative idle preloading');
    ctx.slots.inject('review.center', () => ctx.slots.register({ name: 'review.center', id: 'code-review', inject: () => ({ client, cache }) }, CodeReview));
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'code-review-navigation', order: 0 }, ReviewNavigation));
}

},
"src/modules/code-review/CodeReview.css": function(module, exports, require) {
// source: src/modules/code-review/CodeReview.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhreview{display:flex;flex:1;min-width:0;min-height:0;height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px}.xhreview *{box-sizing:border-box}.xhreview button,.xhreview input,.xhreview select{font:inherit;color:inherit}.xhreview button,.xhreview summary{cursor:pointer}.xhreview button:focus-visible,.xhreview select:focus-visible,.xhreview summary:focus-visible,.xhreview-nav:focus-visible{outline:2px solid currentColor;outline-offset:2px}\n.xhreview-list{flex:0 0 280px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);padding:18px 10px 12px}.xhreview-list header{display:flex;align-items:center;justify-content:space-between;padding:0 9px;margin-bottom:20px;gap:10px}.xhreview-list h1{font-size:21px;font-weight:650;letter-spacing:-.3px;margin:0}.xhreview-close{border:0;background:none;display:grid;place-items:center;padding:6px;color:var(--dsw-alias-label-tertiary)!important;border-radius:6px}.xhreview-close:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-search{display:flex;align-items:center;gap:10px;min-width:0;border-radius:24px;padding:13px 14px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}.xhreview-search input{padding:0;border:0;outline:0;min-width:0;width:100%;background:none;font-size:15px}.xhreview-search:focus-within{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}.xhreview-search input::placeholder{color:var(--dsw-alias-label-tertiary)}.xhreview-list select{align-self:flex-start;max-width:100%;margin:17px 5px 12px;padding:0 4px;background:transparent;border:0;font-size:15px;color:var(--dsw-alias-label-secondary)}.xhreview-rows{flex:1;overflow:auto;min-height:0}.xhreview-row{display:block;position:relative;width:100%;text-align:left;background:none;border:0;border-radius:12px;padding:8px 10px 10px}.xhreview-row:hover,.xhreview-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:16px;line-height:1.4}.xhreview-row-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:7px}.xhreview-row-meta img,.xhreview-author img{border-radius:50%;flex-shrink:0}.xhreview-row-meta .xhreview-state{margin-left:auto}.xhreview-preview{color:var(--dsw-alias-label-tertiary);font-size:11px}.xhreview-list>.xhreview-preview{padding:12px 10px 0}\n.xhreview-detail{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;container-type:inline-size;container-name:review-detail}.xhreview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 16px}.xhreview-tabs{display:flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);padding:3px;border-radius:24px;gap:3px;max-width:100%}.xhreview-tabs button{border:0;background:transparent;border-radius:20px;padding:7px 11px;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:14px}.xhreview-tabs button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhreview-add{color:#268d49}.xhreview-remove{color:#ce4e52}.xhreview-content{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:32px;overflow:auto;flex:1;min-height:0;padding:8px 26px 48px}.xhreview-body{min-width:0}.xhreview-identity{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 12px}.xhreview-open{display:inline-flex;align-items:center;gap:6px;background:#24a95813;color:#1c9747;border-radius:20px;padding:7px 14px}.xhreview-body>h2{margin:0 0 16px;font-size:27px;line-height:1.26;letter-spacing:-.6px;font-weight:650;overflow-wrap:anywhere}.xhreview-author{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:13px;white-space:nowrap}.xhreview-author strong{font-weight:550;color:var(--dsw-alias-label-primary)}.xhreview-branch{overflow:hidden;text-overflow:ellipsis;min-width:0}.xhreview-description{font-size:17px;line-height:1.75}.xhreview-description h3{font-size:21px;margin:26px 0 10px;font-weight:600}.xhreview-description p{margin:0 0 20px;overflow-wrap:anywhere}.xhreview-metadata{padding-top:2px;min-width:0}.xhreview-metadata section{padding:0 0 18px;margin-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhreview-metadata section:last-child{border-bottom:0}.xhreview-metadata h3{font-size:14px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin:0 0 15px}.xhreview-metadata p{margin:0;font-size:14px}.xhreview-muted{color:var(--dsw-alias-label-tertiary)}.xhreview-check{margin:0 0 12px}.xhreview-check summary{display:flex;gap:13px;align-items:center;list-style:none;font-size:15px}.xhreview-check summary::-webkit-details-marker{display:none}.xhreview-state{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;flex-shrink:0}.xhreview-state.passed{color:white;background:#0aa443}.xhreview-state.failed{color:#d64b52;border:1px solid currentColor}.xhreview pre{font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;margin:12px 0 0;max-width:100%;overflow:auto;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:12px}.xhreview-check pre{white-space:pre-wrap;overflow-wrap:anywhere}.xhreview-files{margin-top:28px}.xhreview-files details{margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}.xhreview-files summary{padding:12px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.xhreview-files pre{margin:0;border-radius:0}.xhreview-files pre span{display:block;min-width:max-content}.xhreview-added{background:#24974718}.xhreview-removed{background:#ce4e5218}.xhreview-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--dsw-alias-label-tertiary);gap:10px}.xhreview-empty h2{font-size:18px;margin:14px 0 0;color:var(--dsw-alias-label-primary);font-weight:550}.xhreview-empty p{margin:0;font-size:15px}.xhreview-empty-list{padding:10px;font-size:13px;color:var(--dsw-alias-label-tertiary)}.xhreview-list-back{display:none}.xhreview-nav{display:flex;align-items:center;justify-content:center;gap:8px;min-height:32px;width:100%;border:0;background:none;border-radius:8px;padding:5px 8px;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px}.xhreview-nav:hover,.xhreview-nav[aria-current=page]{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-nav svg{flex-shrink:0}\n@container review-detail (max-width:740px){.xhreview-content{grid-template-columns:minmax(0,1fr);gap:24px}.xhreview-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xhreview-body>h2{font-size:25px}.xhreview-description{font-size:16px}.xhreview-metadata section{margin:0}}\n@media(max-width:920px){.xhreview-list{flex-basis:240px}.xhreview-list h1{font-size:19px}.xhreview-row-title{font-size:15px}.xhreview-content{padding:8px 20px 32px}}\n@media(max-width:650px){.xhreview-list{flex:1}.xhreview[data-selected=true] .xhreview-list{display:none}.xhreview[data-selected=false] .xhreview-detail{display:none}.xhreview-list-back{display:block;border:0;background:none;padding:6px;color:var(--dsw-alias-label-secondary)}.xhreview-toolbar{flex-wrap:wrap;gap:8px;padding:12px}.xhreview-toolbar>.xhreview-preview{display:none}.xhreview-tabs button{font-size:13px;padding:7px 9px}.xhreview-author{flex-wrap:wrap;white-space:normal}.xhreview-branch{flex-basis:100%}.xhreview-content{padding:8px 16px 32px}.xhreview-metadata{grid-template-columns:minmax(0,1fr)}}\n.xhreview-account{display:flex;align-items:center;gap:8px;padding:12px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;flex-wrap:wrap}.xhreview-account span{flex:1}.xhreview-account button,.xhreview-action{border:0;background:none;border-radius:6px;padding:6px;font-size:12px}.xhreview-action{margin:0 4px 6px}.xhreview-account button:hover,.xhreview-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhreview-avatar{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);flex-shrink:0}.xhreview-error{padding:12px;overflow-wrap:anywhere;font-size:13px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}.xhreview-loading{padding:10px 26px;color:var(--dsw-alias-label-tertiary);font-size:13px}.xhreview-comment,.xhreview-description-body{white-space:pre-wrap;overflow-wrap:anywhere}.xhreview-description-body{margin-top:26px!important}.xhreview-github{font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none}.xhreview-sha{display:block;color:var(--dsw-alias-label-tertiary);margin-bottom:14px;font-family:monospace}.xhreview-state.pending,.xhreview-state.neutral{color:var(--dsw-alias-label-tertiary);border:1px solid currentColor}.xhreview-metadata details:not(.xhreview-check){font-size:13px;margin-bottom:12px}.xhreview-metadata button,.xhreview-files>button,.xhreview-empty button{border:1px solid var(--dsw-alias-border-l1);background:none;border-radius:8px;padding:8px 12px}.xhreview button:disabled{cursor:default;opacity:.5}\n.xhreview-connect{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary);padding:8px}.xhreview-connect .xhreview-error{padding:0;border:0}\n.xhreview-comment,.xhreview-description-body{white-space:normal}\n.xhreview-pending{padding:32px;max-width:820px}.xhreview-pending h2{font-size:28px;line-height:1.35;margin:16px 0}.xhreview-pending .xhreview-muted{margin-top:32px}\n";

},
"src/modules/code-review/client.js": function(module, exports, require) {
// source: src/modules/code-review/client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubClient = exports.GitHubError = void 0;
exports.summary = summary;
exports.detail = detail;
exports.page = page;
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
function check(value) { const v = object(value); return { id: string(v.id), name: string(v.name), status: string(v.status), conclusion: nullableString(v.conclusion), description: string(v.description) }; }
function detail(value) { const v = object(value); return { ...summary(v), body: string(v.body), baseBranch: string(v.baseBranch), additions: number(v.additions), deletions: number(v.deletions), changedFiles: number(v.changedFiles), mergeable: nullableBool(v.mergeable), mergeableState: nullableString(v.mergeableState), files: list(v.files, file), comments: list(v.comments, comment), reviews: list(v.reviews, review), checks: list(v.checks, check), filesHasMore: bool(v.filesHasMore), commentsHasMore: bool(v.commentsHasMore), reviewsHasMore: bool(v.reviewsHasMore), checksTruncated: bool(v.checksTruncated), inlineCommentCount: number(v.inlineCommentCount), commentCount: number(v.commentCount) }; }
function page(v, parse) { const value = object(v); return { items: list(value.items, parse), hasMore: bool(value.hasMore) }; }
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
    constructor(factory) {
        this.factory = factory;
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
                            store.delete('snapshot');
                        else
                            store.put(value, 'snapshot');
                    }
                    else {
                        const request = store.get('snapshot');
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

}
};
const __dependencies = {"src/modules/code-review/index.js":{"./CodeReview.css":"src/modules/code-review/CodeReview.css","./client":"src/modules/code-review/client.js","./cache":"src/modules/code-review/cache.js","./storage":"src/modules/code-review/storage.js","./idle":"src/modules/code-review/idle.js","./data":"src/modules/code-review/data.js"},"src/modules/code-review/CodeReview.css":{},"src/modules/code-review/client.js":{},"src/modules/code-review/cache.js":{"./client":"src/modules/code-review/client.js","./idle":"src/modules/code-review/idle.js"},"src/modules/code-review/idle.js":{},"src/modules/code-review/storage.js":{},"src/modules/code-review/data.js":{}};
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
