import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "./context.js";
import { apiRequest, validateTemplateInFolder, moveTemplateToFolder, validateTemplateByExternalId } from "./api.js";

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

// Layer properties accepted inside a page of the `pages` array. Unlike the
// top-level `layers` array, a page's `layers` is an OBJECT keyed by layer name,
// so there is no `layer` field here (the key is the name).
const pageLayerProperties = {
  type: { type: "string", enum: ["text", "image", "shape", "rating"], description: "Layer type" },
  x: { type: "number" }, y: { type: "number" },
  width: { type: "number" }, height: { type: "number" },
  text: { type: "string" }, color: { type: "string" },
  font_family: { type: "string" }, font_size: { type: "string", description: "CSS size with unit, e.g. '48px'" },
  image_url: { type: "string" }, background: { type: "string" },
  html: { type: "string", description: "SVG content for shape layers" },
  hide: { type: "boolean" },
};

// `pages` mirrors the shape returned by get_template_pages, so a page read from
// that tool can be edited and sent straight back.
const pagesSchema = {
  type: "array",
  description:
    "Pages for multi-page or multi-size templates (e.g. Instagram square, story and X landscape in ONE template, each with its own width/height). " +
    "Use this INSTEAD of top-level 'layers'. Each page: 'page' (unique name), optional 'width'/'height' (fall back to the template size), " +
    "and 'layers' as an OBJECT keyed by layer name (NOT an array). Same shape as get_template_pages returns.",
  items: {
    type: "object",
    properties: {
      page: { type: "string", description: "Unique page name (e.g. 'Insta Story', 'X Landscape')" },
      width: { type: "number", description: "Page width in pixels (defaults to template width)" },
      height: { type: "number", description: "Page height in pixels (defaults to template height)" },
      hide: { type: "boolean", description: "On update_template, true REMOVES the page from the template" },
      layers: {
        type: "object",
        description: "Layers keyed by layer name: { \"title\": { \"type\": \"text\", \"text\": \"Hi\", ... } }",
        additionalProperties: { type: "object", properties: pageLayerProperties, required: ["type"] },
      },
    },
    required: ["page", "layers"],
  },
};

export const tools: Tool[] = [
  // ---------------------------------------------------------------------------
  // RENDER TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "create_render",
    description: "Create a render (image, video, or PDF) from a template. This is the main tool for generating content. Supports formats: jpg, png, webp, pdf, mp4.",
    annotations: {
      title: "Create Render",
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
      title: "Get Render",
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
      title: "List Renders",
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
      title: "Delete Render",
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
      title: "Merge Renders into PDF",
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
      title: "List Templates",
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
      title: "Get Template",
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
      title: "Get Template Layers",
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
      title: "Get Template Pages",
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
    description: "Create a new template programmatically with layers. IMPORTANT: Each layer must have a 'layer' field (unique identifier/name), not 'name'. Valid layer types are: 'text', 'image', 'shape', 'rating'. Use 'shape' for rectangles, circles, and other shapes - shapes require an 'html' field with SVG content. For a multi-page or multi-size template (several sizes in one template), pass 'pages' instead of 'layers': each page carries its own width/height and its layers as an object keyed by layer name.",
    annotations: {
      title: "Create Template",
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
        pages: pagesSchema,
      },
      required: ["name", "width", "height"],
    },
  },
  {
    name: "update_template",
    description: "Update an existing template. IMPORTANT: Each layer must have a 'layer' field (unique identifier), not 'name'. Valid types: 'text', 'image', 'shape', 'rating'. For multi-page templates use 'pages': a page name that does not exist yet is ADDED to the template, an existing one has its layers merged (or replaced with replaceLayers). To change page sizes on a multi-size template set width/height per page inside 'pages'; top-level width/height are rejected there because they would resize every page.",
    annotations: {
      title: "Update Template",
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
          description: "New width in pixels. Applies to every page; rejected on multi-size templates (use per-page width inside 'pages')",
        },
        height: {
          type: "number",
          description: "New height in pixels. Applies to every page; rejected on multi-size templates (use per-page height inside 'pages')",
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
        pages: pagesSchema,
      },
      required: ["template_id"],
    },
  },
  {
    name: "clone_template",
    description: "Create a copy of an existing template",
    annotations: {
      title: "Clone Template",
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
      title: "Delete Template",
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
      title: "List Renders from Template",
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
      title: "List Folders",
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
      title: "Create Folder",
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
      title: "Update Folder",
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
      title: "Delete Folder",
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
      title: "List Uploads",
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
      title: "Upload Image from URL",
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
      title: "Delete Upload",
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
      title: "List Fonts",
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
      title: "Upload Font",
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
      title: "Delete Font",
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
      title: "Get Account Info",
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

export async function handleToolCall(
  ctx: RequestContext,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    // RENDER HANDLERS
    case "create_render": {
      await validateTemplateInFolder(ctx, args.template as string);
      await validateTemplateByExternalId(ctx, args.template as string);
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
      return apiRequest(ctx, "POST", "/v1/render", body);
    }

    case "get_render":
      return apiRequest(ctx, "GET", `/v1/render/${args.render_id}`);

    case "list_renders": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      const folderId = ctx.folderId;
      const externalId = ctx.externalId;
      if (externalId) params.externalId = externalId;
      const rendersPath = folderId ? `/v1/folder/${folderId}/renders` : "/v1/renders";
      return apiRequest(ctx, "GET", rendersPath, undefined, params);
    }

    case "delete_render":
      return apiRequest(ctx, "DELETE", `/v1/render/${args.render_id}`);

    case "merge_renders":
      return apiRequest(ctx, "POST", "/v1/renders/merge", {
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
      const folderId = ctx.folderId;
      const externalId = ctx.externalId;
      if (externalId) params.externalId = externalId;
      const templatesPath = folderId ? `/v1/folder/${folderId}/templates` : "/v1/templates";
      return apiRequest(ctx, "GET", templatesPath, undefined, params);
    }

    case "get_template":
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      return apiRequest(ctx, "GET", `/v1/template/${args.template_id}`);

    case "get_template_layers":
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      return apiRequest(ctx, "GET", `/v1/template/${args.template_id}/layers`);

    case "get_template_pages":
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      return apiRequest(ctx, "GET", `/v1/template/${args.template_id}/pages`);

    case "create_template": {
      const body: Record<string, unknown> = {
        name: args.name,
        width: args.width,
        height: args.height,
      };
      if (args.background) body.background = args.background;
      if (args.duration) body.duration = args.duration;
      if (args.layers) body.layers = args.layers;
      if (args.pages) body.pages = args.pages;
      const externalId = ctx.externalId;
      if (externalId) body.externalId = externalId;
      const result = await apiRequest(ctx, "POST", "/v1/template", body) as Record<string, unknown>;
      await moveTemplateToFolder(ctx, result.id as string);
      return result;
    }

    case "update_template": {
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      if (args.description) body.description = args.description;
      if (args.width) body.width = args.width;
      if (args.height) body.height = args.height;
      if (args.background) body.background = args.background;
      if (args.duration) body.duration = args.duration;
      if (args.layers) body.layers = args.layers;
      if (args.pages) body.pages = args.pages;
      const params: Record<string, string> = {};
      if (args.replaceLayers) params.replaceLayers = "true";
      return apiRequest(ctx, "PUT", `/v1/template/${args.template_id}`, body, params);
    }

    case "clone_template": {
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      const params: Record<string, string> = {};
      if (args.name) params.name = String(args.name);
      const result = await apiRequest(ctx, "POST", `/v1/template/${args.template_id}/clone`, undefined, params) as Record<string, unknown>;
      await moveTemplateToFolder(ctx, result.id as string);
      // Set externalId on the clone
      const externalId = ctx.externalId;
      if (externalId) {
        await apiRequest(ctx, "PUT", `/v1/template/${result.id}`, { externalId });
      }
      return result;
    }

    case "delete_template":
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      return apiRequest(ctx, "DELETE", `/v1/template/${args.template_id}`);

    case "list_template_renders": {
      await validateTemplateInFolder(ctx, args.template_id as string);
      await validateTemplateByExternalId(ctx, args.template_id as string);
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest(ctx, "GET", `/v1/template/${args.template_id}/renders`, undefined, params);
    }

    // FOLDER HANDLERS
    case "list_folders": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest(ctx, "GET", "/v1/folders", undefined, params);
    }

    case "create_folder":
      return apiRequest(ctx, "POST", "/v1/folder", { name: args.name });

    case "update_folder":
      return apiRequest(ctx, "PUT", `/v1/folder/${args.folder_id}`, { name: args.name });

    case "delete_folder":
      return apiRequest(ctx, "DELETE", `/v1/folder/${args.folder_id}`);

    // UPLOAD HANDLERS
    case "list_uploads": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest(ctx, "GET", "/v1/uploads", undefined, params);
    }

    case "create_upload": {
      const body: Record<string, unknown> = { url: args.url };
      if (args.name) body.name = args.name;
      return apiRequest(ctx, "POST", "/v1/upload", body);
    }

    case "delete_upload":
      return apiRequest(ctx, "DELETE", `/v1/upload/${args.upload_id}`);

    // FONT HANDLERS
    case "list_fonts": {
      const params: Record<string, string> = {};
      if (args.page !== undefined) params.page = String(args.page);
      if (args.limit !== undefined) params.limit = String(args.limit);
      return apiRequest(ctx, "GET", "/v1/fonts", undefined, params);
    }

    case "upload_font":
      return apiRequest(ctx, "POST", "/v1/font", {
        url: args.url,
        name: args.name,
      });

    case "delete_font":
      return apiRequest(ctx, "DELETE", `/v1/font/${args.font_id}`);

    // ACCOUNT HANDLERS
    case "get_account":
      return apiRequest(ctx, "GET", "/v1/account");

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
