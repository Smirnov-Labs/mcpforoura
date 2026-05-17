import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  DailyStress,
  SleepPeriod,
} from "../../oura/types.js";
import { OuraInvalidInput, OuraReauthRequired, OuraAccountUnavailable } from "../../errors.js";
import { daysBetween, isIsoDate, shiftDate } from "./dates.js";
import { mean, nonNull, round } from "./stats.js";

export const getWeeklyRecapSchema = {
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End date YYYY-MM-DD, user's LOCAL date (inclusive)."),
  days: z
    .number()
    .int()
    .min(1)
    .max(28)
    .optional()
    .describe("Window size in days, 1-28. Default 7."),
};

export interface GetWeeklyRecapInput {
  end_date: string;
  days?: number;
}

interface DailyRow {
  date: string;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  stress_high_sec: number | null;
  hrv: number | null;
  resting_hr: number | null;
  total_sleep_hours: number | null;
}

interface MetricStat {
  mean: number;
  min: number;
  max: number;
}

export interface GetWeeklyRecapResult {
  window: { start: string; end: string; days: number };
  daily: DailyRow[];
  stats: Partial<Record<keyof Omit<DailyRow, "date">, MetricStat>>;
}

async function safeCollect<T>(
  client: OuraClient,
  path: string,
  start: string,
  end: string
): Promise<T[]> {
  try {
    return await client.collectAll<T>(path, { start_date: start, end_date: end });
  } catch (err) {
    if (err instanceof OuraReauthRequired || err instanceof OuraAccountUnavailable) {
      throw err;
    }
    return [];
  }
}

function indexByDay<T extends { day: string }>(docs: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const d of docs) {
    if (!m.has(d.day)) m.set(d.day, d);
  }
  return m;
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const span = daysBetween(start, end);
  for (let i = 0; i <= span; i++) {
    out.push(shiftDate(start, i));
  }
  return out;
}

function statsFor(values: Array<number | null>): MetricStat | undefined {
  const arr = nonNull(values);
  if (arr.length === 0) return undefined;
  return {
    mean: round(mean(arr), 2),
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

export async function executeGetWeeklyRecap(
  client: OuraClient,
  input: GetWeeklyRecapInput
): Promise<GetWeeklyRecapResult> {
  if (!isIsoDate(input.end_date)) {
    throw new OuraInvalidInput("end_date must be YYYY-MM-DD.");
  }
  const days = input.days ?? 7;
  const end = input.end_date;
  const start = shiftDate(end, -(days - 1));
  const dates = enumerateDates(start, end);

  const [sleepDocs, readinessDocs, activityDocs, stressDocs, sleepPeriods] = await Promise.all([
    safeCollect<DailySleep>(client, "/usercollection/daily_sleep", start, end),
    safeCollect<DailyReadiness>(client, "/usercollection/daily_readiness", start, end),
    safeCollect<DailyActivity>(client, "/usercollection/daily_activity", start, end),
    safeCollect<DailyStress>(client, "/usercollection/daily_stress", start, end),
    safeCollect<SleepPeriod>(client, "/usercollection/sleep", start, end),
  ]);

  const sleepByDay = indexByDay(sleepDocs);
  const readinessByDay = indexByDay(readinessDocs);
  const activityByDay = indexByDay(activityDocs);
  const stressByDay = indexByDay(stressDocs);

  // Pick the longest sleep period per day for total_sleep_hours.
  const longestSleepByDay = new Map<string, SleepPeriod>();
  for (const p of sleepPeriods) {
    if (p.type !== "long_sleep" && p.type !== "sleep") continue;
    const existing = longestSleepByDay.get(p.day);
    const cur = p.total_sleep_duration ?? -1;
    const prev = existing?.total_sleep_duration ?? -2;
    if (cur > prev) longestSleepByDay.set(p.day, p);
  }

  const daily: DailyRow[] = dates.map((date) => ({
    date,
    sleep_score: sleepByDay.get(date)?.score ?? null,
    readiness_score: readinessByDay.get(date)?.score ?? null,
    activity_score: activityByDay.get(date)?.score ?? null,
    stress_high_sec: stressByDay.get(date)?.stress_high ?? null,
    hrv: readinessByDay.get(date)?.contributors?.hrv_balance ?? null,
    resting_hr: readinessByDay.get(date)?.contributors?.resting_heart_rate ?? null,
    total_sleep_hours: (() => {
      const p = longestSleepByDay.get(date);
      return p?.total_sleep_duration != null ? round(p.total_sleep_duration / 3600, 2) : null;
    })(),
  }));

  const stats: GetWeeklyRecapResult["stats"] = {};
  const fields: Array<keyof Omit<DailyRow, "date">> = [
    "sleep_score",
    "readiness_score",
    "activity_score",
    "stress_high_sec",
    "hrv",
    "resting_hr",
    "total_sleep_hours",
  ];
  for (const f of fields) {
    const s = statsFor(daily.map((row) => row[f]));
    if (s) stats[f] = s;
  }

  return {
    window: { start, end, days },
    daily,
    stats,
  };
}
