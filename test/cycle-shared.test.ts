import { describe, expect, it } from "vitest";
import { cyclePhaseForDate } from "../src/mcp/tools/cycle-shared";
import type { CycleInsight } from "../src/oura/types";

const cycle: CycleInsight = {
  id: "c1",
  start_day: "2026-04-15",
  end_day: "2026-05-12",
  length_days: 28,
  predicted_length_days: 28,
  phases: [
    { phase: "menstrual", start_day: "2026-04-15", end_day: "2026-04-19" },
    { phase: "follicular", start_day: "2026-04-20", end_day: "2026-04-28" },
    { phase: "ovulatory", start_day: "2026-04-29", end_day: "2026-05-01" },
    { phase: "luteal", start_day: "2026-05-02", end_day: "2026-05-12" },
  ],
};

describe("cyclePhaseForDate", () => {
  it("returns menstrual for a day in the menstrual phase", () => {
    const out = cyclePhaseForDate([cycle], "2026-04-17");
    expect(out.phase).toBe("menstrual");
    expect(out.day_of_cycle).toBe(3);
    expect(out.cycle_start_date).toBe("2026-04-15");
    expect(out.predicted_next_phase).toBe("follicular");
  });

  it("returns ovulatory for a day in that phase", () => {
    const out = cyclePhaseForDate([cycle], "2026-04-30");
    expect(out.phase).toBe("ovulatory");
    expect(out.day_of_cycle).toBe(16);
    expect(out.predicted_next_phase).toBe("luteal");
  });

  it("returns luteal for the last day of the cycle", () => {
    const out = cyclePhaseForDate([cycle], "2026-05-12");
    expect(out.phase).toBe("luteal");
    expect(out.predicted_next_phase).toBeNull();
  });

  it("returns unknown when date is outside all cycles", () => {
    const out = cyclePhaseForDate([cycle], "2026-06-01");
    expect(out.phase).toBe("unknown");
    expect(out.day_of_cycle).toBeNull();
    expect(out.cycle_start_date).toBeNull();
  });

  it("returns unknown when cycles array is empty", () => {
    const out = cyclePhaseForDate([], "2026-04-17");
    expect(out.phase).toBe("unknown");
  });
});
