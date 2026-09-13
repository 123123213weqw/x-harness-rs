export const NS = 'runtime.environment'
export const en = {
  choose: 'Choose execution environment', local: 'Local', cloud: 'Cloud',
  unavailable: 'Cloud execution is not connected yet. Tasks still run on the current Host.',
  bound: 'This conversation keeps its existing environment. Start a new task to choose another.',
  unknown: 'Conversation history has not been confirmed. Its environment cannot be changed.',
}
export const zh: Record<keyof typeof en, string> = {
  choose: '选择执行环境', local: '本机', cloud: 'Cloud',
  unavailable: '云端执行尚未接入。任务仍在当前 Host 上运行。',
  bound: '此对话保持原执行环境。切换环境需要新建任务。',
  unknown: '尚未确认对话历史，不能更改其执行环境。',
}
export type EnvironmentKey = keyof typeof en
