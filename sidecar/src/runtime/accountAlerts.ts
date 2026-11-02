import type { JobStore } from '../state/jobStore.js';

/**
 * Telling the owner when the model account refuses runs.
 *
 * On 30 Oct 2026 the Claude subscription refused every run for about 16
 * minutes ("Claude Code can't use your Claude subscription, usually because a
 * payment is past due"). Each requester got a generic reply, and the owner,
 * the only one who could fix the account, heard nothing: one request sat
 * unanswered for three and a half days. Now the first refused run tells the
 * owner, once, with the CLI's own words. Later refusals are only counted.
 * When a run on the same backend works again, the owner is told that too,
 * with the threads whose requests were refused while it was down, so none of
 * them stays unanswered.
 */

/** A run the model account refused. */
export interface AccountRefusal {
  /** Backend id, e.g. `claude-code`: one outage per backend. */
  backend: string;
  /** The backend's name for people, e.g. "Claude Code (Anthropic)". */
  backendName: string;
  /** The CLI's own words for the refusal. */
  message: string;
  code?: string;
  jobId?: string;
}

/** An outage in progress, as stored between runs and restarts. */
export interface AccountOutage {
  since: string;
  backendName: string;
  message: string;
  /** Jobs refused during it, oldest first, without repeats. */
  jobIds: string[];
}

type StateStore = Pick<JobStore, 'getState' | 'setState'>;

/** More than this many jobs are counted, not listed. */
const MAX_LISTED_JOBS = 50;

const stateKey = (backend: string): string => `account_alert:${backend}`;

function readOutage(store: StateStore, backend: string): AccountOutage | undefined {
  const raw = store.getState(stateKey(backend));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountOutage>;
    if (typeof parsed.since !== 'string' || typeof parsed.message !== 'string') return undefined;
    return {
      since: parsed.since,
      backendName: typeof parsed.backendName === 'string' ? parsed.backendName : backend,
      message: parsed.message,
      jobIds: Array.isArray(parsed.jobIds) ? parsed.jobIds.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Record a refused run. `first` is true for the run that starts an outage:
 * the one the owner is told about. The rest are only added to the list.
 */
export function recordRefusal(
  refusal: AccountRefusal,
  store: StateStore,
  now: Date = new Date(),
): { first: boolean; outage: AccountOutage } {
  const existing = readOutage(store, refusal.backend);
  const outage: AccountOutage = existing ?? {
    since: now.toISOString(),
    backendName: refusal.backendName,
    message: refusal.message,
    jobIds: [],
  };
  if (refusal.jobId && !outage.jobIds.includes(refusal.jobId) && outage.jobIds.length < MAX_LISTED_JOBS) {
    outage.jobIds.push(refusal.jobId);
  }
  store.setState(stateKey(refusal.backend), JSON.stringify(outage));
  return { first: !existing, outage };
}

/** Record a run that worked. Returns the outage it ended, if one was in progress. */
export function recordWorking(backend: string, store: StateStore): AccountOutage | undefined {
  const outage = readOutage(store, backend);
  if (outage) store.setState(stateKey(backend), '');
  // A value that no longer parses is cleared too, so it cannot hold the alert back.
  else if (store.getState(stateKey(backend))) store.setState(stateKey(backend), '');
  return outage;
}

/** Slack's markup characters, escaped for message text. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What the owner is told when the account starts refusing runs. */
export function refusalAlertText(refusal: AccountRefusal, threadLink?: string): string {
  const where = threadLink
    ? `First refused: <${threadLink}|this thread>${refusal.jobId ? ` (job \`${refusal.jobId.slice(0, 8)}\`)` : ''}.`
    : refusal.jobId
      ? `First refused: job \`${refusal.jobId.slice(0, 8)}\`.`
      : undefined;
  return [
    `:warning: The model account (${refusal.backendName}) is refusing runs, so requests fail until it's fixed. The CLI says:`,
    ...escapeSlack(refusal.message)
      .split('\n')
      .map(line => `> ${line}`),
    ...(where ? [where] : []),
    "Each requester is told this reason in their thread. I'll tell you when a run works again.",
  ].join('\n');
}

/** "16 min", "2 h 5 min": how long the outage lasted. */
function formatOutage(sinceIso: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(sinceIso)) / 60_000));
  if (!Number.isFinite(minutes)) return 'a while';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * What the owner is told when a run works again: how long it was down, and
 * the threads whose requests it refused. `threadLinks` lines up with
 * `outage.jobIds`; a job whose link could not be found is named by its id.
 */
export function recoveredAlertText(
  outage: AccountOutage,
  threadLinks: Array<string | undefined>,
  now: Date = new Date(),
): string {
  const header = `:white_check_mark: The model account (${outage.backendName}) works again, after about ${formatOutage(outage.since, now)}.`;
  if (outage.jobIds.length === 0) return header;
  const count = outage.jobIds.length;
  // Two refused asks in one thread are one place to follow up.
  const places = [...new Set(outage.jobIds.map((id, index) => threadLinks[index] ?? `job:${id.slice(0, 8)}`))].map(
    (place, index) => (place.startsWith('job:') ? `\`${place.slice(4)}\`` : `<${place}|${index + 1}>`),
  );
  return [
    header,
    `${count === 1 ? 'One request was' : `${count}${count >= MAX_LISTED_JOBS ? '+' : ''} requests were`} refused while it was down: ${places.join(', ')}.`,
    'Nothing re-runs by itself: mention miniOG in those threads to run them again.',
  ].join('\n');
}

type Listener = {
  refused(refusal: AccountRefusal): void;
  working(backend: string): void;
};

let listener: Listener | undefined;

/** Where runs report refusals and successes. Set once at startup. */
export function onAccountEvents(fn: Listener | undefined): void {
  listener = fn;
}

/** Called by a run the model account refused. Never throws into the run. */
export function reportAccountRefused(refusal: AccountRefusal): void {
  try {
    listener?.refused(refusal);
  } catch {
    // Telling the owner must not affect the run.
  }
}

/** Called by a run that worked. Never throws into the run. */
export function reportAccountWorking(backend: string): void {
  try {
    listener?.working(backend);
  } catch {
    // Telling the owner must not affect the run.
  }
}
