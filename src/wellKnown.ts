import { McpConfig } from "./config.js";

export function protectedResourceMetadata(cfg: McpConfig): Record<string, unknown> {
  return {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.apiBaseUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://templated.io/docs/integrations/mcp/",
  };
}

export class AuthServerMetadataProxy {
  private apiBaseUrl: string;
  private fetchFn: typeof fetch;
  private ttlMs: number;
  private now: () => number;
  private cached: { body: string; fetchedAt: number } | null = null;

  constructor(opts: { apiBaseUrl: string; fetchFn?: typeof fetch; ttlMs?: number; now?: () => number }) {
    this.apiBaseUrl = opts.apiBaseUrl;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.now = opts.now ?? Date.now;
  }

  async get(): Promise<{ status: number; body: string }> {
    const now = this.now();
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) {
      return { status: 200, body: this.cached.body };
    }
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/.well-known/oauth-authorization-server`);
      if (res.status === 200) {
        const body = await res.text();
        this.cached = { body, fetchedAt: now };
        return { status: 200, body };
      }
    } catch {
      // fall through
    }
    if (this.cached) return { status: 200, body: this.cached.body };
    return { status: 502, body: JSON.stringify({ error: "authorization server metadata unavailable" }) };
  }
}
