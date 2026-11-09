import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "./context.js";
import {
  apiRequest, apiUpload, validateTemplateInFolder, moveTemplateToFolder, validateTemplateByExternalId,
  ApiError, ErrorTarget, FileResponse, InputError,
} from "./api.js";
import { fetchRemoteFile } from "./remote.js";
import { sanitizeToolResult } from "./sanitize.js";
import { CREATE_RENDER_META, GET_RENDER_META, RENDER_CARD_OUTPUT_SCHEMA } from "./ui.js";

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// merge_renders with host=false returns the PDF inline as base64. Tool results
// over about 150k characters fail on claude.ai, and 100 KB of PDF is about 137k.
export const MAX_INLINE_PDF_BYTES = 100 * 1024;

const pageParam = {
  type: "number",
  minimum: 0,
  description: "Page number, starting at 0 (default: 0)",
};
const limitParam = {
  type: "number",
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Results per page (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
};

// Layer properties accepted inside a page of the `pages` array. Unlike the
// top-level `layers` array, a page's `layers` is an object keyed by layer name,
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
    "Pages for a multi-page or multi-size template (for example an Instagram square, a story and an X landscape version in one template, each with its own width and height). " +
    "Used in place of top-level 'layers'. Each page has 'page' (a unique name), optional 'width'/'height' (default: the template size), " +
    "and 'layers' as an object keyed by layer name, the same shape get_template_pages returns.",
  items: {
    type: "object",
    properties: {
      page: { type: "string", description: "Unique page name (e.g. 'Insta Story', 'X Landscape')" },
      width: { type: "number", description: "Page width in pixels (defaults to template width)" },
      height: { type: "number", description: "Page height in pixels (defaults to template height)" },
      hide: { type: "boolean", description: "On update_template, true deletes the page from the template" },
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
    description:
      "Render a Templated template into an image (JPG, PNG or WebP), a PDF or an MP4 video, with new text, images and colors in its layers. " +
      "Use this when the user wants a finished design from one of their templates, such as a social media post, banner, OG image, certificate or invoice. " +
      "Templated fills the saved template with the exact values given: this is template rendering, not AI image generation. " +
      "Pass the template ID and 'layers' keyed by the layer names from get_template_layers; names the template doesn't have are rejected before anything is rendered. " +
      "Multi-page templates render every page, or only the pages listed in 'pages'. Each output counts toward the account's render usage. " +
      "Returns the render with its file URL (one render per page for multi-page templates).",
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
          description: "The template ID to render (from list_templates)",
        },
        format: {
          type: "string",
          enum: ["jpg", "png", "webp", "pdf", "mp4"],
          description: "Output format. Default: jpg",
        },
        layers: {
          type: "object",
          description:
            "Layer values keyed by layer name, e.g. { \"title\": { \"text\": \"Hello\" }, \"photo\": { \"image_url\": \"https://...\" } }. " +
            "Each value can set text, image_url, color, background, hide and other layer properties. " +
            "'animation' (MP4 only) takes 'in' (entrance: type slide|fade|zoom|rotate, direction, duration, writingStyle), 'loop' (type spin|pulse, duration), " +
            "'out' (exit: type slide|fade|zoom, direction, duration), 'start' and 'end' (when the layer appears and disappears). All animation times are in milliseconds.",
          additionalProperties: {
            type: "object",
          },
        },
        pages: {
          type: "array",
          description:
            "For multi-page templates: the pages to render, each with its own layer values. Each item has 'page' (a page name from get_template_pages) " +
            "and 'layers' keyed by layer name, like the top-level 'layers'. Only the listed pages are rendered. Use either 'layers' or 'pages' in one call.",
          items: {
            type: "object",
            properties: {
              page: { type: "string", description: "Page name, as returned by get_template_pages" },
              layers: { type: "object", description: "Layer values for this page, keyed by layer name", additionalProperties: { type: "object" } },
            },
            required: ["page"],
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
    outputSchema: RENDER_CARD_OUTPUT_SCHEMA,
    _meta: CREATE_RENDER_META,
  },
  {
    name: "get_render",
    description:
      "Get one render by ID with its status, format, size and file URL. " +
      "Use this to check whether a render has finished or to find its URL again.",
    annotations: {
      title: "Get Render",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
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
    outputSchema: RENDER_CARD_OUTPUT_SCHEMA,
    _meta: GET_RENDER_META,
  },
  {
    name: "list_renders",
    description:
      `List the renders in the connected Templated account, newest first, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}). ` +
      "Use this to find a render's ID or file URL, for example to merge PDFs with merge_renders. " +
      "Returns each render's id, url, status, format, size and template.",
    annotations: {
      title: "List Renders",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: pageParam,
        limit: limitParam,
      },
    },
  },
  {
    name: "delete_render",
    description:
      "Permanently delete a render from the connected Templated account; it can't be restored. " +
      "Use this when the user asks to remove a render. Takes the render ID from list_renders and returns a confirmation.",
    annotations: {
      title: "Delete Render",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    description:
      "Merge several renders into one PDF, in the order given, for example one certificate or invoice per recipient. Image renders become PDF pages. " +
      "Use this after creating the individual renders. Each merge counts toward the account's render usage. " +
      `Returns the URL of the merged PDF. With host set to false the PDF itself is returned inline instead, which only works for PDFs up to ${MAX_INLINE_PDF_BYTES / 1024} KB.`,
    annotations: {
      title: "Merge Renders into PDF",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        render_ids: {
          type: "array",
          items: { type: "string" },
          description: "Render IDs to merge, in page order",
        },
        host: {
          type: "boolean",
          description: `true (default): return a URL to the merged PDF. false: return the PDF inline as an embedded file, for PDFs up to ${MAX_INLINE_PDF_BYTES / 1024} KB.`,
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
    description:
      `List the templates in the connected Templated account, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}), optionally filtered by name (query), size (width, height) or tags. ` +
      "Use this first to find the template ID for create_render, get_template_layers or update_template. " +
      "Returns each template's id, name, size, thumbnail, folder, and layer and page counts.",
    annotations: {
      title: "List Templates",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to filter templates by name",
        },
        page: pageParam,
        limit: limitParam,
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
          description: "Include each template's layers (a much larger response; get_template_layers reads one template's layers)",
        },
      },
    },
  },
  {
    name: "get_template",
    description:
      "Get one template's details by ID: name, size, background, thumbnail, tags, folder, and layer and page counts. " +
      "Use this to check a template's size or settings; get_template_layers returns its editable layers.",
    annotations: {
      title: "Get Template",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
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
    description:
      "List a template's layers with their names, types and current values (text, image_url, colors, fonts, position and size). " +
      "Use this before create_render: the layer names are the keys create_render accepts in 'layers'. " +
      "Covers every page of a multi-page template; get_template_pages groups the layers by page.",
    annotations: {
      title: "Get Template Layers",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
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
    description:
      "List the pages of a multi-page or multi-size template, each with its name, width, height and layers keyed by layer name. " +
      "Use this to render specific pages with create_render ('pages') or to edit pages with update_template, which accepts the same shape.",
    annotations: {
      title: "Get Template Pages",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
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
    description:
      "Create a new template in the connected Templated account from layers, for example a social media post, banner, OG image, certificate or invoice. " +
      "Use this when none of the existing templates fits or the account has no templates yet. " +
      "Each layer has a unique name in 'layer' and a 'type': text, image, shape or rating. Shape layers draw rectangles, circles and other shapes from SVG content in 'html'. " +
      "For a multi-page or multi-size template (several sizes in one template), pass 'pages' in place of 'layers'. " +
      "Returns the new template; its ID can be rendered right away with create_render.",
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
          description: "Layers of a single-page template. Each layer object has 'layer' (its unique name, later used as the key in create_render) and 'type'.",
          items: {
            type: "object",
            properties: {
              layer: {
                type: "string",
                description: "Unique layer name (e.g., 'title', 'background', 'photo'). The field is called 'layer'; there is no 'name' field.",
              },
              type: {
                type: "string",
                enum: ["text", "image", "shape", "rating"],
                description: "Layer type. Rectangles, circles and other shapes use 'shape' with SVG content in 'html'.",
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
              background: { type: "string", description: "Background color or gradient (shapes can use this or SVG content in html)" },
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
    description:
      "Change an existing template: name, description, size, background, default video duration, layers or pages. " +
      "Use this to edit a design, resize it, or add sizes to a multi-size template. " +
      "Layers are matched by their 'layer' name: an existing layer is updated in place and a new name is added. Top-level 'layers' apply to the first page; 'pages' reaches the others. " +
      "With replaceLayers true, layers missing from the request are deleted. To move a layer, send both x and y (a missing coordinate is set to 0). " +
      "In 'pages', a page name that doesn't exist yet is added and an existing page has its layers updated. " +
      "On a multi-size template, set width and height per page inside 'pages'; top-level width and height are rejected there because they would resize every page. " +
      "Returns the updated template.",
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
          description: "Layer definitions. Each has 'layer' (its unique name) and 'type' (text, image, shape or rating).",
          items: {
            type: "object",
            properties: {
              layer: { type: "string", description: "Unique layer name. The field is called 'layer'; there is no 'name' field." },
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
          description: "true: delete the layers (on the pages being updated) that are missing from the request. false (default): keep them.",
        },
        pages: pagesSchema,
      },
      required: ["template_id"],
    },
  },
  {
    name: "clone_template",
    description:
      "Copy a template, with all its layers and pages, into a new template in the same account. " +
      "Use this to make a variation without changing the original. Returns the copy, which keeps the original's name unless 'name' is given.",
    annotations: {
      title: "Clone Template",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
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
    description:
      "Permanently delete a template from the connected Templated account; it can't be restored or rendered afterwards. " +
      "Renders already created from it are kept. Use this when the user asks to delete a template.",
    annotations: {
      title: "Delete Template",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    description:
      `List the renders created from one template, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}). ` +
      "Use this to find earlier outputs of a template. Returns each render's id, url, status and format.",
    annotations: {
      title: "List Renders from Template",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "The template ID",
        },
        page: pageParam,
        limit: limitParam,
      },
      required: ["template_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // FOLDER TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "list_folders",
    description:
      `List the folders in the connected Templated account with the number of templates in each, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}). ` +
      "Use this to find a folder ID for update_folder or delete_folder. Returns the folders plus total and hasMore.",
    annotations: {
      title: "List Folders",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: pageParam,
        limit: limitParam,
      },
    },
  },
  {
    name: "create_folder",
    description:
      "Create a folder to organize templates in the connected Templated account. " +
      "Use this when the user wants to group templates. Returns the new folder with its ID.",
    annotations: {
      title: "Create Folder",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
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
    description: "Rename a folder. Use this when the user wants to change a folder's name. Returns the updated folder.",
    annotations: {
      title: "Update Folder",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    description:
      "Delete a folder from the connected Templated account. The templates inside it are not deleted: they move out of the folder to the top level of the account. " +
      "Use this when the user asks to remove a folder.",
    annotations: {
      title: "Delete Folder",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    description:
      `List the images uploaded to the connected Templated account, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}). ` +
      "Use this to reuse an uploaded image: its 'path' is a URL that can be set as image_url on an image layer. " +
      "Returns each upload's id, name, type, size and path.",
    annotations: {
      title: "List Uploads",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        page: pageParam,
        limit: limitParam,
      },
    },
  },
  {
    name: "create_upload",
    description:
      "Upload an image (JPG, PNG, WebP or SVG, up to 10 MB) from a public URL to the connected Templated account. " +
      "Use this to keep an image in the account's assets for templates and renders. " +
      "Returns the upload; its 'path' is the URL to use as image_url. API reference: https://templated.io/docs",
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
          description: "Public URL of the image to upload",
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
    description:
      "Permanently delete an uploaded image from the connected Templated account; it can't be restored. " +
      "Use this when the user asks to remove an upload. Takes the upload ID from list_uploads.",
    annotations: {
      title: "Delete Upload",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    description:
      `List the custom fonts uploaded to the connected Templated account, ${DEFAULT_LIMIT} per page by default (max ${MAX_LIMIT}). ` +
      "Templates can also use any Google Font by family name: set include_google_fonts to true to list those too, and query to search by name. " +
      "Use this to choose a font_family for create_template or update_template, or to find the name for delete_font. " +
      "Returns the font names plus total and hasMore.",
    annotations: {
      title: "List Fonts",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Only fonts whose name contains this text (case-insensitive)",
        },
        include_google_fonts: {
          type: "boolean",
          description: "Also list the Google Fonts available to every template (default: false)",
        },
        page: pageParam,
        limit: limitParam,
      },
    },
  },
  {
    name: "upload_font",
    description:
      "Upload a custom font file (TTF, OTF, WOFF or WOFF2) from a public URL to the connected Templated account under the given family name. " +
      "Use this when a design needs a font that isn't a Google Font; templates then use it as font_family. " +
      "Returns the font. API reference: https://templated.io/docs",
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
    description:
      "Permanently delete a custom font from the connected Templated account by family name, including every file uploaded under that name. " +
      "Templates that use it fall back to another font in later renders. Use this when the user asks to remove a font.",
    annotations: {
      title: "Delete Font",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        font_name: {
          type: "string",
          description: "The font family name to delete, as returned by list_fonts",
        },
      },
      required: ["font_name"],
    },
  },

  // ---------------------------------------------------------------------------
  // ACCOUNT TOOLS
  // ---------------------------------------------------------------------------
  {
    name: "get_account",
    description:
      "Get the connected Templated account's render usage for the current period: renders used (apiUsage), renders included (apiQuota) and the percentage used. " +
      "Use this to check how many renders are left before a large batch.",
    annotations: {
      title: "Get Render Usage",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
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

type Args = Record<string, unknown>;

const isObject = (value: unknown): value is Args =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A result that is already MCP content (an embedded file, a message for the model) instead of JSON data.
export class ToolContent {
  constructor(readonly content: CallToolResult["content"]) {}
}

// A brand-new account answers list_templates with nothing, and for 19 of the 41 new ChatGPT users
// who made a tool call (Oct 29 to Nov 9, 2026) that was the only call, with no template designed.
const NO_TEMPLATES_YET = new ToolContent([{
  type: "text",
  text: JSON.stringify({
    templates: [],
    message: "This account has no templates yet. To make what the user asked for, call create_template with a design based on their description, then call create_render with the new template's id.",
  }),
}]);

// Where the model can look up a valid value for an ID parameter.
const ID_HINTS: Record<string, string> = {
  template: "Call list_templates to get template IDs.",
  template_id: "Call list_templates to get template IDs.",
  render_id: "Call list_renders to get render IDs.",
  render_ids: "Call list_renders to get render IDs.",
  folder_id: "Call list_folders to get folder IDs.",
  upload_id: "Call list_uploads to get upload IDs.",
  font_name: "Call list_fonts to get font names.",
};
const hint = (param: string) => (ID_HINTS[param] ? ` ${ID_HINTS[param]}` : "");

function assertRequired(name: string, args: Args): void {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new InputError(`Unknown tool: ${name}.`);
  }
  for (const param of tool.inputSchema.required ?? []) {
    const value = args[param];
    const missing = value === undefined || value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (missing) {
      throw new InputError(`Missing required parameter "${param}".${hint(param)}`);
    }
  }
}

// IDs come from the model and end up in URL paths, where they are percent-encoded
// (enc). "." and ".." are refused: URL parsing resolves them as path segments even
// when encoded, so they could point the request at another endpoint.
function idParam(args: Args, param: string): string {
  const value = args[param];
  const id = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!id || id === "." || id === "..") {
    throw new InputError(`Invalid ${param} ${JSON.stringify(value)}.${hint(param)}`);
  }
  return id;
}
const enc = encodeURIComponent;

// Which item a call is about, so API errors can name it.
function errorTarget(name: string, args: Args): ErrorTarget | undefined {
  const ids = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
  switch (name) {
    case "create_render":
      return { kind: "template", ids: ids(args.template), listTool: "list_templates" };
    case "get_template":
    case "get_template_layers":
    case "get_template_pages":
    case "update_template":
    case "clone_template":
    case "delete_template":
    case "list_template_renders":
      return { kind: "template", ids: ids(args.template_id), listTool: "list_templates" };
    case "get_render":
    case "delete_render":
      return { kind: "render", ids: ids(args.render_id), listTool: "list_renders" };
    case "merge_renders":
      return { kind: "render", ids: ids(args.render_ids), listTool: "list_renders" };
    case "update_folder":
    case "delete_folder":
      return { kind: "folder", ids: ids(args.folder_id), listTool: "list_folders" };
    case "delete_upload":
      return { kind: "upload", ids: ids(args.upload_id), listTool: "list_uploads" };
    case "delete_font":
      return { kind: "font", ids: ids(args.font_name), listTool: "list_fonts" };
    default:
      return undefined;
  }
}

export async function handleToolCall(
  ctx: RequestContext,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<unknown> {
  const input = isObject(args) ? args : {};
  assertRequired(name, input);
  try {
    const result = await executeToolCall(ctx, name, input);
    return result instanceof ToolContent ? result : sanitizeToolResult(name, result);
  } catch (error) {
    if (error instanceof ApiError) throw error.about(errorTarget(name, input));
    throw error;
  }
}

// --- paging -------------------------------------------------------------------

interface Paging { page: number; limit: number }

function paging(args: Args): Paging {
  const page = Math.floor(Number(args.page));
  const limit = Math.floor(Number(args.limit));
  return {
    page: Number.isFinite(page) && page > 0 ? page : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

const pagingParams = ({ page, limit }: Paging): Record<string, string> => ({ page: String(page), limit: String(limit) });

// Some list endpoints ignore page/limit (template search by name or tags) and
// return every match; cut those to the requested page so no list exceeds the limit.
function cutToPage(result: unknown, { page, limit }: Paging): unknown {
  if (!Array.isArray(result) || result.length <= limit) return result;
  return result.slice(page * limit, page * limit + limit);
}

// For endpoints that always return everything (folders, fonts).
function pageLocally(listKey: string, items: unknown[], { page, limit }: Paging) {
  const start = page * limit;
  return { page, limit, total: items.length, hasMore: start + limit < items.length, [listKey]: items.slice(start, start + limit) };
}

// --- create_render layer checks -------------------------------------------------

interface LayerInfo { layer?: string; group?: string | null; locked?: boolean | null }
interface PageInfo { page?: string; layers?: Record<string, LayerInfo> }

const MAX_LISTED_NAMES = 40;

function listNames(names: string[]): string {
  if (names.length === 0) return "none";
  const shown = names.slice(0, MAX_LISTED_NAMES).join(", ");
  return names.length > MAX_LISTED_NAMES ? `${shown} and ${names.length - MAX_LISTED_NAMES} more` : shown;
}

// Keys a render accepts: layer names (locked ones included, the renderer applies
// them) and group names (a group can be hidden as a whole). The error lists the
// unlocked layer names, the same ones get_template_layers shows.
function unknownLayerNames(keys: string[], known: LayerInfo[]): { unknown: string; valid: string } | undefined {
  const accepted = new Set<string>();
  const offered = new Set<string>();
  for (const layer of known) {
    if (layer.layer) {
      accepted.add(layer.layer);
      if (!layer.locked) offered.add(layer.layer);
    }
    if (layer.group) accepted.add(layer.group);
  }
  const unknown = keys.filter((key) => !accepted.has(key));
  if (unknown.length === 0) return undefined;
  const described = unknown.map((key) => {
    const match = [...accepted].find((name) => name.toLowerCase() === key.toLowerCase());
    return match ? `"${key}" (did you mean "${match}"?)` : `"${key}"`;
  });
  return { unknown: described.join(", "), valid: listNames([...offered]) };
}

// Best effort: if the lookup fails, the render request goes ahead and the render
// endpoint reports the problem (it answers a missing template with a clean 404).
async function lookup(ctx: RequestContext, path: string): Promise<unknown> {
  try {
    return await apiRequest(ctx, "GET", path, undefined, { includeLockedLayers: "true" });
  } catch {
    return undefined;
  }
}

// The API applies unknown layer names to nothing and still renders (and charges);
// catching them here turns a silent mismatch into an error that lists the valid names.
async function assertKnownLayers(ctx: RequestContext, templateId: string, args: Args): Promise<void> {
  const layerKeys = isObject(args.layers) ? Object.keys(args.layers) : [];
  const pages = Array.isArray(args.pages) ? args.pages : [];
  if (pages.length > 0 && layerKeys.length > 0) {
    throw new InputError("Pass either layers or pages, not both: when pages is set, each page is rendered with its own layers and top-level layers are ignored.");
  }
  if (pages.length > 0) {
    await assertKnownPages(ctx, templateId, pages);
    return;
  }
  if (layerKeys.length === 0) return;

  const known = await lookup(ctx, `/v1/template/${enc(templateId)}/layers`);
  if (!Array.isArray(known)) return;
  const problem = unknownLayerNames(layerKeys, known as LayerInfo[]);
  if (problem) {
    throw new InputError(
      `Template ${templateId} has no layer named ${problem.unknown}. Nothing was rendered. ` +
      `Valid layer names: ${problem.valid}. Call get_template_layers to see each layer's type and current value.`,
    );
  }
}

async function assertKnownPages(ctx: RequestContext, templateId: string, pages: unknown[]): Promise<void> {
  const known = await lookup(ctx, `/v1/template/${enc(templateId)}/pages`);
  if (!Array.isArray(known) || known.length === 0) return;
  const byName = new Map<string, PageInfo>();
  for (const page of known as PageInfo[]) {
    if (page.page && !byName.has(page.page)) byName.set(page.page, page);
  }

  const problems: string[] = [];
  const requested = pages.map((page) => (isObject(page) ? page : {}));
  const unknownPages = requested.map((page) => String(page.page ?? "")).filter((name) => !byName.has(name));
  if (unknownPages.length > 0) {
    problems.push(
      `Template ${templateId} has no page named ${unknownPages.map((name) => JSON.stringify(name)).join(", ")}. ` +
      `Valid page names: ${listNames([...byName.keys()])}.`,
    );
  }
  for (const page of requested) {
    const target = byName.get(String(page.page ?? ""));
    if (!target || !isObject(page.layers)) continue;
    const known = Object.entries(target.layers ?? {}).map(([name, layer]) => ({ ...layer, layer: name }));
    const problem = unknownLayerNames(Object.keys(page.layers), known);
    if (problem) {
      problems.push(`Page "${page.page}" has no layer named ${problem.unknown}. Valid layer names on that page: ${problem.valid}.`);
    }
  }
  if (problems.length > 0) {
    throw new InputError(`${problems.join(" ")} Nothing was rendered. Call get_template_pages to see each page's layers.`);
  }
}

// --- merge_renders host=false ------------------------------------------------------

const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

function inlineFile(file: FileResponse): ToolContent {
  if (file.bytes.byteLength > MAX_INLINE_PDF_BYTES) {
    throw new InputError(
      `The merged PDF is ${kilobytes(file.bytes.byteLength)}, too large to return inline (limit ${kilobytes(MAX_INLINE_PDF_BYTES)}). ` +
      "Call merge_renders again with host set to true (the default) to get a URL to the file.",
    );
  }
  const filename = /\.pdf$/i.test(file.filename) ? file.filename : "merged_renders.pdf";
  const mimeType = file.contentType === "application/octet-stream" ? "application/pdf" : file.contentType;
  return new ToolContent([
    { type: "text", text: JSON.stringify({ filename, mimeType, size: file.bytes.byteLength }) },
    {
      type: "resource",
      resource: {
        uri: `templated://renders/merged/${enc(filename)}`,
        mimeType,
        blob: Buffer.from(file.bytes).toString("base64"),
      },
    },
  ]);
}

const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];
const FONT_MIME_EXTENSIONS: Record<string, string> = {
  "font/ttf": "ttf", "font/otf": "otf", "font/woff": "woff", "font/woff2": "woff2",
  "application/x-font-ttf": "ttf", "application/x-font-opentype": "otf", "application/font-woff": "woff",
};

async function executeToolCall(
  ctx: RequestContext,
  name: string,
  args: Args
): Promise<unknown> {
  switch (name) {
    // RENDER HANDLERS
    case "create_render": {
      const templateId = idParam(args, "template");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      await assertKnownLayers(ctx, templateId, args);
      const body: Record<string, unknown> = {
        template: templateId,
      };
      if (args.format) body.format = args.format;
      if (args.layers) body.layers = args.layers;
      if (Array.isArray(args.pages) && args.pages.length > 0) body.pages = args.pages;
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
      return apiRequest(ctx, "GET", `/v1/render/${enc(idParam(args, "render_id"))}`);

    case "list_renders": {
      const paged = paging(args);
      const params = pagingParams(paged);
      const folderId = ctx.folderId;
      const externalId = ctx.externalId;
      if (externalId) params.externalId = externalId;
      const rendersPath = folderId ? `/v1/folder/${enc(folderId)}/renders` : "/v1/renders";
      return cutToPage(await apiRequest(ctx, "GET", rendersPath, undefined, params), paged);
    }

    case "delete_render":
      return apiRequest(ctx, "DELETE", `/v1/render/${enc(idParam(args, "render_id"))}`);

    case "merge_renders": {
      const result = await apiRequest(ctx, "POST", "/v1/render/merge", {
        ids: args.render_ids,
        host: args.host !== false,
      });
      return result instanceof FileResponse ? inlineFile(result) : result;
    }

    // TEMPLATE HANDLERS
    case "list_templates": {
      const paged = paging(args);
      const params = pagingParams(paged);
      if (args.query) params.query = String(args.query);
      if (args.width !== undefined) params.width = String(args.width);
      if (args.height !== undefined) params.height = String(args.height);
      if (args.tags) params.tags = String(args.tags);
      if (args.includeLayers) params.includeLayers = "true";
      const folderId = ctx.folderId;
      const externalId = ctx.externalId;
      if (externalId) params.externalId = externalId;
      const templatesPath = folderId ? `/v1/folder/${enc(folderId)}/templates` : "/v1/templates";
      const templates = cutToPage(await apiRequest(ctx, "GET", templatesPath, undefined, params), paged);
      const narrowed = paged.page > 0 || args.query || args.width !== undefined || args.height !== undefined || args.tags || folderId || externalId;
      if (Array.isArray(templates) && templates.length === 0 && !narrowed) return NO_TEMPLATES_YET;
      return templates;
    }

    case "get_template": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      return apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}`);
    }

    case "get_template_layers": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      return apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}/layers`);
    }

    case "get_template_pages": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      return apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}/pages`);
    }

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
      await moveTemplateToFolder(ctx, String(result.id));
      return result;
    }

    case "update_template": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
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
      return apiRequest(ctx, "PUT", `/v1/template/${enc(templateId)}`, body, params);
    }

    case "clone_template": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      const params: Record<string, string> = {};
      if (args.name) params.name = String(args.name);
      const result = await apiRequest(ctx, "POST", `/v1/template/${enc(templateId)}/clone`, undefined, params) as Record<string, unknown>;
      await moveTemplateToFolder(ctx, String(result.id));
      // Set externalId on the clone
      const externalId = ctx.externalId;
      if (externalId) {
        await apiRequest(ctx, "PUT", `/v1/template/${enc(String(result.id))}`, { externalId });
      }
      return result;
    }

    case "delete_template": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      return apiRequest(ctx, "DELETE", `/v1/template/${enc(templateId)}`);
    }

    case "list_template_renders": {
      const templateId = idParam(args, "template_id");
      await validateTemplateInFolder(ctx, templateId);
      await validateTemplateByExternalId(ctx, templateId);
      const paged = paging(args);
      const result = await apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}/renders`, undefined, pagingParams(paged));
      return cutToPage(result, paged);
    }

    // FOLDER HANDLERS
    case "list_folders": {
      // The API returns every folder in one response.
      const folders = await apiRequest(ctx, "GET", "/v1/folders");
      return pageLocally("folders", Array.isArray(folders) ? folders : [], paging(args));
    }

    case "create_folder":
      return apiRequest(ctx, "POST", "/v1/folder", { name: args.name });

    case "update_folder":
      return apiRequest(ctx, "PUT", `/v1/folder/${enc(idParam(args, "folder_id"))}`, { name: args.name });

    case "delete_folder":
      return apiRequest(ctx, "DELETE", `/v1/folder/${enc(idParam(args, "folder_id"))}`);

    // UPLOAD HANDLERS
    case "list_uploads": {
      const paged = paging(args);
      return cutToPage(await apiRequest(ctx, "GET", "/v1/uploads", undefined, pagingParams(paged)), paged);
    }

    case "create_upload": {
      // The API only accepts multipart uploads, so the file is fetched here first.
      const file = await fetchRemoteFile(String(args.url));
      if (args.name) {
        const ext = file.filename.includes(".") ? file.filename.slice(file.filename.lastIndexOf(".")) : "";
        const name = String(args.name);
        file.filename = name.includes(".") ? name : `${name}${ext}`;
      }
      const fields: Record<string, string> = {};
      if (ctx.externalId) fields.externalId = ctx.externalId;
      return apiUpload(ctx, "/v1/upload", file, fields);
    }

    case "delete_upload":
      return apiRequest(ctx, "DELETE", "/v1/uploads", undefined, { ids: String(args.upload_id) });

    // FONT HANDLERS
    case "list_fonts": {
      // The API returns the team's fonts followed by every Google Font (about 350),
      // without paging; filter and page here.
      const all = await apiRequest(ctx, "GET", "/v1/fonts");
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const seen = new Set<string>();
      const fonts = (Array.isArray(all) ? all : []).filter((font) => {
        if (!isObject(font) || typeof font.name !== "string" || seen.has(font.name)) return false;
        if (font.isGoogleFont === true && args.include_google_fonts !== true) return false;
        if (query && !font.name.toLowerCase().includes(query)) return false;
        seen.add(font.name);
        return true;
      });
      return pageLocally("fonts", fonts, paging(args));
    }

    case "upload_font": {
      const file = await fetchRemoteFile(String(args.url));
      // The API derives the family name and the format check from the filename.
      const urlExt = file.filename.includes(".") ? file.filename.slice(file.filename.lastIndexOf(".") + 1).toLowerCase() : "";
      const ext = FONT_EXTENSIONS.includes(urlExt) ? urlExt : FONT_MIME_EXTENSIONS[file.contentType];
      if (!ext) {
        throw new InputError("The URL must point to a TTF, OTF, WOFF or WOFF2 font file");
      }
      file.filename = `${String(args.name).trim() || "font"}.${ext}`;
      return apiUpload(ctx, "/v1/font", file);
    }

    case "delete_font":
      return apiRequest(ctx, "DELETE", "/v1/fonts", undefined, { fonts: String(args.font_name) });

    // ACCOUNT HANDLERS
    case "get_account":
      return apiRequest(ctx, "GET", "/v1/account");

    default:
      throw new InputError(`Unknown tool: ${name}.`);
  }
}
