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

// Plan-limit bodies as the API words them.
const API_TEMPLATE_LIMIT = JSON.stringify({ error: "You've reached your template limit. Upgrade your plan to create more templates." });
const API_QUOTA_EXCEEDED = JSON.stringify({ error: "API quota exceeded. Upgrade your plan to generate more renders." });
const API_INSUFFICIENT_CREDITS = JSON.stringify({ error: "Insufficient credits. This render requires 2 credits, but you only have 1 remaining. Upgrade your plan to generate more renders." });
const API_PAID_FONTS = JSON.stringify({ error: "Please upgrade your account to a paid plan to upload fonts." });

const UPGRADE_URL = "https://app.templated.io/upgrade";
const TEMPLATE_LIMIT_REACHED =
  "The connected Templated account has reached the template limit of its current plan. The options are: upgrade the plan at https://app.templated.io/upgrade, free a slot by deleting a template that is no longer needed (delete_template), or change an existing template with update_template instead of creating a new one.";
const CREDITS_USED_UP =
  "The connected Templated account has used all the render credits of its current plan. The plan can be upgraded at https://app.templated.io/upgrade. Retrying will not work until the account has render credits again.";
const NOT_ENOUGH_CREDITS =
  "The connected Templated account does not have enough render credits left on its current plan for this render (get_account shows the usage). The plan can be upgraded at https://app.templated.io/upgrade. Retrying the same render will not work until the account has more render credits.";
const PLAN_RESTRICTION =
  "This action is not available on the current plan of the connected Templated account: a limit of the plan was reached, or the plan does not include this feature. The plan can be upgraded at https://app.templated.io/upgrade.";

// Client names and user agents as the hosted server's logs show them. Only Claude clients
// are told about the plan; a client that is not known counts as not Claude.
const CLAUDE_CLIENTS = ["Anthropic/ClaudeAI", "Anthropic/Toolbox", "claude-code", "claude-ai (via mcp-remote 0.16.5)", "Claude-User", "claude-code/2.1.309 (cli)"];
const NEUTRAL_CLIENTS = ["openai-mcp", "openai-mcp (Codex)", "openai-mcp/1.0.0", "codex-mcp-client", "Cursor", "cursor-vscode", "mcp", undefined];

test("clients other than Claude keep the neutral message for billing and plan errors", () => {
  for (const client of NEUTRAL_CLIENTS) {
    for (const body of [API_TEMPLATE_LIMIT, API_QUOTA_EXCEEDED, API_INSUFFICIENT_CREDITS, API_PAID_FONTS]) {
      const message = describeApiError(403, body, undefined, undefined, client);
      assert.equal(message, NOT_AVAILABLE);
      assert.doesNotMatch(message, /upgrade|credits|payment/i);
    }
    assert.equal(describeApiError(403, API_PAID_FONTS, template("t1"), undefined, client), NOT_AVAILABLE);
    const payment = describeApiError(402, "Payment Required", undefined, undefined, client);
    assert.equal(payment, NOT_AVAILABLE, "a 402 must not leak the status code either");
  }
});

test("Claude clients are told the template limit was reached, with the upgrade link and two ways around it", () => {
  for (const client of CLAUDE_CLIENTS) {
    const message = describeApiError(403, API_TEMPLATE_LIMIT, undefined, undefined, client);
    assert.equal(message, TEMPLATE_LIMIT_REACHED);
    assert.match(message, /template limit of its current plan/);
    assert.ok(message.includes(UPGRADE_URL));
    assert.match(message, /delete_template/);
    assert.match(message, /update_template/);
  }
});

test("Claude clients are told the render credits ran out, with the upgrade link and that retrying will not work", () => {
  for (const client of CLAUDE_CLIENTS) {
    // create_render names its template, so these errors also carry a target
    const usedUp = describeApiError(403, API_QUOTA_EXCEEDED, template("tpl-1"), undefined, client);
    assert.equal(usedUp, CREDITS_USED_UP);
    assert.match(usedUp, /used all the render credits of its current plan/);
    assert.ok(usedUp.includes(UPGRADE_URL));
    assert.match(usedUp, /Retrying will not work/);

    // Some credits are left, but fewer than this render costs
    const short = describeApiError(403, API_INSUFFICIENT_CREDITS, template("tpl-1"), undefined, client);
    assert.equal(short, NOT_ENOUGH_CREDITS);
    assert.ok(short.includes(UPGRADE_URL));
    assert.match(short, /Retrying the same render will not work/);
    assert.doesNotMatch(short, /\d/, "the credit counts in the API body are not passed on");
  }
});

test("other plan restrictions get one generic message with the upgrade link, for Claude clients", () => {
  for (const client of CLAUDE_CLIENTS) {
    assert.equal(describeApiError(403, API_PAID_FONTS, undefined, undefined, client), PLAN_RESTRICTION);
    assert.equal(describeApiError(402, "Payment Required", undefined, undefined, client), PLAN_RESTRICTION, "a 402 must not leak the status code either");
  }
  assert.ok(PLAN_RESTRICTION.includes(UPGRADE_URL));
});

test("plan-limit messages are fixed strings: nothing else in the API body reaches the model", () => {
  const leaky = (reason: string) => JSON.stringify({ error: `${reason} Owner jane@example.com is on the Gold plan at $99/month. Upgrade your plan.` });
  assert.equal(describeApiError(403, leaky("You've reached your template limit (3 of 3)."), undefined, undefined, "Anthropic/ClaudeAI"), TEMPLATE_LIMIT_REACHED);
  assert.equal(describeApiError(403, leaky("API quota exceeded."), undefined, undefined, "Anthropic/ClaudeAI"), CREDITS_USED_UP);
  assert.equal(describeApiError(403, leaky("Insufficient credits."), undefined, undefined, "Anthropic/ClaudeAI"), NOT_ENOUGH_CREDITS);
  assert.equal(describeApiError(403, leaky("This feature is not included."), undefined, undefined, "Anthropic/ClaudeAI"), PLAN_RESTRICTION);
});

test("past-due and suspended accounts keep the neutral message for every client: an upgrade does not lift them", () => {
  const pastDue = JSON.stringify({ error: "Your payment method on file is past due. Please update your payment method to continue or contact support at support@templated.io." });
  const suspended = JSON.stringify({ error: "Your API access has been suspended. Please contact support@templated.io." });
  for (const client of [...NEUTRAL_CLIENTS, ...CLAUDE_CLIENTS]) {
    assert.equal(describeApiError(403, pastDue, undefined, undefined, client), NOT_AVAILABLE);
    assert.equal(describeApiError(403, suspended, template("t1"), undefined, client), NOT_AVAILABLE);
  }
});

test("a billing word echoed by an error that is not a 402 or 403 never becomes an upgrade message", () => {
  // A template name sent as the ID comes back in the 404; so does an image URL in a 400.
  const echoedName = JSON.stringify({ error: "Template not found: Payment plan" });
  const echoedUrl = spring(400, "Bad Request").replace("}", ',"message":"Could not fetch https://example.com/upgrade-credits.png"}');
  for (const client of [...NEUTRAL_CLIENTS, ...CLAUDE_CLIENTS]) {
    assert.equal(describeApiError(404, echoedName, template("Payment plan"), undefined, client), NOT_AVAILABLE);
    assert.equal(describeApiError(400, echoedUrl, undefined, undefined, client), NOT_AVAILABLE);
  }
});

test("errors that are not about billing read the same for every client", () => {
  for (const client of [...NEUTRAL_CLIENTS, ...CLAUDE_CLIENTS]) {
    assert.equal(
      describeApiError(403, JSON.stringify({ error: "You're not authorized to update this template" }), template("tpl-1"), undefined, client),
      "The connected Templated account does not have access to template tpl-1 (HTTP 403). It may belong to another Templated account: call list_templates to see the templates this connection can use, or reconnect Templated with the account that owns it.",
    );
    assert.equal(
      describeApiError(403, JSON.stringify({ error: "Your account is blocked. Please contact support." }), undefined, undefined, client),
      "Templated refused this request (HTTP 403): Your account is blocked. Please contact support. Reconnect Templated with an account that has access, then retry.",
    );
    assert.equal(
      describeApiError(404, spring(404, "Not Found"), template("tpl-9"), undefined, client),
      "Template tpl-9 not found in the connected Templated account (HTTP 404). Call list_templates to get valid template IDs.",
    );
    assert.equal(
      describeApiError(404, spring(404, "Not Found"), undefined, undefined, client),
      "Not found (HTTP 404). Check the IDs used in this call.",
    );
  }
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

test("apiRequest words a plan-limit error for the client named in the context", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(API_TEMPLATE_LIMIT, { status: 403 })) as typeof fetch;
  const errorFor = async (clientName?: string): Promise<ApiError> => {
    try {
      await apiRequest({ ...ctx("k"), clientName }, "POST", "/v1/template", { name: "Post" });
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return error;
    }
    assert.fail("expected the request to be refused");
  };
  try {
    const openai = await errorFor("openai-mcp");
    const claude = await errorFor("Anthropic/ClaudeAI");
    assert.equal(openai.message, NOT_AVAILABLE);
    assert.equal(claude.message, TEMPLATE_LIMIT_REACHED);
    assert.equal((await errorFor("Cursor")).message, NOT_AVAILABLE);
    assert.equal((await errorFor(undefined)).message, NOT_AVAILABLE, "a client that is not known is not told about the plan");
    // handleToolCall re-describes the error with the item it was about: the client still decides the wording
    assert.equal(openai.about(template("tpl-1")).message, NOT_AVAILABLE);
    assert.equal(claude.about(template("tpl-1")).message, TEMPLATE_LIMIT_REACHED);
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
