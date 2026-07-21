// Generated from src/modules/brand-official/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-brand-official",
factory: (__externalRequire) => {
const __units = {
"src/modules/brand-official/index.js": function(module, exports, require) {
// source: src/modules/brand-official/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const Brand_1 = require("./Brand");
/** Required service: the UI slot registry. */
exports.inject = ['slots'];
/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
function apply(ctx) {
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Brand_1.OfficialBrandMark);
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, Brand_1.OfficialBrandName);
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Brand_1.OfficialBrandMark);
    })));
}

},
"src/modules/brand-official/Brand.js": function(module, exports, require) {
// source: src/modules/brand-official/Brand.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficialBrandMark = OfficialBrandMark;
exports.OfficialBrandName = OfficialBrandName;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
function OfficialBrandMark({ size, className }) {
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.FishLogo, { size: size, className: className });
}
/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
function OfficialBrandName() {
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.BrandWordmark, { includeMark: false });
}

}
};
const __dependencies = {"src/modules/brand-official/index.js":{"./Brand":"src/modules/brand-official/Brand.js"},"src/modules/brand-official/Brand.js":{}};
const __cache = Object.create(null);
const __load = id => {
  if (__cache[id]) return __cache[id].exports;
  const unit = __units[id];
  if (!unit) throw Error('Unknown local UI module: ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  try {
    unit(module, module.exports, request => Object.prototype.hasOwnProperty.call(__dependencies[id], request)
      ? __load(__dependencies[id][request]) : __externalRequire(request));
  } catch (error) { delete __cache[id]; throw error; }
  return module.exports;
};
return __load("src/modules/brand-official/index.js");
}
});
