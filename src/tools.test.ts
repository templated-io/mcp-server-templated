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

// Captures every HTTP call a tool makes so tests can assert on the body/params
// the MCP server actually forwards to the REST API.
const captureCalls = async (
  name: string,
  args: Record<string, unknown>,
  response: unknown = { id: "tpl-new" },
) => {
  const calls: { url: string; method: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, text: async () => JSON.stringify(response) } as any;
  }) as typeof fetch;
  try {
    await handleToolCall(ctx("k"), name, args);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
};

const schemaOf = (name: string) =>
  (tools.find((t) => t.name === name)!.inputSchema as any).properties;

const pages = [
  { page: "Square", width: 1080, height: 1080, layers: { title: { type: "text", text: "A" } } },
  { page: "Story", width: 1080, height: 1920, layers: { title: { type: "text", text: "B" } } },
];

test("create_template declares pages and forwards it to POST /v1/template", async () => {
  assert.ok(schemaOf("create_template").pages, "inputSchema must declare pages");

  const calls = await captureCalls("create_template", { name: "t", width: 1080, height: 1080, pages });
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/template"));
  assert.ok(post, "must POST /v1/template");
  assert.deepEqual(post.body.pages, pages);
});

test("update_template declares pages and forwards pages, background and duration", async () => {
  const props = schemaOf("update_template");
  assert.ok(props.pages, "inputSchema must declare pages");

  const calls = await captureCalls("update_template", {
    template_id: "tpl-1", pages, background: "#fff", duration: 5000,
  });
  const put = calls.find((c) => c.method === "PUT" && c.url.includes("/v1/template/tpl-1"));
  assert.ok(put, "must PUT /v1/template/tpl-1");
  assert.deepEqual(put.body.pages, pages);
  assert.equal(put.body.background, "#fff");
  assert.equal(put.body.duration, 5000);
});

test("clone_template sends name as a query param to the clone endpoint", async () => {
  const calls = await captureCalls("clone_template", { template_id: "tpl-1", name: "My Clone" });
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/template/tpl-1/clone"));
  assert.ok(post, "must POST /v1/template/tpl-1/clone");
  assert.equal(new URL(post.url).searchParams.get("name"), "My Clone");
});

test("tool results are sanitized before reaching the model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => JSON.stringify({ email: "x@y.z", name: "Jane", plan: "Enterprise", apiUsage: 1, apiQuota: 10, usagePercentage: 10 }),
  })) as any;
  try {
    const result = await handleToolCall(ctx("k"), "get_account", {});
    assert.deepEqual(result, { apiUsage: 1, apiQuota: 10, usagePercentage: 10 });
  } finally {
    globalThis.fetch = original;
  }
});

test("merge_renders, delete_upload and delete_font call the endpoints the API exposes", async () => {
  const merge = await captureCalls("merge_renders", { render_ids: ["r1", "r2"] });
  assert.ok(merge[0].url.endsWith("/v1/render/merge"));
  assert.deepEqual(merge[0].body, { ids: ["r1", "r2"], host: true });

  const del = await captureCalls("delete_upload", { upload_id: "up-1" });
  assert.equal(del[0].method, "DELETE");
  assert.ok(del[0].url.endsWith("/v1/uploads?ids=up-1"));

  const font = await captureCalls("delete_font", { font_name: "My Font" });
  assert.equal(font[0].method, "DELETE");
  assert.ok(font[0].url.endsWith("/v1/fonts?fonts=My+Font"));
  assert.ok(schemaOf("delete_font").font_name, "delete_font takes the font name");
});

test("create_upload and upload_font fetch the URL and post it as multipart", async () => {
  const calls: { url: string; form?: FormData }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), form: init?.body instanceof FormData ? init.body : undefined });
    if (String(url).startsWith("https://93.184.216.34/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "font/woff2" } });
    }
    return { ok: true, text: async () => JSON.stringify({ id: "up-1", name: "logo.png", userId: "u" }) } as any;
  }) as typeof fetch;
  try {
    const upload = await handleToolCall({ apiKey: "k", folderId: null, externalId: "cust-9" }, "create_upload", {
      url: "https://93.184.216.34/logo.png", name: "brand",
    });
    assert.deepEqual(upload, { id: "up-1", name: "logo.png" });
    const post = calls.find((c) => c.url.endsWith("/v1/upload"));
    assert.ok(post?.form, "must POST multipart to /v1/upload");
    assert.equal((post!.form!.get("file") as File).name, "brand.png");
    assert.equal(post!.form!.get("externalId"), "cust-9");

    calls.length = 0;
    await handleToolCall(ctx("k"), "upload_font", { url: "https://93.184.216.34/download?id=7", name: "Inter" });
    const fontPost = calls.find((c) => c.url.endsWith("/v1/font"));
    assert.equal((fontPost!.form!.get("file") as File).name, "Inter.woff2");
  } finally {
    globalThis.fetch = original;
  }
});
