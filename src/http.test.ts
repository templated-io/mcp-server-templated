import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { AddressInfo } from "net";
import { createHttpServer } from "./http.js";
import { loadConfig } from "./config.js";
import { TokenValidator } from "./auth.js";

let server: http.Server;
let base: string;

before(async () => {
  server = createHttpServer();
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
