# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

`mcpforoura` is a hosted, multi-tenant MCP server for the Oura Ring API. It runs on Cloudflare Workers, exposes a single `/mcp` endpoint, and authenticates MCP clients via OAuth2 (using `@cloudflare/workers-oauth-provider`). Each authenticated MCP client maps to a specific Oura user via a second OAuth flow handled by this server.

Live at `https://mcp-oura.smirnov.link/mcp`. Cap is 3 users.

## Architecture at a glance

```
Claude (MCP client)
  │  HTTPS  Bearer token
  ▼
Cloudflare Worker (mcpforoura)
  ├─ OAuthProvider — /authorize /token /register     (workers-oauth-provider)
  │     defaultHandler →
  │       Hono app (src/oauth-app.ts)
  │         /                 — landing page
  │         /privacy /tos     — required by Oura app registration
  │         GET  /authorize    — consent screen w/ CSRF cookie
  │         POST /authorize    — verify CSRF, redirect to cloud.ouraring.com
  │         GET  /oura/callback — exchange code, fetch personal_info,
  │                              encrypt+save token, completeAuthorization
  ├─ apiRoute "/mcp" → OuraMCP.serve("/mcp")
  │     OuraMCP extends McpAgent (src/index.ts)
  │       this.props.ouraUserId  — set by completeAuthorization
  │       init() → registerOuraTools(server, env, props)
  │         per tool: new OuraClient(env, userId) → call → return JSON
  └─ Storage
        OAUTH_KV     — provider state, OAuth state tokens (TTL'd)
        OURA_TOKENS  — AES-GCM encrypted refresh/access tokens
        OURA_CACHE   — (planned) response cache w/ date-aware TTLs
```

The two OAuth flows:
- **Flow A — Claude → this server.** Handled by `workers-oauth-provider`. Standard OAuth2 + PKCE + dynamic client registration per MCP spec. The consent page is rendered by `src/oauth-app.ts:renderConsentPage`.
- **Flow B — this server → Oura.** Hand-rolled. Triggered inside Flow A's POST `/authorize`: instead of calling `completeAuthorization` immediately, we redirect the user to Oura. On return at `/oura/callback`, we exchange the code, fetch `/personal_info` for stable identity, save the encrypted token to KV, and *then* call `completeAuthorization` — passing the Oura user ID as `props.ouraUserId`.

## File map

```
src/
├── index.ts                     OuraMCP class + OAuthProvider default export
├── oauth-app.ts                 Hono app: /, /privacy, /tos, /authorize, /oura/callback
├── env.d.ts                     adds secrets to Cloudflare.Env interface
├── auth/
│   ├── types.ts                 AuthProps, StoredOuraToken, OAuthStatePayload
│   └── session.ts               createOAuthState / bindStateToSession / validateOAuthState
├── oura/
│   ├── auth.ts                  buildOuraAuthorizeUrl, exchangeAuthorizationCode,
│   │                            refreshAccessToken, fetchPersonalInfo, deriveOuraUserId
│   ├── client.ts                OuraClient — lazy load, refresh, 401 disambig, 429 backoff
│   ├── scopes.ts                OURA_SCOPES list
│   └── types.ts                 DailySleep, DailyReadiness, DailyActivity, SleepPeriod, ...
├── storage/
│   └── tokens.ts                encrypted save/load/delete on OURA_TOKENS KV
├── crypto.ts                    deriveKey (HKDF-SHA256), encrypt/decrypt (AES-GCM 256),
│                                sha256HexTruncated
├── errors.ts                    OuraReauthRequired, OuraAccountUnavailable,
│                                OuraEndpointGated, OuraRateLimited,
│                                OuraInsufficientBaseline, OuraInvalidInput
└── mcp/
    ├── registerTools.ts         registers all tools on the McpServer
    └── tools/
        ├── dates.ts             isIsoDate, resolveDate, shiftDate, daysBetween
        ├── daily-summary.ts     get_daily_summary
        ├── date-range.ts        get_date_range (8 metrics × multi-endpoint)
        └── last-night-sleep.ts  get_last_night_sleep
```

## Adding a new tool

1. Create `src/mcp/tools/<name>.ts` with two exports:
   - `<name>Schema` — Zod object describing inputs. Use strict regex on dates (see Timezones below).
   - `execute<Name>(client: OuraClient, input: T): Promise<Result>` — pure function, no MCP knowledge.
2. Register in `src/mcp/registerTools.ts`:
   ```typescript
   server.registerTool(
     "<name>",
     {
       title: "Human Title",
       description: "Use this when... Returns... For X instead, use other_tool.",
       inputSchema: <name>Schema,
       annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
     },
     clientTool(env, props, execute<Name>)
   );
   ```
3. Type-check: `npm run type-check`. Dry-run: `npx wrangler deploy --dry-run --outdir=/tmp/x`.

Tool descriptions are how the LLM picks tools. Spend time on them. Each description should answer: "when should the user ask me to call this, and when should I avoid it in favor of a different tool?"

## OuraClient — the right way to call Oura

Always go through `OuraClient`. It handles:
- Lazy token load + decrypt from KV.
- Refresh when expiry within 5 minutes.
- 429: backoff 1s/2s/4s then throw `OuraRateLimited`.
- 401: refresh + retry once. If still 401, probe `/personal_info`. If probe works, throw `OuraEndpointGated(path)`. If probe also 401s, throw `OuraAccountUnavailable`. If refresh itself fails, throw `OuraReauthRequired`.
- `request<T>(path, query?)` — single resource or list.
- `requestList<T>(path, query?)` — typed list response `{data: T[], next_token?: string}`.
- `collectAll<T>(path, query?)` — auto-paginate via `next_token`.

Construct per tool invocation: `new OuraClient(env, props.ouraUserId)`. Don't share across tools — concurrent calls inside one tool execution share an instance (which has cached state).

## Timezones

The server runs in UTC. Oura attributes daily docs to the **user's local day** (day of wake-up for sleep, calendar day for activity). Don't try to compute "today" server-side — the LLM has the user's local date in its system prompt.

Tools accept dates as strict `YYYY-MM-DD` (regex-enforced in the Zod schema). Tool descriptions explicitly tell the model to compute from the user's local date and never pass `"today"`/`"yesterday"` sentinels.

The one exception is `get_last_night_sleep`, which uses server UTC `today()` to compute a 2-day query window. The 2-day buffer covers any timezone offset, and the picker selects by `bedtime_end` so the user's actual last night is always the most recent qualifying period.

## Encryption

Per-user AES-GCM keys derived via HKDF-SHA256 from `ENCRYPTION_SECRET` (base64-encoded 32 bytes) + the userId as salt + a fixed info string. Stored format is `base64(IV ‖ ciphertext)` with a 12-byte random IV per write.

If `ENCRYPTION_SECRET` is lost, all stored tokens become undecryptable. Users would re-authenticate. The local backup is in `.dev.vars` (gitignored).

## Deploy

```bash
npx wrangler deploy
```

Account ID and KV namespace IDs are in `wrangler.jsonc`. Secrets are managed out-of-band:

```bash
echo -n "$VALUE" | npx wrangler secret put OURA_CLIENT_ID
# repeat for OURA_CLIENT_SECRET, ENCRYPTION_SECRET, OAUTH_PROVIDER_ENCRYPTION_KEY
```

Custom domain `mcp-oura.smirnov.link` is configured via `routes` in `wrangler.jsonc` with `custom_domain: true`. Works automatically because `smirnov.link` is in the same CF account.

For local dev: `cp .dev.vars.example .dev.vars`, fill in, `npm run dev`. The Oura redirect URI is a single value, so local dev typically uses `wrangler dev --remote` against the production redirect.

## Gotchas

- **wrangler.jsonc not .toml.** Spec said `.toml`; we use `.jsonc` to match the YNAB sister project.
- **DO binding is `MCP_OBJECT`, not `MCP_AGENT`.** Same reason.
- **`agents` bundles its own MCP SDK.** Pin `@modelcontextprotocol/sdk` to whatever `agents` deps to (currently `1.28.0` for `agents@0.8.7`). Mismatched versions cause private-field type incompatibility on `McpServer.server._serverInfo`.
- **KV namespace titles are global per account.** When running `wrangler kv namespace create OAUTH_KV` in a CF account that already has another worker's `OAUTH_KV`, you'll collide. Use worker-prefixed titles like `mcpforoura-OAUTH_KV`. Binding name in `wrangler.jsonc` can stay as `OAUTH_KV` — bindings are per-worker.
- **Multi-account CF login.** Add `"account_id": "<id>"` to `wrangler.jsonc` so commands aren't ambiguous.
- **First deploy registers the worker.** `wrangler secret put` works after that.
- **`FormDataEntryValue` is a DOM type.** Not in `lib: ["es2021"]`. Use `string | File | null` for `formData.get(...)` returns.
- **The OAuth provider's `props` field is how user identity flows from callback to McpAgent.** Inside the agent, `this.props.ouraUserId` is set; outside, it's `undefined`.

## Status

Built so far (M1–M6 of the original spec):
- ✅ Scaffold, OAuth provider, Hono consent, Oura OAuth flow B, encrypted tokens, OuraClient with refresh/disambig/backoff
- ✅ Tools: `ping`, `_internal_personal_info`, `get_daily_summary`, `get_date_range`, `get_last_night_sleep`

Pending:
- M7 — KV response cache with date-aware TTLs
- M8 — `get_workouts`, `get_sessions`, `get_heart_rate_series`, `get_tags`, `compare_to_baseline`
- M9 — Vitest tests, deploy-docs polish

The original spec lives in the project's brainstorming notes; the high-value pieces are encoded above.
