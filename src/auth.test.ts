import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resourceMetadataUrl } from "./config.js";
import { extractToken, wwwAuthenticate, TokenValidator } from "./auth.js";

test("loadConfig defaults to production and strips trailing slashes", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.apiBaseUrl, "https://api.templated.io");
  assert.equal(cfg.publicUrl, "https://mcp.templated.io");
  const dev = loadConfig({ TEMPLATED_API_URL: "http://localhost:8090/", MCP_PUBLIC_URL: "http://localhost:3456/" } as NodeJS.ProcessEnv);
  assert.equal(dev.apiBaseUrl, "http://localhost:8090");
  assert.equal(resourceMetadataUrl(dev), "http://localhost:3456/.well-known/oauth-protected-resource/mcp");
});

test("extractToken prefers the Bearer header over the query param", () => {
  const url = new URL("https://m.x/mcp?apiKey=from-query");
  assert.equal(extractToken("Bearer from-header", url), "from-header");
  assert.equal(extractToken(undefined, url), "from-query");
  assert.equal(extractToken(undefined, new URL("https://m.x/mcp")), null);
});

test("wwwAuthenticate shapes", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(
    wwwAuthenticate(cfg),
    'Bearer resource_metadata="https://mcp.templated.io/.well-known/oauth-protected-resource/mcp"'
  );
  assert.ok(wwwAuthenticate(cfg, true).includes('error="invalid_token"'));
});

function fetchReturning(status: number) {
  let calls = 0;
  const fn = (async () => { calls += 1; return { status } as any; }) as typeof fetch;
  return { fn, calls: () => calls };
}

test("validator: 200 is valid and cached", async () => {
  const f = fetchReturning(200);
  const v = new TokenValidator({ apiBaseUrl: "https://api.x", fetchFn: f.fn });
  assert.equal(await v.validate("tok"), "valid");
  assert.equal(await v.validate("tok"), "valid");
  assert.equal(f.calls(), 1);
});

test("validator: 401/403/404 are invalid", async () => {
  for (const status of [401, 403, 404]) {
    const v = new TokenValidator({ apiBaseUrl: "https://api.x", fetchFn: fetchReturning(status).fn });
    assert.equal(await v.validate("tok"), "invalid");
  }
});

test("validator: 5xx without cache is unavailable, with fresh-enough stale uses it", async () => {
  let mode: "ok" | "boom" = "ok";
  let t = 0;
  const fetchFn = (async () => {
    if (mode === "boom") throw new Error("down");
    return { status: 200 } as any;
  }) as typeof fetch;
  const v = new TokenValidator({ apiBaseUrl: "https://api.x", fetchFn, now: () => t, validTtlMs: 60_000, staleMaxMs: 300_000 });
  assert.equal(await v.validate("tok"), "valid");   // cached at t=0
  t = 120_000; mode = "boom";                        // cache expired, upstream down, stale age 120s < 300s
  assert.equal(await v.validate("tok"), "valid");
  t = 500_000;                                       // stale too old now
  assert.equal(await v.validate("tok"), "unavailable");
  const v2 = new TokenValidator({ apiBaseUrl: "https://api.x", fetchFn: (async () => { throw new Error("down"); }) as typeof fetch });
  assert.equal(await v2.validate("other"), "unavailable");
});
