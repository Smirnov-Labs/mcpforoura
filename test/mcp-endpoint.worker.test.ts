// test/mcp-endpoint.worker.test.ts
//
// End to end through the Worker's default export: the OAuth provider checks a
// real access token, then /mcp answers as the user the token was issued for.
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { oauthProviderOptions } from "../src/index";

const BASE_URL = env.PUBLIC_BASE_URL;
const MCP_URL = `${BASE_URL}/mcp`;
const REDIRECT_URI = "https://client.example/callback";
const PROTOCOL_VERSION = "2025-06-18";

interface Session {
  token: string;
  sessionId?: string;
}

interface JsonRpcReply {
  id?: number;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// The authorization-code flow with PKCE that an MCP client completes once the
// user has signed in to Oura. The grant's props carry the Oura user ID.
async function issueAccessToken(ouraUserId: string): Promise<string> {
  const helpers = getOAuthApi(oauthProviderOptions(BASE_URL), env);
  const client = await helpers.createClient({
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
  });
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );
  const authorizeUrl = new URL(`${BASE_URL}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp",
    state: "e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  }).toString();
  const request = await helpers.parseAuthRequest(new Request(authorizeUrl));
  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: ouraUserId,
    metadata: {},
    scope: request.scope,
    props: { ouraUserId },
  });

  const res = await exports.default.fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });
  expect(res.status).toBe(200);
  const { access_token } = await res.json<{ access_token: string }>();
  return access_token;
}

function post(session: Session, message: object, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers({
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    ...headers,
  });
  if (session.sessionId) requestHeaders.set("Mcp-Session-Id", session.sessionId);
  return exports.default.fetch(MCP_URL, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(message),
  });
}

// A reply is a JSON body or an SSE stream whose last data line is the reply.
async function readReply(res: Response): Promise<JsonRpcReply> {
  const text = await res.text();
  if (!res.headers.get("Content-Type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text.split("\n").filter((line) => line.startsWith("data: "));
  return JSON.parse(data[data.length - 1].slice("data: ".length));
}

let nextId = 1;

async function rpc(session: Session, method: string, params: object = {}) {
  const res = await post(session, { jsonrpc: "2.0", id: nextId++, method, params });
  expect(res.status).toBe(200);
  return readReply(res);
}

// Initialize the way Claude does: initialize, then notifications/initialized.
async function connect(ouraUserId: string) {
  const session: Session = { token: await issueAccessToken(ouraUserId) };
  const res = await post(session, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-endpoint-test", version: "1.0.0" },
    },
  });
  expect(res.status).toBe(200);
  session.sessionId = res.headers.get("Mcp-Session-Id") ?? undefined;
  const init = await readReply(res);
  const initialized = await post(session, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(initialized.status).toBe(202);
  return { session, init };
}

async function callTool(session: Session, name: string, args: object = {}) {
  const reply = await rpc(session, "tools/call", { name, arguments: args });
  return reply.result as { isError?: boolean; content: { type: string; text: string }[] };
}

describe("/mcp", () => {
  it("asks for a token, naming the protected-resource metadata", async () => {
    const res = await exports.default.fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  it("initializes as mcpforoura with tools", async () => {
    const { init } = await connect("user-a");
    expect(init.result?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.result?.serverInfo).toMatchObject({ name: "mcpforoura" });
    expect(init.result?.capabilities.tools).toBeDefined();
  });

  it("lists all 20 tools with their input schemas", async () => {
    const { session } = await connect("user-a");
    const { result } = await rpc(session, "tools/list");
    const tools = result?.tools as { name: string; inputSchema: any }[];
    expect(tools).toHaveLength(20);
    const summary = tools.find((tool) => tool.name === "get_daily_summary");
    expect(summary?.inputSchema.required).toEqual(["date"]);
    expect(summary?.inputSchema.properties.date.pattern).toBe("^\\d{4}-\\d{2}-\\d{2}$");
  });

  it("runs each tool as the user its token belongs to", async () => {
    const a = await connect("user-a");
    const b = await connect("user-b");
    const pingA = await callTool(a.session, "ping");
    const pingB = await callTool(b.session, "ping");
    expect(JSON.parse(pingA.content[0].text)).toEqual({ ok: true, user_id: "user-a" });
    expect(JSON.parse(pingB.content[0].text)).toEqual({ ok: true, user_id: "user-b" });
  });

  it("returns an Oura failure as a tool error", async () => {
    // No Oura token is stored for this user, so OuraClient asks for re-auth.
    const { session } = await connect("user-without-oura-token");
    const result = await callTool(session, "get_daily_summary", { date: "2026-10-27" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "oura_reauth_required" });
  });

  it("ignores a session ID left over from McpAgent", async () => {
    // Connectors that signed in before the switch still send the session ID
    // McpAgent issued. The stateless handler has no sessions to look it up in.
    const { session } = await connect("user-a");
    const stale = { ...session, sessionId: "7d3e9a0c5b1f4e2a8c6d0b9f1e3a5c7d9b2f4a6c8e0d1b3f5a7c9e2d4b6f8a0c" };
    const ping = await callTool(stale, "ping");
    expect(JSON.parse(ping.content[0].text)).toEqual({ ok: true, user_id: "user-a" });
  });

  it("answers GET and DELETE with 405, as a server without sessions may", async () => {
    const { session } = await connect("user-a");
    for (const method of ["GET", "DELETE"]) {
      const res = await exports.default.fetch(MCP_URL, {
        method,
        headers: { Authorization: `Bearer ${session.token}`, Accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
    }
  });

  it("refuses a browser request from another site", async () => {
    // Server-side clients such as Claude's connectors send no Origin.
    const { session } = await connect("user-a");
    const message = { jsonrpc: "2.0", id: nextId++, method: "tools/list" };
    const res = await post(session, message, { Origin: "https://attacker.example" });
    expect(res.status).toBe(403);
    const local = await post(session, message, { Origin: "http://localhost:6274" });
    expect(local.status).toBe(200);
  });
});
