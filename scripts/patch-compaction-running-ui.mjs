import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MARKER='// xh-compaction-running/v1';

export function patchCompactionRunningUi(bytes) {
 let s=bytes.toString();
 if(s.includes(MARKER))return Buffer.from(s);
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('compaction running UI anchor changed: '+a.slice(0,120));s=s.replace(a,b)};
 once('/** Automatic compaction keyed Chat renderer. */',`${MARKER}
		/** Automatic compaction keyed Chat renderer. */`);
 once(`		const CompactionNodeView = (0, react.memo)(function CompactionNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: node.data,
				t
			});
		});`, `		const CompactionNodeView = (0, react.memo)(function CompactionNodeView({ node, t }) {
			if (node.data.status === "running") return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.compactionRow + " " + MessageItem_module_css_default.retryRow,
				"data-active": true,
				"data-compaction-running": true,
				"aria-live": "polite",
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: MessageItem_module_css_default.compactionLeading,
					"aria-hidden": true,
					children: (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.IconApiOutline14, {})
				}), (0, react_jsx_runtime.jsx)("span", {
					className: MessageItem_module_css_default.retryText,
					children: t("message.compaction.running")
				})]
			});
			return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: node.data,
				t
			});
		});`);
 once(`		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/summary") return {`, `		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/start") return {
				...state,
				start: match,
				end: void 0
			};
			if (match.event.type === "compaction/end") return {
				...state,
				end: match
			};
			if (match.event.type === "compaction/summary") return {`);
 once(`		function fallbackState$2(context) {
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			return {
				...summary === void 0 ? {} : { summary },
				...checkpoint === void 0 ? {} : { checkpoint }
			};
		}`, `		function fallbackState$2(context) {
			const start = context.matches.find((match) => match.event.type === "compaction/start");
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			const end = context.matches.find((match) => match.event.type === "compaction/end");
			return {
				...start === void 0 ? {} : { start },
				...summary === void 0 ? {} : { summary },
				...checkpoint === void 0 ? {} : { checkpoint },
				...end === void 0 ? {} : { end }
			};
		}`);
 once(`			start: () => ({}),
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);
				if (state.checkpoint === void 0) return null;
				const marker = compactSummary(state.summary, state.checkpoint);
				return chatNode(context, "compaction", marker.seq, marker);
			}`, `			start: (_context, match) => match === void 0 ? {} : { start: match },
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);
				if (state.checkpoint !== void 0) {
					const marker = compactSummary(state.summary, state.checkpoint);
					return chatNode(context, "compaction", marker.seq, marker);
				}
				if (state.end !== void 0 || state.start === void 0) return null;
				const marker = {
					kind: "compaction",
					status: "running",
					seq: state.start.event.seq,
					time: state.start.event.time
				};
				return chatNode(context, "compaction", marker.seq, marker);
			}`);
 return Buffer.from(s);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dist=resolve(process.argv[2]??'ui/dist'),p=resolve(dist,'plugins/@xharness/dsh-client-ui-conversation/client.js');
 const bytes=patchCompactionRunningUi(readFileSync(p));writeFileSync(p,bytes);
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
 const gp=resolve(dist,'client-graph.json'),g=JSON.parse(readFileSync(gp));
 const e=g.entries.find(e=>e.id==='@xharness/dsh-client-ui-conversation');e.rev=hash(bytes);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;
 g.rev=hash(JSON.stringify(g.entries));writeFileSync(gp,JSON.stringify(g,null,2)+'\n');
 const ip=resolve(dist,'index.html');writeFileSync(ip,readFileSync(ip,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(g)}</script>`));
}
