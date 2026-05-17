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
