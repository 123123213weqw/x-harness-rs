export const NS = 'runtime.environment'
export const en = {
  separate: 'Open another environment in a new tab. This task and draft stay here.',
  popupBlocked: 'Browser blocked the new environment tab. Allow popups and try again.',
  connected: 'Cloud Host connected', disconnected: 'Cloud connection unavailable',
  notSynced: 'Independent workspace · session transfer and file sync are not enabled',
  choose: 'Choose execution environment', local: 'Local', cloud: 'Cloud',
  unavailable: 'Cloud execution is not connected yet. Tasks still run on the current Host.',
  bound: 'This conversation keeps its existing environment. Start a new task to choose another.',
  unknown: 'Conversation history has not been confirmed. Its environment cannot be changed.',
}
export const zh: Record<keyof typeof en, string> = {
  separate: '在新标签页打开另一环境；当前任务和草稿保持不变。',
  popupBlocked: '新环境标签页被浏览器拦截，请允许弹出窗口后重试。',
  connected: '云端 Host 已连接', disconnected: '云端连接不可用',
  notSynced: '独立工作区 · 尚未启用会话迁移与文件同步',
  choose: '选择执行环境', local: '本机', cloud: 'Cloud',
  unavailable: '云端执行尚未接入。任务仍在当前 Host 上运行。',
  bound: '此对话保持原执行环境。切换环境需要新建任务。',
  unknown: '尚未确认对话历史，不能更改其执行环境。',
}
export type EnvironmentKey = keyof typeof en
