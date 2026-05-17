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
