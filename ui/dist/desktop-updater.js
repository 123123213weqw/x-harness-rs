"use strict";
(() => {
  // src/modules/shared/runtime-types.ts
  function isObjectRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/desktop/updater.ts
  function decodePlan(value) {
    if (!isObjectRecord(value) || typeof value.needsChoice !== "boolean") throw Error("Invalid installation permission reply");
    if (value.needsChoice && (typeof value.currentDirectory !== "string" || typeof value.userDirectory !== "string" || typeof value.migrationAvailable !== "boolean")) throw Error("Incomplete installation permission reply");
    if (value.reason !== void 0 && value.reason !== null && typeof value.reason !== "string") throw Error("Invalid installation permission reason");
    return {
      needsChoice: value.needsChoice,
      currentDirectory: typeof value.currentDirectory === "string" ? value.currentDirectory : void 0,
      userDirectory: typeof value.userDirectory === "string" ? value.userDirectory : void 0,
      migrationAvailable: typeof value.migrationAvailable === "boolean" ? value.migrationAvailable : void 0,
      reason: nullableText(value.reason)
    };
  }
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
    }, options = {}) {
      let state = { seq: -1, phase: "idle" };
      let pending = false;
      let confirming = false;
      let disposed2 = false;
      let automaticAttempts = 0;
      let plan;
      let placement;
      let preparation = 0;
      function resetConsent() {
        confirming = false;
        plan = void 0;
        placement = void 0;
        preparation++;
      }
      function notify() {
        changed(state, { pending, confirming, plan, placement });
      }
      async function prepareInstall() {
        if (disposed2 || pending || busyPhases.has(state.phase ?? "")) return;
        if (!options.preflight) {
          confirming = true;
          notify();
          return;
        }
        resetConsent();
        pending = true;
        const generation = preparation, before = state.seq;
        notify();
        try {
          const reply = decodePlan(await invoke2("desktop_update_preflight"));
          if (disposed2 || generation !== preparation || state.seq !== before) return;
          plan = reply;
          confirming = !reply.needsChoice;
        } catch (error) {
          if (!disposed2 && generation === preparation && state.seq === before)
            state = { ...state, phase: "error", retryAction: "install", message: String(error) };
        } finally {
          pending = false;
          notify();
        }
      }
      function accept(value) {
        const next = decodeState(value);
        if (!next || next.seq < state.seq) return;
        if (busyPhases.has(next.phase ?? "") || next.seq !== state.seq && (confirming || plan)) resetConsent();
        state = next;
        notify();
      }
      async function execute(action2) {
        if (disposed2 || pending || busyPhases.has(state.phase ?? "")) return;
        const installPlacement = placement;
        pending = true;
        resetConsent();
        const before = state.seq;
        notify();
        try {
          const command = { check: "desktop_check_update", download: "desktop_download_update", install: "desktop_install_update" }[action2];
          accept(await invoke2(command, action2 === "install" ? { confirmStop: true, ...installPlacement ? { placement: installPlacement } : {} } : void 0));
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
        get plan() {
          return plan;
        },
        enablePreflight() {
          options.preflight = true;
        },
        choose(value) {
          if (disposed2 || pending || !plan?.needsChoice || confirming || value === "user" && !plan.migrationAvailable) return;
          if (value !== "user" && value !== "current") return;
          placement = value;
          confirming = true;
          notify();
        },
        get retryDelay() {
          if (disposed2 || pending || confirming || plan || state.phase !== "error" || state.retryAction === "install") return;
          return [3e4, 12e4, 6e5][automaticAttempts - 1];
        },
        accept,
        async restore() {
          accept(await invoke2("desktop_update_status"));
        },
        async prepare() {
          if (disposed2 || pending || confirming || plan || busyPhases.has(state.phase ?? "") || automaticAttempts >= 4) return;
          if (state.phase === "downloaded" || state.phase === "error" && state.retryAction === "install") return;
          automaticAttempts++;
          if (state.phase !== "available" && !(state.phase === "error" && state.retryAction === "download")) await execute("check");
          if (disposed2) return;
          if (state.phase === "available" || state.phase === "error" && state.retryAction === "download") await execute("download");
          if (state.phase === "downloaded" || state.phase === "up-to-date") automaticAttempts = 0;
          notify();
        },
        dispose() {
          disposed2 = true;
          resetConsent();
        },
        check() {
          if (["idle", "up-to-date", "available"].includes(state.phase ?? "") || state.phase === "error" && state.retryAction === "check") return execute("check");
        },
        act() {
          automaticAttempts = 0;
          if (pending || busyPhases.has(state.phase ?? "")) return;
          const action2 = state.phase === "error" ? state.retryAction ?? "check" : state.phase === "downloaded" ? "install" : state.phase === "available" ? "download" : "check";
          if (action2 === "install") return prepareInstall();
          return execute(action2);
        },
        confirm() {
          if (confirming) return execute("install");
        },
        dismiss() {
          resetConsent();
          notify();
        }
      };
    }
    window.__XHARNESS_DESKTOP_UPDATER_TEST__ = { updateView, createController };
    const invoke = window.__TAURI__?.core?.invoke;
    const listen = window.__TAURI__?.event?.listen;
    if (typeof invoke !== "function" || typeof listen !== "function" || typeof document === "undefined" || !document.body) return;
    let expanded = false;
    let disposed = false;
    let retryTimer;
    let scheduledRetry;
    let bootError = null;
    const host = document.createElement("div");
    host.id = "xharness-desktop-updater";
    host.hidden = true;
    host.style.cssText = "position:fixed;left:11px;bottom:104px;z-index:11";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      :host{color-scheme:light dark} *{box-sizing:border-box}
      .panel{position:absolute;bottom:46px;left:0;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 166px);overflow:auto;padding:16px;border-radius:16px;
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
      <div class="placement" hidden></div>
      <div class="confirm" hidden>\u91CD\u542F\u5C06\u505C\u6B62\u5F53\u524D Agent\u3001\u5DE5\u5177\u548C\u540E\u53F0 Job\u3002\u4F1A\u8BDD\u4F1A\u4FDD\u5B58\uFF0C\u4F46\u8FD0\u884C\u4E2D\u7684\u547D\u4EE4\u4E0D\u4FDD\u8BC1\u81EA\u52A8\u6062\u590D\u3002\u786E\u8BA4\u73B0\u5728\u66F4\u65B0\uFF1F</div>
      <div class="footer"><button class="later" hidden>\u7A0D\u540E</button><button class="current-place" hidden></button><button class="action primary">\u68C0\u67E5\u66F4\u65B0</button></div>
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
    let anchorSlot = null;
    let anchorStarted = false;
    let anchorFrame;
    function scheduleAnchor() {
      if (disposed || anchorFrame !== void 0) return;
      anchorFrame = window.requestAnimationFrame(() => {
        anchorFrame = void 0;
        if (!disposed) positionAnchor();
      });
    }
    const anchorSize = new ResizeObserver(scheduleAnchor);
    const anchorMount = new MutationObserver(() => {
      if (!anchorSlot?.isConnected) scheduleAnchor();
    });
    function positionAnchor() {
      const nextSlot = document.getElementById("xharness-sidebar-updater-slot");
      if (nextSlot !== anchorSlot) {
        anchorSize.disconnect();
        if (anchorSlot) anchorSlot.hidden = true;
        anchorSlot = nextSlot;
        if (anchorSlot) {
          anchorSlot.style.cssText = "height:42px;flex:none;width:100%";
          anchorSlot.hidden = false;
          anchorSize.observe(anchorSlot);
          if (anchorSlot.parentElement) anchorSize.observe(anchorSlot.parentElement);
        }
      }
      if (anchorSlot) {
        const rect = anchorSlot.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const left = Math.max(0, Math.min(rect.left + 1, window.innerWidth - 34));
          const top = Math.max(0, Math.min(rect.top + 4, window.innerHeight - 34));
          host.style.left = left + "px";
          host.style.top = top + "px";
          host.style.bottom = "auto";
          panel.style.maxHeight = Math.max(0, top - 28) + "px";
          return;
        }
      }
      host.style.left = "11px";
      host.style.top = "auto";
      host.style.bottom = "104px";
      panel.style.maxHeight = "calc(100vh - 166px)";
    }
    function showAnchor() {
      if (!anchorStarted) {
        anchorStarted = true;
        anchorMount.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", positionAnchor);
      }
      host.hidden = false;
      positionAnchor();
    }
    const tr = (zh, en) => (document.documentElement.lang || navigator.language || "en").startsWith("zh") ? zh : en;
    const placementBox = $(".placement"), currentPlace = root.querySelector(".current-place");
    if (!(currentPlace instanceof HTMLButtonElement)) throw Error("desktop updater: missing placement button");
    const controller = createController(invoke, (state, { pending, confirming, plan, placement }) => {
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
      const choosing = Boolean(plan?.needsChoice && !confirming);
      placementBox.hidden = !choosing;
      placementBox.textContent = choosing ? [
        tr("\u65E7\u5B89\u88C5\u4F4D\u7F6E\u9700\u8981\u6743\u9650\u786E\u8BA4\uFF0C\u5EFA\u8BAE\u8FC1\u79FB\u5230\u7528\u6237\u76EE\u5F55\uFF0C\u540E\u7EED\u66F4\u65B0\u65E0\u9700\u7BA1\u7406\u5458\u6743\u9650\u3002", "The current installation needs a permission decision. Move to your user directory for future non-admin updates."),
        plan?.userDirectory ?? "",
        tr("\u4F1A\u8BDD\u4E0E\u914D\u7F6E\u4E0D\u53D8\uFF1B\u65E7\u5B89\u88C5\u4E0D\u4F1A\u81EA\u52A8\u5220\u9664\u3002", "Conversations and settings are preserved. The old installation will not be deleted."),
        plan?.migrationAvailable ? "" : plan?.reason ?? tr("\u6682\u4E0D\u53EF\u8FC1\u79FB", "Migration unavailable")
      ].filter(Boolean).join("\n") : "";
      placementBox.style.whiteSpace = "pre-wrap";
      placementBox.style.overflowWrap = "anywhere";
      currentPlace.hidden = !choosing;
      currentPlace.textContent = tr("\u4FDD\u7559\u539F\u4F4D\u7F6E\u66F4\u65B0", "Keep current location");
      currentPlace.disabled = pending || view.busy;
      confirmation.textContent = (placement === "user" ? tr("\u5C06\u8FC1\u79FB\u5230\u7528\u6237\u76EE\u5F55\u3002", "Move to your user directory. ") : "") + tr("\u91CD\u542F\u5C06\u505C\u6B62\u5F53\u524D Agent\u3001\u5DE5\u5177\u548C\u540E\u53F0\u4EFB\u52A1\u3002\u4F1A\u8BDD\u4F1A\u4FDD\u5B58\uFF0C\u8FD0\u884C\u4E2D\u7684\u547D\u4EE4\u4E0D\u4FDD\u8BC1\u81EA\u52A8\u6062\u590D\u3002", "Restart will stop running agents, tools and jobs. Conversations are saved; running commands may not resume.");
      action.textContent = choosing ? tr("\u8FC1\u79FB\u5E76\u66F4\u65B0\uFF08\u63A8\u8350\uFF09", "Migrate & update (recommended)") : confirming ? tr("\u505C\u6B62\u4EFB\u52A1\u5E76\u91CD\u542F\u66F4\u65B0", "Stop tasks & update") : view.action;
      action.disabled = Boolean(bootError) || pending || view.busy || choosing && !plan?.migrationAvailable;
      confirmation.hidden = !confirming;
      later.hidden = !confirming && !choosing;
      later.textContent = tr("\u7A0D\u540E", "Later");
      progress.hidden = state.phase !== "downloading";
      if (typeof state.total === "number" && state.total > 0) {
        progress.max = state.total;
        progress.value = Math.min(state.downloaded ?? 0, state.total);
      } else progress.removeAttribute("value");
      const delay = controller.retryDelay;
      const retryKey = !disposed && delay !== void 0 ? `${state.seq}:${state.retryAction}:${delay}` : void 0;
      if (retryKey !== scheduledRetry) {
        window.clearTimeout(retryTimer);
        retryTimer = void 0;
        scheduledRetry = retryKey;
        if (retryKey !== void 0 && delay !== void 0) retryTimer = window.setTimeout(() => {
          retryTimer = void 0;
          return prepare();
        }, delay);
      }
    });
    const prepare = () => {
      if (disposed || typeof navigator !== "undefined" && navigator.onLine === false) return;
      return controller.prepare();
    };
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
    currentPlace.addEventListener("click", () => controller.choose("current"));
    action.addEventListener("click", () => controller.confirming ? controller.confirm() : controller.plan?.needsChoice ? controller.choose("user") : controller.act());
    root.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        collapse();
        toggle.focus();
      }
    });
    let unlisten, initialTimer, periodicTimer;
    const online = () => {
      if (!disposed && document.visibilityState === "visible") prepare();
    };
    window.addEventListener("online", online);
    window.addEventListener("pagehide", () => {
      disposed = true;
      controller.dispose();
      anchorMount.disconnect();
      anchorSize.disconnect();
      if (anchorFrame !== void 0) window.cancelAnimationFrame(anchorFrame);
      window.removeEventListener("resize", positionAnchor);
      if (anchorSlot) anchorSlot.hidden = true;
      unlisten?.();
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
      window.clearTimeout(retryTimer);
      window.removeEventListener("online", online);
    }, { once: true });
    const boot = async () => {
      const status = await invoke("desktop_status");
      if (!isObjectRecord(status) || typeof status.updaterConfigured !== "boolean")
        throw Error("desktop updater: invalid desktop status");
      if (!status.updaterConfigured || disposed) return;
      if (status.updatePreflightSupported === true) controller.enablePreflight();
      unlisten = await listen("xharness-update", ({ payload }) => controller.accept(payload));
      if (disposed) {
        unlisten();
        return;
      }
      await controller.restore();
      if (disposed) return;
      showAnchor();
      initialTimer = window.setTimeout(prepare, 1500);
      periodicTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") prepare();
      }, 6 * 60 * 60 * 1e3);
    };
    boot().catch((error) => {
      unlisten?.();
      if (disposed) {
        host.remove();
        return;
      }
      bootError = String(error);
      showAnchor();
      controller.dismiss();
    });
  })();
})();
