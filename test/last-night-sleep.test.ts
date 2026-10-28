// test/last-night-sleep.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeLastNightSleep } from "../src/mcp/tools/last-night-sleep";
import type { OuraClient } from "../src/oura/client";

// Serves docs whose day falls inside the requested range, end day included:
// the contract OuraClient gives tools.
function stubClient(docsByPath: Record<string, Array<{ day: string }>>) {
  return {
    async collectAll(path: string, query: Record<string, string>) {
      return (docsByPath[path] ?? []).filter(
        (doc) => doc.day >= query.start_date && doc.day <= query.end_date
      );
    },
  } as unknown as OuraClient;
}

function night(day: string, bedtimeEnd: string, totalSleepSeconds: number) {
  return { day, type: "long_sleep", bedtime_end: bedtimeEnd, total_sleep_duration: totalSleepSeconds };
}

describe("executeLastNightSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds last night for a user ahead of UTC, whose morning is still yesterday in UTC", async () => {
    // 07:00 on 2026-10-28 in Tokyo (UTC+9) is 22:00 on 2026-10-27 in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T22:00:00Z"));
    const client = stubClient({
      "/usercollection/sleep": [
        night("2026-10-27", "2026-10-27T06:40:00+09:00", 25200),
        night("2026-10-28", "2026-10-28T06:50:00+09:00", 23256),
      ],
      "/usercollection/daily_sleep": [
        { day: "2026-10-27", score: 80 },
        { day: "2026-10-28", score: 74 },
      ] as Array<{ day: string }>,
    });

    const result = await executeLastNightSleep(client);

    expect(result.date).toBe("2026-10-28");
    expect(result.total_sleep_hours).toBe(6.46);
    expect(result.score).toBe(74);
  });
});
