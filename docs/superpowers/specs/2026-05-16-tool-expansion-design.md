# Tool Expansion Design — mcpforoura v2

**Date:** 2026-05-16
**Status:** proposed
**Author:** Claude + Ivan Smirnov

## Goal

Expand mcpforoura from the 5 currently-live tools (M1–M6) to 21 tools total, covering:

1. The original 8-tool spec (M8 finishes this — 5 tools).
2. All metric endpoints we have OAuth scopes for but haven't surfaced yet (7 tools).
3. Two composite tools that aggregate common multi-fetch questions (2 tools).
4. Two analytics tools for anomaly detection + tag/metric correlation (2 tools).

## Non-goals

- **Write operations.** No tool creates, edits, or deletes Oura data. Read-only stays the rule.
- **Webhook subscriptions.** Polling on demand only.
- **New OAuth scopes.** Work within what the Oura developer app already has enabled (`email, personal, daily, heartrate, workout, session, tag, spo2, ring_configuration, stress, heart_health`).
- **Server-side ML/insights.** The server returns shaped data; the LLM reasons and narrates.

## Design decisions locked

1. **Each Oura daily metric gets its own tool** (not merged as scopes on `get_daily_summary`). Reason: per-tool descriptions can be tuned to the metric's use case, which improves LLM tool-selection accuracy. The cost is more tools for the LLM to weigh; we accept that for explicit-purpose surfaces.
2. **Composite tools are neutral.** `get_morning_briefing` and `get_weekly_recap` return structured raw data, no server-side ranking or highlighting. The LLM decides what to surface. Reason: keeps the server stateless and rewards the model's existing curation strengths.
3. **Dates are user-local YYYY-MM-DD.** Same convention as v1: strict ISO regex on inputs, no `today`/`yesterday` aliases. The model resolves from its system-prompt local date.
4. **Errors stay structured.** Continue using the `errors.ts` discriminated types: `OuraReauthRequired`, `OuraEndpointGated`, `OuraAccountUnavailable`, `OuraRateLimited`, `OuraInsufficientBaseline`, `OuraInvalidInput`. Tools convert to `{ isError: true, content: [{ type: "text", text: JSON.stringify({code, message}) }] }`.

## Tools to add (16 new + 1 internal probe)

### Phase 1 — Finish the original spec (5 tools)

Already designed in the v1 spec (sections 8–9). No new design work, just implementation.

| Tool | Endpoint | Inputs | Returns |
|---|---|---|---|
| `get_workouts` | `/usercollection/workout` | `start, end` (YYYY-MM-DD) | `{workouts: [{date, activity, start_datetime, end_datetime, duration_min, calories, intensity, distance_m?, source}]}` |
| `get_sessions` | `/usercollection/session` | `start, end` | `{sessions: [{date, type, duration_min, start_datetime, end_datetime, mood_before?, mood_after?}]}` |
| `get_heart_rate_series` | `/usercollection/heartrate` | `start, end` (ISO 8601 datetime), `resolution: "raw" \| "5min" \| "15min"` (default `5min`); max 24h window | `{points: [{timestamp, bpm, source}]}` |
| `get_tags` | `/usercollection/enhanced_tag` | `start, end` | `{tags: [{date, tag_type_code, custom_name?, comment?, start_time?, end_time?}]}` |
| `compare_to_baseline` | `/daily_sleep`, `/daily_readiness`, `/daily_activity`, `/sleep` | `metric, date?` (default today) | `{metric, date, value, p30_mean, p30_stdev, p90_mean, p90_stdev, delta_from_p30_pct, percentile_in_p90}` or `{insufficient_baseline, days_with_data}` if <14 valid days |

### Phase 2 — Per-metric Tier A wrappers (7 tools)

Each follows the `get_daily_summary` shape: takes one date, fetches one Oura endpoint, returns the shaped doc or `{available: false, reason}`. All share an `_internal_probe` mini-tool internally to help debug new endpoint paths during dev.

| Tool | Endpoint | Returns |
|---|---|---|
| `get_stress` | `/usercollection/daily_stress` | `{date, stress_high_seconds, recovery_high_seconds, day_summary: "restored" \| "normal" \| "stressful"}` |
| `get_spo2` | `/usercollection/daily_spo2` | `{date, average_oxygen_pct, breathing_disturbance_index?}` |
| `get_resilience` | `/usercollection/daily_resilience` | `{date, level: "limited"\|"adequate"\|"solid"\|"strong"\|"exceptional", contributors: {sleep_recovery, daytime_recovery, stress}}` |
| `get_cardio_age` | `/usercollection/daily_cardiovascular_age` | `{date, vascular_age_years}` |
| `get_vo2_max` | `/usercollection/vO2_max` | `{date, vo2_max}` (returns most recent measurement in the queried range) |
| `get_recommended_sleep_time` | `/usercollection/sleep_time` | `{date, optimal_bedtime_start_offset_min, optimal_bedtime_end_offset_min, status, recommendation: "earlier_bedtime"\|"later_bedtime"\|"good_to_go"\|...}` |
| `get_rest_mode_periods` | `/usercollection/rest_mode_period` | `{periods: [{start_day, end_day?, duration_days, episode_type}]}` over a date range |

For each new endpoint, the first dev step is to hit `_internal_probe(path)` with a known-valid date to confirm the schema before writing the shaping function.

### Phase 3 — Composite tools (2 tools)

Both fetch 2–3 endpoints in parallel via `OuraClient` and return the union as structured JSON.

#### `get_morning_briefing`

Inputs: `{date: "YYYY-MM-DD"}` (user's local today)

Behavior: parallel fan-out across `daily_readiness(date)`, `daily_sleep(date-1)`, `daily_activity(date-1)`, `daily_stress(date-1)`, `sleep_time(date)`, `enhanced_tag(date-1, date-1)`. Returns:

```json
{
  "today": {
    "date": "YYYY-MM-DD",
    "readiness": { ...shape from get_daily_summary.readiness... } | null,
    "recommended_sleep_time": { ... } | null
  },
  "yesterday": {
    "date": "YYYY-MM-DD",
    "sleep": { ... } | null,
    "activity": { ... } | null,
    "stress": { ... } | null,
    "tags": [ ... ]
  }
}
```

No prose. No ranking. LLM curates which fields to highlight.

#### `get_weekly_recap`

Inputs: `{end_date: "YYYY-MM-DD", days?: number}` — default 7 days, max 28.

Behavior: pulls each daily endpoint over the window and computes per-metric mean/min/max. Returns:

```json
{
  "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "days": 7 },
  "daily": [
    { "date": "YYYY-MM-DD", "sleep_score": 86, "readiness_score": 85, "activity_score": 89, "stress_high_sec": 4200, "hrv": 68, "resting_hr": 51, "total_sleep_hours": 7.4 },
    ...
  ],
  "stats": {
    "sleep_score": { "mean": 84.3, "min": 72, "max": 92 },
    "readiness_score": { "mean": 86.1, "min": 78, "max": 94 },
    ...
  }
}
```

### Phase 4 — Analytics tools (2 tools)

#### `find_anomalies`

Inputs: `{metric, end_date, lookback_days?: 90, threshold_sigma?: 2}`

Behavior: pulls the metric over the lookback window, computes rolling baseline (excluding the day under test), returns days where `|z-score| > threshold_sigma`.

```json
{
  "metric": "hrv",
  "window": { "start": "...", "end": "...", "days": 90 },
  "baseline": { "mean": 65.2, "stdev": 8.1, "non_null_days": 87 },
  "anomalies": [
    { "date": "2026-05-16", "value": 49, "deviation_sigma": -2.0, "direction": "low" }
  ]
}
```

If `non_null_days < 14` → return `OuraInsufficientBaseline` error.

#### `correlate_tag_with_metric`

Inputs: `{tag_type_code? | custom_name?, metric, lookback_days?: 90}` — exactly one of `tag_type_code` or `custom_name`.

Behavior: pulls `enhanced_tag` over lookback. For each day, mark as tagged (a matching tag exists with `start_day == date`) or untagged. Compute group stats on the chosen metric.

```json
{
  "tag": { "tag_type_code": "alcohol", "custom_name": null },
  "metric": "sleep_score",
  "window": { "start": "...", "end": "...", "days": 90 },
  "tagged": { "n": 8, "mean": 71.2, "median": 73, "stdev": 6.1 },
  "untagged": { "n": 75, "mean": 84.3, "median": 85, "stdev": 7.4 },
  "mean_delta_pct": -15.5,
  "small_sample_warning": false
}
```

If either `tagged.n < 5` or `untagged.n < 5` → set `small_sample_warning: true`. LLM is responsible for not over-interpreting.

## Implementation order

1. **M7 — KV cache layer first.** Adding 16 tools without caching would risk hitting Oura's 5000/5min/user ceiling during normal exploratory use. M7 unblocks volume.
2. **Phase 1 — finish original spec.** Largest single user-visible jump; closes M8.
3. **Phase 2 — Tier A wrappers.** Each is ~30 min. Implement in pairs, deploy after each pair.
4. **Phase 3 — composites.** Need M7 done so each composite doesn't re-fetch on every call.
5. **Phase 4 — analytics.** Depends on Phase 1 (`compare_to_baseline`'s statistical helpers can be reused).
6. **M9 — tests + deploy-docs polish.**

## Open questions

1. **Endpoint path verification.** Exact casing/spelling of `vO2_max`, `sleep_time`, `rest_mode_period` paths needs live API confirmation. Resolution: during implementation, the first step on each new tool is to hit `_internal_probe(path)` with a known-good date and confirm response shape before writing the shaping function. If a path 404s, fix and document in `gotchas` for the cf-mcp-server skill.
2. **`get_stress` field names.** Oura's daily_stress shape has shifted between API versions; verify `stress_high` field name (vs `high_stress_minutes`, etc.) during impl.
3. **`get_recommended_sleep_time` semantics.** The `optimal_bedtime` field is an offset in seconds from midnight in user-local time, not a clock time. Tool should convert to a human-readable `HH:MM` for both start and end.
4. **Cache TTLs for new daily endpoints.** Use the same TTL table as v1 (today=5min, yesterday=1h, historical=24h). `vO2_max` and `rest_mode_period` get 24h regardless since they change rarely.

## Out of scope for v2

These are interesting but explicitly deferred:

- `get_period_overview` (menstrual cycle phase) — requires additional scope discussion.
- Cross-MCP-connector composite tools (e.g., "compare Oura readiness with my YNAB stress-spending days") — belongs in a separate orchestration layer, not in Oura's MCP.
- Server-side anomaly explanation (LLM-generated "why" text per anomaly) — keep the server pure data; LLM explains.

## References

- v1 spec: in conversation transcript (the original brief).
- mcpforoura code: `/home/vania/Projects/smirnovlabs/mcpforoura`, repo `Smirnov-Labs/mcpforoura`.
- Reusable scaffold skill: `Smirnov-Labs/internal-skills` → `skills/building-cf-mcp-server`.
- Oura API v2 docs: https://cloud.ouraring.com/v2/docs (JS-rendered; verify against live API during impl).
