window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-reference",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region ../../context/file-reference/src/grammar.ts
		/**
		* Format a selected path as prompt text. Whitespace uses the quoted
		* `@"path"` grammar; a quoted directory keeps that quote open after its
		* trailing slash so completion can descend another level.
		* @param candidate - selected file or directory.
		* @param preserveQuote - retain an explicitly opened quote even when unnecessary.
		* @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
		*/
		function formatFileMention(candidate, preserveQuote) {
			const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return void 0;
			if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
			if (candidate.kind === "directory") return `@"${path}`;
			return `@"${path}"`;
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `reference` namespace dictionaries for the unified `@` source. */
		/** Dictionary namespace owned by this plugin. */
		const NS = "reference";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"section.files": "文件与文件夹",
			"section.sessions": "Session 对话",
			"candidate.file": "文件",
			"candidate.folder": "文件夹",
			"candidate.session": "Session",
			"candidate.noCwd": "（无工作目录）"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"section.files": "Files & folders",
			"section.sessions": "Session conversations",
			"candidate.file": "File",
			"candidate.folder": "Folder",
			"candidate.session": "Session",
			"candidate.noCwd": "(no cwd)"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the trigger registry, the Remote namespaces, and the copy. */
		const inject = [
			"inputTriggers",
			"locale",
			"remote",
			"remote.fileReferences",
			"remote.sessionReferenceResolver"
		];
		/**
		* Register the combined `@file` / `@session` source.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-reference: dictionaries");
			const t = ctx.locale.bind(NS);
			const source = {
				trigger: "@",
				name: "reference",
				showGroupTitle: false,
				async candidates(session, { query, quoted, signal }) {
					const files = ctx.remote.fileReferences.list(session.sessionId, query, signal).then((result) => result.ok ? result.value : [], () => []);
					const sessions = quoted === true ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates(session.sessionId, query, signal).then((result) => result.ok ? result.value : [], () => []);
					const [fileItems, sessionItems] = await Promise.all([files, sessions]);
					if (signal.aborted) return [];
					return [...fileItems.flatMap((candidate) => fileCandidate(candidate, quoted === true, t)), ...sessionItems.map((candidate) => sessionCandidate(candidate, t))];
				},
				onPick({ candidate }) {
					const value = parseCandidate(candidate.value);
					if (value?.kind === "file") return value.fileKind === "directory" ? {
						text: value.mention,
						continue: true
					} : { insert: {
						source: "reference",
						ref: value.mention,
						label: value.label,
						appearance: "file",
						clipboardText: value.mention
					} };
					if (value?.kind === "session") return { insert: {
						source: "reference",
						ref: value.mention,
						label: value.label,
						appearance: "session",
						clipboardText: value.mention
					} };
				},
				codec: {
					clipboardText: (ref) => ref,
					serialize: (ref) => Promise.resolve(ref)
				}
			};
			const inputTriggers = ctx.get("inputTriggers");
			ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
		}
		function fileCandidate(candidate, preserveQuote, t) {
			const mention = formatFileMention(candidate, preserveQuote);
			if (mention === void 0) return [];
			const name = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
			const directory = candidate.kind === "directory";
			const value = {
				kind: "file",
				fileKind: candidate.kind,
				label: name,
				mention
			};
			return [{
				name: `${t(directory ? "candidate.folder" : "candidate.file")} · ${name}${directory ? "/" : ""}`,
				description: candidate.path,
				section: t("section.files"),
				value: JSON.stringify(value)
			}];
		}
		function sessionCandidate(candidate, t) {
			const location = candidate.cwd ?? t("candidate.noCwd");
			const description = `${candidate.label === candidate.sessionId ? "" : `${candidate.sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`;
			const value = {
				kind: "session",
				label: candidate.label,
				mention: candidate.mention
			};
			return {
				name: `${t("candidate.session")} · ${candidate.label}`,
				description,
				section: t("section.sessions"),
				value: JSON.stringify(value)
			};
		}
		function parseCandidate(value) {
			if (value === void 0) return void 0;
			return JSON.parse(value);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map