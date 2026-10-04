"use strict";
(() => {
  // src/startup/surface.raw.css
  var surface_raw_default = `/* One geometry/palette for both documents; no React/theme plugin is required. */
:root {
  --xh-startup-bg: #fafafa;
  --xh-startup-text: #232427;
  --xh-startup-muted: #75777d;
  --xh-startup-error: #b42332;
}
@media (prefers-color-scheme: dark) {
  :root { --xh-startup-bg: #101113; --xh-startup-text: #eeeff1; --xh-startup-muted: #989ba2; --xh-startup-error: #ff9b9b; }
}
body[data-ds-dark-theme] [data-xh-startup] {
  --xh-startup-bg: #101113; --xh-startup-text: #eeeff1; --xh-startup-muted: #989ba2; --xh-startup-error: #ff9b9b;
}
html[data-xh-startup-document], html[data-xh-startup-document] body, html[data-xh-startup-document] #state {
  height: 100%; margin: 0; background: var(--xh-startup-bg); color-scheme: light dark;
}
/* The Host document initially has an empty root. Match the local document
   before ESM execution instead of painting the browser's default white. */
body:has(> #root:empty) { background: var(--xh-startup-bg); }
html[data-xh-startup-document][data-xh-mac-titlebar="overlay"] #state {
  position: relative; top: 32px; height: calc(100% - 32px);
}
html[data-xh-startup-document] .titlebar-drag { display: none; }
html[data-xh-startup-document][data-xh-mac-titlebar="overlay"] .titlebar-drag {
  display: block; position: absolute; top: 0; left: 80px; right: 0; height: 32px; z-index: 1;
}
[data-xh-startup] {
  height: 100%; min-height: 180px; display: grid; place-items: center; overflow: hidden;
  color: var(--dsw-alias-label-primary, var(--xh-startup-text));
  background: var(--dsw-alias-bg-base, var(--xh-startup-bg));
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
}
[data-xh-startup] .xh-startup-cluster {
  width: min(560px, calc(100% - 48px)); display: flex; flex-direction: column; align-items: center;
  text-align: center; transform: translateY(-12px);
}
[data-xh-startup] .xh-startup-mark { width: 94px; height: 94px; display: block; flex: none; }
[data-xh-startup][data-motion="pending"] .xh-startup-mark { transform: scale(5); }
[data-xh-startup][data-motion="pending"] .xh-startup-copy { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  [data-xh-startup][data-motion="pending"] .xh-startup-mark { transform: none; }
  [data-xh-startup][data-motion="pending"] .xh-startup-copy { opacity: 1; }
}
[data-xh-startup][data-motion="playing"] .xh-startup-mark { will-change: transform; }
[data-xh-startup] .xh-startup-copy { width: 100%; margin-top: 10px; }
[data-xh-startup] h1 { margin: 0; font-size: 18px; line-height: 1.4; font-weight: 500; letter-spacing: -.025em; }
[data-xh-startup] .xh-startup-message { margin: 11px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--xh-startup-muted)); overflow-wrap: anywhere; }
[data-xh-startup][data-failed] .xh-startup-message { color: var(--xh-startup-error); }
[data-xh-startup] .xh-startup-report {
  margin-top: 16px; max-height: 40vh; overflow: auto; text-align: left; font: 12px/1.5 ui-monospace, 'SF Mono', Consolas, monospace;
  color: var(--dsw-alias-label-secondary, var(--xh-startup-muted)); white-space: pre-wrap; overflow-wrap: anywhere;
}
[data-xh-startup] .xh-startup-report[hidden] { display: none; }
[data-xh-startup] .xh-startup-report > div + div { margin-top: 8px; }
/* Outside the React mount point: no hydration mismatch or input interception.
   Scope to the actual content bounds so the native titlebar remains usable. */
[data-xh-startup][data-xh-startup-exit] {
  position: fixed; min-height: 0; z-index: 2147483000; pointer-events: none;
  user-select: none; contain: paint;
}
[data-xh-startup][data-xh-startup-exit] .xh-startup-mark { will-change: transform; }
@media (forced-colors: active) {
  [data-xh-startup] { color: CanvasText; background: Canvas; }
  [data-xh-startup] .xh-startup-message, [data-xh-startup] .xh-startup-report { color: CanvasText; }
}
`;

  // src/startup/mark.svg
  var mark_default = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">\n  <defs>\n    <linearGradient id="under" x1="864" y1="136" x2="160" y2="888" gradientUnits="userSpaceOnUse">\n      <stop stop-color="#E7E8EB"/>\n      <stop offset="0.16" stop-color="#777A82"/>\n      <stop offset="0.44" stop-color="#292B31"/>\n      <stop offset="0.56" stop-color="#1B1D22"/>\n      <stop offset="0.84" stop-color="#62656D"/>\n      <stop offset="1" stop-color="#C6C8CD"/>\n    </linearGradient>\n    <linearGradient id="over" x1="160" y1="136" x2="864" y2="888" gradientUnits="userSpaceOnUse">\n      <stop stop-color="#DDE0E4"/>\n      <stop offset="0.16" stop-color="#6E7179"/>\n      <stop offset="0.43" stop-color="#303238"/>\n      <stop offset="0.51" stop-color="#15171B"/>\n      <stop offset="0.59" stop-color="#24262B"/>\n      <stop offset="0.84" stop-color="#62656D"/>\n      <stop offset="1" stop-color="#BFC2C8"/>\n    </linearGradient>\n    <filter id="shadow" x="86" y="66" width="852" height="902" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">\n      <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#000" flood-opacity="0.72"/>\n    </filter>\n  </defs>\n  <g filter="url(#shadow)">\n    <path d="M864 136H678L160 776V888H346L864 248V136Z" fill="url(#under)"/>\n    <path d="M160 136H346L864 776V888H678L160 248V136Z" fill="url(#over)"/>\n    <path d="M160 136H346L398 198H212L160 136Z" fill="#FFF" fill-opacity="0.1"/>\n    <path d="M864 888H678L626 826H812L864 888Z" fill="#FFF" fill-opacity="0.065"/>\n  </g>\n  <path d="M160 136H346" stroke="#FFF" stroke-opacity="0.66" stroke-width="2"/>\n  <path d="M678 136H864" stroke="#FFF" stroke-opacity="0.72" stroke-width="2"/>\n</svg>\n';

  // src/startup/handoff.ts
  var StartupHandoff = class {
    constructor(surface, container) {
      this.container = container;
      this.animations = [];
      this.started = false;
      this.disposed = false;
      this.onHidden = () => {
        if (document.hidden) this.dispose();
      };
      this.onPageHide = () => {
        this.dispose();
      };
      this.onResize = () => {
        this.dispose();
      };
      const snapshot = surface.cloneNode(true);
      if (!(snapshot instanceof HTMLElement)) throw new Error("startup: invalid loading snapshot");
      this.root = snapshot;
      this.root.dataset.xhStartupExit = "";
      this.root.dataset.motion = "idle";
      this.root.setAttribute("aria-hidden", "true");
      this.root.inert = true;
      const colors = getComputedStyle(surface);
      this.root.style.backgroundColor = colors.backgroundColor;
      this.root.style.color = colors.color;
      this.mark = this.root.querySelector("img");
      this.copy = this.root.querySelector(".xh-startup-copy");
      const originalMessage = surface.querySelector(".xh-startup-message");
      const message = this.root.querySelector(".xh-startup-message");
      if (originalMessage !== null && message !== null) message.style.color = getComputedStyle(originalMessage).color;
      this.root.removeAttribute("id");
      this.root.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    }
    /** Called by the renderer's commit callback, never by Host Ready. */
    play() {
      if (this.started || this.disposed) return;
      this.started = true;
      const bounds = this.container.getBoundingClientRect();
      if (!this.container.isConnected || bounds.width <= 0 || bounds.height <= 0 || document.hidden || typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches || this.mark === null || typeof this.root.animate !== "function" || typeof this.mark.animate !== "function") {
        this.dispose();
        return;
      }
      this.root.style.left = `${bounds.left}px`;
      this.root.style.top = `${bounds.top}px`;
      this.root.style.width = `${bounds.width}px`;
      this.root.style.height = `${bounds.height}px`;
      document.body.append(this.root);
      document.addEventListener("visibilitychange", this.onHidden);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("resize", this.onResize);
      try {
        this.animations.push(this.mark.animate([
          { transform: "scale(1)", filter: "brightness(1)" },
          { transform: "scale(1.18)", filter: "brightness(1.14)" }
        ], { duration: 180, easing: "cubic-bezier(.2,.7,.25,1)", fill: "both" }));
        this.animations.push(this.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-out", fill: "both" }));
        if (this.copy !== null) this.animations.push(this.copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: "both" }));
        void Promise.all(this.animations.map((animation) => animation.finished)).then(() => this.dispose(), () => this.dispose());
      } catch {
        this.dispose();
      }
    }
    /** Cancel on teardown/hidden/resize, including a prepared but unplayed exit. */
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const animation of this.animations) animation.cancel();
      this.animations = [];
      this.root.remove();
      document.removeEventListener("visibilitychange", this.onHidden);
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("resize", this.onResize);
    }
  };

  // src/startup/surface.ts
  var StartupSurface = class {
    constructor(container, options) {
      this.animations = [];
      this.stopped = false;
      this.failed = false;
      this.onHidden = () => {
        if (document.hidden) this.finish();
      };
      this.onPageHide = () => {
        this.finish();
      };
      if (document.getElementById("xh-startup-style") === null) {
        const style = document.createElement("style");
        style.id = "xh-startup-style";
        style.textContent = surface_raw_default;
        document.head.append(style);
      }
      this.root = document.createElement("div");
      this.root.dataset.xhStartup = "";
      this.root.dataset.motion = "idle";
      const cluster = document.createElement("div");
      cluster.className = "xh-startup-cluster";
      this.image = document.createElement("img");
      this.image.className = "xh-startup-mark";
      this.image.alt = "";
      this.image.draggable = false;
      this.image.src = `data:image/svg+xml,${encodeURIComponent(mark_default)}`;
      if (options.intro && !document.hidden && typeof this.image.animate === "function") this.root.dataset.motion = "pending";
      this.copy = document.createElement("div");
      this.copy.className = "xh-startup-copy";
      const title = document.createElement("h1");
      title.textContent = "XHarness";
      this.message = document.createElement("p");
      this.message.className = "xh-startup-message";
      this.message.setAttribute("role", "status");
      this.message.setAttribute("aria-live", "polite");
      this.message.textContent = options.message;
      this.report = document.createElement("div");
      this.report.className = "xh-startup-report";
      this.report.setAttribute("role", "alert");
      this.report.hidden = true;
      this.copy.append(title, this.message, this.report);
      cluster.append(this.image, this.copy);
      this.root.append(cluster);
      container.append(this.root);
      if (options.intro) {
        document.addEventListener("visibilitychange", this.onHidden);
        window.addEventListener("pagehide", this.onPageHide);
        const decoded = typeof this.image.decode === "function" ? this.image.decode() : Promise.resolve();
        void decoded.catch(() => {
        }).then(() => {
          if (!this.stopped && this.root.isConnected && !document.hidden) this.play();
          else this.finish();
        });
      }
    }
    /** A live specific failure takes precedence over generic transport errors. */
    get hasFailed() {
      return this.failed;
    }
    /** Native phases may update the message, but never overwrite a failure. */
    setMessage(message) {
      if (!this.failed) this.message.textContent = message;
    }
    /** A loader fiber may recover before boot fails; restore its original ABI.
     * No entrance is replayed after a transient plugin failure. */
    resetLoading(message) {
      this.failed = false;
      delete this.root.dataset.failed;
      this.report.hidden = true;
      this.report.replaceChildren();
      this.message.textContent = message;
    }
    /** Activation counts are diagnostic data, not overall startup percentages. */
    setProgress(active, total) {
      this.root.dataset.loaded = String(active);
      this.root.dataset.total = String(total);
    }
    /** Failure is terminal for this surface and cancels motion immediately. */
    fail(title, details = []) {
      this.finish();
      this.handoff?.dispose();
      this.handoff = void 0;
      this.failed = true;
      this.root.dataset.failed = "";
      this.message.textContent = title;
      this.report.replaceChildren();
      for (const detail of details) {
        const row = document.createElement("div");
        row.textContent = detail;
        this.report.append(row);
      }
      this.report.hidden = details.length === 0;
    }
    /** Cancel without delaying renderer handoff or changing the loading DOM. */
    finish() {
      this.stopped = true;
      for (const animation of this.animations) animation.cancel();
      this.animations = [];
      this.root.dataset.motion = "idle";
      document.removeEventListener("visibilitychange", this.onHidden);
      window.removeEventListener("pagehide", this.onPageHide);
    }
    /** Freeze before hydration; keep only this small snapshot, never the app. */
    prepareHandoff(container) {
      this.finish();
      this.handoff?.dispose();
      this.handoff = void 0;
      if (!this.failed && this.root.isConnected) {
        try {
          this.handoff = new StartupHandoff(this.root, container);
        } catch {
        }
      }
    }
    /** The application is committed and clickable; the exit is purely visual. */
    completeHandoff() {
      if (!this.failed) this.handoff?.play();
    }
    dispose() {
      this.finish();
      this.handoff?.dispose();
      this.handoff = void 0;
      this.root.remove();
    }
    play() {
      if (typeof this.image.animate !== "function") {
        this.finish();
        return;
      }
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.root.dataset.motion = "playing";
      const duration = reduced ? 120 : 480;
      this.animations = [
        this.image.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [
          { offset: 0, transform: "scale(5)", filter: "brightness(1)", easing: "cubic-bezier(.18,.8,.2,1)" },
          { offset: 0.82, transform: "scale(1)", filter: "brightness(1.42)", easing: "ease-out" },
          { offset: 1, transform: "scale(1)", filter: "brightness(1)" }
        ], { duration, fill: "both" }),
        this.copy.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [
          { offset: 0, opacity: 0 },
          { offset: 0.58, opacity: 0 },
          { offset: 1, opacity: 1 }
        ], { duration, fill: "both" })
      ];
      void Promise.all(this.animations.map((animation) => animation.finished)).then(() => {
        this.finish();
      }).catch(() => {
      });
    }
  };

  // src/desktop/bootstrap.ts
  (() => {
    const container = document.getElementById("state");
    if (container === null) return;
    const surface = new StartupSurface(container, { message: "\u6B63\u5728\u521D\u59CB\u5316\u684C\u9762\u8FD0\u884C\u73AF\u5883\u2026", intro: true });
    let disposed = false;
    let unlisten;
    window.addEventListener("pagehide", () => {
      disposed = true;
      surface.finish();
      unlisten?.();
    }, { once: true });
    const native = window.__TAURI__;
    if (native === void 0) return;
    async function boot() {
      if (native === void 0) return;
      const stop = await native.event.listen("xharness-bootstrap", ({ payload }) => {
        if (disposed || typeof payload !== "object" || payload === null) return;
        const message = "message" in payload && typeof payload.message === "string" ? payload.message : void 0;
        const phase = "phase" in payload ? payload.phase : void 0;
        if (phase === "failed") surface.fail(message ?? "\u684C\u9762\u542F\u52A8\u5931\u8D25");
        else if (phase === "ready") surface.setMessage("\u6B63\u5728\u52A0\u8F7D\u754C\u9762\u2026");
        else if (message !== void 0) surface.setMessage(message);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const status = await native.core.invoke("desktop_status");
      if (disposed) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!disposed) void native.core.invoke("desktop_report_startup_phase", { phase: "window_mapped" }).catch(() => {
        });
      }));
      if (typeof status === "object" && status !== null && "startupError" in status && typeof status.startupError === "string" && status.startupError.length > 0) {
        surface.fail(status.startupError);
      }
    }
    void boot().catch(() => {
      if (!disposed && !surface.hasFailed) surface.fail("\u65E0\u6CD5\u8BFB\u53D6\u684C\u9762\u542F\u52A8\u72B6\u6001\uFF0C\u8BF7\u5173\u95ED\u6B64\u7A97\u53E3\u540E\u91CD\u8BD5\u3002");
    });
  })();
})();
