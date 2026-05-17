// src/mcp/tools/get-sessions.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { OuraSession } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getSessionsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 180 days."),
};

export interface GetSessionsInput {
  start: string;
  end: string;
}

interface SessionOut {
  date: string;
  type: string;
  duration_min: number;
  start_datetime: string;
  end_datetime: string;
  mood_before: string | null;
  mood_after: string | null;
}

export interface GetSessionsResult {
  sessions: SessionOut[];
}

const MAX_DAYS = 180;

export async function executeGetSessions(
  client: OuraClient,
  input: GetSessionsInput
): Promise<GetSessionsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span >= MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<OuraSession>("/usercollection/session", {
    start_date: input.start,
    end_date: input.end,
  });

  const sessions: SessionOut[] = docs.map((s) => {
    const startMs = new Date(s.start_datetime).getTime();
    const endMs = new Date(s.end_datetime).getTime();
    const duration_min =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.round((endMs - startMs) / 60000)
        : 0;
    return {
      date: s.day,
      type: s.type,
      duration_min,
      start_datetime: s.start_datetime,
      end_datetime: s.end_datetime,
      mood_before: (s as { mood_before?: string | null }).mood_before ?? null,
      mood_after: (s as { mood_after?: string | null }).mood_after ?? null,
    };
  });

  sessions.sort((a, b) => (a.start_datetime < b.start_datetime ? -1 : 1));
  return { sessions };
}
