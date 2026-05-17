# Phase 4 (Analytics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add 2 analytics tools that bake server-side statistical reasoning the LLM would otherwise struggle with: anomaly detection by z-score, and tag-vs-metric correlation by group stats.

**Tech Stack:** Reuses `src/mcp/tools/stats.ts` (`mean`, `stdev`, `nonNull`) and the metric-fetching pattern from `compare_to_baseline`. Zod schemas.

Reference: spec Phase 4 section.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/mcp/tools/metric-fetch.ts` | create | Shared helper that fetches the right daily endpoint for a given metric, returning `{date, value}[]`. Extracted from `compare_to_baseline`'s `fetchPoints` so Phase 4 can reuse without duplicating endpoint mapping. |
| `src/mcp/tools/compare-to-baseline.ts` | modify | Refactor to import the shared metric fetcher. Net behavior unchanged. |
| `src/mcp/tools/find-anomalies.ts` | create | z-score-based anomaly detection over rolling baseline. |
| `src/mcp/tools/correlate-tag-with-metric.ts` | create | Group stats for tagged-vs-untagged days. |
| `src/mcp/registerTools.ts` | modify | Register the 2 new tools. |
| `test/find-anomalies.test.ts` | create | Tests for the z-score branch + insufficient-baseline. |
| `test/correlate-tag-with-metric.test.ts` | create | Tests for tagged/untagged stats + small-sample warning. |

## Invariants

1. **Strict YYYY-MM-DD on date inputs.** Same convention as v1+v2.
2. **Insufficient-data signals are structured, not thrown.** Use the result envelope: `{insufficient_baseline: true, ...}` or `{small_sample_warning: true, ...}`.
3. **Reuse stats helpers + endpoint mapping** — don't re-implement.

---

## Task 1: Extract metric-fetch helper

Create `src/mcp/tools/metric-fetch.ts`:

```typescript
import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  SleepPeriod,
} from "../../oura/types.js";
import { round } from "./stats.js";

export type Metric =
  | "sleep_score"
  | "readiness_score"
  | "activity_score"
  | "hrv"
  | "resting_hr"
  | "steps"
  | "total_sleep_hours"
  | "efficiency_pct";

export interface DayValue {
  date: string;
  value: number | null;
}

const READINESS_METRICS = new Set<Metric>(["readiness_score", "hrv", "resting_hr"]);
const SLEEP_DAILY_METRICS = new Set<Metric>(["sleep_score"]);
const SLEEP_PERIOD_METRICS = new Set<Metric>(["total_sleep_hours", "efficiency_pct"]);
const ACTIVITY_METRICS = new Set<Metric>(["activity_score", "steps"]);

function pickReadiness(metric: Metric, doc: DailyReadiness): number | null {
  if (metric === "readiness_score") return doc.score ?? null;
  if (metric === "hrv") return doc.contributors?.hrv_balance ?? null;
  if (metric === "resting_hr") return doc.contributors?.resting_heart_rate ?? null;
  return null;
}

function pickActivity(metric: Metric, doc: DailyActivity): number | null {
  if (metric === "activity_score") return doc.score ?? null;
  if (metric === "steps") return doc.steps ?? null;
  return null;
}

export async function fetchMetricPoints(
  client: OuraClient,
  metric: Metric,
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
    return docs.map((d) => ({ date: d.day, value: pickActivity(metric, d) }));
  }
  throw new Error(`Unsupported metric: ${metric}`);
}
```

Commit:

```bash
git add src/mcp/tools/metric-fetch.ts
git commit -m "metric-fetch: shared helper for daily-metric → DayValue[] mapping"
```

## Task 2: Refactor `compare_to_baseline` to use the shared fetcher

Edit `src/mcp/tools/compare-to-baseline.ts` so it imports `fetchMetricPoints` and `type Metric`/`DayValue` from `./metric-fetch.js` and deletes the internal `fetchPoints`, `pickReadiness`, and the metric Set constants. The local `BaselineMetric` z.enum stays — it's the user-facing schema. Map `BaselineMetric` values to the broader `Metric` type when calling the shared helper.

The relevant change:

```typescript
// Replace these imports near the top
import { fetchMetricPoints, type DayValue, type Metric } from "./metric-fetch.js";
// Remove imports of DailyActivity, DailyReadiness, DailySleep, SleepPeriod (now in metric-fetch.ts)

// Drop the local pickReadiness, READINESS_METRICS, SLEEP_DAILY_METRICS, SLEEP_PERIOD_METRICS,
// ACTIVITY_METRICS, DayValue interface, and the local fetchPoints function entirely.

// Replace the fetchPoints call inside executeCompareToBaseline:
const points: DayValue[] = await fetchMetricPoints(client, input.metric as Metric, start, date);
```

The `BaselineMetric` z.enum excludes `"steps"`. The shared `Metric` type includes it. Cast at the call boundary is safe because every `BaselineMetric` is a valid `Metric`.

Run `npm run test:unit` to confirm `compare-to-baseline.test.ts` (3 tests) still passes — behavior is unchanged.

Commit:

```bash
git add src/mcp/tools/compare-to-baseline.ts
git commit -m "compare_to_baseline: refactor to use shared metric-fetch helper"
```

## Task 3: `find_anomalies`

Create `src/mcp/tools/find-anomalies.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { OuraInvalidInput } from "../../errors.js";
import { isIsoDate, shiftDate } from "./dates.js";
import { fetchMetricPoints, type Metric } from "./metric-fetch.js";
import { mean, nonNull, round, stdev } from "./stats.js";

const METRIC = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "hrv",
  "resting_hr",
  "steps",
  "total_sleep_hours",
  "efficiency_pct",
]);

export const findAnomaliesSchema = {
  metric: METRIC.describe("Metric to scan for outliers."),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End of window YYYY-MM-DD, user's LOCAL date (inclusive)."),
  lookback_days: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .describe("Window size in days, 7-365. Default 90."),
  threshold_sigma: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .describe("Z-score magnitude that qualifies as an anomaly. Default 2."),
};

export interface FindAnomaliesInput {
  metric: Metric;
  end_date: string;
  lookback_days?: number;
  threshold_sigma?: number;
}

export interface AnomalyOut {
  date: string;
  value: number;
  deviation_sigma: number;
  direction: "high" | "low";
}

export interface FindAnomaliesResult {
  metric: Metric;
  window: { start: string; end: string; days: number };
  baseline: { mean: number; stdev: number; non_null_days: number };
  anomalies: AnomalyOut[];
  insufficient_baseline?: boolean;
  days_with_data?: number;
}

const MIN_NON_NULL = 14;

export async function executeFindAnomalies(
  client: OuraClient,
  input: FindAnomaliesInput
): Promise<FindAnomaliesResult> {
  if (!isIsoDate(input.end_date)) {
    throw new OuraInvalidInput("end_date must be YYYY-MM-DD.");
  }
  const days = input.lookback_days ?? 90;
  const threshold = input.threshold_sigma ?? 2;
  const end = input.end_date;
  const start = shiftDate(end, -(days - 1));

  const points = await fetchMetricPoints(client, input.metric, start, end);
  const values = nonNull(points.map((p) => p.value));

  if (values.length < MIN_NON_NULL) {
    return {
      metric: input.metric,
      window: { start, end, days },
      baseline: { mean: Number.NaN, stdev: Number.NaN, non_null_days: values.length },
      anomalies: [],
      insufficient_baseline: true,
      days_with_data: values.length,
    };
  }

  const m = mean(values);
  const s = stdev(values);
  const anomalies: AnomalyOut[] = [];
  if (s > 0) {
    for (const p of points) {
      if (p.value === null) continue;
      const z = (p.value - m) / s;
      if (Math.abs(z) > threshold) {
        anomalies.push({
          date: p.date,
          value: p.value,
          deviation_sigma: round(z, 2),
          direction: z > 0 ? "high" : "low",
        });
      }
    }
  }
  // Sort by magnitude descending.
  anomalies.sort((a, b) => Math.abs(b.deviation_sigma) - Math.abs(a.deviation_sigma));

  return {
    metric: input.metric,
    window: { start, end, days },
    baseline: {
      mean: round(m, 2),
      stdev: round(s, 2),
      non_null_days: values.length,
    },
    anomalies,
  };
}
```

Commit:

```bash
git add src/mcp/tools/find-anomalies.ts
git commit -m "tools: find_anomalies (z-score deviations over rolling baseline)"
```

## Task 4: `correlate_tag_with_metric`

Create `src/mcp/tools/correlate-tag-with-metric.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { EnhancedTag } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { isIsoDate, shiftDate, today } from "./dates.js";
import { fetchMetricPoints, type Metric } from "./metric-fetch.js";
import { mean, nonNull, round, stdev } from "./stats.js";

const METRIC = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "hrv",
  "resting_hr",
  "steps",
  "total_sleep_hours",
  "efficiency_pct",
]);

export const correlateTagWithMetricSchema = {
  metric: METRIC.describe("Metric to compare across tagged vs untagged days."),
  tag_type_code: z
    .string()
    .optional()
    .describe("Oura tag type code (e.g., 'alcohol', 'caffeine'). Exactly one of tag_type_code OR custom_name."),
  custom_name: z
    .string()
    .optional()
    .describe("User-defined tag name. Exactly one of tag_type_code OR custom_name."),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of window YYYY-MM-DD, user's LOCAL date. Default: today (server UTC)."),
  lookback_days: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .describe("Window size 7-365 days. Default 90."),
};

export interface CorrelateInput {
  metric: Metric;
  tag_type_code?: string;
  custom_name?: string;
  end_date?: string;
  lookback_days?: number;
}

export interface GroupStat {
  n: number;
  mean: number;
  median: number;
  stdev: number;
}

export interface CorrelateResult {
  tag: { tag_type_code: string | null; custom_name: string | null };
  metric: Metric;
  window: { start: string; end: string; days: number };
  tagged: GroupStat;
  untagged: GroupStat;
  mean_delta_pct?: number;
  small_sample_warning: boolean;
}

const MIN_GROUP = 5;

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function groupStat(values: number[]): GroupStat {
  const arr = nonNull(values);
  return {
    n: arr.length,
    mean: arr.length > 0 ? round(mean(arr), 2) : Number.NaN,
    median: arr.length > 0 ? round(median(arr), 2) : Number.NaN,
    stdev: arr.length > 1 ? round(stdev(arr), 2) : Number.NaN,
  };
}

export async function executeCorrelateTagWithMetric(
  client: OuraClient,
  input: CorrelateInput
): Promise<CorrelateResult> {
  if (Boolean(input.tag_type_code) === Boolean(input.custom_name)) {
    throw new OuraInvalidInput("Provide exactly one of tag_type_code or custom_name.");
  }
  const end = input.end_date ?? today();
  if (!isIsoDate(end)) {
    throw new OuraInvalidInput("end_date must be YYYY-MM-DD.");
  }
  const days = input.lookback_days ?? 90;
  const start = shiftDate(end, -(days - 1));

  const [points, tags] = await Promise.all([
    fetchMetricPoints(client, input.metric, start, end),
    client.collectAll<EnhancedTag>("/usercollection/enhanced_tag", {
      start_date: start,
      end_date: end,
    }),
  ]);

  // Build the set of days where the requested tag fired.
  const taggedDays = new Set<string>();
  for (const t of tags) {
    const matchesType = input.tag_type_code && t.tag_type_code === input.tag_type_code;
    const matchesName = input.custom_name && t.custom_name === input.custom_name;
    if (matchesType || matchesName) {
      if (t.start_day) taggedDays.add(t.start_day);
    }
  }

  const tagged: Array<number | null> = [];
  const untagged: Array<number | null> = [];
  for (const p of points) {
    if (taggedDays.has(p.date)) tagged.push(p.value);
    else untagged.push(p.value);
  }

  const taggedStats = groupStat(tagged);
  const untaggedStats = groupStat(untagged);

  const result: CorrelateResult = {
    tag: {
      tag_type_code: input.tag_type_code ?? null,
      custom_name: input.custom_name ?? null,
    },
    metric: input.metric,
    window: { start, end, days },
    tagged: taggedStats,
    untagged: untaggedStats,
    small_sample_warning: taggedStats.n < MIN_GROUP || untaggedStats.n < MIN_GROUP,
  };

  if (
    Number.isFinite(taggedStats.mean) &&
    Number.isFinite(untaggedStats.mean) &&
    untaggedStats.mean !== 0
  ) {
    result.mean_delta_pct = round(
      ((taggedStats.mean - untaggedStats.mean) / untaggedStats.mean) * 100,
      1
    );
  }

  return result;
}
```

Commit:

```bash
git add src/mcp/tools/correlate-tag-with-metric.ts
git commit -m "tools: correlate_tag_with_metric (group stats for tagged vs untagged days)"
```

## Task 5: Tests

Create `test/find-anomalies.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { executeFindAnomalies } from "../src/mcp/tools/find-anomalies";
import type { OuraClient } from "../src/oura/client";

function stub(docs: Array<{ day: string; score: number | null }>): OuraClient {
  return {
    async collectAll(path: string) {
      if (path !== "/usercollection/daily_readiness") return [];
      return docs.map((d) => ({
        id: d.day,
        day: d.day,
        score: d.score,
        contributors: { hrv_balance: null, resting_heart_rate: null },
      }));
    },
  } as unknown as OuraClient;
}

describe("executeFindAnomalies", () => {
  it("flags days outside threshold sigma", async () => {
    const docs = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date("2026-04-17T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      docs.push({ day, score: day === "2026-05-10" ? 30 : 85 });
    }
    const client = stub(docs);
    const out = await executeFindAnomalies(client, {
      metric: "readiness_score",
      end_date: "2026-05-16",
      lookback_days: 30,
      threshold_sigma: 2,
    });
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0].date).toBe("2026-05-10");
    expect(out.anomalies[0].direction).toBe("low");
    expect(out.anomalies[0].value).toBe(30);
  });

  it("returns insufficient_baseline with <14 non-null days", async () => {
    const docs = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date("2026-05-01T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      docs.push({ day: d.toISOString().slice(0, 10), score: 80 });
    }
    const client = stub(docs);
    const out = await executeFindAnomalies(client, {
      metric: "readiness_score",
      end_date: "2026-05-16",
      lookback_days: 90,
    });
    expect(out.insufficient_baseline).toBe(true);
    expect(out.days_with_data).toBe(10);
    expect(out.anomalies).toEqual([]);
  });

  it("rejects invalid end_date", async () => {
    await expect(
      executeFindAnomalies(stub([]), {
        metric: "readiness_score",
        end_date: "bogus",
      })
    ).rejects.toThrow();
  });
});
```

Create `test/correlate-tag-with-metric.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { executeCorrelateTagWithMetric } from "../src/mcp/tools/correlate-tag-with-metric";
import type { OuraClient } from "../src/oura/client";

function stub(metricDocs: Array<{ day: string; score: number | null }>, tags: Array<{ start_day: string; tag_type_code: string }>): OuraClient {
  return {
    async collectAll(path: string) {
      if (path === "/usercollection/daily_sleep") {
        return metricDocs.map((d) => ({ id: d.day, day: d.day, score: d.score }));
      }
      if (path === "/usercollection/enhanced_tag") {
        return tags;
      }
      return [];
    },
  } as unknown as OuraClient;
}

describe("executeCorrelateTagWithMetric", () => {
  it("splits tagged vs untagged days and computes stats", async () => {
    const metricDocs = [];
    const tags = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date("2026-04-17T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      const isTagged = i % 3 === 0;
      metricDocs.push({ day, score: isTagged ? 70 : 85 });
      if (isTagged) tags.push({ start_day: day, tag_type_code: "alcohol" });
    }
    const client = stub(metricDocs, tags);
    const out = await executeCorrelateTagWithMetric(client, {
      metric: "sleep_score",
      tag_type_code: "alcohol",
      end_date: "2026-05-16",
      lookback_days: 30,
    });
    expect(out.tagged.n).toBe(10);
    expect(out.tagged.mean).toBe(70);
    expect(out.untagged.n).toBe(20);
    expect(out.untagged.mean).toBe(85);
    expect(out.mean_delta_pct).toBeCloseTo(-17.6, 1);
    expect(out.small_sample_warning).toBe(false);
  });

  it("flags small_sample_warning with <5 in either group", async () => {
    const metricDocs = [];
    const tags = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      const isTagged = i < 3;
      metricDocs.push({ day, score: isTagged ? 60 : 85 });
      if (isTagged) tags.push({ start_day: day, tag_type_code: "alcohol" });
    }
    const client = stub(metricDocs, tags);
    const out = await executeCorrelateTagWithMetric(client, {
      metric: "sleep_score",
      tag_type_code: "alcohol",
      end_date: "2026-05-16",
      lookback_days: 20,
    });
    expect(out.tagged.n).toBe(3);
    expect(out.small_sample_warning).toBe(true);
  });

  it("rejects when both tag_type_code and custom_name are provided", async () => {
    await expect(
      executeCorrelateTagWithMetric(stub([], []), {
        metric: "sleep_score",
        tag_type_code: "alcohol",
        custom_name: "wine",
      })
    ).rejects.toThrow();
  });

  it("rejects when neither tag_type_code nor custom_name is provided", async () => {
    await expect(
      executeCorrelateTagWithMetric(stub([], []), {
        metric: "sleep_score",
      })
    ).rejects.toThrow();
  });
});
```

Run `npm run test:unit` — expect 7 new tests on top of 44 = 51 total.

Commit:

```bash
git add test/find-anomalies.test.ts test/correlate-tag-with-metric.test.ts
git commit -m "tests: find_anomalies + correlate_tag_with_metric"
```

## Task 6: Register both tools

Modify `src/mcp/registerTools.ts`. Add imports:

```typescript
import { findAnomaliesSchema, executeFindAnomalies } from "./tools/find-anomalies.js";
import { correlateTagWithMetricSchema, executeCorrelateTagWithMetric } from "./tools/correlate-tag-with-metric.js";
```

Add registrations after Phase 3:

```typescript
server.registerTool(
  "find_anomalies",
  {
    title: "Find Anomalies",
    description:
      "Flag days whose metric value deviates more than threshold_sigma standard deviations from the rolling-window mean. Default window 90 days, default threshold 2σ. Use when the user asks 'when did my HRV crash?' or 'pick out my worst sleep weeks'. Returns empty list (and insufficient_baseline=true) if fewer than 14 non-null days. Pass user's LOCAL end_date as strict YYYY-MM-DD.",
    inputSchema: findAnomaliesSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeFindAnomalies)
);

server.registerTool(
  "correlate_tag_with_metric",
  {
    title: "Correlate Tag with Metric",
    description:
      "Compute mean/median/stdev of a metric on tagged days vs untagged days, plus mean_delta_pct. Use when the user asks 'does alcohol hurt my sleep?' or 'are tagged days worse for HRV?'. Provide exactly one of tag_type_code (Oura's tag taxonomy) or custom_name (user-defined). small_sample_warning=true when either group has <5 days.",
    inputSchema: correlateTagWithMetricSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeCorrelateTagWithMetric)
);
```

Verify: `npm run type-check`, `npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle`.

Commit:

```bash
git add src/mcp/registerTools.ts
git commit -m "register: wire up Phase 4 — find_anomalies + correlate_tag_with_metric"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| find_anomalies (z-score, rolling baseline, sort by magnitude desc) | Task 3 |
| insufficient_baseline at <14 non-null days | Task 3 |
| correlate_tag_with_metric (tagged vs untagged group stats) | Task 4 |
| small_sample_warning at <5 in either group | Task 4 |
| Exactly one of tag_type_code or custom_name | Task 4 |
| Reuse stats helpers (mean/stdev/nonNull/round) | Tasks 3, 4 |
| Reuse metric-fetch logic across Phase 1 + Phase 4 | Task 1 (extract) + Task 2 (refactor compare_to_baseline) |
| Both tools use OuraClient.collectAll (cache via M7) | Tasks 3, 4 |
| Strict YYYY-MM-DD on date inputs | Tasks 3, 4 |
| Registered in registerTools.ts | Task 6 |
