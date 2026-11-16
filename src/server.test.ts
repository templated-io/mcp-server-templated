import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, ServerOptions } from "./server.js";
import { SERVER_INSTRUCTIONS } from "./prompts.js";
import { VERSION } from "./version.js";
import type { ToolCallRecord } from "./usage.js";
import type { RequestContext } from "./context.js";

const ctx: RequestContext = { apiKey: "secret-key-123", folderId: null, externalId: null };

async function connect(options: ServerOptions = {}, clientName = "test") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx, options);
  const client = new Client({ name: clientName, version: "9.9.9" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

const withFetch = async <T>(handler: (url: string) => Response, fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => handler(String(url))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test("tool results are compact JSON without empty fields", async () => {
  const { client, close } = await connect();
  try {
    const result = await withFetch(
      () => new Response(JSON.stringify([{ layer: "title", type: "text", text: "Hi", description: "", color_2: null }])),
      () => client.callTool({ name: "get_template_layers", arguments: { template_id: "t1" } }),
    );
    const [content] = result.content as { type: string; text: string }[];
    assert.equal(content.text, '[{"layer":"title","type":"text","text":"Hi"}]');
  } finally {
    await close();
  }
});

test("merge_renders host false reaches the client as an embedded PDF resource", async () => {
  const { client, close } = await connect();
  try {
    const result = await withFetch(
      () => new Response(new TextEncoder().encode("%PDF-1.7\n"), { headers: { "content-type": "application/pdf" } }),
      () => client.callTool({ name: "merge_renders", arguments: { render_ids: ["r1"], host: false } }),
    );
    assert.notEqual(result.isError, true);
    const resource = (result.content as any[]).find((c) => c.type === "resource");
    assert.equal(resource.resource.mimeType, "application/pdf");
    assert.equal(Buffer.from(resource.resource.blob, "base64").toString(), "%PDF-1.7\n");
  } finally {
    await close();
  }
});

test("each tool call is logged with the client from the handshake, outcome and duration", async () => {
  const records: ToolCallRecord[] = [];
  const { client, close } = await connect({ onToolCall: (r) => records.push(r) }, "claude-ai");
  try {
    await withFetch(() => new Response(JSON.stringify({ apiUsage: 1, apiQuota: 10 })), () =>
      client.callTool({ name: "get_account", arguments: {} }));
    const failed = await withFetch(() => new Response(JSON.stringify({ status: 404, error: "Not Found" }), { status: 404 }), () =>
      client.callTool({ name: "get_template", arguments: { template_id: "Private user text" } }));
    assert.equal(failed.isError, true);
    await client.callTool({ name: "get_template", arguments: {} });
    await client.callTool({ name: "no_such_tool", arguments: {} });
  } finally {
    await close();
  }

  assert.equal(records.length, 4);
  const [ok, notFound, invalid, unknown] = records;
  assert.deepEqual({ ...ok, duration_ms: 0 }, {
    tool: "get_account", outcome: "ok", client: { name: "claude-ai", version: "9.9.9" }, duration_ms: 0,
  });
  assert.ok(ok.duration_ms >= 0);
  assert.equal(notFound.outcome, "error");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.error_type, "api");
  assert.equal(invalid.error_type, "invalid_input");
  assert.equal(unknown.tool, "unknown");
  const logged = JSON.stringify(records);
  assert.doesNotMatch(logged, /secret-key-123/, "no credentials in logs");
  assert.doesNotMatch(logged, /Private user text/, "no user content in logs");
});

test("plan-limit errors name the limit and the upgrade link for Claude clients and stay neutral for every other client", async () => {
  const refusal = (error: string) => () => new Response(JSON.stringify({ error }), { status: 403 });
  const run = async (options: ServerOptions, clientName: string) => {
    const records: ToolCallRecord[] = [];
    const { client, close } = await connect({ ...options, onToolCall: (r) => records.push(r) }, clientName);
    try {
      const template = await withFetch(refusal("You've reached your template limit. Upgrade your plan to create more templates."), () =>
        client.callTool({ name: "create_template", arguments: { name: "Post", width: 1080, height: 1080 } }));
      const render = await withFetch(refusal("API quota exceeded. Upgrade your plan to generate more renders."), () =>
        client.callTool({ name: "create_render", arguments: { template: "tpl-1" } }));
      assert.equal(template.isError, true);
      assert.equal(render.isError, true);
      // The log line is the same whatever the wording
      assert.deepEqual(
        records.map(({ tool, outcome, status, error_type }) => ({ tool, outcome, status, error_type })),
        [
          { tool: "create_template", outcome: "error", status: 403, error_type: "api" },
          { tool: "create_render", outcome: "error", status: 403, error_type: "api" },
        ],
      );
      const [templateText, renderText] = [template, render].map((result) => (result.content as { text: string }[])[0].text);
      return { templateText, renderText };
    } finally {
      await close();
    }
  };
  const neutral = /^Error: This action is not available on the connected Templated account right now/;
  const assertNeutral = ({ templateText, renderText }: { templateText: string; renderText: string }) => {
    for (const text of [templateText, renderText]) {
      assert.match(text, neutral);
      assert.doesNotMatch(text, /upgrade|credits|template limit/i);
    }
  };
  const assertNamesTheLimit = ({ templateText, renderText }: { templateText: string; renderText: string }) => {
    assert.match(templateText, /^Error: The connected Templated account has reached the template limit of its current plan/);
    assert.match(templateText, /delete_template/);
    assert.match(templateText, /update_template/);
    assert.match(renderText, /^Error: The connected Templated account has used all the render credits of its current plan/);
    assert.match(renderText, /Retrying will not work/);
    for (const text of [templateText, renderText]) {
      assert.ok(text.includes("https://app.templated.io/upgrade"));
    }
  };

  assertNamesTheLimit(await run({}, "Anthropic/ClaudeAI"));
  assertNamesTheLimit(await run({}, "claude-code"));
  assertNeutral(await run({}, "openai-mcp"));
  assertNeutral(await run({}, "Cursor"));
  // Over stateless HTTP a tool call can arrive with no known handshake (restart, another
  // instance): the user agent then stands in for the client name, as it does in the log line.
  assertNamesTheLimit(await run({ userAgent: "Claude-User" }, ""));
  assertNeutral(await run({ userAgent: "openai-mcp/1.0.0" }, ""));
  // Neither a handshake nor a user agent: not known to be Claude, so neutral.
  assertNeutral(await run({}, ""));
});

test("server instructions describe the flow without steering or documenting silent failures", () => {
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /Unknown keys are ignored/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /do not stop|send the user/i);
  assert.match(SERVER_INSTRUCTIONS, /list_templates/);
  assert.match(SERVER_INSTRUCTIONS, /get_template_layers/);
  assert.match(SERVER_INSTRUCTIONS, /1080x1080/);
});

test("the version is the same everywhere it is declared", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const registry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  assert.equal(VERSION, "1.9.0");
  assert.equal(pkg.version, VERSION);
  assert.equal(registry.version, VERSION);
  assert.ok(registry.packages.every((p: { version: string }) => p.version === VERSION));

  const { client, close } = await connect();
  try {
    assert.equal(client.getServerVersion()?.version, VERSION);
  } finally {
    await close();
  }
});
