"use strict";
(() => {
  // src/desktop/logo-motion.ts
  (() => {
    const sync = () => document.documentElement.toggleAttribute("data-xh-page-hidden", document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
  })();
})();
