// Cross-language acceptance uses the production Runtime + business definitions.
// Only transport is omitted. No hand-built lifecycle, footer or fold reducers.
import { harness } from './conversation-test-harness.mjs'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'

export const terminalRow = event => ({ event })
export const terminalEvent = (seq, type, data, append = false) => ({ seq, time: seq * 100, type, data, ...(append ? { surfaceOp: 'append' } : {}) })
export function terminalPrefix(outcome = 'success') {
  return [
    terminalEvent(0, 'turn/start', { turn: 1 }), terminalEvent(1, 'step/start', { turn: 1, step: 0 }),
    terminalEvent(2, 'tool/call', { turn: 1, step: 0, callId: 'probe', name: 'bash', arguments: '{}' }),
    terminalEvent(3, 'tool/result', { turn: 1, step: 0,
      message: { source: { callId: 'probe' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'result' }], isError: outcome !== 'success' }] },
      ...(outcome === 'unknown' ? { error: { name: 'OutcomeUnknown', code: 'OUTCOME_UNKNOWN' } } : {}),
    }, true),
    terminalEvent(4, 'assistant/message', { turn: 1, step: 0, message: { id: 'answer', content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }] } }, true),
    terminalEvent(5, 'step/end', { turn: 1, step: 0 }),
  ]
}
export function terminalHarness(compiled) {
  const runtime = runtimeTestApi(), { plugin } = harness(compiled, { runtime })
  const definitions = [], views = []
  let fallback
  plugin.registerConversationNodes({
    conversationEvents: { register: value => definitions.push(value), registerFallback: value => { fallback = value } },
    conversationViews: { register: value => views.push(value) },
  })
  const conversation = {
    events: { entries: () => definitions, fallbackEntry: () => fallback },
    views: { entries: () => views },
  }
  return { runtime, plugin, conversation,
    session: () => new runtime.Session('terminal-fixture', {}, {}, { conversation }),
  }
}
/** Serialize a real assembled window for DOM-only acceptance. Rematerialize
 * location Maps on the browser side; never synthesize missing terminal data. */
export function terminalChatFixture(chat) {
  return JSON.parse(JSON.stringify({
    order: chat.order,
    turns: [...chat.timeline.turns.values()].map(turn => ({
      turn: turn.turn, start: turn.start, end: turn.end, status: turn.status,
      data: [['turn-tail', turn.data.get('turn-tail')]], steps: turn.steps.map(step => ({
        step: step.step, start: step.start, end: step.end, data: [['assistant-step', step.data.get('assistant-step')]],
      })),
    })),
    nodes: chat.order.map(key => {
      const node = chat.nodes.get(key), location = node.location
      return { ...node, location: { kind: location.kind, turn: location.turn.turn,
        ...(location.kind === 'step' ? { step: location.step.step } : {}),
      } }
    }),
  }))
}
