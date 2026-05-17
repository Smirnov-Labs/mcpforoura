import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { RestModePeriod } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getRestModePeriodsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 365 days."),
};

export interface GetRestModePeriodsInput {
  start: string;
  end: string;
}

export interface RestModePeriodOut {
  start_day: string;
  end_day: string | null;
  duration_days: number | null;
  episode_type: string | null;
}

export interface GetRestModePeriodsResult {
  periods: RestModePeriodOut[];
}

const MAX_DAYS = 365;

export async function executeGetRestModePeriods(
  client: OuraClient,
  input: GetRestModePeriodsInput
): Promise<GetRestModePeriodsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS) throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<RestModePeriod>(
    "/usercollection/rest_mode_period",
    { start_date: input.start, end_date: input.end }
  );

  const periods: RestModePeriodOut[] = docs.map((p) => ({
    start_day: p.start_day,
    end_day: p.end_day ?? null,
    duration_days:
      p.end_day && p.start_day ? daysBetween(p.start_day, p.end_day) + 1 : null,
    episode_type: p.episode_type ?? null,
  }));
  periods.sort((a, b) => (a.start_day < b.start_day ? -1 : 1));
  return { periods };
}
