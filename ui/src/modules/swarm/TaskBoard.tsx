import { useCallback, useEffect, useRef, useState } from 'react';
import type { Observation, SwarmClient, TaskRow, Team } from './client';

interface Props {
    client: SwarmClient;
    team: Team;
    workers: readonly Observation[];
    workerName(id: string): string;
    openWorker(id: string): void;
    onChanged(): Promise<void>;
    disabled: boolean;
    onGuardChange?(guarded: boolean): void;
}
const message = (error: unknown): string => error instanceof Error ? error.message : 'Task board request failed';
function label(row: TaskRow, team: Team): string {
    const state = row.task.state;
    if (state.status === 'settled') return state.outcome === 'completed' ? 'Completed' : 'Not accepted';
    if (state.status === 'assigned') return state.delivered ? 'Inbox received' : 'Delivery pending';
    return row.ready ? 'Ready' : team.status === 'closed' ? 'Closed' : team.status === 'paused' ? 'Paused' : 'Waiting on dependencies';
}
/** Presentation and explicit user actions only. No task picking or model requests on view. */
export function TaskBoard({ client, team, workers, workerName, openWorker, onChanged, disabled, onGuardChange }: Props) {
    const [rows, setRows] = useState<readonly TaskRow[]>([]), [history, setHistory] = useState(false);
    const [revision, setRevision] = useState(0), [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [selected, setSelected] = useState(''), [worker, setWorker] = useState(''), [adding, setAdding] = useState(false);
    const [title, setTitle] = useState(''), [instructions, setInstructions] = useState(''), [dependencies, setDependencies] = useState<readonly string[]>([]);
    const [eligible, setEligible] = useState<readonly string[]>([]);
    const request = useRef(0), controller = useRef<AbortController | null>(null), alive = useRef(true), lock = useRef(false);
    const read = useCallback(async (after: string | null = null): Promise<void> => {
        controller.current?.abort();
        const abort = new AbortController(), id = ++request.current;
        controller.current = abort;
        setLoading(true);
        try {
            const page = await client.tasks(team, history, after, abort.signal);
            if (!alive.current || abort.signal.aborted || request.current !== id) return;
            // A changed revision invalidates a paginated view; reload rather than mix snapshots.
            if (after !== null && page.revision !== revision) {
                setRows([]); setCursor(null); setError('The board changed. Refresh tasks to load a consistent view.'); return;
            }
            setRows(previous => after === null ? page.tasks : [...previous, ...page.tasks]);
            setRevision(page.revision); setCursor(page.nextCursor); setError('');
            if (page.revision !== team.revision) await onChanged();
        } catch (error: unknown) {
            if (alive.current && !abort.signal.aborted && request.current === id) setError(message(error));
        } finally {
            if (alive.current && !abort.signal.aborted && request.current === id) setLoading(false);
        }
    }, [client, team, history, revision, onChanged]);
    // Reset the displayed scope before a new history read; component identity is the team/owner.
    const readRef = useRef(read); readRef.current = read;
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; request.current++; controller.current?.abort(); };
    }, []);
    useEffect(() => {
        setRows([]); setCursor(null); setWorker('');
        void readRef.current();
        return () => { request.current++; controller.current?.abort(); };
    }, [team.revision, history]);
    async function mutate(action: () => Promise<void>, added = false): Promise<void> {
        if (lock.current || loading || disabled || error) return;
        lock.current = true; setBusy(true);
        controller.current?.abort(); request.current++;
        try {
            await action();
            if (!alive.current) return;
            if (added) { setAdding(false); setTitle(''); setInstructions(''); setDependencies([]); setEligible([]); }
            setWorker('');
            await readRef.current();
        } catch (error: unknown) {
            if (alive.current) setError(`${message(error)}. Refresh tasks before retrying; the change may already be saved.`);
        } finally {
            lock.current = false;
            if (alive.current) setBusy(false);
        }
    }
    useEffect(() => { onGuardChange?.(busy || loading || !!error || adding); return () => onGuardChange?.(false); }, [onGuardChange, busy, loading, error, adding]);
    const current = rows.find(row => row.task.id === selected);
    const available = workers.filter(w => w.activity === 'idle' && !rows.some(row => row.task.state.status === 'assigned' && row.task.state.workerSessionId === w.sessionId));
    const blocked = busy || loading || disabled || !!error || revision === 0;
    return <section className="xhswarm-board" aria-label="Task board" aria-busy={loading}>
        <div className="xhswarm-board-toolbar"><div className="xhswarm-board-filters" role="group" aria-label="Task view">
            <button type="button" aria-pressed={!history} disabled={busy} onClick={() => setHistory(false)}>Active</button>
            <button type="button" aria-pressed={history} disabled={busy} onClick={() => setHistory(true)}>All tasks</button>
        </div><button type="button" aria-label="Refresh tasks" disabled={busy || loading} onClick={() => void read()}>Refresh</button></div>
        <label className="xhswarm-task-checkbox"><input type="checkbox" checked={team.autoDispatch} disabled={blocked || team.status === 'closed' || (team.status !== 'active' && !team.autoDispatch)} onChange={event => { const enabled = event.target.checked; void mutate(() => client.dispatch(team, revision, enabled)); }}/>Auto-dispatch</label>
        {error && <p className="xhswarm-board-error" role="alert">{error}</p>}
        {loading && <p className="xhswarm-muted" role="status">Loading tasks…</p>}
        {!loading && !error && !rows.length && <div className="xhswarm-board-empty"><strong>{history ? 'No recorded tasks' : 'No active tasks'}</strong><p>{history ? 'Completed work stays here.' : 'Add work when the team is ready.'}</p></div>}
        <ul className="xhswarm-task-list">{rows.map(row => <li key={row.task.id}>
            <button type="button" className="xhswarm-task-row" aria-expanded={row.task.id === selected} onClick={() => { setSelected(selected === row.task.id ? '' : row.task.id); setWorker(''); }}>
                <span className="xhswarm-task-mark" aria-hidden="true">{row.task.state.status === 'settled' ? row.task.state.outcome === 'completed' ? '✓' : '!' : row.task.state.status === 'assigned' ? '→' : '○'}</span>
                <span><strong>{row.task.title}</strong><small>{label(row, team)}{row.task.state.status !== 'pending' ? ` · ${workerName(row.task.state.workerSessionId)}` : ''}</small></span>
            </button>
            {current?.task.id === row.task.id && <div className="xhswarm-task-detail">
                <p className="xhswarm-task-instructions">{row.task.instructions}</p>
                {row.task.eligibleWorkerSessionIds.length > 0 && <small>Eligible workers: {row.task.eligibleWorkerSessionIds.map(workerName).join(', ')}</small>}
                {row.task.dependencies.length > 0 && <div className="xhswarm-task-dependencies"><span>Depends on</span><ul>{row.task.dependencies.map(id => <li key={id}>{rows.find(item => item.task.id === id)?.task.title ?? id}</li>)}</ul></div>}
                {row.task.state.status === 'settled' && <><h3>Recorded result</h3><p className="xhswarm-task-instructions">{row.task.state.summary}</p><small>{row.task.state.turn === null ? 'Failed before a turn started' : `Worker turn ${row.task.state.turn}`}</small></>}
                {row.task.state.status !== 'pending' && <button type="button" onClick={() => { if (row.task.state.status !== 'pending') openWorker(row.task.state.workerSessionId); }}>Open worker conversation</button>}
                {row.task.state.status === 'pending' && row.ready && team.status === 'active' && <form onSubmit={event => { event.preventDefault(); if (available.some(w => w.sessionId === worker)) void mutate(() => client.claimTask(team, revision, row.task.id, worker)); }}>
                    <label>Assign to<select aria-label={`Assign ${row.task.title} to`} value={worker} disabled={blocked} onChange={event => setWorker(event.target.value)}><option value="">Choose an idle worker</option>{available.map(w => <option key={w.sessionId} value={w.sessionId}>{workerName(w.sessionId)}</option>)}</select></label>
                    <small>Assignment sends this task to the worker’s inbox and can start work.</small>
                    <button className="xhswarm-primary" type="submit" disabled={blocked || !available.some(w => w.sessionId === worker)}>Assign task</button>
                </form>}
            </div>}
        </li>)}</ul>
        {cursor && <button type="button" disabled={busy || loading || !!error} onClick={() => void read(cursor)}>Load more tasks</button>}
        {!adding && <button className="xhswarm-add-task" type="button" disabled={blocked || team.status !== 'active'} onClick={() => setAdding(true)}>+ Add task</button>}
        {adding && <form className="xhswarm-task-form" onSubmit={event => { event.preventDefault(); if (title.trim() && instructions.trim()) void mutate(() => client.addTask(team, revision, title.trim(), instructions.trim(), dependencies, eligible), true); }}>
            <label>Title<input value={title} maxLength={160} required onChange={event => setTitle(event.target.value)}/></label>
            <label>Instructions<textarea value={instructions} maxLength={32768} required onChange={event => setInstructions(event.target.value)}/></label>
            <details><summary>Automatic routing</summary><p className="xhswarm-muted">Only these workers may pick up this task automatically. Leave empty for manual assignment.</p>{workers.map(worker => <label className="xhswarm-task-checkbox" key={worker.sessionId}><input type="checkbox" checked={eligible.includes(worker.sessionId)} onChange={event => setEligible(event.target.checked ? [...eligible, worker.sessionId] : eligible.filter(id => id !== worker.sessionId))}/>{workerName(worker.sessionId)}</label>)}</details>
            <details><summary>Dependencies</summary><p className="xhswarm-muted">From loaded tasks. Use All tasks to include completed work.</p>{rows.map(row => <label className="xhswarm-task-checkbox" key={row.task.id}><input type="checkbox" checked={dependencies.includes(row.task.id)} onChange={event => setDependencies(event.target.checked ? [...dependencies, row.task.id] : dependencies.filter(id => id !== row.task.id))}/>{row.task.title}</label>)}</details>
            <div className="xhswarm-form-actions"><button className="xhswarm-primary" type="submit" disabled={blocked || team.status !== 'active' || !title.trim() || !instructions.trim()}>Save task</button><button type="button" disabled={busy} onClick={() => setAdding(false)}>Cancel task</button></div>
        </form>}
        <p className="xhswarm-board-footnote">{team.autoDispatch ? 'Automatic pickup for explicitly routed tasks · results need coordinator review' : 'Manual assignment · automatic pickup is off'}</p>
    </section>;
}
