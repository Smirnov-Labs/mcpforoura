import { describe, expect, it } from "vitest";
import { deleteStoredToken, loadStoredToken, saveStoredToken } from "../src/storage/tokens";
import type { StoredOuraToken } from "../src/auth/types";

const SECRET = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=";

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

const TOKEN: StoredOuraToken = {
  accessToken: "access-xyz",
  refreshToken: "refresh-abc",
  expiresAt: 1_800_000_000_000,
  scope: "daily heartrate",
  ouraPersonalId: "ouraperson1",
};

describe("token storage roundtrip", () => {
  it("saves and loads the encrypted token", async () => {
    const kv = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", TOKEN);
    const loaded = await loadStoredToken(kv, SECRET, "u1");
    expect(loaded).toEqual(TOKEN);
  });

  it("returns null when no token is stored", async () => {
    const kv = fakeKV();
    expect(await loadStoredToken(kv, SECRET, "missing")).toBeNull();
  });

  it("stores ciphertext, not plaintext", async () => {
    const kv = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", TOKEN);
    const raw = await kv.get("tokens:u1");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("access-xyz");
    expect(raw).not.toContain("refresh-abc");
  });

  it("scopes by user — cannot decrypt one user's token with another's key", async () => {
    const kv = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", TOKEN);
    // Reach into KV with u1's key but try to decrypt as if for u2:
    const raw = await kv.get("tokens:u1");
    expect(raw).toBeTruthy();
    // Move that ciphertext under tokens:u2 and confirm decryption fails.
    await (kv as unknown as { put: KVNamespace["put"] }).put("tokens:u2", raw!);
    await expect(loadStoredToken(kv, SECRET, "u2")).rejects.toBeDefined();
  });

  it("deleteStoredToken removes the entry", async () => {
    const kv = fakeKV();
    await saveStoredToken(kv, SECRET, "u1", TOKEN);
    await deleteStoredToken(kv, "u1");
    expect(await loadStoredToken(kv, SECRET, "u1")).toBeNull();
  });
});
