# Architecture

How `mcpforoura` is put together. Written for someone who's never seen the codebase and wants to be productive in an hour.

For the file-by-file walkthrough see `CLAUDE.md`. This document is the "why".

## What this is

`mcpforoura` is a hosted, multi-tenant **remote MCP server** for the [Oura Ring](https://ouraring.com) API. It runs on a single Cloudflare Worker, talks Model Context Protocol over streamable HTTP, and lets each authorized user connect *their* Oura account to *any* MCP-compatible AI assistant (Claude, Cursor, etc.). Live at `https://mcp-oura.smirnov.link/mcp`.

It's read-only. It does not write to Oura, does not create transactions, does not make medical interpretations.

## Big picture

```
                 ┌──── Browser / MCP client ────┐
                 │                              │
                 ▼                              ▼
            (humans)                    (Claude, Cursor, etc.)
                 │                              │
                 │ GET /                        │ Bearer-auth'd
                 │ GET /privacy                 │ MCP over HTTPS
                 │ GET /tos                     │ to /mcp
                 │ GET /delete                  │
                 │ GET /mcp w/ Accept: html     │
                 │   ↓                          ↓
            ┌────┴──────────────────────────────┴────────┐
            │     Cloudflare Worker (mcpforoura)         │
            │                                            │
            │  default export wraps OAuthProvider with   │
            │  a fetch shim that intercepts the hello-   │
            │  page request and falls through otherwise. │
            │                                            │
            │  ┌────────────────────────────────────┐    │
            │  │ workers-oauth-provider             │    │
            │  │   /authorize, /token, /register    │    │
            │  │   issues bearer tokens to clients  │    │
            │  │                                    │    │
            │  │   defaultHandler → Hono app:       │    │
            │  │     /                              │    │
            │  │     /privacy /tos                  │    │
            │  │     /delete /delete/start          │    │
            │  │     GET /authorize  (consent UI)   │    │
            │  │     POST /authorize (→ Oura)       │    │
            │  │     /oura/callback (grant+delete)  │    │
            │  │     /.well-known/*                 │    │
            │  │                                    │    │
            │  │   apiRoute /mcp → OuraMCP.serve()  │    │
            │  └─────────────┬──────────────────────┘    │
            │                │                           │
            │                ▼                           │
            │  ┌────────────────────────────────────┐    │
            │  │ OuraMCP (Durable Object)           │    │
            │  │   extends McpAgent                 │    │
            │  │   this.props.ouraUserId            │    │
            │  │   registers 21 tools on init()     │    │
            │  │   each tool → new OuraClient(...)  │    │
            │  └─────────────┬──────────────────────┘    │
            │                │                           │
            │                ▼                           │
            │  ┌────────────────────────────────────┐    │
            │  │ OuraClient                         │    │
            │  │   load+decrypt token from KV       │    │
            │  │   ensureFresh (5-min window)       │    │
            │  │   refresh w/ mutex + KV reload     │    │
            │  │   401 disambig: refresh, probe     │    │
            │  │   429 backoff 1s/2s/4s             │    │
            │  │   read-through encrypted cache     │    │
            │  └─────────────┬──────────────────────┘    │
            │                │                           │
            └────────────────┼───────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  api.ouraring.com    │
                  │  /v2/usercollection  │
                  └──────────────────────┘

  Storage: 3 KV namespaces
    OAUTH_KV     — provider state, dynamic clients, grants, access tokens
                   (managed entirely by workers-oauth-provider)
    OURA_TOKENS  — per-user encrypted Oura access+refresh tokens
                   key: tokens:{ouraUserId}
                   value: AES-GCM(JSON), HKDF info "oura-token-encryption-v1"
    OURA_CACHE   — per-user encrypted Oura response cache
                   key: cache:{ouraUserId}:{path}:{16-hex-sha256-params}
                   value: AES-GCM(JSON), HKDF info "oura-cache-encryption-v1"
                   date-aware TTLs: 5min (today) → 24h (historical)
```

## The two OAuth flows

`mcpforoura` is simultaneously an OAuth **authorization server** (for MCP clients connecting to it) and an OAuth **client** (of Oura). The two flows happen back-to-back during first authorization.

### Flow A — Claude (or another MCP client) ↔ this server

Handled by `@cloudflare/workers-oauth-provider`. Standard OAuth 2.1: dynamic client registration, S256 PKCE, authorization-code grant, refresh-token grant. Plain PKCE and implicit flow are both refused.

**Consent UI** is rendered by our Hono `defaultHandler` (`src/oauth-app.ts:renderConsentPage`) — a server-side HTML form with a CSRF cookie. The state token from the OAuth provider is encoded into a hidden form input. POST `/authorize` validates the CSRF token, then triggers Flow B instead of immediately completing the authorization.

### Flow B — this server ↔ Oura

Hand-rolled. Triggered from POST `/authorize` *after* CSRF validation: we create a state-token payload `{flow: "grant", oauthReqInfo}` in `OAUTH_KV` (TTL'd, browser-bound via a session-cookie hash), then redirect the user to `https://cloud.ouraring.com/oauth/authorize` with our scope list.

On return at `/oura/callback`:

1. Validate state token (`src/auth/session.ts:validateOAuthState`): KV lookup + cookie hash match.
2. Exchange the OAuth code for tokens at `https://api.ouraring.com/oauth/token`.
3. Fetch `/usercollection/personal_info` to learn the Oura user id.
4. Derive a stable internal user id: `sha256("oura:" + ouraPersonalId).slice(0, 32)`.
5. Encrypt and store the tokens at `tokens:{ouraUserId}` in `OURA_TOKENS`.
6. Call `c.env.OAUTH_PROVIDER.completeAuthorization({ ..., userId: ouraUserId, props: { ouraUserId } })` — *this* is what hands an MCP bearer token back to the client and is what makes `this.props.ouraUserId` available inside the McpAgent.

The same callback also handles `flow: "delete"` payloads. See "Deletion" below.

## The McpAgent and per-call OuraClient

Inside the Worker, the OAuth provider's `apiRoute: "/mcp"` routes authenticated MCP traffic to a Durable Object (`OuraMCP extends McpAgent`). The DO's `init()` runs once per session and registers the 21 tools onto an `McpServer` instance. Each registered tool is wrapped by `clientTool(env, props, handler)` — a small adapter that constructs a fresh `OuraClient(env, props.ouraUserId)` per tool invocation, runs the handler, and converts thrown `OuraInvalidInput` / `OuraReauthRequired` / etc. into MCP error content.

A fresh `OuraClient` per tool call means:
- Token cache is per-tool-call (acceptable: KV reads are cheap, ~10ms).
- Concurrent fan-out within one tool call (e.g. `get_morning_briefing` hits 6 endpoints in parallel) shares the same client instance, so the refresh mutex inside `OuraClient` is the right scope.
- Different tools (different MCP method calls) get different `OuraClient` instances, so the refresh mutex doesn't help across them — that's what the "KV reload on failed refresh" fallback covers (see `src/oura/client.ts:doRefresh`).

## Storage layout

| Namespace | Key pattern | Value |
|---|---|---|
| `OAUTH_KV` | (managed by workers-oauth-provider — `client:*`, `grant:*`, `token:*`) | Provider-internal |
| `OAUTH_KV` | `oauth:state:{uuid}` | OAuth flow state payload (TTL ~10 min) |
| `OURA_TOKENS` | `tokens:{ouraUserId}` | AES-GCM ciphertext of `StoredOuraToken` JSON |
| `OURA_CACHE` | `cache:{ouraUserId}:{path-colonized}:{16-hex}` | AES-GCM ciphertext of cached response |

Three namespaces are deliberate: `OAUTH_KV` is owned by the library, `OURA_TOKENS` is highest-sensitivity, `OURA_CACHE` is high-churn. Separating them makes the security/deletion story cleaner and gives us the freedom to rate-limit cache writes without affecting auth state.

## Encryption

Per-user keys derived via HKDF-SHA256 from a single Worker secret (`ENCRYPTION_SECRET`):

```
key(user, purpose) = HKDF(secret = ENCRYPTION_SECRET,
                          salt   = userId,
                          info   = purpose-info-string)
```

Two `purpose-info-string` values are defined in `src/crypto.ts`:

- `oura-token-encryption-v1` (default; used by `src/storage/tokens.ts`).
- `oura-cache-encryption-v1` (used by `src/storage/cache.ts`).

This gives **domain separation** — even though the two KV namespaces use the same underlying secret and same salt, the resulting keys are cryptographically distinct. If an attacker swapped a ciphertext from one namespace into the other, AES-GCM authentication would fail. (The KV namespaces are physically separate anyway, but defense in depth is cheap here.)

`encrypt()` prepends a 12-byte random IV to AES-256-GCM ciphertext and base64-encodes the whole blob. `decrypt()` reverses it. Both live in `src/crypto.ts`.

Rotating `ENCRYPTION_SECRET` would invalidate every stored token (no current rotation flow — users would just re-authenticate). This is an acceptable tradeoff at this scale.

## Refresh-token handling

Oura refresh tokens are **single-use**: each refresh consumes the current one and Oura returns a new pair. This creates two race scenarios that the client mitigates:

1. **In-process race.** A single MCP tool call (`get_morning_briefing`) issues 6 parallel `OuraClient.request()` calls. If the access token is near expiry, every leg calls `ensureFresh()` and would race to refresh — the first wins, the others get `invalid_grant`. The fix in `src/oura/client.ts` is `pendingRefresh: Promise | null` — concurrent callers in the same isolate all await the same in-flight promise.

2. **Cross-isolate race.** Two browser tabs or two MCP method calls from one user can land in different Worker invocations (separate isolates). The in-process mutex doesn't span isolates. So when `refreshAccessToken()` rejects with what looks like `invalid_grant`, `doRefresh()` force-reloads the stored token from KV. If the stored `refreshToken` field has changed since we tried, another invocation already refreshed — use the newer value. Only when the stored value is still the now-burnt one do we throw `OuraReauthRequired`.

## 401 disambiguation

A 401 from Oura's API can mean any of three things: (a) the access token expired and we missed the refresh window, (b) the user's account lost membership / lost access to the specific endpoint, (c) the OAuth grant was revoked. The MCP error we surface should match the underlying cause so the LLM can narrate to the user accurately.

The flow in `OuraClient.request()`:

1. Get a 401 on the target endpoint.
2. If we haven't just refreshed in this client instance: refresh and retry once.
3. Still 401 after a successful refresh → call `disambiguate401(path)`:
   - If the original path was `/personal_info` itself → throw `OuraAccountUnavailable` (no further probe possible).
   - Otherwise hit `/personal_info` directly:
     - If it succeeds → original endpoint is gated (account doesn't have the feature) → throw `OuraEndpointGated(path)`.
     - If it 401s too → broader account issue → throw `OuraAccountUnavailable`.
4. Failure in the refresh step itself (after the reload-on-fail fallback) → `OuraReauthRequired`.

Each error type has a specific user-facing message; the `clientTool` wrapper in `src/mcp/registerTools.ts` surfaces them as MCP error content with a structured `{code, message}` body.

## Cache

Read-through, write-back, TTL-aware. `src/storage/cache.ts`:

```
selectTTLSeconds(path, query):
  - /personal_info        → 24h
  - /heartrate            → 30 min
  - else look at query.end_date:
      end_date >= today UTC → 5 min  (mid-day data still being computed)
      end_date == yesterday → 1 hour (overnight scores finalized)
      else                  → 24h    (historical, stable)
  - no end_date           → 24h
```

Lexicographic comparison on YYYY-MM-DD strings works because the format is fixed-length and chronologically sorted.

Plaintext entries (from before the encryption migration) self-heal: `getCached()` catches decrypt failure, deletes the key, returns null. Caller refetches from Oura with new encrypted storage.

## Deletion

`/delete` (GET) shows a confirmation page. `/delete/start` (POST) validates a CSRF token, mints a state payload `{flow: "delete"}` in `OAUTH_KV`, and redirects to Oura's authorize URL. The user re-authenticates with Oura; on return at `/oura/callback`, the state payload is `flow === "delete"`, so the callback handler takes a different path:

1. Exchange the OAuth code, fetch `personal_info`, derive `ouraUserId`.
2. Best-effort delete in this order, each wrapped in try/catch so partial failures don't block the rest:
   - `deleteStoredToken(env.OURA_TOKENS, ouraUserId)` — drops the per-user encrypted token.
   - `deleteAllCacheForUser(env.OURA_CACHE, ouraUserId)` — paginates `kv.list({prefix: "cache:" + ouraUserId + ":"})` and deletes each.
   - `OAUTH_PROVIDER.listUserGrants(ouraUserId)` → for each grant, `revokeGrant(g.id, ouraUserId)`.
3. Render the summary page with counts.

Authentication for the delete is *re-proving Oura identity*, not a current MCP bearer. This means users can delete even after losing access to their MCP client.

## Tools (21 live)

| Category | Tools |
|---|---|
| Diagnostic (1) | `ping` |
| Core daily (3) | `get_daily_summary`, `get_date_range`, `get_last_night_sleep` |
| Phase 1 closes M8 (5) | `get_workouts`, `get_sessions`, `get_tags`, `get_heart_rate_series`, `compare_to_baseline` |
| Phase 2 Tier A wrappers (7) | `get_stress`, `get_spo2`, `get_resilience`, `get_cardio_age`, `get_vo2_max`, `get_recommended_sleep_time`, `get_rest_mode_periods` |
| Phase 3 composites (2) | `get_morning_briefing`, `get_weekly_recap` |
| Phase 4 analytics (2) | `find_anomalies`, `correlate_tag_with_metric` |

Phase 5 (cycle analytics) was removed because Oura's public v2 API does not expose menstrual-cycle endpoints. Tag-based logging via `get_tags` + `correlate_tag_with_metric` is the documented workaround.

## Discoverability

| Path | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414. Served by workers-oauth-provider. |
| `/.well-known/oauth-protected-resource` | RFC 9728. Served by workers-oauth-provider with explicit `resourceMetadata` config from `src/index.ts`. |
| `/.well-known/glama.json` | Glama directory discovery. Maintainer email. |
| `/.well-known/mcp/server-card.json` | Smithery scan fallback. Includes `configSchema` (empty — OAuth handles auth, no user config to prompt for). |
| `server.json` (repo root) | Official MCP Registry submission file. Namespace `link.smirnov/mcp-oura`, DNS-verified against `smirnov.link`. |

The official MCP Registry is the upstream for PulseMCP, mcp.so, and other aggregators. Publishing there propagates everywhere. See `mcp-publish.md` (gitignored — contains the publisher's private key).

## Hello page

`GET /mcp` with `Accept: text/html` and *not* `application/json` or `text/event-stream` returns a human-readable HTML page explaining "this is an MCP endpoint, paste it into your client" instead of the JSON 401. The shim lives in the default export's `fetch` method, wrapping the OAuthProvider. Real MCP traffic (POST with JSON, SSE) and probe requests (HEAD, OPTIONS) fall through to the provider unchanged.

Pattern adopted from https://www.hybridlogic.co.uk/blog/2026/05/mcp-hello-page.

## What's intentionally absent

- **No write tools.** Oura's API supports creating tags/workouts; we don't expose this.
- **No webhooks.** Polling via the cache layer is sufficient at this scale.
- **No background scheduled refresh.** Tokens refresh lazily during request handling.
- **No web UI for users to inspect their data.** Browser pages are for setup/legal only; the data is consumed through MCP clients.
- **No multi-region deployment story.** Single Cloudflare Worker; the Workers runtime handles edge placement.
- **No first-party medical interpretation.** The TOS explicitly disclaims; tools surface raw data.
