import type { StoredOuraToken } from "../auth/types.js";
import { decrypt, deriveKey, encrypt } from "../crypto.js";

function tokenKey(userId: string) {
  return `tokens:${userId}`;
}

export async function saveStoredToken(
  kv: KVNamespace,
  encryptionSecret: string,
  userId: string,
  token: StoredOuraToken
): Promise<void> {
  const key = await deriveKey(userId, encryptionSecret);
  const ciphertext = await encrypt(JSON.stringify(token), key);
  await kv.put(tokenKey(userId), ciphertext);
}

export async function loadStoredToken(
  kv: KVNamespace,
  encryptionSecret: string,
  userId: string
): Promise<StoredOuraToken | null> {
  const raw = await kv.get(tokenKey(userId));
  if (!raw) return null;
  const key = await deriveKey(userId, encryptionSecret);
  const plaintext = await decrypt(raw, key);
  return JSON.parse(plaintext) as StoredOuraToken;
}

export async function deleteStoredToken(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(tokenKey(userId));
}
