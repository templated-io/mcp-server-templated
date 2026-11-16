import type { RequestContext } from "./context.js";
import { loadConfig } from "./config.js";
import type { RemoteFile } from "./remote.js";

export const API_BASE_URL = loadConfig().apiBaseUrl;

// The API phrases quota and plan errors as upgrade prompts. Its wording never reaches
// the model. Claude clients get one of the fixed messages below, which name the limit
// and the upgrade page. Every other client gets NOT_AVAILABLE, and that text must stay
// as it is: OpenAI's app rules keep billing and plan state out of the conversation, and
// the tool reference (docs/tools.md) says the limit message does not promote plans.
const BILLING_PATTERN = /upgrade|plan\b|credits?\b|payment|billing|suspend|subscri/i;
const NOT_AVAILABLE =
  "This action is not available on the connected Templated account right now (usage limit reached or feature not enabled). Check the account at app.templated.io.";

const UPGRADE_URL = "https://app.templated.io/upgrade";
const TEMPLATE_LIMIT_REACHED =
  `The connected Templated account has reached the template limit of its current plan. The options are: upgrade the plan at ${UPGRADE_URL}, free a slot by deleting a template that is no longer needed (delete_template), or change an existing template with update_template instead of creating a new one.`;
const CREDITS_USED_UP =
  `The connected Templated account has used all the render credits of its current plan. The plan can be upgraded at ${UPGRADE_URL}. Retrying will not work until the account has render credits again.`;
// Some credits are left, but fewer than this render costs (several pages, or a video).
const NOT_ENOUGH_CREDITS =
  `The connected Templated account does not have enough render credits left on its current plan for this render (get_account shows the usage). The plan can be upgraded at ${UPGRADE_URL}. Retrying the same render will not work until the account has more render credits.`;
const PLAN_RESTRICTION =
  `This action is not available on the current plan of the connected Templated account: a limit of the plan was reached, or the plan does not include this feature. The plan can be upgraded at ${UPGRADE_URL}.`;

// A past-due payment and suspended API access also match BILLING_PATTERN, but an
// upgrade lifts neither, so they keep the neutral message for every client.
const ACCOUNT_STANDING_PATTERN = /past due|suspend/i;

// Claude clients report names such as "Anthropic/ClaudeAI", "claude-code" and "claude-ai";
// their user agents start with "Claude-User" or "claude-code/". A client that is not known
// does not match, so it gets the neutral message.
const isClaudeClient = (clientName: string | undefined) => /^(anthropic|claude)/i.test(clientName ?? "");

// Which limit a billing error is about, going by the API's own wording.
function planLimitMessage(detail: string): string {
  if (/template limit/i.test(detail)) return TEMPLATE_LIMIT_REACHED;
  if (/quota exceeded/i.test(detail)) return CREDITS_USED_UP;
  if (/insufficient credits/i.test(detail)) return NOT_ENOUGH_CREDITS;
  return PLAN_RESTRICTION;
}

// Bodies that only restate the status code give the model nothing to act on.
const GENERIC_DETAILS = new Set([
  "", "bad request", "unauthorized", "not authorized", "forbidden", "not found",
  "internal server error", "an unexpected error occurred",
]);
const MAX_DETAIL_LENGTH = 300;
const MAX_LISTED_IDS = 5;

export type ResourceKind = "template" | "render" | "folder" | "upload" | "font";

// What a failed call was about, so the error can name the item and the tool
// that lists valid ones.
export interface ErrorTarget {
  kind: ResourceKind;
  ids: string[];
  listTool: string;
}

// The model-facing reason in an API error body. Spring's default body is
// { timestamp, status, error, path }; our handlers answer { error: "..." }.
function detailOf(body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      detail = String(parsed.message || parsed.error || "");
    }
  } catch {
    // not JSON, keep the raw text
  }
  return detail.trim().replace(/[.\s]+$/, "").slice(0, MAX_DETAIL_LENGTH);
}

function describeTarget(target: ErrorTarget): string {
  const shown = target.ids.slice(0, MAX_LISTED_IDS).join(", ");
  const more = target.ids.length > MAX_LISTED_IDS ? ` and ${target.ids.length - MAX_LISTED_IDS} more` : "";
  return `${target.kind}${target.ids.length > 1 ? "s" : ""} ${shown}${more}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const idWord = (target: ErrorTarget) => (target.kind === "font" ? "names" : "IDs");

// Turns an API failure into a message that tells the model what to do next.
export function describeApiError(status: number, body: string, target?: ErrorTarget, retryAfter?: string | null, clientName?: string): string {
  const detail = detailOf(body);
  if (status === 402 || BILLING_PATTERN.test(detail)) {
    // The API answers a plan limit with 403. Another status that matches is an error
    // echoing such a word (a template named "Payment plan" sent as the ID), not a limit.
    const planLimit = (status === 402 || status === 403) && !ACCOUNT_STANDING_PATTERN.test(detail);
    return planLimit && isClaudeClient(clientName) ? planLimitMessage(detail) : NOT_AVAILABLE;
  }
  const http = `(HTTP ${status})`;
  const specific = GENERIC_DETAILS.has(detail.toLowerCase()) ? "" : detail;
  const about = target && target.ids.length > 0 ? describeTarget(target) : "";

  if (status === 401 || /api key not valid/i.test(detail)) {
    return `The Templated connection is not authorized ${http}. Reconnect Templated (sign in again, or update the API key) and retry.`;
  }
  if (target && about && (status === 404 || (status === 400 && /not found|no \w+ found/i.test(detail)))) {
    return `${capitalize(about)} not found in the connected Templated account ${http}. Call ${target.listTool} to get valid ${target.kind} ${idWord(target)}.`;
  }
  if (status === 403) {
    if (target && about) {
      return `The connected Templated account does not have access to ${about} ${http}. It may belong to another Templated account: call ${target.listTool} to see the ${target.kind}s this connection can use, or reconnect Templated with the account that owns it.`;
    }
    return `Templated refused this request ${http}${specific ? `: ${specific}.` : "."} Reconnect Templated with an account that has access, then retry.`;
  }
  if (status === 429) {
    const seconds = retryAfter?.trim();
    const wait = seconds && /^\d+$/.test(seconds) ? `${seconds} seconds` : "a few seconds";
    return `Templated is limiting requests right now ${http}${specific ? `: ${specific}.` : "."} Wait ${wait} and retry, running batch calls one at a time.`;
  }
  if (status >= 500) {
    if (target && about) {
      // Some endpoints (template layers and pages, merge) answer a wrong ID with a bare 500.
      return `Templated could not complete the request for ${about} ${http}. Check the ${idWord(target)} with ${target.listTool}; if they are valid, this is a temporary error, so retry in a few seconds. If it keeps failing, contact support@templated.io.`;
    }
    return `Templated had a temporary problem ${http}. Retry in a few seconds; if the same request keeps failing, check its parameters or contact support@templated.io.`;
  }
  if (status === 404) {
    return `Not found ${http}${specific ? `: ${specific}.` : "."} Check the IDs used in this call.`;
  }
  if (specific) {
    return `Templated rejected the request ${http}: ${specific}. Adjust the parameters and retry.`;
  }
  return `Templated rejected the request as invalid ${http}. Check the parameter names, types and values against this tool's input schema and retry.`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter?: string | null,
    target?: ErrorTarget,
    readonly clientName?: string,
  ) {
    super(describeApiError(status, body, target, retryAfter, clientName));
    this.name = "ApiError";
  }

  // Re-describes the error once the caller knows which item the request was about.
  about(target: ErrorTarget | undefined): ApiError {
    return target ? new ApiError(this.status, this.body, this.retryAfter, target, this.clientName) : this;
  }
}

// A problem with the tool arguments, found before (or instead of) calling the API.
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

// A non-JSON success body, such as the PDF that merge_renders returns with host=false.
export class FileResponse {
  constructor(
    readonly bytes: Uint8Array,
    readonly contentType: string,
    readonly filename: string,
  ) {}
}

const FILE_TYPES = new Set(["application/pdf", "application/octet-stream", "application/zip"]);

function filenameOf(contentDisposition: string | null | undefined): string | undefined {
  return contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
}

function requireKey(ctx: RequestContext): string {
  if (!ctx.apiKey) {
    throw new Error("No Templated API key is set for this connection. Reconnect Templated, or set TEMPLATED_API_KEY when running the server locally.");
  }
  return ctx.apiKey;
}

function buildUrl(path: string, queryParams?: Record<string, string>): string {
  let url = `${API_BASE_URL}${path}`;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }
  return url;
}

async function readResponse(ctx: RequestContext, response: Response): Promise<unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(response.status, errorText, response.headers?.get("retry-after"), undefined, ctx.clientName);
  }
  const contentType = response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (FILE_TYPES.has(contentType)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new FileResponse(bytes, contentType, filenameOf(response.headers.get("content-disposition")) ?? "file");
  }
  const text = await response.text();
  if (!text) {
    return { success: true };
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Templated returned an unexpected response (not JSON). Retry in a few seconds; if it keeps happening, contact support@templated.io.");
  }
}

export async function apiRequest(
  ctx: RequestContext,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const apiKey = requireKey(ctx);
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

  const response = await fetch(buildUrl(path, queryParams), options);
  return readResponse(ctx, response);
}

// multipart/form-data upload; fetch sets the boundary header itself.
export async function apiUpload(
  ctx: RequestContext,
  path: string,
  file: RemoteFile,
  fields: Record<string, string> = {}
): Promise<unknown> {
  const apiKey = requireKey(ctx);
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form,
  });
  return readResponse(ctx, response);
}

const enc = encodeURIComponent;

export async function validateTemplateInFolder(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.folderId) return;
  const template = await apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}`) as Record<string, unknown>;
  if (template.folderId !== ctx.folderId) {
    throw new InputError(`Template ${templateId} is not in the folder this connection is limited to. Call list_templates to see the templates available here.`);
  }
}

export async function moveTemplateToFolder(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.folderId) return;
  await apiRequest(ctx, "PUT", `/v1/folder/${enc(ctx.folderId)}/template/${enc(templateId)}`);
}

export async function validateTemplateByExternalId(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.externalId) return;
  const template = await apiRequest(ctx, "GET", `/v1/template/${enc(templateId)}`) as Record<string, unknown>;
  if (template.externalId !== ctx.externalId) {
    throw new InputError(`Template ${templateId} is not available for the external ID this connection is limited to. Call list_templates to see the templates available here.`);
  }
}
