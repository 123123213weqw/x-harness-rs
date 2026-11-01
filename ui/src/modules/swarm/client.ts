/** Strict decoding at the opt-in Swarm RPC boundary. Mutations are explicit; no automatic retries. */
import type { ClientConnectionRpc } from '../client-connection/rpc-contracts';
import type { SubagentAddress } from '../client-connection/contracts/host/apiproxy/api/subagents';
export type SwarmStatus = 'active' | 'paused' | 'closed';
export interface Member {
    sessionId: string;
    assignment: string;
}
export interface Team {
    id: string;
    ownerSessionId: string;
    workspace: string;
    objective: string;
    status: SwarmStatus;
    revision: number;
    autoDispatch: boolean;
    members: Readonly<Record<string, Member>>;
}
export type Activity = 'unavailable' | 'running' | 'awaiting_approval' | 'awaiting_answer' | 'needs_reconciliation' | 'dispatch_paused' | 'queued' | 'idle';
export interface Observation {
    sessionId: string;
    activity: Activity;
    sessionRevision: number | null;
    lastTurnEnd: {
        kind: string;
    } | null;
    unresolvedToolCalls: readonly string[];
    pendingMessages: number;
}
export interface WorkerWork {
    assignment: { taskId: string; title: string; delivered: boolean } | null;
    accepted: number;
    failed: number;
    result: { taskId: string; title: string; turn: number | null; outcome: 'completed' | 'failed'; summary: string; truncated: boolean } | null;
}
export interface TeamProgress { total: number; pending: number; assigned: number; accepted: number; failed: number }
export interface WorkerDetail {
    model: { provider: string; model: string } | null;
    activity: { text: string; time: number } | null;
    answer: { text: string; truncated: boolean } | null;
}
export interface Inspection {
    swarm: Team;
    workers: readonly Observation[];
    work: Readonly<Record<string, WorkerWork>>;
    progress: TeamProgress;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { if (!isObject(value))
    throw Error('Invalid Swarm response'); return value; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim())
    throw Error('Invalid Swarm text'); return value; }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('Invalid Swarm revision/count'); return value; }
function list<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value))
    throw Error('Invalid Swarm list'); return value.map((item: unknown) => parse(item)); }
function status(value: unknown): SwarmStatus { if (value === 'active' || value === 'paused' || value === 'closed')
    return value; throw Error('Invalid Swarm lifecycle'); }
function activity(value: unknown): Activity { if (value === 'unavailable' || value === 'running' || value === 'awaiting_approval' || value === 'awaiting_answer' || value === 'needs_reconciliation' || value === 'dispatch_paused' || value === 'queued' || value === 'idle')
    return value; throw Error('Invalid worker activity'); }
export function parseTeam(value: unknown): Team {
    const v = object(value), members: Record<string, Member> = {};
    for (const [id, item] of Object.entries(object(v.members))) {
        const m = object(item), sessionId = text(m.sessionId);
        if (id !== sessionId || id === '__proto__' || id === 'constructor' || id === 'prototype')
            throw Error('Invalid member identity');
        members[id] = { sessionId, assignment: text(m.assignment) };
    }
    const revision = number(v.revision);
    if (!revision)
        throw Error('Invalid Swarm revision');
    return { id: text(v.id), ownerSessionId: text(v.ownerSessionId), workspace: text(v.workspace), objective: text(v.objective), status: status(v.status), revision, members, autoDispatch: v.autoDispatch === undefined ? false : boolean(v.autoDispatch) };
}
export function parseInspection(value: unknown): Inspection {
    const v = object(value), swarm = parseTeam(v.swarm);
    const workers = list(v.workers, item => { const w = object(item); return { sessionId: text(w.sessionId), activity: activity(w.activity), sessionRevision: w.sessionRevision === null ? null : number(w.sessionRevision), lastTurnEnd: w.lastTurnEnd === null ? null : { kind: text(object(w.lastTurnEnd).kind) }, unresolvedToolCalls: list(w.unresolvedToolCalls, text), pendingMessages: number(w.pendingMessages) }; });
    if (new Set(workers.map(w => w.sessionId)).size !== workers.length || workers.length !== Object.keys(swarm.members).length || workers.some(w => !Object.prototype.hasOwnProperty.call(swarm.members, w.sessionId)))
        throw Error('Swarm member/observation mismatch');
    const work: Record<string, WorkerWork> = {};
    const progress: TeamProgress = { total: 0, pending: 0, assigned: 0, accepted: 0, failed: 0 };
    // Retain counts and one bounded result per worker, never task instructions or histories.
    const tasks = object(v.swarm).tasks;
    for (const [id, item] of Object.entries(tasks === undefined ? {} : object(tasks))) {
        const task = object(item), state = taskState(task.state);
        if (text(task.id) !== id) throw Error('Invalid task identity');
        progress.total++;
        if (state.status === 'pending') { progress.pending++; continue; }
        if (!Object.prototype.hasOwnProperty.call(swarm.members, state.workerSessionId)) throw Error('Unknown task worker');
        const facts = work[state.workerSessionId] ?? { assignment: null, accepted: 0, failed: 0, result: null };
        if (state.status === 'assigned') {
            progress.assigned++;
            if (facts.assignment) throw Error('Worker has multiple unfinished tasks');
            facts.assignment = { taskId: id, title: text(task.title), delivered: state.delivered };
        } else {
            if (state.outcome === 'completed') { facts.accepted++; progress.accepted++; }
            else { facts.failed++; progress.failed++; }
            // Worker turn ordering is authoritative; task IDs are not completion timestamps.
            if (!facts.result || (state.turn !== null && (facts.result.turn === null || state.turn > facts.result.turn)))
                facts.result = { taskId: id, title: text(task.title), turn: state.turn, outcome: state.outcome, summary: state.summary.slice(0, 2000), truncated: state.summary.length > 2000 };
        }
        work[state.workerSessionId] = facts;
    }
    return { swarm, workers, work, progress };
}
export type TaskState =
    | { status: 'pending' }
    | { status: 'assigned'; workerSessionId: string; messageId: string; delivered: boolean }
    | { status: 'settled'; workerSessionId: string; messageId: string; turn: number | null; outcome: 'completed' | 'failed'; summary: string };
export interface Task {
    id: string;
    title: string;
    instructions: string;
    dependencies: readonly string[];
    eligibleWorkerSessionIds: readonly string[];
    state: TaskState;
}
export interface TaskRow { task: Task; ready: boolean }
export interface TaskPage {
    swarmId: string;
    revision: number;
    tasks: readonly TaskRow[];
    hasMore: boolean;
    nextCursor: string | null;
}
function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw Error('Invalid task flag');
    return value;
}
function taskState(value: unknown): TaskState {
    const state = object(value);
    if (state.status === 'pending') return { status: 'pending' };
    const workerSessionId = text(state.workerSessionId), messageId = text(state.messageId);
    if (state.status === 'assigned') return { status: 'assigned', workerSessionId, messageId, delivered: boolean(state.delivered) };
    if (state.status !== 'settled' || (state.outcome !== 'completed' && state.outcome !== 'failed')) throw Error('Invalid task state');
    const turn = state.turn === null ? null : number(state.turn);
    if ((turn !== null && turn > 4294967295) || (state.outcome === 'completed' && turn === null)) throw Error('Completed task requires a turn');
    return { status: 'settled', workerSessionId, messageId, turn, outcome: state.outcome, summary: text(state.summary) };
}
export function parseTaskPage(value: unknown): TaskPage {
    const page = object(value);
    const tasks = list(page.tasks, item => {
        const row = object(item), task = object(row.task);
        const dependencies = list(task.dependencies, text), state = taskState(task.state), ready = boolean(row.ready);
        const eligibleWorkerSessionIds = task.eligibleWorkerSessionIds === undefined ? [] : list(task.eligibleWorkerSessionIds, text);
        if (eligibleWorkerSessionIds.length > 64 || new Set(eligibleWorkerSessionIds).size !== eligibleWorkerSessionIds.length) throw Error('Invalid eligible workers');
        const id = text(task.id);
        if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id) || (ready && state.status !== 'pending')) throw Error('Invalid task dependencies/readiness');
        return { task: { id, title: text(task.title), instructions: text(task.instructions), dependencies, eligibleWorkerSessionIds, state }, ready };
    });
    const hasMore = boolean(page.hasMore), nextCursor = page.nextCursor === null ? null : text(page.nextCursor), revision = number(page.revision);
    if (!revision || tasks.length > 200 || new Set(tasks.map(row => row.task.id)).size !== tasks.length || tasks.some((row, i) => i > 0 && (tasks[i - 1]?.task.id ?? '') >= row.task.id) || (hasMore ? !tasks.length || nextCursor !== tasks[tasks.length - 1]?.task.id : nextCursor !== null)) throw Error('Invalid task page');
    return { swarmId: text(page.swarmId), revision, tasks, hasMore, nextCursor };
}

/** Decode only public tail activity and reported model metadata; never retain reasoning. */
export function parseWorkerDetail(value: unknown): WorkerDetail {
    const reply = object(value), detail: WorkerDetail = { model: null, activity: null, answer: null };
    if (reply.projections !== undefined) {
        const values = object(object(reply.projections).values);
        if (values.sessionStats !== undefined) {
            const throughput = object(values.sessionStats).activeThroughput;
            if (throughput !== undefined && throughput !== null) {
                const route = object(throughput);
                detail.model = { provider: text(route.provider), model: text(route.model) };
            }
        }
    }
    for (const item of list(reply.events, object)) {
        const event = object(item.event), kind = text(event.type), data = object(event.data);
        const time = number(event.time);
        if (kind === 'tool/call') detail.activity = { text: `Tool: ${text(data.name)}`, time };
        else if (kind === 'turn/start') detail.activity = { text: 'Turn started', time };
        else if (kind === 'turn/end') detail.activity = { text: `Turn ${text(object(data.reason).kind).replaceAll('_', ' ')}`, time };
        else if (kind === 'assistant/message') {
            let answer = '', truncated = false;
            for (const part of list(object(data.message).content, object)) {
                if (part.type !== 'text') continue;
                if (typeof part.text !== 'string') throw Error('Invalid public answer');
                const remaining = 2000 - answer.length;
                truncated ||= part.text.length > remaining;
                answer += part.text.slice(0, remaining);
            }
            if (answer) { detail.answer = { text: answer, truncated }; detail.activity = { text: 'Public response recorded', time }; }
        }
    }
    return detail;
}

export class SwarmClient {
    constructor(private readonly rpc: ClientConnectionRpc) { }
    private async call(ownerSessionId: string, command: object, signal?: AbortSignal): Promise<unknown> {
        const result = await this.rpc.call('/api', 'swarm/manage', { ownerSessionId, command }, signal);
        if (!result.ok)
            throw Error(result.error.message);
        return result.value;
    }
    async list(owner: string, signal: AbortSignal): Promise<readonly Team[]> { const teams = list(object(await this.call(owner, { action: 'list' }, signal)).swarms, parseTeam); if (teams.some(t => t.ownerSessionId !== owner) || new Set(teams.map(t => t.id)).size !== teams.length)
        throw Error('Swarm owner/identity mismatch'); return teams; }
    async inspect(owner: string, id: string, signal: AbortSignal): Promise<Inspection> { const result = parseInspection(await this.call(owner, { action: 'inspect', swarmId: id }, signal)); if (result.swarm.id !== id || result.swarm.ownerSessionId !== owner)
        throw Error('Swarm target mismatch'); return result; }
    async workerDetail(address: SubagentAddress, signal: AbortSignal): Promise<WorkerDetail> {
        const response = await this.rpc.call('/api', 'subagent.history', { ...address, maxMessages: 1 }, signal);
        if (!response.ok) throw Error(response.error.message);
        return parseWorkerDetail(response.value);
    }
    async create(owner: string, objective: string): Promise<string> { return text(object(await this.call(owner, { action: 'create', objective })).swarmId); }
    async status(team: Team, next: SwarmStatus): Promise<void> { await this.call(team.ownerSessionId, { action: 'set_status', swarmId: team.id, expectedRevision: team.revision, status: next }); }
    private async taskCall(owner: string, command: object, signal?: AbortSignal): Promise<unknown> {
        const result = await this.rpc.call('/api', 'swarm/tasks', { ownerSessionId: owner, command }, signal);
        if (!result.ok) throw Error(result.error.message);
        return result.value;
    }
    async tasks(team: Team, includeSettled: boolean, afterTaskId: string | null, signal: AbortSignal): Promise<TaskPage> {
        const command = afterTaskId === null
            ? { action: 'list', swarmId: team.id, includeSettled, limit: 50 }
            : { action: 'list', swarmId: team.id, includeSettled, limit: 50, afterTaskId };
        const page = parseTaskPage(await this.taskCall(team.ownerSessionId, command, signal));
        if (page.revision < team.revision || page.swarmId !== team.id || (afterTaskId !== null && page.tasks.some(row => row.task.id <= afterTaskId))) throw Error('Task board target/cursor mismatch');
        if (!includeSettled && page.tasks.some(row => row.task.state.status === 'settled')) throw Error('Unexpected settled task');
        return page;
    }
    async dispatch(team: Team, revision: number, enabled: boolean): Promise<void> {
        await this.call(team.ownerSessionId, { action: 'set_dispatch', swarmId: team.id, expectedRevision: revision, enabled });
    }
    async addTask(team: Team, revision: number, title: string, instructions: string, dependencies: readonly string[], eligibleWorkerSessionIds: readonly string[] = []): Promise<void> {
        await this.taskCall(team.ownerSessionId, { action: 'add', swarmId: team.id, expectedRevision: revision, title, instructions, dependencies, eligibleWorkerSessionIds });
    }
    async claimTask(team: Team, revision: number, taskId: string, workerSessionId: string): Promise<void> {
        await this.taskCall(team.ownerSessionId, { action: 'claim', swarmId: team.id, expectedRevision: revision, taskId, workerSessionId });
    }
    async attach(team: Team, child: string): Promise<void> { await this.call(team.ownerSessionId, { action: 'attach_member', swarmId: team.id, expectedRevision: team.revision, childSessionId: child }); }
}
