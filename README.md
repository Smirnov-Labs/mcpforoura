# mcpforoura

Hosted remote MCP server for Oura Ring, deployed at `https://mcp-oura.smirnov.link/mcp`. Multi-tenant OAuth via `@cloudflare/workers-oauth-provider`; each user authenticates to their own Oura account. Read-only.

## Tools

Eight tools covering daily summaries, ranged trends, last-night sleep, workouts, mindfulness sessions, intraday heart-rate, tags, and personal-baseline comparison. See `docs/` for tool reference.

## Setup (operator)

1. Create the Oura developer application:
   - https://cloud.ouraring.com → API Applications → New
   - Redirect URI: `https://mcp-oura.smirnov.link/oura/callback`
   - Store the issued Client ID / Secret.

2. Create Cloudflare KV namespaces and paste IDs into `wrangler.jsonc`:
   ```
   wrangler kv namespace create OAUTH_KV
   wrangler kv namespace create OURA_TOKENS
   wrangler kv namespace create OURA_CACHE
   ```

3. Set secrets:
   ```
   wrangler secret put OURA_CLIENT_ID
   wrangler secret put OURA_CLIENT_SECRET
   wrangler secret put ENCRYPTION_SECRET                # openssl rand -base64 32
   wrangler secret put COOKIE_SECRET                    # openssl rand -base64 32
   wrangler secret put OAUTH_PROVIDER_ENCRYPTION_KEY    # openssl rand -base64 32
   ```

4. Deploy: `npm run deploy`

5. Map the custom domain `mcp-oura.smirnov.link` to the worker in the Cloudflare dashboard.

## Setup (user)

In Claude → Settings → Connectors → Add custom: `https://mcp-oura.smirnov.link/mcp`. Approve the MCP authorization, then complete Oura's OAuth consent.

## Development

```
cp .dev.vars.example .dev.vars   # fill in
npm install
npm run dev
```

Local dev requires the Oura redirect URI to match the deployed value; use a tunnel (`cloudflared`) or `wrangler dev --remote` against the prod redirect.
