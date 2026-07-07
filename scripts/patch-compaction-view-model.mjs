import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '// xh-compaction-view-model/v1'

export function patchCompactionViewModel(bytes) {
  let source = bytes.toString()
  if (source.includes(marker)) return Buffer.from(source)
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw Error('compaction view-model anchor changed: ' + before.slice(0, 100))
    source = source.replace(before, after)
  }
  once('\t\tfunction fallbackState$2(context) {', `${marker}
		function projectedCompactionView(envelope) {
			if (envelope?.for !== "compaction" || envelope.view?.schemaVersion !== 1) return void 0;
			const view = envelope.view;
			if (typeof view.id !== "string" || view.id === "" || !Number.isSafeInteger(view.anchorSeq) || view.anchorSeq < 0 || !Number.isFinite(view.time)) return void 0;
			if (!["running", "succeeded", "failed"].includes(view.phase)) return void 0;
			if (view.phase === "succeeded" && (typeof view.summary !== "string" || !Number.isSafeInteger(view.summaryEventSeq) || !Number.isSafeInteger(view.shadowedItemCount) || !Number.isSafeInteger(view.shadowedTokenCount))) return void 0;
			return view;
		}
		function fallbackState$2(context) {`)
  once(`			const end = context.matches.find((match) => match.event.type === "compaction/end");
			return {`, `			const end = context.matches.find((match) => match.event.type === "compaction/end");
			const presentation = context.matches.map((match) => projectedCompactionView(match.view)).filter(Boolean).at(-1);
			return {
				...presentation === void 0 ? {} : { presentation },`)
  once(`		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/start") return {`, `		function updateCompactionState(state, match) {
			const presentation = projectedCompactionView(match.view);
			if (presentation !== void 0) return { ...state, presentation };
			if (match.event.type === "compaction/start") return {`)
  once(`			if (match.event.type === "compaction/end") return {
				...state,
				end: match
			};`, `			if (match.event.type === "compaction/end") return {
				...state,
				presentation: void 0,
				end: match
			};`)
  once(`		const compactionDefinition = {
			kind: "compaction",
			target: "chat",
			match: (event) => {`, `		const compactionDefinition = {
			kind: "compaction",
			target: "chat",
			match: (event, view) => {
				if (view?.for === "compaction") {
					const presentation = projectedCompactionView(view);
					return presentation === void 0 ? null : {
						id: presentation.id,
						role: presentation.phase === "running" ? "start" : "update"
					};
				}`)
  once(`			start: (_context, match) => match === void 0 ? {} : { start: match },
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);`, `			start: (_context, match) => match === void 0 ? {} : updateCompactionState({}, match),
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);
				if (state.presentation !== void 0) {
					const view = state.presentation;
					const data = view.phase === "succeeded" ? {
						kind: "compaction",
						seq: view.anchorSeq,
						time: view.time,
						summary: view.summary,
						summaryEventSeq: view.summaryEventSeq,
						shadowedItemCount: view.shadowedItemCount,
						shadowedTokenCount: view.shadowedTokenCount
					} : {
						kind: "compaction",
						status: view.phase === "running" ? "running" : "ended",
						seq: view.anchorSeq,
						time: view.time
					};
					return chatNode(context, "compaction", data.seq, data, {
						visibility: view.phase === "failed" ? "hidden" : "visible"
					});
				}`)
  return Buffer.from(source)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist')
  const path = resolve(dist, 'plugins/@xharness/dsh-client-ui-conversation/client.js')
  const bytes = patchCompactionViewModel(readFileSync(path))
  writeFileSync(path, bytes)
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath))
  const entry = graph.entries.find(candidate => candidate.id === '@xharness/dsh-client-ui-conversation')
  const previousUrl = entry.url
  entry.rev = hash(bytes)
  entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`
  graph.rev = hash(JSON.stringify(graph.entries))
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  const indexPath = resolve(dist, 'index.html')
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replaceAll(previousUrl, entry.url).replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}
