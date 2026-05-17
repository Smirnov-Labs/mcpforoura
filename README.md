# mcpforoura

[![smithery badge](https://smithery.ai/badge/issmirnov/oura)](https://smithery.ai/servers/issmirnov/oura) [![mcp registry](https://img.shields.io/badge/mcp%20registry-link.smirnov%2Fmcp--oura-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=link.smirnov)

Hosted remote MCP server for [Oura Ring](https://ouraring.com), live at **https://mcp-oura.smirnov.link/mcp**. Multi-tenant OAuth: each user authenticates to their own Oura account. Read-only. Built on Cloudflare Workers.

Listed on [Smithery](https://smithery.ai/servers/issmirnov/oura) and the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=link.smirnov).

Small-scale connector — currently in Oura's development-mode 10-user cap; production application is pending. Not affiliated with Oura Health Oy.

**Status:** deployed and serving. 21 tools live across 4 implementation phases on top of the original M1-M8. KV cache live (M7). Phase 1–4 v2 tool expansion complete (Tier A wrappers, composites, analytics). Phase 5 cycle tools removed pending Oura API support.

## What you can ask

21 tools live across 4 phases (Phase 5 cycle tools removed — see "Not available" below):

**Core (M6 originals)**

| Tool | When to use |
|---|---|
| `get_daily_summary` | "How was my Saturday?" / "Show me yesterday's readiness." A single-day snapshot of sleep + readiness + activity. |
| `get_date_range` | "How was my sleep this week?" / "Show me my HRV over the past month." A single metric over up to 180 days. |
| `get_last_night_sleep` | "How did I sleep last night?" Most recent night's score, stage breakdown, timing, HR/HRV. |
| `ping` | Diagnostic. Verifies the connector is authenticated and reachable. |
| `_internal_personal_info` | Diagnostic. Verifies the Oura token works and the API is responding. |

**Phase 1 — Activity & tagging**

| Tool | When to use |
|---|---|
| `get_workouts` | List logged or auto-detected workouts over a date range (up to 180 days). |
| `get_sessions` | List mindfulness sessions (meditation, breathing, relaxation). |
| `get_heart_rate_series` | Intraday HR time-series within a 24h window, bucketed to 5min/15min/raw. |
| `get_tags` | Custom tags users log (caffeine, alcohol, custom notes). |
| `compare_to_baseline` | "Is this normal for me?" Compares a day's metric to 30- and 90-day personal baselines. |

**Phase 2 — Tier A daily metrics**

| Tool | When to use |
|---|---|
| `get_stress` | Daily high-stress and recovery seconds for a date. |
| `get_spo2` | Nightly blood-oxygen (SpO2) average and breathing disturbance index. |
| `get_resilience` | Oura's long-term stress recovery capacity score for a date. |
| `get_cardio_age` | Cardiovascular-age estimate derived from HRV, resting HR, and other signals. |
| `get_vo2_max` | Most recent VO2 max measurement within 30 days of the queried date. |
| `get_recommended_sleep_time` | Oura's recommended bedtime window for a date. |
| `get_rest_mode_periods` | List illness/recovery rest-mode periods over a date range. |

**Phase 3 — Composite tools**

| Tool | When to use |
|---|---|
| `get_morning_briefing` | "How am I today?" Structured snapshot: readiness + recommended sleep time + yesterday's stats. |
| `get_weekly_recap` | 1–28 day window with per-metric mean/min/max. Default 7 days. |

**Phase 4 — Analytics**

| Tool | When to use |
|---|---|
| `find_anomalies` | Flag days whose metric deviates >N σ from the rolling-window mean. |
| `correlate_tag_with_metric` | "Does alcohol hurt my HRV?" Compare metric stats on tagged vs. untagged days. |

## Not available

Cycle analytics (`get_cycle_phase`, `get_cycle_history`, `compare_metric_across_cycle_phases`) were initially planned for Phase 5 but **Oura's public v2 API does not expose menstrual cycle endpoints** — the Cycle Insights feature lives in the Oura app only. The tools were removed after a beta user hit 404s; see git history (`feat/phase-5-cycle` and `feat/remove-cycle-tools` branches) for the reasoning trail. Tag-based logging via `get_tags` can serve as a partial workaround if users tag period start days manually.

## Adding the connector in Claude

1. Settings → Connectors → Add custom connector.
2. URL: `https://mcp-oura.smirnov.link/mcp`.
3. Approve on this server's consent page → redirected to Oura → consent there → returned to Claude.

The connector currently caps at 10 authorized users (Oura's default development-mode limit). To lift the cap, the Oura developer application must be approved for production by Oura.

## Architecture

Two-stage OAuth on Cloudflare Workers:

- **Flow A (MCP client ↔ this server).** Handled by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Standard OAuth2 + PKCE + dynamic client registration. Consent page is rendered server-side and includes a CSRF token.
- **Flow B (this server ↔ Oura).** Hand-rolled. Triggered inside Flow A: redirect to `cloud.ouraring.com`, exchange the returned code for tokens, fetch `/personal_info` to derive a stable user id, store the token AES-GCM encrypted in Cloudflare KV, then complete Flow A with that user id attached as `props`.

A `McpAgent`-derived Durable Object holds session state and routes MCP method calls to typed tool handlers. Each tool builds an `OuraClient` per call that handles token refresh, 401 disambiguation (re-auth vs. endpoint gated vs. account membership inactive), and 429 exponential backoff.

See `CLAUDE.md` for the full file-by-file walkthrough.

## Setup (operator)

One-time:

1. **Oura developer app** — [cloud.ouraring.com](https://cloud.ouraring.com) → API Applications → New.
   - Redirect URI: `https://<your-host>/oura/callback`
   - Privacy Policy URL: `https://<your-host>/privacy`
   - Terms of Service URL: `https://<your-host>/tos`

2. **Cloudflare KV namespaces** (paste IDs into `wrangler.jsonc`):
   ```bash
   npx wrangler kv namespace create mcpforoura-OAUTH_KV
   npx wrangler kv namespace create OURA_TOKENS
   npx wrangler kv namespace create OURA_CACHE
   ```
   The `mcpforoura-` prefix on `OAUTH_KV` avoids colliding with other workers in the same CF account that also use a binding called `OAUTH_KV`.

3. **First deploy** (registers the worker so secrets can attach to it):
   ```bash
   npx wrangler deploy
   ```

4. **Secrets**:
   ```bash
   echo -n "$CLIENT_ID"     | npx wrangler secret put OURA_CLIENT_ID
   echo -n "$CLIENT_SECRET" | npx wrangler secret put OURA_CLIENT_SECRET
   openssl rand -base64 32  | tr -d '\n' | npx wrangler secret put ENCRYPTION_SECRET
   ```
   Keep a copy of `ENCRYPTION_SECRET` somewhere safe — if it's lost, stored tokens cannot be decrypted and all users have to re-authorize.

5. **Custom domain** — if the apex zone is in the same Cloudflare account, the `routes` block in `wrangler.jsonc` (with `custom_domain: true`) attaches the subdomain automatically on next deploy. Otherwise, configure it manually in the Cloudflare dashboard.

## Discoverability

The server publishes the following metadata for MCP registry aggregators:

| Path | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth2 authorization-server metadata (served by `@cloudflare/workers-oauth-provider`). |
| `/.well-known/oauth-protected-resource` | OAuth2 protected-resource metadata (served by `@cloudflare/workers-oauth-provider`). |
| `/.well-known/glama.json` | Glama directory discovery — `https://glama.ai/mcp`. |
| `/.well-known/mcp/server-card.json` | Smithery scan fallback (only used when their auto-scanner can't pull the tool list through OAuth). |
| `server.json` (repo root) | Official MCP Registry submission file — namespace `link.smirnov/mcp-oura`, DNS-verified against `smirnov.link`. Published with `mcp-publisher`. |

Submitting the server to the official MCP Registry (which PulseMCP, mcp.so, and other aggregators consume from):

```bash
# One-time, from this repo root
go install github.com/modelcontextprotocol/registry/cmd/mcp-publisher@latest
mcp-publisher login dns smirnov.link   # prints a TXT record to add in Cloudflare DNS
mcp-publisher publish                  # uses server.json in the repo root
```

Submitting to Smithery: paste `https://mcp-oura.smirnov.link/mcp` at `smithery.ai/new` and walk through OAuth during their scan.

Submitting to Glama: use "Add Server" on `glama.ai/mcp/servers` (they pick up maintainer info from `/.well-known/glama.json` automatically).

## Development

```bash
cp .dev.vars.example .dev.vars      # fill in
npm install
npm run dev
```

Local development hits the same Oura redirect URI as production, so it's usually easier to test via `wrangler dev --remote` so the consent flow completes against deployed infrastructure.

## Privacy & data handling

- Oura OAuth tokens are encrypted at rest (AES-GCM, per-user HKDF-derived key) in Cloudflare Workers KV.
- Oura ring data is fetched on demand and (when the cache layer ships) may be briefly cached in KV with TTLs ranging from 5 minutes (today's data) to 24 hours (historical).
- Ring data is not logged.
- Disconnecting the connector revokes the OAuth grant; tokens become unreachable.
- See `/privacy` on the deployed site for the full policy.

## Status

Deployed at `https://mcp-oura.smirnov.link` on the Smirnov Labs Cloudflare account. Custom domain mapped via the `routes` block in `wrangler.jsonc`. Three KV namespaces provisioned (`mcpforoura-OAUTH_KV`, `OURA_TOKENS`, `OURA_CACHE`). Three secrets set (`OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `ENCRYPTION_SECRET`).

### Build progress

| Milestone | Status |
|---|---|
| M1 — Worker scaffold | ✅ |
| M2 — OAuth provider + Hono consent + `ping` | ✅ |
| M3 — Oura OAuth flow B | ✅ |
| M4 — OuraClient (refresh, 401 disambig, 429 backoff) | ✅ |
| M5 — AES-GCM token encryption | ✅ |
| M6 — Tools 1–3 | ✅ |
| D1 — First deploy to `mcp-oura.smirnov.link` | ✅ |
| D2 — CLAUDE.md + expanded README + LICENSE | ✅ |
| D3 — Push to `Smirnov-Labs/mcpforoura` on GitHub | ✅ |
| M7 — KV response cache with date-aware TTLs | ✅ |
| M8 — Tools 4–8 (workouts, sessions, HR series, tags, baseline) | ✅ |
| Phase 1–4 — 16 additional tools (Tier A, composites, analytics) | ✅ |
| Phase 5 — cycle tools (removed; Oura v2 API has no public cycle endpoints) | ❌ |
| M9 — Vitest tests + deploy-docs polish | ✅ |

## License

MIT. See `LICENSE`.
