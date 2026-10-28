import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { DurableObject } from "cloudflare:workers";
import type { AuthProps } from "./auth/types.js";
import { registerOuraTools } from "./mcp/registerTools.js";
import app, { renderMcpHelloPage } from "./oauth-app.js";

// /mcp is stateless: each request gets its own McpServer, built for the Oura
// user in the grant's props. The OAuth provider checks the access token and
// puts those props on ctx before it calls this handler.
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as AuthProps | undefined;
    if (!props?.ouraUserId) {
      throw new Error("Missing authenticated user context");
    }
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "mcpforoura", version: "0.1.1" });
      registerOuraTools(server, env, props);
      return server;
    });
    return handler(request, env, ctx);
  },
};

// Retired: /mcp ran on this McpAgent Durable Object until the stateless
// handler above replaced it. Deleting the class takes a deleted_classes
// migration, and Cloudflare blocks `wrangler rollback` across one, so the
// class stays until prod no longer needs to roll back to McpAgent.
export class OuraMCP extends DurableObject {
  // A session that ended under McpAgent can still have an alarm queued.
  async alarm() {}
}

// Scopes this server understands. Single "mcp" scope covers the bearer
// token issued to MCP clients — they don't need finer-grained access to
// what is already a curated, read-only tool surface.
const MCP_SCOPES = ["mcp"];

// baseUrl is env.PUBLIC_BASE_URL, so staging advertises itself, not prod.
// Tests pass these options to getOAuthApi to issue access tokens.
export function oauthProviderOptions(baseUrl: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: app,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",

    // Advertise the scopes we accept; clients see this via the
    // /.well-known/oauth-authorization-server document.
    scopesSupported: MCP_SCOPES,
    // Scopes every /mcp call needs: published as the protected-resource
    // metadata's scopes_supported and named in the 401 challenge.
    requiredScopes: MCP_SCOPES,

    // The provider defaults to 30-day grants and 90-day client registrations.
    // Grants and clients issued before the 1.x upgrade never expire; keep
    // that, rather than making every user sign in to Oura again each month.
    refreshTokenTTL: undefined,
    clientRegistrationTTL: undefined,

    // RFC 9728 protected-resource metadata, exposed at
    // /.well-known/oauth-protected-resource/mcp. Explicit values so the
    // response is stable across hosts. Every grant is bound to `resource`
    // (https://mcp-oura.smirnov.link/mcp in prod), so changing it signs
    // existing users out.
    resourceMetadata: {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
    },
  };
}

// Built on the first request, once env is available.
let oauthProvider: OAuthProvider<Env> | undefined;

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
    oauthProvider ??= new OAuthProvider(oauthProviderOptions(env.PUBLIC_BASE_URL));
    return oauthProvider.fetch(request, env, ctx);
  },
};
