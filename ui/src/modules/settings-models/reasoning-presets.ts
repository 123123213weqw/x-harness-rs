/** Explicit request recipes, never inferred from an engine or model name. */
export type ReasoningRecipeId = 'disabled' | 'enable-thinking' | 'thinking' | 'native-effort'

interface ReasoningEffortRecipe {
  id: string
  name: string
  request_patch: {
    chat_template_kwargs?: { enable_thinking?: boolean; thinking?: boolean }
    reasoning_effort?: string
  }
}

export interface ReasoningRecipeProfile {
  default_effort: string
  efforts: ReasoningEffortRecipe[]
}

/** Only Chat Completions recipes are declared here; do not leak them into Responses. */
export function supportsReasoningRecipes(api: string | undefined): boolean {
  return api === 'openai-completions'
}

export function reasoningRecipe(id: string): ReasoningRecipeProfile | null | undefined {
  switch (id) {
    case 'disabled': return null // Hide controls, not a request to turn thinking off.
    case 'enable-thinking': return {
      default_effort: 'on',
      efforts: [
        { id: 'off', name: 'Off', request_patch: { chat_template_kwargs: { enable_thinking: false } } },
        { id: 'on', name: 'On', request_patch: { chat_template_kwargs: { enable_thinking: true } } },
      ],
    }
    case 'thinking': return {
      default_effort: 'on',
      efforts: [
        { id: 'off', name: 'Off', request_patch: { chat_template_kwargs: { thinking: false } } },
        { id: 'on', name: 'On', request_patch: { chat_template_kwargs: { thinking: true } } },
      ],
    }
    case 'native-effort': return {
      default_effort: 'medium',
      efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id, request_patch: { reasoning_effort: id } })),
    }
    default: return undefined // Keep custom/unknown profiles untouched.
  }
}

/** Copy only the explicitly chosen recipe; preserve all unrelated model fields. */
export function applyReasoningRecipe(
  model: Readonly<Record<string, unknown>>, id: string, api: string | undefined,
): Record<string, unknown> {
  const reasoning = supportsReasoningRecipes(api) ? reasoningRecipe(id) : undefined
  return reasoning === undefined ? { ...model } : { ...model, reasoning }
}
