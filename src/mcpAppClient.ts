// View-side MCP Apps client for the render card (spec io.modelcontextprotocol/ui,
// version 2026-01-26), bundled into the card's HTML.
//
// It sends exactly what App from @modelcontextprotocol/ext-apps 1.7.5 sends (same
// ui/initialize params, postMessage to window.parent with "*", messages accepted
// only from window.parent, the same size-changed measurement) without that
// package's zod-based message validation, which takes the card from about 21 KB
// to 261 KB. mcpAppClient.test.ts runs it against the SDK's own host, AppBridge.
// The method names match App, so switching to it is a drop-in change.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const PROTOCOL_VERSION = "2026-01-26";
const REQUEST_TIMEOUT_MS = 60_000;

type RequestId = string | number;
type Json = Record<string, unknown>;

// The parts of the spec's McpUi* types the card uses (the ext-apps type
// declarations do not resolve under NodeNext).
export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  toolInfo?: { id?: RequestId; tool: { name: string } };
  [key: string]: unknown;
}

export interface HostCapabilities {
  openLinks?: object;
  serverTools?: { listChanged?: boolean };
  [key: string]: unknown;
}

export interface AppCapabilities {
  availableDisplayModes?: DisplayMode[];
}

interface InitializeResult {
  protocolVersion: string;
  hostCapabilities?: HostCapabilities;
  hostContext?: HostContext;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// How messages reach the host; in the browser, postMessage to the parent frame.
export interface Channel {
  send(message: JsonRpcMessage): void;
  listen(handler: (message: unknown) => void): () => void;
}

export function parentWindowChannel(): Channel {
  const host = window.parent;
  return {
    send: (message) => host.postMessage(message, "*"),
    listen: (handler) => {
      const listener = (event: MessageEvent) => {
        if (event.source === host) handler(event.data);
      };
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class McpAppClient {
  ontoolinput?: (params: { arguments?: Json }) => void;
  ontoolresult?: (result: CallToolResult) => void;
  ontoolcancelled?: (params: { reason?: string }) => void;
  onhostcontextchanged?: (changed: HostContext) => void;
  onteardown?: () => void | Promise<void>;

  private channel?: Channel;
  private stopListening?: () => void;
  private nextId = 1;
  private pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private hostCapabilities?: HostCapabilities;
  private hostContext: HostContext = {};

  constructor(
    private readonly appInfo: { name: string; version: string },
    private readonly capabilities: AppCapabilities = {},
  ) {}

  // Handlers must be set before connect: the host sends tool input and result
  // right after the handshake.
  async connect(channel: Channel = parentWindowChannel()): Promise<void> {
    this.channel = channel;
    this.stopListening = channel.listen((message) => this.receive(message));
    const result = await this.request<InitializeResult>("ui/initialize", {
      appCapabilities: this.capabilities,
      appInfo: this.appInfo,
      protocolVersion: PROTOCOL_VERSION,
    });
    this.hostCapabilities = result.hostCapabilities;
    this.hostContext = result.hostContext ?? {};
    this.notify("ui/notifications/initialized");
  }

  close(): void {
    this.stopListening?.();
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }

  getHostCapabilities(): HostCapabilities | undefined {
    return this.hostCapabilities;
  }

  getHostContext(): HostContext {
    return this.hostContext;
  }

  callServerTool(params: { name: string; arguments?: Json }): Promise<CallToolResult> {
    return this.request<CallToolResult>("tools/call", params);
  }

  openLink(params: { url: string }): Promise<{ isError?: boolean }> {
    return this.request("ui/open-link", params);
  }

  requestDisplayMode(params: { mode: "inline" | "fullscreen" | "pip" }): Promise<{ mode: string }> {
    return this.request("ui/request-display-mode", params);
  }

  sendSizeChanged(params: { width: number; height: number }): void {
    this.notify("ui/notifications/size-changed", params);
  }

  // Reports the document size whenever it changes, like App's autoResize: the
  // height is measured with height: max-content so it can shrink as well as grow.
  autoResize(): () => void {
    let scheduled = false;
    let lastWidth = 0;
    let lastHeight = 0;
    const measure = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const html = document.documentElement;
        const previous = html.style.height;
        html.style.height = "max-content";
        const height = Math.ceil(html.getBoundingClientRect().height);
        html.style.height = previous;
        const width = Math.ceil(window.innerWidth);
        if (width !== lastWidth || height !== lastHeight) {
          lastWidth = width;
          lastHeight = height;
          this.sendSizeChanged({ width, height });
        }
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    return () => observer.disconnect();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.channel) throw new Error("Not connected");
    this.channel.send(message);
  }

  private receive(message: unknown): void {
    if (!isObject(message) || message.jsonrpc !== "2.0") return;
    const id = message.id as RequestId | undefined;
    if (typeof message.method === "string") {
      if (id === undefined) this.onNotification(message.method, message.params);
      else void this.onRequest(id, message.method);
      return;
    }
    if (id === undefined) return;
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (isObject(message.error)) call.reject(new Error(String(message.error.message ?? "Request failed")));
    else call.resolve(message.result);
  }

  private onNotification(method: string, params: unknown): void {
    const value = isObject(params) ? params : {};
    switch (method) {
      case "ui/notifications/tool-input":
        this.ontoolinput?.(value as { arguments?: Json });
        break;
      case "ui/notifications/tool-result":
        this.ontoolresult?.(value as unknown as CallToolResult);
        break;
      case "ui/notifications/tool-cancelled":
        this.ontoolcancelled?.(value as { reason?: string });
        break;
      case "ui/notifications/host-context-changed":
        this.hostContext = { ...this.hostContext, ...(value as HostContext) };
        this.onhostcontextchanged?.(value as HostContext);
        break;
      default:
        // tool-input-partial and anything newer: not needed by the card
        break;
    }
  }

  private async onRequest(id: RequestId, method: string): Promise<void> {
    if (method === "ping") {
      this.send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "ui/resource-teardown") {
      try {
        await this.onteardown?.();
      } finally {
        this.send({ jsonrpc: "2.0", id, result: {} });
      }
      return;
    }
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
