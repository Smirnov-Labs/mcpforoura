import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { bindStateToSession, createOAuthState, validateOAuthState } from "./auth/session.js";
import type { AuthProps, StoredOuraToken } from "./auth/types.js";
import {
  buildOuraAuthorizeUrl,
  deriveOuraUserId,
  exchangeAuthorizationCode,
  fetchPersonalInfo,
} from "./oura/auth.js";
import { saveStoredToken } from "./storage/tokens.js";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

const CSRF_COOKIE = "__Host-OURA_MCP_CSRF";
const APP_NAME = "MCP for Oura";
const INSTALL_GUIDE_URL = "https://github.com/issmirnov/mcpforoura#readme";

function escapeHtml(value: string | undefined) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function encodeState(payload: unknown) {
  return btoa(JSON.stringify(payload));
}

function decodeState<T>(value: string): T {
  return JSON.parse(atob(value)) as T;
}

function createCsrfCookie() {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  };
}

function validateCsrf(request: Request, submittedToken: string | File | null) {
  if (typeof submittedToken !== "string" || !submittedToken) {
    throw new Error("Missing CSRF token");
  }
  const cookieToken = request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  if (!cookieToken || cookieToken !== submittedToken) {
    throw new Error("Invalid CSRF token");
  }
}

function clearCsrfCookie() {
  return `${CSRF_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function renderLayout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1rem 3rem; line-height: 1.5; color: #111; }
      .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; background: #fff; }
      .meta { color: #555; margin: 0.25rem 0; }
      .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; flex-wrap: wrap; }
      button, .link-button { padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #222; cursor: pointer; text-decoration: none; display: inline-block; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; }
      code { background: #f5f5f5; padding: 0.1rem 0.35rem; border-radius: 4px; }
      footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #444; font-size: 0.95rem; }
      a { color: #0b57d0; }
    </style>
  </head>
  <body>
    ${body}
    <footer>
      <p><a href="/privacy">Privacy Policy</a></p>
      <p>Not affiliated with Oura Health Oy. Use at your own risk.</p>
    </footer>
  </body>
</html>`;
}

function redirectOAuthError(request: AuthRequest, error: string, description: string, headers?: HeadersInit) {
  const redirectUrl = new URL(request.redirectUri);
  redirectUrl.searchParams.set("error", error);
  redirectUrl.searchParams.set("error_description", description);
  if (request.state) {
    redirectUrl.searchParams.set("state", request.state);
  }
  return new Response(null, {
    status: 302,
    headers: { ...(headers || {}), Location: redirectUrl.toString() },
  });
}

function renderHomePage(request: Request) {
  const mcpUrl = new URL("/mcp", request.url).toString();
  return renderLayout(
    APP_NAME,
    `<div class="card">
      <p><strong>${escapeHtml(APP_NAME)}</strong></p>
      <h1>Hosted MCP connector for Oura Ring</h1>
      <p>This service connects supported MCP clients to a user's Oura account through OAuth. Read-only.</p>
      <p class="meta"><strong>MCP endpoint:</strong> <code>${escapeHtml(mcpUrl)}</code></p>
      <div class="actions">
        <a class="link-button primary" href="${escapeHtml(INSTALL_GUIDE_URL)}">Setup instructions</a>
        <a class="link-button secondary" href="/privacy">Privacy Policy</a>
      </div>
    </div>`
  );
}

function renderPrivacyPage() {
  return renderLayout(
    `${APP_NAME} Privacy Policy`,
    `<div class="card">
      <h1>Privacy Policy</h1>
      <p>This service stores your Oura OAuth tokens encrypted in Cloudflare KV solely to fulfil MCP tool requests you initiate through your connected client. Oura ring data is fetched on demand and may be cached briefly (up to 24 hours) keyed to your Oura user ID. Tokens are deleted when you revoke this connector. Cloudflare is the only third-party infrastructure used. Contact <a href="mailto:ivan@smirnovlabs.com">ivan@smirnovlabs.com</a>.</p>
    </div>`
  );
}

function renderConsentPage(oauthReqInfo: AuthRequest, clientInfo: ClientInfo, csrfToken: string) {
  const encodedState = encodeState({ oauthReqInfo });
  return renderLayout(
    `${APP_NAME} Authorization`,
    `<div class="card">
      <p><strong>${escapeHtml(APP_NAME)}</strong></p>
      <h1>Authorize MCP client</h1>
      <p>This client is requesting access to your hosted MCP server for Oura.</p>
      <p class="meta"><strong>Client:</strong> ${escapeHtml(clientInfo.clientName || clientInfo.clientId)}</p>
      <p class="meta"><strong>Client ID:</strong> <code>${escapeHtml(clientInfo.clientId)}</code></p>
      <p class="meta"><strong>Redirect URI:</strong> <code>${escapeHtml(oauthReqInfo.redirectUri)}</code></p>
      <p class="meta"><strong>Scopes:</strong> ${escapeHtml(oauthReqInfo.scope.join(", ") || "(none)")}</p>
      <p class="meta">Approving will redirect you to Oura to grant ring-data access. Review the <a href="/privacy">Privacy Policy</a>.</p>
      <form method="post" action="/authorize">
        <input type="hidden" name="state" value="${escapeHtml(encodedState)}" />
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
        <div class="actions">
          <button class="primary" type="submit" name="decision" value="approve">Continue to Oura</button>
          <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
        </div>
      </form>
    </div>`
  );
}

function renderErrorPage(message: string) {
  return renderLayout(
    `${APP_NAME} Error`,
    `<div class="card">
      <h1>Authorization error</h1>
      <p>${escapeHtml(message)}</p>
      <div class="actions"><a class="link-button primary" href="/">Return home</a></div>
    </div>`
  );
}

app.get("/", (c) => c.html(renderHomePage(c.req.raw)));
app.get("/privacy", (c) => c.html(renderPrivacyPage()));

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) {
    return c.text("Unknown OAuth client", 400);
  }
  const { token, setCookie } = createCsrfCookie();
  return new Response(renderConsentPage(oauthReqInfo, clientInfo, token), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
    },
  });
});

app.post("/authorize", async (c) => {
  const formData = await c.req.raw.formData();

  try {
    validateCsrf(c.req.raw, formData.get("csrf_token"));
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid consent request", 400);
  }

  const encodedState = formData.get("state");
  if (typeof encodedState !== "string" || !encodedState) {
    return c.text("Missing authorization request state", 400);
  }

  const { oauthReqInfo } = decodeState<{ oauthReqInfo: AuthRequest }>(encodedState);
  const csrfClearCookie = clearCsrfCookie();

  if (formData.get("decision") !== "approve") {
    return redirectOAuthError(oauthReqInfo, "access_denied", "User denied authorization.", {
      "Set-Cookie": csrfClearCookie,
    });
  }

  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) {
    return c.text("Unknown OAuth client", 400);
  }
  if (!clientInfo.redirectUris.includes(oauthReqInfo.redirectUri)) {
    return c.text("OAuth client redirect URI is not registered", 400);
  }

  const { stateToken } = await createOAuthState({ flow: "grant", oauthReqInfo }, c.env.OAUTH_KV);
  const { setCookie } = await bindStateToSession(stateToken);

  const headers = new Headers();
  headers.append("Set-Cookie", csrfClearCookie);
  headers.append("Set-Cookie", setCookie);
  headers.set("Location", buildOuraAuthorizeUrl(c.env, stateToken));

  return new Response(null, { status: 302, headers });
});

app.get("/oura/callback", async (c) => {
  let oauthReqInfo: AuthRequest | undefined;
  let clearCookie: string;

  try {
    const validated = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    if (validated.payload.flow !== "grant") {
      return c.html(renderErrorPage("Unsupported callback flow."), 400);
    }
    oauthReqInfo = validated.payload.oauthReqInfo;
    clearCookie = validated.clearCookie;
  } catch (error) {
    return c.html(
      renderErrorPage(error instanceof Error ? error.message : "Invalid OAuth callback"),
      400
    );
  }

  const code = c.req.query("code");
  const oauthError = c.req.query("error");
  const oauthErrorDescription = c.req.query("error_description");

  if (oauthError) {
    return redirectOAuthError(
      oauthReqInfo,
      oauthError,
      oauthErrorDescription || "Upstream Oura authorization failed.",
      { "Set-Cookie": clearCookie }
    );
  }

  if (!code) {
    return redirectOAuthError(oauthReqInfo, "invalid_request", "Missing Oura authorization code.", {
      "Set-Cookie": clearCookie,
    });
  }

  try {
    const tokenWithoutId = await exchangeAuthorizationCode(c.env, code);
    const personalInfo = await fetchPersonalInfo(tokenWithoutId.accessToken);
    const ouraUserId = await deriveOuraUserId(personalInfo.id);

    const storedToken: StoredOuraToken = {
      ...tokenWithoutId,
      ouraPersonalId: personalInfo.id,
    };

    await saveStoredToken(c.env.OURA_TOKENS, c.env.ENCRYPTION_SECRET, ouraUserId, storedToken);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: ouraUserId,
      scope: oauthReqInfo.scope,
      metadata: { label: `Oura ${ouraUserId.slice(0, 8)}` },
      props: { ouraUserId } satisfies AuthProps,
    });

    return new Response(null, {
      status: 302,
      headers: { "Set-Cookie": clearCookie, Location: redirectTo },
    });
  } catch (error) {
    return redirectOAuthError(
      oauthReqInfo,
      "server_error",
      error instanceof Error ? error.message : "Oura OAuth failed",
      { "Set-Cookie": clearCookie }
    );
  }
});

export default app;
