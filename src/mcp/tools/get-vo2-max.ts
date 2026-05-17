import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { VO2MaxSample } from "../../oura/types.js";
import { resolveDate, shiftDate } from "./dates.js";

export const getVo2MaxSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date. Returns the most recent VO2 max within 30 days of this date."),
};

export interface GetVo2MaxInput {
  date: string;
}

export interface GetVo2MaxResult {
  date_queried: string;
  available: boolean;
  measurement_date?: string;
  vo2_max?: number | null;
  reason?: string;
}

export async function executeGetVo2Max(
  client: OuraClient,
  input: GetVo2MaxInput
): Promise<GetVo2MaxResult> {
  const date = resolveDate(input.date);
  const start = shiftDate(date, -29);
  const docs = await client.collectAll<VO2MaxSample>("/usercollection/vO2_max", {
    start_date: start,
    end_date: date,
  });
  if (docs.length === 0) {
    return {
      date_queried: date,
      available: false,
      reason: "No VO2 max measurements in the past 30 days. Oura computes VO2 max from outdoor walks/runs.",
    };
  }
  // Most recent first
  docs.sort((a, b) => (a.day < b.day ? 1 : -1));
  const latest = docs[0];
  return {
    date_queried: date,
    available: true,
    measurement_date: latest.day,
    vo2_max: latest.vo2_max ?? null,
  };
}
