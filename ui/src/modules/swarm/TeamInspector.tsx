import { useEffect, useState } from 'react';
import type { SubagentAddress } from '../client-connection/contracts/host/apiproxy/api/subagents';
import type { Inspection, SwarmClient, WorkerDetail } from './client';
import { activityLabel } from './AgentMonitor';
interface Props {
    client: SwarmClient;
    inspection: Inspection;
    coordinatorName: string;
    coordinatorRunning: boolean;
    workerName(id: string): string;
    workerAddress(id: string): SubagentAddress | undefined;
    openWorker(id: string): void;
    selected: string;
    select(id: string): void;
    error: string;
}
export function TeamInspector({ client, inspection, coordinatorName, coordinatorRunning, workerName, workerAddress, openWorker, selected, select, error }: Props) {
    const { swarm: team, workers, work, progress } = inspection;
    const observed = workers.find(worker => worker.sessionId === selected);
    const revision = observed?.sessionRevision;
    const isMember = Object.prototype.hasOwnProperty.call(team.members, selected);
    const [detail, setDetail] = useState<{ id: string; value: WorkerDetail } | null>(null);
    const [loading, setLoading] = useState(false), [detailError, setDetailError] = useState(''), [retry, setRetry] = useState(0);
    const address = selected ? workerAddress(selected) : undefined;
    const parent = address?.parentSessionId, child = address?.childSessionId, mode = address?.mode;
    useEffect(() => {
        const abort = new AbortController();
        setDetailError(''); setLoading(false);
        if (!selected || !Object.prototype.hasOwnProperty.call(team.members, selected) || !parent || !child || !mode || parent !== team.ownerSessionId || child !== selected) {
            if (selected) setDetailError('Worker address unavailable. Refresh workers to retry.');
            return;
        }
        setLoading(true);
        void client.workerDetail({ parentSessionId: parent, childSessionId: child, mode }, abort.signal).then(value => {
            if (!abort.signal.aborted) setDetail({ id: selected, value });
        }).catch((e: unknown) => {
            if (!abort.signal.aborted) setDetailError(e instanceof Error ? e.message : 'Worker details unavailable');
        }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
        return () => abort.abort();
    }, [client, team.ownerSessionId, selected, isMember, parent, child, mode, revision, retry]);
    const current = detail?.id === selected ? detail.value : null;
    const members = Object.values(team.members).sort((a, b) => workerName(a.sessionId).localeCompare(workerName(b.sessionId), undefined, { numeric: true }));
    return <section className="xhswarm-inspector" aria-label="Team inspector">
        <section className="xhswarm-team-overview" aria-label="Team overview">
            <h3>Objective</h3><p className="xhswarm-inspector-text">{team.objective}</p>
            <dl><div><dt>Coordinator</dt><dd>{coordinatorName} · {coordinatorRunning ? 'Running' : 'Idle'}</dd></div>
                <div><dt>Team</dt><dd>{team.status} · {members.length} workers</dd></div>
                <div><dt>Dispatch</dt><dd>{team.autoDispatch ? 'Automatic' : 'Manual'}</dd></div></dl>
            <label className="xhswarm-progress-label">{progress.accepted} / {progress.total} tasks accepted<progress aria-label="Accepted tasks" value={progress.accepted} max={Math.max(1, progress.total)}/></label>
            <p className="xhswarm-inspector-meta">{progress.pending} pending · {progress.assigned} assigned · {progress.failed} rejected</p>
            {error && <p role="status" className="xhswarm-inspector-warning">Status unavailable · showing last known team data.</p>}
        </section>
        <h3>Workers</h3>
        {!members.length && <p className="xhswarm-muted">No workers linked yet.</p>}
        {members.map(member => {
            const worker = workers.find(w => w.sessionId === member.sessionId), facts = work[member.sessionId], expanded = selected === member.sessionId;
            return <article className="xhswarm-worker" key={member.sessionId}>
                <button type="button" className="xhswarm-worker-toggle" aria-label={`Inspect agent ${workerName(member.sessionId)}`} aria-expanded={expanded} onClick={() => select(expanded ? '' : member.sessionId)}>
                    <strong>{workerName(member.sessionId)}</strong><span>{worker ? activityLabel[worker.activity] : 'Not observed'}</span>
                    <small>{facts?.assignment?.title ?? 'No active assignment'}</small>
                    <small>{facts?.accepted ?? 0} accepted · {facts?.failed ?? 0} rejected</small>
                </button>
                {expanded && <section className="xhswarm-worker-detail" aria-label={`Agent details ${workerName(member.sessionId)}`}>
                    <h4>Role / initial assignment</h4><p className="xhswarm-inspector-text">{member.assignment.slice(0, 2000)}{member.assignment.length > 2000 ? '…' : ''}</p>
                    <dl><div><dt>Last used model</dt><dd>{current?.model ? `${current.model.provider} / ${current.model.model}` : loading ? 'Loading…' : 'Not reported'}</dd></div>
                        <div><dt>Inbox</dt><dd>{worker?.pendingMessages ?? 'Unknown'} pending messages</dd></div>
                        <div><dt>Last turn</dt><dd>{worker?.lastTurnEnd?.kind.replaceAll('_', ' ') ?? 'Not recorded'}</dd></div>
                        {facts?.assignment && <div><dt>Assignment</dt><dd>{facts.assignment.title} · {facts.assignment.delivered ? 'Inbox received' : 'Delivery pending'}</dd></div>}
                    </dl>
                    <h4>Blockers</h4><p>{!worker ? 'Status unavailable' : worker.unresolvedToolCalls.length ? `${worker.unresolvedToolCalls.length} unresolved tool calls` : ['awaiting_approval', 'awaiting_answer', 'needs_reconciliation', 'unavailable', 'dispatch_paused'].includes(worker.activity) ? activityLabel[worker.activity] : team.status !== 'active' ? 'Team is not active; new dispatch is paused.' : 'No blocker reported'}</p>
                    {current?.activity && <><h4>Latest recorded activity</h4><p>{current.activity.text} · {new Date(current.activity.time).toLocaleTimeString('en-GB')}</p></>}
                    {facts?.result && <><h4>{facts.result.turn === null ? 'Recorded task result' : `Task result · worker turn ${facts.result.turn}`}</h4><strong>{facts.result.title} · {facts.result.outcome === 'completed' ? 'Accepted' : 'Rejected'}</strong><p className="xhswarm-inspector-text">{facts.result.summary}</p>{facts.result.truncated && <small>Preview truncated. Open the conversation for context.</small>}</>}
                    {current?.answer && <><h4>Latest public response</h4><p className="xhswarm-inspector-text">{current.answer.text}</p>{current.answer.truncated && <small>Preview truncated.</small>}</>}
                    {loading && <p role="status">Loading worker details…</p>}
                    {detailError && <p role="status" className="xhswarm-inspector-warning">{detailError}{current ? ' · Showing last known details.' : ''}</p>}
                    <div className="xhswarm-detail-actions"><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh details</button><button type="button" onClick={() => openWorker(member.sessionId)}>Open worker conversation</button></div>
                </section>}
            </article>;
        })}
    </section>;
}
