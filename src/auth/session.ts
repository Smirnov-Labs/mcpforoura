import type { OAuthStatePayload } from "./types.js";

const STATE_COOKIE = "__Host-OURA_MCP_STATE";

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createOAuthState(
  payload: OAuthStatePayload,
  kv: KVNamespace,
  ttlSeconds = 600
) {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
  return { stateToken };
}

export async function bindStateToSession(stateToken: string) {
  const hashHex = await sha256Hex(stateToken);
  return {
    setCookie: `${STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  };
}

export async function validateOAuthState(request: Request, kv: KVNamespace) {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  if (!stateToken) {
    throw new Error("Missing OAuth state");
  }

  const rawPayload = await kv.get(`oauth:state:${stateToken}`);
  if (!rawPayload) {
    throw new Error("Invalid or expired OAuth state");
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const expectedHash = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);
  if (!expectedHash) {
    throw new Error("Missing session binding cookie");
  }

  const actualHash = await sha256Hex(stateToken);
  if (actualHash !== expectedHash) {
    throw new Error("OAuth state does not match this browser session");
  }

  await kv.delete(`oauth:state:${stateToken}`);

  return {
    payload: JSON.parse(rawPayload) as OAuthStatePayload,
    clearCookie: `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
  };
}
