# Phase 5 (Cycle Analytics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add 3 menstrual-cycle-aware tools backed by Oura's Cycle Insights data, plus a privacy-page update calling out the new data category.

**Tech Stack:** TypeScript, Zod, reuses `fetchMetricPoints` from Phase 4, `OuraClient`. No new deps.

Reference: `docs/superpowers/specs/2026-05-16-tool-expansion-design.md` Phase 5 section.

---

## High-uncertainty zone

Per the spec's open questions:

- **OAuth scope** for cycle data is unclear. The Oura dev app currently has `email, personal, daily, heartrate, tag, workout, session, spo2, ring_configuration, stress, heart_health`. There is no explicit `cycle` scope visible in that list. If endpoints 403 in production, the user will need to enable a scope on the Oura dev app and have all 3 users re-authorize. **Phase 5 implementation makes that recoverable**, not blocking: each tool returns `{available: false, reason}` rather than throwing on 403/404.
- **Endpoint paths** are best-guesses. Primary: `/usercollection/cycle_insights`. Fallback paths to probe in production: `/usercollection/menstrual_cycle`, `/usercollection/period_prediction`.

The implementation handles these defensively. Discovery happens after deploy via real Claude tool calls.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/oura/types.ts` | modify | Add `CycleInsight`, `CyclePhaseInfo` types. |
| `src/oura/client.ts` | modify | Add `requestSafe<T>` that returns `{ok: true, data}` or `{ok: false, status, body}` instead of throwing on non-2xx. Used by cycle tools to detect 403/404 gracefully. |
| `src/mcp/tools/cycle-shared.ts` | create | Shared helpers: `fetchCycleHistory`, `cyclePhaseForDate`. Used by all 3 cycle tools. |
| `src/mcp/tools/get-cycle-phase.ts` | create | Single-date phase + day-of-cycle lookup. |
| `src/mcp/tools/get-cycle-history.ts` | create | Returns last N cycles with length stats + regularity classification. |
| `src/mcp/tools/compare-metric-across-cycle-phases.ts` | create | Phase-aware aggregation of a metric across the lookback window. |
| `src/mcp/registerTools.ts` | modify | Register the 3 new tools. |
| `src/oauth-app.ts` | modify | Add "menstrual-cycle data" to the Privacy page's "Data We Access" section. Bump `PRIVACY_LAST_UPDATED`. |
| `test/cycle-shared.test.ts` | create | Tests for `cyclePhaseForDate` + history regularity classification. |

## Invariants

1. **Defensive failure mode.** Every tool returns `{available: false, reason: "..."}` on 403/404 from the cycle endpoint, with a reason that explains both possible causes (scope not enabled, endpoint path wrong). Other errors propagate normally.
2. **Strict YYYY-MM-DD on date inputs.**
3. **All cycle endpoint calls go through `OuraClient.requestSafe`** — bypasses the M7 cache only on the *response handling*, not the read path. Cache writes only happen on success (200 OK), per M7's existing invariant.
4. **Phase classification.** Use Oura's `phase` field directly when present. If Oura returns date ranges per phase, map the queried date to the matching range. If the date is outside all known phases, return `phase: "unknown"`.

---

## Task 1: Add types

Edit `src/oura/types.ts`, appending:

```typescript
export interface CyclePhaseInfo {
  phase: "menstrual" | "follicular" | "ovulatory" | "luteal" | "unknown";
  start_day: string;
  end_day?: string | null;
}

export interface CycleInsight {
  id: string;
  start_day: string;
  end_day?: string | null;
  length_days?: number | null;
  predicted_length_days?: number | null;
  phases?: CyclePhaseInfo[] | null;
  [key: string]: unknown;
}
```

Commit:

```bash
git add src/oura/types.ts
git commit -m "types: CycleInsight, CyclePhaseInfo for Phase 5 cycle tools"
```

## Task 2: `OuraClient.requestSafe`

Edit `src/oura/client.ts`. Add a method that wraps `request` but returns a discriminated result so callers can distinguish 4xx/5xx from success without try/catch boilerplate.

After the existing `request<T>` method, add:

```typescript
async requestSafe<T>(
  path: string,
  query?: Record<string, string>
): Promise<
  | { ok: true; data: T }
  | { ok: false; status: number; body: string }
> {
  try {
    const data = await this.request<T>(path, query);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof Error) {
      const m = err.message.match(/failed \((\d+)\): (.*)$/s);
      if (m) {
        return { ok: false, status: Number.parseInt(m[1], 10), body: m[2] };
      }
    }
    throw err;
  }
}
```

Caveat: the discrimination relies on the error message format set by `request<T>` (line 116: `throw new Error(\`Oura API ${path} failed (${response.status}): ${body}\`)`). If that format changes, `requestSafe` falls back to re-throwing. Acceptable for now.

Commit:

```bash
git add src/oura/client.ts
git commit -m "OuraClient: add requestSafe that returns discriminated result on 4xx/5xx"
```

## Task 3: Cycle shared helpers

Create `src/mcp/tools/cycle-shared.ts`:

```typescript
import type { OuraClient } from "../../oura/client.js";
import type { CycleInsight, CyclePhaseInfo } from "../../oura/types.js";
import { daysBetween, shiftDate } from "./dates.js";

const CYCLE_PATH = "/usercollection/cycle_insights";

export interface CycleFetchResult {
  available: boolean;
  cycles: CycleInsight[];
  reason?: string;
}

export async function fetchCycleHistory(
  client: OuraClient,
  end: string,
  lookbackDays = 365
): Promise<CycleFetchResult> {
  const start = shiftDate(end, -(lookbackDays - 1));
  const res = await client.requestSafe<{ data: CycleInsight[]; next_token?: string | null }>(
    CYCLE_PATH,
    { start_date: start, end_date: end }
  );
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      return {
        available: false,
        cycles: [],
        reason: `Oura cycle endpoint returned ${res.status}. Either cycle-tracking scope is not enabled on the connector app, the endpoint path has changed, or this account does not have cycle insights. Have the operator check the Oura developer app's scope list.`,
      };
    }
    throw new Error(`Oura cycle endpoint failed (${res.status}): ${res.body}`);
  }
  return { available: true, cycles: res.data.data };
}

export function cyclePhaseForDate(
  cycles: CycleInsight[],
  date: string
): {
  phase: CyclePhaseInfo["phase"];
  day_of_cycle: number | null;
  cycle_start_date: string | null;
  predicted_next_phase: CyclePhaseInfo["phase"] | null;
  predicted_next_phase_start_date: string | null;
} {
  for (const cycle of cycles) {
    const cycleStart = cycle.start_day;
    const cycleEnd = cycle.end_day ?? shiftDate(cycleStart, 60); // generous fallback
    if (date < cycleStart || date > cycleEnd) continue;

    const phases = cycle.phases ?? [];
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const pStart = p.start_day;
      const pEnd = p.end_day ?? phases[i + 1]?.start_day ?? cycleEnd;
      if (date >= pStart && date <= pEnd) {
        const next = phases[i + 1];
        return {
          phase: p.phase,
          day_of_cycle: daysBetween(cycleStart, date) + 1,
          cycle_start_date: cycleStart,
          predicted_next_phase: next ? next.phase : null,
          predicted_next_phase_start_date: next ? next.start_day : null,
        };
      }
    }

    return {
      phase: "unknown",
      day_of_cycle: daysBetween(cycleStart, date) + 1,
      cycle_start_date: cycleStart,
      predicted_next_phase: null,
      predicted_next_phase_start_date: null,
    };
  }
  return {
    phase: "unknown",
    day_of_cycle: null,
    cycle_start_date: null,
    predicted_next_phase: null,
    predicted_next_phase_start_date: null,
  };
}
```

Commit:

```bash
git add src/mcp/tools/cycle-shared.ts
git commit -m "cycle-shared: fetchCycleHistory + cyclePhaseForDate helpers"
```

## Task 4: `get_cycle_phase`

Create `src/mcp/tools/get-cycle-phase.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { resolveDate } from "./dates.js";
import { cyclePhaseForDate, fetchCycleHistory } from "./cycle-shared.js";

export const getCyclePhaseSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetCyclePhaseInput {
  date: string;
}

export interface GetCyclePhaseResult {
  date: string;
  available: boolean;
  phase?: string;
  day_of_cycle?: number | null;
  cycle_start_date?: string | null;
  predicted_next_phase?: string | null;
  predicted_next_phase_start_date?: string | null;
  reason?: string;
}

export async function executeGetCyclePhase(
  client: OuraClient,
  input: GetCyclePhaseInput
): Promise<GetCyclePhaseResult> {
  const date = resolveDate(input.date);
  const fetched = await fetchCycleHistory(client, date, 90);
  if (!fetched.available) {
    return { date, available: false, reason: fetched.reason };
  }
  if (fetched.cycles.length === 0) {
    return { date, available: false, reason: "No cycle data in the past 90 days." };
  }
  const phaseInfo = cyclePhaseForDate(fetched.cycles, date);
  return {
    date,
    available: true,
    phase: phaseInfo.phase,
    day_of_cycle: phaseInfo.day_of_cycle,
    cycle_start_date: phaseInfo.cycle_start_date,
    predicted_next_phase: phaseInfo.predicted_next_phase,
    predicted_next_phase_start_date: phaseInfo.predicted_next_phase_start_date,
  };
}
```

Commit:

```bash
git add src/mcp/tools/get-cycle-phase.ts
git commit -m "tools: get_cycle_phase (current phase + day-of-cycle for a date)"
```

## Task 5: `get_cycle_history`

Create `src/mcp/tools/get-cycle-history.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { CycleInsight } from "../../oura/types.js";
import { resolveDate } from "./dates.js";
import { fetchCycleHistory } from "./cycle-shared.js";
import { mean, nonNull, round, stdev } from "./stats.js";

export const getCycleHistorySchema = {
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End of history YYYY-MM-DD, user's LOCAL date (inclusive)."),
  cycles: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("How many recent cycles to return (1-24). Default 6."),
};

export interface GetCycleHistoryInput {
  end_date: string;
  cycles?: number;
}

interface CycleOut {
  start_date: string;
  end_date: string | null;
  length_days: number | null;
  predicted_length_days: number | null;
  deviation_from_prediction_days: number | null;
  regular: boolean;
}

export interface GetCycleHistoryResult {
  available: boolean;
  cycles: CycleOut[];
  summary?: {
    mean_length_days: number;
    stdev_length_days: number;
    regularity: "regular" | "irregular" | "insufficient_data";
  };
  reason?: string;
}

function classifyRegularity(stdevDays: number, completeCycles: number): "regular" | "irregular" | "insufficient_data" {
  if (completeCycles < 4) return "insufficient_data";
  if (stdevDays < 5) return "regular";
  return "irregular";
}

export async function executeGetCycleHistory(
  client: OuraClient,
  input: GetCycleHistoryInput
): Promise<GetCycleHistoryResult> {
  const end = resolveDate(input.end_date);
  const want = input.cycles ?? 6;
  // Pull a generous window (each cycle ~28-35 days) then trim to `want` most recent.
  const fetched = await fetchCycleHistory(client, end, Math.max(want * 45, 365));
  if (!fetched.available) {
    return { available: false, cycles: [], reason: fetched.reason };
  }
  if (fetched.cycles.length === 0) {
    return { available: false, cycles: [], reason: "No cycle data in the lookback window." };
  }

  const sorted = [...fetched.cycles].sort((a: CycleInsight, b: CycleInsight) =>
    a.start_day < b.start_day ? 1 : -1
  );
  const trimmed = sorted.slice(0, want);

  const out: CycleOut[] = trimmed.map((c) => {
    const length = c.length_days ?? null;
    const predicted = c.predicted_length_days ?? null;
    const deviation = length != null && predicted != null ? length - predicted : null;
    return {
      start_date: c.start_day,
      end_date: c.end_day ?? null,
      length_days: length,
      predicted_length_days: predicted,
      deviation_from_prediction_days: deviation,
      regular: deviation != null && Math.abs(deviation) <= 3,
    };
  });

  const completeLengths = nonNull(out.map((c) => c.length_days));
  let summary: GetCycleHistoryResult["summary"];
  if (completeLengths.length > 0) {
    summary = {
      mean_length_days: round(mean(completeLengths), 1),
      stdev_length_days:
        completeLengths.length > 1 ? round(stdev(completeLengths), 1) : 0,
      regularity: classifyRegularity(
        completeLengths.length > 1 ? stdev(completeLengths) : 0,
        completeLengths.length
      ),
    };
  }

  return { available: true, cycles: out, summary };
}
```

Commit:

```bash
git add src/mcp/tools/get-cycle-history.ts
git commit -m "tools: get_cycle_history (recent N cycles + length/regularity stats)"
```

## Task 6: `compare_metric_across_cycle_phases`

Create `src/mcp/tools/compare-metric-across-cycle-phases.ts`:

```typescript
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { OuraInvalidInput } from "../../errors.js";
import { isIsoDate, shiftDate, today } from "./dates.js";
import { fetchCycleHistory, cyclePhaseForDate } from "./cycle-shared.js";
import { fetchMetricPoints, type Metric } from "./metric-fetch.js";
import { mean, nonNull, round, stdev } from "./stats.js";

const METRIC = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "hrv",
  "resting_hr",
  "total_sleep_hours",
  "efficiency_pct",
]);

export const compareMetricAcrossCyclePhasesSchema = {
  metric: METRIC.describe("Metric to compare across phases."),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of window YYYY-MM-DD, user's LOCAL date. Default: today (server UTC)."),
  lookback_days: z
    .number()
    .int()
    .min(28)
    .max(540)
    .optional()
    .describe("Window size 28-540 days. Default 180."),
};

export interface CompareInput {
  metric: Metric;
  end_date?: string;
  lookback_days?: number;
}

interface PhaseStat {
  n: number;
  mean: number;
  median: number;
  stdev: number;
}

const PHASES = ["menstrual", "follicular", "ovulatory", "luteal"] as const;
type PhaseName = (typeof PHASES)[number];

export interface CompareCycleResult {
  available: boolean;
  metric: Metric;
  window?: { start: string; end: string; days: number };
  by_phase?: Partial<Record<PhaseName, PhaseStat>>;
  complete_cycles_in_window?: number;
  insufficient_data?: boolean;
  reason?: string;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function phaseStat(values: number[]): PhaseStat {
  return {
    n: values.length,
    mean: values.length > 0 ? round(mean(values), 2) : Number.NaN,
    median: values.length > 0 ? round(medianOf(values), 2) : Number.NaN,
    stdev: values.length > 1 ? round(stdev(values), 2) : Number.NaN,
  };
}

export async function executeCompareMetricAcrossCyclePhases(
  client: OuraClient,
  input: CompareInput
): Promise<CompareCycleResult> {
  const end = input.end_date ?? today();
  if (!isIsoDate(end)) {
    throw new OuraInvalidInput("end_date must be YYYY-MM-DD.");
  }
  const days = input.lookback_days ?? 180;
  const start = shiftDate(end, -(days - 1));

  const [cycleFetch, metricPoints] = await Promise.all([
    fetchCycleHistory(client, end, days),
    fetchMetricPoints(client, input.metric, start, end),
  ]);

  if (!cycleFetch.available) {
    return {
      available: false,
      metric: input.metric,
      reason: cycleFetch.reason,
    };
  }
  if (cycleFetch.cycles.length === 0) {
    return {
      available: false,
      metric: input.metric,
      reason: "No cycle data in the lookback window.",
    };
  }

  const buckets: Record<PhaseName, number[]> = {
    menstrual: [],
    follicular: [],
    ovulatory: [],
    luteal: [],
  };

  for (const p of metricPoints) {
    if (p.value === null) continue;
    const info = cyclePhaseForDate(cycleFetch.cycles, p.date);
    if (info.phase === "unknown") continue;
    buckets[info.phase as PhaseName].push(p.value);
  }

  const byPhase: Partial<Record<PhaseName, PhaseStat>> = {};
  for (const phase of PHASES) {
    if (buckets[phase].length > 0) byPhase[phase] = phaseStat(buckets[phase]);
  }

  const completeCycles = cycleFetch.cycles.filter((c) => c.length_days != null).length;
  const insufficient =
    completeCycles < 3 ||
    Object.values(byPhase).some((stat) => stat.n < 3);

  return {
    available: true,
    metric: input.metric,
    window: { start, end, days },
    by_phase: byPhase,
    complete_cycles_in_window: completeCycles,
    insufficient_data: insufficient,
  };
}
```

Commit:

```bash
git add src/mcp/tools/compare-metric-across-cycle-phases.ts
git commit -m "tools: compare_metric_across_cycle_phases (phase-bucketed metric stats)"
```

## Task 7: Tests

Create `test/cycle-shared.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { cyclePhaseForDate } from "../src/mcp/tools/cycle-shared";
import type { CycleInsight } from "../src/oura/types";

const cycle: CycleInsight = {
  id: "c1",
  start_day: "2026-04-15",
  end_day: "2026-05-12",
  length_days: 28,
  predicted_length_days: 28,
  phases: [
    { phase: "menstrual", start_day: "2026-04-15", end_day: "2026-04-19" },
    { phase: "follicular", start_day: "2026-04-20", end_day: "2026-04-28" },
    { phase: "ovulatory", start_day: "2026-04-29", end_day: "2026-05-01" },
    { phase: "luteal", start_day: "2026-05-02", end_day: "2026-05-12" },
  ],
};

describe("cyclePhaseForDate", () => {
  it("returns menstrual for a day in the menstrual phase", () => {
    const out = cyclePhaseForDate([cycle], "2026-04-17");
    expect(out.phase).toBe("menstrual");
    expect(out.day_of_cycle).toBe(3);
    expect(out.cycle_start_date).toBe("2026-04-15");
    expect(out.predicted_next_phase).toBe("follicular");
  });

  it("returns ovulatory for a day in that phase", () => {
    const out = cyclePhaseForDate([cycle], "2026-04-30");
    expect(out.phase).toBe("ovulatory");
    expect(out.day_of_cycle).toBe(16);
    expect(out.predicted_next_phase).toBe("luteal");
  });

  it("returns luteal for the last day of the cycle", () => {
    const out = cyclePhaseForDate([cycle], "2026-05-12");
    expect(out.phase).toBe("luteal");
    expect(out.predicted_next_phase).toBeNull();
  });

  it("returns unknown when date is outside all cycles", () => {
    const out = cyclePhaseForDate([cycle], "2026-06-01");
    expect(out.phase).toBe("unknown");
    expect(out.day_of_cycle).toBeNull();
    expect(out.cycle_start_date).toBeNull();
  });

  it("returns unknown when cycles array is empty", () => {
    const out = cyclePhaseForDate([], "2026-04-17");
    expect(out.phase).toBe("unknown");
  });
});
```

Run `npm run test:unit` — expect 5 new tests on top of 51 = 56 total.

Commit:

```bash
git add test/cycle-shared.test.ts
git commit -m "tests: cyclePhaseForDate across all 4 phases + edge cases"
```

## Task 8: Register tools + update privacy page

Edit `src/mcp/registerTools.ts`. Add imports:

```typescript
import { getCyclePhaseSchema, executeGetCyclePhase } from "./tools/get-cycle-phase.js";
import { getCycleHistorySchema, executeGetCycleHistory } from "./tools/get-cycle-history.js";
import {
  compareMetricAcrossCyclePhasesSchema,
  executeCompareMetricAcrossCyclePhases,
} from "./tools/compare-metric-across-cycle-phases.js";
```

Add registrations after Phase 4:

```typescript
server.registerTool(
  "get_cycle_phase",
  {
    title: "Cycle Phase",
    description:
      "Get the current menstrual cycle phase (menstrual/follicular/ovulatory/luteal) and day-of-cycle for a date, plus the predicted next phase. Returns available=false with a reason if cycle data isn't enabled or available. Pass user's LOCAL date as strict YYYY-MM-DD.",
    inputSchema: getCyclePhaseSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetCyclePhase)
);

server.registerTool(
  "get_cycle_history",
  {
    title: "Cycle History",
    description:
      "List the most recent N (1-24, default 6) menstrual cycles with start date, length, predicted length, and a regularity summary (regular if stdev<5 days over 4+ complete cycles). Pass user's LOCAL end_date as strict YYYY-MM-DD.",
    inputSchema: getCycleHistorySchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeGetCycleHistory)
);

server.registerTool(
  "compare_metric_across_cycle_phases",
  {
    title: "Metric Across Cycle Phases",
    description:
      "Compute mean/median/stdev of a metric (HRV, sleep_score, readiness_score, etc.) bucketed by menstrual cycle phase across the lookback window (28-540 days, default 180). Use to answer 'is my HRV always lower in luteal?'. insufficient_data=true when <3 complete cycles or any phase has <3 days of data.",
    inputSchema: compareMetricAcrossCyclePhasesSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  clientTool(env, props, executeCompareMetricAcrossCyclePhases)
);
```

Then update `src/oauth-app.ts`:

1. Find `const PRIVACY_LAST_UPDATED = "2026-05-16";` (or whatever current value is) and bump it to the current commit date if different.
2. In the `renderPrivacyPage` function, find the `<h2>Data We Access</h2>` paragraph. Change "...can include daily readiness, sleep, activity, stress, heart-rate series, workouts, mindfulness sessions, user-entered tags, SpO2, and ring/personal metadata." to add `, and menstrual-cycle insights (phase, history, and length data)` before the period.

Verify:

```bash
npm run type-check
npx wrangler deploy --dry-run --outdir=/tmp/mcpforoura-bundle
```

Commit:

```bash
git add src/mcp/registerTools.ts src/oauth-app.ts
git commit -m "register: wire up Phase 5 cycle tools + update privacy page"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| get_cycle_phase (phase, day-of-cycle, predicted next) | Task 4 |
| get_cycle_history (last N cycles + regularity) | Task 5 |
| compare_metric_across_cycle_phases (phase-bucketed stats) | Task 6 |
| Defensive on 403/404 (scope/path failure) | Task 2 + Task 3 |
| `insufficient_data` signaling | Tasks 5, 6 |
| Reuses fetchMetricPoints + stats helpers | Task 6 |
| Privacy page updated to call out cycle data | Task 8 |
| Registered in registerTools.ts | Task 8 |

## Anticipated issues

1. **Endpoint path 404.** Primary guess `/usercollection/cycle_insights` may be wrong. Each tool returns `{available: false, reason}` cleanly. After deploy, user tests; if all 3 fail with 404, document the missing endpoint and the path-discovery work is a follow-up.
2. **Scope 403.** If the OAuth scope for cycle data is missing, same defensive return. Operator needs to enable the scope on the Oura dev app and have users re-authorize.
3. **Phase shape unknown.** I'm assuming Oura's response includes a `phases` array per cycle with `{phase, start_day, end_day}`. If the real shape differs (e.g., separate fields per phase), `cyclePhaseForDate` will return `phase: "unknown"` for every date and the tools degrade gracefully. We adjust based on real responses.
