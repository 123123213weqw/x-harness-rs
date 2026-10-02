/** Preference constants consumed by the browser. The Host owns schema validation. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
export const LOCALE_PREFERENCE_FIELD = 'preference'
export const LOCALE_IDS = ['zh', 'en'] as const
export type LocaleId = typeof LOCALE_IDS[number]
export interface LocaleSettings { preference?: LocaleId }
