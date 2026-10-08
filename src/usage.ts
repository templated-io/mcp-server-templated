import { createHash } from "node:crypto";

// Per-call usage logging for the hosted server: which client (Claude, ChatGPT,
// Cursor...) called which tool, whether it worked and how long it took. Only
// metadata is logged: never credentials, tool arguments or results.

export interface ClientInfo {
  name: string;
  version?: string;
}

export interface ToolCallRecord {
  tool: string;
  outcome: "ok" | "error";
  status?: number;
  error_type?: "api" | "invalid_input" | "internal";
  client?: ClientInfo;
  user_agent?: string;
  duration_ms: number;
}

export type ToolCallLogger = (record: ToolCallRecord) => void;

const MAX_FIELD_LENGTH = 80;

// Client-supplied strings end up in log lines: drop control characters and cap the length.
export function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FIELD_LENGTH);
  return text || undefined;
}

export function clientInfoOf(value: unknown): ClientInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const info = value as { name?: unknown; version?: unknown };
  const name = clean(info.name);
  if (!name) return undefined;
  const version = clean(info.version);
  return version ? { name, version } : { name };
}

// The clientInfo of an initialize request, or undefined for any other message.
export function initializeClientInfo(message: unknown): ClientInfo | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { method, params } = message as { method?: unknown; params?: { clientInfo?: unknown } };
  return method === "initialize" ? clientInfoOf(params?.clientInfo) : undefined;
}

// Hash of the credential plus user agent. The OAuth token is the team's API key,
// so the same team connected from ChatGPT and Claude shares a token; the user
// agent keeps them apart. The credential itself is never stored or logged.
export function connectionKey(token: string, userAgent: string | undefined): string {
  return createHash("sha256").update(`${token}\n${userAgent ?? ""}`).digest("hex");
}

// Over stateless HTTP the initialize handshake and each tool call arrive as
// separate requests (with a new Server each), so tool calls look up the client by
// connection key. In memory and bounded: a miss (restart, another instance) only
// costs the client name on that log line.
export class ClientRegistry {
  private entries = new Map<string, { info: ClientInfo; seenAt: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  remember(key: string, info: ClientInfo): void {
    this.entries.delete(key);
    this.entries.set(key, { info, seenAt: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  lookup(key: string): ClientInfo | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.seenAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.info;
  }
}

// One JSON line per tool call on stdout.
export function logToolCall(record: ToolCallRecord): void {
  console.log(JSON.stringify({ event: "mcp_tool_call", ts: new Date().toISOString(), ...record }));
}
