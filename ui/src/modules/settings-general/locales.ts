/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'account.trigger': '账号与设置',
  'account.name': 'XHarness',
  'account.caption': '账号与设置',
  'account.local': '本机工作区',
  'account.menu': '账号与额度',
  'account.profile': '使用档案',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'account.trigger': 'Account & settings',
  'account.name': 'XHarness',
  'account.caption': 'Account & settings',
  'account.local': 'Local workspace',
  'account.menu': 'Account & allowance',
  'account.profile': 'Usage profile',
} satisfies Record<SettingsKey, string>
