import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AuthProps } from "./auth/types.js";
import { registerOuraTools } from "./mcp/registerTools.js";
import app from "./oauth-app.js";

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

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: OuraMCP.serve("/mcp"),
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
