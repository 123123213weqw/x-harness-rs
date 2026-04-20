// The shipped Web client is assembled from a frozen upstream checkout whose
// client packages live under the upstream npm scope. XHarness ships the built
// artifacts, so both the on-disk plugin directories and the graph/identifier
// spellings inside them are ours. This module is the single place that maps
// upstream package ids onto the scope we publish.
import { join } from 'node:path'

/** Scope the assembled graph, plugin directories and bundler identifiers use. */
export const UI_NAMESPACE = '@xharness'
/** Scope the frozen upstream checkout ships its client packages under. */
export const UPSTREAM_NAMESPACE = '@deepseek-ai'
/** How `portableBytes` labels vendored upstream checkout paths in comments. */
export const UPSTREAM_SOURCE_LABEL = 'vendored'

/** `@scope/name` becomes `scope_name` inside a bundle's derived identifiers. */
export function identifierPrefix(scope) {
  return `${scope.slice(1).replace(/[^a-z0-9]+/gi, '_')}_`
}

export const UI_IDENTIFIER_PREFIX = identifierPrefix(UI_NAMESPACE)
export const UPSTREAM_IDENTIFIER_PREFIX = identifierPrefix(UPSTREAM_NAMESPACE)

/** Package name without its scope: `@scope/name` -> `name`. Lets a matcher
 * accept both spellings while assembling and after the shipped rewrite. */
export function pluginName(id) {
  return id.slice(id.indexOf('/') + 1)
}

/** True when an id is the named package under any accepted scope. */
export function isPlugin(id, name) {
  return pluginName(id) === name
}

/** Map an upstream package id onto the shipped one; other ids pass through. */
export function distId(id) {
  return id.startsWith(`${UPSTREAM_NAMESPACE}/`) ? UI_NAMESPACE + id.slice(UPSTREAM_NAMESPACE.length) : id
}

/** Directory holding one scope's plugin directories inside an assembled dist. */
export function pluginDir(dist, scope = UI_NAMESPACE) {
  return join(dist, 'plugins', scope)
}

/** Path of a single shipped plugin's client bundle, accepting either spelling.
 * Package-name product plugins keep their own scope, so derive it from the id. */
export function pluginPath(dist, id) {
  const shipped = distId(id)
  const separator = shipped.indexOf('/')
  return join(dist, 'plugins', shipped.slice(0, separator), shipped.slice(separator + 1), 'client.js')
}
