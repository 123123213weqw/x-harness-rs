import {
  init_define_process_execArgv
} from "./chunk-YOCBWPQK.js";

// node_modules/ccount/index.js
init_define_process_execArgv();
function ccount(value, character) {
  const source = String(value);
  if (typeof character !== "string") {
    throw new TypeError("Expected character");
  }
  let count = 0;
  let index = source.indexOf(character);
  while (index !== -1) {
    count++;
    index = source.indexOf(character, index + character.length);
  }
  return count;
}

export {
  ccount
};
//# sourceMappingURL=chunk-C4DTIBBW.js.map
