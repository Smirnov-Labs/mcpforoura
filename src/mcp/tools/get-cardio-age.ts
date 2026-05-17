import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyCardiovascularAge } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getCardioAgeSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetCardioAgeInput {
  date: string;
}

export interface GetCardioAgeResult {
  date: string;
  available: boolean;
  vascular_age_years?: number | null;
  reason?: string;
}

export async function executeGetCardioAge(
  client: OuraClient,
  input: GetCardioAgeInput
): Promise<GetCardioAgeResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyCardiovascularAge>(
    "/usercollection/daily_cardiovascular_age",
    {
      start_date: date,
      end_date: date,
    }
  );
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_cardiovascular_age data for this date." };
  }
  return {
    date,
    available: true,
    vascular_age_years: doc.vascular_age ?? null,
  };
}
