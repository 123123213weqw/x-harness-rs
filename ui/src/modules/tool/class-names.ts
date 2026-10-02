/** The consumed clsx surface is boolean/undefined string composition only. */
export function clsx(...values: readonly (string | boolean | undefined)[]): string {
  return values.filter(value => typeof value === 'string' && value.length > 0).join(' ')
}
