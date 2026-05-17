import type { StoredOuraToken } from "../auth/types.js";
import {
  OuraAccountUnavailable,
  OuraEndpointGated,
  OuraRateLimited,
  OuraReauthRequired,
} from "../errors.js";
import { getCached, selectTTLSeconds, setCached, type CacheKey } from "../storage/cache.js";
import { loadStoredToken, saveStoredToken } from "../storage/tokens.js";
import { refreshAccessToken } from "./auth.js";

const OURA_API_BASE = "https://api.ouraring.com/v2";
const PERSONAL_INFO_PATH = "/usercollection/personal_info";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000];

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface OuraListResponse<T> {
  data: T[];
  next_token?: string | null;
}

export class OuraClient {
  private token: StoredOuraToken | null = null;
  private justRefreshed = false;

  constructor(private readonly env: Env, private readonly userId: string) {}

  private async loadToken(): Promise<StoredOuraToken> {
    if (this.token) return this.token;
    const stored = await loadStoredToken(this.env.OURA_TOKENS, this.env.ENCRYPTION_SECRET, this.userId);
    if (!stored) {
      throw new OuraReauthRequired();
    }
    this.token = stored;
    return stored;
  }

  private async ensureFresh(): Promise<StoredOuraToken> {
    const token = await this.loadToken();
    if (token.expiresAt > Date.now() + REFRESH_WINDOW_MS) {
      return token;
    }
    return this.refresh();
  }

  private async refresh(): Promise<StoredOuraToken> {
    const current = await this.loadToken();
    let refreshed;
    try {
      refreshed = await refreshAccessToken(this.env, current.refreshToken);
    } catch (error) {
      throw new OuraReauthRequired();
    }
    const updated: StoredOuraToken = {
      ...refreshed,
      ouraPersonalId: current.ouraPersonalId,
    };
    await saveStoredToken(this.env.OURA_TOKENS, this.env.ENCRYPTION_SECRET, this.userId, updated);
    this.token = updated;
    this.justRefreshed = true;
    return updated;
  }

  private async rawCall(path: string, query?: Record<string, string>): Promise<Response> {
    const token = await this.loadToken();
    const url = new URL(`${OURA_API_BASE}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    }
    return fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  }

  private async callWithBackoff(path: string, query?: Record<string, string>): Promise<Response> {
    let response = await this.rawCall(path, query);
    for (let i = 0; response.status === 429 && i < RATE_LIMIT_BACKOFF_MS.length; i++) {
      await sleep(RATE_LIMIT_BACKOFF_MS[i]);
      response = await this.rawCall(path, query);
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "60", 10);
      throw new OuraRateLimited(Number.isFinite(retryAfter) ? retryAfter : 60);
    }
    return response;
  }

  async request<T>(path: string, query?: Record<string, string>): Promise<T> {
    const cacheKey: CacheKey = { userId: this.userId, path, query };
    const cached = await getCached<T>(this.env.OURA_CACHE, cacheKey);
    if (cached !== null) return cached;

    await this.ensureFresh();
    let response = await this.callWithBackoff(path, query);

    if (response.status === 401) {
      if (!this.justRefreshed) {
        await this.refresh();
        response = await this.callWithBackoff(path, query);
      }
      if (response.status === 401) {
        await this.disambiguate401(path);
      }
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Oura API ${path} failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as T;
    const ttlSeconds = selectTTLSeconds(path, query);
    await setCached(this.env.OURA_CACHE, cacheKey, data, { ttlSeconds });
    return data;
  }

  async requestSafe<T>(
    path: string,
    query?: Record<string, string>
  ): Promise<
    | { ok: true; data: T }
    | { ok: false; status: number; body: string }
  > {
    try {
      const data = await this.request<T>(path, query);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof Error) {
        const m = err.message.match(/failed \((\d+)\): (.*)$/s);
        if (m) {
          return { ok: false, status: Number.parseInt(m[1], 10), body: m[2] };
        }
      }
      throw err;
    }
  }

  async requestList<T>(path: string, query?: Record<string, string>): Promise<OuraListResponse<T>> {
    return this.request<OuraListResponse<T>>(path, query);
  }

  async collectAll<T>(path: string, query?: Record<string, string>): Promise<T[]> {
    const collected: T[] = [];
    let cursor: string | undefined = undefined;
    do {
      const page: OuraListResponse<T> = await this.requestList<T>(path, {
        ...(query || {}),
        ...(cursor ? { next_token: cursor } : {}),
      });
      collected.push(...page.data);
      cursor = page.next_token || undefined;
    } while (cursor);
    return collected;
  }

  private async disambiguate401(originalPath: string): Promise<never> {
    if (originalPath === PERSONAL_INFO_PATH) {
      throw new OuraAccountUnavailable();
    }
    const probe = await this.rawCall(PERSONAL_INFO_PATH);
    if (probe.ok) {
      throw new OuraEndpointGated(originalPath);
    }
    if (probe.status === 401) {
      throw new OuraAccountUnavailable();
    }
    throw new Error(`Oura personal_info probe returned ${probe.status}`);
  }

  async personalInfo(): Promise<{ id: string; [k: string]: unknown }> {
    return this.request(PERSONAL_INFO_PATH);
  }
}
