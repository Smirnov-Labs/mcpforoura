import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyActivity, DailyReadiness, DailySleep } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

const SCOPE = z.enum(["sleep", "readiness", "activity"]);

export const dailySummarySchema = {
  date: z
    .string()
    .describe("Date (YYYY-MM-DD), or 'today' / 'yesterday'."),
  scopes: z
    .array(SCOPE)
    .optional()
    .describe("Which scores to include. Default: all three."),
};

export type DailySummaryInput = {
  date: string;
  scopes?: ("sleep" | "readiness" | "activity")[];
};

interface DailySummaryResult {
  date: string;
  sleep?: ReturnType<typeof shapeSleep>;
  readiness?: ReturnType<typeof shapeReadiness>;
  activity?: ReturnType<typeof shapeActivity>;
}

function shapeSleep(doc: DailySleep | undefined) {
  if (!doc) return null;
  return {
    score: doc.score,
    contributors: doc.contributors ?? null,
  };
}

function shapeReadiness(doc: DailyReadiness | undefined) {
  if (!doc) return null;
  return {
    score: doc.score,
    temperature_deviation: doc.temperature_deviation ?? null,
    contributors: doc.contributors ?? null,
  };
}

function shapeActivity(doc: DailyActivity | undefined) {
  if (!doc) return null;
  const secToMin = (s: number | null | undefined) =>
    typeof s === "number" ? Math.round(s / 60) : null;
  return {
    score: doc.score,
    steps: doc.steps ?? null,
    active_calories: doc.active_calories ?? null,
    total_calories: doc.total_calories ?? null,
    high_activity_minutes: secToMin(doc.high_activity_time),
    medium_activity_minutes: secToMin(doc.medium_activity_time),
    low_activity_minutes: secToMin(doc.low_activity_time),
  };
}

async function fetchDoc<T extends { day: string }>(
  client: OuraClient,
  path: string,
  date: string
): Promise<T | undefined> {
  const list = await client.requestList<T>(path, { start_date: date, end_date: date });
  return list.data.find((d) => d.day === date) ?? list.data[0];
}

export async function executeDailySummary(
  client: OuraClient,
  input: DailySummaryInput
): Promise<DailySummaryResult> {
  const date = resolveDate(input.date);
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : ["sleep", "readiness", "activity"];
  const wantSleep = scopes.includes("sleep");
  const wantReadiness = scopes.includes("readiness");
  const wantActivity = scopes.includes("activity");

  const [sleep, readiness, activity] = await Promise.all([
    wantSleep
      ? fetchDoc<DailySleep>(client, "/usercollection/daily_sleep", date)
      : Promise.resolve(undefined),
    wantReadiness
      ? fetchDoc<DailyReadiness>(client, "/usercollection/daily_readiness", date)
      : Promise.resolve(undefined),
    wantActivity
      ? fetchDoc<DailyActivity>(client, "/usercollection/daily_activity", date)
      : Promise.resolve(undefined),
  ]);

  const result: DailySummaryResult = { date };
  if (wantSleep) result.sleep = shapeSleep(sleep);
  if (wantReadiness) result.readiness = shapeReadiness(readiness);
  if (wantActivity) result.activity = shapeActivity(activity);
  return result;
}
