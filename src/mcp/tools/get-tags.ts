// src/mcp/tools/get-tags.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { EnhancedTag } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { daysBetween, isIsoDate } from "./dates.js";

export const getTagsSchema = {
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (local)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (local). Max 180 days."),
};

export interface GetTagsInput {
  start: string;
  end: string;
}

interface TagOut {
  date: string;
  tag_type_code: string;
  custom_name: string | null;
  comment: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface GetTagsResult {
  tags: TagOut[];
}

const MAX_DAYS = 180;

export async function executeGetTags(
  client: OuraClient,
  input: GetTagsInput
): Promise<GetTagsResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) {
    throw new OuraInvalidInput("start and end must be YYYY-MM-DD.");
  }
  const span = daysBetween(input.start, input.end);
  if (span < 0) throw new OuraInvalidInput("end must be on or after start.");
  if (span > MAX_DAYS)
    throw new OuraInvalidInput(`Range too large (${span + 1} days). Max ${MAX_DAYS}.`);

  const docs = await client.collectAll<EnhancedTag>("/usercollection/enhanced_tag", {
    start_date: input.start,
    end_date: input.end,
  });

  const tags: TagOut[] = docs.map((t) => ({
    date: t.start_day ?? t.end_day ?? "",
    tag_type_code: t.tag_type_code,
    custom_name: t.custom_name ?? null,
    comment: t.comment ?? null,
    start_time: t.start_time ?? null,
    end_time: t.end_time ?? null,
  }));

  tags.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { tags };
}
