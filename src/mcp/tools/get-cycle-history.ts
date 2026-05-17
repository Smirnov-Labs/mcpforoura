import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { CycleInsight } from "../../oura/types.js";
import { resolveDate } from "./dates.js";
import { fetchCycleHistory } from "./cycle-shared.js";
import { mean, nonNull, round, stdev } from "./stats.js";

export const getCycleHistorySchema = {
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End of history YYYY-MM-DD, user's LOCAL date (inclusive)."),
  cycles: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("How many recent cycles to return (1-24). Default 6."),
};

export interface GetCycleHistoryInput {
  end_date: string;
  cycles?: number;
}

interface CycleOut {
  start_date: string;
  end_date: string | null;
  length_days: number | null;
  predicted_length_days: number | null;
  deviation_from_prediction_days: number | null;
  regular: boolean;
}

export interface GetCycleHistoryResult {
  available: boolean;
  cycles: CycleOut[];
  summary?: {
    mean_length_days: number;
    stdev_length_days: number;
    regularity: "regular" | "irregular" | "insufficient_data";
  };
  reason?: string;
}

function classifyRegularity(stdevDays: number, completeCycles: number): "regular" | "irregular" | "insufficient_data" {
  if (completeCycles < 4) return "insufficient_data";
  if (stdevDays < 5) return "regular";
  return "irregular";
}

export async function executeGetCycleHistory(
  client: OuraClient,
  input: GetCycleHistoryInput
): Promise<GetCycleHistoryResult> {
  const end = resolveDate(input.end_date);
  const want = input.cycles ?? 6;
  // Pull a generous window (each cycle ~28-35 days) then trim to `want` most recent.
  const fetched = await fetchCycleHistory(client, end, Math.max(want * 45, 365));
  if (!fetched.available) {
    return { available: false, cycles: [], reason: fetched.reason };
  }
  if (fetched.cycles.length === 0) {
    return { available: false, cycles: [], reason: "No cycle data in the lookback window." };
  }

  const sorted = [...fetched.cycles].sort((a: CycleInsight, b: CycleInsight) =>
    a.start_day < b.start_day ? 1 : -1
  );
  const trimmed = sorted.slice(0, want);

  const out: CycleOut[] = trimmed.map((c) => {
    const length = c.length_days ?? null;
    const predicted = c.predicted_length_days ?? null;
    const deviation = length != null && predicted != null ? length - predicted : null;
    return {
      start_date: c.start_day,
      end_date: c.end_day ?? null,
      length_days: length,
      predicted_length_days: predicted,
      deviation_from_prediction_days: deviation,
      regular: deviation != null && Math.abs(deviation) <= 3,
    };
  });

  const completeLengths = nonNull(out.map((c) => c.length_days));
  let summary: GetCycleHistoryResult["summary"];
  if (completeLengths.length > 0) {
    summary = {
      mean_length_days: round(mean(completeLengths), 1),
      stdev_length_days:
        completeLengths.length > 1 ? round(stdev(completeLengths), 1) : 0,
      regularity: classifyRegularity(
        completeLengths.length > 1 ? stdev(completeLengths) : 0,
        completeLengths.length
      ),
    };
  }

  return { available: true, cycles: out, summary };
}
