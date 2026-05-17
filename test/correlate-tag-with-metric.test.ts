import { describe, expect, it } from "vitest";
import { executeCorrelateTagWithMetric } from "../src/mcp/tools/correlate-tag-with-metric";
import type { OuraClient } from "../src/oura/client";

function stub(metricDocs: Array<{ day: string; score: number | null }>, tags: Array<{ start_day: string; tag_type_code: string }>): OuraClient {
  return {
    async collectAll(path: string) {
      if (path === "/usercollection/daily_sleep") {
        return metricDocs.map((d) => ({ id: d.day, day: d.day, score: d.score }));
      }
      if (path === "/usercollection/enhanced_tag") {
        return tags;
      }
      return [];
    },
  } as unknown as OuraClient;
}

describe("executeCorrelateTagWithMetric", () => {
  it("splits tagged vs untagged days and computes stats", async () => {
    const metricDocs = [];
    const tags = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date("2026-04-17T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      const isTagged = i % 3 === 0;
      metricDocs.push({ day, score: isTagged ? 70 : 85 });
      if (isTagged) tags.push({ start_day: day, tag_type_code: "alcohol" });
    }
    const client = stub(metricDocs, tags);
    const out = await executeCorrelateTagWithMetric(client, {
      metric: "sleep_score",
      tag_type_code: "alcohol",
      end_date: "2026-05-16",
      lookback_days: 30,
    });
    expect(out.tagged.n).toBe(10);
    expect(out.tagged.mean).toBe(70);
    expect(out.untagged.n).toBe(20);
    expect(out.untagged.mean).toBe(85);
    expect(out.mean_delta_pct).toBeCloseTo(-17.6, 1);
    expect(out.small_sample_warning).toBe(false);
  });

  it("flags small_sample_warning with <5 in either group", async () => {
    const metricDocs = [];
    const tags = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      const isTagged = i < 3;
      metricDocs.push({ day, score: isTagged ? 60 : 85 });
      if (isTagged) tags.push({ start_day: day, tag_type_code: "alcohol" });
    }
    const client = stub(metricDocs, tags);
    const out = await executeCorrelateTagWithMetric(client, {
      metric: "sleep_score",
      tag_type_code: "alcohol",
      end_date: "2026-05-16",
      lookback_days: 20,
    });
    expect(out.tagged.n).toBe(3);
    expect(out.small_sample_warning).toBe(true);
  });

  it("rejects when both tag_type_code and custom_name are provided", async () => {
    await expect(
      executeCorrelateTagWithMetric(stub([], []), {
        metric: "sleep_score",
        tag_type_code: "alcohol",
        custom_name: "wine",
      })
    ).rejects.toThrow();
  });

  it("rejects when neither tag_type_code nor custom_name is provided", async () => {
    await expect(
      executeCorrelateTagWithMetric(stub([], []), {
        metric: "sleep_score",
      })
    ).rejects.toThrow();
  });
});
