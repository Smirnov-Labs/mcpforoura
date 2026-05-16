export class OuraReauthRequired extends Error {
  readonly code = "oura_reauth_required";
  constructor() {
    super(
      "Your Oura connection has expired or been revoked. Please remove and re-add the MCP server in your client to reconnect."
    );
  }
}

export class OuraAccountUnavailable extends Error {
  readonly code = "oura_account_unavailable";
  constructor() {
    super(
      "Your Oura access token is valid, but the API isn't returning data. This usually means your Oura account lacks active membership (required for Gen3/Ring 4 API access) or the ring hasn't synced recently."
    );
  }
}

export class OuraEndpointGated extends Error {
  readonly code = "oura_endpoint_gated";
  constructor(public readonly endpoint: string) {
    super(
      `The ${endpoint} endpoint isn't available for this account. New rings have a baseline period before some advanced metrics are exposed, and some endpoints require active Oura membership.`
    );
  }
}

export class OuraRateLimited extends Error {
  readonly code = "oura_rate_limited";
  constructor(public readonly retryAfterSeconds: number) {
    super(`Oura rate limit hit. Try again in ${retryAfterSeconds} seconds.`);
  }
}

export class OuraInsufficientBaseline extends Error {
  readonly code = "oura_insufficient_baseline";
  constructor(public readonly daysWithData: number) {
    super(`Not enough historical data for this analysis (only ${daysWithData} days available).`);
  }
}

export class OuraInvalidInput extends Error {
  readonly code = "oura_invalid_input";
  constructor(message: string) {
    super(message);
  }
}
