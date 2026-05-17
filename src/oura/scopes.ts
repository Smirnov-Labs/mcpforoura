export const OURA_SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "session",
  "tag",
  "spo2",
  "ring_configuration",
  "stress",
  "heart_health",
] as const;

export const OURA_SCOPE_STRING = OURA_SCOPES.join(" ");
