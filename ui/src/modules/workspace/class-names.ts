type ClassValue = string | number | boolean | null | undefined | readonly ClassValue[] | {[key: string]: unknown}
function isClassArray(value: ClassValue): value is readonly ClassValue[] { return Array.isArray(value) }
/** Complete class-list composition for the migrated presentation-only surfaces. */
export default function clsx(...values: readonly ClassValue[]): string {
  const output: string[] = []
  const add = (value: ClassValue): void => {
    if (!value) return
    if (typeof value === 'string' || typeof value === 'number') output.push(String(value))
    else if (isClassArray(value)) {for (const child of value) add(child)}
    else if (typeof value === 'object') {for (const key of Object.keys(value)) if (value[key]) output.push(key)}
  }
  for (const value of values) add(value)
  return output.join(' ')
}
