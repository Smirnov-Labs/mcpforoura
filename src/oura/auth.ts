import type { StoredOuraToken } from "../auth/types.js";
import { sha256HexTruncated } from "../crypto.js";
import { OURA_SCOPE_STRING } from "./scopes.js";

const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const OURA_API_BASE = "https://api.ouraring.com/v2";

interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface OuraPersonalInfo {
  id: string;
  age?: number;
  weight?: number;
  height?: number;
  biological_sex?: string;
  email?: string;
}

export function buildOuraAuthorizeUrl(env: Env, stateToken: string) {
  const url = new URL(OURA_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.OURA_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OURA_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OURA_SCOPE_STRING);
  url.searchParams.set("state", stateToken);
  return url.toString();
}

async function postTokenRequest(body: URLSearchParams): Promise<OuraTokenResponse> {
  const response = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Oura token exchange failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as OuraTokenResponse;
}

export async function exchangeAuthorizationCode(env: Env, code: string): Promise<Omit<StoredOuraToken, "ouraPersonalId">> {
  const token = await postTokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.OURA_CLIENT_ID,
      client_secret: env.OURA_CLIENT_SECRET,
      code,
      redirect_uri: env.OURA_REDIRECT_URI,
    })
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<Omit<StoredOuraToken, "ouraPersonalId">> {
  const token = await postTokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.OURA_CLIENT_ID,
      client_secret: env.OURA_CLIENT_SECRET,
      refresh_token: refreshToken,
    })
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
}

export async function fetchPersonalInfo(accessToken: string): Promise<OuraPersonalInfo> {
  const response = await fetch(`${OURA_API_BASE}/usercollection/personal_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch personal_info (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as OuraPersonalInfo;
}

export async function deriveOuraUserId(ouraPersonalId: string): Promise<string> {
  return sha256HexTruncated(`oura:${ouraPersonalId}`, 32);
}

export const OURA_ENDPOINTS = {
  authorize: OURA_AUTHORIZE_URL,
  token: OURA_TOKEN_URL,
  apiBase: OURA_API_BASE,
};
