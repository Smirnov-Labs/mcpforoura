import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailyResilience } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getResilienceSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetResilienceInput {
  date: string;
}

export interface GetResilienceResult {
  date: string;
  available: boolean;
  level?: string | null;
  contributors?: DailyResilience["contributors"];
  reason?: string;
}

export async function executeGetResilience(
  client: OuraClient,
  input: GetResilienceInput
): Promise<GetResilienceResult> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailyResilience>("/usercollection/daily_resilience", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_resilience data for this date." };
  }
  return {
    date,
    available: true,
    level: doc.level ?? null,
    contributors: doc.contributors ?? null,
  };
}
