import { test } from "node:test";
import assert from "node:assert/strict";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpAppClient, PROTOCOL_VERSION, type Channel, type JsonRpcMessage } from "./mcpAppClient.js";

// Host transport and card channel wired to each other the way postMessage would:
// asynchronously, with structured cloning.
function linkedPair() {
  let deliver: ((message: unknown) => void) | undefined;
  const hostTransport: Transport = {
    async start() {},
    async send(message) {
      queueMicrotask(() => deliver?.(structuredClone(message)));
    },
    async close() {
      hostTransport.onclose?.();
    },
  };
  const channel: Channel = {
    send: (message) => queueMicrotask(() => hostTransport.onmessage?.(structuredClone(message) as JSONRPCMessage)),
    listen: (handler) => {
      deliver = handler;
      return () => {
        deliver = undefined;
      };
    },
  };
  return { hostTransport, channel };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the card client speaks MCP Apps with the SDK's own host (AppBridge)", async () => {
  const bridge = new AppBridge(null, { name: "test-host", version: "1.0.0" }, { openLinks: {}, serverTools: {} }, {
    hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
  });
  const opened: string[] = [];
  const sizes: unknown[] = [];
  const toolCalls: unknown[] = [];
  bridge.onopenlink = async ({ url }) => {
    opened.push(url);
    return {};
  };
  bridge.oncalltool = async (params) => {
    toolCalls.push(params);
    return { content: [{ type: "text", text: "{}" }], structuredContent: { id: "r1", status: "completed" } };
  };
  bridge.onrequestdisplaymode = async ({ mode }) => ({ mode });
  bridge.onsizechange = (size) => sizes.push(size);
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });

  const { hostTransport, channel } = linkedPair();
  await bridge.connect(hostTransport);

  const client = new McpAppClient({ name: "Templated render preview", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
  const inputs: unknown[] = [];
  const results: unknown[] = [];
  const contexts: unknown[] = [];
  let tornDown = false;
  client.ontoolinput = (params) => inputs.push(params.arguments);
  client.ontoolresult = (result) => results.push(result.structuredContent);
  client.onhostcontextchanged = (changed) => contexts.push(changed);
  client.onteardown = () => {
    tornDown = true;
  };

  await client.connect(channel);
  await initialized;
  assert.equal(client.getHostContext().theme, "dark");
  assert.deepEqual(client.getHostCapabilities()?.openLinks, {});
  assert.deepEqual(bridge.getAppCapabilities()?.availableDisplayModes, ["inline", "fullscreen"]);
  assert.deepEqual(bridge.getAppVersion(), { name: "Templated render preview", version: "1.0.0" });

  await bridge.sendToolInput({ arguments: { template: "t1", format: "png" } });
  await bridge.sendToolResult({ content: [{ type: "text", text: "{}" }], structuredContent: { id: "r1", status: "pending" } });
  await settle();
  assert.deepEqual(inputs, [{ template: "t1", format: "png" }]);
  assert.deepEqual(results, [{ id: "r1", status: "pending" }]);

  const polled = await client.callServerTool({ name: "get_render", arguments: { render_id: "r1" } });
  assert.deepEqual(polled.structuredContent, { id: "r1", status: "completed" });
  assert.deepEqual(toolCalls, [{ name: "get_render", arguments: { render_id: "r1" } }]);

  await client.openLink({ url: "https://cdn.templated.media/render/r1.png" });
  assert.deepEqual(opened, ["https://cdn.templated.media/render/r1.png"]);
  assert.deepEqual(await client.requestDisplayMode({ mode: "fullscreen" }), { mode: "fullscreen" });

  client.sendSizeChanged({ width: 400, height: 320 });
  await settle();
  assert.deepEqual(sizes, [{ width: 400, height: 320 }]);

  bridge.setHostContext({ theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] });
  await settle();
  assert.deepEqual(contexts, [{ theme: "light" }]);
  assert.equal(client.getHostContext().theme, "light");
  assert.equal(client.getHostContext().displayMode, "inline");

  await bridge.teardownResource({ reason: "closed" });
  assert.equal(tornDown, true);
  client.close();
  await hostTransport.close();
});

test("the client answers pings, refuses unknown host requests and surfaces errors", async () => {
  const sent: JsonRpcMessage[] = [];
  let deliver: (message: unknown) => void = () => {};
  const channel: Channel = { send: (message) => sent.push(message), listen: (handler) => ((deliver = handler), () => {}) };
  const client = new McpAppClient({ name: "card", version: "1" });
  const connecting = client.connect(channel);

  const init = sent[0];
  assert.equal(init.method, "ui/initialize");
  assert.deepEqual((init.params as any).protocolVersion, PROTOCOL_VERSION);
  deliver("not json-rpc");
  deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: PROTOCOL_VERSION, hostInfo: { name: "h", version: "1" }, hostCapabilities: {}, hostContext: {} } });
  await connecting;
  assert.deepEqual(sent[1], { jsonrpc: "2.0", method: "ui/notifications/initialized" });

  deliver({ jsonrpc: "2.0", id: 99, method: "ping" });
  deliver({ jsonrpc: "2.0", id: 100, method: "ui/something-new" });
  await settle();
  assert.deepEqual(sent[2], { jsonrpc: "2.0", id: 99, result: {} });
  assert.equal(sent[3].id, 100);
  assert.equal(sent[3].error?.code, -32601);

  const link = client.openLink({ url: "https://example.com" });
  deliver({ jsonrpc: "2.0", id: sent[4].id, error: { code: -32000, message: "Link opening denied by user" } });
  await assert.rejects(link, /denied/);
  client.close();
});
