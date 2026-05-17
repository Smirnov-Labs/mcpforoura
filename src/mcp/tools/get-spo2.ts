import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { DailySpO2 } from "../../oura/types.js";
import { resolveDate } from "./dates.js";

export const getSpo2Schema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetSpo2Input {
  date: string;
}

export interface GetSpo2Result {
  date: string;
  available: boolean;
  average_oxygen_pct?: number | null;
  breathing_disturbance_index?: number | null;
  reason?: string;
}

export async function executeGetSpo2(
  client: OuraClient,
  input: GetSpo2Input
): Promise<GetSpo2Result> {
  const date = resolveDate(input.date);
  const list = await client.requestList<DailySpO2>("/usercollection/daily_spo2", {
    start_date: date,
    end_date: date,
  });
  const doc = list.data.find((d) => d.day === date) ?? list.data[0];
  if (!doc) {
    return { date, available: false, reason: "No daily_spo2 data for this date." };
  }
  return {
    date,
    available: true,
    average_oxygen_pct: doc.spo2_percentage?.average ?? null,
    breathing_disturbance_index: doc.breathing_disturbance_index ?? null,
  };
}
