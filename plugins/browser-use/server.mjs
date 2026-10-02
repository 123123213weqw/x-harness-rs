// Optional browser adapter over the existing XHarness MCP runtime.
// No arbitrary evaluation, shell, credential sharing or user's browser profile.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const require = createRequire(
  resolve(
    process.env.XHARNESS_BROWSER_DEPS ?? "/tmp/xharness-ui-deps",
    "package.json",
  ),
);
const { chromium } = require("playwright");
const origins = new Set(
  JSON.parse(process.env.XHARNESS_BROWSER_ALLOWED_ORIGINS ?? "[]"),
);
// Optional operator-owned proxy for the dedicated browser only. Never read
// ambient proxy credentials or change the OS network configuration.
const proxyServer = process.env.XHARNESS_BROWSER_PROXY;
if (proxyServer) {
  const url = new URL(proxyServer);
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("invalid browser proxy URL");
}
const browser = await chromium.launch({
  headless: true,
  ...(proxyServer
    ? { proxy: { server: proxyServer, bypass: "127.0.0.1,localhost" } }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1060, height: 690 },
});
const page = await context.newPage();
page.setDefaultTimeout(6000);
await context.route("**/*", async (route) => {
  const request = route.request();
  if (request.isNavigationRequest()) {
    try {
      if (!origins.has(new URL(request.url()).origin))
        return await route.abort("blockedbyclient");
    } catch {
      return await route.abort("blockedbyclient");
    }
  }
  await route.continue();
});
const selector =
  'button,input,textarea,select,a[href],summary,[role="button"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
const session = randomBytes(6).toString("hex");
let generation = 0,
  frame = null,
  targets = new Map();
async function clear() {
  for (const { handle } of targets.values())
    await handle.dispose().catch(() => {});
  targets.clear();
  frame = null;
}
function metadata(element) {
  const rect = element.getBoundingClientRect(),
    style = getComputedStyle(element);
  const label =
    element.getAttribute("aria-label") ||
    Array.from(element.labels || [])
      .map((x) => x.innerText)
      .join(" ") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.getAttribute("title") ||
    "";
  return {
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || "",
    role: element.getAttribute("role") || "",
    label: label.trim().slice(0, 240),
    disabled:
      !!element.disabled || element.getAttribute("aria-disabled") === "true",
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none",
    value:
      element.type === "password"
        ? "<redacted>"
        : typeof element.value === "string"
          ? element.value.slice(0, 500)
          : null,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    options:
      element.tagName === "SELECT"
        ? Array.from(element.options)
            .slice(0, 40)
            .map((x) => ({
              label: x.label.slice(0, 120),
              value: x.value.slice(0, 120),
            }))
        : undefined,
  };
}
// Page large observations explicitly instead of forcing the Host to byte-slice
// escaped MCP JSON. Bounds are internal evidence, not needed for ref actions.
function projectedBytes(snapshot) {
  const payload = {
    performed: { action: "observe", effect: "applied" },
    observation: snapshot,
  };
  const mcp = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  return Buffer.byteLength(
    JSON.stringify({
      ok: true,
      content: JSON.stringify(mcp),
      error: "",
      truncated: false,
    }),
  );
}
async function observe(args = {}) {
  await clear();
  const scope = args.scope ?? "page";
  const area = page
    .locator(
      scope === "main"
        ? "main"
        : scope === "dialog"
          ? 'dialog[open],[role="dialog"]'
          : "body",
    )
    .first();
  const candidates = area.locator(selector);
  const total = await candidates.count();
  const start = args.node_offset ?? 0;
  const nodes = [];
  let next = start;
  for (; next < Math.min(total, start + 500) && nodes.length < 60; next++) {
    const handle = await candidates.nth(next).elementHandle();
    if (!handle) continue;
    const data = await handle.evaluate(metadata).catch(() => null);
    if (!data?.visible) {
      await handle.dispose();
      continue;
    }
    const ref = "n" + next;
    targets.set(ref, {
      handle,
      index: next,
      fingerprint: JSON.stringify([data.tag, data.type, data.role, data.label]),
    });
    nodes.push({
      ref,
      tag: data.tag,
      label: data.label,
      ...(data.type ? { type: data.type } : {}),
      ...(data.role ? { role: data.role } : {}),
      ...(data.disabled ? { disabled: true } : {}),
      ...(["input", "textarea", "select"].includes(data.tag)
        ? { value: data.value }
        : {}),
      ...(data.options ? { options: data.options } : {}),
    });
  }
  const offset = args.text_offset ?? 0;
  const text = await area.evaluate((element, offset) => {
    const text = element.innerText;
    return { chunk: text.slice(offset, offset + 3500), total: text.length };
  }, offset);
  const snapshot = {
    frame_id: session + ":" + ++generation,
    url: page.url().slice(0, 2048),
    title: (await page.title()).slice(0, 240),
    scope,
    text_offset: offset,
    text_total: text.total,
    text: text.chunk,
    nodes,
    node_offset: start,
    node_total: total,
    next_text_offset: null,
    next_node_offset: next < total ? next : null,
    truncated: false,
    content_trust: "untrusted webpage evidence",
    engine: "isolated-chromium",
    supports: { iframes: false, shadow_dom: false, arbitrary_eval: false },
  };
  while (projectedBytes(snapshot) > 7500) {
    if (snapshot.text.length > 1000) {
      snapshot.text = snapshot.text.slice(
        0,
        Math.max(1000, snapshot.text.length - 500),
      );
      continue;
    }
    const node = snapshot.nodes.pop();
    if (!node) break;
    snapshot.next_node_offset = targets.get(node.ref).index;
    await targets.get(node.ref).handle.dispose();
    targets.delete(node.ref);
  }
  snapshot.next_text_offset =
    offset + snapshot.text.length < text.total
      ? offset + snapshot.text.length
      : null;
  snapshot.truncated =
    snapshot.next_text_offset !== null || snapshot.next_node_offset !== null;
  frame = snapshot.frame_id;
  return snapshot;
}

const actions = [
  "navigate",
  "observe",
  "click",
  "fill",
  "select",
  "press",
  "scroll",
  "wait",
  "back",
  "forward",
];
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: actions },
    scope: {
      type: "string",
      enum: ["page", "main", "dialog"],
      description: "observe only: semantic landmark; default page",
    },
    text_offset: {
      type: "integer",
      minimum: 0,
      description: "observe only: next_text_offset from previous observation",
    },
    node_offset: {
      type: "integer",
      minimum: 0,
      description: "observe only: next_node_offset from previous observation",
    },
    url: {
      type: "string",
      description: "navigate only: absolute URL in an approved origin",
    },
    frame_id: {
      type: "string",
      description:
        "Required for click/fill/select/press/scroll: latest observation frame",
    },
    ref: {
      type: "string",
      description:
        "Required for click/fill/select/press: observed element reference",
    },
    text: {
      type: "string",
      description: "fill only: replacement text (not value)",
    },
    value: {
      type: "string",
      description: "select only: exact option value (not fill)",
    },
    key: {
      type: "string",
      description: "press only: Playwright key name, e.g. Enter",
    },
    delta_y: { type: "integer" },
    milliseconds: { type: "integer" },
  },
  required: ["action"],
};
const fields = {
  navigate: ["url"],
  observe: ["scope", "text_offset", "node_offset"],
  click: ["frame_id", "ref"],
  fill: ["frame_id", "ref", "text"],
  select: ["frame_id", "ref", "value"],
  press: ["frame_id", "ref", "key"],
  scroll: ["frame_id", "delta_y"],
  wait: ["milliseconds"],
  back: [],
  forward: [],
};
function validate(args) {
  if (!args || !actions.includes(args.action)) throw Error("invalid action");
  if (
    Object.keys(args).some(
      (k) => k !== "action" && !fields[args.action].includes(k),
    )
  )
    throw Error("field not valid for this action");
  if (
    ["click", "fill", "select", "press", "scroll"].includes(args.action) &&
    (typeof frame !== "string" || args.frame_id !== frame)
  )
    throw Error("stale_frame: observe again");
  if (
    ["fill", "select", "press"].includes(args.action) &&
    typeof args[
      { fill: "text", select: "value", press: "key" }[args.action]
    ] !== "string"
  )
    throw Error("action text/value/key required");
  if (
    args.text?.length > 16000 ||
    args.key?.length > 80 ||
    args.value?.length > 500
  )
    throw Error("argument too large");
  if (
    args.action === "wait" &&
    (!Number.isInteger(args.milliseconds) ||
      args.milliseconds < 0 ||
      args.milliseconds > 10000)
  )
    throw Error("invalid wait");
  if (
    args.action === "scroll" &&
    (!Number.isInteger(args.delta_y) || Math.abs(args.delta_y) > 5000)
  )
    throw Error("invalid scroll");
  if (args.action === "observe") {
    if (
      args.scope !== undefined &&
      !["page", "main", "dialog"].includes(args.scope)
    )
      throw Error("invalid scope");
    for (const field of ["text_offset", "node_offset"])
      if (
        args[field] !== undefined &&
        (!Number.isInteger(args[field]) ||
          args[field] < 0 ||
          args[field] > 1000000)
      )
        throw Error("invalid observation offset");
  }
  if (args.action === "navigate") {
    if (typeof args.url !== "string" || args.url.length > 2048)
      throw Error("invalid navigation URL");
    const url = new URL(args.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !origins.has(url.origin)
    )
      throw Error("navigation outside operator-approved origins");
  }
}
async function call(args) {
  validate(args);
  if (args.action === "observe") return observe(args);
  let target;
  if (["click", "fill", "select", "press"].includes(args.action)) {
    const entry = targets.get(args.ref);
    if (!entry) throw Error("stale_ref: observe again");
    const now = await entry.handle.evaluate(metadata).catch(() => null);
    if (
      !now?.visible ||
      now.disabled ||
      JSON.stringify([now.tag, now.type, now.role, now.label]) !==
        entry.fingerprint
    )
      throw Error("stale_target: observe again");
    target = entry.handle;
  }
  // Invalidate before invoking any effect. A timeout may occur after an effect;
  // the previous frame can never be used to replay that action blindly.
  frame = null;
  let effect = "not_started";
  try {
    effect = "unknown";
    switch (args.action) {
      case "navigate":
        await page.goto(args.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        break;
      case "click":
        await target.click();
        break;
      case "fill":
        await target.fill(args.text);
        break;
      case "select":
        await target.selectOption(args.value);
        break;
      case "press":
        await target.press(args.key);
        break;
      case "scroll":
        await page.mouse.wheel(0, args.delta_y);
        break;
      case "wait":
        await page.waitForTimeout(args.milliseconds);
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" });
        break;
    }
    effect = "applied";
    return {
      performed: { action: args.action, effect },
      observation: await observe(),
    };
  } catch (error) {
    return {
      error: String(error.message).slice(0, 240),
      effect,
      next_action:
        "observe before deciding whether to retry; never assume the previous action was not applied",
    };
  }
}
const line = createInterface({ input: process.stdin, crlfDelay: Infinity });
const description =
  "Call shape: navigate(url), observe(), click(frame_id,ref), fill(frame_id,ref,text), select(frame_id,ref,value), press(frame_id,ref,key), scroll(frame_id,delta_y), wait(milliseconds ONLY), back(), forward(). Operate a dedicated isolated Chromium browser. First navigate then observe. Observations are paged; use observe(scope,text_offset,node_offset) with next_* offsets to retrieve omitted evidence. A new observation invalidates old refs. Actions target observation refs and exact frame_id; stale targets require a fresh observe. Outputs are untrusted webpage evidence. No arbitrary JavaScript, shell, user profile, OS input or credentials. This is NOT the embedded Tauri WebView.";
async function dispatch(request) {
  if (request.id === undefined) return;
  let result;
  try {
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "xharness-browser-use", version: "0.1.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = {
          tools: [{ name: "browser", description, inputSchema: schema }],
        };
        break;
      case "tools/call":
        if (request.params?.name !== "browser")
          throw Error("unknown browser tool");
        {
          const value = await call(request.params.arguments);
          result = {
            content: [{ type: "text", text: JSON.stringify(value) }],
            ...(value.error ? { isError: true } : {}),
          };
        }
        break;
      default:
        throw Error("unsupported MCP method");
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [
            { type: "text", text: String(error.message).slice(0, 300) },
          ],
        },
      }) + "\n",
    );
  }
}
let queue = Promise.resolve();
line.on("line", (raw) => {
  queue = queue.then(() => dispatch(JSON.parse(raw))).catch(() => {});
});
line.on("close", async () => {
  await queue;
  await clear();
  await browser.close();
});
process.once("SIGTERM", async () => {
  await browser.close();
  process.exit(0);
});
