// src/storage/cache.ts

import { CACHE_HKDF_INFO, decrypt, deriveKey, encrypt, sha256HexTruncated } from "../crypto.js";

export interface CacheKey {
  userId: string;
  path: string;
  query?: Record<string, string>;
}

export interface CacheSetOptions {
  ttlSeconds: number;
}

const HASH_LEN = 16;
const PERSONAL_INFO_PATH = "/usercollection/personal_info";
const HEARTRATE_PATH = "/usercollection/heartrate";

function canonicalJson(query?: Record<string, string>): string {
  if (!query) return "{}";
  const keys = Object.keys(query).sort();
  const sorted: Record<string, string> = {};
  for (const k of keys) sorted[k] = query[k];
  return JSON.stringify(sorted);
}

async function paramsHash(query?: Record<string, string>): Promise<string> {
  return sha256HexTruncated(canonicalJson(query), HASH_LEN);
}

async function buildKey(key: CacheKey): Promise<string> {
  const safePath = key.path.replace(/^\//, "").replace(/\//g, ":");
  const hash = await paramsHash(key.query);
  return `cache:${key.userId}:${safePath}:${hash}`;
}

export function selectTTLSeconds(
  path: string,
  query?: Record<string, string>,
  now: Date = new Date()
): number {
  if (path === PERSONAL_INFO_PATH) return 24 * 3600;
  if (path === HEARTRATE_PATH) return 30 * 60;

  const endDate = query?.end_date;
  if (!endDate) return 24 * 3600;

  const today = now.toISOString().slice(0, 10);
  const yesterdayDate = new Date(now);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  // Lexicographic order is chronological for fixed-length ISO dates (YYYY-MM-DD).
  if (endDate >= today) return 5 * 60;
  if (endDate === yesterday) return 60 * 60;
  return 24 * 3600;
}

export async function getCached<T>(
  kv: KVNamespace,
  encryptionSecret: string,
  key: CacheKey
): Promise<T | null> {
  const k = await buildKey(key);
  const raw = await kv.get(k);
  if (!raw) return null;
  try {
    const cryptoKey = await deriveKey(key.userId, encryptionSecret, CACHE_HKDF_INFO);
    const plaintext = await decrypt(raw, cryptoKey);
    return JSON.parse(plaintext) as T;
  } catch {
    // Either ciphertext is corrupt OR it's a legacy plaintext entry. Either
    // way, evict so the caller does a fresh fetch.
    try {
      await kv.delete(k);
    } catch {
      // best-effort
    }
    return null;
  }
}

export async function setCached<T>(
  kv: KVNamespace,
  encryptionSecret: string,
  key: CacheKey,
  value: T,
  opts: CacheSetOptions
): Promise<void> {
  const k = await buildKey(key);
  try {
    const cryptoKey = await deriveKey(key.userId, encryptionSecret, CACHE_HKDF_INFO);
    const ciphertext = await encrypt(JSON.stringify(value), cryptoKey);
    await kv.put(k, ciphertext, { expirationTtl: opts.ttlSeconds });
  } catch {
    // KV write failed (or encryption failed) — degrade gracefully.
  }
}

/**
 * Deletes every cache entry under cache:{userId}:*. Best-effort — paginates
 * via KV list, deletes each, swallows individual failures.
 */
export async function deleteAllCacheForUser(kv: KVNamespace, userId: string): Promise<number> {
  const prefix = `cache:${userId}:`;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const result: KVNamespaceListResult<unknown> = await kv.list({ prefix, cursor });
    for (const k of result.keys) {
      try {
        await kv.delete(k.name);
        deleted++;
      } catch {
        // best-effort
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return deleted;
}

// Exports for test visibility only.
export const __test = { canonicalJson, paramsHash, buildKey };
