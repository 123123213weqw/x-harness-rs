// Real Chromium + stdio MCP contracts. No model or paid API is used here.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const deps = process.env.UI_TEST_DEPS ?? "/tmp/xharness-ui-deps";
const require = createRequire(resolve(deps, "package.json"));
const { chromium } = require("playwright");
const fixture = readFileSync(
  new URL("./fixtures/index.html", import.meta.url),
  "utf8",
);
const reports = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/report") {
    let data = "";
    for await (const chunk of req) data += chunk;
    reports.set(url.searchParams.get("run"), JSON.parse(data));
    res.end("{}");
    return;
  }
  if (url.pathname === "/many") {
    res.end(
      "<body>" +
        Array.from(
          { length: 180 },
          (_, i) => "<button>" + "x".repeat(240) + i + "</button>",
        ).join("") +
        "</body>",
    );
    return;
  }
  if (url.pathname === "/stale") {
    res.end(
      '<body><button id="target">Original</button><input id="password" type="password" value="private-password"><script>setTimeout(()=>{target.outerHTML="<button>Replacement</button>"},1000)</script></body>',
    );
    return;
  }
  if (url.pathname === "/failed") {
    res.end(
      '<body><button onclick="this.remove();document.body.remove()">Apply then remove body</button></body>',
    );
    return;
  }
  if (url.pathname === "/outside") {
    res.writeHead(302, { location: "http://localhost:1/denied" });
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(fixture);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const child = spawn(
  process.execPath,
  [new URL("../../plugins/browser-use/server.mjs", import.meta.url).pathname],
  {
    env: {
      ...process.env,
      XHARNESS_BROWSER_DEPS: deps,
      XHARNESS_BROWSER_ALLOWED_ORIGINS: JSON.stringify([origin]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let id = 0,
  stderr = "",
  closed = false;
const pending = new Map();
child.stderr.on("data", (x) => (stderr += x));
createInterface({ input: child.stdout }).on("line", (raw) => {
  const value = JSON.parse(raw);
  const slot = pending.get(value.id);
  if (slot) {
    pending.delete(value.id);
    slot.resolve(value);
  }
});
child.on("exit", () => {
  closed = true;
  for (const slot of pending.values())
    slot.reject(Error("MCP child exited: " + stderr));
  pending.clear();
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Error("MCP timeout"));
    }, 20000);
    pending.set(requestId, {
      resolve: (x) => {
        clearTimeout(timer);
        resolve(x);
      },
      reject: (x) => {
        clearTimeout(timer);
        reject(x);
      },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n",
    );
  });
}
async function call(args) {
  const response = await rpc("tools/call", {
    name: "browser",
    arguments: args,
  });
  const text = response.result.content[0].text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { error: text };
  }
  return {
    value,
    error: response.result.isError === true,
    raw: response.result,
  };
}
const view = (x) => x.value.observation ?? x.value;
const action = (snapshot, label, kind = "click", extra = {}) => ({
  action: kind,
  frame_id: snapshot.frame_id,
  ref: snapshot.nodes.find((n) => n.label === label).ref,
  ...extra,
});
let checks = 0;
function check(condition) {
  assert.ok(condition);
  checks++;
}
try {
  check(
    (
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contract", version: "1" },
      })
    ).result.capabilities.tools,
  );
  const tool = (await rpc("tools/list")).result.tools[0];
  check(tool.name === "browser" && !tool.inputSchema.properties.script);
  check((await call({ action: "scroll", delta_y: 1 })).error);
  check((await call({ action: "navigate", url: "file:///etc/passwd" })).error);
  check(
    (
      await call({
        action: "navigate",
        url: origin.replace("://", "://name:secret@"),
      })
    ).error,
  );
  check(
    (await call({ action: "navigate", url: "http://localhost:1/denied" }))
      .error,
  );
  let s = view(
    await call({
      action: "navigate",
      url: origin + "/?task=issue&run=" + "a".repeat(32),
    }),
  );
  const old = s.frame_id;
  check(
    (await call({ ...action(s, "Search issues", "fill"), value: "wrong" }))
      .error,
  );
  s = view(
    await call(action(s, "Search issues", "fill", { text: "compaction" })),
  );
  check((await call({ action: "click", frame_id: old, ref: "n0" })).error);
  s = view(await call(action(s, "Search")));
  s = view(await call(action(s, "#105 Compaction recovery does not settle")));
  s = view(
    await call(
      action(s, "Recovery marker answer", "fill", { text: "ORBIT-7319" }),
    ),
  );
  await new Promise((r) => setTimeout(r, 100));
  check(reports.get("a".repeat(32)).marker === "ORBIT-7319");
  s = view(await call(action(s, "Pull requests")));
  check(s.url.includes("run=" + "a".repeat(32)));
  s = view(await call(action(s, "New draft")));
  s = view(
    await call(
      action(s, "Title", "fill", { text: "Restore compact completion" }),
    ),
  );
  s = view(
    await call(
      action(s, "Description", "fill", {
        text: "Handle the completion event. Tests: replay and restart.",
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 100));
  check(
    reports.get("a".repeat(32)).pr.title === "Restore compact completion" &&
      reports.get("a".repeat(32)).submitted === false,
  );
  s = view(await call(action(s, "Settings")));
  s = view(await call(action(s, "Configure provider")));
  check(s.nodes.find((n) => n.label === "Save settings").disabled);
  check((await call(action(s, "Save settings"))).error);
  s = view(await call(action(s, "Provider", "select", { value: "gamma" })));
  s = view(await call({ action: "wait", milliseconds: 800 }));
  s = view(
    await call(action(s, "Reasoning level", "select", { value: "low" })),
  );
  s = view(await call(action(s, "Save settings")));
  await new Promise((r) => setTimeout(r, 100));
  check(reports.get("a".repeat(32)).dynamic.saved === true);
  s = view(await call(action(s, "Target game")));
  for (let i = 0; i < 8; i++) s = view(await call(action(s, "Target")));
  await new Promise((r) => setTimeout(r, 100));
  check(
    reports.get("a".repeat(32)).game.hits === 8 &&
      reports.get("a".repeat(32)).game.misses === 0,
  );
  s = view(await call({ action: "navigate", url: origin + "/stale" }));
  check(
    s.nodes.find((n) => n.type === "password").value === "<redacted>" &&
      !JSON.stringify(s).includes("private-password"),
  );
  await new Promise((r) => setTimeout(r, 1200));
  check((await call(action(s, "Original"))).error);
  s = view(await call({ action: "navigate", url: origin + "/many" }));
  check(s.truncated && s.nodes.length <= 60);
  const seen = new Set(s.nodes.map((n) => n.ref));
  while (s.next_node_offset !== null) {
    s = view(
      await call({ action: "observe", node_offset: s.next_node_offset }),
    );
    for (const n of s.nodes) seen.add(n.ref);
  }
  check(seen.size === 180);
  s = view(await call({ action: "observe", text_offset: 3500 }));
  check(s.text_offset === 3500 && s.text.length > 0);
  const envelope = {
    ok: true,
    content: JSON.stringify({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            performed: { action: "observe", effect: "applied" },
            observation: s,
          }),
        },
      ],
    }),
    error: "",
    truncated: false,
  };
  check(Buffer.byteLength(JSON.stringify(envelope)) < 8192);
  check((await call({ action: "observe", scope: "arbitrary css" })).error);
  check((await call({ action: "observe", text_offset: -1 })).error);
  check(
    Buffer.byteLength(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(s) }] }),
    ) <= 48000,
  );
  check((await call({ action: "wait", milliseconds: 10001 })).error);
  check(
    (await call({ action: "observe", script: "document.body.remove()" })).error,
  );
  s = view(await call({ action: "navigate", url: origin + "/failed" }));
  const failed = await call(action(s, "Apply then remove body"));
  check(failed.error && failed.value.effect === "applied");
  check((await call(action(s, "Apply then remove body"))).error);
  const denied = await call({ action: "navigate", url: origin + "/outside" });
  check(denied.error && denied.value.effect === "unknown");
  await call({ action: "wait", milliseconds: 250 });
  await call({ action: "observe" });
  const recovered = await call({
    action: "navigate",
    url: origin + "/?task=issue",
  });
  check(
    !recovered.error ||
      (() => {
        console.error("recovery diagnostic", recovered);
        return false;
      })(),
  );
  console.log("Browser MCP real Chromium contracts passed: " + checks);
} finally {
  child.stdin.end();
  await new Promise((r) => {
    if (closed) return r();
    child.once("exit", r);
    setTimeout(() => {
      if (!closed) child.kill("SIGTERM");
    }, 4000);
  });
  await new Promise((r) => server.close(r));
  check(closed);
}
