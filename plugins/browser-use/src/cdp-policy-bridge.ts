import type { Browser, CDPSession } from "playwright";

interface Pending {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface TargetState { ready: Promise<void>; sessionId?: string }
export async function policyDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Native policy control RPC timed out")), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/** Dedicated-browser targets start paused. Install native Fetch interception before
 * releasing that guard: configuring an already-started popup is too late for its
 * initial redirect chain. All transport uses public CDP methods and events.
 */
export class CdpPolicyBridge {
  private readonly targets = new Map<string, TargetState>();
  private readonly pending = new Map<number, Pending>();
  private readonly denials: Array<{ targetId: string; url: string }> = [];
  private id = 0;
  private closed = false;
  failure: string | undefined;
  private constructor(private readonly root: CDPSession, private readonly browser: Browser, private readonly origins: readonly string[]) {
    root.on("Target.attachedToTarget", event => {
      if (!["page", "iframe"].includes(event.targetInfo.type) || this.targets.has(event.targetInfo.targetId)) return;
      if (this.targets.size >= 256) { this.fail(new Error("Native request policy target capacity exceeded")); return; }
      const state: TargetState = { ready: Promise.resolve() };
      this.targets.set(event.targetInfo.targetId, state);
      state.ready = this.configure(event.targetInfo.targetId, event.sessionId, state);
      void state.ready.catch(async error => {
        if (this.closed) return;
        try {
          const { targetInfos } = await policyDeadline(this.root.send("Target.getTargets"));
          if (!targetInfos.some(target => target.targetId === event.targetInfo.targetId)) { this.targets.delete(event.targetInfo.targetId); return; }
        } catch { /* A transport error must not permit an unguarded live browser. */ }
        this.fail(error);
      });
    });
    root.on("Target.receivedMessageFromTarget", event => {
      let value: unknown;
      try { value = JSON.parse(event.message); } catch { this.fail(new Error("Malformed native policy message")); return; }
      const message = record(value);
      if (!message) return;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending || pending.sessionId !== event.sessionId) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        const error = record(message.error);
        if (error) pending.reject(new Error(typeof error.message === "string" ? error.message : "CDP request policy rejected"));
        else if (record(message.result)) pending.resolve();
        else pending.reject(new Error("Malformed CDP request policy response"));
        return;
      }
      if (message.method !== "Fetch.requestPaused") return;
      const params = record(message.params), request = record(params?.request);
      if (!params || typeof params.requestId !== "string" || !request || typeof request.url !== "string") { this.fail(new Error("Malformed native paused request")); return; }
      const requestUrl = request.url;
      let allowed = false;
      try { const url = new URL(requestUrl); allowed = !["http:", "https:"].includes(url.protocol) || this.origins.includes(url.origin); } catch { /* Malformed URLs fail closed. */ }
      const operation = allowed
        ? this.send(event.sessionId, "Fetch.continueRequest", { requestId: params.requestId })
        : this.send(event.sessionId, "Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" });
      void operation.then(() => {
        if (allowed) return;
        const targetId = Array.from(this.targets).find(([, target]) => target.sessionId === event.sessionId)?.[0];
        if (!targetId) return;
        let url = "<unavailable>";
        try { const address = new URL(requestUrl); address.username = ""; address.password = ""; address.search = ""; address.hash = ""; url = address.href.slice(0, 2048); } catch { /* Never expose an unparsed request URL. */ }
        this.denials.push({ targetId, url });
        if (this.denials.length > 200) this.denials.shift();
      }).catch(error => {
        // A same-origin request can be cancelled by navigation between the pause
        // event and continuation. Its expired native id is not a policy failure;
        // never replay it. Denial errors still fail closed, even for this code.
        if (allowed && error instanceof Error && error.message === "Invalid InterceptionId.") return;
        if (Array.from(this.targets.values()).some(target => target.sessionId === event.sessionId)) this.fail(new Error(`${allowed ? "Fetch.continueRequest" : "Fetch.failRequest"}: ${error instanceof Error ? error.message : "native control failed"}`));
      });
    });
    root.on("Target.detachedFromTarget", event => {
      for (const [target, state] of this.targets) if (state.sessionId === event.sessionId) this.targets.delete(target);
      for (const [id, pending] of this.pending) if (pending.sessionId === event.sessionId) {
        this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error("CDP target closed during policy operation"));
      }
    });
    browser.once("disconnected", () => this.clear());
  }
  static async create(browser: Browser, origins: readonly string[]): Promise<CdpPolicyBridge> {
    const bridge = new CdpPolicyBridge(await browser.newBrowserCDPSession(), browser, origins);
    try {
      // Chromium requires flattened browser-level auto-attach. A second public
      // nested session carries commands/events; detach only the temporary guard
      // after interception is installed and Runtime has been resumed.
      await policyDeadline(bridge.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }, { type: "iframe" }, { exclude: true }] }));
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }
  drainDenials(targetId: string): Array<{ url: string }> {
    const entries = this.denials.filter(entry => entry.targetId === targetId).map(entry => ({ url: entry.url }));
    const retained = this.denials.filter(entry => entry.targetId !== targetId);
    this.denials.splice(0, this.denials.length, ...retained);
    return entries;
  }
  async ensureTarget(targetId: string): Promise<void> {
    if (this.closed || this.failure) throw new Error(this.failure ?? "Native request policy is closed");
    const state = this.targets.get(targetId);
    if (!state) throw new Error("Target did not enter the native request policy guard");
    await state.ready;
  }
  async ensureTargets(): Promise<void> {
    if (this.closed || this.failure) throw new Error(this.failure ?? "Native request policy is closed");
    await Promise.all(Array.from(this.targets.values(), state => state.ready));
  }
  private async configure(targetId: string, guardSessionId: string, state: TargetState): Promise<void> {
    const { sessionId } = await policyDeadline(this.root.send("Target.attachToTarget", { targetId, flatten: false }));
    state.sessionId = sessionId;
    await this.send(sessionId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await this.send(sessionId, "Runtime.runIfWaitingForDebugger", {});
    await policyDeadline(this.root.send("Target.detachFromTarget", { sessionId: guardSessionId }));
  }
  private send(sessionId: string, method: string, params: Record<string, unknown>): Promise<void> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Native request policy RPC timed out")); }, 5000);
      this.pending.set(id, { sessionId, resolve, reject, timer });
      void this.root.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); reject(error instanceof Error ? error : new Error("CDP policy forwarding failed"));
      });
    });
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error instanceof Error ? error.message : "Native request policy failed";
    // Do not leave a live, potentially unguarded target after transport failure.
    void this.browser.close().catch(() => {});
  }
  private clear(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Dedicated browser closed")); }
    this.pending.clear(); this.targets.clear(); this.denials.length = 0;
  }
  async close(): Promise<void> { this.clear(); await this.root.detach().catch(() => {}); }
}
