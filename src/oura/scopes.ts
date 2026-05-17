// Minimal scope set — request only what the exposed tools use. Oura requires
// scope minimization for production approval.
//  - personal: required by /personal_info probe (401-disambiguation only — we
//    do not surface personal_info to MCP clients).
//  - daily: covers daily_sleep/readiness/activity/stress/spo2/resilience/
//    cardiovascular_age.
//  - heartrate: get_heart_rate_series.
//  - workout, session, tag: get_workouts / get_sessions / get_tags.
//  - spo2: get_spo2 (separately granted even though daily_spo2 is under daily).
//  - stress: get_stress.
//  - heart_health: get_cardio_age + VO2 max.
// Intentionally dropped:
//  - email: not surfaced anywhere.
//  - ring_configuration: no tool uses it.
export const OURA_SCOPES = [
  "personal",
  "daily",
  "heartrate",
  "workout",
  "session",
  "tag",
  "spo2",
  "stress",
  "heart_health",
] as const;

export const OURA_SCOPE_STRING = OURA_SCOPES.join(" ");
