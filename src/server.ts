import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "./context.js";
import { ApiError, InputError } from "./api.js";
import { tools, handleToolCall, ToolContent } from "./tools.js";
import { prompts, getPrompt, SERVER_INSTRUCTIONS } from "./prompts.js";
import { clientInfoOf, ClientInfo, ToolCallLogger, ToolCallRecord } from "./usage.js";
import { VERSION } from "./version.js";
import { listUiResources, readUiResource, RENDER_CARD_TOOLS, UiHost } from "./ui.js";
import { toCardData } from "./renderCard.js";

export interface ServerOptions {
  // Called once per tools/call with metadata only (no arguments, results or credentials).
  onToolCall?: ToolCallLogger;
  // Over stateless HTTP each request gets a new Server, so the initialize handshake
  // happened on an earlier request; this returns the client it reported.
  clientInfo?: () => ClientInfo | undefined;
  // Logged when the client is unknown, so calls can still be told apart.
  userAgent?: string;
  // Public URL of the hosted server (MCP_PUBLIC_URL); the UI resource's dedicated
  // origin in ChatGPT. Absent for local stdio servers.
  publicUrl?: string;
  // Templated web app, for the preview card's "Open in editor" link.
  appUrl?: string;
}

const DEFAULT_APP_URL = "https://app.templated.io";

const TOOL_NAMES = new Set(tools.map((tool) => tool.name));

type Outcome = Pick<ToolCallRecord, "outcome" | "status" | "error_type">;

function errorOutcome(error: unknown): Outcome {
  if (error instanceof ApiError) return { outcome: "error", status: error.status, error_type: "api" };
  if (error instanceof InputError) return { outcome: "error", error_type: "invalid_input" };
  return { outcome: "error", error_type: "internal" };
}

export function createServer(ctx: RequestContext, options: ServerOptions = {}): Server {
  const mcpServer = new Server(
    { name: "mcp-server-templated", version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  const client = () => clientInfoOf(mcpServer.getClientVersion()) ?? options.clientInfo?.();
  const uiHost = (): UiHost => ({ publicUrl: options.publicUrl, client: client(), userAgent: options.userAgent });

  mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listUiResources(uiHost()) }));

  mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => readUiResource(request.params.uri, uiHost()));

  mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, request.params.arguments ?? {})
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
          return {
            ...tool,
            description: `List the templates in ${scopeLabel}, 25 per page by default (max 100), optionally filtered by name (query), size (width, height) or tags. Use this first to find the template ID for create_render, get_template_layers or update_template.`,
          };
        }
        if (tool.name === "list_renders") {
          return {
            ...tool,
            description: `List the renders in ${scopeLabel}, 25 per page by default (max 100). Use this to find a render's ID or file URL.`,
          };
        }
        return tool;
      });
    return { tools: scopedTools };
  });

  const record = (tool: string, started: number, outcome: Outcome) => {
    if (!options.onToolCall) return;
    const info = client();
    const entry: ToolCallRecord = {
      tool: TOOL_NAMES.has(tool) ? tool : "unknown",
      outcome: outcome.outcome,
      ...(outcome.status !== undefined && { status: outcome.status }),
      ...(outcome.error_type && { error_type: outcome.error_type }),
      ...(info ? { client: info } : options.userAgent ? { user_agent: options.userAgent } : {}),
      duration_ms: Date.now() - started,
    };
    try {
      options.onToolCall(entry);
    } catch {
      // logging never fails a tool call
    }
  };

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const started = Date.now();
    try {
      const result = await handleToolCall(ctx, name, args);
      const response: CallToolResult = result instanceof ToolContent
        ? { content: result.content }
        : { content: [{ type: "text", text: JSON.stringify(result) }] };
      // The preview card renders from structuredContent; the text above stays for
      // clients without MCP Apps. White-label contexts (external ID) get no editor link.
      if (RENDER_CARD_TOOLS.has(name) && !(result instanceof ToolContent)) {
        response.structuredContent = { ...toCardData(result, { appUrl: ctx.externalId ? undefined : options.appUrl ?? DEFAULT_APP_URL }) };
      }
      record(name, started, { outcome: "ok" });
      return response;
    } catch (error) {
      record(name, started, errorOutcome(error));
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  return mcpServer;
}
