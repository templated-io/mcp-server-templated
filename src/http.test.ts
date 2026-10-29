import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { AddressInfo } from "net";
import { createHttpServer } from "./http.js";
import { loadConfig } from "./config.js";
import { TokenValidator } from "./auth.js";
import type { InitializeRecord, ToolCallRecord } from "./usage.js";

let server: http.Server;
let base: string;

before(async () => {
  server = createHttpServer({ logToolCall: () => {}, logInitialize: () => {} });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function toolCallBody(id: number) {
  return JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "get_account", arguments: {} },
  });
}

async function postMcp(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...headers },
    body,
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

// The MCP response is SSE ("data: {...}" lines); extract the JSON-RPC payloads.
function sseData(text: string): any[] {
  return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
}

// helper used by the new tests
function serverWithValidator(validated: Record<string, "valid" | "invalid" | "unavailable">) {
  const validator = new TokenValidator({
    apiBaseUrl: "https://api.x",
    fetchFn: (async (_url: any, init: any) => {
      const token = String(init.headers["Authorization"]).replace("Bearer ", "");
      const result = validated[token] ?? "invalid";
      if (result === "unavailable") throw new Error("down");
      return { status: result === "valid" ? 200 : 401 } as any;
    }) as typeof fetch,
  });
  return createHttpServer({ config: loadConfig({} as NodeJS.ProcessEnv), validator });
}

test("health endpoint works", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test("concurrent tool calls with different keys stay isolated end to end", async (t) => {
  const original = globalThis.fetch;
  const upstream = (globalThis as any).fetch;
  // Fake ONLY calls to api.templated.io; pass through everything else (our own test server).
  // Both the auth gate's /v1/account validation check and the get_account tool call hit
  // this same endpoint, so a single 200 response satisfies both.
  (globalThis as any).fetch = async (url: any, init?: any) => {
    if (String(url).includes("api.templated.io")) {
      const auth = init.headers["Authorization"];
      // apiUsage survives the response sanitizer, so the key can be read back from the tool result.
      return { ok: true, status: 200, text: async () => JSON.stringify({ apiUsage: auth }) } as any;
    }
    return upstream(url, init);
  };
  t.after(() => { (globalThis as any).fetch = original; });

  const [a, b] = await Promise.all([
    postMcp("/mcp?apiKey=key-A", toolCallBody(1)),
    postMcp("/mcp", toolCallBody(2), { Authorization: "Bearer key-B" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const aPayload = JSON.stringify(sseData(a.text));
  const bPayload = JSON.stringify(sseData(b.text));
  assert.ok(aPayload.includes("key-A") && !aPayload.includes("key-B"), `A saw: ${aPayload}`);
  assert.ok(bPayload.includes("key-B") && !bPayload.includes("key-A"), `B saw: ${bPayload}`);
});

test("no credential -> 401 with WWW-Authenticate pointing at the PRM", async () => {
  const s = serverWithValidator({});
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    assert.equal(res.status, 401);
    const header = res.headers.get("www-authenticate") ?? "";
    assert.ok(header.includes('resource_metadata="https://mcp.templated.io/.well-known/oauth-protected-resource/mcp"'), header);
  } finally { s.close(); }
});

test("invalid bearer -> 401; valid bearer passes; unavailable upstream -> 503 without challenge", async () => {
  const s = serverWithValidator({ good: "valid", down: "unavailable" });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const post = (auth: string) => fetch(`${b}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", Authorization: auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  try {
    assert.equal((await post("Bearer nope")).status, 401);
    assert.equal((await post("Bearer good")).status, 200);
    const down = await post("Bearer down");
    assert.equal(down.status, 503);
    assert.equal(down.headers.get("www-authenticate"), null);
  } finally { s.close(); }
});

test("PRM endpoints are served on both paths", async () => {
  const s = serverWithValidator({});
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${b}${p}`);
      assert.equal(res.status, 200);
      const json: any = await res.json();
      assert.equal(json.resource, "https://mcp.templated.io/mcp");
    }
  } finally { s.close(); }
});

test("no credential -> 401 (no longer reaches the MCP layer)", async () => {
  const res = await postMcp("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  assert.equal(res.status, 401);
});

test("tool calls are logged with the client name from an earlier initialize request", async (t) => {
  const records: ToolCallRecord[] = [];
  const inits: InitializeRecord[] = [];
  const lines: string[] = [];
  const teamId = "2fd904ee-9ca8-4c57-9536-e252dc05caa1";
  const validator = new TokenValidator({
    apiBaseUrl: "https://api.x",
    fetchFn: (async () => new Response(JSON.stringify({ teamId }), { status: 200 })) as typeof fetch,
  });
  const s = createHttpServer({
    config: loadConfig({} as NodeJS.ProcessEnv),
    validator,
    logToolCall: (record) => { records.push(record); lines.push(JSON.stringify(record)); },
    logInitialize: (record) => { inits.push(record); lines.push(JSON.stringify(record)); },
  });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) =>
    String(url).includes("api.templated.io")
      ? new Response(JSON.stringify({ apiUsage: 3, apiQuota: 50 }))
      : original(url, init);
  t.after(() => { (globalThis as any).fetch = original; s.close(); });

  const headers = {
    "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer tok-openai", "User-Agent": "openai-mcp/1.0.0",
  };
  const init = await fetch(`${b}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } } }),
  });
  assert.equal(init.status, 200);
  await init.text();

  const call = await fetch(`${b}/mcp`, { method: "POST", headers, body: toolCallBody(2) });
  assert.equal(call.status, 200);
  await call.text();

  // Same key from another client (different user agent) is not mixed up with ChatGPT
  const other = await fetch(`${b}/mcp`, { method: "POST", headers: { ...headers, "User-Agent": "Claude-User" }, body: toolCallBody(3) });
  await other.text();

  assert.deepEqual(inits, [{ client: { name: "openai-mcp", version: "1.0.0" }, team_id: teamId }]);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].client, { name: "openai-mcp", version: "1.0.0" });
  assert.equal(records[0].tool, "get_account");
  assert.equal(records[0].outcome, "ok");
  assert.equal(records[0].team_id, teamId);
  assert.equal(records[1].client, undefined);
  assert.equal(records[1].user_agent, "Claude-User");
  assert.equal(records[1].team_id, teamId);
  assert.ok(lines.every((l) => !l.includes("tok-openai")), "the bearer token is never logged");
});

test("over HTTP the render card gets the public origin as ui.domain for ChatGPT only", async (t) => {
  const validator = new TokenValidator({
    apiBaseUrl: "https://api.x",
    fetchFn: (async () => ({ status: 200 })) as unknown as typeof fetch,
  });
  const s = createHttpServer({
    config: loadConfig({ MCP_PUBLIC_URL: "https://mcp.example.test" } as NodeJS.ProcessEnv),
    validator,
    logToolCall: () => {},
    logInitialize: () => {},
  });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  t.after(() => s.close());

  const read = async (userAgent: string) => {
    const res = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer tok", "User-Agent": userAgent,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://templated/render-card-v1.html" } }),
    });
    assert.equal(res.status, 200);
    const [message] = sseData(await res.text());
    return message.result.contents[0]._meta;
  };

  assert.equal((await read("openai-mcp/1.0.0")).ui.domain, "https://mcp.example.test");
  const claude = await read("Claude-User");
  assert.equal(claude.ui.domain, undefined);
  assert.equal(claude["openai/widgetDomain"], "https://mcp.example.test");
});
