import type { RequestContext } from "./context.js";
import { loadConfig } from "./config.js";
import type { RemoteFile } from "./remote.js";

export const API_BASE_URL = loadConfig().apiBaseUrl;

// Billing and plan state stays out of the model's context: the API phrases
// quota and plan errors as upgrade prompts, which an AI client must not relay.
const BILLING_PATTERN = /upgrade|plan\b|credits?\b|payment|billing|suspend|subscri/i;
const NOT_AVAILABLE =
  "This action is not available on the connected Templated account right now (usage limit reached or feature not enabled). Check the account at app.templated.io.";

export function describeApiError(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      // Spring's default body is { timestamp, status, error, path }; keep only the reason.
      message = String(parsed.message ?? parsed.error ?? body);
    }
  } catch {
    // not JSON, keep the raw text
  }
  if (status === 402 || BILLING_PATTERN.test(message)) {
    message = NOT_AVAILABLE;
  }
  return `API error (${status}): ${message}`;
}

function requireKey(ctx: RequestContext): string {
  if (!ctx.apiKey) {
    throw new Error("API key required. Please provide your Templated API key via ?apiKey= query parameter or Authorization header.");
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

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(describeApiError(response.status, errorText));
  }
  const text = await response.text();
  if (!text) {
    return { success: true };
  }
  return JSON.parse(text);
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
  return readResponse(response);
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
  return readResponse(response);
}

export async function validateTemplateInFolder(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.folderId) return;
  const template = await apiRequest(ctx, "GET", `/v1/template/${templateId}`) as Record<string, unknown>;
  if (template.folderId !== ctx.folderId) {
    throw new Error("Template not found in the configured folder");
  }
}

export async function moveTemplateToFolder(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.folderId) return;
  await apiRequest(ctx, "PUT", `/v1/folder/${ctx.folderId}/template/${templateId}`);
}

export async function validateTemplateByExternalId(ctx: RequestContext, templateId: string): Promise<void> {
  if (!ctx.externalId) return;
  const template = await apiRequest(ctx, "GET", `/v1/template/${templateId}`) as Record<string, unknown>;
  if (template.externalId !== ctx.externalId) {
    throw new Error("Template not found for the configured external ID");
  }
}
