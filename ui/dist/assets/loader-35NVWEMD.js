"use strict";
(() => {
  // src/modules/platform/bootstrap.ts
  function isBootstrapModule(value) {
    return typeof value.createClientModuleSystem === "function" && typeof value.apply === "function";
  }
  var pendingQueue = [];
  var loader = {
    mode: "queue",
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration);
    },
    create(options) {
      if (this.mode !== "queue") throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot");
      const index = pendingQueue.findIndex((registration2) => registration2.id === "@xharness/dsh-client-modules");
      const registration = pendingQueue[index];
      if (registration === void 0) throw new Error("client-modules: HTML did not preload @xharness/dsh-client-modules/client.js");
      pendingQueue.splice(index, 1);
      const exports = registration.factory((specifier) => {
        throw new Error('client-modules: @xharness/dsh-client-modules/client.js requested external "' + specifier + '" before the module system existed');
      });
      if (typeof exports !== "object" || exports === null || !isBootstrapModule(exports)) {
        throw new Error("client-modules: @xharness/dsh-client-modules/client.js did not export the bootstrap module face");
      }
      return exports.createClientModuleSystem(this, { id: registration.id, exports }, options);
    }
  };
  window.__ModuleLoader__ = loader;
})();
//# sourceMappingURL=loader-35NVWEMD.js.map
