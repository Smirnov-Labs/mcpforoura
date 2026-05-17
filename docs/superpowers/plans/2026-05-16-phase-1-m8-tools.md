# Phase 1 (M8 close) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the five remaining tools from the original v1 spec — `get_workouts`, `get_sessions`, `get_heart_rate_series`, `get_tags`, `compare_to_baseline` — plus a reusable `stats.ts` helper module that Phase 4 will also use.

**Architecture:** Each tool gets its own module under `src/mcp/tools/`, registered in `src/mcp/registerTools.ts` via the existing `clientTool` wrapper. Heart-rate series does server-side bucketing for 5/15-min resolutions. `compare_to_baseline` reuses the new stats helpers so Phase 4 can share them.

**Tech Stack:** TypeScript, Zod, `OuraClient.request` / `collectAll` (auto-cached via M7), no new deps.

Reference: `docs/superpowers/specs/2026-05-16-tool-expansion-design.md` Phase 1 section for exact response shapes.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/mcp/tools/stats.ts` | create | Pure stat helpers: `mean`, `stdev`, `percentile`, `nonNullSamples`. Used by both `compare_to_baseline` and (later) Phase 4. |
| `src/mcp/tools/get-workouts.ts` | create | Schema + execute for `/usercollection/workout` range query. |
| `src/mcp/tools/get-sessions.ts` | create | Schema + execute for `/usercollection/session`. |
| `src/mcp/tools/get-tags.ts` | create | Schema + execute for `/usercollection/enhanced_tag`. |
| `src/mcp/tools/get-heart-rate-series.ts` | create | Schema + execute for `/usercollection/heartrate` with server-side bucketing (mean per 5/15 min). |
| `src/mcp/tools/compare-to-baseline.ts` | create | Pulls 90 days of `metric` from the appropriate daily endpoint, computes p30/p90 mean/stdev/percentile, returns the comparison. |
| `src/oura/types.ts` | modify | Add or refine `EnhancedTag` and `Workout` if their existing typing needs adjustment (existing types may be sufficient — verify). |
| `src/mcp/registerTools.ts` | modify | Register the five new tools. |
| `test/stats.test.ts` | create | Unit tests for the stat helpers. |
| `test/heart-rate-bucketing.test.ts` | create | Unit tests for the bucketing function (extracted from `get-heart-rate-series.ts`). |
| `test/compare-to-baseline.test.ts` | create | Unit tests for the comparison logic using a stubbed client. |

## Invariants

1. **Strict YYYY-MM-DD date inputs** with regex enforcement on schemas, as established in M6.
2. **Errors thrown stay as the existing discriminated types** — `OuraInvalidInput` for range-validation problems; the `clientTool` wrapper in `registerTools.ts` converts thrown errors to MCP error content automatically.
3. **`compare_to_baseline` returns `{insufficient_baseline: true, days_with_data: N}`** when fewer than 14 non-null days are available in the 90-day window. Use the existing `OuraInsufficientBaseline` error class only if throwing makes more sense in a specific case; the spec's preference is structured `available=false`-style returns for "no data" so the LLM can narrate gracefully.
4. **Heart-rate series: max 24-hour window.** Reject `end - start > 24h` with `OuraInvalidInput`. Server-side bucket on resolution `"5min"` or `"15min"`; for `"raw"` pass through.
5. **All tools use `OuraClient.request` / `requestList` / `collectAll`** so they ride the M7 cache transparently. Do NOT call `rawCall` directly.
6. **Reuse `clientTool(env, props, handler)`** from `src/mcp/registerTools.ts` for consistent error + JSON wrapping.

---

## Task 1: Stats helpers (`src/mcp/tools/stats.ts`)

**Files:**
- Create: `src/mcp/tools/stats.ts`
- Create: `test/stats.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/stats.ts`**

```typescript
// src/mcp/tools/stats.ts

export function nonNull(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Returns the percentile (0-100) of `value` within `population`. Linear
 * interpolation between sorted samples; returns 0 if value < min, 100 if > max.
 */
export function percentileOf(value: number, population: number[]): number {
  if (population.length === 0) return Number.NaN;
  const sorted = [...population].sort((a, b) => a - b);
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 100;
  // Find rank.
  let below = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else break;
  }
  return +((below / sorted.length) * 100).toFixed(1);
}

export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
```

- [ ] **Step 2: Write `test/stats.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { mean, nonNull, percentileOf, round, stdev } from "../src/mcp/tools/stats";

describe("nonNull", () => {
  it("filters null, undefined, and NaN", () => {
    expect(nonNull([1, null, 2, undefined, Number.NaN, 3])).toEqual([1, 2, 3]);
  });

  it("returns an empty array when no numbers present", () => {
    expect(nonNull([null, undefined, Number.NaN])).toEqual([]);
  });
});

describe("mean", () => {
  it("computes a simple mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("returns NaN on empty input", () => {
    expect(mean([])).toBeNaN();
  });
});

describe("stdev", () => {
  it("computes sample stdev", () => {
    // [2,4,4,4,5,5,7,9] → mean 5, stdev 2.13809...
    expect(round(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 4)).toBe(2.1381);
  });

  it("returns NaN with fewer than 2 samples", () => {
    expect(stdev([])).toBeNaN();
    expect(stdev([3])).toBeNaN();
  });
});

describe("percentileOf", () => {
  it("returns 0 for values at or below min", () => {
    expect(percentileOf(1, [2, 3, 4, 5])).toBe(0);
    expect(percentileOf(2, [2, 3, 4, 5])).toBe(0);
  });

  it("returns 100 for values at or above max", () => {
    expect(percentileOf(5, [2, 3, 4, 5])).toBe(100);
    expect(percentileOf(99, [2, 3, 4, 5])).toBe(100);
  });

  it("computes interior percentile", () => {
    // value=4 in [2,3,4,5,6] → 2 values below → 40%
    expect(percentileOf(4, [2, 3, 4, 5, 6])).toBe(40);
  });

  it("returns NaN on empty population", () => {
    expect(percentileOf(5, [])).toBeNaN();
  });
});

describe("round", () => {
  it("rounds to N decimals", () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(3.155, 2)).toBe(3.16);
  });

  it("passes through non-finite values", () => {
    expect(round(Number.NaN, 2)).toBeNaN();
    expect(round(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
```

- [ ] **Step 3: Verify**

`npm run test:unit` — expect 13 new tests on top of the previous 19 = 32 total passing.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/stats.ts test/stats.test.ts
git commit -m "stats: mean/stdev/percentile/round helpers + tests"
```

---

## Task 2: `get_workouts`

**Files:**
- Create: `src/mcp/tools/get-workouts.ts`

- [ ] **Step 1: Write the tool**

```typescript
// src/mcp/tools/get-workouts.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { Workout } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getWorkoutsSchema = {
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Start date YYYY-MM-DD, user's LOCAL date."),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End date YYYY-MM-DD, user's LOCAL date. Max 180 days."),
};

export interface GetWorkoutsInput {
  start: string;
  end: string;
}

interface WorkoutOut {
  date: string;
  activity: string;
  start_datetime: string;
  end_datetime: string;
  duration_min: number;
  calories: number | null;
  intensity: string;
  distance_m: number | null;
  source: string;
}

export interface GetWorkoutsResult {
  workouts: WorkoutOut[];
}

const MAX_DAYS = 180;

export async function executeGetWorkouts(
  client: OuraClient,
  input: GetWorkoutsInput
): Promise<GetWorkoutsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<Workout>("/usercollection/workout", {
    start_date: input.start,
    end_date: input.end,
  });

  const workouts: WorkoutOut[] = docs.map((w) => {
    const startMs = new Date(w.start_datetime).getTime();
    const endMs = new Date(w.end_datetime).getTime();
    const duration_min =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.round((endMs - startMs) / 60000)
        : 0;
    return {
      date: w.day,
      activity: w.activity,
      start_datetime: w.start_datetime,
      end_datetime: w.end_datetime,
      duration_min,
      calories: w.calories,
      intensity: w.intensity,
      distance_m: w.distance,
      source: w.source,
    };
  });

  workouts.sort((a, b) => (a.start_datetime < b.start_datetime ? -1 : 1));
  return { workouts };
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npm run type-check
git add src/mcp/tools/get-workouts.ts
git commit -m "tools: get_workouts (workout endpoint range query)"
```

---

## Task 3: `get_sessions`

**Files:**
- Create: `src/mcp/tools/get-sessions.ts`

- [ ] **Step 1: Write the tool**

```typescript
// src/mcp/tools/get-sessions.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { OuraSession } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getSessionsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 180 days."),
};

export interface GetSessionsInput {
  start: string;
  end: string;
}

interface SessionOut {
  date: string;
  type: string;
  duration_min: number;
  start_datetime: string;
  end_datetime: string;
  mood_before: string | null;
  mood_after: string | null;
}

export interface GetSessionsResult {
  sessions: SessionOut[];
}

const MAX_DAYS = 180;

export async function executeGetSessions(
  client: OuraClient,
  input: GetSessionsInput
): Promise<GetSessionsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<OuraSession>("/usercollection/session", {
    start_date: input.start,
    end_date: input.end,
  });

  const sessions: SessionOut[] = docs.map((s) => {
    const startMs = new Date(s.start_datetime).getTime();
    const endMs = new Date(s.end_datetime).getTime();
    const duration_min =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.round((endMs - startMs) / 60000)
        : 0;
    return {
      date: s.day,
      type: s.type,
      duration_min,
      start_datetime: s.start_datetime,
      end_datetime: s.end_datetime,
      mood_before: (s as { mood_before?: string | null }).mood_before ?? null,
      mood_after: (s as { mood_after?: string | null }).mood_after ?? null,
    };
  });

  sessions.sort((a, b) => (a.start_datetime < b.start_datetime ? -1 : 1));
  return { sessions };
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npm run type-check
git add src/mcp/tools/get-sessions.ts
git commit -m "tools: get_sessions (mindfulness session range query)"
```

---

## Task 4: `get_tags`

**Files:**
- Create: `src/mcp/tools/get-tags.ts`

- [ ] **Step 1: Write the tool**

```typescript
// src/mcp/tools/get-tags.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { EnhancedTag } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getTagsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 180 days."),
};

export interface GetTagsInput {
  start: string;
  end: string;
}

interface TagOut {
  date: string;
  tag_type_code: string;
  custom_name: string | null;
  comment: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface GetTagsResult {
  tags: TagOut[];
}

const MAX_DAYS = 180;

export async function executeGetTags(
  client: OuraClient,
  input: GetTagsInput
): Promise<GetTagsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<EnhancedTag>("/usercollection/enhanced_tag", {
    start_date: input.start,
    end_date: input.end,
  });

  const tags: TagOut[] = docs.map((t) => ({
    date: t.start_day ?? t.end_day ?? "",
    tag_type_code: t.tag_type_code,
    custom_name: t.custom_name ?? null,
    comment: t.comment ?? null,
    start_time: t.start_time ?? null,
    end_time: t.end_time ?? null,
  }));

  tags.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { tags };
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npm run type-check
git add src/mcp/tools/get-tags.ts
git commit -m "tools: get_tags (enhanced_tag range query)"
```

---

## Task 5: `get_heart_rate_series` with bucketing

**Files:**
- Create: `src/mcp/tools/get-heart-rate-series.ts`
- Create: `test/heart-rate-bucketing.test.ts`

- [ ] **Step 1: Write the tool with extractable `bucketHeartRate` function**

```typescript
// src/mcp/tools/get-heart-rate-series.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { HeartRateSample } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { mean, nonNull, round } from "./stats.js";

const RESOLUTION = z.enum(["raw", "5min", "15min"]);
export type HrResolution = z.infer<typeof RESOLUTION>;

export const getHeartRateSeriesSchema = {
  start: z.string().datetime().describe("Start datetime ISO 8601 (timezone-aware)."),
  end: z.string().datetime().describe("End datetime ISO 8601. Max 24h after start."),
  resolution: RESOLUTION.optional().describe("Default 5min. Use raw for unbucketed."),
};

export interface GetHeartRateSeriesInput {
  start: string;
  end: string;
  resolution?: HrResolution;
}

export interface HrPoint {
  timestamp: string;
  bpm: number;
  source: string;
}

export interface GetHeartRateSeriesResult {
  points: HrPoint[];
}

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

const BUCKET_MS: Record<HrResolution, number> = {
  raw: 0,
  "5min": 5 * 60 * 1000,
  "15min": 15 * 60 * 1000,
};

export function bucketHeartRate(samples: HeartRateSample[], bucketMs: number): HrPoint[] {
  if (bucketMs <= 0 || samples.length === 0) {
    return samples.map((s) => ({ timestamp: s.timestamp, bpm: s.bpm, source: s.source }));
  }
  const buckets = new Map<number, { sum: number[]; source: string }>();
  for (const s of samples) {
    const ms = new Date(s.timestamp).getTime();
    if (!Number.isFinite(ms)) continue;
    const bucketStart = Math.floor(ms / bucketMs) * bucketMs;
    const entry = buckets.get(bucketStart);
    if (entry) {
      entry.sum.push(s.bpm);
    } else {
      buckets.set(bucketStart, { sum: [s.bpm], source: s.source });
    }
  }
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  return sortedKeys.map((k) => {
    const b = buckets.get(k)!;
    const bpm = Math.round(mean(nonNull(b.sum)));
    return {
      timestamp: new Date(k).toISOString(),
      bpm,
      source: b.source,
    };
  });
}

export async function executeGetHeartRateSeries(
  client: OuraClient,
  input: GetHeartRateSeriesInput
): Promise<GetHeartRateSeriesResult> {
  const startMs = new Date(input.start).getTime();
  const endMs = new Date(input.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new OuraInvalidInput("start and end must be ISO-8601 datetimes.");
  }
  if (endMs < startMs) {
    throw new OuraInvalidInput("end must be on or after start.");
  }
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new OuraInvalidInput("Window too large. Max 24 hours.");
  }

  const samples = await client.collectAll<HeartRateSample>("/usercollection/heartrate", {
    start_datetime: input.start,
    end_datetime: input.end,
  });

  const resolution: HrResolution = input.resolution ?? "5min";
  const points = bucketHeartRate(samples, BUCKET_MS[resolution]);
  // round() is unused once we bucket, but we apply Math.round in bucketing.
  void round;
  return { points };
}
```

- [ ] **Step 2: Write bucketing unit tests**

```typescript
// test/heart-rate-bucketing.test.ts
import { describe, expect, it } from "vitest";
import { bucketHeartRate } from "../src/mcp/tools/get-heart-rate-series";

describe("bucketHeartRate", () => {
  it("returns raw passthrough with bucketMs=0", () => {
    const samples = [
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:01:00Z", bpm: 62, source: "sleep" },
    ];
    expect(bucketHeartRate(samples, 0)).toEqual(samples);
  });

  it("groups samples within a 5-minute bucket and averages bpm", () => {
    const samples = [
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:02:00Z", bpm: 64, source: "sleep" },
      { timestamp: "2026-05-16T00:04:30Z", bpm: 62, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 5 * 60 * 1000);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe("2026-05-16T00:00:00.000Z");
    expect(out[0].bpm).toBe(62); // mean of 60,64,62
  });

  it("creates separate buckets across boundaries", () => {
    const samples = [
      { timestamp: "2026-05-16T00:01:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:06:00Z", bpm: 70, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 5 * 60 * 1000);
    expect(out).toHaveLength(2);
    expect(out[0].bpm).toBe(60);
    expect(out[1].bpm).toBe(70);
  });

  it("returns an empty array for empty input", () => {
    expect(bucketHeartRate([], 5 * 60 * 1000)).toEqual([]);
  });

  it("returns buckets sorted chronologically", () => {
    const samples = [
      { timestamp: "2026-05-16T01:00:00Z", bpm: 70, source: "sleep" },
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 60 * 60 * 1000);
    expect(out[0].timestamp).toBe("2026-05-16T00:00:00.000Z");
    expect(out[1].timestamp).toBe("2026-05-16T01:00:00.000Z");
  });
});
```

- [ ] **Step 3: Verify**

`npm run test:unit` — expect 5 new tests on top of stats's 13 + the M7 cache's 19 = 37 total passing.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/get-heart-rate-series.ts test/heart-rate-bucketing.test.ts
git commit -m "tools: get_heart_rate_series with 5/15-min server-side bucketing"
```

---

## Task 6: `compare_to_baseline`

**Files:**
- Create: `src/mcp/tools/compare-to-baseline.ts`
- Create: `test/compare-to-baseline.test.ts`

- [ ] **Step 1: Write the tool**

```typescript
// src/mcp/tools/compare-to-baseline.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyActivity, DailyReadiness, DailySleep, SleepPeriod } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { isIsoDate, shiftDate, today } from "./dates.js";
import { mean, nonNull, percentileOf, round, stdev } from "./stats.js";

const BASELINE_METRIC = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "hrv",
  "resting_hr",
  "total_sleep_hours",
  "efficiency_pct",
]);
export type BaselineMetric = z.infer<typeof BASELINE_METRIC>;

export const compareToBaselineSchema = {
  metric: BASELINE_METRIC.describe(
    "Which personal metric to compare. sleep_score/total_sleep_hours/efficiency_pct from daily_sleep+sleep; readiness_score/hrv/resting_hr from daily_readiness; activity_score from daily_activity."
  ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Day to compare (YYYY-MM-DD, user's LOCAL date). Default: today (server UTC)."),
};

export interface CompareToBaselineInput {
  metric: BaselineMetric;
  date?: string;
}

export interface CompareToBaselineResult {
  metric: BaselineMetric;
  date: string;
  value: number | null;
  insufficient_baseline?: boolean;
  days_with_data?: number;
  p30_mean?: number;
  p30_stdev?: number;
  p90_mean?: number;
  p90_stdev?: number;
  delta_from_p30_pct?: number;
  percentile_in_p90?: number;
}

const READINESS_METRICS = new Set<BaselineMetric>(["readiness_score", "hrv", "resting_hr"]);
const SLEEP_DAILY_METRICS = new Set<BaselineMetric>(["sleep_score"]);
const SLEEP_PERIOD_METRICS = new Set<BaselineMetric>(["total_sleep_hours", "efficiency_pct"]);
const ACTIVITY_METRICS = new Set<BaselineMetric>(["activity_score"]);

const MIN_NON_NULL = 14;

interface DayValue {
  date: string;
  value: number | null;
}

function pickReadiness(metric: BaselineMetric, doc: DailyReadiness): number | null {
  if (metric === "readiness_score") return doc.score ?? null;
  if (metric === "hrv") return doc.contributors?.hrv_balance ?? null;
  if (metric === "resting_hr") return doc.contributors?.resting_heart_rate ?? null;
  return null;
}

async function fetchPoints(
  client: OuraClient,
  metric: BaselineMetric,
  start: string,
  end: string
): Promise<DayValue[]> {
  if (READINESS_METRICS.has(metric)) {
    const docs = await client.collectAll<DailyReadiness>("/usercollection/daily_readiness", {
      start_date: start,
      end_date: end,
    });
    return docs.map((d) => ({ date: d.day, value: pickReadiness(metric, d) }));
  }
  if (SLEEP_DAILY_METRICS.has(metric)) {
    const docs = await client.collectAll<DailySleep>("/usercollection/daily_sleep", {
      start_date: start,
      end_date: end,
    });
    return docs.map((d) => ({ date: d.day, value: d.score ?? null }));
  }
  if (SLEEP_PERIOD_METRICS.has(metric)) {
    const periods = await client.collectAll<SleepPeriod>("/usercollection/sleep", {
      start_date: start,
      end_date: end,
    });
    const byDay = new Map<string, SleepPeriod>();
    for (const p of periods) {
      if (p.type !== "long_sleep" && p.type !== "sleep") continue;
      const existing = byDay.get(p.day);
      const cur = p.total_sleep_duration ?? -1;
      const prev = existing?.total_sleep_duration ?? -2;
      if (cur > prev) byDay.set(p.day, p);
    }
    return [...byDay.values()].map((p) => ({
      date: p.day,
      value:
        metric === "total_sleep_hours"
          ? p.total_sleep_duration != null
            ? round(p.total_sleep_duration / 3600, 2)
            : null
          : p.efficiency != null
            ? round(p.efficiency, 2)
            : null,
    }));
  }
  if (ACTIVITY_METRICS.has(metric)) {
    const docs = await client.collectAll<DailyActivity>("/usercollection/daily_activity", {
      start_date: start,
      end_date: end,
    });
    return docs.map((d) => ({ date: d.day, value: d.score ?? null }));
  }
  throw new OuraInvalidInput(`Unsupported metric: ${metric}`);
}

export async function executeCompareToBaseline(
  client: OuraClient,
  input: CompareToBaselineInput
): Promise<CompareToBaselineResult> {
  const date = input.date ?? today();
  if (!isIsoDate(date)) {
    throw new OuraInvalidInput("date must be YYYY-MM-DD.");
  }

  const start = shiftDate(date, -89); // 90-day window ending on date inclusive
  const points = await fetchPoints(client, input.metric, start, date);

  // Locate the value for date
  const todayPoint = points.find((p) => p.date === date);
  const value = todayPoint?.value ?? null;

  // Build non-null populations excluding the day itself.
  const p90Values = nonNull(points.filter((p) => p.date !== date).map((p) => p.value));
  const p30Cutoff = shiftDate(date, -30);
  const p30Values = nonNull(
    points.filter((p) => p.date !== date && p.date >= p30Cutoff).map((p) => p.value)
  );

  if (p90Values.length < MIN_NON_NULL) {
    return {
      metric: input.metric,
      date,
      value,
      insufficient_baseline: true,
      days_with_data: p90Values.length,
    };
  }

  const p30Mean = round(mean(p30Values), 2);
  const p30Std = round(stdev(p30Values), 2);
  const p90Mean = round(mean(p90Values), 2);
  const p90Std = round(stdev(p90Values), 2);

  const result: CompareToBaselineResult = {
    metric: input.metric,
    date,
    value,
    p30_mean: p30Mean,
    p30_stdev: p30Std,
    p90_mean: p90Mean,
    p90_stdev: p90Std,
  };

  if (value !== null && p30Mean !== 0 && Number.isFinite(p30Mean)) {
    result.delta_from_p30_pct = round(((value - p30Mean) / p30Mean) * 100, 1);
  }
  if (value !== null) {
    result.percentile_in_p90 = percentileOf(value, p90Values);
  }
  return result;
}
```

- [ ] **Step 2: Write tests with a stubbed client**

```typescript
// test/compare-to-baseline.test.ts
import { describe, expect, it } from "vitest";
import { executeCompareToBaseline } from "../src/mcp/tools/compare-to-baseline";
import type { OuraClient } from "../src/oura/client";

function dailyReadinessStub(docs: Array<{ day: string; score: number | null; hrv: number | null }>) {
  return {
    async collectAll(path: string) {
      if (path !== "/usercollection/daily_readiness") return [];
      return docs.map((d) => ({
        id: d.day,
        day: d.day,
        score: d.score,
        contributors: { hrv_balance: d.hrv, resting_heart_rate: 50 },
      }));
    },
  } as unknown as OuraClient;
}

describe("executeCompareToBaseline", () => {
  it("returns insufficient_baseline when fewer than 14 non-null days", async () => {
    const docs = [];
    for (let i = 0; i < 90; i++) {
      docs.push({
        day: `2026-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 30) + 1).padStart(2, "0")}`,
        score: i < 5 ? 80 : null,
        hrv: null,
      });
    }
    const client = dailyReadinessStub(docs);
    const out = await executeCompareToBaseline(client, {
      metric: "readiness_score",
      date: "2026-03-30",
    });
    expect(out.insufficient_baseline).toBe(true);
    expect(out.days_with_data).toBeLessThan(14);
  });

  it("computes p30/p90 stats with sufficient data", async () => {
    const docs = [];
    // 90 days ending 2026-05-16. All days have score=85, except the target day=90.
    const end = new Date("2026-05-16T00:00:00Z");
    for (let i = 89; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(end.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      docs.push({ day, score: day === "2026-05-16" ? 90 : 85, hrv: null });
    }
    const client = dailyReadinessStub(docs);
    const out = await executeCompareToBaseline(client, {
      metric: "readiness_score",
      date: "2026-05-16",
    });
    expect(out.value).toBe(90);
    expect(out.p90_mean).toBe(85);
    expect(out.p30_mean).toBe(85);
    expect(out.delta_from_p30_pct).toBeCloseTo(5.9, 1);
    expect(out.percentile_in_p90).toBe(100); // 90 > all baseline values
    expect(out.insufficient_baseline).toBeUndefined();
  });

  it("rejects invalid date", async () => {
    const client = dailyReadinessStub([]);
    await expect(
      executeCompareToBaseline(client, { metric: "readiness_score", date: "bogus" })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Verify**

`npm run test:unit` — expect 3 new tests on top of the previous totals.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/compare-to-baseline.ts test/compare-to-baseline.test.ts
git commit -m "tools: compare_to_baseline with p30/p90 personal stats"
```

---

## Task 7: Register all five tools

**Files:**
- Modify: `src/mcp/registerTools.ts`

- [ ] **Step 1: Update `registerTools.ts`**

Replace the existing `registerOuraTools` function with one that also registers the five new tools (keep the existing six registrations — `ping`, `_internal_personal_info`, `get_daily_summary`, `get_date_range`, `get_last_night_sleep`):

```typescript
import { compareToBaselineSchema, executeCompareToBaseline } from "./tools/compare-to-baseline.js";
import { getHeartRateSeriesSchema, executeGetHeartRateSeries } from "./tools/get-heart-rate-series.js";
import { getSessionsSchema, executeGetSessions } from "./tools/get-sessions.js";
import { getTagsSchema, executeGetTags } from "./tools/get-tags.js";
import { getWorkoutsSchema, executeGetWorkouts } from "./tools/get-workouts.js";
```

Inside `registerOuraTools`, after the existing tools, add:

```typescript
server.registerTool(
  "get_workouts",
  {
    title: "Workouts",
    description:
      "List workouts logged or auto-detected over a date range. Use for exercise/training questions or to correlate workouts with recovery. Pass user's LOCAL dates as strict YYYY-MM-DD.",
    inputSchema: getWorkoutsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetWorkouts)
);

server.registerTool(
  "get_sessions",
  {
    title: "Mindfulness Sessions",
    description:
      "List mindfulness sessions (meditation, breathing, relaxation) over a date range. Pass user's LOCAL dates as strict YYYY-MM-DD.",
    inputSchema: getSessionsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetSessions)
);

server.registerTool(
  "get_tags",
  {
    title: "Enhanced Tags",
    description:
      "List user-annotated tags (caffeine, alcohol, late meal, custom notes) over a date range. Use to correlate behaviors with sleep/readiness or to recall what was logged. Pass user's LOCAL dates as strict YYYY-MM-DD.",
    inputSchema: getTagsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetTags)
);

server.registerTool(
  "get_heart_rate_series",
  {
    title: "Heart Rate Series",
    description:
      "Get intraday heart-rate time series within a 24-hour window, bucketed to 5min/15min/raw. Use for HR patterns within a day (sleep, workout, stress events). For multi-day trends, use get_date_range with metric=resting_hr instead.",
    inputSchema: getHeartRateSeriesSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetHeartRateSeries)
);

server.registerTool(
  "compare_to_baseline",
  {
    title: "Compare to Baseline",
    description:
      "Compare a single day's metric to the user's personal 30-day and 90-day rolling baselines. Use when the user asks 'is this normal for me?' or 'how does today compare to my usual?'. Returns value alongside personal context so answers can be 'good for you' rather than absolute.",
    inputSchema: compareToBaselineSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeCompareToBaseline)
);
```

- [ ] **Step 2: Type-check + dry-run**

```bash
npm run type-check
npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle
```

Both expected clean.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/registerTools.ts
git commit -m "register: wire up get_workouts/sessions/tags/heart_rate_series/compare_to_baseline"
```

---

## Task 8: Push, open PR, wait for tests, merge

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/phase-1-m8-tools
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "Phase 1: close M8 (5 tools + stats helpers)" --body "$(cat <<'EOF'
## Summary

Closes the original v1 spec's M8 milestone by adding the remaining 5 tools plus a reusable `stats.ts` helper module that Phase 4 will reuse.

- `get_workouts`, `get_sessions`, `get_tags`: typical list-endpoint range queries.
- `get_heart_rate_series`: intraday HR with 5/15-min server-side bucketing or raw passthrough; 24h max window.
- `compare_to_baseline`: p30 + p90 rolling stats; insufficient-baseline fallback at <14 non-null days.

## Test plan

- [x] `npm run test:unit` — all tests pass (stats: 13, hr-bucketing: 5, baseline: 3)
- [x] `npm run type-check` clean
- [x] `wrangler deploy --dry-run` clean
- [x] Deploy + smoke: homepage 200, /mcp 401

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for any checks (no CI configured yet)**

```bash
gh pr checks 2>&1 | tail -5 || echo "no checks"
```

- [ ] **Step 4: Squash-merge**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 5: Sync local main**

```bash
git checkout main
git pull --rebase
```

- [ ] **Step 6: Update README**

Mark M8 ✅ in the milestone table. Bump tool count in the "Status" paragraph.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| get_workouts (response shape) | Task 2 |
| get_sessions | Task 3 |
| get_tags (enhanced_tag) | Task 4 |
| get_heart_rate_series (5/15min bucketing) | Task 5 |
| compare_to_baseline (p30/p90 + insufficient at <14) | Task 6 |
| Statistical helpers reusable for Phase 4 | Task 1 (`stats.ts`) |
| All tools use M7 cache via OuraClient.request | Tasks 2-6 (uses `collectAll`/`request`) |
| Strict YYYY-MM-DD on date schemas | Tasks 2-4, 6 (regex enforced) |
| 180-day max for list-range tools | Tasks 2-4 |
| 24-hour max for heart-rate window | Task 5 |
| Sort chronological in output | Tasks 2-5 |

## Anticipated issues

1. `EnhancedTag` shape: existing typing uses `start_day`/`end_day`. Verify in real call that these are the correct field names; if Oura returns `day` instead, adjust `get_tags.ts:50` accordingly.
2. `HeartRateSample.source` is typed as `string`. Real Oura values are `"rest" | "sleep" | "workout" | "live"` — leave as string to be forward-compatible.
3. `SleepPeriod.efficiency` is sometimes 0–1 and sometimes 0–100 depending on API version. `compare_to_baseline` rounds raw value; if user reports out-of-range, adjust normalization.
