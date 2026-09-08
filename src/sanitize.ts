// The REST API is shared with direct customers and returns internal ids,
// owner ids and billing state that an AI client never needs. Everything a
// tool hands back to the model goes through these allowlists first.

const TEMPLATE_FIELDS = [
  "id", "name", "description", "width", "height", "thumbnail", "folderId", "folderName",
  "tags", "layersCount", "pagesCount", "multiSizePages", "background", "duration",
  "createdAt", "updatedAt", "layers", "pages",
];
const RENDER_FIELDS = [
  "id", "url", "status", "format", "width", "height", "templateId", "templateName",
  "name", "page", "createdAt",
];
const FOLDER_FIELDS = ["id", "name", "templateCount", "createdAt"];
const UPLOAD_FIELDS = ["id", "name", "size", "contentType", "path", "tags", "createdAt"];
const FONT_FIELDS = ["name", "isGoogleFont", "isUploadedFont", "createdAt"];
const ACCOUNT_FIELDS = ["apiUsage", "apiQuota", "usagePercentage"];
const CONFIRMATION_FIELDS = ["success", "message", "deleted"];
const PAGINATION_FIELDS = ["page", "limit", "total", "totalPages", "hasMore"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function pick(value: unknown, fields: string[]): unknown {
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = value[field];
  }
  return out;
}

// Lists come back either as a bare array or wrapped ({ templates: [...], page, total }).
function collection(value: unknown, listKey: string, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => pick(item, fields));
  if (isObject(value) && Array.isArray(value[listKey])) {
    const items = (value[listKey] as unknown[]).map((item) => pick(item, fields));
    return { ...(pick(value, PAGINATION_FIELDS) as Json), [listKey]: items };
  }
  return pick(value, fields);
}

// create_render and merge_renders answer with { url, download_page_url, renders }
// for multi-page output and with a plain render otherwise.
function renders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => pick(item, RENDER_FIELDS));
  if (isObject(value) && Array.isArray(value.renders)) {
    const out: Json = { renders: (value.renders as unknown[]).map((item) => pick(item, RENDER_FIELDS)) };
    if (value.url !== undefined) out.url = value.url;
    return out;
  }
  return pick(value, RENDER_FIELDS);
}

export function sanitizeToolResult(toolName: string, result: unknown): unknown {
  switch (toolName) {
    case "create_render":
    case "get_render":
    case "list_renders":
    case "list_template_renders":
    case "merge_renders":
      return renders(result);

    case "list_templates":
      return collection(result, "templates", TEMPLATE_FIELDS);
    case "get_template":
    case "create_template":
    case "update_template":
    case "clone_template":
      return pick(result, TEMPLATE_FIELDS);

    case "list_folders":
      return collection(result, "folders", FOLDER_FIELDS);
    case "create_folder":
    case "update_folder":
      return pick(result, FOLDER_FIELDS);

    case "list_uploads":
      return collection(result, "uploads", UPLOAD_FIELDS);
    case "create_upload":
      return pick(result, UPLOAD_FIELDS);

    case "list_fonts":
      return collection(result, "fonts", FONT_FIELDS);
    case "upload_font":
      return pick(result, FONT_FIELDS);

    case "get_account":
      return pick(result, ACCOUNT_FIELDS);

    case "delete_render":
    case "delete_template":
    case "delete_folder":
    case "delete_upload":
    case "delete_font":
      return pick(result, CONFIRMATION_FIELDS);

    default:
      // get_template_layers / get_template_pages are pure design data.
      return result;
  }
}
