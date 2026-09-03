import { createHash } from "crypto";
import { McpConfig, resourceMetadataUrl } from "./config.js";

export function extractToken(authorizationHeader: string | undefined, url: URL): string | null {
  if (authorizationHeader?.startsWith("Bearer ")) {
    const token = authorizationHeader.substring(7).trim();
    if (token) return token;
  }
  return url.searchParams.get("apiKey") || null;
}

export function wwwAuthenticate(cfg: McpConfig, invalid = false): string {
  const rm = `resource_metadata="${resourceMetadataUrl(cfg)}"`;
  return invalid ? `Bearer error="invalid_token", ${rm}` : `Bearer ${rm}`;
}

export type ValidationResult = "valid" | "invalid" | "unavailable";

interface CacheEntry { result: "valid" | "invalid"; checkedAt: number }

export class TokenValidator {
  private cache = new Map<string, CacheEntry>();
  private apiBaseUrl: string;
  private fetchFn: typeof fetch;
  private now: () => number;
  private validTtlMs: number;
  private invalidTtlMs: number;
  private staleMaxMs: number;
  private maxEntries: number;
  private timeoutMs: number;

  constructor(opts: {
    apiBaseUrl: string; fetchFn?: typeof fetch; now?: () => number;
    validTtlMs?: number; invalidTtlMs?: number; staleMaxMs?: number; maxEntries?: number; timeoutMs?: number;
  }) {
    this.apiBaseUrl = opts.apiBaseUrl;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.validTtlMs = opts.validTtlMs ?? 60_000;
    this.invalidTtlMs = opts.invalidTtlMs ?? 10_000;
    this.staleMaxMs = opts.staleMaxMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  async validate(token: string): Promise<ValidationResult> {
    const key = createHash("sha256").update(token).digest("hex");
    const entry = this.cache.get(key);
    const now = this.now();
    if (entry) {
      const ttl = entry.result === "valid" ? this.validTtlMs : this.invalidTtlMs;
      if (now - entry.checkedAt < ttl) return entry.result;
    }
    let status: number | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`${this.apiBaseUrl}/v1/account`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        status = res.status;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      status = null;
    }
    if (status === 200) return this.store(key, "valid", now);
    if (status === 401 || status === 403 || status === 404) return this.store(key, "invalid", now);
    // Upstream unavailable: reuse a recent stale entry rather than logging users out.
    if (entry && now - entry.checkedAt <= this.staleMaxMs) return entry.result;
    return "unavailable";
  }

  private store(key: string, result: "valid" | "invalid", now: number): ValidationResult {
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, { result, checkedAt: now });
    return result;
  }
}
