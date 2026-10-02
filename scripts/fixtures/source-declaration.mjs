import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require = createRequire(new URL('../../ui/package.json', import.meta.url))
const ts = require('typescript')

/** Tests inspect an exact named declaration, not a minifier's whitespace/region boundary. */
export function sourceDeclaration(text, name) {
  const file = ts.createSourceFile('shipped.js', text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS)
  assert.equal(file.parseDiagnostics.length, 0, 'shipped script must parse')
  const matches = []
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name?.text === name) matches.push(node.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(matches.length, 1, `one actual declaration of ${name} must ship`)
  return matches[0]
}
