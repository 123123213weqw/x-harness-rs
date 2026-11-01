import type { Activity, Observation } from './client';
interface Props {
    workerCount: number;
    workers: readonly Observation[];
    showTeam(): void;
    observedAt: number;
    error: string;
}
export const activityLabel: Record<Activity, string> = { running: 'Running', queued: 'Queued', idle: 'Idle', dispatch_paused: 'Stopped', unavailable: 'Unavailable', needs_reconciliation: 'Needs reconciliation', awaiting_approval: 'Needs approval', awaiting_answer: 'Needs answer' };
/** A compact entry point only; worker details live in the right-hand inspector. */
export function AgentMonitor({ workerCount, workers, showTeam, observedAt, error }: Props) {
    const running = workers.filter(worker => worker.activity === 'running').length;
    const attention = workers.filter(worker => ['awaiting_approval', 'awaiting_answer', 'needs_reconciliation', 'unavailable'].includes(worker.activity)).length;
    const status = error ? 'Status unavailable; showing last known data' : `${running} running${attention ? ` · ${attention} need attention` : ''}`;
    return <button type="button" className="xhswarm-team-summary" aria-label="Show team details" aria-controls="xhswarm-team" title={`${workerCount} agents · ${status}${observedAt ? ` · Updated ${new Date(observedAt).toLocaleTimeString('en-GB')}` : ''}`} onClick={showTeam}>
        <span>{workerCount} agents</span><span className="xhswarm-summary-status">{error ? 'Unavailable' : `${running} running`}</span>{attention > 0 && <span className="xhswarm-summary-attention" aria-label={`${attention} need attention`}>!</span>}
    </button>;
}
