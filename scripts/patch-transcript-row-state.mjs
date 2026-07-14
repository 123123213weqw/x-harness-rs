import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const marker = '// xh-transcript-row-state/v1';
export function patchTranscriptRowState(id, bytes) {
  const kind = id.split('/').at(-1);
  if (!['dsh-client-ui-conversation', 'dsh-client-ui-tool', 'dsh-client-ui-cordis', 'xharness-client-ui-computer'].includes(kind)) return bytes;
  let s = bytes.toString();
  if (s.includes(marker)) {
    if (s.split(marker).length !== 2 || !s.includes('function xhUseTranscriptState(key, initial)'))
      throw Error('Transcript row state anchors changed');
    return bytes;
  }
  const once = (from, to) => {
    if (s.split(from).length !== 2) throw Error('Transcript row state anchor changed: ' + from);
    s = s.replace(from, to);
  };
  // Small per-component keys, never prompts, DOM trees, or copied tool results.
  const reactName = kind === 'xharness-client-ui-computer' ? 'React' : 'react';
  const anchor = kind === 'xharness-client-ui-computer' ? "const React = require('react')" : 'let react = require("react");';
  once(anchor, anchor + `\n${marker}\nfunction xhUseTranscriptState(key, initial) {\n  const api = globalThis.__xhTranscriptState?.get(${reactName}.createElement);\n  return api ? api.useState(key, initial) : ${reactName}.useState(initial);\n}\n`);
  const change = (name, key, variable = 'expanded', first = 'false') => {
    const pos = s.indexOf('function ' + name + '(');
    if (pos < 0) throw Error('Missing transcript component: ' + name);
    const before = s.slice(0, pos), tail = s.slice(pos);
    const declaration = `const [${variable}, set${variable[0].toUpperCase() + variable.slice(1)}] = (0, react.useState)(${first});`;
    const at = tail.indexOf(declaration);
    if (at < 0 || at > 1800) throw Error('Missing transcript state: ' + name);
    s = before + tail.slice(0, at) + declaration.replace(`(0, react.useState)(${first})`, `xhUseTranscriptState(${key}, ${first})`) + tail.slice(at + declaration.length);
  };
  if (kind === 'dsh-client-ui-conversation') {
    change('CompactionItem', '"compact"');
    change('ContextInjectionRow', '"context"', 'open');
    change('GenericCommandCard', '"command"');
    once('function ReasoningRow({ text, running, t })', 'function ReasoningRow({ text, running, t, stateKey = 0 })');
    change('ReasoningRow', '"reasoning:" + stateKey');
    once('jsx)(ReasoningRow, {\n', 'jsx)(ReasoningRow, {\nstateKey: i,\n');
    once('const processMode = xhUseProcessMode();\n\t\t\t(0, react.useEffect)', 'const processMode = xhUseProcessMode();\nconst [appliedMode, setAppliedMode] = xhUseTranscriptState("reasoning-mode:" + stateKey, null);\n\t\t\t(0, react.useEffect)');
    once('if (processMode === "verbose") setExpanded(true);', 'if (appliedMode === processMode) return;\nsetAppliedMode(processMode);\n\t\t\t\tif (processMode === "verbose") setExpanded(true);');
    once('}, [processMode, running]);', '}, [processMode, running, appliedMode]);');
  } else if (kind === 'dsh-client-ui-tool') {
    once('function ToolRow({ t, variant,', 'function ToolRow({ stateKey = "", t, variant,');
    change('ToolRow', '"tool:" + stateKey');
    change('BashRow', '"bash:" + block.callId');
    const calls = 'jsx)(ToolRow, {\n';
    if (s.split(calls).length !== 8) throw Error('Tool row call count changed');
    s = s.replaceAll(calls, calls + 'stateKey: block.callId,\n');
    once('...diffBody.card,', '...diffBody.card,\nstateKey,');
    once('const processMode = xhUseProcessMode();\n\t\t\t(0, react.useEffect)', 'const processMode = xhUseProcessMode();\nconst [appliedMode, setAppliedMode] = xhUseTranscriptState("tool-mode:" + stateKey, null);\n\t\t\t(0, react.useEffect)');
    once('if (processMode === "verbose") setExpanded(true);', 'if (appliedMode === processMode) return;\nsetAppliedMode(processMode);\n\t\t\t\tif (processMode === "verbose") setExpanded(true);');
    once('}, [processMode, state]);', '}, [processMode, state, appliedMode]);');
  } else if (kind === 'xharness-client-ui-computer') {
    once('const [expanded, setExpanded] = React.useState(false)', 'const [expanded, setExpanded] = xhUseTranscriptState("computer:" + callId, false)');
  } else {
    // Cordis card fields are presentation-only; do not retain async operations.
    once('const [expanded, setExpanded] = (0, react.useState)(false);', 'const [expanded, setExpanded] = xhUseTranscriptState("cordis-expanded", false);');
    once('const [selectedSource, setSelectedSource] = (0, react.useState)(card.clientCode !== null ? "client" : "host");', 'const [selectedSource, setSelectedSource] = xhUseTranscriptState("cordis-source", card.clientCode !== null ? "client" : "host");');
  }
  return Buffer.from(s);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json')));
  const hash = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
  for (const entry of graph.entries) {
    const file = resolve(dist, 'plugins', entry.id, 'client.js');
    const bytes = patchTranscriptRowState(entry.id, readFileSync(file));
    writeFileSync(file, bytes); entry.rev = hash(bytes); entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`;
  }
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(resolve(dist, 'client-graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const index = resolve(dist, 'index.html');
  const urls = new Map(graph.entries.map(entry => [entry.url.split('?')[0], entry.url]));
  writeFileSync(index, readFileSync(index, 'utf8')
    .replace(/(\/plugins\/[^"?]+\/client\.js)\?rev=[a-f0-9]+/g, (url, path) => urls.get(path) ?? url)
    .replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
