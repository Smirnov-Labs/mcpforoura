// src/mcp/tools/get-heart-rate-series.ts
import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type { HeartRateSample } from "../../oura/types.js";
import { OuraInvalidInput } from "../../errors.js";
import { mean, nonNull, round } from "./stats.js";

const RESOLUTION = z.enum(["raw", "5min", "15min"]);
export type HrResolution = z.infer<typeof RESOLUTION>;

export const getHeartRateSeriesSchema = {
  start: z.string().datetime().describe("Start datetime ISO 8601 (timezone-aware)."),
  end: z.string().datetime().describe("End datetime ISO 8601. Max 24h after start."),
  resolution: RESOLUTION.optional().describe("Default 5min. Use raw for unbucketed."),
};

export interface GetHeartRateSeriesInput {
  start: string;
  end: string;
  resolution?: HrResolution;
}

export interface HrPoint {
  timestamp: string;
  bpm: number;
  source: string;
}

export interface GetHeartRateSeriesResult {
  points: HrPoint[];
}

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

const BUCKET_MS: Record<HrResolution, number> = {
  raw: 0,
  "5min": 5 * 60 * 1000,
  "15min": 15 * 60 * 1000,
};

export function bucketHeartRate(samples: HeartRateSample[], bucketMs: number): HrPoint[] {
  if (bucketMs <= 0 || samples.length === 0) {
    return samples.map((s) => ({ timestamp: s.timestamp, bpm: s.bpm, source: s.source }));
  }
  const buckets = new Map<number, { sum: number[]; source: string }>();
  for (const s of samples) {
    const ms = new Date(s.timestamp).getTime();
    if (!Number.isFinite(ms)) continue;
    const bucketStart = Math.floor(ms / bucketMs) * bucketMs;
    const entry = buckets.get(bucketStart);
    if (entry) {
      entry.sum.push(s.bpm);
    } else {
      buckets.set(bucketStart, { sum: [s.bpm], source: s.source });
    }
  }
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  return sortedKeys.map((k) => {
    const b = buckets.get(k)!;
    const bpm = Math.round(mean(nonNull(b.sum)));
    return {
      timestamp: new Date(k).toISOString(),
      bpm,
      source: b.source,
    };
  });
}

export async function executeGetHeartRateSeries(
  client: OuraClient,
  input: GetHeartRateSeriesInput
): Promise<GetHeartRateSeriesResult> {
  const startMs = new Date(input.start).getTime();
  const endMs = new Date(input.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new OuraInvalidInput("start and end must be ISO-8601 datetimes.");
  }
  if (endMs < startMs) {
    throw new OuraInvalidInput("end must be on or after start.");
  }
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new OuraInvalidInput("Window too large. Max 24 hours.");
  }

  const samples = await client.collectAll<HeartRateSample>("/usercollection/heartrate", {
    start_datetime: input.start,
    end_datetime: input.end,
  });

  const resolution: HrResolution = input.resolution ?? "5min";
  const points = bucketHeartRate(samples, BUCKET_MS[resolution]);
  // round() is unused once we bucket, but we apply Math.round in bucketing.
  void round;
  return { points };
}
