import type { RequestContext } from "./context.js";
import { loadConfig } from "./config.js";

export const API_BASE_URL = loadConfig().apiBaseUrl;

export async function apiRequest(
  ctx: RequestContext,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>
): Promise<unknown> {
  if (!ctx.apiKey) {
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
      "Authorization": `Bearer ${ctx.apiKey}`,
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

  const text = await response.text();
  if (!text) {
    return { success: true };
  }
  return JSON.parse(text);
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
