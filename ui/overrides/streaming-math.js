// Parse with the same math extensions as completed Markdown. Unlike an EOF-
// tolerant full-document parser, streaming must not typeset an unclosed fence.
function xhParseStreamingMath(text, parse) {
  const tree = parse(text);
  function visit(parent) {
    if (!parent.children) return;
    parent.children = parent.children.map(node => {
      if (node.type === 'math') {
        const raw = text.slice(node.position.start.offset, node.position.end.offset);
        const trimmed = raw.trimEnd();
        const dollars = raw.match(/^\${2,}/)?.[0];
        let closed = false;
        if (dollars) {
          const suffix = trimmed.match(/\$+$/)?.[0] ?? '';
          const start = trimmed.length - suffix.length;
          let slashes = 0;
          for (let i = start - 1; i >= 0 && trimmed[i] === '\\'; i--) slashes++;
          closed = suffix.length >= dollars.length && start >= dollars.length && slashes % 2 === 0;
        } else if (raw.startsWith('\\[')) {
          const start = trimmed.length - 2;
          let slashes = 0;
          for (let i = start - 1; i >= 0 && trimmed[i] === '\\'; i--) slashes++;
          closed = start >= 2 && trimmed.endsWith('\\]') && slashes % 2 === 0;
        }
        if (!closed) return { type: 'paragraph', position: node.position, children: [{ type: 'text', value: raw }] };
      }
      visit(node);
      return node;
    });
  }
  visit(tree);
  return tree;
}
