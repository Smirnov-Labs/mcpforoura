import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCompareToBaseline } from "../src/mcp/tools/compare-to-baseline";
import { shiftDate } from "../src/mcp/tools/dates";
import { OuraClient } from "../src/oura/client";
import { saveStoredToken } from "../src/storage/tokens";
import type { StoredOuraToken } from "../src/auth/types";
import {
  OuraAccountUnavailable,
  OuraEndpointGated,
  OuraReauthRequired,
} from "../src/errors";

const SECRET = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA=";

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

function makeEnv(kv: KVNamespace, cache: KVNamespace): Env {
  return {
    OURA_TOKENS: kv,
    OURA_CACHE: cache,
    ENCRYPTION_SECRET: SECRET,
    OURA_CLIENT_ID: "client-id",
    OURA_CLIENT_SECRET: "client-secret",
  } as unknown as Env;
}

const VALID_TOKEN: StoredOuraToken = {
  accessToken: "good-access",
  refreshToken: "good-refresh",
  expiresAt: Date.now() + 60 * 60 * 1000,
  scope: "daily",
  ouraPersonalId: "p1",
};

const EXPIRING_TOKEN: StoredOuraToken = {
  ...VALID_TOKEN,
  expiresAt: Date.now() + 1000, // < 5min refresh window
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("OuraClient.request — happy path", () => {
  it("returns parsed JSON when Oura returns 200", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ day: "2026-05-16", score: 86 }] }));

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    const result = await client.request<{ data: Array<{ day: string; score: number }> }>(
      "/usercollection/daily_sleep",
      { start_date: "2026-05-16", end_date: "2026-05-16" }
    );
    expect(result.data[0].score).toBe(86);
  });
});

// Oura's API docs don't say whether end_date is inclusive, and endpoints
// differ. This fake leaves the end day out on every path, as daily_activity
// and sleep do.
function ouraWithExclusiveEnd(docsByPath: Record<string, Array<Record<string, unknown>>>) {
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v2/, "");
    const start = url.searchParams.get("start_date") ?? "";
    const end = url.searchParams.get("end_date") ?? "";
    const data = (docsByPath[path] ?? []).filter((doc) => {
      const day = String(doc.day ?? doc.start_day);
      return day >= start && day < end;
    });
    return jsonResponse(200, { data });
  });
}

describe("OuraClient.request — end_date", () => {
  it("asks Oura for end_date + 1 and drops docs past the requested end", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { day: "2026-10-25", steps: 8868, active_calories: 410, total_calories: 2450 },
          { day: "2026-10-26", steps: 4000, active_calories: 200, total_calories: 2100 },
        ],
      })
    );

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    const result = await client.request<{ data: Array<{ day: string; active_calories: number }> }>(
      "/usercollection/daily_activity",
      { start_date: "2026-10-25", end_date: "2026-10-25" }
    );

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("start_date")).toBe("2026-10-25");
    expect(url.searchParams.get("end_date")).toBe("2026-10-26");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].day).toBe("2026-10-25");
    expect(result.data[0].active_calories).toBe(410);
  });

  it("does the same on endpoints that include the end day", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);
    const paths = ["/usercollection/sleep", "/usercollection/daily_sleep", "/usercollection/daily_readiness"];
    for (const _ of paths) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { data: [{ day: "2026-10-27" }, { day: "2026-10-28" }] })
      );
    }

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    for (const path of paths) {
      const result = await client.request<{ data: Array<{ day: string }> }>(path, {
        start_date: "2026-10-27",
        end_date: "2026-10-27",
      });
      expect(result.data.map((doc) => doc.day)).toEqual(["2026-10-27"]);
    }
    const ends = fetchMock.mock.calls.map(([input]) => new URL(input as string).searchParams.get("end_date"));
    expect(ends).toEqual(["2026-10-28", "2026-10-28", "2026-10-28"]);
  });

  it("drops rest-mode periods and enhanced tags that start after the requested end", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { start_day: "2026-10-20", end_day: null },
          { start_day: "2026-10-28", end_day: null },
        ],
      })
    );

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    const result = await client.request<{ data: Array<{ start_day: string }> }>(
      "/usercollection/rest_mode_period",
      { start_date: "2026-10-01", end_date: "2026-10-27" }
    );

    expect(result.data.map((doc) => doc.start_day)).toEqual(["2026-10-20"]);
  });

  it("leaves a request without end_date as it is", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ bpm: 61, timestamp: "2026-10-27T23:30:00+00:00" }] })
    );

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    const result = await client.request<{ data: unknown[] }>("/usercollection/heartrate", {
      start_datetime: "2026-10-27T00:00:00Z",
      end_datetime: "2026-10-28T00:00:00Z",
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.has("end_date")).toBe(false);
    expect(url.searchParams.get("end_datetime")).toBe("2026-10-28T00:00:00Z");
    expect(result.data).toHaveLength(1);
  });

  it("gives compare_to_baseline the requested night when /sleep leaves the end day out", async () => {
    // The reported bug: HRV, resting HR and total sleep for the requested day
    // came back null, while the baseline from the days before it was intact.
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);
    const nights = Array.from({ length: 90 }, (_, i) => ({
      day: shiftDate("2026-10-27", -i),
      type: "long_sleep",
      total_sleep_duration: i === 0 ? 23256 : 25200,
      average_hrv: i === 0 ? 17 : 30,
      lowest_heart_rate: i === 0 ? 64 : 58,
    }));
    ouraWithExclusiveEnd({ "/usercollection/sleep": nights });

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    const hrv = await executeCompareToBaseline(client, { metric: "hrv", date: "2026-10-27" });
    const restingHr = await executeCompareToBaseline(client, { metric: "resting_hr", date: "2026-10-27" });
    const sleepHours = await executeCompareToBaseline(client, { metric: "total_sleep_hours", date: "2026-10-27" });

    expect(hrv.value).toBe(17);
    expect(hrv.p30_mean).toBe(30);
    expect(restingHr.value).toBe(64);
    expect(sleepHours.value).toBe(6.46);
  });
});

describe("OuraClient.request — refresh when token is near expiry", () => {
  it("refreshes via oauth/token before calling the endpoint", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", EXPIRING_TOKEN);

    fetchMock
      // 1st call: refresh
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        })
      )
      // 2nd call: the actual endpoint
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    await client.request("/usercollection/daily_sleep", { start_date: "2026-05-16", end_date: "2026-05-16" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as string).includes("/oauth/token")).toBe(true);
    expect((fetchMock.mock.calls[1][0] as string).includes("/daily_sleep")).toBe(true);
  });

  it("throws OuraReauthRequired when refresh itself fails", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", EXPIRING_TOKEN);

    fetchMock.mockResolvedValueOnce(textResponse(400, "invalid_grant"));

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    await expect(
      client.request("/usercollection/daily_sleep", { start_date: "2026-05-16", end_date: "2026-05-16" })
    ).rejects.toBeInstanceOf(OuraReauthRequired);
  });
});

describe("OuraClient.request — 401 disambiguation", () => {
  it("throws OuraEndpointGated when token works but specific endpoint 401s", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);

    fetchMock
      // 1st call: endpoint 401
      .mockResolvedValueOnce(textResponse(401, "denied"))
      // 2nd call: refresh succeeds
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "x", refresh_token: "y", expires_in: 3600 })
      )
      // 3rd call: endpoint still 401
      .mockResolvedValueOnce(textResponse(401, "denied"))
      // 4th call: personal_info probe succeeds → endpoint is gated
      .mockResolvedValueOnce(jsonResponse(200, { id: "p1" }));

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    await expect(
      client.request("/usercollection/daily_resilience", { start_date: "2026-05-16", end_date: "2026-05-16" })
    ).rejects.toBeInstanceOf(OuraEndpointGated);
  });

  it("throws OuraAccountUnavailable when personal_info also 401s", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);

    fetchMock
      .mockResolvedValueOnce(textResponse(401, "denied"))
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "x", refresh_token: "y", expires_in: 3600 })
      )
      .mockResolvedValueOnce(textResponse(401, "denied"))
      .mockResolvedValueOnce(textResponse(401, "denied")); // personal_info probe also 401

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    await expect(
      client.request("/usercollection/daily_sleep", { start_date: "2026-05-16", end_date: "2026-05-16" })
    ).rejects.toBeInstanceOf(OuraAccountUnavailable);
  });

  it("throws OuraAccountUnavailable when /personal_info itself returns 401 (no probe recursion)", async () => {
    const kv = fakeKV();
    const cache = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", VALID_TOKEN);

    fetchMock
      .mockResolvedValueOnce(textResponse(401, "denied"))
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "x", refresh_token: "y", expires_in: 3600 })
      )
      .mockResolvedValueOnce(textResponse(401, "still-denied"));

    const client = new OuraClient(makeEnv(kv, cache), "u1");
    await expect(client.personalInfo()).rejects.toBeInstanceOf(OuraAccountUnavailable);
  });
});
