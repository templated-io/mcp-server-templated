import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "./context.js";
import { tools, handleToolCall } from "./tools.js";

export function createServer(ctx: RequestContext): Server {
  const mcpServer = new Server(
    { name: "mcp-server-templated", version: "1.6.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const { folderId, externalId } = ctx;
    if (!folderId && !externalId) {
      return { tools };
    }

    // When scoped: hide folder management tools and update descriptions
    const hiddenTools = new Set<string>();
    if (folderId) {
      hiddenTools.add("list_folders");
      hiddenTools.add("create_folder");
      hiddenTools.add("update_folder");
      hiddenTools.add("delete_folder");
    }

    const scopeLabel = folderId && externalId
      ? "the configured folder and external ID"
      : folderId ? "the configured folder" : "the configured external ID";

    const scopedTools = tools
      .filter((tool) => !hiddenTools.has(tool.name))
      .map((tool) => {
        if (tool.name === "list_templates") {
          return { ...tool, description: `List templates in ${scopeLabel}. Use this to find template IDs for rendering.` };
        }
        if (tool.name === "list_renders") {
          return { ...tool, description: `List renders in ${scopeLabel}` };
        }
        return tool;
      });
    return { tools: scopedTools };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(ctx, name, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  return mcpServer;
}
