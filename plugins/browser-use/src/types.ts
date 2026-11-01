import type { Frame } from "playwright";

export type Role = Parameters<Frame["getByRole"]>[0];
export type Target =
  | { ref: string; observationId: string }
  | { by: "role"; role: Role; name?: string; exact?: boolean; frameId?: string }
  | { by: "text" | "label" | "placeholder" | "testId"; value: string; exact?: boolean; frameId?: string };
export type BrowserCommand = { tabId?: string } & (
  | { action: "tabs" }
  | { action: "new"; url?: string }
  | { action: "select" | "close"; targetTabId: string }
  | { action: "navigate"; url: string; reuse?: boolean }
  | { action: "back" | "forward" | "reload" }
  | { action: "observe"; scope?: "page" | "main" | "dialog"; nodeOffset?: number; textOffset?: number; frameId?: string; frameOffset?: number }
  | { action: "click"; target: Target; button?: "left" | "right" | "middle"; clickCount?: number }
  | { action: "fill" | "type"; target: Target; text: string }
  | { action: "press"; key: string; target?: Target }
  | { action: "wait"; target?: Target; state?: "attached" | "detached" | "visible" | "hidden"; loadState?: "load" | "domcontentloaded"; milliseconds?: number }
  | { action: "drag"; target: Target; destination: Target }
  | { action: "hover"; target: Target }
  | { action: "selectOption"; target: Target; values: string[] }
  | { action: "check"; target: Target; checked: boolean }
  | { action: "scroll"; x?: number; y: number; target?: Target; observationId?: string }
  | { action: "mouse"; screenshotId: string; x: number; y: number; operation: "click" | "move" | "down" | "up"; button?: "left" | "right" | "middle" }
  | { action: "screenshot"; fullPage?: boolean }
  | { action: "dialog"; accept: boolean; text?: string }
  | { action: "upload"; target: Target; files: string[] }
  | { action: "download"; downloadId: string }
  | { action: "console" | "network"; after?: number }
);
export interface EngineOptions {
  artifactRoot: string;
  headless?: boolean;
  proxy?: string;
  allowedOrigins: string[];
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  /** Legacy option name: maximum UTF-8 bytes of structured observation/log/tab results. */
  maxOutputChars?: number;
}
export interface BrowserReceipt {
  action: BrowserCommand["action"];
  outcome: "not-started" | "possibly-applied" | "applied";
  tabId?: string;
  result?: unknown;
  error?: { code: string; message: string };
  replaySafe: boolean;
}
