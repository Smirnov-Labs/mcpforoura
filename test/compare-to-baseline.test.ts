// test/compare-to-baseline.test.ts
import { describe, expect, it } from "vitest";
import { executeCompareToBaseline } from "../src/mcp/tools/compare-to-baseline";
import type { OuraClient } from "../src/oura/client";

function dailyReadinessStub(docs: Array<{ day: string; score: number | null; hrv: number | null }>) {
  return {
    async collectAll(path: string) {
      if (path !== "/usercollection/daily_readiness") return [];
      return docs.map((d) => ({
        id: d.day,
        day: d.day,
        score: d.score,
        contributors: { hrv_balance: d.hrv, resting_heart_rate: 50 },
      }));
    },
  } as unknown as OuraClient;
}

describe("executeCompareToBaseline", () => {
  it("returns insufficient_baseline when fewer than 14 non-null days", async () => {
    const docs = [];
    for (let i = 0; i < 90; i++) {
      docs.push({
        day: `2026-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 30) + 1).padStart(2, "0")}`,
        score: i < 5 ? 80 : null,
        hrv: null,
      });
    }
    const client = dailyReadinessStub(docs);
    const out = await executeCompareToBaseline(client, {
      metric: "readiness_score",
      date: "2026-03-30",
    });
    expect(out.insufficient_baseline).toBe(true);
    expect(out.days_with_data).toBeLessThan(14);
  });

  it("computes p30/p90 stats with sufficient data", async () => {
    const docs = [];
    // 90 days ending 2026-05-16. All days have score=85, except the target day=90.
    const end = new Date("2026-05-16T00:00:00Z");
    for (let i = 89; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(end.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      docs.push({ day, score: day === "2026-05-16" ? 90 : 85, hrv: null });
    }
    const client = dailyReadinessStub(docs);
    const out = await executeCompareToBaseline(client, {
      metric: "readiness_score",
      date: "2026-05-16",
    });
    expect(out.value).toBe(90);
    expect(out.p90_mean).toBe(85);
    expect(out.p30_mean).toBe(85);
    expect(out.delta_from_p30_pct).toBeCloseTo(5.9, 1);
    expect(out.percentile_in_p90).toBe(100); // 90 > all baseline values
    expect(out.insufficient_baseline).toBeUndefined();
  });

  it("rejects invalid date", async () => {
    const client = dailyReadinessStub([]);
    await expect(
      executeCompareToBaseline(client, { metric: "readiness_score", date: "bogus" })
    ).rejects.toThrow();
  });
});
