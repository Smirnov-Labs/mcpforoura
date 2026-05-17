# Submitting mcpforoura to Oura for production approval

> Goal: lift the 10-user cap on the Oura developer application so anyone (not just whitelisted dev users) can authorize the connector.

Oura's docs are succinct on this:

> *"By default, API Applications have a ten user limit. If you want to release your application to a wider audience, your application needs to be approved. Once you have finished developing your application, you can submit it for review from the application's page."* — https://cloud.ouraring.com/docs/

There is no public submission form URL; the **"Submit for review"** action lives on the application's page inside the Oura developer portal.

## Pre-submission checklist

Verify each of these before clicking submit. All are already in place at the time of this writing — listed here so you can spot-check before/after any future changes.

| Item | Current state | How to verify |
|---|---|---|
| Production HTTPS domain | ✅ `mcp-oura.smirnov.link` | `curl -I https://mcp-oura.smirnov.link/` returns 200 |
| Privacy policy URL registered with Oura | ✅ `https://mcp-oura.smirnov.link/privacy` | Both Oura's app settings AND the live page must agree |
| Terms of service URL | ✅ `https://mcp-oura.smirnov.link/tos` | Same |
| Contact email | ✅ `ivan@smirnovlabs.com` | Surfaced on `/privacy`, `/tos`, and Oura app settings |
| Redirect URI | ✅ `https://mcp-oura.smirnov.link/oura/callback` | Must match exactly between Oura app + `wrangler.jsonc` `OURA_REDIRECT_URI` var |
| Scope minimization | ✅ `personal, daily, heartrate, workout, session, tag, spo2, stress, heart_health` (no `email`, no `ring_configuration`) | `src/oura/scopes.ts` |
| OAuth flow working end-to-end | ✅ | You and Lena both authorized via prod |
| Tokens encrypted at rest | ✅ AES-GCM + HKDF per-user | `src/crypto.ts` + `src/storage/tokens.ts` |
| Response cache encrypted at rest | ✅ Same pattern, separate HKDF info string | `src/storage/cache.ts` (CACHE_HKDF_INFO) |
| User-initiated deletion path | ✅ `/delete` flow | `https://mcp-oura.smirnov.link/delete` returns 200; drops token + cache + grants on completion |
| Single-use refresh-token handling | ✅ In-process mutex + KV reload-on-fail | `src/oura/client.ts` (`pendingRefresh`, `doRefresh` fallback) |
| OAuth 2.1 hardening | ✅ S256-only PKCE, no implicit flow | `src/index.ts` (`allowPlainPKCE: false`, `allowImplicitFlow: false`) |
| No medical-advice positioning | ✅ Explicit disclaimer in `/tos` Limitation of liability section | grep "not medical advice" |

## How to submit

1. Sign in to https://cloud.ouraring.com
2. Navigate to **API Applications**
3. Click the **MCP for Oura** application
4. Look for a **"Submit for review"** or **"Apply for production"** button — typically at the top or in the app's settings panel. If you don't see it, the metadata is probably incomplete; fill in any blank fields first.
5. The form will likely ask the questions below. Suggested answers are pre-drafted; tune for tone before submitting.

## Suggested form answers

These are drafted as if the form has free-text fields. Adapt verbatim or shorten as needed.

### What does your application do?

> mcpforoura is a hosted, multi-tenant remote MCP (Model Context Protocol) server that connects users' Oura accounts to AI assistants — Claude, Cursor, etc. — through OAuth. It exposes 21 read-only tools that surface Oura ring data (sleep, readiness, activity, stress, SpO2, workouts, mindfulness sessions, user tags, recommended sleep time, rest-mode periods, VO2 max, cardiovascular age, resilience), plus two composite tools (morning briefing, weekly recap) and two analytics tools (anomaly detection, tag-vs-metric correlation).
>
> Users authorize the application from their MCP client; the server holds OAuth tokens on their behalf, refreshes them as needed, and brokers tool calls. Read-only — no Oura data is created or modified by this server.

### Expected user volume?

> Small. Currently personal use plus close friends and family beta. Gradual expansion as the connector matures. No marketing push, no enterprise plans, no API resale.

### How do you store and handle user data?

> - **OAuth tokens** (access + refresh) are encrypted at rest in Cloudflare Workers KV using AES-GCM with per-user keys derived via HKDF-SHA256. The shared secret is held as a Cloudflare Worker secret; loss of the secret renders all stored tokens undecryptable (no cleartext leak path).
> - **Response cache** entries (used to reduce upstream load and stay within rate limits) are encrypted with the same AES-GCM pattern but a distinct HKDF info string so the cache and token namespaces have cryptographically separated keys. TTLs range from 5 minutes (today's data) to 24 hours (historical data); entries expire automatically.
> - **Operational logs** capture only non-sensitive service metadata (request timing, error codes, opaque user IDs). No Oura ring data is logged.
> - **Refresh tokens** are treated as single-use per Oura's API agreement. The server uses an in-process mutex to coalesce concurrent refresh attempts and a cross-isolate KV reload-on-failure fallback to handle multi-Worker-invocation races without burning user-recoverable state.
> - **Cloudflare** is the only third-party infrastructure provider used. No data is sold, no data is shared with third parties.

### How can users delete their data?

> Users can immediately delete their stored data by visiting `https://mcp-oura.smirnov.link/delete`. They re-authenticate with Oura to confirm their identity, then the server:
>
> 1. Deletes the user's encrypted OAuth token from Cloudflare KV.
> 2. Deletes every cache entry scoped to that user's Oura user ID.
> 3. Revokes every OAuth grant this server issued to MCP clients on the user's behalf.
>
> The deletion summary shown to the user reports the counts of each. Disconnecting the MCP connector from the AI client (Claude → Settings → Connectors → Remove) is also sufficient to stop future authorization, though it does not eagerly evict cached data.

### What is your security posture?

> - **OAuth 2.1 hardened.** S256 is the only accepted PKCE method (`allowPlainPKCE: false`); the legacy implicit flow is rejected (`allowImplicitFlow: false`). Scopes the server accepts are explicitly declared in OAuth metadata (`scopes_supported: ["mcp"]`).
> - **CSRF protection** on consent pages via double-submit cookie pattern (`__Host-` prefixed, HttpOnly, Secure, SameSite=Lax).
> - **State-token binding** between authorize and callback uses a session cookie hash so a state token leaking via a referrer header alone is insufficient to replay.
> - **TLS-only**, served from `mcp-oura.smirnov.link` (Cloudflare-managed cert).
> - **Bearer-token gated** MCP endpoint (`/mcp`). Unauthenticated requests return RFC 6750 `WWW-Authenticate: Bearer` with a pointer to `/.well-known/oauth-protected-resource`.

### Is this a medical product or does it offer medical advice?

> No. The terms of service explicitly disclaim medical advice: *"Health metrics retrieved through this service are not medical advice; consult a qualified clinician for medical decisions."* Tools surface raw Oura data and let the connected AI assistant narrate; they do not interpret data clinically or make recommendations.

### Do you have a test/demo account we can use to review?

> Happy to walk Oura's review team through the OAuth flow with my own account, or to coordinate a brief screenshare. Email `ivan@smirnovlabs.com` to arrange.

### Source code

> Public on GitHub: https://github.com/Smirnov-Labs/mcpforoura — full implementation, design docs in `docs/`, and review history (the project has been through an external security review whose findings are tracked in PRs #9 through #16).

## After submitting

Review timelines for OAuth applications at small platforms typically run from a few days to ~2 weeks. If anything unusual comes up that requires code changes (e.g., they want a specific log-retention statement or a contact-email DNS proof), capture the requirements as a follow-up PR and link from this file.

## If they reject

Most rejections are fixable. Common categories:
- **Scope over-request** — already minimized; if they push back on a specific scope, drop it from `src/oura/scopes.ts` and have authorized users re-authenticate.
- **Missing privacy disclosure** — extend `/privacy` content and bump `PRIVACY_LAST_UPDATED`.
- **Caching policy concern** — `OURA_CACHE` is already encrypted with a distinct HKDF info string; if they want shorter TTLs or no cache at all, the TTL table is centralized in `src/storage/cache.ts:selectTTLSeconds`.
- **Deletion not visible enough** — already linked from `/privacy` and home page; could add an explicit `/.well-known/data-deletion` JSON pointer.

For any case, document the change in this file under a new dated heading so the next person reading sees the trail.
