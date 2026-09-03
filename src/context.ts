export interface RequestContext {
  apiKey: string;
  folderId: string | null;
  externalId: string | null;
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
