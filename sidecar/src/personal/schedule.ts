/**
 * When My day's nightly run is due, and what window it covers. Times are the
 * Mac's local time: the run belongs to the owner's day.
 */

const OVERLAP_MS = 30 * 60 * 1000;
const MAX_WINDOW_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RUN_TIME = '22:00';

/** `HH:MM`, or the default for anything else. */
export function parseRunTime(value: string | undefined): { hours: number; minutes: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '');
  const [hours, minutes] = match ? [Number(match[1]), Number(match[2])] : [22, 0];
  return { hours, minutes };
}

/** The latest moment at or before `now` that the run time passed. */
export function latestRunTime(now: Date, runTime: string | undefined): Date {
  const { hours, minutes } = parseRunTime(runTime);
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  if (today.getTime() <= now.getTime()) return today;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return yesterday;
}

/**
 * Due when the run time has passed since the last run started. That also fires
 * a run the Mac slept through as soon as it wakes. Turning the run on doesn't
 * fire one for a time that had already passed: `enabledAt` sets the baseline.
 */
export function isRunDue(params: {
  now: Date;
  enabled: boolean;
  runTime: string | undefined;
  enabledAt: string | undefined;
  lastStartedAt: string | undefined;
}): boolean {
  const { now, enabled, runTime, enabledAt, lastStartedAt } = params;
  if (!enabled) return false;
  const passed = latestRunTime(now, runTime).getTime();
  const baselines = [enabledAt, lastStartedAt].map(value => (value ? Date.parse(value) : Number.NaN));
  return baselines.every(baseline => Number.isNaN(baseline) || baseline < passed);
}

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * A run covers what came in since the last finished run ended, with an overlap
 * for what arrived while that run was collecting. Failed runs don't move it, so
 * a night that failed is covered by the next one. Past a week, or with no run
 * yet, it covers today. `span` widens it: `3d`, or a date.
 */
export function runWindow(params: { now: Date; lastWindowEnd: string | undefined; span: string | undefined }): {
  start: Date;
  end: Date;
} {
  const { now, lastWindowEnd, span } = params;
  const days = span ? /^(\d{1,2})d$/.exec(span) : null;
  if (days) return { start: new Date(startOfDay(now).getTime() - Number(days[1]) * DAY_MS), end: now };
  if (span && /^\d{4}-\d{2}-\d{2}$/.test(span)) {
    const date = new Date(`${span}T00:00:00`);
    if (!Number.isNaN(date.getTime()) && date.getTime() <= now.getTime()) return { start: date, end: now };
  }
  const last = lastWindowEnd ? Date.parse(lastWindowEnd) : Number.NaN;
  const age = now.getTime() - last;
  if (!Number.isNaN(last) && age > 0 && age <= MAX_WINDOW_AGE_MS) {
    return { start: new Date(last - OVERLAP_MS), end: now };
  }
  return { start: startOfDay(now), end: now };
}
