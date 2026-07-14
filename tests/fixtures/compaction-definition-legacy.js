// Frozen pre-view Definition fixture; tests patch construction, not runtime dependencies.
		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/start") return {
				...state,
				start: match,
				end: void 0
			};
			if (match.event.type === "compaction/end") return {
				...state,
				end: match
			};
			if (match.event.type === "compaction/summary") return {
				...state,
				summary: match
			};
			if (compactSource(match.event) !== void 0) return {
				...state,
				checkpoint: match
			};
			return state;
		}
		function fallbackState$2(context) {
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
		}
		/** Automatic compaction lifecycle and landed checkpoint Definition. */
		const compactionDefinition = {
			kind: "compaction",
			target: "chat",
			match: (event) => {
				const checkpoint = compactSource(event);
				if (checkpoint !== void 0 && checkpoint.sourceCommandId === void 0) return {
					id: checkpoint.compactionId,
					role: "update"
				};
				if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
					if (event.data.sourceCommandId !== void 0) return null;
					const compactionId = event.data.compactionId;
					if (typeof compactionId !== "string" || compactionId === "") return null;
					return {
						id: compactionId,
						role: event.type === "compaction/start" ? "start" : "update"
					};
				}
				return null;
			},
			start: (_context, match) => match === void 0 ? {} : { start: match },
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);
				if (state.checkpoint !== void 0) {
					const marker = compactSummary(state.summary, state.checkpoint);
					return chatNode(context, "compaction", marker.seq, marker);
				}
				if (state.start === void 0) return null;
				const marker = {
					kind: "compaction",
					status: state.end === void 0 ? "running" : "ended",
					seq: state.start.event.seq,
					time: state.start.event.time
				};
				return chatNode(context, "compaction", marker.seq, marker, {
					visibility: state.end === void 0 ? "visible" : "hidden"
				});
			}
		};
