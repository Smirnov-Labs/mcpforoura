// Response shapes from Oura API v2 /usercollection/* endpoints.
// Only the fields we surface are typed; everything else is allowed via index signatures.

export interface DailySleep {
  id: string;
  day: string;
  score: number | null;
  contributors?: {
    deep_sleep?: number | null;
    efficiency?: number | null;
    latency?: number | null;
    rem_sleep?: number | null;
    restfulness?: number | null;
    timing?: number | null;
    total_sleep?: number | null;
  };
  [key: string]: unknown;
}

export interface DailyReadiness {
  id: string;
  day: string;
  score: number | null;
  temperature_deviation?: number | null;
  contributors?: {
    activity_balance?: number | null;
    body_temperature?: number | null;
    hrv_balance?: number | null;
    previous_day_activity?: number | null;
    previous_night?: number | null;
    recovery_index?: number | null;
    resting_heart_rate?: number | null;
    sleep_balance?: number | null;
  };
  [key: string]: unknown;
}

export interface DailyActivity {
  id: string;
  day: string;
  score: number | null;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  low_activity_time?: number | null;
  [key: string]: unknown;
}

export interface SleepPeriod {
  id: string;
  day: string;
  type: string;
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_duration: number | null;
  deep_sleep_duration: number | null;
  rem_sleep_duration: number | null;
  light_sleep_duration: number | null;
  awake_time: number | null;
  efficiency: number | null;
  average_heart_rate: number | null;
  lowest_heart_rate: number | null;
  average_hrv: number | null;
  readiness?: { score?: number | null } | null;
  sleep_score_delta?: number | null;
  [key: string]: unknown;
}

export interface Workout {
  id: string;
  day: string;
  activity: string;
  start_datetime: string;
  end_datetime: string;
  calories: number | null;
  intensity: string;
  distance: number | null;
  source: string;
  [key: string]: unknown;
}

export interface OuraSession {
  id: string;
  day: string;
  type: string;
  start_datetime: string;
  end_datetime: string;
  mood?: string | null;
  mood_before?: string | null;
  mood_after?: string | null;
  [key: string]: unknown;
}

export interface HeartRateSample {
  timestamp: string;
  bpm: number;
  source: string;
}

export interface EnhancedTag {
  id: string;
  tag_type_code: string;
  start_day?: string | null;
  end_day?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  custom_name?: string | null;
  comment?: string | null;
  [key: string]: unknown;
}
