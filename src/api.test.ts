import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRequest } from "./api.js";
import type { RequestContext } from "./context.js";

const ctx = (apiKey: string): RequestContext => ({ apiKey, folderId: null, externalId: null });

function fakeFetch(capture: { auth: string[]; urls: string[] }) {
  return (async (url: any, init: any) => {
    capture.urls.push(String(url));
    capture.auth.push(init.headers["Authorization"]);
    return { ok: true, text: async () => JSON.stringify({ ok: true }) } as any;
  }) as typeof fetch;
}

test("apiRequest sends the context key as Bearer and builds query params", async () => {
  const capture = { auth: [] as string[], urls: [] as string[] };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(capture);
  try {
    await apiRequest(ctx("key-A"), "GET", "/v1/renders", undefined, { page: "2" });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(capture.auth[0], "Bearer key-A");
  assert.ok(capture.urls[0].endsWith("/v1/renders?page=2"));
});

test("apiRequest rejects when the context has no key", async () => {
  await assert.rejects(() => apiRequest(ctx(""), "GET", "/v1/renders"), /API key required/);
});

test("concurrent apiRequest calls never swap keys", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    seen.push(init.headers["Authorization"]);
    await gate; // hold both requests in flight simultaneously
    return { ok: true, text: async () => "{}" } as any;
  }) as typeof fetch;
  try {
    const a = apiRequest(ctx("key-A"), "GET", "/v1/account");
    const b = apiRequest(ctx("key-B"), "GET", "/v1/account");
    release();
    await Promise.all([a, b]);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen.sort(), ["Bearer key-A", "Bearer key-B"]);
});
