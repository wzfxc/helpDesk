import { TZDate } from '@date-fns/tz';

/**
 * Business-hours arithmetic. Pure and deterministic: no access to the current time.
 * Days are resolved in the calendar's IANA time zone, so DST transitions are handled
 * by the tz database (09:00 Kyiv is 06:00Z in summer and 07:00Z in winter).
 */
export interface BusinessCalendar {
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday */
  workDays: readonly number[];
  /** Minutes after local midnight. */
  startMinute: number;
  endMinute: number;
}

export const KYIV_CALENDAR: BusinessCalendar = {
  timeZone: 'Europe/Kyiv',
  workDays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
};

/** Interval during which timers are stopped. `end: null` = still paused. */
export interface Pause {
  start: Date;
  end: Date | null;
}

const MINUTE = 60_000;
/** Hard stop for runaway loops (≈ 30 years of days). */
const MAX_DAYS = 11_000;

interface Window {
  start: number;
  end: number;
}

function localDayWindow(
  y: number,
  m: number,
  d: number,
  cal: BusinessCalendar,
): { window: Window | null; next: [number, number, number] } {
  const noon = new TZDate(y, m, d, 12, 0, 0, cal.timeZone);
  const next: [number, number, number] = [y, m, d + 1];
  if (!cal.workDays.includes(noon.getDay())) return { window: null, next };
  const start = new TZDate(
    y,
    m,
    d,
    Math.floor(cal.startMinute / 60),
    cal.startMinute % 60,
    0,
    cal.timeZone,
  );
  const end = new TZDate(
    y,
    m,
    d,
    Math.floor(cal.endMinute / 60),
    cal.endMinute % 60,
    0,
    cal.timeZone,
  );
  return { window: { start: start.getTime(), end: end.getTime() }, next };
}

/** Business windows (in epoch ms) starting from the local day containing `from`. */
function* businessWindows(from: number, cal: BusinessCalendar): Generator<Window> {
  const local = new TZDate(from, cal.timeZone);
  let ymd: [number, number, number] = [local.getFullYear(), local.getMonth(), local.getDate()];
  for (let i = 0; i < MAX_DAYS; i++) {
    const { window, next } = localDayWindow(ymd[0], ymd[1], ymd[2], cal);
    // Normalise overflowing day numbers (e.g. 32 Jan -> 1 Feb) via the tz-aware constructor.
    const n = new TZDate(next[0], next[1], next[2], 12, 0, 0, cal.timeZone);
    ymd = [n.getFullYear(), n.getMonth(), n.getDate()];
    if (window && window.end > from) yield { start: Math.max(window.start, from), end: window.end };
  }
  throw new Error('business calendar has no working time');
}

interface NormalizedPause {
  start: number;
  end: number;
}

function normalizePauses(pauses: readonly Pause[]): NormalizedPause[] {
  const sorted = pauses
    .map((p) => ({ start: p.start.getTime(), end: p.end ? p.end.getTime() : Infinity }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start);
  const merged: NormalizedPause[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push({ ...p });
  }
  return merged;
}

/** Splits a window into the parts not covered by pauses. */
function subtractPauses(w: Window, pauses: readonly NormalizedPause[]): Window[] {
  let parts: Window[] = [w];
  for (const p of pauses) {
    if (p.end <= w.start) continue;
    if (p.start >= w.end) break;
    parts = parts.flatMap((part) => {
      if (p.end <= part.start || p.start >= part.end) return [part];
      const out: Window[] = [];
      if (p.start > part.start) out.push({ start: part.start, end: p.start });
      if (p.end < part.end) out.push({ start: p.end, end: part.end });
      return out;
    });
  }
  return parts;
}

/**
 * Adds `minutes` of business time to `start`, skipping paused intervals.
 * Returns null when the deadline cannot be known because an open pause (end = null)
 * starts before the budget is used up.
 */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  pauses: readonly Pause[] = [],
  cal: BusinessCalendar = KYIV_CALENDAR,
): Date | null {
  if (minutes < 0) throw new RangeError('minutes must be >= 0');
  const norm = normalizePauses(pauses);
  let remaining = minutes * MINUTE;
  const from = start.getTime();
  if (remaining === 0) return new Date(from);

  for (const w of businessWindows(from, cal)) {
    const openPause = norm.find((p) => p.end === Infinity);
    if (openPause && openPause.start <= w.start) return null;
    for (const part of subtractPauses(w, norm)) {
      const len = part.end - part.start;
      if (remaining <= len) return new Date(part.start + remaining);
      remaining -= len;
    }
  }
  /* c8 ignore next */
  return null;
}

/** Business minutes in [from, to) excluding pauses (open pauses run until `to`). */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  pauses: readonly Pause[] = [],
  cal: BusinessCalendar = KYIV_CALENDAR,
): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  const norm = normalizePauses(pauses);
  let total = 0;
  for (const w of businessWindows(a, cal)) {
    if (w.start >= b) break;
    const clipped = { start: w.start, end: Math.min(w.end, b) };
    for (const part of subtractPauses(clipped, norm)) total += part.end - part.start;
    if (w.end >= b) break;
  }
  return total / MINUTE;
}
