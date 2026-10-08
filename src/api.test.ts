import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRequest, describeApiError, ApiError, FileResponse } from "./api.js";
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
  await assert.rejects(() => apiRequest(ctx(""), "GET", "/v1/renders"), /API key/);
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

const NOT_AVAILABLE =
  "This action is not available on the connected Templated account right now (usage limit reached or feature not enabled). Check the account at app.templated.io.";
const spring = (status: number, error: string) =>
  JSON.stringify({ timestamp: "2026-10-08T16:07:24Z", status, error, path: "/v1/template/x" });
const template = (id: string) => ({ kind: "template" as const, ids: [id], listTool: "list_templates" });

test("billing and plan errors from the API are replaced by a neutral message", () => {
  const quota = describeApiError(403, JSON.stringify({ error: "Insufficient credits. This render requires 2 credits, but you only have 1 remaining. Upgrade your plan to generate more renders." }));
  assert.equal(quota, NOT_AVAILABLE);
  assert.doesNotMatch(quota, /upgrade|credits|payment/i);
  assert.equal(describeApiError(403, JSON.stringify({ error: "Please upgrade your account to a paid plan to upload fonts." }), template("t1")), NOT_AVAILABLE);
  const payment = describeApiError(402, "Payment Required");
  assert.equal(payment, NOT_AVAILABLE, "a 402 must not leak the status code either");
});

test("404 on a known resource names the ID and the list tool to call", () => {
  assert.equal(
    describeApiError(404, spring(404, "Not Found"), template("tpl-9")),
    "Template tpl-9 not found in the connected Templated account (HTTP 404). Call list_templates to get valid template IDs.",
  );
  const renders = describeApiError(404, JSON.stringify({ error: "Render not found" }), { kind: "render", ids: ["r1", "r2"], listTool: "list_renders" });
  assert.match(renders, /Renders r1, r2/);
  assert.match(renders, /list_renders/);
  // delete_upload and delete_font answer a missing item with a 400
  const font = describeApiError(400, JSON.stringify({ error: "Cannot delete fonts: no fonts found with the specified name(s) for this user" }), { kind: "font", ids: ["Brand Sans"], listTool: "list_fonts" });
  assert.match(font, /Font Brand Sans not found/);
  assert.match(font, /list_fonts/);
});

test("401 and rejected keys ask to reconnect instead of retrying", () => {
  const unauthorized = describeApiError(401, JSON.stringify({ error: "Not authorized" }));
  assert.match(unauthorized, /HTTP 401/);
  assert.match(unauthorized, /reconnect/i);
  const badKey = describeApiError(404, JSON.stringify({ error: "API key not valid. Please check your Authorization header." }), template("t1"));
  assert.match(badKey, /reconnect/i);
  assert.doesNotMatch(badKey, /list_templates/);
});

test("403 without billing wording explains the access problem and how to recover", () => {
  const msg = describeApiError(403, JSON.stringify({ error: "You're not authorized to update this template" }), template("tpl-1"));
  assert.match(msg, /does not have access to template tpl-1 \(HTTP 403\)/);
  assert.match(msg, /list_templates/);
  assert.match(msg, /reconnect/i);
  const blocked = describeApiError(403, JSON.stringify({ error: "Your account is blocked. Please contact support." }));
  assert.match(blocked, /HTTP 403/);
  assert.match(blocked, /Your account is blocked/);
});

test("400 surfaces the API's validation message, or points at the schema when there is none", () => {
  const scale = describeApiError(400, JSON.stringify({ error: "Scale parameter must be between 0.1 and 4.0" }));
  assert.match(scale, /HTTP 400/);
  assert.match(scale, /Scale parameter must be between 0\.1 and 4\.0/);
  const bare = describeApiError(400, spring(400, "Bad Request"));
  assert.match(bare, /HTTP 400/);
  assert.match(bare, /input schema/);
  assert.doesNotMatch(bare, /Bad Request/);
  assert.match(describeApiError(415, spring(415, "Unsupported Media Type")), /Unsupported Media Type/);
});

test("429 asks to wait and retry, using Retry-After when present", () => {
  const msg = describeApiError(429, JSON.stringify({ error: "Another update is in progress for this template. Please wait and try again." }), undefined, "5");
  assert.match(msg, /HTTP 429/);
  assert.match(msg, /Another update is in progress/);
  assert.match(msg, /5 seconds/);
  assert.match(describeApiError(429, ""), /few seconds/);
});

test("5xx is reported as temporary, with an ID check when the call targets one", () => {
  // /v1/template/{id}/layers answers a missing template with a bare 500
  const layers = describeApiError(500, spring(500, "Internal Server Error"), template("tpl-404"));
  assert.match(layers, /template tpl-404 \(HTTP 500\)/);
  assert.match(layers, /list_templates/);
  assert.match(layers, /retry/i);
  assert.doesNotMatch(layers, /Internal Server Error/);
  const down = describeApiError(503, "upstream connect error");
  assert.match(down, /HTTP 503/);
  assert.match(down, /temporary/i);
  assert.match(down, /retry/i);
  assert.doesNotMatch(down, /upstream connect error/);
});

test("apiRequest throws an ApiError that carries the HTTP status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(spring(404, "Not Found"), { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(
      () => apiRequest(ctx("k"), "GET", "/v1/template/missing"),
      (error: unknown) => error instanceof ApiError && error.status === 404 && /HTTP 404/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("apiRequest returns a PDF body as a file instead of parsing it as JSON", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n%fake\n");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(pdf, {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": 'form-data; name="attachment"; filename="merged_renders.pdf"' },
  })) as typeof fetch;
  try {
    const result = await apiRequest(ctx("k"), "POST", "/v1/render/merge", { ids: ["r1"], host: false });
    assert.ok(result instanceof FileResponse);
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.filename, "merged_renders.pdf");
    assert.deepEqual([...result.bytes], [...pdf]);
  } finally {
    globalThis.fetch = original;
  }
});
