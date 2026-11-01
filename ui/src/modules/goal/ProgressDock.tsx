/** Read-only plan projection. Removing this surface cannot affect execution. */
import type { PropsLocale } from '../views-types'
import './ProgressDock.styles'

export interface ProgressItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}
export interface ProgressPlan { revision: number; items: readonly ProgressItem[] }
function isUnknownArray(value: unknown): value is readonly unknown[] { return Array.isArray(value) }

/** Validate the generic wire projection before consuming its fields. */
export function readProgressPlan(value: unknown): ProgressPlan | null {
  if (typeof value !== 'object' || value === null || !('revision' in value) || !('items' in value)) return null
  const { revision, items } = value
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !isUnknownArray(items) || items.length > 128) return null
  const parsed: ProgressItem[] = []
  const ids = new Set<string>()
  for (const item of items) {
    // Array.isArray yields a library array; receive each element as unknown.
    const entry: unknown = item
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('title' in entry) || !('status' in entry)) return null
    const { id, title, status } = entry
    if (typeof id !== 'string' || id.length > 128 || !id.trim() || ids.has(id) || typeof title !== 'string' || title.length > 2048 || !title.trim()) return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    ids.add(id)
    parsed.push({ id, title, status })
  }
  return { revision, items: parsed }
}
export interface ProgressDockProps extends PropsLocale<'goal'> {
  useProjection(name: 'taskPlan'): unknown
}
export function ProgressDock({ useProjection, t }: ProgressDockProps) {
  const plan = readProgressPlan(useProjection('taskPlan'))
  if (!plan || plan.items.length === 0) return null
  const completed = plan.items.filter(item => item.status === 'completed').length
  return <div className="xh-progress-dock" data-task-plan-revision={plan.revision}>
    <details className="xh-progress-card" open>
      <summary><span>{t('progress.title')}</span><span className="xh-progress-count">{completed}/{plan.items.length}</span><span className="xh-progress-chevron" aria-hidden="true">⌃</span></summary>
      <ol aria-label={t('progress.title')}>
        {plan.items.map(item => <li key={item.id} data-plan-item={item.id} data-plan-status={item.status}>
          <span className="xh-progress-icon" aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '○'}</span>
          <span className="xh-progress-item"><span className="xh-progress-sr">{t(item.status === 'completed' ? 'progress.completed' : item.status === 'in_progress' ? 'progress.running' : 'progress.pending')}: </span>{item.title}</span>
        </li>)}
      </ol>
    </details>
  </div>
}
