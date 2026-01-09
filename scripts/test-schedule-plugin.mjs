import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(
  await readFile(new URL('../ui/plugins/@xlang/xharness-client-ui-schedule/client.js', import.meta.url), 'utf8'),
  sandbox,
)

const React = {
  createElement() {},
  useEffect() {},
  useMemo() {},
  useRef() {},
  useState() {},
}
const plugin = registration.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal() {} }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconChevronDownOutline14() {}, useAnchoredPosition() {} }
  }
  throw new Error(`unexpected module dependency: ${id}`)
})

const once = {
  id: 'schedule-1',
  kind: 'after',
  prompt: 'once',
  afterSeconds: 30,
  scheduledAt: '2026-09-02T00:00:30.000Z',
}
const every = {
  id: 'schedule-2',
  kind: 'every',
  prompt: 'repeat',
  everySeconds: 300,
  scheduledAt: '2026-09-02T00:05:00.000Z',
}

assert.deepEqual(
  JSON.parse(JSON.stringify(plugin.foldScheduleChanges([
    { operation: 'create', schedule: once },
    { operation: 'create', schedule: every },
    { operation: 'dispatch', id: once.id },
    { operation: 'dispatch', id: every.id, acceptedAt: '2026-09-02T00:11:00.000Z' },
  ]))),
  [{ ...every, scheduledAt: '2026-09-02T00:15:00.000Z' }],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(plugin.foldScheduleChanges([
    { operation: 'create', schedule: once },
    { operation: 'delete', id: once.id },
  ]))),
  [],
)

const ordered = plugin.orderScheduleRecords([
  { ...every, id: 'future', scheduledAt: '2026-09-02T00:20:00.000Z' },
  { ...once, id: 'overdue', scheduledAt: '2026-09-02T00:00:00.000Z' },
], Date.parse('2026-09-02T00:10:00.000Z'))
assert.equal(ordered[0].id, 'overdue')
assert.deepEqual(
  JSON.parse(JSON.stringify(plugin.inject)),
  ['slots', 'locale', 'conversationEvents', 'conversationViews'],
)

console.log('schedule component projection tests passed')
