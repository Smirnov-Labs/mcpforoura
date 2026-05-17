# Lessons from building mcpforoura

Written after one production release cycle. Captures the things I'd want to know before building the *next* hosted remote MCP server.

## Codex production-readiness review — what it caught

Two days in we ran an outside-the-loop review (OpenAI Codex gpt-5.5 + xhigh reasoning) before submitting to any registry. The findings, in order of severity, plus how each was resolved:

### Blocker #1 — No real data deletion path

`/privacy` claimed tokens "become unreachable" when the connector is removed. In practice, `deleteStoredToken` existed but was never called from any route. Oura's API agreement requires deletion-on-request; this would have failed any production review.

**Fix (PR #10):** wired up a full `/delete` flow that re-authenticates the user with Oura, then drops their encrypted token, every cache entry for their user id, and every OAuth grant the provider issued. Re-auth via Oura instead of "current MCP bearer" lets users delete even if they lost access to the MCP client side.

**Generalizes to:** any OAuth connector that retains tokens. The deletion endpoint needs to identify the user *without* trusting the bearer that may have been revoked or lost; an upstream-OAuth re-auth handshake is the cleanest way.

### Blocker #2 — Refresh-token race

Oura's refresh tokens are single-use. Composite tools (`get_morning_briefing` fans out to 6 endpoints) race to refresh when the access token nears expiry. Every parallel leg calls `ensureFresh()`; the first refresh succeeds, the others hit Oura with the already-consumed refresh token and get `invalid_grant`. Result: `OuraReauthRequired` thrown to the user even though they're fine.

**Fix (PR #12):** two-layer mitigation.
1. **In-process mutex** — `OuraClient.pendingRefresh: Promise | null`. Concurrent callers in the same isolate await the same in-flight promise.
2. **Cross-isolate reload-on-fail** — when `refreshAccessToken` rejects, force-reload the stored token from KV. If the stored `refreshToken` differs from what we tried with, another isolate already refreshed; use the newer value. Only throw `OuraReauthRequired` if KV still holds the burnt token.

**Generalizes to:** any provider that issues single-use refresh tokens (Oura, Auth0, Spotify in some modes). Single-isolate mutex is necessary but not sufficient; you need the cross-isolate reload too.

### Blocker #3 — Plaintext cache

`OURA_CACHE` stored Oura response bodies as plaintext JSON in KV. Oura's API agreement restricts caching/storing user data; this would have been flagged.

**Fix (PR #10):** apply the same AES-GCM + HKDF-per-user encryption used for tokens. Plaintext legacy entries self-heal: decrypt failure in `getCached()` evicts the key and returns null, the caller refetches with new encrypted storage. No manual migration. Added a separate HKDF info string (`oura-cache-encryption-v1` vs `oura-token-encryption-v1`) for cryptographic domain separation between the cache and token KV namespaces.

**Generalizes to:** any per-user response cache on shared infrastructure. The marginal cost of encrypting cache entries is negligible (Web Crypto is fast) and the security/compliance posture jumps materially.

### Blocker #4 — Mislabeled metrics

Three metrics returned the wrong data:

- `get_last_night_sleep.score` returned `best.readiness?.score` — the sleep period's nested *readiness* signal, not the sleep score.
- `hrv` metric (used by `get_date_range`, `compare_to_baseline`, `find_anomalies`) returned `daily_readiness.contributors.hrv_balance` — a 0–100 normalized score, not actual HRV in milliseconds.
- `resting_hr` returned `daily_readiness.contributors.resting_heart_rate` — also a 0–100 score, not heart rate in BPM.

Easy to miss because the field names sound right. A user asking "what was my HRV last week" would get back numbers in the 0–100 range — they look like HRV ms values when in fact they are scores.

**Fix (PR #11):** moved `hrv` and `resting_hr` from the readiness-document source to the sleep-period source (`average_hrv` and `lowest_heart_rate`), which carry the actual physiological measurements. Moved `get_last_night_sleep.score` to a parallel `daily_sleep` fetch and pulled the correct field.

**Generalizes to:** API surfaces with similarly-named fields at different granularities. *Always* trace each tool's output field back to its API source and confirm the unit and meaning. The cost of an outside review catching this is much lower than a user noticing and not trusting any number the server returns.

### Blocker #5 — OAuth provider hardening

`workers-oauth-provider` defaults are permissive for backwards compatibility:
- Plain PKCE allowed.
- Implicit flow allowed.
- No declared `scopesSupported`, no explicit `resourceMetadata`.

Anthropic's connector review criteria explicitly call these out.

**Fix (PR #13):** set `allowPlainPKCE: false`, `allowImplicitFlow: false`, `scopesSupported: ["mcp"]`, and an explicit `resourceMetadata` with `resource`, `authorization_servers`, and `scopes_supported`. Verified live by hitting `/.well-known/oauth-authorization-server` — `code_challenge_methods_supported` now contains only `["S256"]`, `grant_types_supported` doesn't include `implicit`.

**Generalizes to:** any deployment of `workers-oauth-provider` or similar libraries — read every option in the constructor and explicitly set the safe ones. Defaults are about backwards compatibility, not security.

### Lower-priority items folded into the discoverability PR

- `_internal_personal_info` was registered as an MCP tool that returned full Oura personal_info to any authenticated client. Useful as a diagnostic but unnecessary PII exposure. **Removed.**
- Scope set included `email` and `ring_configuration`, neither used by any tool. **Dropped** — Oura's production approval explicitly asks for scope minimization.
- `COOKIE_SECRET` declared in env but never referenced. **Removed.**
- `OAUTH_PROVIDER_ENCRYPTION_KEY` documented in README but not read by `@cloudflare/workers-oauth-provider@0.3.1`. **Removed.**
- README said "3-user cap" but Oura's default is 10. **Fixed.**

## Phase 5 cycle tools — the "guess an endpoint" mistake

The original spec called for cycle-analytics tools (`get_cycle_phase`, `get_cycle_history`, `compare_metric_across_cycle_phases`). I built them against an assumed endpoint path `/usercollection/cycle_insights`. After deploy, a beta user (Lena) hit 404s.

Confirmed across three sources that **Oura's public v2 API does not expose menstrual cycle endpoints.** The Cycle Insights feature lives in the Oura app only. PR #8 removed all three tools.

**Lesson:** before writing code for an endpoint, *verify it exists*. The original spec acknowledged this risk and instructed defensive failure modes (`{available: false, reason}` on 404), which worked — but the better move is to spend 30 seconds with `curl -H "Authorization: Bearer ..."` against a known account to confirm the path. The Phase 5 code now lives in git history; if Oura ever publishes a cycle API, restoration from `feat/phase-5-cycle` is trivial.

## Timezone bug — UTC vs user-local

`get_daily_summary` originally accepted `"today"` / `"yesterday"` as aliases. The server resolved them by calling `new Date().toISOString().slice(0, 10)` — which gives **UTC**, not the user's local date. Oura's API attributes daily docs to the *user's local day*. At 8:40 PM in Denver, the UTC date is already the next day; the alias resolved wrong and the tool returned empty.

**Fix:** dropped the aliases. Tools accept strict YYYY-MM-DD only; the LLM, which has the user's local date in its system prompt, resolves the alias itself.

**Generalizes to:** any "today" / "yesterday" convenience in a hosted service. Servers don't have user-locale context — let the LLM (which does) do the date math and pass an explicit date. Same pattern for "this week", "this month", etc.

## KV namespace title collision

`wrangler kv namespace create OAUTH_KV` failed because another worker in the same Cloudflare account already owned a namespace titled `OAUTH_KV`. KV namespace *titles* are global per account; only the *binding name* inside the worker is local.

**Fix:** create with a worker-prefixed title: `wrangler kv namespace create mcpforoura-OAUTH_KV`. The binding inside the worker stays `OAUTH_KV` for readability — `wrangler.jsonc` separates the binding name from the namespace ID.

## `agents` package + bundled MCP SDK version drift

`agents@0.8.7` pins `@modelcontextprotocol/sdk@1.28.0` as a nested dep. Our top-level `package.json` pinned `1.26.0`. TypeScript flagged it: the two SDK copies have separate `_serverInfo` private fields, so the `server` property on `OuraMCP extends McpAgent` was a type mismatch even though the runtime would have worked.

**Fix:** bump the top-level pin to match what `agents` deps to.

**Generalizes to:** any "wrapper" library that depends on a major-ish SDK. Always check `node_modules/<wrapper>/package.json` for the nested version and pin to match — the dual-package hazard is real and TypeScript will surface it.

## MCP Registry description cap

`server.json` `description` field has an undocumented (well, documented in the schema but not surfaced on first read) 100-character limit. Our first attempt had a 256-character marketing description and got HTTP 422 from the registry. The error message path was confusingly `body._meta.io.description` — *not* `body.description` — because the registry transforms the top-level field internally.

**Fix:** shortened to 82 chars. Captured in `mcp-publish.md` and `docs/learnings.md` (this file) so future versions don't re-discover this.

**Generalizes to:** any new schema — read length constraints and any other hidden validation before publishing. The error payload locations don't always match the JSON paths you wrote.

## Smithery scan needed an explicit empty configSchema

Smithery's scanner warned "no config schema provided" even though our server has zero user configuration (it's OAuth-protected; no API keys to prompt for). Their scan apparently expects the field to be present and explicitly empty rather than missing.

**Fix:** added `configSchema: { type: "object", properties: {}, additionalProperties: false, description: "No user config required..." }` to the `/.well-known/mcp/server-card.json` route. Warning cleared.

## The "hello page" pattern

Browser users paste the MCP URL (`https://mcp-oura.smirnov.link/mcp`) into their address bar to "test if it works" and see a JSON 401. They assume the server is broken and file support tickets. Pattern adopted from [hybridlogic.co.uk](https://www.hybridlogic.co.uk/blog/2026/05/mcp-hello-page): when `GET /mcp` arrives with `Accept: text/html` and *not* `application/json` or `text/event-stream`, serve an HTML page explaining "this is an MCP endpoint, paste it into your client." Real MCP traffic is unaffected (it sends `application/json` and/or `text/event-stream`, or no Accept at all).

Worth doing on day one for any new hosted MCP server.

## Discoverability is a multi-target problem

Aggregator coverage doesn't fall out of "publish to one place":

| Target | How they find you |
|---|---|
| Official MCP Registry | `server.json` + DNS-verified namespace + `mcp-publisher publish` |
| PulseMCP | Pulls from the official registry; no separate submission |
| mcp.so | Pulls from the official registry; no separate submission |
| Smithery | Manual submission at `smithery.ai/new`; optional `/.well-known/mcp/server-card.json` fallback; has its own verification checklist (homepage + DNS TXT + README backlink) |
| Glama | Manual submission; reads `/.well-known/glama.json` from your server for ownership |
| Claude.ai connectors directory | Curated by Anthropic; no public submission as of writing |

The single highest-leverage move is publishing to the official MCP Registry — that covers PulseMCP and mcp.so automatically. Smithery and Glama are partly automatic, partly manual.

## What the subagent-driven dev pattern was good and bad at

The whole v2 build (16 tools, 5 phases) was executed via the `superpowers:subagent-driven-development` pattern: a plan written by the controller, dispatched to a sonnet-tier implementer subagent, with a separate spec-compliance and code-quality reviewer subagent gating each merge.

**Worked well:**
- Fresh context per task. The implementer didn't drown in prior-PR detail.
- Two-stage review caught real issues (the off-by-one in `get_rest_mode_periods`, the `void round` dead import, the unsafe `pickByDay` fallback). These would have shipped without it.
- Continuous progress without me cherry-picking lines.

**Worked less well:**
- The implementer was sometimes *too* literal. Plans that said "match this code block exactly" got matched, but plans that said "follow the existing pattern" sometimes diverged subtly.
- Cycle of plan → implement → review → fix → re-review was expensive when the fix was a 2-line change. Some PRs were better as "controller writes the fix inline" rather than "dispatch a fix subagent."
- Codex (gpt-5.5 + xhigh) review took 5–10 minutes of wall clock per dispatch. Worth it for production gates but not for routine PRs.

The right granularity seems to be: **subagent for any PR that touches 3+ files or has non-trivial logic; inline edits for typo-class changes or single-spot fixes that emerge from review**. Worth re-evaluating each release cycle.
