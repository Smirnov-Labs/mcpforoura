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

function groupStat(values: Array<number | null>): GroupStat {
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
