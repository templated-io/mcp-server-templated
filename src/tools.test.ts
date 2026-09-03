import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, handleToolCall } from "./tools.js";
import type { RequestContext } from "./context.js";

const ctx = (apiKey: string, folderId: string | null = null): RequestContext =>
  ({ apiKey, folderId, externalId: null });

test("tools list is intact (25 tools, create_render present)", () => {
  assert.equal(tools.length, 25);
  assert.ok(tools.some((t) => t.name === "create_render"));
});

test("concurrent tool calls from different tenants keep their own keys", async () => {
  const byKey: Record<string, string[]> = {};
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const key = init.headers["Authorization"];
    (byKey[key] ??= []).push(String(url));
    await gate;
    return { ok: true, text: async () => JSON.stringify({ email: "x@y.z" }) } as any;
  }) as typeof fetch;
  try {
    const a = handleToolCall(ctx("key-A"), "get_account", {});
    const b = handleToolCall(ctx("key-B"), "get_account", {});
    release();
    await Promise.all([a, b]);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(byKey["Bearer key-A"].length, 1);
  assert.equal(byKey["Bearer key-B"].length, 1);
});

test("folder scoping still applies through the context", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ renders: [] }) } as any;
  }) as typeof fetch;
  try {
    await handleToolCall(ctx("k", "fold-1"), "list_renders", {});
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls[0].includes("/v1/folder/fold-1/renders"));
});
