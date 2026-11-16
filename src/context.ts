export interface RequestContext {
  apiKey: string;
  folderId: string | null;
  externalId: string | null;
  // Name the MCP client gave at initialize, or its user agent when the handshake is
  // not known. The server sets it per tool call; plan-limit errors are worded by it.
  clientName?: string;
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): RequestContext {
  return {
    apiKey: env.TEMPLATED_API_KEY ?? "",
    folderId: env.TEMPLATED_FOLDER_ID || null,
    externalId: env.TEMPLATED_EXTERNAL_ID || null,
  };
}

export function contextFromRequest(url: URL, apiKey: string): RequestContext {
  return {
    apiKey,
    folderId: url.searchParams.get("folderId") || null,
    externalId: url.searchParams.get("externalId") || null,
  };
}
