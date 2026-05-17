import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt, sha256HexTruncated } from "../src/crypto";

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 bytes base64
const USER = "user1234567890abcdef";

describe("encrypt/decrypt roundtrip", () => {
  it("recovers the original plaintext", async () => {
    const key = await deriveKey(USER, SECRET);
    const ct = await encrypt("hello world", key);
    const pt = await decrypt(ct, key);
    expect(pt).toBe("hello world");
  });

  it("produces different ciphertext for repeat encryptions (random IV)", async () => {
    const key = await deriveKey(USER, SECRET);
    const a = await encrypt("same input", key);
    const b = await encrypt("same input", key);
    expect(a).not.toBe(b);
    expect(await decrypt(a, key)).toBe("same input");
    expect(await decrypt(b, key)).toBe("same input");
  });

  it("fails to decrypt with the wrong user-derived key", async () => {
    const keyA = await deriveKey("user-a", SECRET);
    const keyB = await deriveKey("user-b", SECRET);
    const ct = await encrypt("secret-data", keyA);
    await expect(decrypt(ct, keyB)).rejects.toBeDefined();
  });

  it("fails to decrypt with the wrong base secret", async () => {
    const keyA = await deriveKey(USER, SECRET);
    const keyB = await deriveKey(USER, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=");
    const ct = await encrypt("secret-data", keyA);
    await expect(decrypt(ct, keyB)).rejects.toBeDefined();
  });

  it("handles unicode and long payloads", async () => {
    const key = await deriveKey(USER, SECRET);
    const big = "🔐".repeat(1000) + JSON.stringify({ deep: { nested: "object" } });
    const ct = await encrypt(big, key);
    expect(await decrypt(ct, key)).toBe(big);
  });
});

describe("sha256HexTruncated", () => {
  it("returns the requested length", async () => {
    expect((await sha256HexTruncated("input", 16)).length).toBe(16);
    expect((await sha256HexTruncated("input", 32)).length).toBe(32);
  });

  it("is stable", async () => {
    expect(await sha256HexTruncated("abc", 16)).toBe(await sha256HexTruncated("abc", 16));
  });
});
