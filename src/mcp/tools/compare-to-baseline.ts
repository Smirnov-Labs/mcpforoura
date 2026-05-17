// src/mcp/tools/compare-to-baseline.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { OuraInvalidInput } from "../../errors.js";
import { isIsoDate, shiftDate, today } from "./dates.js";
import { mean, nonNull, percentileOf, round, stdev } from "./stats.js";
import { fetchMetricPoints, type DayValue, type Metric } from "./metric-fetch.js";

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

const MIN_NON_NULL = 14;

export async function executeCompareToBaseline(
  client: OuraClient,
  input: CompareToBaselineInput
): Promise<CompareToBaselineResult> {
  const date = input.date ?? today();
  if (!isIsoDate(date)) {
    throw new OuraInvalidInput("date must be YYYY-MM-DD.");
  }

  const start = shiftDate(date, -89); // 90-day window ending on date inclusive
  const points: DayValue[] = await fetchMetricPoints(client, input.metric as Metric, start, date);

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
