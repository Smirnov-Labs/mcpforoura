import type { OuraClient } from "../../oura/client.js";
import type { SleepPeriod } from "../../oura/types.js";
import { shiftDate, today } from "./dates.js";

export const lastNightSleepSchema = {};

export interface LastNightSleepResult {
  available: boolean;
  date?: string;
  score?: number | null;
  total_sleep_hours?: number | null;
  deep_hours?: number | null;
  rem_hours?: number | null;
  light_hours?: number | null;
  awake_hours?: number | null;
  efficiency_pct?: number | null;
  bedtime_start?: string;
  bedtime_end?: string;
  avg_hr_bpm?: number | null;
  lowest_hr_bpm?: number | null;
  avg_hrv_ms?: number | null;
  reason?: string;
}

function secToHours(s: number | null | undefined): number | null {
  return typeof s === "number" ? +(s / 3600).toFixed(2) : null;
}

export async function executeLastNightSleep(
  client: OuraClient,
  _input?: Record<string, never>
): Promise<LastNightSleepResult> {
  const end = today();
  const start = shiftDate(end, -2);

  const periods = await client.collectAll<SleepPeriod>("/usercollection/sleep", {
    start_date: start,
    end_date: end,
  });

  const longSleeps = periods.filter(
    (p) => (p.type === "long_sleep" || p.type === "sleep") && p.total_sleep_duration != null
  );

  if (longSleeps.length === 0) {
    return { available: false, reason: "No sleep periods in the last 2 days." };
  }

  longSleeps.sort((a, b) => (a.bedtime_end < b.bedtime_end ? 1 : -1));
  const best = longSleeps[0];

  return {
    available: true,
    date: best.day,
    score: best.readiness?.score ?? null,
    total_sleep_hours: secToHours(best.total_sleep_duration),
    deep_hours: secToHours(best.deep_sleep_duration),
    rem_hours: secToHours(best.rem_sleep_duration),
    light_hours: secToHours(best.light_sleep_duration),
    awake_hours: secToHours(best.awake_time),
    efficiency_pct: best.efficiency != null ? +best.efficiency.toFixed(2) : null,
    bedtime_start: best.bedtime_start,
    bedtime_end: best.bedtime_end,
    avg_hr_bpm: best.average_heart_rate,
    lowest_hr_bpm: best.lowest_heart_rate,
    avg_hrv_ms: best.average_hrv,
  };
}
