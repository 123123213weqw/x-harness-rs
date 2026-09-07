window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-model-selection",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/directory.js
		/** One session's shared directory controller; disposed with the session scope. */
		var ModelDirectory = class {
			sessions;
			sessionId;
			available;
			/** The shared snapshot both entries render from (uSES-safe store). */
			store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				current: null,
				routable: null,
				groups: [],
				failures: [],
				status: "idle",
				error: null
			});
			/** Latest operation wins; an older response never overwrites a newer one. */
			generation = 0;
			disposed = false;
			/**
			* @param sessions - the session wire face (captured from the plugin's root connection).
			* @param sessionId - the owning session.
			* @param available - whether this session may use Agent-bound model RPCs.
			*/
			constructor(sessions, sessionId, available) {
				this.sessions = sessions;
				this.sessionId = sessionId;
				this.available = available;
			}
			/**
			* Refresh the advisory directory (both entries call this on open).
			* Failure preserves the last good groups and current selection.
			* @returns the fresh directory value.
			*/
			async load() {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "loading";
					s.error = null;
				});
				const { result } = await xhModelRequest(this, generation, this.sessions.models({ sessionId: this.sessionId }));
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
					return result.value;
				}
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.error = `${result.error.code}: ${result.error.message}`;
					});
					throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`);
				}
				const { current, routable, groups, failures } = result.value;
				this.store.update((s) => {
					s.current = current;
					s.routable = routable;
					s.groups = groups;
					s.failures = failures;
					s.status = "ready";
					s.error = null;
				});
				return result.value;
			}
			/**
			* Select the complete provider/model/reasoning selection (both entries submit through here). Success
			* updates the shared current; failure surfaces on the store and throws so
			* each entry's own retry surface engages.
			* @param selection - provider, provider-owned model id, and optional adapter-owned effort.
			*/
			async select(selection) {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "selecting";
					s.error = null;
				});
				const { result } = await xhModelRequest(this, generation, this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort },
                    ...selection.contextWindowTokens === void 0 ? {} : { contextWindowTokens: selection.contextWindowTokens }
				}));
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
					return;
				}
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.error = `${result.error.code}: ${result.error.message}`;
					});
					throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`);
				}
				this.store.update((s) => {
					s.current = result.value.selected;
					s.routable = true;
					s.status = "ready";
					s.error = null;
				});
			}
			/**
			* Drop the previous Host generation's projection and repull it. Clearing
			* first prevents an unconsumed process-local selection from being displayed
			* while the restarted Host has restored the last logged model selection.
			*/
			resetConnected() {
				if (this.disposed) return;
				++this.generation;
				this.store.update((s) => {
					s.current = null;
					s.routable = null;
					s.groups = [];
					s.failures = [];
					s.status = "idle";
					s.error = null;
				});
				if (!this.available()) return;
				this.load().catch(() => {});
			}
			/** Scope teardown: late settlements lose write access to the store. */
			dispose() {
				this.disposed = true;
			}
			assertAvailable() {
				if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions");
			}
		};
		//#endregion
		//#region lib/types/client/service.js
		/**
		* ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
		* {@link ModelDirectory} instances. Both selection entries (the /model popup
		* and the composer model seat) resolve their session's directory through
		* this service, which is what makes the dual entry one shared state.
		*
		* Per-session storage follows the client service pattern (InputTriggerService /
		* CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
		* owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
		* does not belong here: it derives scope from the host carrier mechanism
		* (object-keyed), while client scopes tag contexts with branded SessionId
		* strings, and it models global+shadow named registries — this is a
		* per-session singleton with no global layer to merge.
		*/
		/** The `ctx.modelDirectories` session model-selection service. */
		var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {
			static inject = [
				"connection",
				"sessions",
				"remote"
			];
			live = { directories: /* @__PURE__ */ new Map() };
			/** Localized composer-block copy; this plugin owns the string it raises. */
			blockReason;
			/**
			* @param ctx - owning root context (the service registers itself as `models`).
			* @param config - the bound translator for this plugin's own dictionary.
			*/
			constructor(ctx, config) {
				super(ctx, "modelDirectories");
				this.blockReason = config.blockReason;
				ctx.on("connection/reset", () => {
					for (const directory of this.live.directories.values()) directory.resetConnected();
				});
				const refresh = () => {
					for (const directory of this.live.directories.values()) directory.load().catch(() => void 0);
				};
				ctx.remote.$on("llm/adapters-updated", refresh);
				ctx.remote.$on("settings/document-updated", refresh);
			}
			/**
			* Resolve the per-session shared directory (lazy; the scope disposer
			* removes and disposes it). Unknown sessions fail loud.
			* @param sessionId - the owning session.
			* @returns the resident directory both entries share.
			*/
			directoryFor(sessionId) {
				const { live } = this;
				const existing = live.directories.get(sessionId);
				if (existing !== void 0) return existing;
				const sessions = this.ctx.get("sessions");
				const actx = sessions.scope(sessionId);
				if (actx === void 0) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`);
				const directory = new ModelDirectory(this.ctx.get("connection").api.sessions, sessionId, () => sessions.subagentAddress(sessionId) === void 0);
				live.directories.set(sessionId, directory);
				const conversation = this.ctx.get("conversation");
				if (conversation !== void 0) {
					const publish = () => {
						conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false ? { reason: this.blockReason() } : void 0);
					};
					publish();
					actx.effect(() => {
						const stop = directory.store.subscribe(publish);
						return () => {
							stop();
							conversation.blocks.set(sessionId, void 0);
						};
					}, "ui-model-selection: composer block");
				}
				actx.effect(() => () => {
					directory.dispose();
					live.directories.delete(sessionId);
				}, "ui-model-selection: session directory");
				return directory;
			}
		};
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.module.css.mjs
		const css = ".AbPDjW_root{min-width:0;position:relative}.AbPDjW_trigger{min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.AbPDjW_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.AbPDjW_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.AbPDjW_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.AbPDjW_triggerEffort{color:var(--dsw-alias-label-caption);flex:none}.AbPDjW_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.AbPDjW_chevronOpen{transform:rotate(180deg)}.AbPDjW_menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.AbPDjW_status,.AbPDjW_empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.AbPDjW_error,.AbPDjW_warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}.AbPDjW_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.AbPDjW_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.AbPDjW_groups{min-height:0;overflow-y:auto}.AbPDjW_group+.AbPDjW_group{margin-top:4px}.AbPDjW_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.AbPDjW_option{box-sizing:border-box;width:auto;min-width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.AbPDjW_option:hover:not(:disabled),.AbPDjW_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_selected{background:0 0}.AbPDjW_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.AbPDjW_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}.AbPDjW_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.AbPDjW_description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.AbPDjW_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.AbPDjW_cell{box-sizing:border-box;width:auto;min-width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}.AbPDjW_cell:hover{background:var(--dsw-alias-interactive-bg-hover)}.AbPDjW_cellLabel{white-space:nowrap;flex:none}.AbPDjW_cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}.AbPDjW_cellChevron{color:var(--dsw-alias-label-tertiary);flex:none}";
		const tagId = "@deepseek-ai/dsh-client-ui-model-selection/ModelSelect.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-model-selection";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ModelSelect_module_css_default = {
			"cell": "AbPDjW_cell",
			"cellChevron": "AbPDjW_cellChevron",
			"cellLabel": "AbPDjW_cellLabel",
			"cellValue": "AbPDjW_cellValue",
			"check": "AbPDjW_check",
			"chevron": "AbPDjW_chevron",
			"chevronOpen": "AbPDjW_chevronOpen",
			"description": "AbPDjW_description",
			"empty": "AbPDjW_empty",
			"error": "AbPDjW_error",
			"group": "AbPDjW_group",
			"groupTitle": "AbPDjW_groupTitle",
			"groups": "AbPDjW_groups",
			"menu": "AbPDjW_menu",
			"modelName": "AbPDjW_modelName",
			"option": "AbPDjW_option",
			"optionCopy": "AbPDjW_optionCopy",
			"retry": "AbPDjW_retry",
			"root": "AbPDjW_root",
			"selected": "AbPDjW_selected",
			"status": "AbPDjW_status",
			"trigger": "AbPDjW_trigger",
			"triggerEffort": "AbPDjW_triggerEffort",
			"triggerLabel": "AbPDjW_triggerLabel",
			"warning": "AbPDjW_warning"
		};
		//#endregion
		//#region lib/types/client/ModelSelect.js
		/**
		* ModelSelect: the composer's named model seat (`conversation.input.model`).
		* Two-level selection per figma 496:26454's MenuDropdown: the root menu is
		* the Model / Effort row pair (label + current value + a right chevron),
		* each drilling into its own list — the provider-grouped model list over
		* the shared directory, and the effort levels. The trigger (313:14108's
		* ToggleButton) shows both: model name + effort in the caption tone.
		* Data and submission ride the SAME per-session ModelDirectory as the
		* /model popup; exact-model reasoning metadata and the selected effort come
		* from the Host rather than a client-owned vocabulary. A rejected selection
		* announces through the shared transient Toast anchored to the composer
		* card; the in-menu strip with Retry remains the catalog-load surface.
		*/
		/**
		* Render the composer model seat.
		* @param props - owner share (locked) + injected face (shared directory
		* store/verbs) + the standard locale seat.
		* @returns the trigger and, while open, the two-level menu.
		*/
		// XHARNESS NESTED CONTEXT MENU
		function ModelSelect({ locked, available, directory, load, select, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
			const [open, setOpen] = (0, react.useState)(false);
			const [pane, setPane] = (0, react.useState)("root");
			const lastActionRef = (0, react.useRef)("load");
      (0, react.useEffect)(() => { setPane("root"); }, [state.current?.provider, state.current?.model]);
			const [toast, setToast] = (0, react.useState)(null);
			const toastSeq = (0, react.useRef)(0);
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const itemRefs = (0, react.useRef)([]);
			const id = (0, react.useId)();
			const choices = (0, react.useMemo)(() => state.groups.flatMap((group) => group.models.map((model) => ({
				group,
				model,
				selection: {
					provider: group.id,
					model: model.id,
					...model.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: model.reasoning.defaultEffort }
				}
			}))), [state.groups]);
			const currentChoice = choices[state.current === null ? -1 : choices.findIndex((c) => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)];
			const reasoning = currentChoice?.model.reasoning;
			const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
			const effortLabel = reasoning === void 0 ? void 0 : effectiveEffort === void 0 ? t("effort.providerDefault") : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort;
			const effortChoices = (0, react.useMemo)(() => reasoning === void 0 ? [] : [...reasoning.defaultEffort === void 0 ? [{
				key: "provider-default",
				effort: void 0,
				label: t("effort.providerDefault")
			}] : [], ...reasoning.efforts.map((effort) => ({
				key: `effort:${effort.id}`,
				effort: effort.id,
				label: effort.name,
				...effort.description === void 0 ? {} : { description: effort.description }
			}))], [reasoning, t]);
			const busy = state.status === "selecting";
			const reload = () => {
				lastActionRef.current = "load";
				load();
			};
			(0, react.useEffect)(() => {
				if (available) {
					lastActionRef.current = "load";
					load();
				}
			}, [available, load]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", closeOutside);
				return () => {
					document.removeEventListener("mousedown", closeOutside);
				};
			}, [open]);
			if (!available) return null;
			const show = () => {
				setPane("root");
				setOpen(true);
				reload();
			};
			const close = (restoreFocus = false) => {
				setOpen(false);
				setPane("root");
				if (restoreFocus) queueMicrotask(() => {
					triggerRef.current?.focus();
				});
			};
			const moveFocus = (offset) => {
				const items = itemRefs.current.filter((item) => item !== null);
				if (items.length === 0) return;
				const active = items.findIndex((item) => item === document.activeElement);
				items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus();
			};
			const onRootKeyDown = (event) => {
				if (event.key === "Escape" && open) {
					event.preventDefault();
					if (pane !== "root") setPane("root");
					else close(true);
					return;
				}
				if (!open || pane === "context") return;
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					moveFocus(event.key === "ArrowDown" ? 1 : -1);
				}
			};
			const onBlur = (event) => {
      // XHARNESS SAFARI MENU BLUR: clicking a non-focusable menu button in WebKit
      // blurs the input with null relatedTarget before click. Outside clicks are
      // already handled by the document listener; do not unmount the form here.
      if (event.relatedTarget === null) return;
				if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
				close();
			};
			const settleSelection = (accepted) => {
				if (accepted) {
					if (rootRef.current !== null) close(true);
					return;
				}
				const message = directory.getSnapshot().error;
				if (message !== null) {
					toastSeq.current += 1;
					setToast({
						seq: toastSeq.current,
						text: t("error.action", { message })
					});
				}
			};
			const choose = (selection) => {
				if (state.current?.provider === selection.provider && state.current.model === selection.model) {
					close(true);
					return;
				}
				lastActionRef.current = "select";
				select(selection).then(settleSelection);
			};
			const chooseEffort = (effort) => {
				if (state.current === null) return;
				if (effectiveEffort === effort) {
					close(true);
					return;
				}
				const selection = {
					provider: state.current.provider,
					model: state.current.model,
					...effort === void 0 ? {} : { reasoningEffort: effort },
                    ...state.current.contextWindowTokens === void 0 ? {} : { contextWindowTokens: state.current.contextWindowTokens }
				};
				lastActionRef.current = "select";
				select(selection).then(settleSelection);
			};
			const modelLabel = currentChoice?.model.name ?? t("trigger.fallback");
			const triggerLabel = effortLabel === void 0 ? modelLabel : `${modelLabel} · ${effortLabel}`;
			const triggerAria = currentChoice === void 0 ? t("trigger.selectAria") : effortLabel === void 0 ? t("trigger.aria", { model: modelLabel }) : t("trigger.ariaEffort", {
				model: modelLabel,
				effort: effortLabel
			});
			itemRefs.current = [];
			let itemIndex = 0;
			const itemRef = () => {
				const at = itemIndex++;
				return (node) => {
					itemRefs.current[at] = node;
				};
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: ModelSelect_module_css_default.root,
				onKeyDown: onRootKeyDown,
				onBlur,
				children: [
					(0, react_jsx_runtime.jsxs)("button", {
						ref: triggerRef,
						type: "button",
						className: ModelSelect_module_css_default.trigger,
						"aria-label": triggerAria,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						"aria-controls": open ? `${id}-menu` : void 0,
						title: triggerLabel,
						disabled: locked,
						onClick: () => {
							if (open) close();
							else show();
						},
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: ModelSelect_module_css_default.triggerLabel,
								children: modelLabel
							}),
							null,
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: clsx(ModelSelect_module_css_default.chevron, open && ModelSelect_module_css_default.chevronOpen) })
						]
					}),
					open && (0, react_jsx_runtime.jsxs)("div", {
						id: `${id}-menu`,
						className: ModelSelect_module_css_default.menu,
						role: pane === "context" ? "dialog" : "menu",
						"aria-label": pane === "context" ? "调整上下文容量" : t("menu.aria"),
						"aria-busy": state.status === "loading" || busy,
						children: [
							pane === "root" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitem",
								className: ModelSelect_module_css_default.cell,
								onClick: () => {
									setPane("model");
								},
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellLabel,
										children: t("menu.model")
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellValue,
										children: modelLabel
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { className: ModelSelect_module_css_default.cellChevron })
								]
							}), reasoning !== void 0 && (0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitem",
								className: ModelSelect_module_css_default.cell,
								onClick: () => {
									setPane("effort");
								},
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellLabel,
										children: t("menu.effort")
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.cellValue,
										children: effortLabel
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { className: ModelSelect_module_css_default.cellChevron })
								]
							}), react.createElement(XHarnessContextRow, {state, itemRef: itemRef(), open: () => setPane("context")})] }),
              pane === "context" && react.createElement(XHarnessContextPane, {locked, directory, load: reload, select, back: () => setPane("root"), saved: () => close(true)}),
							pane === "model" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								state.status === "loading" && (0, react_jsx_runtime.jsx)("div", {
									className: ModelSelect_module_css_default.status,
									children: t("status.loading")
								}),
								state.error !== null && lastActionRef.current === "load" && (0, react_jsx_runtime.jsxs)("div", {
									className: ModelSelect_module_css_default.error,
									children: [(0, react_jsx_runtime.jsx)("span", { children: t("error.action", { message: state.error }) }), (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: ModelSelect_module_css_default.retry,
										onClick: reload,
										children: t("retry")
									})]
								}),
								state.failures.map((failure) => (0, react_jsx_runtime.jsxs)("div", {
									className: ModelSelect_module_css_default.warning,
									children: [(0, react_jsx_runtime.jsx)("span", { children: t("warning.groupLoad", {
										name: failure.name,
										message: failure.message
									}) }), (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: ModelSelect_module_css_default.retry,
										onClick: reload,
										children: t("retry")
									})]
								}, failure.id)),
								(0, react_jsx_runtime.jsx)("div", {
									className: clsx(ModelSelect_module_css_default.groups, "scrollable"),
									children: state.groups.map((group) => {
										const headingId = `${id}-${group.id}`;
										return (0, react_jsx_runtime.jsxs)("section", {
											role: "group",
											"aria-labelledby": headingId,
											className: ModelSelect_module_css_default.group,
											children: [(0, react_jsx_runtime.jsx)("div", {
												className: ModelSelect_module_css_default.groupTitle,
												id: headingId,
												children: group.name
											}), group.models.map((model) => {
												const selected = state.current?.provider === group.id && state.current.model === model.id;
												return (0, react_jsx_runtime.jsxs)("button", {
													ref: itemRef(),
													type: "button",
													role: "menuitemradio",
													"aria-checked": selected,
													className: clsx(ModelSelect_module_css_default.option, selected && ModelSelect_module_css_default.selected),
													title: model.name,
													disabled: busy,
													onClick: () => {
														choose({
															provider: group.id,
															model: model.id
														});
													},
													children: [(0, react_jsx_runtime.jsxs)("span", {
														className: ModelSelect_module_css_default.optionCopy,
														children: [(0, react_jsx_runtime.jsx)("span", {
															className: ModelSelect_module_css_default.modelName,
															children: model.name
														}), model.description !== void 0 && (0, react_jsx_runtime.jsx)("span", {
															className: ModelSelect_module_css_default.description,
															children: model.description
														})]
													}), (0, react_jsx_runtime.jsx)("span", {
														className: ModelSelect_module_css_default.check,
														children: selected ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : null
													})]
												}, model.id);
											})]
										}, group.id);
									})
								}),
								state.status === "ready" && choices.length === 0 && (0, react_jsx_runtime.jsx)("div", {
									className: ModelSelect_module_css_default.empty,
									children: t("empty.models")
								})
							] }),
							pane === "effort" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [state.error !== null && lastActionRef.current === "load" && (0, react_jsx_runtime.jsxs)("div", {
								className: ModelSelect_module_css_default.error,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("error.action", { message: state.error }) }), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: ModelSelect_module_css_default.retry,
									onClick: reload,
									children: t("action.reload")
								})]
							}), effortChoices.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
								className: ModelSelect_module_css_default.empty,
								children: t("empty.efforts")
							}) : effortChoices.map((level) => (0, react_jsx_runtime.jsxs)("button", {
								ref: itemRef(),
								type: "button",
								role: "menuitemradio",
								"aria-checked": effectiveEffort === level.effort,
								className: clsx(ModelSelect_module_css_default.option, effectiveEffort === level.effort && ModelSelect_module_css_default.selected),
								disabled: busy,
								onClick: () => {
									chooseEffort(level.effort);
								},
								children: [(0, react_jsx_runtime.jsxs)("span", {
									className: ModelSelect_module_css_default.optionCopy,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.modelName,
										children: level.label
									}), level.description !== void 0 && (0, react_jsx_runtime.jsx)("span", {
										className: ModelSelect_module_css_default.description,
										children: level.description
									})]
								}), (0, react_jsx_runtime.jsx)("span", {
									className: ModelSelect_module_css_default.check,
									children: effectiveEffort === level.effort ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : null
								})]
							}, level.key))] })
						]
					}),
					toast !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: toast.text,
						icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {}),
						anchor: rootRef.current?.closest("[data-composer-card]") ?? null,
						onDone: () => {
							setToast(null);
						}
					}, toast.seq)
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `model` namespace dictionaries.
		*
		* `trigger.selectAria` reads identically to `trigger.fallback` today and is
		* still a separate key: the visible fallback label and the accessible name of
		* an unset trigger are free to diverge per locale, and folding it into
		* `trigger.aria` would announce the degenerate "Select model, current Select
		* model".
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"command.description": "选择本会话使用的模型",
			"option.loadError": "目录加载失败：{message}",
			"trigger.fallback": "选择模型",
			"trigger.selectAria": "选择模型",
			"trigger.aria": "选择模型，当前 {model}",
			"trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",
			"menu.aria": "模型与推理等级",
			"menu.model": "模型",
			"menu.effort": "推理等级",
			"effort.providerDefault": "Default",
			"status.loading": "正在刷新模型列表…",
			"error.action": "模型操作失败：{message}",
			"action.reload": "重新加载",
			"warning.groupLoad": "{name} 加载失败：{message}",
			"empty.models": "没有可用的模型。",
			"blocked.composer": "当前模型不可用，请先选择模型",
			"empty.efforts": "当前模型未提供推理等级。"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"command.description": "Select the model for this conversation",
			"option.loadError": "Catalog failed to load: {message}",
			"trigger.fallback": "Select model",
			"trigger.selectAria": "Select model",
			"trigger.aria": "Select model, current {model}",
			"trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",
			"menu.aria": "Model and reasoning effort",
			"menu.model": "Model",
			"menu.effort": "Effort",
			"effort.providerDefault": "Default",
			"status.loading": "Refreshing model list…",
			"error.action": "Model operation failed: {message}",
			"action.reload": "Reload",
			"warning.groupLoad": "{name} failed to load: {message}",
			"empty.models": "No models available.",
			"blocked.composer": "This model is unavailable — select one to continue",
			"empty.efforts": "This model provides no reasoning effort levels."
		};
		//#endregion
		//#region lib/types/client/index.js
		/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
		function rowId(providerId, modelId) {
			return `${providerId}/${modelId}`;
		}
		/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
		function optionsOf(directory, t) {
			const rows = [];
			for (const group of directory.groups) for (const model of group.models) rows.push({
				id: rowId(group.id, model.id),
				label: model.name,
				detail: model.description !== void 0 ? `${group.name} · ${model.description}` : group.name,
				...directory.current.provider === group.id && directory.current.model === model.id ? { active: true } : {}
			});
			for (const failure of directory.failures) rows.push({
				id: `failure/${failure.id}`,
				label: failure.name,
				detail: t("option.loadError", { message: failure.message })
			});
			return rows;
		}
		/**
		* Resolve a picked row back to its model selection by matching against the loaded
		* groups (the same data the rows were built from — ids stay opaque).
		* @param state - the session's directory snapshot.
		* @param id - the picked row id.
		* @returns the row's model selection, or undefined for failure rows / stale ids.
		*/
		function selectionOf(state, id) {
			for (const group of state.groups) for (const model of group.models) {
				if (rowId(group.id, model.id) !== id) continue;
				const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
				return {
					provider: group.id,
					model: model.id,
					...reasoningEffort === void 0 ? {} : { reasoningEffort }
				};
			}
		}
		/** Dictionary namespace owned by this plugin. */
		const NS = "model";
		/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
		const inject = [
			"commandUi",
			"connection",
			"locale",
			"sessions",
			"slots",
			"remote"
		];
		/**
		* Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
		* then register the /model popup contribution and the composer model seat
		* over the service.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-model-selection: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.plugin(ModelDirectoryResolver, { blockReason: () => t("blocked.composer") });
			ctx.inject(["commandUi", "modelDirectories"], (scope) => {
				const command = scope.get("commandUi");
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.effect(() => command.register({
					name: "model",
					description: t("command.description"),
					available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
					ui: {
						kind: "popupSelect",
						options: async (session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							return optionsOf(await models.directoryFor(session.sessionId).load(), t);
						},
						onSelect: async (option, session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							const directory = models.directoryFor(session.sessionId);
							const selection = selectionOf(directory.store.getSnapshot(), option.id);
							if (selection === void 0) throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
							await directory.select(selection);
						}
					}
				}), "ui-model-selection: /model contribution");
			});
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.slots.inject("conversation.input.model", () => scope.slots.register({
					name: "conversation.input.model",
					locale: NS,
					inject: (sessionId) => {
						const directory = models.directoryFor(sessionId);
						const available = sessions.subagentAddress(sessionId) === void 0;
						return {
							available,
							directory: directory.store,
							load: () => {
								if (available) directory.load().catch(() => {});
							},
							select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false)
						};
					}
				}, XHarnessModelSelect));
			});
		}
		//#endregion
// XHARNESS MODEL CONTROLS BEGIN
// Product-owned extension of the upstream ModelDirectory, not a second settings store.
// Inserted by scripts/patch-model-controls.mjs; all carriers use the same RPCs.
async function xhModelRequest(directory, generation, promise) {
  try { return await promise; }
  catch (error) {
    if (!directory.disposed && directory.generation === generation) directory.store.update(s => {
      s.status = 'error'; s.error = error.message ?? String(error);
    });
    throw error;
  }
}
function xhModelInfo(state) {
  const current = state.current;
  const model = state.groups.find(g => g.id === current?.provider)?.models.find(m => m.id === current?.model);
  const maximum = Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined;
  return { current, model, maximum, effort: current?.reasoningEffort ?? model?.reasoning?.defaultEffort };
}
function xhContextSelection(state, raw) {
  const { current, maximum } = xhModelInfo(state);
  if (!current || !maximum) throw new Error('当前模型未提供上下文上限，无法调整。');
  if (!/^\d+$/.test(raw.trim())) throw new Error('请输入正整数 Token 数量。');
  const tokens = Number(raw);
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > maximum) throw new Error(`请输入 1–${maximum.toLocaleString()} 之间的 Token 数量。`);
  return { ...current, contextWindowTokens: tokens };
}
function xhTokenLabel(value) {
  if (!Number.isSafeInteger(value) || value < 1) return '未知';
  return value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString();
}
// Only the context form is product-owned; model/effort navigation stays upstream.
function XHarnessContextPane({ locked, directory, load, select, back, saved }) {
  const h = react.createElement;
  const state = react.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
  const { current, model, maximum } = xhModelInfo(state);
  const currentTokens = current?.contextWindowTokens ?? maximum;
  const [draft, setDraft] = react.useState(String(currentTokens ?? ''));
  const [error, setError] = react.useState(null);
  const [saving, setSaving] = react.useState(false);
  const version = react.useRef(0);
  const busy = saving || state.status === 'loading' || state.status === 'selecting';
  const identity = JSON.stringify([current, maximum]);
  react.useEffect(() => {
    setDraft(String(currentTokens ?? '')); setError(null); setSaving(false);
  }, [identity]);
  react.useEffect(() => { ++version.current; }, [current?.provider, current?.model]);
  react.useEffect(() => () => { ++version.current; }, []);
  async function submit(event) {
    event.preventDefault();
    if (locked || busy || !maximum) return;
    let selection;
    try { selection = xhContextSelection(directory.getSnapshot(), draft); }
    catch (e) { setError(e.message); return; }
    const generation = version.current;
    setSaving(true); setError(null);
    try {
      const ok = await select(selection);
      if (generation !== version.current) return;
      if (!ok) throw new Error(directory.getSnapshot().error ?? '保存失败，请重试。');
      const actual = directory.getSnapshot().current;
      if (['provider', 'model', 'reasoningEffort', 'contextWindowTokens'].every(key => actual?.[key] === selection[key])) saved();
    } catch (e) {
      if (generation === version.current) setError(e.message ?? String(e));
    } finally {
      if (generation === version.current) setSaving(false);
    }
  }
  return h('form', { className: 'xh-context-form', onSubmit: submit }, [
    h('button', { key: 'back', type: 'button', onClick: back }, '← 返回模型设置'),
    h('h3', { key: 'title' }, '上下文容量'),
    h('p', { key: 'scope' }, '仅影响后续请求，不改变正在运行的请求。'),
    h('label', { key: 'label' }, ['Token 数量', h('input', { key: 'input', autoFocus: true, type: 'text', inputMode: 'numeric', 'aria-label': '上下文 Token 数量', value: draft, readOnly: busy, disabled: locked, onChange: e => { setDraft(e.target.value); setError(null); } })]),
    h('p', { key: 'limit' }, `当前模型有效上限：${maximum?.toLocaleString() ?? '未知'} tokens（${model?.contextWindowSource ?? '来源未标注'}）`),
    !maximum && h('p', { key: 'unknown' }, '当前模型未提供上限，暂时无法调整。'),
    (error || state.error) && h('p', { key: 'error', role: 'alert' }, error || state.error),
    state.status === 'error' && h('button', { key: 'retry', type: 'button', onClick: load }, '重新获取'),
    h('div', { key: 'actions', className: 'xh-context-actions' }, [
      h('button', { key: 'max', type: 'button', disabled: busy || locked || !maximum, onClick: () => { setDraft(String(maximum)); setError(null); } }, '填入上限'),
      h('button', { key: 'save', type: 'submit', disabled: busy || locked || !maximum }, saving ? '保存中…' : '保存'),
    ]),
  ]);
}
function XHarnessContextRow({ state, itemRef, open }) {
  const h = react.createElement, css = ModelSelect_module_css_default;
  const { current, maximum } = xhModelInfo(state);
  return h('button', {ref: itemRef, type: 'button', role: 'menuitem', className: css.cell, onClick: open},
    h('span', {className: css.cellLabel}, '上下文容量'),
    h('span', {className: css.cellValue}, xhTokenLabel(current?.contextWindowTokens ?? maximum)),
    h(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {className: css.cellChevron}));
}
function XHarnessModelSelect(props) {
  return react.createElement(react.Fragment, null,
    react.createElement('style', null, `.xh-context-form{box-sizing:border-box;width:300px;max-width:calc(100vw - 48px);padding:10px;font-size:13px;overflow:auto}.xh-context-form h3{font-size:14px;margin:12px 0 6px}.xh-context-form p{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:8px 0}.xh-context-form input{display:block;box-sizing:border-box;width:100%;padding:8px;margin-top:6px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#aaa);border-radius:6px}.xh-context-form button{padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:transparent;color:inherit;cursor:pointer}.xh-context-form button:disabled{opacity:.5;cursor:default}.xh-context-form [role=alert]{color:var(--dsw-alias-state-error-label,#c33)}.xh-context-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}`),
    react.createElement(ModelSelect, props));
}
// XHARNESS MODEL CONTROLS END
		exports.ModelDirectory = ModelDirectory;
        exports.XHarnessModelSelect = XHarnessModelSelect;
        exports.xhContextSelection = xhContextSelection;
        exports.xhModelInfo = xhModelInfo;
		exports.ModelDirectoryResolver = ModelDirectoryResolver;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
