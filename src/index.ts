import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AuthProps } from "./auth/types.js";
import { registerOuraTools } from "./mcp/registerTools.js";
import app, { renderMcpHelloPage } from "./oauth-app.js";

export class OuraMCP extends McpAgent<Env, Record<string, never>, AuthProps> {
  server = new McpServer({
    name: "mcpforoura",
    version: "0.1.0",
  });

  async init() {
    if (!this.props) {
      throw new Error("Missing authenticated user context");
    }
    registerOuraTools(this.server, this.env, this.props);
  }
}

// Scopes this server understands. Single "mcp" scope covers the bearer
// token issued to MCP clients — they don't need finer-grained access to
// what is already a curated, read-only tool surface.
const MCP_SCOPES = ["mcp"];

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: OuraMCP.serve("/mcp"),
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  // OAuth 2.1 hardening: refuse the legacy implicit flow and refuse the
  // "plain" PKCE method (S256 only).
  allowImplicitFlow: false,
  allowPlainPKCE: false,

  // Advertise the scopes we accept; clients see this via the
  // /.well-known/oauth-authorization-server document.
  scopesSupported: MCP_SCOPES,

  // RFC 9728 protected-resource metadata, exposed at
  // /.well-known/oauth-protected-resource. Explicit values so the
  // response is stable across hosts.
  resourceMetadata: {
    resource: "https://mcp-oura.smirnov.link/mcp",
    authorization_servers: ["https://mcp-oura.smirnov.link"],
    scopes_supported: MCP_SCOPES,
  },
});

// Wrap the OAuthProvider so we can intercept real browser GETs to /mcp and
// serve a friendly "this is an MCP endpoint" page instead of a JSON 401.
// Real MCP clients send Accept: application/json or text/event-stream (or
// omit Accept entirely); they are unaffected and still hit the provider.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/mcp") {
      const accept = request.headers.get("Accept") ?? "";
      const wantsHtml = accept.includes("text/html");
      const wantsMcp = accept.includes("application/json") || accept.includes("text/event-stream");
      if (wantsHtml && !wantsMcp) {
        return renderMcpHelloPage(url);
      }
    }
    return oauthProvider.fetch(request, env, ctx);
  },
};
