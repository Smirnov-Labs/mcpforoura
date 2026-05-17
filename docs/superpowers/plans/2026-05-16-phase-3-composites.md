# Phase 3 (Composites) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add 2 composite tools that fan out across 2–6 endpoints and return structured raw data for the LLM to curate. Neutral style — no server-side ranking.

**Tech Stack:** TypeScript, Zod, `OuraClient` with `Promise.all` fan-out.

Reference: `docs/superpowers/specs/2026-05-16-tool-expansion-design.md` Phase 3 section.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/mcp/tools/get-morning-briefing.ts` | create | Fan-out to today's readiness + sleep_time + yesterday's sleep + activity + stress + tags. Returns structured JSON. |
| `src/mcp/tools/get-weekly-recap.ts` | create | 7-day (configurable 1–28) array of daily metrics + per-metric stats. |
| `src/mcp/registerTools.ts` | modify | Register the 2 new tools. |
| `test/morning-briefing.test.ts` | create | Stubbed-client test asserting parallel fan-out and shape. |
| `test/weekly-recap.test.ts` | create | Stubbed-client test asserting per-metric stats and daily ordering. |

## Invariants

1. Strict YYYY-MM-DD date inputs (matches v1+v2 convention).
2. Server returns structured raw data; no ranking or highlighting.
3. All endpoint calls go through `OuraClient.requestList`/`collectAll` (M7 cache).
4. Fan-out via `Promise.all` for parallelism — composites should be roughly as fast as the slowest single call.
5. Each sub-fetch failure does NOT fail the whole composite. Per-sub-fetch errors become `null` on the corresponding field, so the composite always returns a usable shape. *(Exception: if `OuraClient` throws `OuraReauthRequired` or `OuraAccountUnavailable`, those are global auth issues — let them propagate.)*

---

## Task 1: `get_morning_briefing`

Create `src/mcp/tools/get-morning-briefing.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  DailyStress,
  EnhancedTag,
  RecommendedSleepTime,
} from "../../oura/types.js";
import { OuraReauthRequired, OuraAccountUnavailable } from "../../errors.js";
import { resolveDate, shiftDate } from "./dates.js";

export const getMorningBriefingSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Today's date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetMorningBriefingInput {
  date: string;
}

interface ReadinessOut {
  score: number | null;
  temperature_deviation: number | null;
  contributors: DailyReadiness["contributors"] | null;
}

interface RecommendedSleepTimeOut {
  optimal_bedtime_start_offset_min: number | null;
  optimal_bedtime_end_offset_min: number | null;
  status: string | null;
  recommendation: string | null;
}

interface SleepOut {
  score: number | null;
  contributors: DailySleep["contributors"] | null;
}

interface ActivityOut {
  score: number | null;
  steps: number | null;
  active_calories: number | null;
}

interface StressOut {
  stress_high_seconds: number | null;
  recovery_high_seconds: number | null;
  day_summary: string | null;
}

interface TagOut {
  tag_type_code: string;
  custom_name: string | null;
  comment: string | null;
}

export interface GetMorningBriefingResult {
  today: {
    date: string;
    readiness: ReadinessOut | null;
    recommended_sleep_time: RecommendedSleepTimeOut | null;
  };
  yesterday: {
    date: string;
    sleep: SleepOut | null;
    activity: ActivityOut | null;
    stress: StressOut | null;
    tags: TagOut[];
  };
}

async function safeRequestList<T>(
  client: OuraClient,
  path: string,
  query: Record<string, string>
): Promise<T[]> {
  try {
    const res = await client.requestList<T>(path, query);
    return res.data;
  } catch (err) {
    if (err instanceof OuraReauthRequired || err instanceof OuraAccountUnavailable) {
      throw err;
    }
    return [];
  }
}

function pickByDay<T extends { day: string }>(docs: T[], day: string): T | undefined {
  return docs.find((d) => d.day === day) ?? docs[0];
}

export async function executeGetMorningBriefing(
  client: OuraClient,
  input: GetMorningBriefingInput
): Promise<GetMorningBriefingResult> {
  const today = resolveDate(input.date);
  const yesterday = shiftDate(today, -1);

  const [readinessDocs, sleepTimeDocs, sleepDocs, activityDocs, stressDocs, tagDocs] =
    await Promise.all([
      safeRequestList<DailyReadiness>(client, "/usercollection/daily_readiness", {
        start_date: today,
        end_date: today,
      }),
      safeRequestList<RecommendedSleepTime>(client, "/usercollection/sleep_time", {
        start_date: today,
        end_date: today,
      }),
      safeRequestList<DailySleep>(client, "/usercollection/daily_sleep", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<DailyActivity>(client, "/usercollection/daily_activity", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<DailyStress>(client, "/usercollection/daily_stress", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<EnhancedTag>(client, "/usercollection/enhanced_tag", {
        start_date: yesterday,
        end_date: yesterday,
      }),
    ]);

  const readiness = pickByDay(readinessDocs, today);
  const sleepTimeDoc = pickByDay(sleepTimeDocs, today);
  const sleep = pickByDay(sleepDocs, yesterday);
  const activity = pickByDay(activityDocs, yesterday);
  const stress = pickByDay(stressDocs, yesterday);

  return {
    today: {
      date: today,
      readiness: readiness
        ? {
            score: readiness.score ?? null,
            temperature_deviation: readiness.temperature_deviation ?? null,
            contributors: readiness.contributors ?? null,
          }
        : null,
      recommended_sleep_time: sleepTimeDoc
        ? {
            optimal_bedtime_start_offset_min:
              sleepTimeDoc.optimal_bedtime?.start_offset != null
                ? Math.round(sleepTimeDoc.optimal_bedtime.start_offset / 60)
                : null,
            optimal_bedtime_end_offset_min:
              sleepTimeDoc.optimal_bedtime?.end_offset != null
                ? Math.round(sleepTimeDoc.optimal_bedtime.end_offset / 60)
                : null,
            status: sleepTimeDoc.status ?? null,
            recommendation: sleepTimeDoc.recommendation ?? null,
          }
        : null,
    },
    yesterday: {
      date: yesterday,
      sleep: sleep
        ? {
            score: sleep.score ?? null,
            contributors: sleep.contributors ?? null,
          }
        : null,
      activity: activity
        ? {
            score: activity.score ?? null,
            steps: activity.steps ?? null,
            active_calories: activity.active_calories ?? null,
          }
        : null,
      stress: stress
        ? {
            stress_high_seconds: stress.stress_high ?? null,
            recovery_high_seconds: stress.recovery_high ?? null,
            day_summary: stress.day_summary ?? null,
          }
        : null,
      tags: tagDocs.map((t) => ({
        tag_type_code: t.tag_type_code,
        custom_name: t.custom_name ?? null,
        comment: t.comment ?? null,
      })),
    },
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-morning-briefing.ts
git commit -m "tools: get_morning_briefing (today readiness + yesterday everything)"
```

---

## Task 2: `get_weekly_recap`

Create `src/mcp/tools/get-weekly-recap.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  DailyStress,
  SleepPeriod,
} from "../../oura/types.js";
import { OuraInvalidInput, OuraReauthRequired, OuraAccountUnavailable } from "../../errors.js";
import { daysBetween, isIsoDate, shiftDate } from "./dates.js";
import { mean, nonNull, round } from "./stats.js";

export const getWeeklyRecapSchema = {
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End date YYYY-MM-DD, user's LOCAL date (inclusive)."),
  days: z
    .number()
    .int()
    .min(1)
    .max(28)
    .optional()
    .describe("Window size in days, 1-28. Default 7."),
};

export interface GetWeeklyRecapInput {
  end_date: string;
  days?: number;
}

interface DailyRow {
  date: string;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  stress_high_sec: number | null;
  hrv: number | null;
  resting_hr: number | null;
  total_sleep_hours: number | null;
}

interface MetricStat {
  mean: number;
  min: number;
  max: number;
}

export interface GetWeeklyRecapResult {
  window: { start: string; end: string; days: number };
  daily: DailyRow[];
  stats: Partial<Record<keyof Omit<DailyRow, "date">, MetricStat>>;
}

async function safeCollect<T>(
  client: OuraClient,
  path: string,
  start: string,
  end: string
): Promise<T[]> {
  try {
    return await client.collectAll<T>(path, { start_date: start, end_date: end });
  } catch (err) {
    if (err instanceof OuraReauthRequired || err instanceof OuraAccountUnavailable) {
      throw err;
    }
    return [];
  }
}

function indexByDay<T extends { day: string }>(docs: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const d of docs) {
    if (!m.has(d.day)) m.set(d.day, d);
  }
  return m;
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const span = daysBetween(start, end);
  for (let i = 0; i <= span; i++) {
    out.push(shiftDate(start, i));
  }
  return out;
}

function statsFor(values: Array<number | null>): MetricStat | undefined {
  const arr = nonNull(values);
  if (arr.length === 0) return undefined;
  return {
    mean: round(mean(arr), 2),
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

export async function executeGetWeeklyRecap(
  client: OuraClient,
  input: GetWeeklyRecapInput
): Promise<GetWeeklyRecapResult> {
  if (!isIsoDate(input.end_date)) {
    throw new OuraInvalidInput("end_date must be YYYY-MM-DD.");
  }
  const days = input.days ?? 7;
  const end = input.end_date;
  const start = shiftDate(end, -(days - 1));
  const dates = enumerateDates(start, end);

  const [sleepDocs, readinessDocs, activityDocs, stressDocs, sleepPeriods] = await Promise.all([
    safeCollect<DailySleep>(client, "/usercollection/daily_sleep", start, end),
    safeCollect<DailyReadiness>(client, "/usercollection/daily_readiness", start, end),
    safeCollect<DailyActivity>(client, "/usercollection/daily_activity", start, end),
    safeCollect<DailyStress>(client, "/usercollection/daily_stress", start, end),
    safeCollect<SleepPeriod>(client, "/usercollection/sleep", start, end),
  ]);

  const sleepByDay = indexByDay(sleepDocs);
  const readinessByDay = indexByDay(readinessDocs);
  const activityByDay = indexByDay(activityDocs);
  const stressByDay = indexByDay(stressDocs);

  // Pick the longest sleep period per day for total_sleep_hours.
  const longestSleepByDay = new Map<string, SleepPeriod>();
  for (const p of sleepPeriods) {
    if (p.type !== "long_sleep" && p.type !== "sleep") continue;
    const existing = longestSleepByDay.get(p.day);
    const cur = p.total_sleep_duration ?? -1;
    const prev = existing?.total_sleep_duration ?? -2;
    if (cur > prev) longestSleepByDay.set(p.day, p);
  }

  const daily: DailyRow[] = dates.map((date) => ({
    date,
    sleep_score: sleepByDay.get(date)?.score ?? null,
    readiness_score: readinessByDay.get(date)?.score ?? null,
    activity_score: activityByDay.get(date)?.score ?? null,
    stress_high_sec: stressByDay.get(date)?.stress_high ?? null,
    hrv: readinessByDay.get(date)?.contributors?.hrv_balance ?? null,
    resting_hr: readinessByDay.get(date)?.contributors?.resting_heart_rate ?? null,
    total_sleep_hours: (() => {
      const p = longestSleepByDay.get(date);
      return p?.total_sleep_duration != null ? round(p.total_sleep_duration / 3600, 2) : null;
    })(),
  }));

  const stats: GetWeeklyRecapResult["stats"] = {};
  const fields: Array<keyof Omit<DailyRow, "date">> = [
    "sleep_score",
    "readiness_score",
    "activity_score",
    "stress_high_sec",
    "hrv",
    "resting_hr",
    "total_sleep_hours",
  ];
  for (const f of fields) {
    const s = statsFor(daily.map((row) => row[f]));
    if (s) stats[f] = s;
  }

  return {
    window: { start, end, days },
    daily,
    stats,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-weekly-recap.ts
git commit -m "tools: get_weekly_recap (7-day daily + per-metric stats)"
```

---

## Task 3: Tests

Create `test/morning-briefing.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { executeGetMorningBriefing } from "../src/mcp/tools/get-morning-briefing";
import type { OuraClient } from "../src/oura/client";

function stubClient(responses: Record<string, unknown[]>): OuraClient {
  return {
    async requestList(path: string) {
      return { data: responses[path] ?? [], next_token: null };
    },
  } as unknown as OuraClient;
}

describe("executeGetMorningBriefing", () => {
  it("fans out and returns shaped today + yesterday", async () => {
    const client = stubClient({
      "/usercollection/daily_readiness": [
        { id: "r1", day: "2026-05-16", score: 85, temperature_deviation: 0.2, contributors: { hrv_balance: 70 } },
      ],
      "/usercollection/sleep_time": [
        { id: "st1", day: "2026-05-16", optimal_bedtime: { start_offset: 79200, end_offset: 82800 }, status: "good", recommendation: "good_to_go" },
      ],
      "/usercollection/daily_sleep": [
        { id: "s1", day: "2026-05-15", score: 86, contributors: { deep_sleep: 90 } },
      ],
      "/usercollection/daily_activity": [
        { id: "a1", day: "2026-05-15", score: 89, steps: 12000, active_calories: 600 },
      ],
      "/usercollection/daily_stress": [
        { id: "st1", day: "2026-05-15", stress_high: 4200, recovery_high: 10800, day_summary: "normal" },
      ],
      "/usercollection/enhanced_tag": [
        { id: "t1", tag_type_code: "alcohol", start_day: "2026-05-15", custom_name: null, comment: "one beer" },
      ],
    });

    const out = await executeGetMorningBriefing(client, { date: "2026-05-16" });

    expect(out.today.date).toBe("2026-05-16");
    expect(out.today.readiness?.score).toBe(85);
    expect(out.today.recommended_sleep_time?.optimal_bedtime_start_offset_min).toBe(1320); // 79200/60
    expect(out.yesterday.date).toBe("2026-05-15");
    expect(out.yesterday.sleep?.score).toBe(86);
    expect(out.yesterday.activity?.steps).toBe(12000);
    expect(out.yesterday.stress?.day_summary).toBe("normal");
    expect(out.yesterday.tags).toHaveLength(1);
    expect(out.yesterday.tags[0].tag_type_code).toBe("alcohol");
  });

  it("returns nulls when an endpoint has no data", async () => {
    const client = stubClient({});
    const out = await executeGetMorningBriefing(client, { date: "2026-05-16" });
    expect(out.today.readiness).toBeNull();
    expect(out.today.recommended_sleep_time).toBeNull();
    expect(out.yesterday.sleep).toBeNull();
    expect(out.yesterday.activity).toBeNull();
    expect(out.yesterday.stress).toBeNull();
    expect(out.yesterday.tags).toEqual([]);
  });
});
```

Create `test/weekly-recap.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { executeGetWeeklyRecap } from "../src/mcp/tools/get-weekly-recap";
import type { OuraClient } from "../src/oura/client";

function stubClient(responses: Record<string, unknown[]>): OuraClient {
  return {
    async collectAll(path: string) {
      return responses[path] ?? [];
    },
  } as unknown as OuraClient;
}

describe("executeGetWeeklyRecap", () => {
  it("returns a 7-day window with daily ordered chronologically", async () => {
    const days: Array<{ day: string; score: number | null }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date("2026-05-10T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      days.push({ day: d.toISOString().slice(0, 10), score: 80 + i });
    }
    const client = stubClient({
      "/usercollection/daily_sleep": days,
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });

    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16" });
    expect(out.window).toEqual({ start: "2026-05-10", end: "2026-05-16", days: 7 });
    expect(out.daily).toHaveLength(7);
    expect(out.daily[0].date).toBe("2026-05-10");
    expect(out.daily[6].date).toBe("2026-05-16");
    expect(out.daily[0].sleep_score).toBe(80);
    expect(out.daily[6].sleep_score).toBe(86);
    expect(out.stats.sleep_score?.mean).toBe(83);
    expect(out.stats.sleep_score?.min).toBe(80);
    expect(out.stats.sleep_score?.max).toBe(86);
  });

  it("omits stats for metrics with no non-null values", async () => {
    const client = stubClient({
      "/usercollection/daily_sleep": [{ day: "2026-05-16", score: 86 }],
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });
    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16", days: 1 });
    expect(out.stats.sleep_score).toBeDefined();
    expect(out.stats.readiness_score).toBeUndefined();
  });

  it("respects custom days parameter", async () => {
    const client = stubClient({
      "/usercollection/daily_sleep": [],
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });
    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16", days: 14 });
    expect(out.window.days).toBe(14);
    expect(out.window.start).toBe("2026-05-03");
    expect(out.daily).toHaveLength(14);
  });
});
```

Verify:

```bash
npm run test:unit
```

Expect 5 new tests on top of 39 prior = 44 total.

Commit:

```bash
git add test/morning-briefing.test.ts test/weekly-recap.test.ts
git commit -m "tests: morning_briefing + weekly_recap with stubbed client"
```

---

## Task 4: Register both tools

Modify `src/mcp/registerTools.ts`. Add imports:

```typescript
import { getMorningBriefingSchema, executeGetMorningBriefing } from "./tools/get-morning-briefing.js";
import { getWeeklyRecapSchema, executeGetWeeklyRecap } from "./tools/get-weekly-recap.js";
```

Add registrations after the Phase 2 tools:

```typescript
server.registerTool(
  "get_morning_briefing",
  {
    title: "Morning Briefing",
    description:
      "Get a structured 'how am I today' snapshot: today's readiness + recommended sleep time + yesterday's sleep, activity, stress, and tags. Use this when the user opens the day and wants a single overview call. Server returns raw fields — you decide what to highlight. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getMorningBriefingSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetMorningBriefing)
);

server.registerTool(
  "get_weekly_recap",
  {
    title: "Weekly Recap",
    description:
      "Get a 1-28 day window of daily Oura metrics with per-metric mean/min/max. Default 7 days. Use this when the user asks 'how was my week' or wants to scan the past N days at a glance. Pass user's LOCAL end_date as strict YYYY-MM-DD.",
    inputSchema: getWeeklyRecapSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetWeeklyRecap)
);
```

Verify:

```bash
npm run type-check
npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle
```

Commit:

```bash
git add src/mcp/registerTools.ts
git commit -m "register: wire up Phase 3 — morning_briefing + weekly_recap"
```

---

## Anticipated issues

- `daily_stress` may not be queryable for the briefing's yesterday if the path was wrong in Phase 2. `safeRequestList` catches non-auth errors and returns `[]`, so the composite still works.
- `sleep_time` similarly. The briefing degrades to `null` for that field.
- The `optimal_bedtime` shape from Oura may differ from the assumed `{start_offset, end_offset}`. If so, the briefing's `recommended_sleep_time` block returns `null` for the offsets but the rest of the call still works.
