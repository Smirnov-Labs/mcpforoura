# Compliance: Deletion Endpoint + Encrypted Cache

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Close two Oura-agreement-driven gaps surfaced in Codex's review: (1) wire up a real user-data-deletion path; (2) encrypt `OURA_CACHE` entries at rest.

**Tech Stack:** TypeScript, AES-GCM + HKDF (existing `src/crypto.ts`), `@cloudflare/workers-oauth-provider` revoke-grant API, Hono routes, Web Crypto.

Reference: Codex review (PR #9 description) — blockers #1 + #3. Oura API agreement requires deletion-on-request and secure handling of cached data.

---

## Why bundle

Both items are surfaced by the same compliance requirement (Oura API agreement, see also Anthropic connector review). Both touch `src/storage/*`. Bundling minimises churn on `src/oura/client.ts` and keeps the compliance story coherent in one commit log.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/storage/cache.ts` | modify | Encrypt cache values via the same `crypto.deriveKey` / `encrypt` / `decrypt` helpers used for tokens. Plaintext entries decrypt-fail and are evicted (so existing entries self-heal on read). Add `deleteAllForUser(kv, userId)` helper. |
| `src/storage/tokens.ts` | modify | Already has `deleteStoredToken`. No change in shape — just confirm it's exported. |
| `src/oauth-app.ts` | modify | Add `/delete` (GET confirmation page) and `/delete/start` (POST → redirect to Oura re-auth). Extend the existing `/oura/callback` to handle the deletion flow when state payload says `flow: "delete"` (the type already exists in `src/auth/types.ts`). On callback in delete mode: fetch personal_info, derive user_id, delete stored token, delete all cache entries for that user, revoke all OAuth grants the provider issued for that user. |
| `src/auth/session.ts` | modify | Existing state-token helpers already support discriminated payload — confirm `OAuthDeleteStatePayload` round-trips. |
| `src/oura/client.ts` | modify (small) | `OuraClient` now reads encrypted cache entries via the new helper — but the public `request<T>` API is unchanged. Migration is internal to `cache.ts`. |
| `test/cache.test.ts` | modify | Update existing tests to expect encrypted-format storage. Add tests for: (a) plaintext-entry eviction, (b) cross-user isolation, (c) `deleteAllForUser` removes only that user's keys. |
| `test/deletion-flow.test.ts` | create | Tests for the new deletion helpers: token + cache + grant revocation. |

## Invariants

1. **Encrypted cache.** Cache values stored on KV are AES-GCM ciphertext with a per-user HKDF-derived key (same pattern as tokens). Cross-user reads remain impossible even if KV is leaked.
2. **Plaintext entries self-heal.** Existing plaintext entries in `OURA_CACHE` cannot be decrypted — getCached returns null, the caller re-fetches, and setCached overwrites with ciphertext. No manual migration step.
3. **Deletion path is authenticated by re-proving Oura identity.** The user must consent to Oura OAuth one more time during deletion. This:
   - Lets users delete even if they have no current MCP bearer token.
   - Confirms user_id without trusting an arbitrary bearer.
   - Matches YNAB sister project pattern.
4. **Deletion is total.** Stored Oura token + all cache entries for that user + all OAuth grants the provider issued for that user are deleted in one transaction-ish sequence (best-effort; failures logged but other steps continue).

---

## Task 1: Encrypted cache

**Files:** `src/storage/cache.ts`, `test/cache.test.ts`

- [ ] **Step 1: Update `src/storage/cache.ts` to encrypt at rest.**

Add an import for the crypto helpers at the top:

```typescript
import { decrypt, deriveKey, encrypt } from "../crypto.js";
```

Add a parameter `encryptionSecret: string` to both `getCached` and `setCached`. Inside `setCached`, after JSON-stringifying, derive a per-user key and encrypt. Inside `getCached`, decrypt before JSON-parsing. On decrypt failure (likely a plaintext legacy entry or corrupt write), treat as cache miss AND delete the key so it self-heals.

Replace the existing `getCached` and `setCached` functions with:

```typescript
export async function getCached<T>(
  kv: KVNamespace,
  encryptionSecret: string,
  key: CacheKey
): Promise<T | null> {
  const k = await buildKey(key);
  const raw = await kv.get(k);
  if (!raw) return null;
  try {
    const cryptoKey = await deriveKey(key.userId, encryptionSecret);
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
    const cryptoKey = await deriveKey(key.userId, encryptionSecret);
    const ciphertext = await encrypt(JSON.stringify(value), cryptoKey);
    await kv.put(k, ciphertext, { expirationTtl: opts.ttlSeconds });
  } catch {
    // KV write failed (or encryption failed) — degrade gracefully.
  }
}
```

- [ ] **Step 2: Add `deleteAllForUser` helper to `src/storage/cache.ts`.**

Append:

```typescript
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
```

- [ ] **Step 3: Update `src/oura/client.ts` call sites.**

In `OuraClient.request<T>`, both the cache read and write now need `this.env.ENCRYPTION_SECRET`:

```typescript
const cached = await getCached<T>(this.env.OURA_CACHE, this.env.ENCRYPTION_SECRET, cacheKey);
// ...
await setCached(this.env.OURA_CACHE, this.env.ENCRYPTION_SECRET, cacheKey, data, { ttlSeconds });
```

No other changes to client.ts.

- [ ] **Step 4: Update existing `test/cache.test.ts`.**

The signature change ripples into the existing 19 cache tests. Replace each `getCached(kv, key)` / `setCached(kv, key, value, opts)` with the new signatures using a constant test secret (e.g. `const SECRET = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEA=";`).

Then add three new tests in a new `describe("cache encryption + isolation", ...)`:

```typescript
import { decrypt, deriveKey } from "../src/crypto";

describe("cache encryption + isolation", () => {
  it("stored value is ciphertext, not plaintext", async () => {
    const kv = fakeKV();
    const key: CacheKey = { userId: "u1", path: "/x" };
    await setCached(kv, SECRET, key, { score: 86 }, { ttlSeconds: 3600 });
    const raw = await kv.get(`cache:u1:x:${await paramsHash(undefined)}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("86");
    expect(raw).not.toContain("score");
  });

  it("evicts plaintext legacy entries instead of returning them", async () => {
    const kv = fakeKV();
    const key: CacheKey = { userId: "u1", path: "/x" };
    const builtKey = `cache:u1:x:${await paramsHash(undefined)}`;
    await (kv as unknown as { put: KVNamespace["put"] }).put(builtKey, JSON.stringify({ score: 99 }));
    const got = await getCached(kv, SECRET, key);
    expect(got).toBeNull();
    expect(await kv.get(builtKey)).toBeNull(); // evicted
  });

  it("scopes by user — u1 cannot read u2's entry", async () => {
    const kv = fakeKV();
    await setCached(kv, SECRET, { userId: "u1", path: "/x" }, { v: 1 }, { ttlSeconds: 3600 });
    // u2 trying to read at u1's key path returns null (different cache key).
    const got = await getCached(kv, SECRET, { userId: "u2", path: "/x" });
    expect(got).toBeNull();
  });
});
```

Plus one test for `deleteAllCacheForUser`:

```typescript
describe("deleteAllCacheForUser", () => {
  it("removes only the target user's keys", async () => {
    const kv = fakeKV();
    await setCached(kv, SECRET, { userId: "u1", path: "/a" }, { v: 1 }, { ttlSeconds: 3600 });
    await setCached(kv, SECRET, { userId: "u1", path: "/b" }, { v: 2 }, { ttlSeconds: 3600 });
    await setCached(kv, SECRET, { userId: "u2", path: "/a" }, { v: 3 }, { ttlSeconds: 3600 });

    const deleted = await deleteAllCacheForUser(kv, "u1");
    expect(deleted).toBe(2);

    expect(await getCached(kv, SECRET, { userId: "u1", path: "/a" })).toBeNull();
    expect(await getCached(kv, SECRET, { userId: "u1", path: "/b" })).toBeNull();
    expect(await getCached(kv, SECRET, { userId: "u2", path: "/a" })).toEqual({ v: 3 });
  });
});
```

- [ ] **Step 5: Verify + commit.**

```bash
npm run type-check
npm run test:unit  # expect existing 69 + 3 new encryption + 1 new deletion = 73 passing
git add src/storage/cache.ts src/oura/client.ts test/cache.test.ts
git commit -m "cache: encrypt at rest (AES-GCM/HKDF per user) + deleteAllCacheForUser helper"
```

---

## Task 2: Deletion flow

**Files:** `src/oauth-app.ts`, `src/auth/types.ts` (verify), `src/oura/auth.ts` (verify), new `test/deletion-flow.test.ts` (optional — most behaviour is in oauth-app.ts which is end-to-end-tested via deploy).

The `OAuthDeleteStatePayload` type already exists at `src/auth/types.ts:24`. The state-token machinery in `src/auth/session.ts` already handles both flows. The implementation work is in `oauth-app.ts`.

- [ ] **Step 1: Add a `renderDeletePage` function in `src/oauth-app.ts`.**

After `renderConsentPage`, add:

```typescript
function renderDeletePage(csrfToken: string) {
  return renderLayout(
    `${APP_NAME} Delete data`,
    `<div class="card">
      <h1>Delete my data</h1>
      <p>This will remove your stored OAuth tokens and cached Oura responses from ${escapeHtml(APP_NAME)}.</p>
      <p class="meta">To protect against accidental deletion, you'll be redirected to Oura to confirm your identity first. We'll only delete data for the Oura account you sign in with.</p>
      <p class="meta">This does not revoke the Oura OAuth grant on Oura's side — to do that, also visit your Oura account's connected-apps page.</p>
      <form method="post" action="/delete/start">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
        <div class="actions">
          <button class="primary" type="submit">Continue to Oura</button>
          <a class="link-button secondary" href="/">Cancel</a>
        </div>
      </form>
    </div>`
  );
}

function renderDeleteCompletePage(message: string) {
  return renderLayout(
    `${APP_NAME} Delete complete`,
    `<div class="card">
      <h1>Delete complete</h1>
      <p>${escapeHtml(message)}</p>
      <p class="meta">If you added this server to an MCP client, remove the connector there too to stop future authorization requests.</p>
      <div class="actions">
        <a class="link-button primary" href="/">Return home</a>
      </div>
    </div>`
  );
}
```

- [ ] **Step 2: Register `/delete` and `/delete/start` routes.**

Just after the existing `app.get("/tos", ...)` line:

```typescript
app.get("/delete", (c) => {
  const { token, setCookie } = createCsrfCookie();
  return new Response(renderDeletePage(token), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
    },
  });
});

app.post("/delete/start", async (c) => {
  const formData = await c.req.raw.formData();
  try {
    validateCsrf(c.req.raw, formData.get("csrf_token"));
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid delete request", 400);
  }
  const csrfClearCookie = clearCsrfCookie();

  // Mint state for the delete flow and redirect to Oura.
  const { stateToken } = await createOAuthState({ flow: "delete" }, c.env.OAUTH_KV);
  const { setCookie } = await bindStateToSession(stateToken);

  const headers = new Headers();
  headers.append("Set-Cookie", csrfClearCookie);
  headers.append("Set-Cookie", setCookie);
  headers.set("Location", buildOuraAuthorizeUrl(c.env, stateToken));

  return new Response(null, { status: 302, headers });
});
```

- [ ] **Step 3: Extend `/oura/callback` to handle the delete flow.**

Find the existing `app.get("/oura/callback", ...)` handler. The validated state payload is currently typechecked as `flow: "grant"`. Replace the early branch that returns `renderErrorPage("Unsupported callback flow.")` with a real delete-flow branch.

Replace:

```typescript
    if (validated.payload.flow !== "grant") {
      return c.html(renderErrorPage("Unsupported callback flow."), 400);
    }
    oauthReqInfo = validated.payload.oauthReqInfo;
```

with:

```typescript
    const payload = validated.payload;
    clearCookie = validated.clearCookie;
    if (payload.flow === "grant") {
      oauthReqInfo = payload.oauthReqInfo;
    } else if (payload.flow === "delete") {
      // Handled below — code/error checked separately.
    } else {
      return c.html(renderErrorPage("Unsupported callback flow."), 400);
    }
```

Then after the existing `code` / `oauthError` early-out checks (which are flow-agnostic), branch on `payload.flow` for the actual handling. The simplest factoring: keep the existing grant-flow body (exchangeAuthorizationCode → fetchPersonalInfo → deriveOuraUserId → saveStoredToken → completeAuthorization → redirect) inside an `if (payload.flow === "grant")` branch, and add a sibling branch for delete:

```typescript
    if (payload.flow === "delete") {
      const tokenWithoutId = await exchangeAuthorizationCode(c.env, code);
      const personalInfo = await fetchPersonalInfo(tokenWithoutId.accessToken);
      const ouraUserId = await deriveOuraUserId(personalInfo.id);

      let tokenDeleted = false;
      let cacheDeleted = 0;
      let grantsRevoked = 0;

      try {
        await deleteStoredToken(c.env.OURA_TOKENS, ouraUserId);
        tokenDeleted = true;
      } catch { /* best-effort */ }

      try {
        cacheDeleted = await deleteAllCacheForUser(c.env.OURA_CACHE, ouraUserId);
      } catch { /* best-effort */ }

      try {
        let cursor: string | undefined;
        do {
          const grants = await c.env.OAUTH_PROVIDER.listUserGrants(ouraUserId, { cursor });
          for (const g of grants.items) {
            try {
              await c.env.OAUTH_PROVIDER.revokeGrant(g.id, ouraUserId);
              grantsRevoked++;
            } catch { /* best-effort */ }
          }
          cursor = grants.cursor;
        } while (cursor);
      } catch { /* best-effort */ }

      const message = `Token deletion: ${tokenDeleted ? "ok" : "no token on file"}. Cache entries removed: ${cacheDeleted}. OAuth grants revoked: ${grantsRevoked}.`;
      return new Response(renderDeleteCompletePage(message), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": clearCookie },
      });
    }

    // Below: existing grant-flow body unchanged.
```

Don't forget to add the new imports at the top:

```typescript
import { deleteStoredToken } from "./storage/tokens.js";
import { deleteAllCacheForUser } from "./storage/cache.js";
```

- [ ] **Step 4: Add a link to `/delete` from the home page and the privacy page.**

In `renderHomePage`, add to the `.actions` div:

```html
<a class="link-button secondary" href="/delete">Delete my data</a>
```

In `renderPrivacyPage`, near the bottom in the Your Choices section, append a sentence: `You can also delete stored data immediately by visiting <a href="/delete">/delete</a>.`

- [ ] **Step 5: Verify + commit.**

```bash
npm run type-check
# Smoke (after deploy below) — exercise /delete page renders.
git add src/oauth-app.ts
git commit -m "auth: /delete flow — Oura re-auth, then drop token + cache + grants"
```

---

## Task 3: Update privacy page to reflect actual deletion behaviour

**File:** `src/oauth-app.ts`

The current privacy page's "Data Retention" / "Your Choices" sections claim tokens "become unreachable" — vague. Tighten to reflect that the new `/delete` flow exists and what it actually does.

- [ ] **Step 1: Edit `renderPrivacyPage`.**

Replace the "Data Retention" paragraph with:

```html
<h2>Data Retention</h2>
<p>Stored OAuth credentials are retained only as long as needed to keep your connector working. To delete your data immediately, visit <a href="/delete">/delete</a> and confirm with Oura — this removes your stored access/refresh tokens, all cached response entries scoped to your Oura user id, and revokes any OAuth grants this server issued to MCP clients on your behalf. Note that deletion via this site does not revoke Oura's own OAuth grant on Oura's side; revoke that separately from your Oura account's connected-apps page if desired.</p>
```

Bump `PRIVACY_LAST_UPDATED` to today's date (`"2026-05-17"`).

- [ ] **Step 2: Commit.**

```bash
git add src/oauth-app.ts
git commit -m "privacy: document /delete and what it does"
```

---

## Task 4: Verify + deploy + PR

- [ ] **Step 1:** `npm run type-check` — clean.
- [ ] **Step 2:** `npm run test:unit` — expect 73/73 (69 existing + 4 new cache tests). If any prior tests need signature updates, do them in Task 1's commit.
- [ ] **Step 3:** `npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle` — clean.
- [ ] **Step 4:** `npx wrangler deploy` — push to `mcp-oura.smirnov.link`.
- [ ] **Step 5:** Curl smoke:
  - `curl -sS -o /dev/null -w "%{http_code}" https://mcp-oura.smirnov.link/delete` → 200
  - Home page should now include "Delete my data" link.
- [ ] **Step 6:** Push branch, open PR, squash-merge.

---

## Spec coverage

| Codex blocker | Task |
|---|---|
| #1: data-deletion endpoint | Task 2 + Task 3 |
| #3: encrypted cache | Task 1 |

## Anticipated issues

- **Plaintext cache entries on first deploy.** All existing cache entries in `OURA_CACHE` are plaintext (M7 shipped before this change). After deploy, the first read of each entry decrypt-fails and gets evicted; the next request re-fetches from Oura with cached storage. Worst-case: short burst of fresh Oura calls right after deploy. Within KV TTLs (5min–24h) it's all back to normal.
- **`OAuthHelpers.listUserGrants` and `revokeGrant`.** Both are part of the public `@cloudflare/workers-oauth-provider` API and used in the YNAB sister project. No reason to expect issues, but if a grant key shape changed in 0.3.1, errors come through the `try/catch` and the deletion still completes the parts that worked.
- **`/delete` exposed to anyone who can browse.** That's intentional — deletion requires Oura re-auth to scope the deletion to the correct user. An attacker who can OAuth as the user can already access the user's data.
