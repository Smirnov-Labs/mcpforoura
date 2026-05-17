import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { RecommendedSleepTime } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getRecommendedSleepTimeSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetRecommendedSleepTimeInput {
  date: string;
}

export interface GetRecommendedSleepTimeResult {
  date: string;
  available: boolean;
  optimal_bedtime_start?: string;        // HH:MM
  optimal_bedtime_end?: string;          // HH:MM
  status?: string | null;
  recommendation?: string | null;
  reason?: string;
}

export function offsetToHHMM(offsetSeconds: number | undefined | null): string | undefined {
  if (typeof offsetSeconds !== "number") return undefined;
  // Normalize into [0, 86400)
  let s = ((offsetSeconds % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function executeGetRecommendedSleepTime(
  client: OuraClient,
  input: GetRecommendedSleepTimeInput
): Promise<GetRecommendedSleepTimeResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<RecommendedSleepTime>(
    "/usercollection/sleep_time",
    { start_date: date, end_date: date }
  );
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No recommended sleep_time entry for this date." };
  }
  const start = offsetToHHMM(doc.optimal_bedtime?.start_offset);
  const end = offsetToHHMM(doc.optimal_bedtime?.end_offset);
  return {
    date,
    available: true,
    optimal_bedtime_start: start,
    optimal_bedtime_end: end,
    status: doc.status ?? null,
    recommendation: doc.recommendation ?? null,
  };
}
