"use strict";
(() => {
  // src/modules/shared/desktop-titlebar.ts
  var DESKTOP_TITLEBAR_CONTROLS_ID = "xh-desktop-titlebar-controls";
  var DESKTOP_TITLEBAR_READY_EVENT = "xh-desktop-titlebar-ready";

  // src/desktop/titlebar.ts
  (() => {
    if (typeof window.__TAURI__?.core?.invoke !== "function") return;
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
