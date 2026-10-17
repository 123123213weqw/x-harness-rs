/// <reference path="../shared/assets.d.ts" />
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconAgentPresetOutline16, IconUserOutline16, IconRefreshOutline16, IconPauseOutline16, IconPlayOutline16, IconCloseOutline16 } from '@xharness/dsh-client-ui-primitives';
import type { ClientContext } from '../views-types';
import type { ISessions } from '../client-runtime/contract/sessions';
import type { ClientConnectionRpc } from '../client-connection/rpc-contracts';
import type { CommandUiContract } from '../commands/contract';
import { SessionId } from '../client-connection/contracts/core/session/types';
import { SwarmClient } from './client';
import type { Activity, Inspection, Team } from './client';
import CSS from './Swarm.css';
export type SwarmSessions = Pick<ISessions, 'list' | 'open' | 'openSubagent' | 'subagentAddress' | 'refreshSubagents'>;
export const openSwarm = (): void => { window.dispatchEvent(new Event('xharness:swarm:open')); };
const labels: Record<Activity, string> = { running: 'Running', queued: 'Queued', idle: 'Waiting', dispatch_paused: 'Stopped', unavailable: 'Unavailable', needs_reconciliation: 'Needs reconciliation', awaiting_approval: 'Needs approval', awaiting_answer: 'Waiting for an answer' };
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Swarm request failed';
export interface SwarmCenterProps {
    client: SwarmClient;
    sessions: SwarmSessions;
    showConversation(visible: boolean): void;
}
export function SwarmCenter({ client, sessions, showConversation }: SwarmCenterProps) {
    const catalog = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot);
    const owner = catalog.current, record = owner ? catalog.byId[owner] : undefined;
    const eligible = !!record && !record.parentId && record.origin !== 'subagent';
    const [railOpen, setRailOpen] = useState(false);
    const [teams, setTeams] = useState<readonly Team[]>([]), [inspection, setInspection] = useState<Inspection | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [objective, setObjective] = useState(''), [creating, setCreating] = useState(false), [child, setChild] = useState('');
    const scope = useRef(0), read = useRef(0), selected = useRef(''), controller = useRef<AbortController | null>(null);
    const team = inspection && inspection.swarm.ownerSessionId === owner ? inspection.swarm : null;
    const refresh = useCallback(async (preferred?: string): Promise<void> => {
        if (!owner || !eligible)
            return;
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        const epoch = scope.current, request = ++read.current;
        setLoading(true);
        try {
            const list = await client.list(owner, abort.signal), id = list.find(t => t.id === (preferred ?? selected.current))?.id ?? list[0]?.id;
            const detail = id ? await client.inspect(owner, id, abort.signal) : null;
            if (scope.current !== epoch || read.current !== request || abort.signal.aborted)
                return;
            selected.current = id ?? '';
            setTeams(list);
            setInspection(detail);
            setError('');
        }
        catch (e: unknown) {
            if (scope.current === epoch && read.current === request && !abort.signal.aborted)
                setError(errorMessage(e));
        }
        finally {
            if (scope.current === epoch && read.current === request && !abort.signal.aborted)
                setLoading(false);
        }
    }, [client, eligible, owner]);
    useEffect(() => { scope.current++; selected.current = ''; setInspection(null); setTeams([]); setCreating(false); setBusy(false); setLoading(false); setError(''); setChild(''); void refresh(); return () => { scope.current++; controller.current?.abort(); }; }, [refresh]);
    const visible = !!team && !creating;
    useEffect(() => { showConversation(visible); return () => showConversation(false); }, [visible, showConversation]);
    useEffect(() => { const visible = (): void => { if (!document.hidden)
        void refresh(); }; document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible); return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); }; }, [refresh]);
    // No hidden polling, provider probes, prompt submission or autonomous team loop.
    async function mutate(operation: () => Promise<string | void>): Promise<void> {
        if (busy || loading || error)
            return;
        controller.current?.abort();
        read.current++;
        const epoch = scope.current;
        setBusy(true);
        setError('');
        try {
            const id = await operation();
            if (scope.current !== epoch)
                return;
            setCreating(false);
            setChild('');
            await refresh(typeof id === 'string' ? id : team?.id);
        }
        catch (e: unknown) {
            if (scope.current === epoch)
                setError(`${errorMessage(e)}. Refresh teams before retrying; the operation may already be saved.`);
        }
        finally {
            if (scope.current === epoch)
                setBusy(false);
        }
    }
    const members = team ? Object.values(team.members) : [], observations = inspection && inspection.swarm.id === team?.id ? inspection.workers : [];
    const available = owner ? catalog.subagentsByParent[owner]?.entries.filter(e => e.kind === 'child' && !members.some(m => m.sessionId === e.id)) ?? [] : [];
    function openWorker(id: string): void {
        const address = sessions.subagentAddress(SessionId(id));
        if (!address) {
            setError('Worker address unavailable. Refresh workers first.');
            return;
        }
        sessions.openSubagent(address);
        window.dispatchEvent(new Event('xharness:swarm:close'));
    }
    async function refreshWorkers(): Promise<void> {
        if (!owner)
            return;
        const epoch = scope.current;
        try {
            await sessions.refreshSubagents(owner);
            if (scope.current === epoch)
                await refresh();
        }
        catch (e: unknown) {
            if (scope.current === epoch)
                setError(errorMessage(e));
        }
    }
    return <>
  <header className="xhswarm-header"><div className="xhswarm-heading"><IconAgentPresetOutline16 size={28}/><div><h1>{team?.objective.split('\n')[0] ?? 'Swarm'}</h1><span>{team ? 'Persistent team' : 'A workspace for your team'}</span></div></div><div className="xhswarm-actions">
   {team && <><span className="xhswarm-status">{team.status === 'closed' ? 'Closed' : team.status === 'paused' ? 'Paused' : record?.running || observations.some(w => w.activity === 'running') ? 'Running' : 'Waiting'}</span><button type="button" disabled={busy || loading || !!error || team.status === 'closed'} title="Changes team membership availability only. Running chats are not stopped." onClick={() => void mutate(() => client.status(team, team.status === 'active' ? 'paused' : 'active'))}>{team.status === 'paused' ? <IconPlayOutline16 /> : <IconPauseOutline16 />}{team.status === 'paused' ? 'Resume membership' : 'Pause membership'}</button></>}
   <button type="button" className="xhswarm-team-toggle" aria-controls="xhswarm-team" aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}>Team</button><button type="button" aria-label="Refresh team" disabled={busy || loading} onClick={() => void refresh()}><IconRefreshOutline16 /></button><button type="button" aria-label="Back to chat" onClick={() => window.dispatchEvent(new Event('xharness:swarm:close'))}><IconCloseOutline16 /></button>
  </div></header>
  {error && <div className="xhswarm-notice" role="alert">{error}</div>}
  {(!team || creating) && <section className="xhswarm-setup" aria-label="Swarm setup"><h2>{creating ? 'New team' : 'Keep your team together'}</h2>
   {!eligible ? <p>Select a root conversation in the sidebar, then open /swarm.</p> : <><p>Create a persistent team record for this conversation. Existing chats and their execution stay unchanged.</p><form onSubmit={event => { event.preventDefault(); if (owner && objective.trim())
            void mutate(() => client.create(owner, objective.trim())); }}><label>Objective<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={32768} required placeholder="What should this team work on?"/></label><button disabled={busy || loading || !!error || !objective.trim()} type="submit">{busy ? 'Saving…' : 'Create team'}</button>{creating && <button type="button" onClick={() => setCreating(false)}>Cancel</button>}</form></>}
   {loading && <p role="status">Loading teams…</p>}
  </section>}
  <aside id="xhswarm-team" className="xhswarm-rail" data-open={railOpen} aria-label="Team" onKeyDown={event => { if (event.key === 'Escape')
        setRailOpen(false); }}><div className="xhswarm-rail-heading"><h2>Team</h2>{eligible && <button type="button" onClick={() => setCreating(true)} disabled={busy}>New</button>}</div>
   {teams.length > 1 && <label className="xhswarm-team-picker">Saved teams<select aria-label="Saved teams" value={team?.id ?? ''} disabled={busy || loading} onChange={event => { setCreating(false); void refresh(event.target.value); }}>{teams.map(t => <option value={t.id} key={t.id}>{t.objective}</option>)}</select></label>}
   {team && <><div className="xhswarm-person"><IconUserOutline16 size={22}/><div><strong>Coordinator</strong><span>{record?.running ? 'Running' : 'Waiting'}</span></div></div>
   {members.map(member => { const observed = observations.find(w => w.sessionId === member.sessionId), entry = owner ? catalog.subagentsByParent[owner]?.entries.find(e => e.id === member.sessionId) : undefined; return <button className="xhswarm-person" type="button" key={member.sessionId} onClick={() => openWorker(member.sessionId)}><IconUserOutline16 size={22}/><div><strong>{entry?.kind === 'child' ? entry.label : member.sessionId.slice(0, 20)}</strong><span>{observed ? labels[observed.activity] : 'Not refreshed'}</span><small title={member.assignment}>{member.assignment}</small></div></button>; })}
   {!members.length && <p className="xhswarm-muted">No workers linked yet.</p>}
   <details className="xhswarm-link"><summary>Link an existing worker</summary><button type="button" onClick={() => void refreshWorkers()} disabled={busy}>Refresh workers</button><label>Worker<select aria-label="Worker to link" value={child} onChange={event => setChild(event.target.value)}><option value="">Choose worker</option>{available.map(entry => <option key={entry.id} value={entry.id}>{entry.kind === 'child' ? entry.label : entry.id}</option>)}</select></label><button type="button" disabled={!child || busy || loading || !!error || team.status !== 'active'} onClick={() => void mutate(() => client.attach(team, child))}>Link worker</button></details>
   <section className="xhswarm-results" aria-label="Recorded results"><h2>Recorded results</h2>{observations.filter(w => w.lastTurnEnd).slice(0, 3).map(w => <button type="button" key={w.sessionId} onClick={() => openWorker(w.sessionId)}><strong>{w.lastTurnEnd?.kind === 'completed' ? 'Turn finished' : w.lastTurnEnd?.kind.replaceAll('_', ' ')}</strong><span>Open worker conversation</span></button>)}{!observations.some(w => w.lastTurnEnd) && <p className="xhswarm-muted">No recorded turn results.</p>}</section></>}
  </aside>
 </>;
}
interface SwarmContext extends Pick<ClientContext, 'effect' | 'slots'> {
    get(name: 'connection'): {
        rpc: ClientConnectionRpc;
    };
    get(name: 'sessions'): SwarmSessions;
    get(name: 'commandUi'): Pick<CommandUiContract, 'register'>;
}
export const inject = ['slots', 'connection', 'sessions', 'commandUi'];
export function apply(ctx: SwarmContext): void {
    const client = new SwarmClient(ctx.get('connection').rpc), sessions = ctx.get('sessions');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.xharnessSwarm = ''; style.textContent = CSS; document.head.append(style); return () => style.remove(); }, 'swarm: scoped workspace styles');
    ctx.effect(() => ctx.get('commandUi').register({ name: 'swarm', description: 'Open a persistent team workspace', available: session => { const row = sessions.list.getSnapshot().byId[SessionId(session.sessionId)]; return !!row && !row.parentId && row.origin !== 'subagent'; }, ui: { kind: 'popupSelect', options: async () => [{ id: 'open', label: 'Open Swarm workspace' }], onSelect: () => openSwarm() } }), 'swarm: explicit opt-in command');
    ctx.slots.inject('swarm.center', () => ctx.slots.register({ name: 'swarm.center', id: 'durable-swarm', inject: () => ({ client, sessions }) }, SwarmCenter));
}
