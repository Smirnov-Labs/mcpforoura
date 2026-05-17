// src/mcp/tools/get-workouts.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { Workout } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getWorkoutsSchema = {
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Start date YYYY-MM-DD, user's LOCAL date."),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("End date YYYY-MM-DD, user's LOCAL date. Max 180 days."),
};

export interface GetWorkoutsInput {
  start: string;
  end: string;
}

interface WorkoutOut {
  date: string;
  activity: string;
  start_datetime: string;
  end_datetime: string;
  duration_min: number;
  calories: number | null;
  intensity: string;
  distance_m: number | null;
  source: string;
}

export interface GetWorkoutsResult {
  workouts: WorkoutOut[];
}

const MAX_DAYS = 180;

export async function executeGetWorkouts(
  client: OuraClient,
  input: GetWorkoutsInput
): Promise<GetWorkoutsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span >= MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<Workout>("/usercollection/workout", {
    start_date: input.start,
    end_date: input.end,
  });

  const workouts: WorkoutOut[] = docs.map((w) => {
    const startMs = new Date(w.start_datetime).getTime();
    const endMs = new Date(w.end_datetime).getTime();
    const duration_min =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.round((endMs - startMs) / 60000)
        : 0;
    return {
      date: w.day,
      activity: w.activity,
      start_datetime: w.start_datetime,
      end_datetime: w.end_datetime,
      duration_min,
      calories: w.calories,
      intensity: w.intensity,
      distance_m: w.distance,
      source: w.source,
    };
  });

  workouts.sort((a, b) => (a.start_datetime < b.start_datetime ? -1 : 1));
  return { workouts };
}
