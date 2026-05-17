# Phase 2 (Tier A wrappers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add 7 daily-metric tools that surface Oura endpoints we have OAuth scopes for but haven't exposed yet — stress, spo2, resilience, cardiovascular age, VO2 max, recommended sleep time, and rest-mode periods.

**Architecture:** Each tool is a thin wrapper around one Oura endpoint, following the existing `get_daily_summary` shape: take a date (or date range), call the endpoint via `OuraClient.request`/`collectAll`, return a shaped JSON object (or `{available: false, reason}` when Oura returns no data). All ride the M7 KV cache transparently.

**Tech Stack:** TypeScript, Zod, no new deps.

Reference: `docs/superpowers/specs/2026-05-16-tool-expansion-design.md` Phase 2 section for response shapes. Plan 1 (`2026-05-16-phase-1-m8-tools.md`) is the canonical example for the per-tool file structure.

---

## Endpoint path uncertainty

Several Phase 2 paths are best-guesses based on Oura's naming conventions. **If a path 404s in production, mark the tool with a note in its description and update the path in a follow-up.** Per the nonstop workaround policy: skip and document, don't stop.

| Tool | Best-guess path | Confidence |
|---|---|---|
| `get_stress` | `/usercollection/daily_stress` | high (follows `daily_*` pattern) |
| `get_spo2` | `/usercollection/daily_spo2` | high |
| `get_resilience` | `/usercollection/daily_resilience` | high |
| `get_cardio_age` | `/usercollection/daily_cardiovascular_age` | high |
| `get_vo2_max` | `/usercollection/vO2_max` | medium (note camelCase per Oura's metric name) |
| `get_recommended_sleep_time` | `/usercollection/sleep_time` | medium |
| `get_rest_mode_periods` | `/usercollection/rest_mode_period` | medium |

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/oura/types.ts` | modify | Add type definitions for: `DailyStress`, `DailySpO2`, `DailyResilience`, `DailyCardiovascularAge`, `VO2MaxSample`, `RecommendedSleepTime`, `RestModePeriod`. Keep `[key: string]: unknown` index signatures for forward compat. |
| `src/mcp/tools/get-stress.ts` | create | daily_stress wrapper |
| `src/mcp/tools/get-spo2.ts` | create | daily_spo2 wrapper |
| `src/mcp/tools/get-resilience.ts` | create | daily_resilience wrapper |
| `src/mcp/tools/get-cardio-age.ts` | create | daily_cardiovascular_age wrapper |
| `src/mcp/tools/get-vo2-max.ts` | create | vO2_max — query 30-day window ending on `date`, return most recent measurement |
| `src/mcp/tools/get-recommended-sleep-time.ts` | create | sleep_time wrapper — converts the optimal_bedtime seconds-from-midnight offset to a human-readable `HH:MM` |
| `src/mcp/tools/get-rest-mode-periods.ts` | create | rest_mode_period range query |
| `src/mcp/registerTools.ts` | modify | Register the 7 new tools using the existing `clientTool` helper. |

No new test files required for Phase 2 — the tools are mechanical wrappers and rely on type-check + dry-run + spec-shape adherence. Phase 4 will add integration tests that cover the daily-metric path end-to-end.

## Invariants

1. **Strict YYYY-MM-DD date inputs** with regex enforcement on schemas, except `get_rest_mode_periods` which takes `{start, end}` for a range.
2. **All tools use `OuraClient.request`/`collectAll`** so they ride the M7 cache.
3. **Each tool returns `{available: false, reason}` if the API returns no document for the requested day.** This matches the `get_last_night_sleep` pattern.
4. **Tool descriptions explicitly state "LOCAL date"** for any tool taking a YYYY-MM-DD input — same convention established in M6.

---

## Task 1: Add types to `src/oura/types.ts`

**Files:** Modify `src/oura/types.ts`

Append the following at the end of the file:

```typescript
export interface DailyStress {
  id: string;
  day: string;
  stress_high?: number | null;        // seconds in high-stress state
  recovery_high?: number | null;      // seconds in high-recovery state
  day_summary?: string | null;        // "restored" | "normal" | "stressful"
  [key: string]: unknown;
}

export interface DailySpO2 {
  id: string;
  day: string;
  spo2_percentage?: { average: number | null } | null;
  breathing_disturbance_index?: number | null;
  [key: string]: unknown;
}

export interface DailyResilience {
  id: string;
  day: string;
  level?: string | null;              // "limited"|"adequate"|"solid"|"strong"|"exceptional"
  contributors?: {
    sleep_recovery?: number | null;
    daytime_recovery?: number | null;
    stress?: number | null;
  } | null;
  [key: string]: unknown;
}

export interface DailyCardiovascularAge {
  id: string;
  day: string;
  vascular_age?: number | null;
  [key: string]: unknown;
}

export interface VO2MaxSample {
  id: string;
  day: string;
  vo2_max?: number | null;
  timestamp?: string | null;
  [key: string]: unknown;
}

export interface RecommendedSleepTime {
  id: string;
  day: string;
  optimal_bedtime?: { start_offset?: number; end_offset?: number; day_tz?: number } | null;
  status?: string | null;
  recommendation?: string | null;
  [key: string]: unknown;
}

export interface RestModePeriod {
  id: string;
  start_day: string;
  end_day?: string | null;
  episode_type?: string | null;
  [key: string]: unknown;
}
```

Commit:

```bash
git add src/oura/types.ts
git commit -m "types: Phase 2 endpoint shapes (stress/spo2/resilience/cardio_age/vo2_max/sleep_time/rest_mode)"
```

---

## Task 2: `get_stress`

Create `src/mcp/tools/get-stress.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyStress } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getStressSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetStressInput {
  date: string;
}

export interface GetStressResult {
  date: string;
  available: boolean;
  stress_high_seconds?: number | null;
  recovery_high_seconds?: number | null;
  day_summary?: string | null;
  reason?: string;
}

export async function executeGetStress(
  client: OuraClient,
  input: GetStressInput
): Promise<GetStressResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyStress>("/usercollection/daily_stress", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_stress data for this date." };
  }
  return {
    date,
    available: true,
    stress_high_seconds: doc.stress_high ?? null,
    recovery_high_seconds: doc.recovery_high ?? null,
    day_summary: doc.day_summary ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-stress.ts
git commit -m "tools: get_stress (daily_stress wrapper)"
```

---

## Task 3: `get_spo2`

Create `src/mcp/tools/get-spo2.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailySpO2 } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getSpo2Schema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetSpo2Input {
  date: string;
}

export interface GetSpo2Result {
  date: string;
  available: boolean;
  average_oxygen_pct?: number | null;
  breathing_disturbance_index?: number | null;
  reason?: string;
}

export async function executeGetSpo2(
  client: OuraClient,
  input: GetSpo2Input
): Promise<GetSpo2Result> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailySpO2>("/usercollection/daily_spo2", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_spo2 data for this date." };
  }
  return {
    date,
    available: true,
    average_oxygen_pct: doc.spo2_percentage?.average ?? null,
    breathing_disturbance_index: doc.breathing_disturbance_index ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-spo2.ts
git commit -m "tools: get_spo2 (daily_spo2 wrapper)"
```

---

## Task 4: `get_resilience`

Create `src/mcp/tools/get-resilience.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyResilience } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getResilienceSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetResilienceInput {
  date: string;
}

export interface GetResilienceResult {
  date: string;
  available: boolean;
  level?: string | null;
  contributors?: DailyResilience["contributors"];
  reason?: string;
}

export async function executeGetResilience(
  client: OuraClient,
  input: GetResilienceInput
): Promise<GetResilienceResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyResilience>("/usercollection/daily_resilience", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_resilience data for this date." };
  }
  return {
    date,
    available: true,
    level: doc.level ?? null,
    contributors: doc.contributors ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-resilience.ts
git commit -m "tools: get_resilience (daily_resilience wrapper)"
```

---

## Task 5: `get_cardio_age`

Create `src/mcp/tools/get-cardio-age.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyCardiovascularAge } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getCardioAgeSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetCardioAgeInput {
  date: string;
}

export interface GetCardioAgeResult {
  date: string;
  available: boolean;
  vascular_age_years?: number | null;
  reason?: string;
}

export async function executeGetCardioAge(
  client: OuraClient,
  input: GetCardioAgeInput
): Promise<GetCardioAgeResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyCardiovascularAge>(
    "/usercollection/daily_cardiovascular_age",
    {
      start_date: date,
      end_date: date,
    }
  );
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_cardiovascular_age data for this date." };
  }
  return {
    date,
    available: true,
    vascular_age_years: doc.vascular_age ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-cardio-age.ts
git commit -m "tools: get_cardio_age (daily_cardiovascular_age wrapper)"
```

---

## Task 6: `get_vo2_max`

Returns the most recent VO2 max measurement in a 30-day window ending on `date`.

Create `src/mcp/tools/get-vo2-max.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { VO2MaxSample } from "../../oura/types.js";
import { resolveDate, shiftDate } from "./dates.js";

export const getVo2MaxSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date. Returns the most recent VO2 max within 30 days of this date."),
};

export interface GetVo2MaxInput {
  date: string;
}

export interface GetVo2MaxResult {
  date_queried: string;
  available: boolean;
  measurement_date?: string;
  vo2_max?: number | null;
  reason?: string;
}

export async function executeGetVo2Max(
  client: OuraClient,
  input: GetVo2MaxInput
): Promise<GetVo2MaxResult> {
  const date = resolveDate(input.date);
  const start = shiftDate(date, -29);
  const docs = await client.collectAll<VO2MaxSample>("/usercollection/vO2_max", {
    start_date: start,
    end_date: date,
  });
  if (docs.length === 0) {
    return {
      date_queried: date,
      available: false,
      reason: "No VO2 max measurements in the past 30 days. Oura computes VO2 max from outdoor walks/runs.",
    };
  }
  // Most recent first
  docs.sort((a, b) => (a.day < b.day ? 1 : -1));
  const latest = docs[0];
  return {
    date_queried: date,
    available: true,
    measurement_date: latest.day,
    vo2_max: latest.vo2_max ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-vo2-max.ts
git commit -m "tools: get_vo2_max (most recent VO2 max in 30-day window)"
```

---

## Task 7: `get_recommended_sleep_time`

Converts `optimal_bedtime.start_offset` and `end_offset` (seconds from midnight in user-local time) to human-readable `HH:MM` strings.

Create `src/mcp/tools/get-recommended-sleep-time.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { RecommendedSleepTime } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getRecommendedSleepTimeSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetRecommendedSleepTimeInput {
  date: string;
}

export interface GetRecommendedSleepTimeResult {
  date: string;
  available: boolean;
  optimal_bedtime_start?: string;        // HH:MM
  optimal_bedtime_end?: string;          // HH:MM
  status?: string | null;
  recommendation?: string | null;
  reason?: string;
}

function offsetToHHMM(offsetSeconds: number | undefined | null): string | undefined {
  if (typeof offsetSeconds !== "number") return undefined;
  // Normalize into [0, 86400)
  let s = ((offsetSeconds % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function executeGetRecommendedSleepTime(
  client: OuraClient,
  input: GetRecommendedSleepTimeInput
): Promise<GetRecommendedSleepTimeResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<RecommendedSleepTime>(
    "/usercollection/sleep_time",
    { start_date: date, end_date: date }
  );
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No recommended sleep_time entry for this date." };
  }
  const start = offsetToHHMM(doc.optimal_bedtime?.start_offset);
  const end = offsetToHHMM(doc.optimal_bedtime?.end_offset);
  return {
    date,
    available: true,
    optimal_bedtime_start: start,
    optimal_bedtime_end: end,
    status: doc.status ?? null,
    recommendation: doc.recommendation ?? null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-recommended-sleep-time.ts
git commit -m "tools: get_recommended_sleep_time (sleep_time with HH:MM conversion)"
```

---

## Task 8: `get_rest_mode_periods`

Range query — returns all rest-mode periods overlapping the date range.

Create `src/mcp/tools/get-rest-mode-periods.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { RestModePeriod } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getRestModePeriodsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 365 days."),
};

export interface GetRestModePeriodsInput {
  start: string;
  end: string;
}

export interface RestModePeriodOut {
  start_day: string;
  end_day: string | null;
  duration_days: number | null;
  episode_type: string | null;
}

export interface GetRestModePeriodsResult {
  periods: RestModePeriodOut[];
}

const MAX_DAYS = 365;

export async function executeGetRestModePeriods(
  client: OuraClient,
  input: GetRestModePeriodsInput
): Promise<GetRestModePeriodsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS) throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<RestModePeriod>(
    "/usercollection/rest_mode_period",
    { start_date: input.start, end_date: input.end }
  );

  const periods: RestModePeriodOut[] = docs.map((p) => ({
    start_day: p.start_day,
    end_day: p.end_day ?? null,
    duration_days:
      p.end_day && p.start_day ? daysBetween(p.start_day, p.end_day) + 1 : null,
    episode_type: p.episode_type ?? null,
  }));
  periods.sort((a, b) => (a.start_day < b.start_day ? -1 : 1));
  return { periods };
}
```

Commit:

```bash
git add src/mcp/tools/get-rest-mode-periods.ts
git commit -m "tools: get_rest_mode_periods (rest_mode_period range query)"
```

---

## Task 9: Register all 7 tools

**Files:** Modify `src/mcp/registerTools.ts`

Add imports at the top alongside the existing tool imports:

```typescript
import { getStressSchema, executeGetStress } from "./tools/get-stress.js";
import { getSpo2Schema, executeGetSpo2 } from "./tools/get-spo2.js";
import { getResilienceSchema, executeGetResilience } from "./tools/get-resilience.js";
import { getCardioAgeSchema, executeGetCardioAge } from "./tools/get-cardio-age.js";
import { getVo2MaxSchema, executeGetVo2Max } from "./tools/get-vo2-max.js";
import { getRecommendedSleepTimeSchema, executeGetRecommendedSleepTime } from "./tools/get-recommended-sleep-time.js";
import { getRestModePeriodsSchema, executeGetRestModePeriods } from "./tools/get-rest-mode-periods.js";
```

In `registerOuraTools`, after the existing tool registrations, add:

```typescript
server.registerTool(
  "get_stress",
  {
    title: "Daily Stress",
    description:
      "Get daily stress metrics (high-stress and recovery seconds) for a date. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getStressSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetStress)
);

server.registerTool(
  "get_spo2",
  {
    title: "Daily SpO2",
    description:
      "Get nightly blood-oxygen (SpO2) average and breathing disturbance index for a date. Useful for altitude effects, suspected sleep apnea, or illness tracking. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getSpo2Schema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetSpo2)
);

server.registerTool(
  "get_resilience",
  {
    title: "Daily Resilience",
    description:
      "Get the resilience score for a date — Oura's long-term stress recovery capacity metric. Levels: limited / adequate / solid / strong / exceptional. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getResilienceSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetResilience)
);

server.registerTool(
  "get_cardio_age",
  {
    title: "Cardiovascular Age",
    description:
      "Get Oura's cardiovascular-age estimate for a date — a heart-health proxy derived from HRV, resting HR, and other signals. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getCardioAgeSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetCardioAge)
);

server.registerTool(
  "get_vo2_max",
  {
    title: "VO2 Max",
    description:
      "Get the most recent VO2 max measurement within 30 days of the queried date. Oura computes VO2 max from outdoor walks/runs, so measurements may be sparse. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getVo2MaxSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetVo2Max)
);

server.registerTool(
  "get_recommended_sleep_time",
  {
    title: "Recommended Sleep Time",
    description:
      "Get Oura's recommended bedtime window for a date as start/end HH:MM in user's local time, with a status and recommendation field. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getRecommendedSleepTimeSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetRecommendedSleepTime)
);

server.registerTool(
  "get_rest_mode_periods",
  {
    title: "Rest Mode Periods",
    description:
      "List rest-mode periods (illness/recovery markers) over a date range. Pass user's LOCAL dates as strict YYYY-MM-DD; max 365-day range.",
    inputSchema: getRestModePeriodsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetRestModePeriods)
);
```

Then:

```bash
npm run type-check
npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle
git add src/mcp/registerTools.ts
git commit -m "register: wire up Phase 2 — 7 Tier A daily-metric tools"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| get_stress (daily_stress) | Task 2 |
| get_spo2 (daily_spo2) | Task 3 |
| get_resilience (daily_resilience) | Task 4 |
| get_cardio_age (daily_cardiovascular_age) | Task 5 |
| get_vo2_max (vO2_max, most recent in window) | Task 6 |
| get_recommended_sleep_time (sleep_time, HH:MM conversion) | Task 7 |
| get_rest_mode_periods (rest_mode_period range) | Task 8 |
| All tools use M7 cache via OuraClient | Tasks 2-8 (use request/collectAll) |
| `{available: false, reason}` on no data | Tasks 2-7 (single-day tools) |
| Strict YYYY-MM-DD on date inputs | Tasks 2-8 (regex enforced) |
| Registered in registerTools.ts | Task 9 |

## Anticipated issues

1. **Endpoint paths may 404.** If any of the 7 paths return 404 in production, document in the tool description ("currently unavailable — endpoint path under investigation") and the path will be fixed in a follow-up. Do NOT block on this during implementation; deploy and discover.
2. **`daily_stress` field names** — Oura may use `high_stress_time` and `recovery_time` instead of `stress_high` and `recovery_high`. The shape allows either via index signature; just verify with a test call after deploy.
3. **`vO2_max` casing** — if `/vO2_max` 404s, try `/vo2_max` (snake_case). If both 404, document.
4. **`sleep_time.optimal_bedtime`** — field may be nested differently. The code handles `null` gracefully via optional chaining.
