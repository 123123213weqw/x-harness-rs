import { chromium } from "playwright";
import type { Browser, BrowserContext, Dialog, Download, ElementHandle, Frame, Locator, Page } from "playwright";
import { NetworkPolicy } from "./network-policy.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BrowserCommand, BrowserReceipt, EngineOptions, Target } from "./types.js";
export type { BrowserCommand, BrowserReceipt, EngineOptions, Target } from "./types.js";

declare global {
  interface Window { __xharnessGeometry?: { revision: number } }
}

class CaptureInvalidated extends Error {}

function documentGeometry(): string {
  let state = window.__xharnessGeometry;
  if (!state) {
    state = { revision: 0 };
    window.__xharnessGeometry = state;
    const current = state;
    new MutationObserver(() => { current.revision++; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    if (document.documentElement) { let initial = true; new ResizeObserver(() => { if (initial) { initial = false; return; } current.revision++; }).observe(document.documentElement); }
  }
  return JSON.stringify([state.revision, scrollX, scrollY, innerWidth, innerHeight, document.documentElement?.scrollWidth, document.documentElement?.scrollHeight]);
}

interface Reference {
  element: ElementHandle<SVGElement | HTMLElement>;
  fingerprint: string;
  frame: Frame;
}
interface Capture { id: string; epoch: number; width: number; height: number; actionable: boolean; geometry: Array<{ frame: Frame; stamp: string }> }
interface Tab {
  id: string;
  page: Page;
  observationId: string;
  refs: Map<string, Reference>;
  frames: Map<string, Frame>;
  epoch: number;
  screenshot?: Capture;
  pointer?: { button: "left" | "right" | "middle"; screenshot: Capture };
  dialog?: Dialog;
  downloads: Map<string, Download>;
  console: Array<{ seq: number; type: string; text: string }>;
  network: Array<{ seq: number; event: string; url: string; method?: string; status?: number; error?: string; source?: "native-policy" }>;
}
interface NodeRecord {
  ref: string;
  frameId: string;
  tag: string;
  role: string;
  name: string;
  label: string;
  type: string;
  value: string | null;
  disabled: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
}
function dialogSnapshot(tab: Tab): { type: string; message: string } | null {
  const dialog = tab.dialog;
  return dialog ? { type: dialog.type(), message: dialog.message().slice(0, 500) } : null;
}
const candidateSelector = 'button,input:not([type="hidden"]),textarea,select,a[href],summary,[role],[contenteditable="true"],h1,h2,h3';
const readOnly = new Set(["tabs", "observe", "screenshot", "console", "network", "wait"]);

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch { return value === "about:blank" ? value : "<unavailable>"; }
}
// The active address is task evidence (search/sort queries matter); redact known
// credential parameters. Passive network telemetry uses safeUrl and omits all queries.
function visibleUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.hash = "";
    for (const key of url.searchParams.keys()) if (/token|secret|password|passwd|authorization|signature|api[_-]?key|credential/i.test(key)) url.searchParams.set(key, "<redacted>");
    return url.href.slice(0, 2048);
  } catch { return safeUrl(value); }
}
function redactPasswordValues(snapshot: string, secrets: string[]): string {
  let sanitized = snapshot;
  for (const secret of new Set(secrets)) {
    if (!secret) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    sanitized = sanitized.split(escaped).join("");
    sanitized = sanitized.split(secret).join("");
  }
  return sanitized;
}
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1600) : "Browser operation failed";
}
function elementMetadata(element: SVGElement | HTMLElement) {
  const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const labels = input ? Array.from(element.labels ?? []).map(label => label.textContent ?? "").join(" ") : "";
  const referenced = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
    .map(id => element.getRootNode() instanceof Document ? element.ownerDocument.getElementById(id)?.textContent ?? "" : "").join(" ");
  const name = (element.getAttribute("aria-label") || referenced || labels || element.getAttribute("alt") || element.getAttribute("placeholder") || element.textContent || element.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 240);
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? "";
  const type = element.getAttribute("type") ?? "";
  return { tag, role, name, type, value: input ? element instanceof HTMLInputElement && element.type === "password" ? "<redacted>" : element.value.slice(0, 500) : null, disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true", fingerprint: JSON.stringify([tag, role, type, name, element.getAttribute("href")]) };
}

/** A dedicated ephemeral browser context. Never attaches to a user's profile. */
export class BrowserUseEngine {
  private readonly tabs = new Map<string, Tab>();
  private selected = "";
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private sequence = 0;
  private policyFailure: () => string | undefined = () => undefined;
  private networkPolicy?: NetworkPolicy;
  private readonly maxOutput: number;
  private constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly options: EngineOptions, private readonly artifactRoot: string) {
    this.maxOutput = Math.max(4000, Math.min(options.maxOutputChars ?? 18000, 64000));
    context.on("page", page => {
      if (this.tabs.size >= 20 && !Array.from(this.tabs.values()).some(tab => tab.page === page)) { void page.close().catch(() => {}); return; }
      this.register(page);
    });
  }
  static async create(options: EngineOptions): Promise<BrowserUseEngine> {
    if (!Array.isArray(options.allowedOrigins)) throw new Error("Explicit allowedOrigins is required");
    for (const origin of options.allowedOrigins) {
      const url = new URL(origin);
      if (/[\*(){}\\]/.test(origin) || !["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("allowedOrigins must contain exact HTTP(S) origins");
    }
    if (options.proxy) {
      const proxy = new URL(options.proxy);
      if (!["http:", "https:", "socks5:"].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error("Invalid operator proxy");
    }
    await mkdir(resolve(options.artifactRoot), { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(options.artifactRoot));
    const browser = await chromium.launch({ headless: options.headless ?? true, ...(options.proxy ? { proxy: { server: options.proxy, bypass: "127.0.0.1,localhost" } } : {}) });
    try {
      const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: "block" });
      context.setDefaultTimeout(Math.min(Math.max(options.timeoutMs ?? 6000, 100), 30000));
      context.setDefaultNavigationTimeout(15000);
      const networkPolicy = await NetworkPolicy.create(browser, context, options.allowedOrigins);
      let policyFailure: string | undefined;
      await context.route("**/*", async route => {
        let requestFrame: Frame | undefined;
        try {
          try { requestFrame = route.request().frame(); } catch { /* Initial popup requests have no Frame yet. */ }
          if (requestFrame) await networkPolicy.ensure(requestFrame);
          else await networkPolicy.ensureUnclaimedTargets();
        }
        catch (error) {
          if (!requestFrame || (!requestFrame.isDetached() && !requestFrame.page().isClosed())) policyFailure = errorMessage(error);
          await route.abort("blockedbyclient").catch(() => {}); return;
        }
        if (route.request().isNavigationRequest()) {
          try {
            if (!options.allowedOrigins.includes(new URL(route.request().url()).origin)) { await route.abort("blockedbyclient"); return; }
          } catch { await route.abort("blockedbyclient"); return; }
        }
        await route.continue();
      });
      const engine = new BrowserUseEngine(browser, context, options, root);
      const page = await context.newPage();
      await networkPolicy.initialize(page);
      engine.policyFailure = () => policyFailure ?? networkPolicy.failure;
      engine.networkPolicy = networkPolicy;
      engine.selected = engine.register(page).id;
      return engine;
    } catch (error) { await browser.close(); throw error; }
  }
  private register(page: Page): Tab {
    for (const tab of this.tabs.values()) if (tab.page === page) return tab;
    const tab: Tab = { id: `tab-${randomUUID()}`, page, observationId: "", refs: new Map(), frames: new Map(), epoch: 0, downloads: new Map(), console: [], network: [] };
    this.tabs.set(tab.id, tab);
    if (!this.selected) this.selected = tab.id;
    page.on("framenavigated", () => { tab.epoch++; tab.observationId = ""; });
    page.on("close", () => { void this.clearRefs(tab); this.tabs.delete(tab.id); if (this.selected === tab.id) this.selected = this.tabs.keys().next().value ?? ""; });
    page.on("dialog", dialog => { tab.dialog = dialog; });
    page.on("download", download => { if (tab.downloads.size < 100) tab.downloads.set(`download-${randomUUID()}`, download); else void download.cancel(); });
    page.on("console", message => {
      tab.console.push({ seq: ++this.sequence, type: message.type(), text: message.text().slice(0, 1000) });
      if (tab.console.length > 200) tab.console.shift();
    });
    page.on("response", response => {
      tab.network.push({ seq: ++this.sequence, event: "response", url: safeUrl(response.url()), method: response.request().method(), status: response.status() });
      if (tab.network.length > 200) tab.network.shift();
    });
    page.on("requestfailed", request => {
      tab.network.push({ seq: ++this.sequence, event: "failed", url: safeUrl(request.url()), error: request.failure()?.errorText.slice(0, 240) ?? "unknown" });
      if (tab.network.length > 200) tab.network.shift();
    });
    return tab;
  }
  /** Commands are serialized; mutating actions are never automatically retried. */
  execute(command: BrowserCommand): Promise<BrowserReceipt> {
    const result = this.tail.then(() => this.perform(command));
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  async close(): Promise<void> {
    await this.tail;
    this.closed = true;
    await this.browser.close();
    await this.networkPolicy?.close();
    this.tabs.clear();
  }
  private tab(id?: string): Tab {
    const tab = this.tabs.get(id ?? this.selected);
    if (!tab || tab.page.isClosed()) throw new Error("Unknown or closed tab");
    return tab;
  }
  private async clearRefs(tab: Tab): Promise<void> {
    const refs = Array.from(tab.refs.values());
    tab.refs.clear();
    await Promise.all(refs.map(ref => ref.element.dispose().catch(() => {})));
  }
  private assertUrl(url: string): void {
    const parsed = new URL(url);
    if (!this.options.allowedOrigins.includes(parsed.origin) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Navigation origin is not allowed");
  }
  private async resolveTarget(tab: Tab, target: Target, strict = true): Promise<Locator | ElementHandle<SVGElement | HTMLElement>> {
    if ("ref" in target) {
      if (target.observationId !== tab.observationId || !tab.observationId) throw new Error("Stale observation; a new observation, effect or navigation invalidated it. Call observe again and use only nodes[].ref with that response's observationId. Do not blindly replay an uncertain effect.");
      const ref = tab.refs.get(target.ref);
      if (!ref) throw new Error("Reference was not returned by the current observation. Use only current nodes[].ref; follow nextNodeOffset to read omitted nodes. Never combine an older ref with a new observationId.");
      if (ref.frame.isDetached()) throw new Error("Reference frame detached; observe again and verify the intended target before acting.");
      const current = await ref.element.evaluate(element => element.isConnected ? true : false);
      if (!current || (await ref.element.evaluate(elementMetadata)).fingerprint !== ref.fingerprint) throw new Error("Reference identity changed; observe again and verify the intended target before acting.");
      return ref.element;
    }
    const frame = target.frameId ? tab.frames.get(target.frameId) : tab.page.mainFrame();
    if (!frame || frame.isDetached()) throw new Error("Unknown or detached frame");
    const exact = target.exact ?? true;
    let locator: Locator;
    if (target.by === "role") locator = frame.getByRole(target.role, { ...(target.name === undefined ? {} : { name: target.name }), exact });
    else if (target.by === "text") locator = frame.getByText(target.value, { exact });
    else if (target.by === "label") locator = frame.getByLabel(target.value, { exact });
    else if (target.by === "placeholder") locator = frame.getByPlaceholder(target.value, { exact });
    else locator = frame.getByTestId(target.value);
    const count = await locator.count();
    if (strict && count > 1) {
      const visible = locator.filter({ visible: true });
      if (await visible.count() === 1) return visible;
      throw new Error(`Target must match exactly one element; matched ${count}. Observe the page, then choose the intended current node ref; do not guess an index.`);
    }
    return locator;
  }
  private async artifactInput(path: string): Promise<string> {
    const candidate = await realpath(isAbsolute(path) ? path : resolve(this.artifactRoot, path));
    const rel = relative(this.artifactRoot, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("File is outside the explicit artifact root");
    if (!(await stat(candidate)).isFile()) throw new Error("Upload requires a regular file");
    return candidate;
  }
  private async navigateSettled(page: Page, operation: () => Promise<unknown>): Promise<void> {
    // A rejected Chromium navigation can still be committing its error document.
    // waitForLoadState may read the PREVIOUS document's already-loaded state.
    // Observe a future main-frame commit/load instead; never replay the effect.
    let committed = false, loaded = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => { const current = wake; wake = undefined; current?.(); };
    const requested = (request: import("playwright").Request) => {
      if (!request.isNavigationRequest()) return;
      try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
      committed = false; loaded = false; notify();
    };
    const navigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      committed = true; loaded = false; notify();
    };
    const completed = () => { if (committed) { loaded = true; notify(); } };
    page.on("request", requested);
    page.on("framenavigated", navigated);
    page.on("load", completed);
    page.on("close", notify);
    try { await operation(); }
    catch (error) {
      const deadline = performance.now() + 2000;
      while (!loaded && !page.isClosed()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, remaining); });
        if (timer) clearTimeout(timer);
        timer = undefined; wake = undefined;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      page.off("request", requested);
      page.off("framenavigated", navigated);
      page.off("load", completed);
      page.off("close", notify);
    }
  }
  /** Retry only discarded read-only captures, never the preceding action.
   * A parent's DOMContentLoaded does not settle its child-frame navigations.
   * Every attempt still validates navigation and geometry; continuously moving
   * pages fail after three attempts without publishing an actionable raster. */
  private async captureScreenshot(tab: Tab, fullPage: boolean) {
    delete tab.screenshot;
    const deadline = performance.now() + 10000;
    for (let attempt = 0; ; attempt++) {
      const epoch = tab.epoch;
      const id = `screenshot-${randomUUID()}`;
      const path = resolve(this.artifactRoot, `${id}.png`);
      try {
        const geometry = await Promise.all(tab.page.frames().map(async frame => {
          try { return { frame, stamp: await frame.evaluate(documentGeometry) }; }
          catch (error) {
            if (epoch !== tab.epoch || frame.isDetached()) throw new CaptureInvalidated("Navigation during screenshot; capture again");
            throw error;
          }
        }));
        let dimensions: { width: number; height: number };
        try { dimensions = await tab.page.evaluate(full => ({ width: full ? document.documentElement.scrollWidth : innerWidth, height: full ? document.documentElement.scrollHeight : innerHeight }), fullPage); }
        catch (error) {
          if (epoch !== tab.epoch) throw new CaptureInvalidated("Navigation during screenshot; capture again");
          throw error;
        }
        if (dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 16000000) throw new Error("Screenshot dimensions exceed image budget; use viewport screenshot");
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Screenshot capture budget exhausted; capture again");
        let png: Buffer;
        try { png = await tab.page.screenshot({ path, fullPage, scale: "css", caret: "initial", timeout: remaining }); }
        catch (error) {
          if (epoch !== tab.epoch) throw new CaptureInvalidated("Navigation during screenshot; capture again");
          throw error;
        }
        const image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), mimeType: "image/png", byteLength: png.length };
        if (image.byteLength > 8 * 1024 * 1024 || image.width > 8192 || image.height > 8192 || image.width * image.height > 16000000) throw new Error("Screenshot exceeds image budget");
        if (epoch !== tab.epoch) throw new CaptureInvalidated("Navigation during screenshot; capture again");
        for (const captured of geometry) {
          if (captured.frame.isDetached()) throw new CaptureInvalidated("Layout changed during screenshot; capture again");
          let stamp: string;
          try { stamp = await captured.frame.evaluate(documentGeometry); }
          catch (error) {
            if (epoch !== tab.epoch || captured.frame.isDetached()) throw new CaptureInvalidated("Navigation during screenshot; capture again");
            throw error;
          }
          if (captured.stamp !== stamp) throw new CaptureInvalidated("Layout changed during screenshot; capture again");
        }
        if (epoch !== tab.epoch) throw new CaptureInvalidated("Navigation during screenshot; capture again");
        const viewport = tab.page.viewportSize();
        if (!viewport) throw new Error("No viewport geometry available");
        tab.screenshot = { id, epoch, width: viewport.width, height: viewport.height, actionable: !fullPage, geometry };
        return { screenshotId: id, path, image, viewport, scale: 1, fullPage, coordinateSpace: "CSS viewport", actionable: !fullPage, url: safeUrl(tab.page.url()) };
      } catch (error) {
        await rm(path, { force: true });
        if (!(error instanceof CaptureInvalidated) || attempt >= 2 || performance.now() >= deadline) throw error;
      }
    }
  }
  private async observe(tab: Tab, nodeOffset = 0, textOffset = 0, selectedFrame?: string, frameOffset = 0, scope: "page" | "main" | "dialog" = "page"): Promise<unknown> {
    if (!Number.isSafeInteger(nodeOffset) || nodeOffset < 0 || !Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error("Offsets must be nonnegative integers");
    if (tab.dialog) return { tabId: tab.id, url: visibleUrl(tab.page.url()), contentTrust: "untrusted webpage evidence", pointer: tab.pointer ? { button: tab.pointer.button, screenshotId: tab.pointer.screenshot.id } : null, dialog: { type: tab.dialog.type(), message: tab.dialog.message().slice(0, 500) }, nodes: [], frames: [], observationId: "", requiresDialogResolution: true };
    // A click can commit a document before its body is attached. Read-only
    // observation waits for that document; it never retries the preceding action.
    try { await tab.page.locator("body").waitFor({ state: "attached", timeout: 2000 }); }
    catch { throw new Error("Page body is missing; observation is unreadable"); }
    const selected = selectedFrame ? tab.frames.get(selectedFrame) : undefined;
    if (selectedFrame && (!selected || selected.isDetached())) throw new Error("Unknown frame");
    await this.clearRefs(tab);
    tab.observationId = `observation-${randomUUID()}`;
    const allFrames = selected ? [selected] : scope === "page" ? tab.page.frames() : [tab.page.mainFrame()];
    if (!Number.isSafeInteger(frameOffset) || frameOffset < 0) throw new Error("Invalid frame offset");
    const frames = allFrames.slice(frameOffset, frameOffset + 16);
    const frameRecords = [];
    const nodes: NodeRecord[] = [];
    let globalIndex = 0;
    let nextNodeOffset: number | null = null;
    let text = "";
    let textTotal = 0;
    let remainingAria = Math.floor(this.maxOutput / 3);
    const observationEpoch = tab.epoch;
    for (const frame of frames) {
      if (frame.isDetached()) continue;
      let frameId = Array.from(tab.frames).find(([, item]) => item === frame)?.[0];
      if (!frameId) { frameId = `frame-${randomUUID()}`; tab.frames.set(frameId, frame); }
      const body = scope === "main" ? frame.locator('main,[role="main"]').filter({ visible: true }) : scope === "dialog" ? frame.locator('dialog[open],[role="dialog"]').filter({ visible: true }) : frame.locator("body");
      if (scope !== "page" && await body.count() !== 1) throw new Error(`Observation scope ${scope} must match exactly one visible element`);
      let aria = "", frameText = "", frameError: string | undefined;
      try {
        if (await body.count()) {
          const secrets = await body.locator('input[type="password"]').evaluateAll(elements => elements.flatMap(element => element instanceof HTMLInputElement && element.value ? [element.value] : []));
          if (secrets.length > 100 || secrets.reduce((total, secret) => total + secret.length, 0) > 65536) throw new Error("Sensitive input budget exceeded; ARIA snapshot withheld");
          aria = redactPasswordValues(await body.ariaSnapshot({ timeout: 2000 }), secrets).slice(0, remainingAria);
          const content = await body.evaluate((element, offset) => { const value = element instanceof HTMLElement ? element.innerText : element.textContent ?? ""; return { text: value.slice(offset, offset + 2500), total: value.length }; }, Math.max(0, textOffset - textTotal));
          frameText = content.text;
          textTotal += content.total;
        }
      } catch (error) { frameError = errorMessage(error).slice(0, 200); }
      remainingAria = Math.max(0, remainingAria - aria.length);
      text += frameText;
      frameRecords.push({ frameId, name: frame.name().slice(0, 120), url: safeUrl(frame.url()).slice(0, 256), aria, ...(frameError ? { error: frameError } : {}) });
      const candidates = body.locator(candidateSelector);
      const count = await candidates.count();
      const start = Math.max(0, nodeOffset - globalIndex);
      const scanEnd = Math.min(count, start + 500);
      for (let i = start; i < scanEnd; i++) {
        if (nodes.length >= 60) { if (nextNodeOffset === null) nextNodeOffset = globalIndex + i; break; }
        const element = await candidates.nth(i).elementHandle();
        if (!element) continue;
        if (!await element.isVisible()) { await element.dispose(); continue; }
        const data = await element.evaluate(elementMetadata);
        const ref = `node-${globalIndex + i}`;
        tab.refs.set(ref, { element, fingerprint: data.fingerprint, frame });
        nodes.push({ ref, frameId, tag: data.tag, role: data.role, name: data.name, label: data.name, type: data.type, value: data.value, disabled: data.disabled, bounds: await element.boundingBox() });
      }
      if (scanEnd < count && nextNodeOffset === null) nextNodeOffset = globalIndex + scanEnd;
      globalIndex += count;
    }
    if (observationEpoch !== tab.epoch) { await this.clearRefs(tab); tab.observationId = ""; throw new Error("Page navigated during observation; observe again"); }
    const textChunk = text.slice(0, 2500);
    const result = { scope, observationId: tab.observationId, tabId: tab.id, url: visibleUrl(tab.page.url()), title: (await tab.page.title()).slice(0, 240), contentTrust: "untrusted webpage evidence", pointer: tab.pointer ? { button: tab.pointer.button, screenshotId: tab.pointer.screenshot.id } : null, frames: frameRecords, nodes, nodeOffset, nodeTotal: globalIndex, nextNodeOffset, text: textChunk, textOffset, textTotal, nextTextOffset: textOffset + textChunk.length < textTotal ? textOffset + textChunk.length : null, framesTruncated: allFrames.length > frameOffset + frames.length, frameOffset, nextFrameOffset: allFrames.length > frameOffset + frames.length ? frameOffset + frames.length : null, dialog: dialogSnapshot(tab), downloads: Array.from(tab.downloads, ([id, download]) => ({ id, filename: download.suggestedFilename().slice(0, 100) })).slice(-20) };
    const reservedNodes = Math.min(8, result.nodes.length);
    while (jsonBytes(result) > this.maxOutput && result.nodes.length > reservedNodes) {
      const node = result.nodes.pop();
      if (node) { result.nextNodeOffset = Number(node.ref.slice(5)); const ref = tab.refs.get(node.ref); await ref?.element.dispose(); tab.refs.delete(node.ref); }
    }
    while (jsonBytes(result) > this.maxOutput) {
      const record = result.frames.find(item => item.aria.length > 0);
      if (record) { record.aria = record.aria.slice(0, Math.max(0, record.aria.length - 1000)); continue; }
      if (result.text.length > 200) { result.text = result.text.slice(0, Math.max(200, result.text.length - 500)); result.nextTextOffset = textOffset + result.text.length; continue; }
      if (result.frames.length > 1) { result.frames.pop(); result.framesTruncated = true; result.nextFrameOffset = frameOffset + result.frames.length; continue; }
      if (result.downloads.length > 1) { result.downloads.pop(); continue; }
      if (result.nodes.length > 0) {
        const node = result.nodes.pop();
        if (node) { result.nextNodeOffset = Number(node.ref.slice(5)); const ref = tab.refs.get(node.ref); await ref?.element.dispose(); tab.refs.delete(node.ref); }
        continue;
      }
      if (result.title.length) { result.title = result.title.slice(0, Math.floor(result.title.length / 2)); continue; }
      if (result.url.length) { result.url = result.url.slice(0, Math.floor(result.url.length / 2)); continue; }
      const frame = result.frames[0];
      if (frame && (frame.name.length || frame.url.length || frame.error)) { frame.name = ""; frame.url = ""; delete frame.error; continue; }
      if (result.downloads.length) { result.downloads.pop(); continue; }
      if (result.dialog) { result.dialog.message = result.dialog.message.slice(0, Math.floor(result.dialog.message.length / 2)); if (!result.dialog.message) result.dialog = null; continue; }
      throw new Error("Observation metadata exceeds UTF-8 output budget");
    }
    for (const [id, frame] of tab.frames) if (frame.isDetached()) tab.frames.delete(id);
    return result;
  }
  private async perform(command: BrowserCommand): Promise<BrowserReceipt> {
    let started = false;
    let tab: Tab | undefined;
    const isRead = readOnly.has(command.action);
    const beginEffect = () => {
      started = true;
      if (tab) { tab.observationId = ""; delete tab.screenshot; }
    };
    try {
      if (this.closed) throw new Error("Engine is closed");
      const held = Array.from(this.tabs.values()).find(item => item.pointer);
      if (held?.pointer && !isRead && command.action !== "close") {
        const continuation = command.action === "mouse" && (command.operation === "up" || command.operation === "move") && (command.tabId ?? this.selected) === held.id && command.screenshotId === held.pointer.screenshot.id;
        if (!continuation) throw new Error(`Pointer is held in ${held.id}; release ${held.pointer.button} with mouse up and screenshotId ${held.pointer.screenshot.id} before another effect`);
      }
      const policyFailure = this.policyFailure();
      if (policyFailure && command.action !== "close" && command.action !== "tabs") throw new Error(`Native origin enforcement failed closed: ${policyFailure}`);
      if (command.action === "tabs") {
        const perTab = Math.max(20, Math.floor((this.maxOutput - 1000) / Math.max(1, this.tabs.size)) - 120);
        const result = await Promise.all(Array.from(this.tabs.values(), async item => ({ tabId: item.id, selected: item.id === this.selected, url: safeUrl(item.page.url()).slice(0, Math.floor(perTab * 0.7)), title: item.dialog ? "" : (await item.page.title().catch(() => "")).slice(0, Math.min(240, Math.floor(perTab * 0.3))) })));
        while (jsonBytes(result) > this.maxOutput) {
          const row = result.reduce((longest, item) => item.title.length + item.url.length > longest.title.length + longest.url.length ? item : longest, result[0] ?? { tabId: "", selected: false, url: "", title: "" });
          if (row.title.length) row.title = row.title.slice(0, Math.floor(row.title.length / 2));
          else if (row.url.length) row.url = row.url.slice(0, Math.floor(row.url.length / 2));
          else break;
        }
        return { action: command.action, outcome: "applied", replaySafe: true, result };
      }
      if (command.action === "new") {
        if (this.tabs.size >= 20) throw new Error("Tab limit reached (20)");
        if (command.url) this.assertUrl(command.url);
        beginEffect();
        tab = this.register(await this.context.newPage());
        this.selected = tab.id;
        await this.networkPolicy?.initialize(tab.page);
        if (command.url) { const page = tab.page, url = command.url; await this.navigateSettled(page, () => page.goto(url, { waitUntil: "domcontentloaded" })); }
        return { action: command.action, outcome: "applied", tabId: tab.id, replaySafe: false, result: { url: safeUrl(tab.page.url()) } };
      }
      tab = this.tab(command.action === "select" || command.action === "close" ? command.targetTabId : command.tabId);
      let result: unknown = {};
      if (command.action === "select") { this.selected = tab.id; result = { selected: tab.id }; }
      else if (command.action === "close") { beginEffect(); await tab.page.close({ runBeforeUnload: false }); delete tab.pointer; result = { closed: tab.id, selected: this.selected || null }; }
      else if (command.action === "navigate") {
        this.assertUrl(command.url);
        if (command.reuse) {
          const existing = Array.from(this.tabs.values()).find(item => item.page.url() === command.url);
          if (existing) { this.selected = existing.id; return { action: command.action, outcome: "applied", tabId: existing.id, replaySafe: true, result: { reused: true } }; }
        }
        beginEffect(); const page = tab.page; await this.navigateSettled(page, () => page.goto(command.url, { waitUntil: "domcontentloaded" })); result = { url: safeUrl(tab.page.url()) };
      } else if (command.action === "back" || command.action === "forward" || command.action === "reload") {
        beginEffect();
        const page = tab.page;
        if (command.action === "back") await this.navigateSettled(page, () => page.goBack({ waitUntil: "domcontentloaded" }));
        else if (command.action === "forward") await this.navigateSettled(page, () => page.goForward({ waitUntil: "domcontentloaded" }));
        else await this.navigateSettled(page, () => page.reload({ waitUntil: "domcontentloaded" }));
        result = { url: safeUrl(tab.page.url()) };
      } else if (command.action === "observe") result = await this.observe(tab, command.nodeOffset, command.textOffset, command.frameId, command.frameOffset, command.scope);
      else if (command.action === "wait") {
        if (command.target) {
          const target = await this.resolveTarget(tab, command.target, false);
          if ("waitFor" in target) await target.waitFor({ state: command.state ?? "visible" });
          else if (command.state === "detached") await tab.page.waitForFunction(element => !element.isConnected, target);
          else if (command.state !== "attached") await target.waitForElementState(command.state ?? "visible");
        } else if (command.loadState) await tab.page.waitForLoadState(command.loadState);
        else {
          const milliseconds = command.milliseconds ?? 0;
          if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 10000) throw new Error("Wait duration must be 0..10000ms");
          await new Promise(resolve => setTimeout(resolve, milliseconds));
        }
      } else if (command.action === "console" || command.action === "network") {
        if (command.action === "network" && this.networkPolicy) {
          for (const denial of await this.networkPolicy.drainDenials(tab.page)) {
            tab.network.push({ seq: ++this.sequence, event: "failed", url: denial.url, error: "BlockedByClient: native Fetch.failRequest acknowledged", source: "native-policy" });
            if (tab.network.length > 200) tab.network.shift();
          }
        }
        const entries = (command.action === "console" ? tab.console : tab.network).filter(entry => entry.seq > (command.after ?? 0)).slice(-50);
        while (jsonBytes(entries) > this.maxOutput - 500) entries.shift();
        result = { entries, next: entries.at(-1)?.seq ?? command.after ?? 0, boundedRetention: 200 };
      } else if (command.action === "screenshot") {
        if (tab.dialog) throw new Error("Resolve the pending JavaScript dialog before screenshot");
        result = await this.captureScreenshot(tab, command.fullPage ?? false);
      } else if (command.action === "dialog") {
        const dialog = tab.dialog;
        if (!dialog) throw new Error("No pending dialog");
        beginEffect();
        if (command.accept) await dialog.accept(command.text); else await dialog.dismiss();
        delete tab.dialog;
      } else if (command.action === "download") {
        const download = tab.downloads.get(command.downloadId);
        if (!download) throw new Error("Unknown download");
        const path = resolve(this.artifactRoot, `${command.downloadId}.download`);
        beginEffect();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([download.saveAs(path), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Download completion timed out; effect may still finish")), 15000); })]);
        } finally { if (timer) clearTimeout(timer); }
        result = { path, filename: download.suggestedFilename().slice(0, 200), failure: await download.failure() };
      } else if (command.action === "mouse") {
        const gesture = tab.pointer;
        const continuation = gesture && gesture.screenshot.id === command.screenshotId && (command.operation === "move" || command.operation === "up");
        const shot = continuation ? gesture.screenshot : tab.screenshot;
        if (continuation && command.operation === "move" && gesture.screenshot.epoch !== tab.epoch) {
          beginEffect();
          try { await tab.page.mouse.up({ button: gesture.button }); } finally { delete tab.pointer; }
          throw new Error("Page changed during pointer gesture; pointer released, capture again");
        }
        if (gesture && !continuation) throw new Error("Release the current pointer gesture before starting another");
        if (!shot || shot.id !== command.screenshotId || (command.operation !== "up" && shot.epoch !== tab.epoch) || !shot.actionable) throw new Error("Stale or non-viewport screenshot; capture again");
        if (!continuation) for (const captured of shot.geometry) if (captured.frame.isDetached() || captured.stamp !== await captured.frame.evaluate(documentGeometry)) throw new Error("Screenshot layout changed; capture again");
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y) || command.x < 0 || command.y < 0 || command.x >= shot.width || command.y >= shot.height) throw new Error("Coordinates outside screenshot viewport");
        beginEffect();
        if (command.operation === "click") await tab.page.mouse.click(command.x, command.y, { button: command.button ?? "left" });
        else if (command.operation === "move") await tab.page.mouse.move(command.x, command.y);
        else {
          await tab.page.mouse.move(command.x, command.y);
          if (command.operation === "down") { tab.pointer = { button: command.button ?? "left", screenshot: shot }; await tab.page.mouse.down({ button: command.button ?? "left" }); }
          else { await tab.page.mouse.up({ button: gesture?.button ?? command.button ?? "left" }); delete tab.pointer; }
        }
        delete tab.screenshot;
      } else if (command.action === "scroll") {
        if (command.observationId !== undefined && command.observationId !== tab.observationId) throw new Error("Stale observation; a new observation, effect or navigation invalidated it. Call observe again and use only nodes[].ref with that response's observationId. Do not blindly replay an uncertain effect.");
        if (!Number.isFinite(command.y) || !Number.isFinite(command.x ?? 0)) throw new Error("Invalid scroll delta");
        const target = command.target ? await this.resolveTarget(tab, command.target) : undefined;
        beginEffect();
        if (target) { await target.scrollIntoViewIfNeeded(); const bounds = await target.boundingBox(); if (!bounds) throw new Error("Target has no visible bounds"); await tab.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); }
        await tab.page.mouse.wheel(command.x ?? 0, command.y); delete tab.screenshot;
      } else if (command.action === "press" && !command.target) { beginEffect(); await tab.page.keyboard.press(command.key); delete tab.screenshot; }
      else if ("target" in command && command.target) {
        const target = await this.resolveTarget(tab, command.target);
        if (command.action === "click") {
          await target.click({ trial: true, button: command.button ?? "left", clickCount: command.clickCount ?? 1 });
          beginEffect(); await target.click({ button: command.button ?? "left", clickCount: command.clickCount ?? 1 });
        } else if (command.action === "drag") {
          const destination = await this.resolveTarget(tab, command.destination);
          await target.click({ trial: true });
          await destination.click({ trial: true });
          const from = await target.boundingBox(), to = await destination.boundingBox(), viewport = tab.page.viewportSize();
          if (!from || !to || !viewport || from.x < 0 || from.y < 0 || to.x < 0 || to.y < 0 || from.x + from.width > viewport.width || from.y + from.height > viewport.height || to.x + to.width > viewport.width || to.y + to.height > viewport.height) throw new Error("Drag endpoints must be visible in the same viewport");
          beginEffect();
          await tab.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
          try {
            await tab.page.mouse.down();
            await tab.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
          } finally { await tab.page.mouse.up(); }
        } else if (command.action === "fill") { if (!await target.isEditable()) throw new Error("Target is not editable"); beginEffect(); await target.fill(command.text); }
        else if (command.action === "type") { await target.click({ trial: true }); beginEffect(); await target.click(); await target.type(command.text); }
        else if (command.action === "press") { beginEffect(); await target.press(command.key); }
        else if (command.action === "hover") { beginEffect(); await target.hover(); }
        else if (command.action === "selectOption") { beginEffect(); const values = await target.selectOption(command.values); const selected = values.slice(0, 20).map(value => value.slice(0, 120)); result = { values: selected, total: values.length, truncated: selected.length !== values.length || values.some(value => value.length > 120) }; }
        else if (command.action === "check") { beginEffect(); await target.setChecked(command.checked); }
        else if (command.action === "upload") {
          if (command.files.length > 20) throw new Error("Upload limit is 20 files");
          const files = await Promise.all(command.files.map(file => this.artifactInput(file)));
          beginEffect(); await target.setInputFiles(files);
        }
        delete tab.screenshot;
      } else throw new Error("Unsupported browser command");
      return { action: command.action, outcome: "applied", tabId: tab.id, result, replaySafe: isRead || command.action === "select" };
    } catch (error) {
      return { action: command.action, outcome: started && !isRead ? "possibly-applied" : "not-started", ...(tab ? { tabId: tab.id } : {}), replaySafe: isRead, error: { code: started && !isRead ? "effect_uncertain" : "operation_rejected", message: errorMessage(error) } };
    }
  }
}
