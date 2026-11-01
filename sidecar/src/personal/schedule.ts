/**
 * When My day's nightly run is due, and what window it covers. Times are the
 * Mac's local time: the run belongs to the owner's day.
 */

const OVERLAP_MS = 30 * 60 * 1000;
const MAX_WINDOW_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A full run is expensive, and one a few hours ago already covered the day. */
const MIN_HOURS_BETWEEN_RUNS_MS = 12 * 60 * 60 * 1000;

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
 * a run the Mac slept through as soon as it wakes. Turning the run on, or moving
 * its time, doesn't fire one for a time that had already passed: `enabledAt` sets
 * that baseline. Moving tonight's time later can't start a second full run either.
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
  const last = lastStartedAt ? Date.parse(lastStartedAt) : Number.NaN;
  if (!Number.isNaN(last) && (last >= passed || now.getTime() - last < MIN_HOURS_BETWEEN_RUNS_MS)) return false;
  const baseline = enabledAt ? Date.parse(enabledAt) : Number.NaN;
  return Number.isNaN(baseline) || baseline < passed;
}

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** A span's start, if it's one: `3d`, or a date that exists and isn't in the future. */
function spanStart(span: string | undefined, now: Date): Date | undefined {
  if (!span) return undefined;
  const days = /^(\d{1,2})d$/.exec(span);
  if (days) return new Date(startOfDay(now).getTime() - Number(days[1]) * DAY_MS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(span)) return undefined;
  const date = new Date(`${span}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime() ? date : undefined;
}

/**
 * A run covers what came in since the last complete run ended, with an overlap
 * for what arrived while that run was collecting. Runs that failed or missed a
 * source don't move it, so the next one covers those nights. Past a week, or with
 * no run yet, it covers the last day. `span` can only widen it: a narrower one
 * would skip days, because the next run starts from this one.
 */
export function runWindow(params: { now: Date; lastWindowEnd: string | undefined; span: string | undefined }): {
  start: Date;
  end: Date;
} {
  const { now, lastWindowEnd, span } = params;
  const last = lastWindowEnd ? Date.parse(lastWindowEnd) : Number.NaN;
  const age = now.getTime() - last;
  const usable = !Number.isNaN(last) && age > 0 && age <= MAX_WINDOW_AGE_MS;
  const usual = usable ? last - OVERLAP_MS : now.getTime() - DAY_MS;
  const widened = spanStart(span, now)?.getTime();
  return { start: new Date(widened === undefined ? usual : Math.min(widened, usual)), end: now };
}
