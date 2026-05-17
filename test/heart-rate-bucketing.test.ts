// test/heart-rate-bucketing.test.ts
import { describe, expect, it } from "vitest";
import { bucketHeartRate } from "../src/mcp/tools/get-heart-rate-series";

describe("bucketHeartRate", () => {
  it("returns raw passthrough with bucketMs=0", () => {
    const samples = [
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:01:00Z", bpm: 62, source: "sleep" },
    ];
    expect(bucketHeartRate(samples, 0)).toEqual(samples);
  });

  it("groups samples within a 5-minute bucket and averages bpm", () => {
    const samples = [
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:02:00Z", bpm: 64, source: "sleep" },
      { timestamp: "2026-05-16T00:04:30Z", bpm: 62, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 5 * 60 * 1000);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe("2026-05-16T00:00:00.000Z");
    expect(out[0].bpm).toBe(62); // mean of 60,64,62
  });

  it("creates separate buckets across boundaries", () => {
    const samples = [
      { timestamp: "2026-05-16T00:01:00Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-05-16T00:06:00Z", bpm: 70, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 5 * 60 * 1000);
    expect(out).toHaveLength(2);
    expect(out[0].bpm).toBe(60);
    expect(out[1].bpm).toBe(70);
  });

  it("returns an empty array for empty input", () => {
    expect(bucketHeartRate([], 5 * 60 * 1000)).toEqual([]);
  });

  it("returns buckets sorted chronologically", () => {
    const samples = [
      { timestamp: "2026-05-16T01:00:00Z", bpm: 70, source: "sleep" },
      { timestamp: "2026-05-16T00:00:00Z", bpm: 60, source: "sleep" },
    ];
    const out = bucketHeartRate(samples, 60 * 60 * 1000);
    expect(out[0].timestamp).toBe("2026-05-16T00:00:00.000Z");
    expect(out[1].timestamp).toBe("2026-05-16T01:00:00.000Z");
  });
});
