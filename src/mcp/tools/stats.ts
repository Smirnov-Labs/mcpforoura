// src/mcp/tools/stats.ts

export function nonNull(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Returns the percentile (0-100) of `value` within `population`. Linear
 * interpolation between sorted samples; returns 0 if value < min, 100 if > max.
 */
export function percentileOf(value: number, population: number[]): number {
  if (population.length === 0) return Number.NaN;
  const sorted = [...population].sort((a, b) => a - b);
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 100;
  // Find rank.
  let below = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else break;
  }
  return +((below / sorted.length) * 100).toFixed(1);
}

export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
