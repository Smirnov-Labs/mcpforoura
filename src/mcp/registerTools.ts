import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthProps } from "../auth/types.js";
import { OuraClient } from "../oura/client.js";
import { dailySummarySchema, executeDailySummary } from "./tools/daily-summary.js";
import { dateRangeSchema, executeDateRange } from "./tools/date-range.js";
import { executeLastNightSleep, lastNightSleepSchema } from "./tools/last-night-sleep.js";

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
}
