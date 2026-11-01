import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { CdpPolicyBridge, policyDeadline } from "./cdp-policy-bridge.js";

/** HTTP(S) exact-origin policy is installed before target startup, including
 * popup redirect chains. No preflight GET, synthetic response or navigation replay.
 */
export class NetworkPolicy {
  private readonly targetIds = new WeakMap<Page, string>();
  private readonly pages = new WeakMap<Page, Promise<void>>();
  private constructor(private readonly context: BrowserContext, private readonly bridge: CdpPolicyBridge) {}
  get failure(): string | undefined { return this.bridge.failure; }
  static async create(browser: Browser, context: BrowserContext, origins: readonly string[]): Promise<NetworkPolicy> {
    return new NetworkPolicy(context, await CdpPolicyBridge.create(browser, origins));
  }
  async ensureUnclaimedTargets(): Promise<void> { await this.bridge.ensureTargets(); }
  async close(): Promise<void> { await this.bridge.close(); }
  async initialize(page: Page): Promise<void> {
    let pending = this.pages.get(page);
    if (!pending) {
      pending = (async () => {
        const session = await policyDeadline(this.context.newCDPSession(page));
        try {
          const { targetInfo } = await policyDeadline(session.send("Target.getTargetInfo"));
          await this.bridge.ensureTarget(targetInfo.targetId);
          this.targetIds.set(page, targetInfo.targetId);
        } finally { await session.detach().catch(() => {}); }
      })();
      this.pages.set(page, pending);
    }
    await pending;
  }
  async drainDenials(page: Page): Promise<Array<{ url: string }>> {
    await this.initialize(page);
    const targetId = this.targetIds.get(page);
    return targetId ? this.bridge.drainDenials(targetId) : [];
  }
  async ensure(frame: Frame): Promise<void> { await this.initialize(frame.page()); }
}
