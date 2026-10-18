// Entrypoint policy is shared by assembly, standalone compiler tests and release checks.
export const CONNECTION_ID = '@xharness/dsh-client-connection'
export const PRODUCTION_CONNECTION = 'src/modules/client-connection/index.ts'
export const FIXTURE_CONNECTION = 'src/modules/client-connection/fixture-entry.ts'
export function assertVariant(variant) {
  if (!['production', 'fixture'].includes(variant)) throw Error(`Unknown UI build variant: ${variant}`)
}
export function isFixtureSource(source) {
  return /(?:^|\/)(?:fixtures?|demos?)(?:[-.]|\/|$)/i.test(source)
}
export function assertProductionSources(sources) {
  for (const source of sources) if (isFixtureSource(source)) throw Error(`Fixture/demo input is forbidden in production: ${source}`)
}
export function moduleRowsForVariant(rows, variant) {
  assertVariant(variant)
  const connection = rows.filter(row => row.id === CONNECTION_ID)
  if (connection.length !== 1 || connection[0].source !== PRODUCTION_CONNECTION) throw Error('UI manifest must declare exactly one production connection entry')
  return rows.map(row => row.id === CONNECTION_ID && variant === 'fixture' ? {...row, source: FIXTURE_CONNECTION} : row)
}
