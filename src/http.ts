import http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { contextFromRequest } from "./context.js";
import { createServer } from "./server.js";
import { loadConfig, McpConfig } from "./config.js";
import { extractToken, wwwAuthenticate, TokenValidator } from "./auth.js";
import { protectedResourceMetadata, AuthServerMetadataProxy } from "./wellKnown.js";

export interface HttpServerOptions {
  config?: McpConfig;
  validator?: TokenValidator;
  asMetadataProxy?: AuthServerMetadataProxy;
}

export function createHttpServer(opts: HttpServerOptions = {}): http.Server {
  const cfg = opts.config ?? loadConfig();
  const validator = opts.validator ?? new TokenValidator({ apiBaseUrl: cfg.apiBaseUrl });
  const asProxy = opts.asMetadataProxy ?? new AuthServerMetadataProxy({ apiBaseUrl: cfg.apiBaseUrl });

  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

    // Content Security Policy - required for ChatGPT app submission
    // Specifies that this server only fetches from api.templated.io (plus the
    // configured API host, when overridden away from production).
    const csp = cfg.apiBaseUrl === "https://api.templated.io"
      ? "default-src 'self'; connect-src 'self' https://api.templated.io"
      : `default-src 'self'; connect-src 'self' https://api.templated.io ${new URL(cfg.apiBaseUrl).origin}`;
    res.setHeader("Content-Security-Policy", csp);

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

    // OAuth 2.0 Protected Resource Metadata (RFC 9728)
    // Used by MCP clients to discover the authorization server for this resource.
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(protectedResourceMetadata(cfg)));
      return;
    }

    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // Proxied from the Templated API so MCP clients can discover OAuth endpoints.
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const meta = await asProxy.get();
      res.writeHead(meta.status, { "Content-Type": "application/json" });
      res.end(meta.body);
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
      const token = extractToken(req.headers.authorization, url);
      if (!token) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": wwwAuthenticate(cfg) });
        res.end(JSON.stringify({ error: "invalid_token", error_description: "Authentication required" }));
        return;
      }
      const validation = await validator.validate(token);
      if (validation === "invalid") {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": wwwAuthenticate(cfg, true) });
        res.end(JSON.stringify({ error: "invalid_token", error_description: "Invalid or expired credentials" }));
        return;
      }
      if (validation === "unavailable") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_unavailable", error_description: "Could not validate credentials. Try again shortly." }));
        return;
      }
      const ctx = contextFromRequest(url, token);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createServer(ctx);
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
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

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}
