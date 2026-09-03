import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { protectedResourceMetadata, AuthServerMetadataProxy } from "./wellKnown.js";

test("PRM advertises the canonical resource and the API as authorization server", () => {
  const prm = protectedResourceMetadata(loadConfig({} as NodeJS.ProcessEnv)) as any;
  assert.equal(prm.resource, "https://mcp.templated.io/mcp");
  assert.deepEqual(prm.authorization_servers, ["https://api.templated.io"]);
  assert.deepEqual(prm.bearer_methods_supported, ["header"]);
});

test("AS metadata proxy caches for the ttl and reports upstream failures as 502", async () => {
  let calls = 0;
  let t = 0;
  const fetchFn = (async () => {
    calls += 1;
    if (calls === 2) throw new Error("down");
    return { status: 200, text: async () => JSON.stringify({ issuer: "https://api.templated.io" }) } as any;
  }) as typeof fetch;
  const proxy = new AuthServerMetadataProxy({ apiBaseUrl: "https://api.x", fetchFn, ttlMs: 300_000, now: () => t });
  const a = await proxy.get();
  assert.equal(a.status, 200);
  assert.ok(a.body.includes("issuer"));
  t = 60_000;
  await proxy.get();               // still cached
  assert.equal(calls, 1);
  t = 400_000;
  const c = await proxy.get();     // expired; upstream now fails; keep serving last good copy
  assert.equal(c.status, 200);
  const empty = new AuthServerMetadataProxy({ apiBaseUrl: "https://api.x", fetchFn: (async () => { throw new Error("down"); }) as typeof fetch });
  const d = await empty.get();
  assert.equal(d.status, 502);
});
