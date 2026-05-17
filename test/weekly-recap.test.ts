import { describe, expect, it } from "vitest";
import { executeGetWeeklyRecap } from "../src/mcp/tools/get-weekly-recap";
import type { OuraClient } from "../src/oura/client";

function stubClient(responses: Record<string, unknown[]>): OuraClient {
  return {
    async collectAll(path: string) {
      return responses[path] ?? [];
    },
  } as unknown as OuraClient;
}

describe("executeGetWeeklyRecap", () => {
  it("returns a 7-day window with daily ordered chronologically", async () => {
    const days: Array<{ day: string; score: number | null }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date("2026-05-10T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      days.push({ day: d.toISOString().slice(0, 10), score: 80 + i });
    }
    const client = stubClient({
      "/usercollection/daily_sleep": days,
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });

    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16" });
    expect(out.window).toEqual({ start: "2026-05-10", end: "2026-05-16", days: 7 });
    expect(out.daily).toHaveLength(7);
    expect(out.daily[0].date).toBe("2026-05-10");
    expect(out.daily[6].date).toBe("2026-05-16");
    expect(out.daily[0].sleep_score).toBe(80);
    expect(out.daily[6].sleep_score).toBe(86);
    expect(out.stats.sleep_score?.mean).toBe(83);
    expect(out.stats.sleep_score?.min).toBe(80);
    expect(out.stats.sleep_score?.max).toBe(86);
  });

  it("omits stats for metrics with no non-null values", async () => {
    const client = stubClient({
      "/usercollection/daily_sleep": [{ day: "2026-05-16", score: 86 }],
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });
    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16", days: 1 });
    expect(out.stats.sleep_score).toBeDefined();
    expect(out.stats.readiness_score).toBeUndefined();
  });

  it("respects custom days parameter", async () => {
    const client = stubClient({
      "/usercollection/daily_sleep": [],
      "/usercollection/daily_readiness": [],
      "/usercollection/daily_activity": [],
      "/usercollection/daily_stress": [],
      "/usercollection/sleep": [],
    });
    const out = await executeGetWeeklyRecap(client, { end_date: "2026-05-16", days: 14 });
    expect(out.window.days).toBe(14);
    expect(out.window.start).toBe("2026-05-03");
    expect(out.daily).toHaveLength(14);
  });
});
