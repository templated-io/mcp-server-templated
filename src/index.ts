#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv } from "./context.js";
import { createServer } from "./server.js";
import { createHttpServer } from "./http.js";

async function startStdioMode() {
  const server = createServer(contextFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Templated MCP server running on stdio");
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  if (port) {
    createHttpServer().listen(port, () => {
      console.log(`Templated MCP server running on http://0.0.0.0:${port}`);
    });
  } else {
    await startStdioMode();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
