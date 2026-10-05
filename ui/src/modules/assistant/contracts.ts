/** Product navigation only. It never submits a prompt or carries execution authority. */
export interface AssistantReference { key: string; text: string }
export const ASSISTANT_OPEN = 'xharness:assistant:open'
export function assistantReference(value: unknown): AssistantReference | null {
  if (typeof value !== 'object' || value === null || !('key' in value) || !('text' in value)) return null
  const {key, text} = value
  if (typeof key !== 'string' || !key || key.length > 8000 || /[\x00-\x1f]/.test(key)
    || typeof text !== 'string' || !text.trim() || text.length > 8000 || text.includes('\0')) return null
  return {key, text}
}
export function openAssistant(reference?: AssistantReference): void {
  if (reference && !assistantReference(reference)) throw new Error('Reference is invalid or exceeds the context limit')
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN, {detail: reference ?? null}))
}
