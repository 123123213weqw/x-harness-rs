// Dedicated real Chromium surface. Control endpoints are evaluator-only;
// the model gets neither this capability nor the hidden grader's state.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
const root = process.env.GUI_BENCH_ROOT ?? "/tmp/xharness-gui-20261001";
const deps = process.env.UI_TEST_DEPS ?? "/tmp/xharness-ui-deps";
const require = createRequire(resolve(deps, "package.json"));
const { chromium } = require("playwright");
const token = randomBytes(32).toString("hex");
const html = readFileSync(new URL("./fixtures/index.html", import.meta.url));
const browser = await chromium.launch({
  headless: process.env.GUI_BENCH_HEADLESS === "1",
  args: [
    "--window-size=1100,800",
    "--window-position=80,100",
    "--force-device-scale-factor=1",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1060, height: 690 },
});
const page = await context.newPage();
const states = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/report" && req.method === "POST") {
    const run = url.searchParams.get("run");
    if (!/^[a-f0-9]{32}$/.test(run ?? "")) {
      res.writeHead(400);
      res.end();
      return;
    }
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 64000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    try {
      states.set(run, JSON.parse(data));
      res.end("{}");
    } catch {
      res.writeHead(400);
      res.end();
    }
    return;
  }
  if (!url.pathname.startsWith("/control/")) {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(html);
    return;
  }
  const credential = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from("Bearer " + token);
  if (
    credential.length !== expected.length ||
    !timingSafeEqual(credential, expected)
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    if (url.pathname === "/control/reset") {
      const task = url.searchParams.get("task");
      if (!["issue", "pr", "dynamic", "game"].includes(task))
        throw Error("invalid task");
      await page.goto(origin + "/?task=" + task);
      await page.bringToFront();
      res.end("{}");
    } else if (url.pathname === "/control/state") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          url.searchParams.has("run")
            ? (states.get(url.searchParams.get("run")) ?? {})
            : await page.evaluate(() => window.__acceptanceState),
        ),
      );
    } else if (url.pathname === "/control/screenshot") {
      res.setHeader("content-type", "image/png");
      res.end(await page.screenshot());
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch {
    res.writeHead(500);
    res.end('{"error":"fixture control failed"}');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
mkdirSync(root, { recursive: true, mode: 0o700 });
writeFileSync(
  resolve(root, "fixture-control.json"),
  JSON.stringify({ origin, capability: token }),
  { mode: 0o600 },
);
await page.goto(origin + "/?task=issue");
console.log("Dedicated Chromium acceptance fixture ready");
async function close() {
  server.close();
  await browser.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
