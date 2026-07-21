/** Composer classes only accept strings and boolean guards; no third-party runtime. */
export default function classes(...values: readonly (string | false | null | undefined)[]): string { return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ') }
