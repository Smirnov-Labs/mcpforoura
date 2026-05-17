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
  // Unreachable while every caller passes a typed Metric, but kept as a typed
  // error so future ad-hoc callers get a structured response.
  throw new OuraInvalidInput(`Unsupported metric: ${metric}`);
}
