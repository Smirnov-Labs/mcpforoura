import { z } from "zod";
import type { OuraClient } from "../../oura/client.js";
import type {
  DailyActivity,
  DailyReadiness,
  DailySleep,
  DailyStress,
  EnhancedTag,
  RecommendedSleepTime,
} from "../../oura/types.js";
import { OuraReauthRequired, OuraAccountUnavailable } from "../../errors.js";
import { resolveDate, shiftDate } from "./dates.js";

export const getMorningBriefingSchema = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Today's date YYYY-MM-DD, user's LOCAL date."),
};

export interface GetMorningBriefingInput {
  date: string;
}

interface ReadinessOut {
  score: number | null;
  temperature_deviation: number | null;
  contributors: DailyReadiness["contributors"] | null;
}

interface RecommendedSleepTimeOut {
  optimal_bedtime_start_offset_min: number | null;
  optimal_bedtime_end_offset_min: number | null;
  status: string | null;
  recommendation: string | null;
}

interface SleepOut {
  score: number | null;
  contributors: DailySleep["contributors"] | null;
}

interface ActivityOut {
  score: number | null;
  steps: number | null;
  active_calories: number | null;
}

interface StressOut {
  stress_high_seconds: number | null;
  recovery_high_seconds: number | null;
  day_summary: string | null;
}

interface TagOut {
  tag_type_code: string;
  custom_name: string | null;
  comment: string | null;
}

export interface GetMorningBriefingResult {
  today: {
    date: string;
    readiness: ReadinessOut | null;
    recommended_sleep_time: RecommendedSleepTimeOut | null;
  };
  yesterday: {
    date: string;
    sleep: SleepOut | null;
    activity: ActivityOut | null;
    stress: StressOut | null;
    tags: TagOut[];
  };
}

async function safeRequestList<T>(
  client: OuraClient,
  path: string,
  query: Record<string, string>
): Promise<T[]> {
  try {
    const res = await client.requestList<T>(path, query);
    return res.data;
  } catch (err) {
    if (err instanceof OuraReauthRequired || err instanceof OuraAccountUnavailable) {
      throw err;
    }
    return [];
  }
}

function pickByDay<T extends { day: string }>(docs: T[], day: string): T | undefined {
  return docs.find((d) => d.day === day) ?? docs[0];
}

export async function executeGetMorningBriefing(
  client: OuraClient,
  input: GetMorningBriefingInput
): Promise<GetMorningBriefingResult> {
  const today = resolveDate(input.date);
  const yesterday = shiftDate(today, -1);

  const [readinessDocs, sleepTimeDocs, sleepDocs, activityDocs, stressDocs, tagDocs] =
    await Promise.all([
      safeRequestList<DailyReadiness>(client, "/usercollection/daily_readiness", {
        start_date: today,
        end_date: today,
      }),
      safeRequestList<RecommendedSleepTime>(client, "/usercollection/sleep_time", {
        start_date: today,
        end_date: today,
      }),
      safeRequestList<DailySleep>(client, "/usercollection/daily_sleep", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<DailyActivity>(client, "/usercollection/daily_activity", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<DailyStress>(client, "/usercollection/daily_stress", {
        start_date: yesterday,
        end_date: yesterday,
      }),
      safeRequestList<EnhancedTag>(client, "/usercollection/enhanced_tag", {
        start_date: yesterday,
        end_date: yesterday,
      }),
    ]);

  const readiness = pickByDay(readinessDocs, today);
  const sleepTimeDoc = pickByDay(sleepTimeDocs, today);
  const sleep = pickByDay(sleepDocs, yesterday);
  const activity = pickByDay(activityDocs, yesterday);
  const stress = pickByDay(stressDocs, yesterday);

  return {
    today: {
      date: today,
      readiness: readiness
        ? {
            score: readiness.score ?? null,
            temperature_deviation: readiness.temperature_deviation ?? null,
            contributors: readiness.contributors ?? null,
          }
        : null,
      recommended_sleep_time: sleepTimeDoc
        ? {
            optimal_bedtime_start_offset_min:
              sleepTimeDoc.optimal_bedtime?.start_offset != null
                ? Math.round(sleepTimeDoc.optimal_bedtime.start_offset / 60)
                : null,
            optimal_bedtime_end_offset_min:
              sleepTimeDoc.optimal_bedtime?.end_offset != null
                ? Math.round(sleepTimeDoc.optimal_bedtime.end_offset / 60)
                : null,
            status: sleepTimeDoc.status ?? null,
            recommendation: sleepTimeDoc.recommendation ?? null,
          }
        : null,
    },
    yesterday: {
      date: yesterday,
      sleep: sleep
        ? {
            score: sleep.score ?? null,
            contributors: sleep.contributors ?? null,
          }
        : null,
      activity: activity
        ? {
            score: activity.score ?? null,
            steps: activity.steps ?? null,
            active_calories: activity.active_calories ?? null,
          }
        : null,
      stress: stress
        ? {
            stress_high_seconds: stress.stress_high ?? null,
            recovery_high_seconds: stress.recovery_high ?? null,
            day_summary: stress.day_summary ?? null,
          }
        : null,
      tags: tagDocs.map((t) => ({
        tag_type_code: t.tag_type_code,
        custom_name: t.custom_name ?? null,
        comment: t.comment ?? null,
      })),
    },
  };
}
