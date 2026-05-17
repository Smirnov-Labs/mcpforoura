# mcpforoura

Hosted remote MCP server for [Oura Ring](https://ouraring.com), live at **https://mcp-oura.smirnov.link/mcp**. Multi-tenant OAuth: each user authenticates to their own Oura account. Read-only. Built on Cloudflare Workers.

This is a small-scale connector (3-user cap). Not affiliated with Oura Health Oy.

**Status:** deployed and serving. 5 tools live (M1–M6). Cache layer, 5 additional tools, and tests are next (M7–M9). The original 8-tool spec is the v1 target; new tool ideas beyond that are being explored.

## What you can ask

Tools available right now:

| Tool | When to use |
|---|---|
| `get_daily_summary` | "How was my Saturday?" / "Show me yesterday's readiness." A single-day snapshot of sleep + readiness + activity. |
| `get_date_range` | "How was my sleep this week?" / "Show me my HRV over the past month." A single metric over up to 180 days. |
| `get_last_night_sleep` | "How did I sleep last night?" Most recent night's score, stage breakdown, timing, HR/HRV. |
| `ping` | Diagnostic. Verifies the connector is authenticated and reachable. |
| `_internal_personal_info` | Diagnostic. Verifies the Oura token works and the API is responding. |

Planned (not yet implemented):

| Tool | When to use |
|---|---|
| `get_workouts` | List logged or auto-detected workouts over a range. |
| `get_sessions` | List mindfulness sessions (meditation, breathing). |
| `get_heart_rate_series` | Intraday HR time-series, up to 24h window, bucketed. |
| `get_tags` | Custom tags users log (caffeine, alcohol, etc.). |
| `compare_to_baseline` | "Is this normal for me?" Compares a day's metric to your 30- and 90-day personal baselines. |

## Adding the connector in Claude

1. Settings → Connectors → Add custom connector.
2. URL: `https://mcp-oura.smirnov.link/mcp`.
3. Approve on this server's consent page → redirected to Oura → consent there → returned to Claude.

The connector caps at 3 authorized users (matches the Oura developer app's development-mode limit).

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
   openssl rand -base64 32  | tr -d '\n' | npx wrangler secret put OAUTH_PROVIDER_ENCRYPTION_KEY
   ```
   Keep a copy of `ENCRYPTION_SECRET` somewhere safe — if it's lost, stored tokens cannot be decrypted and all users have to re-authorize.

5. **Custom domain** — if the apex zone is in the same Cloudflare account, the `routes` block in `wrangler.jsonc` (with `custom_domain: true`) attaches the subdomain automatically on next deploy. Otherwise, configure it manually in the Cloudflare dashboard.

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

Deployed at `https://mcp-oura.smirnov.link` on the Smirnov Labs Cloudflare account. Custom domain mapped via the `routes` block in `wrangler.jsonc`. Three KV namespaces provisioned (`mcpforoura-OAUTH_KV`, `OURA_TOKENS`, `OURA_CACHE`). Four secrets set (`OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `ENCRYPTION_SECRET`, `OAUTH_PROVIDER_ENCRYPTION_KEY`).

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
| M7 — KV response cache with date-aware TTLs | not started |
| M8 — Tools 4–8 (workouts, sessions, HR series, tags, baseline) | not started |
| M9 — Vitest tests + deploy-docs polish | not started |

## License

MIT. See `LICENSE`.
