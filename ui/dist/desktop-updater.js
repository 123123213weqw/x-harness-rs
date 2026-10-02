"use strict";
(() => {
  // src/modules/shared/runtime-types.ts
  function isObjectRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/desktop/updater.ts
  function updateAction(value) {
    return value === "check" || value === "download" || value === "install";
  }
  function nullableText(value) {
    return typeof value === "string" || value === null ? value : void 0;
  }
  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function decodeState(value) {
    if (!isObjectRecord(value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq)) return;
    if (value.phase !== void 0 && typeof value.phase !== "string") return;
    for (const key of ["version", "message", "notes"]) {
      if (value[key] !== void 0 && value[key] !== null && typeof value[key] !== "string") return;
    }
    if (value.retryAction !== void 0 && value.retryAction !== null && !updateAction(value.retryAction)) return;
    if (value.downloaded !== void 0 && finiteNumber(value.downloaded) === void 0) return;
    if (value.total !== void 0 && value.total !== null && finiteNumber(value.total) === void 0) return;
    return {
      ...value,
      seq: value.seq,
      phase: value.phase,
      version: nullableText(value.version),
      message: nullableText(value.message),
      notes: nullableText(value.notes),
      retryAction: updateAction(value.retryAction) ? value.retryAction : void 0,
      downloaded: finiteNumber(value.downloaded),
      total: value.total === null ? null : finiteNumber(value.total)
    };
  }
  (() => {
    const busyPhases = /* @__PURE__ */ new Set(["checking", "downloading", "stopping-host", "host-force-stopped", "installing", "recovering-host", "installed"]);
    function updateView(state) {
      const phase = state.phase ?? "idle";
      const view = { label: "XHarness \u684C\u9762\u66F4\u65B0", action: "\u68C0\u67E5\u66F4\u65B0", busy: busyPhases.has(phase), emphasized: false };
      if (phase === "available") return { ...view, label: "\u53D1\u73B0 XHarness " + (state.version ?? "\u65B0\u7248\u672C"), action: "\u4E0B\u8F7D\u66F4\u65B0", emphasized: true };
      if (phase === "checking") return { ...view, label: "\u6B63\u5728\u68C0\u67E5\u66F4\u65B0\u2026", action: "\u68C0\u67E5\u4E2D" };
      if (phase === "downloading") {
        const percent = typeof state.total === "number" && state.total > 0 ? " " + Math.max(0, Math.min(100, Math.round((state.downloaded ?? 0) / state.total * 100))) + "%" : "";
        return { ...view, label: "\u6B63\u5728\u4E0B\u8F7D\u66F4\u65B0" + percent, action: "\u4E0B\u8F7D\u4E2D", emphasized: true };
      }
      if (phase === "downloaded") return { ...view, label: "\u66F4\u65B0\u5DF2\u4E0B\u8F7D\u5E76\u9A8C\u8BC1\uFF0C\u53EF\u7A0D\u540E\u91CD\u542F", action: "\u91CD\u542F\u66F4\u65B0", emphasized: true };
      if (view.busy) return { ...view, label: state.message ?? (phase === "installed" ? "\u66F4\u65B0\u5B8C\u6210\uFF0C\u6B63\u5728\u91CD\u542F\u2026" : "\u6B63\u5728\u5B89\u5168\u5B89\u88C5\u66F4\u65B0\u2026"), action: "\u5B89\u88C5\u4E2D", emphasized: true };
      if (phase === "error") return { ...view, label: state.message ?? "\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5", action: "\u91CD\u8BD5" };
      if (phase === "up-to-date") return { ...view, label: "XHarness \u5DF2\u662F\u6700\u65B0\u7248\u672C", action: "\u518D\u6B21\u68C0\u67E5" };
      return view;
    }
    function createController(invoke2, changed = () => {
    }) {
      let state = { seq: -1, phase: "idle" };
      let pending = false;
      let confirming = false;
      function notify() {
        changed(state, { pending, confirming });
      }
      function accept(value) {
        const next = decodeState(value);
        if (!next || next.seq < state.seq) return;
        state = next;
        if (busyPhases.has(state.phase ?? "")) confirming = false;
        notify();
      }
      async function execute(action2) {
        if (pending || busyPhases.has(state.phase ?? "")) return;
        pending = true;
        confirming = false;
        const before = state.seq;
        notify();
        try {
          const command = { check: "desktop_check_update", download: "desktop_download_update", install: "desktop_install_update" }[action2];
          accept(await invoke2(command, action2 === "install" ? { confirmStop: true } : void 0));
        } catch (error) {
          try {
            accept(await invoke2("desktop_update_status"));
          } catch {
          }
          if (state.seq <= before && !busyPhases.has(state.phase ?? "")) {
            state = { ...state, phase: "error", retryAction: action2, message: String(error) };
          }
        } finally {
          pending = false;
          notify();
        }
      }
      return {
        get state() {
          return state;
        },
        get confirming() {
          return confirming;
        },
        accept,
        async restore() {
          accept(await invoke2("desktop_update_status"));
        },
        check() {
          if (["idle", "up-to-date", "available"].includes(state.phase ?? "") || state.phase === "error" && state.retryAction === "check") return execute("check");
        },
        act() {
          if (pending || busyPhases.has(state.phase ?? "")) return;
          const action2 = state.phase === "error" ? state.retryAction ?? "check" : state.phase === "downloaded" ? "install" : state.phase === "available" ? "download" : "check";
          if (action2 === "install") {
            confirming = true;
            notify();
            return;
          }
          return execute(action2);
        },
        confirm() {
          if (confirming) return execute("install");
        },
        dismiss() {
          confirming = false;
          notify();
        }
      };
    }
    window.__XHARNESS_DESKTOP_UPDATER_TEST__ = { updateView, createController };
    const invoke = window.__TAURI__?.core?.invoke;
    const listen = window.__TAURI__?.event?.listen;
    if (typeof invoke !== "function" || typeof listen !== "function" || typeof document === "undefined" || !document.body) return;
    let expanded = false;
    let bootError = null;
    const host = document.createElement("div");
    host.id = "xharness-desktop-updater";
    host.hidden = true;
    host.style.cssText = "position:fixed;left:11px;bottom:64px;z-index:11";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      :host{color-scheme:light dark} *{box-sizing:border-box}
      .panel{position:absolute;bottom:46px;left:0;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 126px);overflow:auto;padding:16px;border-radius:16px;
        background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        box-shadow:0 12px 40px #0003;font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
      [hidden]{display:none!important}.header{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .title{font-size:14px;font-weight:650}.text{margin:12px 0;overflow-wrap:anywhere}
      .notes{max-height:160px;overflow:auto;white-space:pre-wrap;font:inherit;border-top:1px solid #8883;padding-top:10px}
      .footer{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.hint{opacity:.65;font-size:12px;margin-top:10px}
      button{appearance:none;border:0;border-radius:9px;padding:8px 12px;font:inherit;cursor:pointer;background:color-mix(in srgb,CanvasText 8%,Canvas);color:CanvasText}
      button:hover{filter:brightness(.93)}button:focus-visible{outline:2px solid #3974ff;outline-offset:3px}
      button:disabled{cursor:wait;opacity:.65}.primary{background:#2463eb;color:white}
      .toggle{position:relative;width:34px;height:34px;padding:8px;display:grid;place-items:center;border-radius:10px;background:Canvas;color:CanvasText;border:1px solid #8883}
      .toggle.primary{background:#2463eb;color:white;border-color:transparent;box-shadow:0 3px 12px #2463eb33}
      .toggle svg{width:18px;height:18px}.close{font-size:18px;line-height:1;padding:4px 8px;background:transparent}
      progress{width:100%;height:6px;accent-color:#2463eb}.confirm{margin-top:12px;padding:10px;border:1px solid #d99b3444;border-radius:8px}
      @media(prefers-reduced-motion:no-preference){.busy svg{animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}}
    </style>
    <section class="panel" hidden role="dialog" aria-modal="false" aria-label="XHarness \u8F6F\u4EF6\u66F4\u65B0">
      <div class="header"><span class="title">XHarness \u66F4\u65B0</span><button class="close" aria-label="\u5173\u95ED\u66F4\u65B0\u9762\u677F">\xD7</button></div>
      <div class="text" role="status" aria-live="polite"></div>
      <progress hidden aria-label="\u66F4\u65B0\u4E0B\u8F7D\u8FDB\u5EA6"></progress>
      <pre class="notes" hidden></pre>
      <div class="confirm" hidden>\u91CD\u542F\u5C06\u505C\u6B62\u5F53\u524D Agent\u3001\u5DE5\u5177\u548C\u540E\u53F0 Job\u3002\u4F1A\u8BDD\u4F1A\u4FDD\u5B58\uFF0C\u4F46\u8FD0\u884C\u4E2D\u7684\u547D\u4EE4\u4E0D\u4FDD\u8BC1\u81EA\u52A8\u6062\u590D\u3002\u786E\u8BA4\u73B0\u5728\u66F4\u65B0\uFF1F</div>
      <div class="footer"><button class="later" hidden>\u7A0D\u540E</button><button class="action primary">\u68C0\u67E5\u66F4\u65B0</button></div>
      <div class="hint">\u4E0B\u8F7D\u4E0D\u5F71\u54CD\u5F53\u524D\u5DE5\u4F5C\uFF1B\u5B89\u88C5\u9700\u8981\u91CD\u542F\u5E94\u7528\u3002</div>
      <div class="footer"><button class="diagnostics">\u8FD0\u884C\u8BCA\u65AD</button></div>
    </section>
    <button class="toggle" aria-label="\u68C0\u67E5 XHarness \u66F4\u65B0" aria-expanded="false" title="XHarness \u66F4\u65B0">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>
    </button>`;
    document.body.append(host);
    const $ = (selector) => {
      const node = root.querySelector(selector);
      if (!(node instanceof HTMLElement)) throw Error("desktop updater: missing element " + selector);
      return node;
    };
    const progressElement = () => {
      const node = root.querySelector("progress");
      if (!(node instanceof HTMLProgressElement)) throw Error("desktop updater: missing progress");
      return node;
    };
    $(".diagnostics").addEventListener("click", async () => {
      try {
        await invoke("desktop_open_diagnostics");
      } catch {
        $(".hint").textContent = "\u65E0\u6CD5\u6253\u5F00\u8FD0\u884C\u8BCA\u65AD\uFF0C\u8BF7\u91CD\u542F\u5BA2\u6237\u7AEF\u540E\u518D\u8BD5\u3002";
      }
    });
    const panel = $(".panel"), toggle = $(".toggle"), action = root.querySelector(".action");
    if (!(action instanceof HTMLButtonElement)) throw Error("desktop updater: missing action button");
    const text = $(".text"), notes = $(".notes"), progress = progressElement(), confirmation = $(".confirm"), later = $(".later");
    const controller = createController(invoke, (state, { pending, confirming }) => {
      const view = bootError ? { label: "\u684C\u9762\u66F4\u65B0\u521D\u59CB\u5316\u5931\u8D25\uFF1A" + bootError, action: "\u66F4\u65B0\u4E0D\u53EF\u7528", busy: false, emphasized: false } : updateView(state);
      panel.hidden = !expanded;
      toggle.classList.toggle("primary", view.emphasized);
      toggle.classList.toggle("busy", view.busy || pending);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", view.label);
      toggle.title = view.label;
      text.textContent = view.label;
      notes.textContent = state.notes ?? "";
      notes.hidden = !notes.textContent;
      action.textContent = confirming ? "\u505C\u6B62\u4EFB\u52A1\u5E76\u91CD\u542F\u66F4\u65B0" : view.action;
      action.disabled = Boolean(bootError) || pending || view.busy;
      confirmation.hidden = !confirming;
      later.hidden = !confirming;
      progress.hidden = state.phase !== "downloading";
      if (typeof state.total === "number" && state.total > 0) {
        progress.max = state.total;
        progress.value = Math.min(state.downloaded ?? 0, state.total);
      } else progress.removeAttribute("value");
    });
    function collapse() {
      expanded = false;
      controller.dismiss();
    }
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      controller.dismiss();
    });
    $(".close").addEventListener("click", collapse);
    later.addEventListener("click", () => controller.dismiss());
    action.addEventListener("click", () => controller.confirming ? controller.confirm() : controller.act());
    root.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        collapse();
        toggle.focus();
      }
    });
    let disposed = false;
    let unlisten, initialTimer, periodicTimer;
    window.addEventListener("pagehide", () => {
      disposed = true;
      unlisten?.();
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
    }, { once: true });
    const boot = async () => {
      const status = await invoke("desktop_status");
      if (!isObjectRecord(status) || typeof status.updaterConfigured !== "boolean")
        throw Error("desktop updater: invalid desktop status");
      if (!status.updaterConfigured || disposed) return;
      unlisten = await listen("xharness-update", ({ payload }) => controller.accept(payload));
      if (disposed) {
        unlisten();
        return;
      }
      await controller.restore();
      if (disposed) return;
      host.hidden = false;
      initialTimer = window.setTimeout(() => controller.check(), 1500);
      periodicTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") controller.check();
      }, 6 * 60 * 60 * 1e3);
    };
    boot().catch((error) => {
      unlisten?.();
      if (disposed) {
        host.remove();
        return;
      }
      bootError = String(error);
      host.hidden = false;
      controller.dismiss();
    });
  })();
})();
