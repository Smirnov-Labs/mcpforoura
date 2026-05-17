import { describe, expect, it } from "vitest";
import { executeFindAnomalies } from "../src/mcp/tools/find-anomalies";
import type { OuraClient } from "../src/oura/client";

function stub(docs: Array<{ day: string; score: number | null }>): OuraClient {
  return {
    async collectAll(path: string) {
      if (path !== "/usercollection/daily_readiness") return [];
      return docs.map((d) => ({
        id: d.day,
        day: d.day,
        score: d.score,
        contributors: { hrv_balance: null, resting_heart_rate: null },
      }));
    },
  } as unknown as OuraClient;
}

describe("executeFindAnomalies", () => {
  it("flags days outside threshold sigma", async () => {
    const docs = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date("2026-04-17T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      docs.push({ day, score: day === "2026-05-10" ? 30 : 85 });
    }
    const client = stub(docs);
    const out = await executeFindAnomalies(client, {
      metric: "readiness_score",
      end_date: "2026-05-16",
      lookback_days: 30,
      threshold_sigma: 2,
    });
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0].date).toBe("2026-05-10");
    expect(out.anomalies[0].direction).toBe("low");
    expect(out.anomalies[0].value).toBe(30);
  });

  it("returns insufficient_baseline with <14 non-null days", async () => {
    const docs = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date("2026-05-01T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      docs.push({ day: d.toISOString().slice(0, 10), score: 80 });
    }
    const client = stub(docs);
    const out = await executeFindAnomalies(client, {
      metric: "readiness_score",
      end_date: "2026-05-16",
      lookback_days: 90,
    });
    expect(out.insufficient_baseline).toBe(true);
    expect(out.days_with_data).toBe(10);
    expect(out.anomalies).toEqual([]);
  });

  it("rejects invalid end_date", async () => {
    await expect(
      executeFindAnomalies(stub([]), {
        metric: "readiness_score",
        end_date: "bogus",
      })
    ).rejects.toThrow();
  });
});
