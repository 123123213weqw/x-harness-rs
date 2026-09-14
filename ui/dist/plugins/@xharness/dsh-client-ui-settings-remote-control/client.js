// Generated from src/modules/settings-remote-control/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings-remote-control",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings-remote-control/index.js": function(module, exports, require) {
// source: src/modules/settings-remote-control/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const api_1 = require("./api");
const RemoteSettings_1 = require("./RemoteSettings");
const locales_1 = require("./locales");
exports.inject = ['slots', 'locale', 'connection'];
const NS = 'settings.remoteControl';
function sessionLabel(values, id) { if (typeof values === 'object' && values !== null && 'title' in values && typeof values.title === 'string' && values.title.trim())
    return values.title; return id; }
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'remote-control: dictionaries');
    const connection = ctx.get('connection'), api = (0, api_1.createAdminClient)(), t = ctx.locale.bind(NS);
    const catalog = async () => {
        const [workspaces, sessions] = await Promise.all([connection.api.workspace.list({}), connection.api.sessions.list({})]);
        if (!workspaces.result.ok || !sessions.result.ok)
            throw new api_1.AdminFailure('unavailable');
        const archived = new Set(workspaces.result.value.archivedSessionIds);
        return { workspaces: workspaces.result.value.items.map(w => ({ id: w.workspaceId, title: w.title, sessions: w.sessionIds.filter(s => !archived.has(s)) })), sessions: Object.fromEntries(sessions.result.value.items.map(s => [s.sessionId, sessionLabel(s.projections?.values, s.sessionId)])) };
    };
    const props = () => ({ t, local: connection.isLoopback, api, catalog });
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'remote-control', order: 35, label: () => t('nav'), locale: NS, inject: props }, RemoteSettings_1.RemoteSettings));
}

},
"src/modules/settings-remote-control/api.js": function(module, exports, require) {
// source: src/modules/settings-remote-control/api.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminFailure = void 0;
exports.decodeStatus = decodeStatus;
exports.decodeGrants = decodeGrants;
exports.decodeRecovery = decodeRecovery;
exports.decodeInbox = decodeInbox;
exports.validateMutation = validateMutation;
exports.createAdminClient = createAdminClient;
const ERRORS = ['not_enabled', 'unauthorized', 'forbidden', 'capacity', 'conflict', 'invalid_input', 'unconfigured_account', 'native_credentials_unavailable', 'cleanup_required', 'unavailable', 'invalid_response', 'connection_lost'];
class AdminFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
exports.AdminFailure = AdminFailure;
function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const record = (v) => { if (!isRecord(v))
    throw new AdminFailure('invalid_response'); return v; };
const string = (v) => { if (typeof v !== 'string' || !v.length || v.length > 512 || /[\u0000-\u001f\u007f]/u.test(v))
    throw new AdminFailure('invalid_response'); return v; };
const number = (v) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new AdminFailure('invalid_response'); return v; };
const bool = (v) => { if (typeof v !== 'boolean')
    throw new AdminFailure('invalid_response'); return v; };
const array = (v, max) => { if (!Array.isArray(v) || v.length > max)
    throw new AdminFailure('invalid_response'); return v.map((item) => item); };
const channel = (v) => { if (v === 'telegram' || v === 'feishu' || v === 'lark' || v === 'weixin' || v === 'mobile_web')
    return v; throw new AdminFailure('invalid_response'); };
const account = (v) => { const r = record(v); return { channel: channel(r.channel), id: string(r.id) }; };
function connection(v) { const r = record(v); if (r.state === 'failed')
    return { state: 'failed', reason: string(r.reason) }; if (r.state === 'disabled' || r.state === 'starting' || r.state === 'online' || r.state === 'stopped')
    return { state: r.state }; throw new AdminFailure('invalid_response'); }
function binding(v) { const r = record(v); return { id: string(r.id), principal: string(r.principal), conversation: string(r.conversation), workspace: string(r.workspace), session: string(r.session), generation: number(r.generation) }; }
function principal(v) { const r = record(v), s = record(r.sender); return { id: string(r.id), host: string(r.host), sender: { channel: channel(s.channel), account: string(s.account), user: string(s.user) }, workspaces: uniqueIds(r.workspaces, 256), sessions: uniqueIds(r.sessions, 4096), revision: number(r.revision), revoked: bool(r.revoked) }; }
function uniqueIds(v, max) { const ids = array(v, max).map(string); if (new Set(ids).size !== ids.length)
    throw new AdminFailure('invalid_response'); return ids; }
function creation(v, p) { const r = record(v), c = { principal: string(r.principal), principal_revision: number(r.principal_revision), generation: number(r.generation), workspaces: uniqueIds(r.workspaces, 256) }; if (c.principal !== p.id || c.principal_revision < 1 || c.principal_revision > p.revision || c.generation < 1 || (c.principal_revision === p.revision && c.workspaces.some(w => !p.workspaces.includes(w))))
    throw new AdminFailure('invalid_response'); return c; }
function decodeStatus(raw) { const r = record(raw), m = record(r.manager); const manager = m.state === 'dormant' || m.state === 'running' ? { state: m.state } : connection(m); return { host: string(r.host), manager, credential_cleanup_pending: bool(r.credential_cleanup_pending), accounts: array(r.accounts, 16).map((v) => { const a = record(v); return { account: account(a.account), revision: number(a.revision), enabled: bool(a.enabled), credential_reference_saved: bool(a.credential_reference_saved), connection: connection(a.connection) }; }) }; }
function decodeGrants(raw) { const r = record(raw); return { items: array(r.items, 25).map((v) => { const g = record(v), p = principal(g.principal), bindings = array(g.bindings, 32).map(binding); if (bindings.some(b => b.principal !== p.id))
        throw new AdminFailure('invalid_response'); return { principal: p, bindings, ...g.creation_policy === undefined ? {} : { creation_policy: creation(g.creation_policy, p) } }; }), next: r.next === null ? null : string(r.next) }; }
function decodeRecovery(raw) { const r = record(raw); return { items: array(r.items, 25).map((v) => { const e = record(v), s = record(e.sender), a = account(e.account), b = binding(e.binding), p = string(e.principal), sender = { channel: channel(s.channel), account: string(s.account), user: string(s.user) }; if (b.principal !== p || sender.channel !== a.channel || sender.account !== a.id)
        throw new AdminFailure('invalid_response'); return { key: string(e.key), sequence: number(e.sequence), account: a, sender, principal: p, binding: b, failure: e.failure === null ? null : string(e.failure), expected_message: e.expected_message === null ? null : string(e.expected_message) }; }), next: r.next === null ? null : number(r.next) }; }
const digest = (v) => { const s = string(v); if (!/^[0-9a-f]{64}$/.test(s))
    throw new AdminFailure('invalid_response'); return s; };
function inboxIdentity(raw) { const r = record(raw), b = binding(r.binding), identity = { key: string(r.key), sequence: number(r.sequence), principal: string(r.principal), principal_revision: number(r.principal_revision), binding: b, identity_sha256: digest(r.identity_sha256) }; if (identity.sequence < 1 || identity.principal_revision < 1 || b.generation < 1 || b.principal !== identity.principal)
    throw new AdminFailure('invalid_response'); return identity; }
function inboxCommand(v) { if (v === 'prompt' || v === 'cancel' || v === 'history' || v === 'catalogue' || v === 'select' || v === 'create_session' || v === 'automation_read' || v === 'automation_control' || v === 'answer_interaction')
    return v; throw new AdminFailure('invalid_response'); }
function decodeInbox(raw, after = 0) {
    const r = record(raw), items = array(r.items, 25).map((v) => {
        const e = record(v), identity = inboxIdentity(e.identity), command = inboxCommand(e.command), allowed = bool(e.observed_accepted_allowed);
        let interaction = null;
        if (e.interaction === 'approval' || e.interaction === 'question')
            interaction = e.interaction;
        else if (e.interaction !== null)
            throw new AdminFailure('invalid_response');
        if ((command === 'answer_interaction') !== (interaction !== null) || allowed !== (command !== 'create_session' && command !== 'automation_control'))
            throw new AdminFailure('invalid_response');
        return { identity, command, interaction, observed_accepted_allowed: allowed };
    }), next = r.next === null ? null : number(r.next);
    if (!Number.isSafeInteger(after) || after < 0 || items.some((e, index) => e.identity.sequence <= (items[index - 1]?.identity.sequence ?? after)) || new Set(items.map(e => e.identity.key)).size !== items.length || (next !== null && (items.length !== 25 || next !== items.at(-1)?.identity.sequence)))
        throw new AdminFailure('invalid_response');
    return { items, next };
}
function validateMutation(action, raw) {
    const r = record(raw), invalid = () => { throw new AdminFailure('invalid_response'); };
    const sameAccount = (actual, wanted) => { const a = account(actual); if (a.channel !== wanted.channel || a.id !== wanted.id)
        invalid(); };
    switch (action.type) {
        case 'configure_telegram':
            sameAccount(r.account, { channel: 'telegram', id: action.bot_id });
            if (number(r.revision) !== action.expected_revision + 1)
                invalid();
            bool(r.credential_cleanup_pending);
            break;
        case 'set_enabled':
            sameAccount(r.account, action.account);
            if (number(r.revision) !== action.expected_revision + 1 || bool(r.enabled) !== action.enabled)
                invalid();
            break;
        case 'grant': {
            const entry = decodeGrants({ items: [raw], next: null }).items[0];
            if (!entry)
                throw new AdminFailure('invalid_response');
            const p = entry.principal, b = entry.bindings[0];
            if (!b)
                throw new AdminFailure('invalid_response');
            if (entry.bindings.length !== 1 || p.revoked || p.sender.channel !== action.account.channel || p.sender.account !== action.account.id || p.sender.user !== action.user || p.workspaces.length !== 1 || p.workspaces[0] !== action.workspace || p.sessions.length !== 1 || p.sessions[0] !== action.session || b.workspace !== action.workspace || b.session !== action.session || b.conversation !== action.user)
                invalid();
            if (action.expected) {
                if (p.id !== action.expected.principal || p.revision !== action.expected.revision + 1 || b.id !== action.expected.binding || b.generation !== action.expected.generation + 1)
                    invalid();
            }
            else if (p.revision !== 1 || b.generation !== 1)
                invalid();
            break;
        }
        case 'grant_scopes': {
            const entry = decodeGrants({ items: [raw], next: null }).items[0];
            if (!entry)
                throw new AdminFailure('invalid_response');
            const p = entry.principal, b = entry.bindings[0], c = entry.creation_policy;
            if (!b || !c)
                throw new AdminFailure('invalid_response');
            const sameIds = (actual, wanted) => { const ids = uniqueIds(wanted, 4096); return actual.length === ids.length && actual.every(id => ids.includes(id)); };
            if (entry.bindings.length !== 1 || p.revoked || p.sender.channel !== action.account.channel || p.sender.account !== action.account.id || p.sender.user !== action.user || !sameIds(p.workspaces, action.workspaces) || !sameIds(p.sessions, action.sessions) || b.workspace !== action.workspace || b.session !== action.session || b.conversation !== action.user || !p.workspaces.includes(b.workspace) || !p.sessions.includes(b.session) || !sameIds(c.workspaces, action.create_workspaces) || c.principal_revision !== p.revision || c.generation !== (action.expected_creation_generation ?? 0) + 1)
                invalid();
            if (action.expected) {
                if (p.id !== action.expected.principal || p.revision !== action.expected.revision + 1 || b.id !== action.expected.binding || b.generation !== action.expected.generation + 1)
                    invalid();
            }
            else if (p.revision !== 1 || b.generation !== 1)
                invalid();
            break;
        }
        case 'revoke':
            if (bool(r.revoked) !== true || string(r.principal) !== action.principal)
                invalid();
            break;
        case 'cleanup_credentials':
            bool(r.credential_cleanup_pending);
            break;
        case 'resolve_inbox': {
            const expected = inboxIdentity(action.expected), identity = inboxIdentity(r.identity), a = record(r.audit), review = record(a.review);
            if (JSON.stringify(identity) !== JSON.stringify(expected) || number(a.sequence) < 1 || a.previous !== 'uncertain' || string(review.delivery_key) !== expected.key || review.actor !== 'authenticated-desktop' || digest(review.evidence_sha256) !== action.evidence_sha256 || review.resolution !== action.resolution || a.current !== (action.resolution === 'observed_accepted' ? 'completed' : action.resolution === 'verified_not_applied' ? 'rejected' : 'abandoned'))
                invalid();
            break;
        }
        case 'resolve_reply': {
            const review = record(r.review), resolution = record(review.resolution);
            if (number(r.sequence) < 1 || r.previous !== 'uncertain' || string(review.key) !== action.key || review.actor !== 'authenticated-desktop' || review.evidence_sha256 !== action.evidence_sha256 || resolution.type !== action.resolution.type)
                invalid();
            if (action.resolution.type === 'observed_delivered') {
                if (r.current !== 'delivered' || string(record(resolution.receipt).message_id) !== action.resolution.receipt.message_id)
                    invalid();
            }
            else if (r.current !== (action.resolution.type === 'verified_not_sent' ? 'rejected' : 'abandoned'))
                invalid();
            break;
        }
    }
}
function createAdminClient(fetcher = globalThis.fetch) {
    async function request(action) {
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 75000);
        try {
            const response = await fetcher('/api/remote-control/manage', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json', 'x-xharness-remote-admin': 'v1' }, body: JSON.stringify(action), signal: abort.signal });
            if (response.status === 404)
                throw new AdminFailure('not_enabled');
            if (response.status === 401)
                throw new AdminFailure('unauthorized');
            if (response.status === 403)
                throw new AdminFailure('forbidden');
            if (response.status === 413)
                throw new AdminFailure('capacity');
            // A bounded reader never trusts response Content-Length or unscoped text.
            const reader = response.body?.getReader();
            if (!reader)
                throw new AdminFailure('invalid_response');
            const chunks = [];
            let size = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    size += part.value.byteLength;
                    if (size > 8 * 1024 * 1024) {
                        await reader.cancel();
                        throw new AdminFailure('capacity');
                    }
                    chunks.push(part.value);
                }
            }
            finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const c of chunks) {
                bytes.set(c, offset);
                offset += c.length;
            }
            let raw;
            try {
                raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            }
            catch {
                throw new AdminFailure('invalid_response');
            }
            const envelope = record(raw);
            if (!response.ok || envelope.ok !== true) {
                const code = record(envelope.error).code;
                throw new AdminFailure(ERRORS.find(known => known === code) ?? 'unavailable');
            }
            return envelope.value;
        }
        catch (error) {
            if (error instanceof AdminFailure)
                throw error;
            throw new AdminFailure('connection_lost');
        }
        finally {
            clearTimeout(timer);
        }
    }
    return { status: async () => decodeStatus(await request({ type: 'status' })), grants: async (after) => decodeGrants(await request(after === undefined ? { type: 'grants' } : { type: 'grants', after })), recovery: async (after = 0) => decodeRecovery(await request({ type: 'uncertain_replies', after })), inboxRecovery: async (after = 0) => decodeInbox(await request({ type: 'uncertain_inbox', after }), after), mutate: async (action) => { validateMutation(action, await request(action)); } };
}

},
"src/modules/settings-remote-control/RemoteSettings.js": function(module, exports, require) {
// source: src/modules/settings-remote-control/RemoteSettings.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteSettings = RemoteSettings;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const api_1 = require("./api");
require("./styles");
const toggle = (values, id) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];
const union = (...values) => [...new Set(values.flat())].sort();
const numeric = (s) => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n;
function RemoteSettings({ t, local, api, catalog }) {
    const [status, setStatus] = (0, react_1.useState)(), [grants, setGrants] = (0, react_1.useState)([]), [moreGrants, setMoreGrants] = (0, react_1.useState)(null);
    const [recovery, setRecovery] = (0, react_1.useState)([]), [moreRecovery, setMoreRecovery] = (0, react_1.useState)(null), [places, setPlaces] = (0, react_1.useState)();
    const [inbox, setInbox] = (0, react_1.useState)([]), [moreInbox, setMoreInbox] = (0, react_1.useState)(null), [inboxReview, setInboxReview] = (0, react_1.useState)(), [inboxResolution, setInboxResolution] = (0, react_1.useState)('abandon_without_replay'), [inboxEvidence, setInboxEvidence] = (0, react_1.useState)('');
    const [issue, setIssue] = (0, react_1.useState)(), [mutationIssue, setMutationIssue] = (0, react_1.useState)(), [notice, setNotice] = (0, react_1.useState)(false), [noticeKind, setNoticeKind] = (0, react_1.useState)('saved'), [busy, setBusy] = (0, react_1.useState)(false), [loading, setLoading] = (0, react_1.useState)(true);
    const [bot, setBot] = (0, react_1.useState)(''), [token, setToken] = (0, react_1.useState)(''), [enabled, setEnabled] = (0, react_1.useState)(false);
    const [grantAccount, setGrantAccount] = (0, react_1.useState)(''), [user, setUser] = (0, react_1.useState)(''), [workspace, setWorkspace] = (0, react_1.useState)(''), [session, setSession] = (0, react_1.useState)(''), [expected, setExpected] = (0, react_1.useState)();
    const [allowedWorkspaces, setAllowedWorkspaces] = (0, react_1.useState)([]), [allowedSessions, setAllowedSessions] = (0, react_1.useState)([]), [createWorkspaces, setCreateWorkspaces] = (0, react_1.useState)([]), [creationGeneration, setCreationGeneration] = (0, react_1.useState)(null);
    const [review, setReview] = (0, react_1.useState)(), [resolution, setResolution] = (0, react_1.useState)('abandon_without_replay'), [evidence, setEvidence] = (0, react_1.useState)(''), [message, setMessage] = (0, react_1.useState)('');
    const live = (0, react_1.useRef)(false), reading = (0, react_1.useRef)(0), working = (0, react_1.useRef)(false), knownPlaces = (0, react_1.useRef)();
    const fail = (error) => error instanceof api_1.AdminFailure ? error.code : 'unavailable';
    async function load(full = true) {
        if (!local)
            return;
        const generation = ++reading.current;
        try {
            const next = await api.status();
            if (!full && knownPlaces.current) {
                if (live.current && generation === reading.current) {
                    setStatus(next);
                    setIssue(undefined);
                }
                return;
            }
            const [scopes, uncertain, unknown, known] = await Promise.all([api.grants(), api.recovery(), api.inboxRecovery(), catalog()]);
            if (!live.current || generation !== reading.current)
                return;
            setStatus(next);
            setGrants(scopes.items);
            setMoreGrants(scopes.next);
            setRecovery(uncertain.items);
            setMoreRecovery(uncertain.next);
            setInbox(unknown.items);
            setMoreInbox(unknown.next);
            knownPlaces.current = known;
            setPlaces(known);
            setIssue(undefined);
        }
        catch (error) {
            if (live.current && generation === reading.current)
                setIssue(fail(error));
        }
        finally {
            if (live.current && generation === reading.current)
                setLoading(false);
        }
    }
    (0, react_1.useEffect)(() => {
        live.current = true;
        if (local)
            void load();
        else
            setLoading(false);
        const poll = setInterval(() => { if (!working.current)
            void load(false); }, 2500);
        return () => { live.current = false; reading.current++; clearInterval(poll); };
    }, [api, catalog, local]);
    async function mutate(action) {
        if (working.current)
            return false;
        working.current = true;
        reading.current++;
        setBusy(true);
        setNotice(false);
        setIssue(undefined);
        setMutationIssue(undefined);
        try {
            await api.mutate(action);
            if (live.current) {
                setNoticeKind(action.type === 'resolve_inbox' ? 'inboxRecorded' : 'saved');
                setNotice(true);
                await load();
            }
            return true;
        }
        catch (error) {
            if (live.current)
                setMutationIssue(fail(error));
            return false;
        }
        finally {
            working.current = false;
            if (live.current)
                setBusy(false);
        }
    }
    const selected = status?.accounts.find(a => a.account.channel === 'telegram' && a.account.id === bot);
    const workspaceSessions = places?.workspaces.find(w => w.id === workspace)?.sessions ?? [];
    function saveCredential(event) { event.preventDefault(); const secret = token; setToken(''); void mutate({ type: 'configure_telegram', bot_id: bot, expected_revision: selected?.revision ?? 0, enabled, token: secret }); }
    function saveGrant(event) { event.preventDefault(); void mutate({ type: 'grant_scopes', account: { channel: 'telegram', id: grantAccount }, user, workspace, session, workspaces: union(allowedWorkspaces, createWorkspaces, [workspace]), sessions: union(allowedSessions, [session]), create_workspaces: createWorkspaces, expected_creation_generation: creationGeneration, ...expected === undefined ? {} : { expected } }).then(saved => { if (saved && live.current) {
        setExpected(undefined);
        setUser('');
        setSession('');
        setAllowedWorkspaces([]);
        setAllowedSessions([]);
        setCreateWorkspaces([]);
        setCreationGeneration(null);
    } }); }
    function edit(entry) { const b = entry.bindings[0]; if (!b)
        return; setGrantAccount(entry.principal.sender.account); setUser(entry.principal.sender.user); setWorkspace(b.workspace); setSession(b.session); setAllowedWorkspaces(entry.principal.workspaces); setAllowedSessions(entry.principal.sessions); setCreateWorkspaces(entry.creation_policy?.principal_revision === entry.principal.revision ? entry.creation_policy.workspaces : []); setCreationGeneration(entry.creation_policy?.generation ?? null); setExpected({ principal: entry.principal.id, revision: entry.principal.revision, binding: b.id, generation: b.generation }); }
    function chooseAccount(account) { setBot(account.account.id); setToken(''); setEnabled(account.enabled); }
    async function loadMore(kind) {
        if (working.current)
            return;
        working.current = true;
        reading.current++;
        setBusy(true);
        try {
            if (kind === 'grants' && moreGrants) {
                const page = await api.grants(moreGrants);
                if (live.current) {
                    setGrants(current => [...current, ...page.items.filter(e => !current.some(c => c.principal.id === e.principal.id))]);
                    setMoreGrants(page.next);
                }
            }
            if (kind === 'inbox' && moreInbox !== null) {
                const page = await api.inboxRecovery(moreInbox);
                if (live.current) {
                    setInbox(current => [...current, ...page.items.filter(e => !current.some(c => c.identity.key === e.identity.key))]);
                    setMoreInbox(page.next);
                }
            }
            if (kind === 'recovery' && moreRecovery !== null) {
                const page = await api.recovery(moreRecovery);
                if (live.current) {
                    setRecovery(current => [...current, ...page.items.filter(e => !current.some(c => c.key === e.key))]);
                    setMoreRecovery(page.next);
                }
            }
        }
        catch (error) {
            if (live.current)
                setIssue(fail(error));
        }
        finally {
            working.current = false;
            if (live.current)
                setBusy(false);
        }
    }
    const visibleIssue = mutationIssue ?? issue;
    if (!local)
        return (0, jsx_runtime_1.jsxs)("section", { className: "xr_remoteRoot", children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("p", { children: t('localOnly') })] });
    return (0, jsx_runtime_1.jsxs)("section", { className: "xr_remoteRoot", "aria-busy": busy || loading, children: [(0, jsx_runtime_1.jsxs)("header", { className: "xr_remoteHeader", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("p", { children: t('subtitle') })] }), (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => { setLoading(true); setMutationIssue(undefined); setNotice(false); void load(); }, children: t('refresh') })] }), loading && (0, jsx_runtime_1.jsx)("p", { role: "status", children: t('loading') }), visibleIssue && (0, jsx_runtime_1.jsx)("p", { className: "xr_remoteMessage", role: "alert", children: t(visibleIssue) }), notice && (0, jsx_runtime_1.jsx)("p", { role: "status", children: t(noticeKind) }), status && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("p", { className: "xr_remoteMeta", children: [t('manager'), ": ", t(status.manager.state), " \u00B7 Host ", (0, jsx_runtime_1.jsx)("code", { children: status.host })] }), status.credential_cleanup_pending && (0, jsx_runtime_1.jsxs)("div", { className: "xr_remoteMessage", children: [(0, jsx_runtime_1.jsx)("p", { children: t('cleanupPending') }), (0, jsx_runtime_1.jsx)("button", { disabled: busy, onClick: () => void mutate({ type: 'cleanup_credentials' }), children: t('cleanup') })] }), (0, jsx_runtime_1.jsxs)("fieldset", { disabled: busy, children: [(0, jsx_runtime_1.jsx)("legend", { children: t('accounts') }), !status.accounts.length && (0, jsx_runtime_1.jsx)("p", { children: t('emptyAccounts') }), (0, jsx_runtime_1.jsx)("ul", { className: "xr_remoteList", children: status.accounts.map(a => (0, jsx_runtime_1.jsxs)("li", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("strong", { children: [a.account.channel, " \u00B7 ", a.account.id] }), (0, jsx_runtime_1.jsxs)("p", { children: [t(a.connection.state), " \u00B7 ", t('revision'), " ", a.revision] }), a.connection.state === 'failed' && (0, jsx_runtime_1.jsx)("p", { children: t(a.connection.reason === 'native_credential_unavailable' ? 'native_credentials_unavailable' : a.connection.reason === 'invalid_credentials' ? 'invalid_input' : 'unavailable') })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xr_remoteActions", children: [(0, jsx_runtime_1.jsx)("button", { disabled: a.account.channel !== 'telegram', onClick: () => chooseAccount(a), children: t('rotate') }), (0, jsx_runtime_1.jsx)("button", { onClick: () => void mutate({ type: 'set_enabled', account: a.account, expected_revision: a.revision, enabled: !a.enabled }), children: t(a.enabled ? 'disable' : 'enable') })] })] }, a.account.channel + ':' + a.account.id)) }), (0, jsx_runtime_1.jsxs)("form", { onSubmit: saveCredential, className: "xr_remoteForm", children: [(0, jsx_runtime_1.jsxs)("label", { children: [t('botId'), (0, jsx_runtime_1.jsx)("input", { "aria-label": t('botId'), inputMode: "numeric", value: bot, onChange: e => { setBot(e.target.value); setToken(''); }, required: true })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('token'), (0, jsx_runtime_1.jsx)("input", { "aria-label": t('token'), type: "password", autoComplete: "off", spellCheck: false, value: token, onChange: e => setToken(e.target.value), maxLength: 256, required: true })] }), (0, jsx_runtime_1.jsx)("small", { children: t('tokenHint') }), (0, jsx_runtime_1.jsxs)("label", { className: "xr_remoteCheck", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: enabled, onChange: e => setEnabled(e.target.checked) }), t('enabled')] }), (0, jsx_runtime_1.jsx)("button", { type: "submit", disabled: !numeric(bot) || !token, children: t('save') })] })] }), (0, jsx_runtime_1.jsxs)("fieldset", { disabled: busy, children: [(0, jsx_runtime_1.jsx)("legend", { children: t('grants') }), (0, jsx_runtime_1.jsx)("p", { children: t('scopeHint') }), !grants.length && (0, jsx_runtime_1.jsx)("p", { children: t('emptyGrants') }), (0, jsx_runtime_1.jsx)("ul", { className: "xr_remoteList", children: grants.map(e => (0, jsx_runtime_1.jsxs)("li", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("strong", { children: [e.principal.sender.channel, " \u00B7 ", e.principal.sender.account, " / ", e.principal.sender.user] }), (0, jsx_runtime_1.jsx)("p", { children: e.principal.revoked ? t('revoked') : e.bindings.map(b => (places?.workspaces.find(w => w.id === b.workspace)?.title ?? b.workspace) + ' / ' + (places?.sessions[b.session] ?? b.session)).join(' · ') }), (0, jsx_runtime_1.jsxs)("small", { children: [t('revision'), " ", e.principal.revision, " \u00B7 ", e.principal.sessions.length, " ", t('allowedSessions'), " \u00B7 ", e.creation_policy?.principal_revision === e.principal.revision && e.creation_policy.workspaces.length ? t('createAllowed') : t('createDisabled')] })] }), !e.principal.revoked && (0, jsx_runtime_1.jsxs)("div", { className: "xr_remoteActions", children: [(0, jsx_runtime_1.jsx)("button", { disabled: e.principal.sender.channel !== 'telegram' || e.bindings.length !== 1, onClick: () => edit(e), children: t('editScope') }), (0, jsx_runtime_1.jsx)("button", { onClick: () => { if (globalThis.confirm(t('confirmRevoke')))
                                                        void mutate({ type: 'revoke', principal: e.principal.id }); }, children: t('revoke') })] })] }, e.principal.id)) }), moreGrants && (0, jsx_runtime_1.jsx)("button", { onClick: () => void loadMore('grants'), children: t('more') }), (0, jsx_runtime_1.jsxs)("form", { onSubmit: saveGrant, className: "xr_remoteForm", children: [(0, jsx_runtime_1.jsxs)("label", { children: [t('account'), (0, jsx_runtime_1.jsxs)("select", { "aria-label": t('account'), value: grantAccount, disabled: expected !== undefined, onChange: e => setGrantAccount(e.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: t('choose') }), status.accounts.filter(a => a.account.channel === 'telegram').map(a => (0, jsx_runtime_1.jsxs)("option", { value: a.account.id, children: ["Telegram ", a.account.id] }, a.account.id))] })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('userId'), (0, jsx_runtime_1.jsx)("input", { "aria-label": t('userId'), inputMode: "numeric", value: user, disabled: expected !== undefined, onChange: e => setUser(e.target.value), required: true })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('workspace'), (0, jsx_runtime_1.jsxs)("select", { "aria-label": t('workspace'), value: workspace, onChange: e => { setWorkspace(e.target.value); setSession(''); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: t('choose') }), places?.workspaces.map(w => (0, jsx_runtime_1.jsx)("option", { value: w.id, children: w.title }, w.id))] })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('session'), (0, jsx_runtime_1.jsxs)("select", { "aria-label": t('session'), value: session, onChange: e => setSession(e.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: t('choose') }), workspaceSessions.map(s => (0, jsx_runtime_1.jsx)("option", { value: s, children: places?.sessions[s] ?? s }, s))] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xr_remoteScopes", children: [(0, jsx_runtime_1.jsx)("h3", { children: t('allowedScopes') }), (0, jsx_runtime_1.jsx)("p", { children: t('createHint') }), places?.workspaces.map(w => (0, jsx_runtime_1.jsxs)("div", { className: "xr_remoteScope", children: [(0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", "aria-label": t('allowWorkspace') + ' ' + w.title, checked: w.id === workspace || allowedWorkspaces.includes(w.id) || createWorkspaces.includes(w.id), disabled: w.id === workspace || createWorkspaces.includes(w.id) || w.sessions.some(s => s === session || allowedSessions.includes(s)), onChange: () => setAllowedWorkspaces(current => toggle(current, w.id)) }), w.title] }), (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", "aria-label": t('allowCreate') + ' ' + w.title, checked: createWorkspaces.includes(w.id), onChange: () => setCreateWorkspaces(current => toggle(current, w.id)) }), t('allowCreate')] }), w.sessions.map(s => (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", "aria-label": t('allowSession') + ' ' + (places?.sessions[s] ?? s), checked: s === session || allowedSessions.includes(s), disabled: s === session, onChange: () => { setAllowedSessions(current => toggle(current, s)); if (!allowedSessions.includes(s))
                                                                    setAllowedWorkspaces(current => union(current, [w.id])); } }), places?.sessions[s] ?? s] }, s))] }, w.id)), allowedWorkspaces.filter(w => !places?.workspaces.some(known => known.id === w)).map(w => (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: true, disabled: w === workspace || createWorkspaces.includes(w), onChange: () => setAllowedWorkspaces(current => toggle(current, w)) }), t('unavailableScope'), ": ", w] }, w)), createWorkspaces.filter(w => !places?.workspaces.some(known => known.id === w)).map(w => (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: true, onChange: () => setCreateWorkspaces(current => toggle(current, w)) }), t('allowCreate'), " \u00B7 ", t('unavailableScope'), ": ", w] }, 'create:' + w)), allowedSessions.filter(s => !places?.workspaces.some(w => w.sessions.includes(s))).map(s => (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: true, disabled: s === session, onChange: () => setAllowedSessions(current => toggle(current, s)) }), t('unavailableScope'), ": ", s] }, s))] }), (0, jsx_runtime_1.jsx)("button", { type: "submit", disabled: !grantAccount || !numeric(user) || !workspaceSessions.includes(session), children: t('grant') }), expected && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { setExpected(undefined); setUser(''); setSession(''); setAllowedWorkspaces([]); setAllowedSessions([]); setCreateWorkspaces([]); setCreationGeneration(null); }, children: t('choose') })] })] }), (0, jsx_runtime_1.jsxs)("fieldset", { disabled: busy, children: [(0, jsx_runtime_1.jsx)("legend", { children: t('inboxRecovery') }), (0, jsx_runtime_1.jsx)("p", { children: t('inboxHint') }), !inbox.length && (0, jsx_runtime_1.jsx)("p", { children: t('emptyInbox') }), (0, jsx_runtime_1.jsx)("ul", { className: "xr_remoteList", children: inbox.map(r => (0, jsx_runtime_1.jsxs)("li", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("strong", { children: t('command_' + r.command) }), (0, jsx_runtime_1.jsxs)("p", { children: [t('principalId'), ": ", (0, jsx_runtime_1.jsx)("code", { children: r.identity.principal }), " \u00B7 ", t('revision'), " ", r.identity.principal_revision] }), (0, jsx_runtime_1.jsxs)("p", { children: [t('workspace'), ": ", r.identity.binding.workspace, " \u00B7 ", t('sessionId'), ": ", r.identity.binding.session, " \u00B7 ", t('bindingGeneration'), " ", r.identity.binding.generation] }), r.interaction && (0, jsx_runtime_1.jsx)("p", { children: t('interactionSealed') }), !r.observed_accepted_allowed && (0, jsx_runtime_1.jsx)("p", { children: t('originalProofRequired') }), (0, jsx_runtime_1.jsx)("code", { children: r.identity.key })] }), (0, jsx_runtime_1.jsx)("button", { onClick: () => { setInboxReview(r); setInboxEvidence(''); setInboxResolution('abandon_without_replay'); }, children: t('reviewInbox') })] }, r.identity.key)) }), moreInbox !== null && (0, jsx_runtime_1.jsx)("button", { onClick: () => void loadMore('inbox'), children: t('moreInbox') }), inboxReview && (0, jsx_runtime_1.jsxs)("form", { className: "xr_remoteForm", onSubmit: e => { e.preventDefault(); if (!globalThis.confirm(t('confirmInbox')))
                                    return; void mutate({ type: 'resolve_inbox', expected: inboxReview.identity, evidence_sha256: inboxEvidence, resolution: inboxResolution }).then(saved => { if (saved && live.current)
                                    setInboxReview(undefined); }); }, children: [(0, jsx_runtime_1.jsx)("code", { children: inboxReview.identity.key }), (0, jsx_runtime_1.jsxs)("label", { children: [t('inboxResolution'), (0, jsx_runtime_1.jsxs)("select", { "aria-label": t('inboxResolution'), value: inboxResolution, onChange: e => { const v = e.target.value; if (v === 'abandon_without_replay' || v === 'verified_not_applied' || (v === 'observed_accepted' && inboxReview.observed_accepted_allowed))
                                                    setInboxResolution(v); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "abandon_without_replay", children: t('abandonInbox') }), (0, jsx_runtime_1.jsx)("option", { value: "verified_not_applied", children: t('notApplied') }), inboxReview.observed_accepted_allowed && (0, jsx_runtime_1.jsx)("option", { value: "observed_accepted", children: t('observedAccepted') })] })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('inboxEvidence'), (0, jsx_runtime_1.jsx)("input", { "aria-label": t('inboxEvidence'), value: inboxEvidence, onChange: e => setInboxEvidence(e.target.value), maxLength: 64, spellCheck: false })] }), (0, jsx_runtime_1.jsx)("button", { type: "submit", disabled: !/^[0-9a-f]{64}$/.test(inboxEvidence), children: t('recordInbox') }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setInboxReview(undefined), children: t('cancelReview') })] })] }), (0, jsx_runtime_1.jsxs)("fieldset", { disabled: busy, children: [(0, jsx_runtime_1.jsx)("legend", { children: t('recovery') }), (0, jsx_runtime_1.jsx)("p", { children: t('recoveryHint') }), !recovery.length && (0, jsx_runtime_1.jsx)("p", { children: t('emptyRecovery') }), (0, jsx_runtime_1.jsx)("ul", { className: "xr_remoteList", children: recovery.map(r => (0, jsx_runtime_1.jsxs)("li", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("strong", { children: [r.account.channel, " \u00B7 ", r.account.id, " / ", r.sender.user] }), (0, jsx_runtime_1.jsxs)("p", { children: [t('sessionId'), ": ", r.binding.session] }), (0, jsx_runtime_1.jsx)("code", { children: r.key })] }), (0, jsx_runtime_1.jsx)("button", { onClick: () => { setReview(r); setEvidence(''); setMessage(''); setResolution('abandon_without_replay'); }, children: t('resolve') })] }, r.key)) }), moreRecovery !== null && (0, jsx_runtime_1.jsx)("button", { onClick: () => void loadMore('recovery'), children: t('more') }), review && (0, jsx_runtime_1.jsxs)("form", { className: "xr_remoteForm", onSubmit: e => { e.preventDefault(); if (!globalThis.confirm(t('confirmResolve')))
                                    return; void mutate({ type: 'resolve_reply', key: review.key, evidence_sha256: evidence, resolution: resolution === 'observed_delivered' ? { type: resolution, receipt: { message_id: message } } : { type: resolution } }).then(saved => { if (saved && live.current)
                                    setReview(undefined); }); }, children: [(0, jsx_runtime_1.jsx)("code", { children: review.key }), (0, jsx_runtime_1.jsxs)("label", { children: [t('resolution'), (0, jsx_runtime_1.jsxs)("select", { value: resolution, onChange: e => { const value = e.target.value; if (value === 'observed_delivered' || value === 'verified_not_sent' || value === 'abandon_without_replay')
                                                    setResolution(value); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "abandon_without_replay", children: t('abandon') }), (0, jsx_runtime_1.jsx)("option", { value: "verified_not_sent", children: t('notSent') }), (0, jsx_runtime_1.jsx)("option", { value: "observed_delivered", children: t('observed') })] })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('evidence'), (0, jsx_runtime_1.jsx)("input", { "aria-label": t('evidence'), value: evidence, onChange: e => setEvidence(e.target.value), maxLength: 64, spellCheck: false })] }), resolution === 'observed_delivered' && (0, jsx_runtime_1.jsxs)("label", { children: [t('messageId'), (0, jsx_runtime_1.jsx)("input", { value: message, onChange: e => setMessage(e.target.value), maxLength: 512 })] }), (0, jsx_runtime_1.jsx)("button", { disabled: !/^[0-9a-f]{64}$/.test(evidence) || (resolution === 'observed_delivered' && !message), children: t('resolve') })] })] }), (0, jsx_runtime_1.jsxs)("fieldset", { children: [(0, jsx_runtime_1.jsx)("legend", { children: t('otherChannels') }), (0, jsx_runtime_1.jsx)("p", { children: "Mobile Web \u00B7 Weixin iLink \u00B7 Feishu \u00B7 Lark" }), (0, jsx_runtime_1.jsx)("small", { children: t('notImplemented') })] })] })] });
}

},
"src/modules/settings-remote-control/styles.js": function(module, exports, require) {
// source: src/modules/settings-remote-control/styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const RemoteSettings_css_1 = __importDefault(require("./RemoteSettings.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/dsh-client-ui-settings-remote-control/RemoteSettings.css', '@xharness/dsh-client-ui-settings-remote-control', RemoteSettings_css_1.default);

},
"src/modules/settings-remote-control/RemoteSettings.css": function(module, exports, require) {
// source: src/modules/settings-remote-control/RemoteSettings.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xr_remoteRoot{display:flex;flex-direction:column;gap:16px;width:100%;max-width:780px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.xr_remoteRoot h2{font-size:18px;margin:0 0 6px}.xr_remoteRoot p{margin:4px 0;overflow-wrap:anywhere}.xr_remoteHeader{display:flex;gap:14px;align-items:flex-start;justify-content:space-between}.xr_remoteHeader p,.xr_remoteMeta,.xr_remoteRoot small{opacity:.7}.xr_remoteRoot button,.xr_remoteRoot input,.xr_remoteRoot select{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:7px;min-height:36px;padding:7px 10px;box-sizing:border-box}.xr_remoteRoot button{cursor:pointer;flex-shrink:0}.xr_remoteRoot button:disabled,.xr_remoteRoot input:disabled,.xr_remoteRoot select:disabled{opacity:.5;cursor:default}.xr_remoteRoot :is(button,input,select):focus-visible{outline:2px solid currentColor;outline-offset:2px}.xr_remoteRoot fieldset{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px}.xr_remoteRoot legend{padding:0 6px;font-weight:600}.xr_remoteMessage{border-inline-start:3px solid currentColor;padding:6px 12px;background:var(--dsw-alias-bg-layer-1)}.xr_remoteForm{display:flex;flex-direction:column;gap:10px;margin-top:12px;max-width:500px}.xr_remoteForm label{display:flex;flex-direction:column;gap:5px}.xr_remoteForm button{align-self:flex-start}.xr_remoteForm .xr_remoteCheck{flex-direction:row;align-items:center}.xr_remoteCheck input{min-height:0;width:16px;height:16px;accent-color:var(--dsw-alias-label-primary)}.xr_remoteList{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}.xr_remoteList li{display:flex;gap:14px;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 0}.xr_remoteList li>div:first-child{min-width:0}.xr_remoteActions{display:flex;gap:6px;flex-wrap:wrap}.xr_remoteRoot code{font-size:11px;overflow-wrap:anywhere;word-break:break-word}@media(max-width:640px){.xr_remoteHeader,.xr_remoteList li{flex-direction:column}.xr_remoteRoot fieldset{padding:10px}.xr_remoteActions{width:100%}.xr_remoteForm{max-width:none}}@media(prefers-reduced-motion:reduce){.xr_remoteRoot *{transition:none!important}}\n/* WebKit native selects ignore minimum height unless appearance is owned. */\n.xr_remoteRoot select{appearance:none;padding-right:30px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m2 4 4 4 4-4' fill='none' stroke='%23777' stroke-width='1.5'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 10px center;background-size:12px 12px}.xr_remoteRoot option{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}\n\n.xr_remoteScopes{display:grid;gap:12px}.xr_remoteScopes h3{margin:4px 0;font-size:14px}.xr_remoteScope{padding:12px;border:1px solid var(--dsw-alias-border-l2);display:grid;gap:4px}.xr_remoteForm .xr_remoteScopes label{display:flex;flex-direction:row;align-items:center;gap:8px;min-height:36px;overflow-wrap:anywhere}.xr_remoteScopes input[type=checkbox]{flex:0 0 16px;width:16px;height:16px;min-height:0;padding:0;accent-color:var(--dsw-alias-label-primary)}\n";

},
"src/modules/views-types.js": function(module, exports, require) {
// source: src/modules/views-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classNames = classNames;
exports.installStyles = installStyles;
function classNames(...values) { return values.filter(Boolean).join(' '); }
/** Exact legacy style identity, but editable source rather than compiled input. */
function installStyles(id, plugin, css) {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = plugin;
    tag.dataset.pluginCss = id;
    tag.textContent = css;
    document.head.appendChild(tag);
}

},
"src/modules/settings-remote-control/locales.js": function(module, exports, require) {
// source: src/modules/settings-remote-control/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
exports.zh = { inboxRecorded: '请求核验已记录。未重放或取消原生任务；旧交互仍封存。', inboxRecovery: "收件箱不确定结果", inboxHint: "仅显示请求身份与类型，不显示正文、答案或交互句柄。请依据原生会话记录核验；记录结论不会重跑请求，也不会重新启用旧交互。", emptyInbox: "没有待核验的不确定请求。", principalId: "控制者 ID", bindingGeneration: "绑定版本", interactionSealed: "此交互实例已封存；所有核验结论均保持旧句柄不可重用。", originalProofRequired: "成功结果只能由原始原生回执恢复；手工结论不能授予新会话或确认自动化控制。", reviewInbox: "核验此请求", moreInbox: "加载更多请求", inboxResolution: "请求核验结论", inboxEvidence: "请求证据 SHA-256（64 位小写十六进制）", abandonInbox: "放弃本请求，不重放", notApplied: "已核实未应用，不重放", observedAccepted: "已观察接纳，非任务完成", recordInbox: "记录请求核验", cancelReview: "取消核验", confirmInbox: "确认依据原生记录核验此请求？不会重放、取消原生任务或重新启用旧交互句柄。", command_prompt: "聊天请求", command_cancel: "取消请求", command_history: "历史查询", command_catalogue: "会话列表", command_select: "绑定选择", command_create_session: "新建会话", command_automation_read: "自动化查询", command_automation_control: "自动化控制", command_answer_interaction: "交互回答", nav: '远程控制与渠道', title: '远程控制与 Bot 渠道', subtitle: '仅桌面本机管理。授权仅覆盖所选工作区与会话；断开渠道不会取消已接纳的任务。', localOnly: '请在本机桌面设置中管理远程控制。', loading: '正在读取连接与授权…', refresh: '刷新', not_enabled: '服务未启用。使用受桌面认证保护的本机 Host，并设置 --remote-control enabled；此界面不会假装已启用。', unauthorized: '桌面认证失效，请重新连接桌面。', forbidden: '本机同源认证被拒绝。', capacity: '已达到数据或队列上限，请先处理现有记录。', conflict: '配置已发生变化，请刷新后重新确认。', invalid_input: '输入无效，请检查数字 ID 与授权范围。', unconfigured_account: '请先保存该账号的凭据。', native_credentials_unavailable: '系统凭据库不可用，请解锁后重试；不使用明文回退。', cleanup_required: '存在待清理凭据，请先恢复清理。', unavailable: '服务暂不可用。', invalid_response: '服务响应无效，未应用本地状态。', connection_lost: '连接中断，操作结果未知。请刷新配置确认，勿盲目重复提交。', accounts: 'Telegram 账号', botId: 'Bot 数字 ID', token: 'Bot Token（仅写入系统凭据库）', tokenHint: '保存后立即清空输入，不保存在浏览器或聊天中。', enabled: '启用连接', save: '保存凭据', enable: '启用', disable: '停用', revision: '版本', disabled: '已停用', starting: '正在连接', online: '身份已验证 · 连接运行中', stopped: '已停止', failed: '连接失败', running: '账号管理器运行中', dormant: '尚未运行', credentialsSaved: '已保存凭据引用', emptyAccounts: '尚未配置账号。', rotate: '更换凭据', cleanup: '清理退役凭据', cleanupPending: '存在待清理的系统凭据；配置已保存，旧凭据清理尚未完成。', grants: '控制者授权', userId: 'Telegram 数字用户 ID（非用户名）', account: '账号', workspace: '工作区', session: '会话', grant: '保存完整授权', scopeHint: '明确选择授权工作区、会话和默认关闭的新建权限。更改授权会使旧请求与订阅快照失效，但不会取消已接纳的任务。', allowedScopes: '完整授权范围', allowedSessions: '个授权会话', allowWorkspace: '授权工作区', allowSession: '授权会话', allowCreate: '允许在此工作区新建会话', createAllowed: '已允许新建', createDisabled: '新建权限已关闭', createHint: '新建权限与已有会话授权相互独立；仅勾选工作区不会启用新建。绑定会话必须保留授权，缺失的旧范围需明确移除。', unavailableScope: '不可用的已选范围', choose: '请选择', editScope: '更改范围', revoke: '永久撤销', confirmRevoke: '确认永久撤销此控制者？再次配对必须创建新身份。', revoked: '已撤销', emptyGrants: '尚无控制者授权。', more: '加载更多', recovery: '不确定发送的恢复', recoveryHint: '仅根据实际平台记录核验；任何恢复操作都不会自动重发或重跑 Agent。', emptyRecovery: '没有待核验的不确定发送。', evidence: '核验证据 SHA-256（64 位小写十六进制）', resolution: '核验结论', observed: '已观察送达', notSent: '已核实未发送', abandon: '放弃本条，不重发', messageId: '平台消息 ID', resolve: '记录核验结论', confirmResolve: '确认根据实际平台记录提交此结论？此操作不会重发。', pending: '操作中…', saved: '配置已保存', catalogFailed: '无法读取工作区与会话列表。', otherChannels: '其他渠道', notImplemented: '尚未接入 · 不代表可用', manager: '账号管理器', sessionId: '会话 ID', failureReason: '失败原因' };
exports.en = { inboxRecorded: 'Inbox review recorded. Native work was not replayed or cancelled; old interactions remain sealed.', inboxRecovery: "Uncertain inbox outcomes", inboxHint: "Only request identity and type are shown, not text, answers or handles. Verify native session records. A review does not rerun the request or re-enable its old interaction.", emptyInbox: "No uncertain inbox requests need review.", principalId: "Principal ID", bindingGeneration: "Binding generation", interactionSealed: "This interaction instance stays sealed under every review outcome; old handles cannot be reused.", originalProofRequired: "Success requires the original native receipt. Manual observations cannot grant a session or certify an automation control.", reviewInbox: "Review inbox request", moreInbox: "Load more inbox requests", inboxResolution: "Inbox review conclusion", inboxEvidence: "Inbox evidence SHA-256 (64 lowercase hexadecimal characters)", abandonInbox: "Abandon request without replay", notApplied: "Verified not applied without replay", observedAccepted: "Observed accepted, not task completion", recordInbox: "Record inbox review", cancelReview: "Cancel review", confirmInbox: "Record this conclusion based on native records? This does not replay, cancel native work or re-enable an old interaction handle.", command_prompt: "Chat request", command_cancel: "Cancellation request", command_history: "History query", command_catalogue: "Session catalogue", command_select: "Binding selection", command_create_session: "Session creation", command_automation_read: "Automation query", command_automation_control: "Automation control", command_answer_interaction: "Interaction answer", nav: 'Remote control & channels', title: 'Remote control & Bot channels', subtitle: 'Desktop-local administration only. Grants cover the selected workspace and session; channel disconnect does not cancel accepted tasks.', localOnly: 'Manage remote control from local desktop settings.', loading: 'Reading connections and grants…', refresh: 'Refresh', not_enabled: 'Service is not enabled. Use a desktop-authenticated loopback Host with --remote-control enabled; this view does not pretend activation.', unauthorized: 'Desktop authentication expired. Reconnect the desktop.', forbidden: 'Desktop same-origin authentication was denied.', capacity: 'A data or queue limit was reached. Resolve existing records first.', conflict: 'Configuration changed. Refresh and confirm again.', invalid_input: 'Invalid input. Check numeric IDs and scope.', unconfigured_account: 'Save this account’s credentials first.', native_credentials_unavailable: 'System credentials are unavailable. Unlock and retry; no plaintext fallback.', cleanup_required: 'Retired credentials need recovery cleanup.', unavailable: 'Service is temporarily unavailable.', invalid_response: 'Invalid service response; local state was not applied.', connection_lost: 'Connection lost; the outcome is unknown. Refresh to verify instead of blindly resubmitting.', accounts: 'Telegram accounts', botId: 'Numeric Bot ID', token: 'Bot Token (system credential store only)', tokenHint: 'Cleared immediately on save; never stored in browser storage or chat.', enabled: 'Enable connection', save: 'Save credential', enable: 'Enable', disable: 'Disable', revision: 'Revision', disabled: 'Disabled', starting: 'Connecting', online: 'Identity verified · workers running', stopped: 'Stopped', failed: 'Connection failed', running: 'Account manager running', dormant: 'Not running', credentialsSaved: 'Credential reference saved', emptyAccounts: 'No accounts configured.', rotate: 'Rotate credential', cleanup: 'Clean retired credentials', cleanupPending: 'System credential cleanup is pending. Configuration was saved; old-key cleanup is not complete.', grants: 'Controller grants', userId: 'Numeric Telegram user ID (not username)', account: 'Account', workspace: 'Workspace', session: 'Session', grant: 'Save complete grant', scopeHint: 'Choose explicit workspace, session and default-off creation permissions. Changes fence old requests/subscriptions, not already accepted native work.', allowedScopes: 'Complete grant scope', allowedSessions: 'allowed sessions', allowWorkspace: 'Allow workspace', allowSession: 'Allow session', allowCreate: 'Allow new sessions in this workspace', createAllowed: 'Creation allowed', createDisabled: 'Creation disabled', createHint: 'Creation is separate from existing-session access. Selecting a workspace alone does not enable it. Keep the bound session authorized; explicitly remove unavailable old scopes.', unavailableScope: 'Unavailable selected scope', choose: 'Select', editScope: 'Change scope', revoke: 'Revoke permanently', confirmRevoke: 'Permanently revoke this controller? Pairing again must mint a new identity.', revoked: 'Revoked', emptyGrants: 'No controller grants.', more: 'Load more', recovery: 'Uncertain-send recovery', recoveryHint: 'Verify actual platform records. No resolution automatically resends or reruns Agent.', emptyRecovery: 'No uncertain sends need review.', evidence: 'Evidence SHA-256 (64 lowercase hexadecimal characters)', resolution: 'Verified conclusion', observed: 'Observed delivered', notSent: 'Verified not sent', abandon: 'Abandon without replay', messageId: 'Platform message ID', resolve: 'Record verified conclusion', confirmResolve: 'Record this conclusion based on actual platform records? This does not resend.', pending: 'Working…', saved: 'Configuration saved', catalogFailed: 'Workspace/session catalog is unavailable.', otherChannels: 'Other channels', notImplemented: 'Not implemented · not available', manager: 'Account manager', sessionId: 'Session ID', failureReason: 'Failure reason' };

}
};
const __dependencies = {"src/modules/settings-remote-control/index.js":{"./api":"src/modules/settings-remote-control/api.js","./RemoteSettings":"src/modules/settings-remote-control/RemoteSettings.js","./locales":"src/modules/settings-remote-control/locales.js"},"src/modules/settings-remote-control/api.js":{},"src/modules/settings-remote-control/RemoteSettings.js":{"./api":"src/modules/settings-remote-control/api.js","./styles":"src/modules/settings-remote-control/styles.js"},"src/modules/settings-remote-control/styles.js":{"./RemoteSettings.css":"src/modules/settings-remote-control/RemoteSettings.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-remote-control/RemoteSettings.css":{},"src/modules/views-types.js":{},"src/modules/settings-remote-control/locales.js":{}};
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
return __load("src/modules/settings-remote-control/index.js");
}
});
