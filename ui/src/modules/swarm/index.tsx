/// <reference path="../shared/assets.d.ts" />
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconAgentPresetOutline16, IconRefreshOutline16, IconPauseOutline16, IconPlayOutline16, IconCloseOutline16 } from '@xharness/dsh-client-ui-primitives';
import type { ClientContext } from '../views-types';
import type { ISessions } from '../client-runtime/contract/sessions';
import type { ClientConnectionRpc } from '../client-connection/rpc-contracts';
import type { SubagentAddress } from '../client-connection/contracts/host/apiproxy/api/subagents';
import type { CommandUiContract } from '../commands/contract';
import { SessionId } from '../client-connection/contracts/core/session/types';
import { SwarmClient } from './client';
import type { Inspection, Team } from './client';
import CSS from './Swarm.css';
import { TaskBoard } from './TaskBoard';
import { AgentMonitor } from './AgentMonitor';
import { TeamInspector } from './TeamInspector';
export type SwarmSessions = Pick<ISessions, 'list' | 'open' | 'openSubagent' | 'subagentAddress' | 'refreshSubagents'>;
export const openSwarm = (): void => { window.dispatchEvent(new Event('xharness:swarm:open')); };
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
    const [panel, setPanel] = useState<'tasks' | 'team'>('team');
    const [teams, setTeams] = useState<readonly Team[]>([]), [inspection, setInspection] = useState<Inspection | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [objective, setObjective] = useState(''), [creating, setCreating] = useState(false), [child, setChild] = useState('');
    const [selectedWorker, setSelectedWorker] = useState('');
    const scope = useRef(0), read = useRef(0), selected = useRef(''), controller = useRef<AbortController | null>(null);
    const [live, setLive] = useState<Inspection | null>(null), [observedAt, setObservedAt] = useState(0), [monitorError, setMonitorError] = useState('');
    const background = useRef<AbortController | null>(null), guarded = useRef(false), foregroundBusy = useRef(false);
    foregroundBusy.current = busy || loading;
    const guardChanged = useCallback((value: boolean): void => { guarded.current = value; }, []);
    const team = inspection && inspection.swarm.ownerSessionId === owner ? inspection.swarm : null;
    const refresh = useCallback(async (preferred?: string): Promise<void> => {
        if (!owner || !eligible)
            return;
        background.current?.abort();
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
            setInspection(detail); setLive(detail); setObservedAt(Date.now()); setMonitorError('');
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
    useEffect(() => { scope.current++; selected.current = ''; guarded.current = false; setLive(null); setObservedAt(0); setMonitorError(''); setInspection(null); setTeams([]); setCreating(false); setBusy(false); setLoading(false); setError(''); setChild(''); void refresh(); return () => { scope.current++; controller.current?.abort(); }; }, [refresh]);
    const visible = !!team && !creating;
    useEffect(() => { showConversation(visible); return () => showConversation(false); }, [visible, showConversation]);
    useEffect(() => { const visible = (): void => { if (!document.hidden)
        void refresh(); }; document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible); return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); }; }, [refresh]);
    // Foreground read-only monitoring. Never polls hidden/unmounted Swarm views,
    // probes a provider, submits prompts, or clears an uncertain-write guard.
    useEffect(() => {
        if (!owner || !eligible || !team) return;
        const id = team.id, epoch = scope.current;
        let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async (): Promise<void> => {
            let delay = 5000;
            if (!document.hidden && !foregroundBusy.current) {
                const abort = new AbortController(); background.current = abort;
                try {
                    const detail = await client.inspect(owner, id, abort.signal);
                    if (disposed || abort.signal.aborted || scope.current !== epoch || selected.current !== id) return;
                    setLive(detail); setObservedAt(Date.now()); setMonitorError('');
                    if (!guarded.current && !foregroundBusy.current) setInspection(detail);
                    if (detail.workers.some(w => w.activity === 'running' || w.activity === 'queued') || Object.values(detail.work).some(w => w.assignment)) delay = 1500;
                } catch (e: unknown) {
                    if (!disposed && !abort.signal.aborted && scope.current === epoch) setMonitorError(errorMessage(e));
                }
            }
            if (!disposed) timer = setTimeout(() => void poll(), delay);
        };
        timer = setTimeout(() => void poll(), 1500);
        return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); background.current?.abort(); };
    }, [client, owner, eligible, team?.id]);
    useEffect(() => { setSelectedWorker(''); }, [owner, team?.id]);
    const memberIds = team ? Object.keys(team.members).join('\0') : '';
    useEffect(() => {
        if (!owner || !memberIds) return;
        let alive = true;
        void sessions.refreshSubagents(owner).catch((e: unknown) => { if (alive) setMonitorError(errorMessage(e)); });
        return () => { alive = false; };
    }, [owner, memberIds, sessions]);
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
    const current = live && live.swarm.id === team?.id && live.swarm.ownerSessionId === owner ? live : inspection;
    const members = current ? Object.values(current.swarm.members) : [], observations = current && current.swarm.id === team?.id ? current.workers : [];
    function workerName(id: string): string { const entry = owner ? catalog.subagentsByParent[owner]?.entries.find(e => e.id === id) : undefined; return entry?.kind === 'child' ? entry.label ?? id : id; }
    const available = owner ? catalog.subagentsByParent[owner]?.entries.filter(e => e.kind === 'child' && !members.some(m => m.sessionId === e.id)) ?? [] : [];
    function workerAddress(id: string): SubagentAddress | undefined {
        if (!owner) return;
        const entry = catalog.subagentsByParent[owner]?.entries.find(row => row.id === id);
        // A discovered child need not have been opened before; use its exact catalog address.
        if (entry?.kind === 'child') return { parentSessionId: owner, childSessionId: entry.id, mode: entry.mode };
        return undefined;
    }
    function openWorker(id: string): void {
        const address = workerAddress(id);
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
  <header className="xhswarm-header"><div className="xhswarm-heading"><IconAgentPresetOutline16 size={20}/><h1 title={team?.objective}>{team?.objective.split('\n')[0] ?? 'Swarm'}</h1></div><div className="xhswarm-actions">
   {team && <AgentMonitor workerCount={members.length} workers={observations} showTeam={() => { setPanel('team'); setRailOpen(true); }} observedAt={observedAt} error={monitorError}/>}
   {team && <button type="button" aria-label={team.status === 'paused' ? 'Resume team' : 'Pause team'} disabled={busy || loading || !!error || team.status === 'closed'} title={team.status === 'paused' ? 'Resume team dispatch' : 'Pause new assignments; already admitted work continues'} onClick={() => void mutate(() => client.status(team, team.status === 'active' ? 'paused' : 'active'))}>{team.status === 'paused' ? <IconPlayOutline16 /> : <IconPauseOutline16 />}</button>}
   <button type="button" aria-label="Refresh team" disabled={busy || loading} onClick={() => void refresh()}><IconRefreshOutline16 /></button><button type="button" aria-label="Back to chat" onClick={() => window.dispatchEvent(new Event('xharness:swarm:close'))}><IconCloseOutline16 /></button>
  </div></header>
  {error && <div className="xhswarm-notice" role="alert">{error}</div>}
  {(!team || creating) && <section className="xhswarm-setup" aria-label="Swarm setup"><h2>{creating ? 'New team' : 'Keep your team together'}</h2>
   {!eligible ? <p>Select a root conversation in the sidebar, then open /swarm.</p> : <><p>Create a persistent team record for this conversation. Existing chats and their execution stay unchanged.</p><form onSubmit={event => { event.preventDefault(); if (owner && objective.trim())
            void mutate(() => client.create(owner, objective.trim())); }}><label>Objective<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={32768} required placeholder="What should this team work on?"/></label><button disabled={busy || loading || !!error || !objective.trim()} type="submit">{busy ? 'Saving…' : 'Create team'}</button>{creating && <button type="button" onClick={() => setCreating(false)}>Cancel</button>}</form></>}
   {loading && <p role="status">Loading teams…</p>}
  </section>}
  <aside id="xhswarm-team" className="xhswarm-rail" data-open={railOpen} aria-label="Tasks and team" onKeyDown={event => { if (event.key === 'Escape')
        setRailOpen(false); }}><div className="xhswarm-rail-heading"><h2>Workspace</h2>{eligible && <button type="button" onClick={() => setCreating(true)} disabled={busy}>New</button>}</div>
   {teams.length > 1 && <label className="xhswarm-team-picker">Saved teams<select aria-label="Saved teams" value={team?.id ?? ''} disabled={busy || loading} onChange={event => { setCreating(false); void refresh(event.target.value); }}>{teams.map(t => <option value={t.id} key={t.id}>{t.objective}</option>)}</select></label>}
   {team && <><div className="xhswarm-panel-tabs" role="group" aria-label="Workspace panel"><button type="button" aria-pressed={panel === 'tasks'} onClick={() => setPanel('tasks')}>Tasks</button><button type="button" aria-pressed={panel === 'team'} onClick={() => setPanel('team')}>Team <span>{members.length}</span></button></div>
   <div hidden={panel !== 'tasks'}><TaskBoard key={`${team.ownerSessionId}:${team.id}`} client={client} team={team} workers={observations} workerName={workerName} onGuardChange={guardChanged} openWorker={openWorker} onChanged={() => refresh(team.id)} disabled={busy || loading || !!error}/></div>
   <div hidden={panel !== 'team'}>{current && <TeamInspector key={`${team.ownerSessionId}:${team.id}`} client={client} inspection={current} coordinatorName={record?.displayTitle ?? 'Coordinator'} coordinatorRunning={!!record?.running} workerName={workerName} workerAddress={workerAddress} openWorker={openWorker} selected={panel === 'team' ? selectedWorker : ''} select={setSelectedWorker} error={monitorError}/>}
   <details className="xhswarm-link"><summary>Link an existing worker</summary><button type="button" onClick={() => void refreshWorkers()} disabled={busy}>Refresh workers</button><label>Worker<select aria-label="Worker to link" value={child} onChange={event => setChild(event.target.value)}><option value="">Choose worker</option>{available.map(entry => <option key={entry.id} value={entry.id}>{entry.kind === 'child' ? entry.label : entry.id}</option>)}</select></label><button type="button" disabled={!child || busy || loading || !!error || team.status !== 'active'} onClick={() => void mutate(() => client.attach(team, child))}>Link worker</button></details>
</div></>}
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
