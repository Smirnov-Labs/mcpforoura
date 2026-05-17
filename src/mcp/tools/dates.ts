// Small date helpers used across tools. All dates are YYYY-MM-DD in UTC.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return DATE_RE.test(value);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveDate(value: string): string {
  if (!isIsoDate(value)) {
    throw new Error(`Invalid date: ${value}. Expected strict YYYY-MM-DD.`);
  }
  return value;
}

export function daysBetween(start: string, end: string): number {
  const a = Date.UTC(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10))
  );
  const b = Date.UTC(
    Number(end.slice(0, 4)),
    Number(end.slice(5, 7)) - 1,
    Number(end.slice(8, 10))
  );
  return Math.round((b - a) / 86_400_000);
}
