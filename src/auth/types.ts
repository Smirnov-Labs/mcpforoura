import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export interface AuthProps extends Record<string, unknown> {
  ouraUserId: string;
}

export interface StoredOuraToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  ouraPersonalId: string;
}

export interface OAuthGrantStatePayload {
  flow: "grant";
  oauthReqInfo: AuthRequest;
}

export interface OAuthDeleteStatePayload {
  flow: "delete";
}

export type OAuthStatePayload = OAuthGrantStatePayload | OAuthDeleteStatePayload;
