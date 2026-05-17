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
