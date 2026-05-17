import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthProps } from "../auth/types.js";
import { OuraClient } from "../oura/client.js";
import { dailySummarySchema, executeDailySummary } from "./tools/daily-summary.js";
import { dateRangeSchema, executeDateRange } from "./tools/date-range.js";
import { executeLastNightSleep, lastNightSleepSchema } from "./tools/last-night-sleep.js";
import { compareToBaselineSchema, executeCompareToBaseline } from "./tools/compare-to-baseline.js";
import { getHeartRateSeriesSchema, executeGetHeartRateSeries } from "./tools/get-heart-rate-series.js";
import { getSessionsSchema, executeGetSessions } from "./tools/get-sessions.js";
import { getTagsSchema, executeGetTags } from "./tools/get-tags.js";
import { getWorkoutsSchema, executeGetWorkouts } from "./tools/get-workouts.js";
import { getStressSchema, executeGetStress } from "./tools/get-stress.js";
import { getSpo2Schema, executeGetSpo2 } from "./tools/get-spo2.js";
import { getResilienceSchema, executeGetResilience } from "./tools/get-resilience.js";
import { getCardioAgeSchema, executeGetCardioAge } from "./tools/get-cardio-age.js";
import { getVo2MaxSchema, executeGetVo2Max } from "./tools/get-vo2-max.js";
import { getRecommendedSleepTimeSchema, executeGetRecommendedSleepTime } from "./tools/get-recommended-sleep-time.js";
import { getRestModePeriodsSchema, executeGetRestModePeriods } from "./tools/get-rest-mode-periods.js";

interface ToolError {
  code?: string;
  message: string;
}

function errorContent(error: unknown) {
  const err: ToolError =
    error instanceof Error
      ? { code: (error as { code?: string }).code, message: error.message }
      : { message: String(error) };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(err) }],
  };
}

function jsonContent(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

type ToolHandler<T> = (client: OuraClient, input: T) => Promise<unknown>;

function clientTool<T>(env: Env, props: AuthProps, handler: ToolHandler<T>) {
  return async (input: T) => {
    const client = new OuraClient(env, props.ouraUserId);
    try {
      const result = await handler(client, input);
      return jsonContent(result);
    } catch (error) {
      return errorContent(error);
    }
  };
}

export function registerOuraTools(server: McpServer, env: Env, props: AuthProps) {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Returns {ok: true, user_id}. Used to verify auth + connectivity. Does not call Oura.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => jsonContent({ ok: true, user_id: props.ouraUserId })
  );

  server.registerTool(
    "_internal_personal_info",
    {
      title: "Internal: Personal Info",
      description:
        "Internal diagnostic — calls Oura /personal_info to verify the token is live and the API is reachable. Not for end-user use.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const client = new OuraClient(env, props.ouraUserId);
      try {
        const info = await client.personalInfo();
        return jsonContent({ ok: true, personal_info: info });
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "get_daily_summary",
    {
      title: "Daily Summary",
      description:
        "Get a single-day summary of Oura Ring data (sleep, readiness, activity). Use this when the user asks 'how was my [day]' or wants a snapshot of one specific date. For ranges, use get_date_range instead.",
      inputSchema: dailySummarySchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeDailySummary)
  );

  server.registerTool(
    "get_date_range",
    {
      title: "Date Range",
      description:
        "Get a single metric over a date range for trend analysis. Use this when the user asks about trends over multiple days like 'how was my sleep this week' or 'show me my HRV over the past month'. For a single-day snapshot, use get_daily_summary.",
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeDateRange)
  );

  server.registerTool(
    "get_last_night_sleep",
    {
      title: "Last Night Sleep",
      description:
        "Get detailed sleep data for the most recent night. Use this when the user asks 'how did I sleep last night' or wants the latest sleep details. Returns scores, stage breakdown, timing, and heart-rate metrics.",
      inputSchema: lastNightSleepSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeLastNightSleep)
  );

  server.registerTool(
    "get_workouts",
    {
      title: "Workouts",
      description:
        "List workouts logged or auto-detected over a date range. Use for exercise/training questions or to correlate workouts with recovery. Pass user's LOCAL dates as strict YYYY-MM-DD.",
      inputSchema: getWorkoutsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetWorkouts)
  );

  server.registerTool(
    "get_sessions",
    {
      title: "Mindfulness Sessions",
      description:
        "List mindfulness sessions (meditation, breathing, relaxation) over a date range. Pass user's LOCAL dates as strict YYYY-MM-DD.",
      inputSchema: getSessionsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetSessions)
  );

  server.registerTool(
    "get_tags",
    {
      title: "Enhanced Tags",
      description:
        "List user-annotated tags (caffeine, alcohol, late meal, custom notes) over a date range. Use to correlate behaviors with sleep/readiness or to recall what was logged. Pass user's LOCAL dates as strict YYYY-MM-DD.",
      inputSchema: getTagsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetTags)
  );

  server.registerTool(
    "get_heart_rate_series",
    {
      title: "Heart Rate Series",
      description:
        "Get intraday heart-rate time series within a 24-hour window, bucketed to 5min/15min/raw. Use for HR patterns within a day (sleep, workout, stress events). For multi-day trends, use get_date_range with metric=resting_hr instead.",
      inputSchema: getHeartRateSeriesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetHeartRateSeries)
  );

  server.registerTool(
    "compare_to_baseline",
    {
      title: "Compare to Baseline",
      description:
        "Compare a single day's metric to the user's personal 30-day and 90-day rolling baselines. Use when the user asks 'is this normal for me?' or 'how does today compare to my usual?'. Returns value alongside personal context so answers can be 'good for you' rather than absolute.",
      inputSchema: compareToBaselineSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeCompareToBaseline)
  );

  server.registerTool(
    "get_stress",
    {
      title: "Daily Stress",
      description:
        "Get daily stress metrics (high-stress and recovery seconds) for a date. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getStressSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetStress)
  );

  server.registerTool(
    "get_spo2",
    {
      title: "Daily SpO2",
      description:
        "Get nightly blood-oxygen (SpO2) average and breathing disturbance index for a date. Useful for altitude effects, suspected sleep apnea, or illness tracking. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getSpo2Schema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetSpo2)
  );

  server.registerTool(
    "get_resilience",
    {
      title: "Daily Resilience",
      description:
        "Get the resilience score for a date — Oura's long-term stress recovery capacity metric. Levels: limited / adequate / solid / strong / exceptional. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getResilienceSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetResilience)
  );

  server.registerTool(
    "get_cardio_age",
    {
      title: "Cardiovascular Age",
      description:
        "Get Oura's cardiovascular-age estimate for a date — a heart-health proxy derived from HRV, resting HR, and other signals. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getCardioAgeSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetCardioAge)
  );

  server.registerTool(
    "get_vo2_max",
    {
      title: "VO2 Max",
      description:
        "Get the most recent VO2 max measurement within 30 days of the queried date. Oura computes VO2 max from outdoor walks/runs, so measurements may be sparse. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getVo2MaxSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetVo2Max)
  );

  server.registerTool(
    "get_recommended_sleep_time",
    {
      title: "Recommended Sleep Time",
      description:
        "Get Oura's recommended bedtime window for a date as start/end HH:MM in user's local time, with a status and recommendation field. Pass user's LOCAL date as strict YYYY-MM-DD.",
      inputSchema: getRecommendedSleepTimeSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetRecommendedSleepTime)
  );

  server.registerTool(
    "get_rest_mode_periods",
    {
      title: "Rest Mode Periods",
      description:
        "List rest-mode periods (illness/recovery markers) over a date range. Pass user's LOCAL dates as strict YYYY-MM-DD; max 365-day range.",
      inputSchema: getRestModePeriodsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    clientTool(env, props, executeGetRestModePeriods)
  );
}
