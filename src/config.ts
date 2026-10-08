export interface McpConfig {
  apiBaseUrl: string;
  publicUrl: string;
  // Templated web app, linked from the render preview card ("Open in editor").
  appUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    apiBaseUrl: (env.TEMPLATED_API_URL ?? "https://api.templated.io").replace(/\/+$/, ""),
    publicUrl: (env.MCP_PUBLIC_URL ?? "https://mcp.templated.io").replace(/\/+$/, ""),
    appUrl: (env.TEMPLATED_APP_URL ?? "https://app.templated.io").replace(/\/+$/, ""),
  };
}

export function resourceMetadataUrl(cfg: McpConfig): string {
  return `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`;
}
