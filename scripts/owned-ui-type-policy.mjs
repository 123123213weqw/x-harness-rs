// One policy used by every owned-source compiler. This is AST/typechecker based,
// not a grep: import aliases, strings and `as const` are not type assertions.
export function inspectOwnedSource(ts, file, checker) {
  const violations = []
  const report = (node, rule, message) => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    violations.push({ file: file.fileName, line: position.line + 1,
      column: position.character + 1, rule, message })
  }
  // Use parser-established literal ranges so regex and template text cannot be
  // mistaken for directive comments by the standalone scanner. Do not protect
  // whole template expressions: comments in ${ ... } are still real comments.
  const literalRanges = []
  const literals = node => {
    if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral
      || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) {
      literalRanges.push([node.getStart(file), node.end])
    }
    ts.forEachChild(node, literals)
  }
  literals(file)
  literalRanges.sort(([a], [b]) => a - b)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.languageVariant, file.text)
  let rangeIndex = 0
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenPos()
    while (literalRanges[rangeIndex] && literalRanges[rangeIndex][1] <= start) rangeIndex++
    const range = literalRanges[rangeIndex]
    if (range && start >= range[0] && start < range[1]) {
      scanner.setTextPos(range[1]); continue
    }
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    if (/@ts-(?:ignore|nocheck|expect-error)\b/.test(scanner.getTokenText())) {
      const position = file.getLineAndCharacterOfPosition(start)
      violations.push({ file: file.fileName, line: position.line + 1,
        column: position.character + 1, rule: 'disabled-type-check', message: 'Disabled source type checking is forbidden' })
    }
  }
  // Type arguments catch inferred Promise<any>, any[] and Map<K, any>, not
  // just direct any. Do not traverse vendor object members: library-internal
  // callback implementation types are outside the owned data boundary.
  const isAny = (type, seen = new Set()) => {
    if (seen.has(type)) return false
    seen.add(type)
    if (type.flags & ts.TypeFlags.Any) return true
    // ReactElement/ComponentClass include library-internal any arguments.
    // Their vendor-defined shape is not an owned unvalidated data binding;
    // explicit any syntax at the use site is independently forbidden above.
    const symbol = type.aliasSymbol ?? type.symbol
    if (symbol?.declarations?.length && symbol.declarations.every(node => {
      const path = node.getSourceFile().fileName
      return /[\\/]node_modules[\\/]/.test(path) && !/[\\/]node_modules[\\/]typescript[\\/]lib[\\/]/.test(path)
    })) return false
    if (type.isUnionOrIntersection?.() && type.types.some(value => isAny(value, seen))) return true
    const parameters = type.aliasTypeArguments ??
      ((type.flags & ts.TypeFlags.Object) && (type.objectFlags & ts.ObjectFlags.Reference)
        ? checker?.getTypeArguments(type) : [])
    return parameters?.some(value => isAny(value, seen)) ?? false
  }
  const visit = node => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'explicit-any', 'Owned UI source must not erase its boundary with any')
    if (ts.isNonNullExpression(node)) report(node, 'non-null-assertion', 'Owned UI source must establish presence through a guard, not a non-null assertion')
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const constLiteral = ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)
        && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const'
      if (!constLiteral) report(node, 'type-assertion', 'Owned UI source must not force an unvalidated type assertion')
    }
    if (checker && (ts.isVariableDeclaration(node) || ts.isParameter(node)
      || ts.isBindingElement(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))) {
      if (node.name && isAny(checker.getTypeAtLocation(node.name))) {
        report(node.name, 'inferred-any', 'Owned UI binding must not infer any; receive untrusted values as unknown and validate them')
      }
    }
    if (checker && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))) {
      const signature = checker.getSignatureFromDeclaration(node)
      if (signature && isAny(checker.getReturnTypeOfSignature(signature))) {
        report(node, 'any-return', 'Owned UI functions must not return any')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations
}
export function assertOwnedSource(ts, file, checker) {
  const errors = inspectOwnedSource(ts, file, checker)
  if (errors.length) throw Error(errors.map(error =>
    `${error.file}:${error.line}:${error.column} [${error.rule}] ${error.message}`).join('\n'))
}
