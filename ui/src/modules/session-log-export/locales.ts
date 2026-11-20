/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'help.label': '帮助与诊断',
  'help.docs': '产品文档',
  'help.issue': '反馈问题',
  'help.export': '导出当前对话日志',
  'dialog.preparingTitle': '正在导出对话日志',
  'dialog.preparingDescription': '正在准备包含当前对话、子会话 和附件的 ZIP 文件。',
  'dialog.successTitle': '对话日志已开始下载',
  'dialog.successDescription': '浏览器正在下载对话日志 ZIP 文件。',
  'dialog.errorTitle': '对话日志导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法开始导出对话日志。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'help.label': 'Help and diagnostics',
  'help.docs': 'Product docs',
  'help.issue': 'Report an issue',
  'help.export': 'Export current chat logs',
  'dialog.preparingTitle': 'Exporting chat logs',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Chat log download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Chat log export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
