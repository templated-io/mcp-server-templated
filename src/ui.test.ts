import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { createServer, ServerOptions } from "./server.js";
import { tools } from "./tools.js";
import {
  MCP_APP_MIME_TYPE, RENDER_CARD_URI, RENDER_MEDIA_ORIGINS, RENDER_CARD_MAX_BYTES, renderCardHtmlPath,
} from "./ui.js";
import type { RequestContext } from "./context.js";

const baseCtx: RequestContext = { apiKey: "secret-key-123", folderId: null, externalId: null };
const PUBLIC_URL = "https://mcp.templated.io";

async function connect(options: ServerOptions = {}, clientName = "claude-ai", ctx = baseCtx) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx, { publicUrl: PUBLIC_URL, ...options });
  const client = new Client({ name: clientName, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// Every API call answers with `body`, except the layer lookup create_render does first.
async function callWith(body: unknown, name: string, args: Record<string, unknown>, ctx = baseCtx) {
  const { client, close } = await connect({}, "claude-ai", ctx);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as typeof fetch;
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    globalThis.fetch = original;
    await close();
  }
}

const apiRender = (over: Record<string, unknown> = {}) => ({
  id: "r1", url: "https://cdn.templated.media/render/r1.png", render_url: "https://cdn.templated.media/render/r1.png",
  status: "COMPLETED", format: "png", width: 1080, height: 1080, templateId: "t1", templateName: "Summer Sale",
  name: "", payload: "{\"secret\":true}", createdAt: "2026-10-08T10:00:00Z", externalId: null, ...over,
});

test("the UI constants match the MCP Apps SDK", () => {
  assert.equal(MCP_APP_MIME_TYPE, RESOURCE_MIME_TYPE);
  assert.equal(RESOURCE_URI_META_KEY, "ui/resourceUri");
  assert.match(RENDER_CARD_URI, /^ui:\/\/templated\/render-card-v\d+\.html$/);
});

test("resources/list declares the render card with its CSP and display modes", async () => {
  const { client, close } = await connect();
  try {
    const { resources } = await client.listResources();
    assert.equal(resources.length, 1);
    const [card] = resources;
    assert.equal(card.uri, RENDER_CARD_URI);
    assert.equal(card.mimeType, "text/html;profile=mcp-app");
    const meta = card._meta as any;
    assert.equal(meta.ui.prefersBorder, true);
    assert.deepEqual(meta.ui.csp, { connectDomains: [], resourceDomains: RENDER_MEDIA_ORIGINS });
    assert.ok(RENDER_MEDIA_ORIGINS.includes("https://cdn.templated.media"));
    assert.ok(RENDER_MEDIA_ORIGINS.includes("https://templated-assets.s3.amazonaws.com"));
    assert.deepEqual(meta["openai/ui"], { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "inline" });
    assert.ok(meta["openai/widgetDescription"].length > 20);
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(resourceTemplates, []);
  } finally {
    await close();
  }
});

test("resources/read returns the built card HTML with the same metadata", async () => {
  const { client, close } = await connect();
  try {
    const { contents } = await client.readResource({ uri: RENDER_CARD_URI });
    assert.equal(contents.length, 1);
    const [card] = contents as any[];
    assert.equal(card.uri, RENDER_CARD_URI);
    assert.equal(card.mimeType, MCP_APP_MIME_TYPE);
    assert.equal(card.text, readFileSync(renderCardHtmlPath(), "utf8"));
    assert.equal(card._meta.ui.prefersBorder, true);
    assert.deepEqual(card._meta.ui.csp.resourceDomains, RENDER_MEDIA_ORIGINS);
    await assert.rejects(client.readResource({ uri: "ui://templated/nope.html" }), /not found/i);
  } finally {
    await close();
  }
});

test("ui.domain goes only to ChatGPT, whose format Claude would reject", async () => {
  const claude = await connect({}, "claude-ai");
  try {
    const { contents } = await claude.client.readResource({ uri: RENDER_CARD_URI });
    const meta = (contents[0] as any)._meta;
    assert.equal(meta.ui.domain, undefined, "Claude validates ui.domain against its own hash format");
    assert.equal(meta["openai/widgetDomain"], PUBLIC_URL);
  } finally {
    await claude.close();
  }

  const chatgpt = await connect({}, "openai-mcp");
  try {
    const listed = (await chatgpt.client.listResources()).resources[0]._meta as any;
    const read = ((await chatgpt.client.readResource({ uri: RENDER_CARD_URI })).contents[0] as any)._meta;
    assert.equal(listed.ui.domain, PUBLIC_URL);
    assert.equal(read.ui.domain, PUBLIC_URL);
  } finally {
    await chatgpt.close();
  }

  // Over stateless HTTP the handshake happened on another request: the user agent decides.
  const byAgent = await connect({ userAgent: "openai-mcp/1.0.0", clientInfo: () => undefined }, "unknown");
  try {
    const read = ((await byAgent.client.readResource({ uri: RENDER_CARD_URI })).contents[0] as any)._meta;
    assert.equal(read.ui.domain, PUBLIC_URL);
  } finally {
    await byAgent.close();
  }

  const stdio = await connect({ publicUrl: undefined }, "openai-mcp");
  try {
    const read = ((await stdio.client.readResource({ uri: RENDER_CARD_URI })).contents[0] as any)._meta;
    assert.equal(read.ui.domain, undefined, "a local server has no origin of its own");
    assert.equal(read["openai/widgetDomain"], undefined);
  } finally {
    await stdio.close();
  }
});

test("create_render and get_render link the card; no other tool references UI", async () => {
  const { client, close } = await connect();
  try {
    const listed = (await client.listTools()).tools;
    for (const tool of listed) {
      const meta = (tool._meta ?? {}) as any;
      if (tool.name === "create_render" || tool.name === "get_render") {
        assert.equal(meta.ui.resourceUri, RENDER_CARD_URI, tool.name);
        assert.equal(meta["ui/resourceUri"], RENDER_CARD_URI, `${tool.name} legacy key, as registerAppTool sets it`);
        assert.equal(meta["openai/outputTemplate"], undefined, "the standard key is enough for ChatGPT");
        assert.equal(tool.outputSchema?.type, "object");
      } else {
        assert.equal(JSON.stringify(meta).includes("ui://"), false, tool.name);
        assert.equal(meta.ui, undefined, tool.name);
        assert.equal(tool.outputSchema, undefined, tool.name);
      }
    }
    const create = listed.find((t) => t.name === "create_render")!._meta as any;
    for (const key of ["openai/toolInvocation/invoking", "openai/toolInvocation/invoked"]) {
      assert.ok(create[key].length > 0 && create[key].length <= 64, key);
    }
  } finally {
    await close();
  }
});

test("scoped servers keep the card metadata on the render tools", async () => {
  const { client, close } = await connect({}, "claude-ai", { ...baseCtx, folderId: "f1" });
  try {
    const create = (await client.listTools()).tools.find((t) => t.name === "create_render")!;
    assert.equal((create._meta as any).ui.resourceUri, RENDER_CARD_URI);
  } finally {
    await close();
  }
});

test("create_render returns an image card next to the unchanged text result", async () => {
  const result = await callWith(apiRender(), "create_render", { template: "t1", format: "png" });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    id: "r1", url: "https://cdn.templated.media/render/r1.png", status: "completed", format: "png",
    width: 1080, height: 1080, templateId: "t1", templateName: "Summer Sale",
    editorUrl: "https://app.templated.io/editor/t1",
  });
  const [content] = result.content as { type: string; text: string }[];
  const text = JSON.parse(content.text);
  assert.equal(text.status, "COMPLETED", "text clients keep the sanitized API result");
  assert.equal(text.payload, undefined);
  assert.equal(text.render_url, undefined);
});

test("create_render returns PDF and MP4 cards", async () => {
  const pdf = await callWith(apiRender({ format: "pdf", url: "https://cdn.templated.media/r1.pdf" }), "create_render", { template: "t1", format: "pdf" });
  assert.equal((pdf.structuredContent as any).format, "pdf");
  const mp4 = await callWith(apiRender({ format: "mp4", url: "https://cdn.templated.media/r1.mp4" }), "create_render", { template: "t1", format: "mp4" });
  assert.equal((mp4.structuredContent as any).format, "mp4");
  assert.equal((mp4.structuredContent as any).url, "https://cdn.templated.media/r1.mp4");
});

test("multi-page renders come back as renders[]", async () => {
  const pages = [apiRender({ id: "a", page: "Cover" }), apiRender({ id: "b", page: "Back", url: "https://cdn.templated.media/b.png" })];
  const result = await callWith(pages, "create_render", { template: "t1" });
  const data = result.structuredContent as any;
  assert.equal(data.status, "completed");
  assert.equal(data.templateName, "Summer Sale");
  assert.deepEqual(data.renders.map((r: any) => [r.id, r.page, r.url]), [
    ["a", "Cover", "https://cdn.templated.media/render/r1.png"],
    ["b", "Back", "https://cdn.templated.media/b.png"],
  ]);
  assert.equal(data.id, undefined);
});

test("get_render reports a pending render so the card can wait for it", async () => {
  const result = await callWith(apiRender({ status: "PENDING", format: "mp4", url: "render/r1.mp4" }), "get_render", { render_id: "r1" });
  const data = result.structuredContent as any;
  assert.equal(data.status, "pending");
  assert.equal(data.id, "r1");
});

test("white-label contexts scoped to an external ID get no editor link", async () => {
  const result = await callWith(apiRender(), "get_render", { render_id: "r1" }, { ...baseCtx, externalId: "customer-42" });
  assert.equal((result.structuredContent as any).editorUrl, undefined);
  assert.equal((result.structuredContent as any).templateId, "t1");
});

test("errors carry no structured content", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: "get_render", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  } finally {
    await close();
  }
});

test("the built card is one self-contained HTML file under the size budget", () => {
  const path = renderCardHtmlPath();
  const html = readFileSync(path, "utf8");
  assert.ok(statSync(path).size < RENDER_CARD_MAX_BYTES, `${statSync(path).size} bytes`);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, "no external scripts");
  assert.doesNotMatch(html, /<link[^>]+\bhref=/i, "no external stylesheets or preloads");
  assert.doesNotMatch(html, /@import/i, "no CSS imports");
  assert.doesNotMatch(html, /url\(\s*['"]?(https?:)?\/\//i, "no CSS URLs");
  assert.equal((html.match(/<script\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1, "the inlined bundle never closes the script early");
});
