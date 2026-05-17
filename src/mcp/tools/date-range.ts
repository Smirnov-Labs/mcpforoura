import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { OuraInvalidInput } from "../../errors.js";
import type { DailyActivity, DailyReadiness, DailySleep, SleepPeriod } from "../../oura/types.js";
import { daysBetween, isIsoDate } from "./dates.js";

const RANGE_METRIC = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "hrv",
  "resting_hr",
  "steps",
  "total_sleep_hours",
  "efficiency_pct",
]);

export type RangeMetric = z.infer<typeof RANGE_METRIC>;

export const dateRangeSchema = {
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "Start date in strict YYYY-MM-DD using the user's LOCAL date (Oura attributes data to local days)."
    ),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "End date in strict YYYY-MM-DD (user's local date). Max 180 days from start."
    ),
  metric: RANGE_METRIC.describe(
    "Which metric to project over the range. sleep_score/total_sleep_hours/efficiency_pct come from daily_sleep + sleep endpoints; readiness_score/hrv/resting_hr come from daily_readiness; activity_score/steps from daily_activity."
  ),
};

export type DateRangeInput = { start: string; end: string; metric: RangeMetric };

const MAX_RANGE_DAYS = 180;

const READINESS_METRICS = new Set<RangeMetric>(["readiness_score", "hrv", "resting_hr"]);
const SLEEP_DAILY_METRICS = new Set<RangeMetric>(["sleep_score"]);
const SLEEP_PERIOD_METRICS = new Set<RangeMetric>(["total_sleep_hours", "efficiency_pct"]);
const ACTIVITY_METRICS = new Set<RangeMetric>(["activity_score", "steps"]);

export interface DateRangePoint {
  date: string;
  value: number | null;
}

export interface DateRangeResult {
  metric: RangeMetric;
  points: DateRangePoint[];
}

function validateRange(start: string, end: string) {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(start, end);
  if (span < 0) {
    throw new OuraInvalidInput("end must be on or after start.");
  }
  if (span > MAX_RANGE_DAYS) {
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_RANGE_DAYS} days.`);
  }
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const span = daysBetween(start, end);
  for (let i = 0; i <= span; i++) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function indexByDay<T extends { day: string }>(docs: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const d of docs) {
    if (!m.has(d.day)) m.set(d.day, d);
  }
  return m;
}

function pickReadinessValue(metric: RangeMetric, doc: DailyReadiness | undefined): number | null {
  if (!doc) return null;
  if (metric === "readiness_score") return doc.score ?? null;
  if (metric === "hrv") return doc.contributors?.hrv_balance ?? null;
  if (metric === "resting_hr") return doc.contributors?.resting_heart_rate ?? null;
  return null;
}

function pickSleepValue(metric: RangeMetric, doc: DailySleep | undefined): number | null {
  if (!doc) return null;
  if (metric === "sleep_score") return doc.score ?? null;
  return null;
}

function pickSleepPeriodValue(metric: RangeMetric, period: SleepPeriod | undefined): number | null {
  if (!period) return null;
  if (metric === "total_sleep_hours") {
    return period.total_sleep_duration != null ? +(period.total_sleep_duration / 3600).toFixed(2) : null;
  }
  if (metric === "efficiency_pct") {
    return period.efficiency != null ? +period.efficiency.toFixed(2) : null;
  }
  return null;
}

function pickActivityValue(metric: RangeMetric, doc: DailyActivity | undefined): number | null {
  if (!doc) return null;
  if (metric === "activity_score") return doc.score ?? null;
  if (metric === "steps") return doc.steps ?? null;
  return null;
}

export async function executeDateRange(
  client: OuraClient,
  input: DateRangeInput
): Promise<DateRangeResult> {
  validateRange(input.start, input.end);
  const dates = enumerateDates(input.start, input.end);

  if (READINESS_METRICS.has(input.metric)) {
    const docs = await client.collectAll<DailyReadiness>("/usercollection/daily_readiness", {
      start_date: input.start,
      end_date: input.end,
    });
    const byDay = indexByDay(docs);
    return {
      metric: input.metric,
      points: dates.map((date) => ({ date, value: pickReadinessValue(input.metric, byDay.get(date)) })),
    };
  }

  if (SLEEP_DAILY_METRICS.has(input.metric)) {
    const docs = await client.collectAll<DailySleep>("/usercollection/daily_sleep", {
      start_date: input.start,
      end_date: input.end,
    });
    const byDay = indexByDay(docs);
    return {
      metric: input.metric,
      points: dates.map((date) => ({ date, value: pickSleepValue(input.metric, byDay.get(date)) })),
    };
  }

  if (SLEEP_PERIOD_METRICS.has(input.metric)) {
    const periods = await client.collectAll<SleepPeriod>("/usercollection/sleep", {
      start_date: input.start,
      end_date: input.end,
    });
    const byDay = new Map<string, SleepPeriod>();
    for (const p of periods) {
      if (p.type !== "long_sleep" && p.type !== "sleep") continue;
      const existing = byDay.get(p.day);
      const current = p.total_sleep_duration ?? 0;
      const prev = existing?.total_sleep_duration ?? -1;
      if (current > prev) byDay.set(p.day, p);
    }
    return {
      metric: input.metric,
      points: dates.map((date) => ({ date, value: pickSleepPeriodValue(input.metric, byDay.get(date)) })),
    };
  }

  if (ACTIVITY_METRICS.has(input.metric)) {
    const docs = await client.collectAll<DailyActivity>("/usercollection/daily_activity", {
      start_date: input.start,
      end_date: input.end,
    });
    const byDay = indexByDay(docs);
    return {
      metric: input.metric,
      points: dates.map((date) => ({ date, value: pickActivityValue(input.metric, byDay.get(date)) })),
    };
  }

  throw new OuraInvalidInput(`Unsupported metric: ${input.metric}`);
}
