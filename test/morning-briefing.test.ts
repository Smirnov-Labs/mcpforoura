import { describe, expect, it } from "vitest";
import { executeGetMorningBriefing } from "../src/mcp/tools/get-morning-briefing";
import type { OuraClient } from "../src/oura/client";

function stubClient(responses: Record<string, unknown[]>): OuraClient {
  return {
    async requestList(path: string) {
      return { data: responses[path] ?? [], next_token: null };
    },
  } as unknown as OuraClient;
}

describe("executeGetMorningBriefing", () => {
  it("fans out and returns shaped today + yesterday", async () => {
    const client = stubClient({
      "/usercollection/daily_readiness": [
        { id: "r1", day: "2026-05-16", score: 85, temperature_deviation: 0.2, contributors: { hrv_balance: 70 } },
      ],
      "/usercollection/sleep_time": [
        { id: "st1", day: "2026-05-16", optimal_bedtime: { start_offset: 79200, end_offset: 82800 }, status: "good", recommendation: "good_to_go" },
      ],
      "/usercollection/daily_sleep": [
        { id: "s1", day: "2026-05-15", score: 86, contributors: { deep_sleep: 90 } },
      ],
      "/usercollection/daily_activity": [
        { id: "a1", day: "2026-05-15", score: 89, steps: 12000, active_calories: 600 },
      ],
      "/usercollection/daily_stress": [
        { id: "st1", day: "2026-05-15", stress_high: 4200, recovery_high: 10800, day_summary: "normal" },
      ],
      "/usercollection/enhanced_tag": [
        { id: "t1", tag_type_code: "alcohol", start_day: "2026-05-15", custom_name: null, comment: "one beer" },
      ],
    });

    const out = await executeGetMorningBriefing(client, { date: "2026-05-16" });

    expect(out.today.date).toBe("2026-05-16");
    expect(out.today.readiness?.score).toBe(85);
    expect(out.today.recommended_sleep_time?.optimal_bedtime_start_offset_min).toBe(1320); // 79200/60
    expect(out.yesterday.date).toBe("2026-05-15");
    expect(out.yesterday.sleep?.score).toBe(86);
    expect(out.yesterday.activity?.steps).toBe(12000);
    expect(out.yesterday.stress?.day_summary).toBe("normal");
    expect(out.yesterday.tags).toHaveLength(1);
    expect(out.yesterday.tags[0].tag_type_code).toBe("alcohol");
  });

  it("returns nulls when an endpoint has no data", async () => {
    const client = stubClient({});
    const out = await executeGetMorningBriefing(client, { date: "2026-05-16" });
    expect(out.today.readiness).toBeNull();
    expect(out.today.recommended_sleep_time).toBeNull();
    expect(out.yesterday.sleep).toBeNull();
    expect(out.yesterday.activity).toBeNull();
    expect(out.yesterday.stress).toBeNull();
    expect(out.yesterday.tags).toEqual([]);
  });
});
