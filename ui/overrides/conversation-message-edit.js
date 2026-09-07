		// XHarness keeps the transcript immutable: editing copies an earlier user
		// message into the composer, where it can be changed and sent as a new turn.
		function xhEditMessage(inputHub, sessionId, text, root = document) {
			inputHub.shell(sessionId).setDraft(text);
			const focus = () => {
				const input = root.querySelector("[data-composer-seat] textarea");
				if (input === null) return;
				input.focus();
				input.setSelectionRange(text.length, text.length);
				input.scrollIntoView({ block: "nearest" });
			};
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
			else focus();
		}
		function XHarnessEditIcon() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M3 11.75V13h1.25l7.37-7.37-1.25-1.25L3 11.75Zm8.25-8.25 1.25 1.25.5-.5a.88.88 0 0 0 0-1.25.88.88 0 0 0-1.25 0l-.5.5Z",
					stroke: "currentColor",
					strokeWidth: 1.25,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		function XHarnessEditAction({ text, editMessage, t }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("message.edit"),
				side: "bottom",
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: MessageIconActions_module_css_default.action,
					"aria-label": t("message.edit"),
					"data-message-edit": "",
					onClick: () => editMessage(text),
					children: (0, react_jsx_runtime.jsx)(XHarnessEditIcon, {})
				})
			});
		}
