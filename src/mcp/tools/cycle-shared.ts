import type { OuraClient } from "../../oura/client.js";
import type { CycleInsight, CyclePhaseInfo } from "../../oura/types.js";
import { daysBetween, shiftDate } from "./dates.js";

const CYCLE_PATH = "/usercollection/cycle_insights";

export interface CycleFetchResult {
  available: boolean;
  cycles: CycleInsight[];
  reason?: string;
}

export async function fetchCycleHistory(
  client: OuraClient,
  end: string,
  lookbackDays = 365
): Promise<CycleFetchResult> {
  const start = shiftDate(end, -(lookbackDays - 1));
  const res = await client.requestSafe<{ data: CycleInsight[]; next_token?: string | null }>(
    CYCLE_PATH,
    { start_date: start, end_date: end }
  );
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      return {
        available: false,
        cycles: [],
        reason: `Oura cycle endpoint returned ${res.status}. Either cycle-tracking scope is not enabled on the connector app, the endpoint path has changed, or this account does not have cycle insights. Have the operator check the Oura developer app's scope list.`,
      };
    }
    throw new Error(`Oura cycle endpoint failed (${res.status}): ${res.body}`);
  }
  return { available: true, cycles: res.data.data };
}

export function cyclePhaseForDate(
  cycles: CycleInsight[],
  date: string
): {
  phase: CyclePhaseInfo["phase"];
  day_of_cycle: number | null;
  cycle_start_date: string | null;
  predicted_next_phase: CyclePhaseInfo["phase"] | null;
  predicted_next_phase_start_date: string | null;
} {
  for (const cycle of cycles) {
    const cycleStart = cycle.start_day;
    const cycleEnd = cycle.end_day ?? shiftDate(cycleStart, 60); // generous fallback
    if (date < cycleStart || date > cycleEnd) continue;

    const phases = cycle.phases ?? [];
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const pStart = p.start_day;
      const pEnd = p.end_day ?? phases[i + 1]?.start_day ?? cycleEnd;
      if (date >= pStart && date <= pEnd) {
        const next = phases[i + 1];
        return {
          phase: p.phase,
          day_of_cycle: daysBetween(cycleStart, date) + 1,
          cycle_start_date: cycleStart,
          predicted_next_phase: next ? next.phase : null,
          predicted_next_phase_start_date: next ? next.start_day : null,
        };
      }
    }

    return {
      phase: "unknown",
      day_of_cycle: daysBetween(cycleStart, date) + 1,
      cycle_start_date: cycleStart,
      predicted_next_phase: null,
      predicted_next_phase_start_date: null,
    };
  }
  return {
    phase: "unknown",
    day_of_cycle: null,
    cycle_start_date: null,
    predicted_next_phase: null,
    predicted_next_phase_start_date: null,
  };
}
