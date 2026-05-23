import { describe, expect, it } from "vitest";
import { executeGetMorningBriefing } from "../src/mcp/tools/get-morning-briefing";
import type { OuraClient } from "../src/oura/client";

interface Call {
  path: string;
  query?: Record<string, string>;
}

function stubClient(responses: Record<string, unknown[]>): { client: OuraClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async requestList(path: string, query?: Record<string, string>) {
      calls.push({ path, query });
      return { data: responses[path] ?? [], next_token: null };
    },
  } as unknown as OuraClient;
  return { client, calls };
}

describe("executeGetMorningBriefing", () => {
  it("places last night's sleep under today (Oura dates sleep to day-of-wake-up)", async () => {
    // Oura's Sleep Day runs 6pm→6pm and is stamped with the day the user woke up on.
    // So sleep that ended on the morning of 2026-05-23 has day="2026-05-23".
    // A morning briefing called on 2026-05-23 should surface THAT document.
    const { client, calls } = stubClient({
      "/usercollection/daily_readiness": [
        { id: "r1", day: "2026-05-23", score: 88, temperature_deviation: -0.06, contributors: { hrv_balance: 76 } },
      ],
      "/usercollection/sleep_time": [
        { id: "st1", day: "2026-05-23", optimal_bedtime: { start_offset: 79200, end_offset: 82800 }, status: "good", recommendation: "good_to_go" },
      ],
      "/usercollection/daily_sleep": [
        { id: "s_today", day: "2026-05-23", score: 91, contributors: { deep_sleep: 98, rem_sleep: 92, total_sleep: 100, restfulness: 74, timing: 80 } },
      ],
      "/usercollection/daily_activity": [
        { id: "a1", day: "2026-05-22", score: 84, steps: 12000, active_calories: 600 },
      ],
      "/usercollection/daily_stress": [
        { id: "ds1", day: "2026-05-22", stress_high: 2700, recovery_high: 2700, day_summary: "normal" },
      ],
      "/usercollection/enhanced_tag": [
        { id: "t1", tag_type_code: "alcohol", start_day: "2026-05-22", custom_name: null, comment: "one beer" },
      ],
    });

    const out = await executeGetMorningBriefing(client, { date: "2026-05-23" });

    expect(out.today.date).toBe("2026-05-23");
    expect(out.today.readiness?.score).toBe(88);
    expect(out.today.sleep?.score).toBe(91);
    expect(out.today.recommended_sleep_time?.optimal_bedtime_start_offset_min).toBe(1320);

    expect(out.yesterday.date).toBe("2026-05-22");
    expect(out.yesterday.activity?.score).toBe(84);
    expect(out.yesterday.stress?.day_summary).toBe("normal");
    expect(out.yesterday.tags).toHaveLength(1);
    expect(out.yesterday.tags[0].tag_type_code).toBe("alcohol");

    // Sleep must be queried for TODAY, not yesterday. Querying yesterday
    // would return the sleep dated yesterday — which is the night BEFORE
    // last night, not the sleep the user just woke up from.
    const sleepCall = calls.find((c) => c.path === "/usercollection/daily_sleep");
    expect(sleepCall?.query?.start_date).toBe("2026-05-23");
    expect(sleepCall?.query?.end_date).toBe("2026-05-23");

    // Activity/stress/tags are calendar-day metrics; querying yesterday is correct.
    const activityCall = calls.find((c) => c.path === "/usercollection/daily_activity");
    expect(activityCall?.query?.start_date).toBe("2026-05-22");
    const stressCall = calls.find((c) => c.path === "/usercollection/daily_stress");
    expect(stressCall?.query?.start_date).toBe("2026-05-22");
    const tagsCall = calls.find((c) => c.path === "/usercollection/enhanced_tag");
    expect(tagsCall?.query?.start_date).toBe("2026-05-22");
  });

  it("ignores a sleep doc dated yesterday (it would be the night before last)", async () => {
    // Defensive: if Oura returns a stray sleep doc dated 2026-05-22 in the
    // today-query (it shouldn't, but cache or pagination could), we must not
    // surface it as last night's sleep.
    const { client } = stubClient({
      "/usercollection/daily_sleep": [
        { id: "stale", day: "2026-05-22", score: 40, contributors: { deep_sleep: 10 } },
      ],
    });

    const out = await executeGetMorningBriefing(client, { date: "2026-05-23" });

    expect(out.today.sleep).toBeNull();
  });

  it("returns nulls when an endpoint has no data", async () => {
    const { client } = stubClient({});
    const out = await executeGetMorningBriefing(client, { date: "2026-05-23" });
    expect(out.today.readiness).toBeNull();
    expect(out.today.sleep).toBeNull();
    expect(out.today.recommended_sleep_time).toBeNull();
    expect(out.yesterday.activity).toBeNull();
    expect(out.yesterday.stress).toBeNull();
    expect(out.yesterday.tags).toEqual([]);
  });
});
