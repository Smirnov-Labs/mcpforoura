import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import { resolveDate } from "./dates.js";
import { cyclePhaseForDate, fetchCycleHistory } from "./cycle-shared.js";

export const getCyclePhaseSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetCyclePhaseInput {
  date: string;
}

export interface GetCyclePhaseResult {
  date: string;
  available: boolean;
  phase?: string;
  day_of_cycle?: number | null;
  cycle_start_date?: string | null;
  predicted_next_phase?: string | null;
  predicted_next_phase_start_date?: string | null;
  reason?: string;
}

export async function executeGetCyclePhase(
  client: OuraClient,
  input: GetCyclePhaseInput
): Promise<GetCyclePhaseResult> {
  const date = resolveDate(input.date);
  const fetched = await fetchCycleHistory(client, date, 90);
  if (!fetched.available) {
    return { date, available: false, reason: fetched.reason };
  }
  if (fetched.cycles.length === 0) {
    return { date, available: false, reason: "No cycle data in the past 90 days." };
  }
  const phaseInfo = cyclePhaseForDate(fetched.cycles, date);
  return {
    date,
    available: true,
    phase: phaseInfo.phase,
    day_of_cycle: phaseInfo.day_of_cycle,
    cycle_start_date: phaseInfo.cycle_start_date,
    predicted_next_phase: phaseInfo.predicted_next_phase,
    predicted_next_phase_start_date: phaseInfo.predicted_next_phase_start_date,
  };
}
