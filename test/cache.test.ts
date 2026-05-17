// test/cache.test.ts
import { describe, expect, it } from "vitest";
import { __test, selectTTLSeconds, getCached, setCached, type CacheKey } from "../src/storage/cache";

const { canonicalJson, paramsHash, buildKey } = __test;

function fakeKV(): KVNamespace {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, {
        value,
        expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
      });
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe("canonicalJson", () => {
  it("sorts keys alphabetically", () => {
    expect(canonicalJson({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
  });

  it("returns {} for undefined", () => {
    expect(canonicalJson(undefined)).toBe("{}");
  });

  it("yields identical strings for differently-ordered inputs", () => {
    expect(canonicalJson({ end_date: "2026-05-16", start_date: "2026-05-10" })).toBe(
      canonicalJson({ start_date: "2026-05-10", end_date: "2026-05-16" })
    );
  });
});

describe("paramsHash", () => {
  it("returns a 16-char hex string", async () => {
    const h = await paramsHash({ start_date: "2026-05-10", end_date: "2026-05-16" });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across input ordering", async () => {
    const a = await paramsHash({ a: "1", b: "2" });
    const b = await paramsHash({ b: "2", a: "1" });
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await paramsHash({ start_date: "2026-05-01" });
    const b = await paramsHash({ start_date: "2026-05-02" });
    expect(a).not.toBe(b);
  });
});

describe("buildKey", () => {
  it("produces cache:user:path:hash with slashes replaced by colons", async () => {
    const key = await buildKey({
      userId: "abc123",
      path: "/usercollection/daily_sleep",
      query: { start_date: "2026-05-10", end_date: "2026-05-16" },
    });
    expect(key).toMatch(/^cache:abc123:usercollection:daily_sleep:[0-9a-f]{16}$/);
  });
});

describe("selectTTLSeconds", () => {
  const NOW = new Date("2026-05-17T12:00:00Z");

  it("returns 24h for personal_info regardless of query", () => {
    expect(selectTTLSeconds("/usercollection/personal_info", undefined, NOW)).toBe(86400);
  });

  it("returns 30min for heartrate regardless of date", () => {
    expect(
      selectTTLSeconds(
        "/usercollection/heartrate",
        { start_datetime: "2026-05-16T00:00:00Z", end_datetime: "2026-05-17T00:00:00Z" },
        NOW
      )
    ).toBe(1800);
  });

  it("returns 5min when end_date is today UTC", () => {
    expect(
      selectTTLSeconds("/usercollection/daily_sleep", { end_date: "2026-05-17" }, NOW)
    ).toBe(300);
  });

  it("returns 5min when end_date is in the future (user-local today ahead of UTC)", () => {
    expect(
      selectTTLSeconds("/usercollection/daily_sleep", { end_date: "2026-05-18" }, NOW)
    ).toBe(300);
  });

  it("returns 1h when end_date is yesterday UTC", () => {
    expect(
      selectTTLSeconds("/usercollection/daily_sleep", { end_date: "2026-05-16" }, NOW)
    ).toBe(3600);
  });

  it("returns 24h for older dates", () => {
    expect(
      selectTTLSeconds("/usercollection/daily_sleep", { end_date: "2026-05-10" }, NOW)
    ).toBe(86400);
  });

  it("returns 24h when no end_date in query", () => {
    expect(selectTTLSeconds("/usercollection/daily_sleep", undefined, NOW)).toBe(86400);
  });
});

describe("getCached / setCached roundtrip", () => {
  it("stores and retrieves a typed value", async () => {
    const kv = fakeKV();
    const key: CacheKey = { userId: "u1", path: "/x", query: { a: "1" } };
    await setCached(kv, key, { score: 86 }, { ttlSeconds: 3600 });
    const got = await getCached<{ score: number }>(kv, key);
    expect(got).toEqual({ score: 86 });
  });

  it("returns null on miss", async () => {
    const kv = fakeKV();
    const got = await getCached(kv, { userId: "u1", path: "/x" });
    expect(got).toBeNull();
  });

  it("returns null on stored garbage", async () => {
    const kv = fakeKV();
    const key: CacheKey = { userId: "u1", path: "/x" };
    // Sneak in non-JSON via direct put.
    await (kv as unknown as { put: KVNamespace["put"] }).put(
      `cache:u1:x:${await paramsHash(undefined)}`,
      "not json"
    );
    const got = await getCached(kv, key);
    expect(got).toBeNull();
  });

  it("self-heals: getCached purges corrupt entries", async () => {
    const kv = fakeKV();
    const key: CacheKey = { userId: "u1", path: "/x" };
    const builtKey = `cache:u1:x:${await paramsHash(undefined)}`;
    await (kv as unknown as { put: KVNamespace["put"] }).put(builtKey, "not json");
    await getCached(kv, key);
    // After a parse-fail read, the corrupt entry should be deleted.
    const afterPurge = await kv.get(builtKey);
    expect(afterPurge).toBeNull();
  });

  it("setCached swallows KV write failures (graceful degradation)", async () => {
    const failingKv = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("KV temporarily unavailable");
      },
      async delete() {
        // no-op
      },
    } as unknown as KVNamespace;
    const key: CacheKey = { userId: "u1", path: "/x" };
    // Should not throw despite kv.put failing.
    await expect(setCached(failingKv, key, { ok: true }, { ttlSeconds: 60 })).resolves.toBeUndefined();
  });
});
