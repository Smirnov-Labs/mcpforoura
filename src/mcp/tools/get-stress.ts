import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyStress } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getStressSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetStressInput {
  date: string;
}

export interface GetStressResult {
  date: string;
  available: boolean;
  stress_high_seconds?: number | null;
  recovery_high_seconds?: number | null;
  day_summary?: string | null;
  reason?: string;
}

export async function executeGetStress(
  client: OuraClient,
  input: GetStressInput
): Promise<GetStressResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyStress>("/usercollection/daily_stress", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_stress data for this date." };
  }
  return {
    date,
    available: true,
    stress_high_seconds: doc.stress_high ?? null,
    recovery_high_seconds: doc.recovery_high ?? null,
    day_summary: doc.day_summary ?? null,
  };
}
