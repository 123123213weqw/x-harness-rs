import type { Role } from "./types.js";

/** JSON Schema subset used by the MCP contract and its fail-before-dispatch parser. */
export interface CommandSchema {
  $ref?: string;
  $defs?: Record<string, CommandSchema>;
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  enum?: readonly unknown[];
  properties?: Record<string, CommandSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: CommandSchema;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  oneOf?: readonly CommandSchema[];
  anyOf?: readonly CommandSchema[];
  not?: CommandSchema;
  description?: string;
}
export const roles = ["alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem"] satisfies Role[];
const string = (maxLength = 4096): CommandSchema => ({ type: "string", maxLength });
const id = string(160), flag: CommandSchema = { type: "boolean" };
const integer = (maximum: number): CommandSchema => ({ type: "integer", minimum: 0, maximum });
const numeric = (minimum: number, maximum: number): CommandSchema => ({ type: "number", minimum, maximum });
const choice = (values: readonly string[]): CommandSchema => ({ type: "string", enum: values });
function object(properties: Record<string, CommandSchema>, required: readonly string[] = []): CommandSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
export const targetSchema: CommandSchema = {
  oneOf: [
    object({ ref: id, observationId: id }, ["ref", "observationId"]),
    object({ by: choice(["role"]), role: choice(roles), name: string(), exact: flag, frameId: id }, ["by", "role"]),
    object({ by: choice(["text", "label", "placeholder", "testId"]), value: string(), exact: flag, frameId: id }, ["by", "value"]),
  ],
  description: "Use exactly {ref,observationId} from the latest observation, OR {by:'role',role,name?,exact?,frameId?}, OR {by:'text'|'label'|'placeholder'|'testId',value,exact?,frameId?}. frameId belongs only to semantic targets, never ref targets.",
};
const fields: Record<string, CommandSchema> = {
  action: string(24), tabId: id, targetTabId: id, url: string(), reuse: flag,
  target: { $ref: "#/$defs/target" }, destination: { $ref: "#/$defs/target" }, observationId: id,
  frame_id: id, ref: id, value: string(), text: string(100000), key: id,
  button: choice(["left", "right", "middle"]), clickCount: { type: "integer", minimum: 1, maximum: 3 }, checked: flag,
  values: { type: "array", items: string(), maxItems: 100 }, files: { type: "array", items: string(), maxItems: 20 },
  nodeOffset: integer(1e7), node_offset: integer(1e7), textOffset: integer(1e8), text_offset: integer(1e8),
  frameOffset: integer(1e5), frameId: id, scope: choice(["page", "main", "dialog"]),
  x: numeric(-100000, 100000), y: numeric(-100000, 100000), delta_y: numeric(-100000, 100000),
  milliseconds: integer(10000), state: choice(["attached", "detached", "visible", "hidden"]), loadState: choice(["load", "domcontentloaded"]),
  screenshotId: id, operation: choice(["click", "move", "down", "up"]), fullPage: flag,
  accept: flag, downloadId: id, after: integer(Number.MAX_SAFE_INTEGER),
};
function command(action: string, names: readonly string[] = [], required: readonly string[] = []): CommandSchema {
  const properties: Record<string, CommandSchema> = { action: choice([action]), tabId: id };
  for (const name of names) { const field = fields[name]; if (!field) throw Error("Unknown schema field: " + name); properties[name] = field; }
  return object(properties, ["action", ...required]);
}
function targeted(action: string, names: readonly string[] = [], required: readonly string[] = [], legacy = false, optional = false): CommandSchema[] {
  return [
    command(action, ["target", ...names], ["target", ...required]),
    ...(legacy ? [command(action, ["frame_id", "ref", ...names], ["frame_id", "ref", ...required])] : []),
    ...(optional ? [command(action, names, required)] : []),
  ];
}
const observe = command("observe", ["nodeOffset", "textOffset", "frameOffset", "frameId", "scope", "node_offset", "text_offset"]);
// Reject competing aliases instead of silently prioritizing one spelling.
observe.not = { anyOf: [{ required: ["nodeOffset", "node_offset"] }, { required: ["textOffset", "text_offset"] }] };
const dialog = command("dialog", ["accept", "text"], ["accept"]);
if (dialog.properties) dialog.properties.text = string();
const actions: CommandSchema[] = [
  ...["tabs", "back", "forward", "reload"].map(action => command(action)),
  command("new", ["url"]), command("navigate", ["url", "reuse"], ["url"]),
  command("select", ["targetTabId"], ["targetTabId"]), command("select", ["frame_id", "ref", "value"], ["frame_id", "ref", "value"]),
  command("close", ["targetTabId"], ["targetTabId"]), observe,
  ...targeted("click", ["button", "clickCount"], [], true),
  ...targeted("fill", ["text"], ["text"], true), ...targeted("type", ["text"], ["text"], true),
  ...targeted("press", ["key"], ["key"], true, true), ...targeted("hover", [], [], true),
  ...targeted("drag", ["destination"], ["destination"]),
  ...targeted("selectOption", ["values"], ["values"]), ...targeted("check", ["checked"], ["checked"]),
  ...targeted("upload", ["files"], ["files"]),
  // Page scroll may use observationId. Element scroll obtains identity from its target.
  command("scroll", ["x", "y", "observationId"], ["y"]), command("scroll", ["target", "x", "y", "observationId"], ["target", "y"]),
  command("scroll", ["frame_id", "ref", "x", "y"], ["frame_id", "y"]),
  command("scroll", ["frame_id", "ref", "x", "delta_y"], ["frame_id", "delta_y"]),
  command("wait"), command("wait", ["milliseconds"], ["milliseconds"]), command("wait", ["loadState"], ["loadState"]), command("wait", ["target", "state"], ["target"]),
  command("screenshot", ["fullPage"]), command("mouse", ["screenshotId", "x", "y", "operation", "button"], ["screenshotId", "x", "y", "operation"]),
  dialog, command("download", ["downloadId"], ["downloadId"]),
  command("console", ["after"]), command("network", ["after"]),
];
// Mouse positions are viewport pixels, not relative signed scroll deltas.
for (const action of actions) if (action.properties?.action?.enum?.includes("mouse") && action.properties) {
  action.properties.x = numeric(0, 100000); action.properties.y = numeric(0, 100000);
}
fields.action = choice([...new Set(actions.flatMap(action => action.properties?.action?.enum?.filter((item): item is string => typeof item === "string") ?? []))]);
export const inputSchema: CommandSchema = { $defs: { target: targetSchema }, type: "object", properties: fields, required: ["action"], additionalProperties: false, oneOf: actions };

function entries(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function errors(schema: CommandSchema, value: unknown, path: string): string[] {
  if (schema.$ref) {
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice(8) : "";
    const definition = inputSchema.$defs && Object.hasOwn(inputSchema.$defs, name) ? inputSchema.$defs[name] : undefined;
    if (!definition) throw Error("Unknown internal schema reference");
    return errors(definition, value, path);
  }
  const result: string[] = [], objectValue = entries(value);
  if (schema.type === "object" && !objectValue) return [path + " must be an object"];
  if (schema.type === "string" && typeof value !== "string") return [path + " must be a string"];
  if (schema.type === "boolean" && typeof value !== "boolean") return [path + " must be a boolean"];
  if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)))) return [path + " must be a finite " + schema.type];
  if (schema.type === "array" && !Array.isArray(value)) return [path + " must be an array"];
  if (schema.enum && !schema.enum.includes(value)) result.push(path + " must be one of " + schema.enum.map(item => JSON.stringify(item)).join(", "));
  if (typeof value === "string" && schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) result.push(path + " exceeds " + schema.maxLength + " characters");
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) result.push(path + " is outside its allowed numeric range");
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) result.push(path + " has too many items");
    if (schema.items) for (const [index, item] of value.entries()) result.push(...errors(schema.items, item, path + "[" + index + "]"));
  }
  if (objectValue) {
    for (const name of schema.required ?? []) if (!Object.hasOwn(objectValue, name)) result.push(path + "." + name + " is required");
    for (const [name, item] of Object.entries(objectValue)) {
      const child = schema.properties && Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
      if (child) result.push(...errors(child, item, path + "." + name));
      else if (schema.additionalProperties === false) result.push(path + "." + name + " is not supported");
    }
  }
  if (schema.not && errors(schema.not, value, path).length === 0) result.push(path + " contains conflicting aliases; provide only one spelling");
  if (schema.anyOf && !schema.anyOf.some(branch => errors(branch, value, path).length === 0)) result.push(path + " does not match an allowed alternative");
  if (schema.oneOf) {
    const candidates = schema.oneOf.map(branch => errors(branch, value, path));
    const matched = candidates.filter(candidate => candidate.length === 0).length;
    if (matched > 1) result.push(path + " matches conflicting forms; provide exactly one form");
    if (matched === 0) {
      const actionName = objectValue?.action;
      const sameAction = typeof actionName === "string" ? schema.oneOf.filter(branch => branch.properties?.action?.enum?.includes(actionName)) : [];
      const options = sameAction.length ? sameAction.map(branch => errors(branch, value, path)) : candidates;
      const best = options.reduce<string[] | undefined>((prior, candidate) => prior === undefined || candidate.length < prior.length ? candidate : prior, undefined);
      result.push(...(best ?? [path + " has no allowed form"]));
    }
  }
  return result;
}
const examples: Record<string, string> = {
  click: '{action:"click",target:{ref:"…",observationId:"…"}}',
  fill: '{action:"fill",target:{by:"label",value:"Name"},text:"replacement"}; use text, not value, for the action payload',
  type: '{action:"type",target:{by:"label",value:"Name"},text:"typed text"}',
  select: '{action:"select",targetTabId:"…"} OR legacy {action:"select",frame_id:"…",ref:"…",value:"…"}',
  observe: '{action:"observe",nodeOffset:0,textOffset:0}; do not mix nodeOffset/node_offset or textOffset/text_offset',
  scroll: '{action:"scroll",y:500,target?:{by:"text",value:"…"}} OR legacy {action:"scroll",frame_id:"…",delta_y:500}',
  wait: '{action:"wait",target:{by:"role",role:"button",name:"Ready"},state:"visible"} OR {action:"wait",loadState:"domcontentloaded"} OR {action:"wait",milliseconds:250}',
};
export function validateCommandInput(value: unknown): void {
  const issues = errors(inputSchema, value, "arguments");
  if (!issues.length) return;
  const action = entries(value)?.action;
  const example = typeof action === "string" ? examples[action] : undefined;
  throw Error(issues.slice(0, 4).join("; ") + ". " + (example ? "Use " + example + ". " : "") + "Targets must use {ref,observationId} OR {by:'role',role,name?} OR {by:'text'|'label'|'placeholder'|'testId',value}. Never mix canonical target with legacy frame_id/ref.");
}
