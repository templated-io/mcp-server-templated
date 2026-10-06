import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import type { RequestContext } from "./context.js";

const ctx: RequestContext = { apiKey: "k", folderId: null, externalId: null };

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx);
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("server advertises prompts and onboarding instructions", async () => {
  const { client, server } = await connect();
  try {
    assert.ok(client.getServerCapabilities()?.prompts, "prompts capability must be advertised");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /no templates/i, "must tell the model what to do for an empty account");
    assert.match(instructions, /create_template/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("prompts/list exposes the starter prompts", async () => {
  const { client, server } = await connect();
  try {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ["certificates", "first-render", "instagram-post", "og-image"]);
    for (const p of prompts) {
      assert.ok(p.description && p.description.length > 10, `${p.name} needs a description`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("prompts/get fills the arguments into a user message", async () => {
  const { client, server } = await connect();
  try {
    const result = await client.getPrompt({
      name: "certificates",
      arguments: { names: "Ana Lima, Bruno Costa", title: "Python Bootcamp" },
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "user");
    const text = (result.messages[0].content as { type: string; text: string }).text;
    assert.match(text, /Ana Lima, Bruno Costa/);
    assert.match(text, /Python Bootcamp/);
    assert.match(text, /first/i, "must render one first and check it before the batch");
  } finally {
    await client.close();
    await server.close();
  }
});

test("prompts/get works without optional arguments", async () => {
  const { client, server } = await connect();
  try {
    const result = await client.getPrompt({ name: "first-render", arguments: {} });
    const text = (result.messages[0].content as { type: string; text: string }).text;
    assert.match(text, /list_templates/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("prompts/get rejects an unknown prompt", async () => {
  const { client, server } = await connect();
  try {
    await assert.rejects(() => client.getPrompt({ name: "nope", arguments: {} }));
  } finally {
    await client.close();
    await server.close();
  }
});
