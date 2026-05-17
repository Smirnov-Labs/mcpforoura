import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  SleepPeriod,
} from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
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

const READINESS_METRICS = new Set<Metric>(["readiness_score"]);
const SLEEP_DAILY_METRICS = new Set<Metric>(["sleep_score"]);
// hrv (ms) and resting_hr (bpm) come from the per-night SleepPeriod document.
// daily_readiness exposes only normalized 0-100 *contributor scores* with the
// same names, which is not what users mean when they say "my HRV".
const SLEEP_PERIOD_METRICS = new Set<Metric>([
  "total_sleep_hours",
  "efficiency_pct",
  "hrv",
  "resting_hr",
]);
const ACTIVITY_METRICS = new Set<Metric>(["activity_score", "steps"]);

function pickReadiness(metric: Metric, doc: DailyReadiness): number | null {
  if (metric === "readiness_score") return doc.score ?? null;
  return null;
}

function pickActivity(metric: Metric, doc: DailyActivity): number | null {
  if (metric === "activity_score") return doc.score ?? null;
  if (metric === "steps") return doc.steps ?? null;
  return null;
}

function pickSleepPeriod(metric: Metric, p: SleepPeriod): number | null {
  switch (metric) {
    case "total_sleep_hours":
      return p.total_sleep_duration != null ? round(p.total_sleep_duration / 3600, 2) : null;
    case "efficiency_pct":
      return p.efficiency != null ? round(p.efficiency, 2) : null;
    case "hrv":
      // average_hrv is the per-night HRV average in milliseconds.
      return p.average_hrv ?? null;
    case "resting_hr":
      // lowest_heart_rate is the closest proxy to resting HR Oura exposes on
      // a per-night basis (resting state during sleep). average_heart_rate
      // would over-report due to REM/wake periods.
      return p.lowest_heart_rate ?? null;
    default:
      return null;
  }
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
      value: pickSleepPeriod(metric, p),
    }));
  }
  if (ACTIVITY_METRICS.has(metric)) {
    const docs = await client.collectAll<DailyActivity>("/usercollection/daily_activity", {
      start_date: start,
      end_date: end,
    });
    return docs.map((d) => ({ date: d.day, value: pickActivity(metric, d) }));
  }
  // Unreachable while every caller passes a typed Metric, but kept as a typed
  // error so future ad-hoc callers get a structured response.
  throw new OuraInvalidInput(`Unsupported metric: ${metric}`);
}
