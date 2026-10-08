import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ClientInfo } from "./usage.js";

// MCP Apps (io.modelcontextprotocol/ui, spec 2026-01-26): create_render and get_render
// link a UI resource that hosts such as Claude and ChatGPT render inline as a preview
// card. Hosts without MCP Apps ignore the metadata and use the text result.

// Same value as RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps (ui.test.ts checks).
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

// The URI is the hosts' cache key (ChatGPT keeps resources up to an hour): bump the
// version when a card change is not backward compatible with cached copies.
export const RENDER_CARD_URI = "ui://templated/render-card-v1.html";

// Origins render files are served from (r2.path and AssetUrls.s3Base in the API).
// Renders on a customer's own bucket (BYOS) fall outside and show as a link.
export const RENDER_MEDIA_ORIGINS = ["https://cdn.templated.media", "https://templated-assets.s3.amazonaws.com"];

// The card ships as one self-contained file built by scripts/build-ui.mjs.
export const RENDER_CARD_MAX_BYTES = 150 * 1024;

export const RENDER_CARD_TOOLS = new Set(["create_render", "get_render"]);

// What registerAppTool from @modelcontextprotocol/ext-apps/server emits: the
// standard key plus the flat "ui/resourceUri" key older hosts still read.
const cardLink = { ui: { resourceUri: RENDER_CARD_URI }, "ui/resourceUri": RENDER_CARD_URI };

export const CREATE_RENDER_META: Record<string, unknown> = {
  ...cardLink,
  "openai/toolInvocation/invoking": "Rendering your design…",
  "openai/toolInvocation/invoked": "Render finished",
};
export const GET_RENDER_META: Record<string, unknown> = { ...cardLink };

const renderFields = {
  id: { type: "string" },
  url: { type: "string", description: "File URL" },
  status: { type: "string", description: "completed, pending or failed" },
  format: { type: "string", description: "jpg, png, webp, pdf or mp4" },
  width: { type: "number" },
  height: { type: "number" },
  name: { type: "string" },
  page: { type: "string", description: "Page name, for multi-page templates" },
};

export const RENDER_CARD_OUTPUT_SCHEMA: Tool["outputSchema"] = {
  type: "object",
  properties: {
    ...renderFields,
    status: { type: "string", description: "completed, pending or failed; for several renders, pending while any of them is" },
    templateId: { type: "string" },
    templateName: { type: "string" },
    editorUrl: { type: "string", description: "Link to edit the template in the Templated editor" },
    renders: {
      type: "array",
      description: "Present when the call produced several renders (one per page); single renders put their fields at the top level",
      items: { type: "object", properties: renderFields, required: ["id", "status"] },
    },
  },
  required: ["status"],
};

// --- resource -------------------------------------------------------------------

export interface UiHost {
  // Public origin of this server (MCP_PUBLIC_URL); absent for local stdio servers.
  publicUrl?: string;
  client?: ClientInfo;
  userAgent?: string;
}

// ChatGPT reports clientInfo "openai-mcp"; over stateless HTTP the initialize
// handshake may have been on another request, so its user agent also counts.
function isChatGpt(host: UiHost): boolean {
  return /^openai|chatgpt/i.test(host.client?.name ?? "") || /openai-mcp|chatgpt/i.test(host.userAgent ?? "");
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// ui.domain is host-specific. ChatGPT requires an origin unique to the plugin
// (openai/widgetDomain is its alias). Claude only accepts
// "<sha256(connector URL)[0:32]>.claudemcpcontent.com" and shows an error instead of
// the card for anything else; without the field it uses its default sandbox, which
// the card is fine with, so Claude never gets one.
export function renderCardMeta(host: UiHost): Record<string, unknown> {
  const domain = originOf(host.publicUrl);
  const ui: Record<string, unknown> = {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: RENDER_MEDIA_ORIGINS },
  };
  if (domain && isChatGpt(host)) ui.domain = domain;
  return {
    ui,
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "inline" },
    "openai/widgetDescription":
      "Shows the finished render: the image, a video player or a PDF tile, with its size and format, " +
      "a Download button and a link to open the template in the Templated editor.",
    ...(domain && { "openai/widgetDomain": domain }),
  };
}

export function listUiResources(host: UiHost): Resource[] {
  return [{
    uri: RENDER_CARD_URI,
    name: "render_card",
    title: "Render preview",
    description: "Preview card for create_render and get_render results",
    mimeType: MCP_APP_MIME_TYPE,
    _meta: renderCardMeta(host),
  }];
}

// -32002 is the MCP error code for an unknown resource.
const RESOURCE_NOT_FOUND = -32002;

export function readUiResource(uri: string, host: UiHost): ReadResourceResult {
  if (uri !== RENDER_CARD_URI) {
    throw new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
  }
  return {
    contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: renderCardHtml(), _meta: renderCardMeta(host) }],
  };
}

// dist/ui.js reads dist/ui/render-card.html; compiled tests (.test-dist) read the
// copy in dist, which `npm test` builds first.
export function renderCardHtmlPath(): string {
  const candidates = [
    new URL("./ui/render-card.html", import.meta.url),
    new URL("../dist/ui/render-card.html", import.meta.url),
  ].map((url) => fileURLToPath(url));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new McpError(-32603, "The render card is not built. Run npm run build.");
  }
  return found;
}

let cachedHtml: string | undefined;
function renderCardHtml(): string {
  cachedHtml ??= readFileSync(renderCardHtmlPath(), "utf8");
  return cachedHtml;
}
