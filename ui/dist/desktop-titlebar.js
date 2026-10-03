"use strict";
(() => {
  // src/desktop/native-theme.ts
  function syncNativeTheme(native) {
    const html = document.documentElement;
    if (html.dataset.xhNativeThemeSync !== void 0) return;
    html.dataset.xhNativeThemeSync = "active";
    let desired;
    let attempted;
    let running = false;
    let disposed = false;
    async function apply() {
      if (running) return;
      running = true;
      try {
        while (!disposed && desired !== void 0 && desired !== attempted) {
          const scheme = desired;
          attempted = scheme;
          try {
            await native.setTheme(scheme);
          } catch {
            console.warn("XHarness: native window theme could not be synchronized");
          }
        }
      } finally {
        running = false;
      }
    }
    function changed() {
      const scheme = html.style.colorScheme;
      if (html.dataset.xhThemePreference === "system") desired = null;
      else if (scheme === "light" || scheme === "dark") desired = scheme;
      else if (scheme === "" && desired !== void 0) desired = null;
      else return;
      void apply();
    }
    const observer = new MutationObserver(changed);
    observer.observe(html, { attributes: true, attributeFilter: ["style", "data-xh-theme-preference"] });
    function dispose() {
      disposed = true;
      observer.disconnect();
      delete html.dataset.xhNativeThemeSync;
      window.removeEventListener("pagehide", dispose);
    }
    window.addEventListener("pagehide", dispose, { once: true });
    changed();
  }

  // src/modules/shared/desktop-titlebar.ts
  var DESKTOP_TITLEBAR_CONTROLS_ID = "xh-desktop-titlebar-controls";
  var DESKTOP_TITLEBAR_READY_EVENT = "xh-desktop-titlebar-ready";

  // src/desktop/titlebar.ts
  (() => {
    if (typeof window.__TAURI__?.core?.invoke !== "function") return;
    const native = window.__TAURI__?.window?.getCurrentWindow?.();
    if (native !== void 0 && typeof native.setTheme === "function") syncNativeTheme(native);
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    document.documentElement.dataset.xhMacTitlebar = "overlay";
    const mount = () => {
      if (document.getElementById("xh-desktop-titlebar")) return;
      const bar = document.createElement("div");
      bar.id = "xh-desktop-titlebar";
      const drag = document.createElement("div");
      drag.id = "xh-desktop-titlebar-drag";
      drag.setAttribute("data-tauri-drag-region", "");
      drag.setAttribute("aria-hidden", "true");
      bar.appendChild(drag);
      const controls = document.createElement("div");
      controls.id = DESKTOP_TITLEBAR_CONTROLS_ID;
      bar.appendChild(controls);
      document.body.prepend(bar);
      window.dispatchEvent(new Event(DESKTOP_TITLEBAR_READY_EVENT));
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  })();
})();
