/** Strict decoding at the opt-in Swarm RPC boundary. No model calls or retries. */
import type { ClientConnectionRpc } from '../client-connection/rpc-contracts';
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
export interface Inspection {
    swarm: Team;
    workers: readonly Observation[];
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
    return { id: text(v.id), ownerSessionId: text(v.ownerSessionId), workspace: text(v.workspace), objective: text(v.objective), status: status(v.status), revision, members };
}
export function parseInspection(value: unknown): Inspection {
    const v = object(value), swarm = parseTeam(v.swarm);
    const workers = list(v.workers, item => { const w = object(item); return { sessionId: text(w.sessionId), activity: activity(w.activity), sessionRevision: w.sessionRevision === null ? null : number(w.sessionRevision), lastTurnEnd: w.lastTurnEnd === null ? null : { kind: text(object(w.lastTurnEnd).kind) }, unresolvedToolCalls: list(w.unresolvedToolCalls, text), pendingMessages: number(w.pendingMessages) }; });
    if (new Set(workers.map(w => w.sessionId)).size !== workers.length || workers.length !== Object.keys(swarm.members).length || workers.some(w => !Object.prototype.hasOwnProperty.call(swarm.members, w.sessionId)))
        throw Error('Swarm member/observation mismatch');
    return { swarm, workers };
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
    async create(owner: string, objective: string): Promise<string> { return text(object(await this.call(owner, { action: 'create', objective })).swarmId); }
    async status(team: Team, next: SwarmStatus): Promise<void> { await this.call(team.ownerSessionId, { action: 'set_status', swarmId: team.id, expectedRevision: team.revision, status: next }); }
    async attach(team: Team, child: string): Promise<void> { await this.call(team.ownerSessionId, { action: 'attach_member', swarmId: team.id, expectedRevision: team.revision, childSessionId: child }); }
}
