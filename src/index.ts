#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

// API Configuration
const API_BASE_URL = "https://api.templated.io";

// Get API key - either from environment (stdio mode) or from request query (HTTP mode)
let currentApiKey: string | null = null;

function getApiKey(): string {
  if (currentApiKey) {
    return currentApiKey;
  }
  const apiKey = process.env.TEMPLATED_API_KEY;
  return apiKey || "";
}

function setApiKey(apiKey: string) {
  currentApiKey = apiKey;
}

// Folder scoping - when set, all operations are restricted to this folder
let currentFolderId: string | null = null;

function getFolderId(): string | null {
  if (currentFolderId) {
    return currentFolderId;
  }
  return process.env.TEMPLATED_FOLDER_ID || null;
}

function setFolderId(folderId: string) {
  currentFolderId = folderId;
}

// External ID scoping - when set, all operations are restricted to this external ID
let currentExternalId: string | null = null;

function getExternalId(): string | null {
  if (currentExternalId) {
    return currentExternalId;
  }
  return process.env.TEMPLATED_EXTERNAL_ID || null;
}

function setExternalId(externalId: string) {
  currentExternalId = externalId;
}

// API request helper
async function apiRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const apiKey = getApiKey();
  
  if (!apiKey) {
    throw new Error("API key required. Please provide your Templated API key via ?apiKey= query parameter or Authorization header.");
  }
  
  let url = `${API_BASE_URL}${path}`;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  const options: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };

  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return { success: true };
  }
  
  return JSON.parse(text);
}

// Validate that a template belongs to the configured folder
async function validateTemplateInFolder(templateId: string): Promise<void> {
  const folderId = getFolderId();
  if (!folderId) return;

  const template = await apiRequest("GET", `/v1/template/${templateId}`) as Record<string, unknown>;
  if (template.folderId !== folderId) {
    throw new Error("Template not found in the configured folder");
  }
}

// Move a template into the configured folder
async function moveTemplateToFolder(templateId: string): Promise<void> {
  const folderId = getFolderId();
  if (!folderId) return;

  await apiRequest("PUT", `/v1/folder/${folderId}/template/${templateId}`);
}

// Validate that a template belongs to the configured external ID
async function validateTemplateByExternalId(templateId: string): Promise<void> {
  const externalId = getExternalId();
  if (!externalId) return;

  const template = await apiRequest("GET", `/v1/template/${templateId}`) as Record<string, unknown>;
  if (template.externalId !== externalId) {
    throw new Error("Template not found for the configured external ID");
  }
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const tools: Tool[] = [
  // ---------------------------------------------------------------------------
  // RENDER TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "create_render",
    description: "Create a render (image, video, or PDF) from a template. This is the main tool for generating content. Supports formats: jpg, png, webp, pdf, mp4.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: "The template ID to render",
        },
        format: {
          type: "string",
          enum: ["jpg", "png", "webp", "pdf", "mp4"],
          description: "Output format. Default: jpg",
        },
        layers: {
          type: "object",
          description: "Layer modifications. Keys are layer names, values are objects with properties like: text, image_url, color, background, hide, animation, etc. The 'animation' property (MP4 only) is an object with: 'in' (entrance: type=slide|fade|zoom|rotate, direction, duration, writingStyle), 'loop' (type=spin|pulse, duration), 'out' (exit: type=slide|fade|zoom, direction, duration), 'start' (ms when layer appears), 'end' (ms when layer disappears). All animation durations are in milliseconds.",
          additionalProperties: {
            type: "object",
          },
        },
        transparent: {
          type: "boolean",
          description: "Make background transparent (PNG only)",
        },
        duration: {
          type: "number",
          description: "Video duration in milliseconds (MP4 only, max 90000)",
        },
        fps: {
          type: "number",
          description: "Frames per second (MP4 only, 1-60)",
        },
        flatten: {
          type: "boolean",
          description: "Flatten PDF for print-ready documents",
        },
        cmyk: {
          type: "boolean",
          description: "Use CMYK color mode (PDF only)",
        },
        width: {
          type: "number",
          description: "Custom width in pixels (100-5000)",
        },
        height: {
          type: "number",
          description: "Custom height in pixels (100-5000)",
        },
        scale: {
          type: "number",
          description: "Scale factor (0.1-2.0)",
        },
        name: {
          type: "string",
          description: "Custom name for the render",
        },
        background: {
          type: "string",
          description: "Background color in hex format (e.g., #FF0000)",
        },
      },
      required: ["template"],
    },
  },
  {
    name: "get_render",
    description: "Retrieve a specific render by its ID to get the status and file URL",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        render_id: {
          type: "string",
          description: "The render ID",
        },
      },
      required: ["render_id"],
    },
  },
  {
    name: "list_renders",
    description: "List all renders in the account",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number (default: 0)",
        },
        limit: {
          type: "number",
          description: "Results per page (default: 25)",
        },
      },
    },
  },
  {
    name: "delete_render",
    description: "Delete a specific render",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        render_id: {
          type: "string",
          description: "The render ID to delete",
        },
      },
      required: ["render_id"],
    },
  },
  {
    name: "merge_renders",
    description: "Merge multiple PDF renders into a single PDF document",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        render_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of render IDs to merge",
        },
        host: {
          type: "boolean",
          description: "If true, returns a hosted URL. If false, returns the file directly",
        },
      },
      required: ["render_ids"],
    },
  },

  // ---------------------------------------------------------------------------
  // TEMPLATE TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "list_templates",
    description: "List all templates in the account. Use this to find template IDs for rendering.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to filter templates by name",
        },
        page: {
          type: "number",
          description: "Page number (default: 0)",
        },
        limit: {
          type: "number",
          description: "Results per page (default: 25)",
        },
        width: {
          type: "number",
          description: "Filter by template width",
        },
        height: {
          type: "number",
          description: "Filter by template height",
        },
        tags: {
          type: "string",
          description: "Filter by tags (comma-separated)",
        },
        includeLayers: {
          type: "boolean",
          description: "Include layer information in response",
        },
      },
    },
  },
  {
    name: "get_template",
    description: "Retrieve a specific template by ID",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "get_template_layers",
    description: "Get all layers of a template. Use this to understand what layers can be modified when creating a render.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "get_template_pages",
    description: "Get all pages of a multi-page template",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "create_template",
    description: "Create a new template programmatically with layers. IMPORTANT: Each layer must have a 'layer' field (unique identifier/name), not 'name'. Valid layer types are: 'text', 'image', 'shape', 'rating'. Use 'shape' for rectangles, circles, and other shapes - shapes require an 'html' field with SVG content.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Template name",
        },
        width: {
          type: "number",
          description: "Template width in pixels",
        },
        height: {
          type: "number",
          description: "Template height in pixels",
        },
        background: {
          type: "string",
          description: "Template background color (e.g., '#ffffff', 'rgb(255,255,255)', 'transparent')",
        },
        duration: {
          type: "number",
          description: "Default video duration in milliseconds for MP4 renders (e.g., 5000 for 5 seconds). Used as fallback when no duration is specified at render time.",
        },
        layers: {
          type: "array",
          description: "Array of layer objects. Each layer MUST have 'layer' (unique name) and 'type' fields.",
          items: {
            type: "object",
            properties: {
              layer: {
                type: "string",
                description: "REQUIRED: Unique layer identifier/name (e.g., 'title', 'background', 'photo'). This is NOT 'name', use 'layer'!",
              },
              type: {
                type: "string",
                enum: ["text", "image", "shape", "rating"],
                description: "REQUIRED: Layer type. Use 'shape' for rectangles/circles (NOT 'rectangle'). Shapes need 'html' with SVG content.",
              },
              x: { type: "number", description: "X position in pixels" },
              y: { type: "number", description: "Y position in pixels" },
              width: { type: "number", description: "Width in pixels" },
              height: { type: "number", description: "Height in pixels" },
              rotation: { type: "number", description: "Rotation in degrees" },
              // Text layer properties
              text: { type: "string", description: "Text content (for text layers)" },
              color: { type: "string", description: "Text color (e.g., '#000000', 'rgba(0,0,0,1)')" },
              font_family: { type: "string", description: "Font family (e.g., 'Inter', 'Arial')" },
              font_size: { type: "string", description: "Font size with unit (e.g., '24px', '2em')" },
              font_weight: { type: "string", description: "Font weight (e.g., 'normal', 'bold', '600')" },
              letter_spacing: { type: "string", description: "Letter spacing (e.g., '1px', '0.05em')" },
              line_height: { type: "string", description: "Line height (e.g., '1.4', '24px')" },
              horizontal_align: { type: "string", enum: ["left", "center", "right"], description: "Horizontal text alignment" },
              vertical_align: { type: "string", enum: ["top", "center", "bottom"], description: "Vertical text alignment" },
              // Image layer properties
              image_url: { type: "string", description: "Image URL (for image layers)" },
              object_fit: { type: "string", enum: ["cover", "contain", "fill"], description: "How image fits in container" },
              // Shape layer properties
              html: { type: "string", description: "SVG content for shape layers. Example: '<rect width=\"100%\" height=\"100%\" fill=\"#ff0000\"/>'" },
              fill: { type: "string", description: "SVG fill color" },
              stroke: { type: "string", description: "SVG stroke color" },
              // Common styling
              background: { type: "string", description: "Background color/gradient (for shapes use this OR html with SVG)" },
              border_width: { type: "number", description: "Border width in pixels" },
              border_color: { type: "string", description: "Border color" },
              border_radius: { type: "string", description: "Border radius (e.g., '8px', '50%')" },
              opacity: { type: "number", description: "Opacity from 0 to 1" },
              hide: { type: "boolean", description: "Whether layer is hidden" },
              order: { type: "number", description: "Layer stacking order (lower = behind)" },
              animation: {
                type: "object",
                description: "Animation config for video (MP4) renders. All time values are in milliseconds. Contains 'in' (entrance), 'loop', 'out' (exit), 'start' and 'end' timeline.",
                properties: {
                  in: {
                    type: "object",
                    description: "Entrance animation",
                    properties: {
                      type: { type: "string", enum: ["slide", "fade", "zoom", "rotate"], description: "Animation type" },
                      direction: { type: "string", enum: ["left", "right", "up", "down", "in", "out"], description: "Direction" },
                      duration: { type: "integer", description: "Duration in milliseconds" },
                      writingStyle: { type: "string", enum: ["block", "word", "character"], description: "Text animation style" },
                    },
                  },
                  loop: {
                    type: "object",
                    description: "Looping animation",
                    properties: {
                      type: { type: "string", enum: ["spin", "pulse"], description: "Animation type" },
                      duration: { type: "integer", description: "Duration in milliseconds per cycle" },
                    },
                  },
                  out: {
                    type: "object",
                    description: "Exit animation",
                    properties: {
                      type: { type: "string", enum: ["slide", "fade", "zoom"], description: "Animation type" },
                      direction: { type: "string", enum: ["left", "right", "up", "down", "in", "out"], description: "Direction" },
                      duration: { type: "integer", description: "Duration in milliseconds" },
                    },
                  },
                  start: { type: "integer", description: "Time in milliseconds when layer becomes visible (default: 0)" },
                  end: { type: "integer", description: "Time in milliseconds when layer disappears (default: video duration)" },
                },
              },
            },
            required: ["layer", "type"],
          },
        },
      },
      required: ["name", "width", "height"],
    },
  },
  {
    name: "update_template",
    description: "Update an existing template. IMPORTANT: Each layer must have a 'layer' field (unique identifier), not 'name'. Valid types: 'text', 'image', 'shape', 'rating'.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID to update",
        },
        name: {
          type: "string",
          description: "New template name",
        },
        description: {
          type: "string",
          description: "New template description",
        },
        width: {
          type: "number",
          description: "New width in pixels",
        },
        height: {
          type: "number",
          description: "New height in pixels",
        },
        background: {
          type: "string",
          description: "Template background color",
        },
        duration: {
          type: "number",
          description: "Default video duration in milliseconds for MP4 renders (e.g., 5000 for 5 seconds)",
        },
        layers: {
          type: "array",
          description: "Layer definitions. Each must have 'layer' (unique name) and 'type' (text/image/shape/rating).",
          items: {
            type: "object",
            properties: {
              layer: { type: "string", description: "REQUIRED: Unique layer identifier (NOT 'name')" },
              type: { type: "string", enum: ["text", "image", "shape", "rating"], description: "Layer type" },
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
              text: { type: "string" }, color: { type: "string" },
              font_family: { type: "string" }, font_size: { type: "string" },
              image_url: { type: "string" }, background: { type: "string" },
              html: { type: "string", description: "SVG content for shape layers" },
              animation: {
                type: "object",
                description: "Animation config for video (MP4) renders. All time values in milliseconds.",
                properties: {
                  in: { type: "object", properties: { type: { type: "string" }, direction: { type: "string" }, duration: { type: "integer" }, writingStyle: { type: "string" } } },
                  loop: { type: "object", properties: { type: { type: "string" }, duration: { type: "integer" } } },
                  out: { type: "object", properties: { type: { type: "string" }, direction: { type: "string" }, duration: { type: "integer" } } },
                  start: { type: "integer", description: "When layer appears (ms)" },
                  end: { type: "integer", description: "When layer disappears (ms)" },
                },
              },
            },
            required: ["layer", "type"],
          },
        },
        replaceLayers: {
          type: "boolean",
          description: "If true, replaces all layers. If false, merges with existing",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "clone_template",
    description: "Create a copy of an existing template",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID to clone",
        },
        name: {
          type: "string",
          description: "Name for the cloned template",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "delete_template",
    description: "Delete a template",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID to delete",
        },
      },
      required: ["template_id"],
    },
  },
  {
    name: "list_template_renders",
    description: "List all renders created from a specific template",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID",
        },
        page: {
          type: "number",
          description: "Page number",
        },
        limit: {
          type: "number",
          description: "Results per page",
        },
      },
      required: ["template_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // FOLDER TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "list_folders",
    description: "List all folders in the account",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number",
        },
        limit: {
          type: "number",
          description: "Results per page",
        },
      },
    },
  },
  {
    name: "create_folder",
    description: "Create a new folder to organize templates",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Folder name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_folder",
    description: "Update a folder's name",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "The folder ID",
        },
        name: {
          type: "string",
          description: "New folder name",
        },
      },
      required: ["folder_id", "name"],
    },
  },
  {
    name: "delete_folder",
    description: "Delete a folder",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "The folder ID to delete",
        },
      },
      required: ["folder_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // UPLOAD TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "list_uploads",
    description: "List all uploaded assets (images, videos)",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number",
        },
        limit: {
          type: "number",
          description: "Results per page",
        },
      },
    },
  },
  {
    name: "create_upload",
    description: "Upload a file from a URL",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL of the file to upload",
        },
        name: {
          type: "string",
          description: "Optional name for the upload",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "delete_upload",
    description: "Delete an uploaded asset",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        upload_id: {
          type: "string",
          description: "The upload ID to delete",
        },
      },
      required: ["upload_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // FONT TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "list_fonts",
    description: "List all custom fonts uploaded to the account",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number",
        },
        limit: {
          type: "number",
          description: "Results per page",
        },
      },
    },
  },
  {
    name: "upload_font",
    description: "Upload a custom font from a URL",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL of the font file (TTF, OTF, WOFF, WOFF2)",
        },
        name: {
          type: "string",
          description: "Font family name",
        },
      },
      required: ["url", "name"],
    },
  },
  {
    name: "delete_font",
    description: "Delete a custom font",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        font_id: {
          type: "string",
          description: "The font ID to delete",
        },
      },
      required: ["font_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // ACCOUNT TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "get_account",
    description: "Get account information including API usage and quota",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// =============================================================================
// TOOL HANDLERS
// =============================================================================

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    // RENDER HANDLERS
    case "create_render": {
      await validateTemplateInFolder(args.template as string);
      await validateTemplateByExternalId(args.template as string);
      const body: Record<string, unknown> = {
        template: args.template,
      };
      if (args.format) body.format = args.format;
      if (args.layers) body.layers = args.layers;
      if (args.transparent) body.transparent = args.transparent;
      if (args.duration) body.duration = args.duration;
      if (args.fps) body.fps = args.fps;
      if (args.flatten) body.flatten = args.flatten;
      if (args.cmyk) body.cmyk = args.cmyk;
      if (args.width) body.width = args.width;
      if (args.height) body.height = args.height;
      if (args.scale) body.scale = args.scale;
      if (args.name) body.name = args.name;
      if (args.background) body.background = args.background;
      return apiRequest("POST", "/v1/render", body);
    }

    case "get_render":
      return apiRequest("GET", `/v1/render/${args.render_id}`);

    case "list_renders": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      const folderId = getFolderId();
      const externalId = getExternalId();
      if (externalId) params.externalId = externalId;
      const rendersPath = folderId ? `/v1/folder/${folderId}/renders` : "/v1/renders";
      return apiRequest("GET", rendersPath, undefined, params);
    }

    case "delete_render":
      return apiRequest("DELETE", `/v1/render/${args.render_id}`);

    case "merge_renders":
      return apiRequest("POST", "/v1/renders/merge", {
        ids: args.render_ids,
        host: args.host ?? true,
      });

    // TEMPLATE HANDLERS
    case "list_templates": {
      const params: Record<string, string> = {};
      if (args.query) params.query = String(args.query);
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.width !== undefined) params.width = String(args.width);
      if (args.height !== undefined) params.height = String(args.height);
      if (args.tags) params.tags = String(args.tags);
      if (args.includeLayers) params.includeLayers = "true";
      const folderId = getFolderId();
      const externalId = getExternalId();
      if (externalId) params.externalId = externalId;
      const templatesPath = folderId ? `/v1/folder/${folderId}/templates` : "/v1/templates";
      return apiRequest("GET", templatesPath, undefined, params);
    }

    case "get_template":
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      return apiRequest("GET", `/v1/template/${args.template_id}`);

    case "get_template_layers":
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      return apiRequest("GET", `/v1/template/${args.template_id}/layers`);

    case "get_template_pages":
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      return apiRequest("GET", `/v1/template/${args.template_id}/pages`);

    case "create_template": {
      const body: Record<string, unknown> = {
        name: args.name,
        width: args.width,
        height: args.height,
      };
      if (args.layers) body.layers = args.layers;
      const externalId = getExternalId();
      if (externalId) body.externalId = externalId;
      const result = await apiRequest("POST", "/v1/template", body) as Record<string, unknown>;
      await moveTemplateToFolder(result.id as string);
      return result;
    }

    case "update_template": {
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      if (args.description) body.description = args.description;
      if (args.width) body.width = args.width;
      if (args.height) body.height = args.height;
      if (args.layers) body.layers = args.layers;
      const params: Record<string, string> = {};
      if (args.replaceLayers) params.replaceLayers = "true";
      return apiRequest("PUT", `/v1/template/${args.template_id}`, body, params);
    }

    case "clone_template": {
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      const result = await apiRequest("POST", `/v1/template/${args.template_id}/clone`, body) as Record<string, unknown>;
      await moveTemplateToFolder(result.id as string);
      // Set externalId on the clone
      const externalId = getExternalId();
      if (externalId) {
        await apiRequest("PUT", `/v1/template/${result.id}`, { externalId });
      }
      return result;
    }

    case "delete_template":
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      return apiRequest("DELETE", `/v1/template/${args.template_id}`);

    case "list_template_renders": {
      await validateTemplateInFolder(args.template_id as string);
      await validateTemplateByExternalId(args.template_id as string);
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest("GET", `/v1/template/${args.template_id}/renders`, undefined, params);
    }

    // FOLDER HANDLERS
    case "list_folders": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest("GET", "/v1/folders", undefined, params);
    }

    case "create_folder":
      return apiRequest("POST", "/v1/folder", { name: args.name });

    case "update_folder":
      return apiRequest("PUT", `/v1/folder/${args.folder_id}`, { name: args.name });

    case "delete_folder":
      return apiRequest("DELETE", `/v1/folder/${args.folder_id}`);

    // UPLOAD HANDLERS
    case "list_uploads": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest("GET", "/v1/uploads", undefined, params);
    }

    case "create_upload": {
      const body: Record<string, unknown> = { url: args.url };
      if (args.name) body.name = args.name;
      return apiRequest("POST", "/v1/upload", body);
    }

    case "delete_upload":
      return apiRequest("DELETE", `/v1/upload/${args.upload_id}`);

    // FONT HANDLERS
    case "list_fonts": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest("GET", "/v1/fonts", undefined, params);
    }

    case "upload_font":
      return apiRequest("POST", "/v1/font", {
        url: args.url,
        name: args.name,
      });

    case "delete_font":
      return apiRequest("DELETE", `/v1/font/${args.font_id}`);

    // ACCOUNT HANDLERS
    case "get_account":
      return apiRequest("GET", "/v1/account");

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// =============================================================================
// SERVER SETUP
// =============================================================================

// Create MCP server instance
function createServer() {
  const mcpServer = new Server(
    {
      name: "mcp-server-templated",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const folderId = getFolderId();
    const externalId = getExternalId();

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
      : folderId
        ? "the configured folder"
        : "the configured external ID";

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

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args as Record<string, unknown>);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return mcpServer;
}

// Start the server in stdio mode (for local use via npx)
async function startStdioMode() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Templated MCP server running on stdio");
}

// Start the server in HTTP mode (for remote access)
async function startHttpMode(port: number) {
  // Create transport and server
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });
  
  const server = createServer();
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    
    // Content Security Policy - required for ChatGPT app submission
    // Specifies that this server only fetches from api.templated.io
    res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://api.templated.io");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Health check endpoint
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "streamable-http" }));
      return;
    }

    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // Used by MCP clients to discover OAuth endpoints
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: "https://api.templated.io",
        authorization_endpoint: "https://api.templated.io/oauth/authorize",
        token_endpoint: "https://api.templated.io/oauth/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
      }));
      return;
    }

    // OpenAI domain verification endpoint (token set via OPENAI_VERIFICATION_TOKEN env var)
    if (url.pathname === "/.well-known/openai-apps-challenge") {
      const verificationToken = process.env.OPENAI_VERIFICATION_TOKEN;
      if (verificationToken) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(verificationToken);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not configured" }));
      }
      return;
    }

    // MCP endpoints - /mcp or /sse (for compatibility)
    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/") {
      // Extract API key from query parameter or Authorization header (optional for tool listing)
      let apiKey = url.searchParams.get("apiKey");
      
      if (!apiKey) {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
          apiKey = authHeader.substring(7);
        }
      }
      
      // Set the API key if provided (tool calls will fail if not set)
      if (apiKey) {
        setApiKey(apiKey);
      } else {
        // Clear API key for unauthenticated requests (allows tool listing but not execution)
        setApiKey("");
      }

      // Set folder ID if provided (scopes all operations to this folder)
      const folderId = url.searchParams.get("folderId");
      if (folderId) {
        setFolderId(folderId);
      }

      // Set external ID if provided (scopes all operations to this external ID)
      const externalId = url.searchParams.get("externalId");
      if (externalId) {
        setExternalId(externalId);
      }

      // Handle the MCP request
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.log(`Templated MCP server running on http://0.0.0.0:${port}`);
    console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp?apiKey=YOUR_API_KEY`);
  });
}

// Main entry point
async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  
  if (port) {
    // HTTP/SSE mode for remote server
    await startHttpMode(port);
  } else {
    // stdio mode for local use
    await startStdioMode();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
