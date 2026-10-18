import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { FATAL_SLACK_ERRORS, slackErrorCode } from './threadStatus.js';

/**
 * One Slack message per run that says where the run is, edited in place
 * (issue #600). Change runs used to post a new line for every stage: seven to
 * eleven messages, some contradicting each other, in channels people read.
 * Now the first stage posts the message and every later stage edits it. New
 * messages are left to what a person must act on and to the result.
 *
 * The message keeps its opening line ("Plan approved — I'll code it up…") and
 * the second line is the stage: `writing the code · step 2/3 · 7 min`. The
 * elapsed time is refreshed once a minute while a stage is running so a long
 * silent agent run does not look stuck.
 *
 * Progress is decoration: nothing here throws. A Slack error that cannot
 * succeed on retry (the message was deleted, the bot lost the channel), or
 * three failures in a row, turns the message off for the rest of the run with
 * one WARN row. The message is posted at most once: a post whose answer was
 * lost must not become a second message.
 */

/** How often the elapsed time on the message is refreshed. */
const TICK_MS = 60_000;

/** Consecutive transport failures tolerated before the message is given up. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ProgressStage {
  /** What is happening now, as a short clause: "writing the code". */
  text: string;
  /** Position in the run, shown as `step 1/3`. */
  step?: number;
  total?: number;
  /** A revision round, shown as `round 2/3`. */
  round?: number;
  rounds?: number;
}

export interface ProgressMessage {
  /** Show a stage. Posts the message the first time, edits it afterwards. Never throws. */
  set(stage: ProgressStage): Promise<void>;
  /**
   * Show a line and stop refreshing the elapsed time: for a human wait, where
   * a counter would say the run is working while it waits. The next `set()`
   * resumes the refresh.
   */
  hold(text: string): Promise<void>;
  /** Final text; stops the elapsed-time refresh. A second call does nothing. Never throws. */
  finish(text: string): Promise<void>;
  /** Release the timer. Safe to call twice. */
  dispose(): void;
  /** The message's ts once posted, for tests and for threading a reply to it. */
  readonly ts: string | undefined;
  /** Whether `finish` has run. */
  readonly finished: boolean;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatProgressLine(stage: ProgressStage, elapsedMs: number): string {
  const parts = [stage.text];
  if (stage.step && stage.total) parts.push(`step ${stage.step}/${stage.total}`);
  if (stage.round && stage.rounds) parts.push(`round ${stage.round}/${stage.rounds}`);
  parts.push(formatElapsed(elapsedMs));
  return parts.join(' · ');
}

export function createProgressMessage(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  /** When the run started; elapsed time counts from here. Defaults to now. */
  startedAt?: number;
  /** The message's first line, kept through every edit: "Plan approved — …". */
  header?: string;
  logStep?: WorkflowStepLogger;
}): ProgressMessage {
  const { slack, channelId, threadTs, logStep } = params;
  const startedAt = params.startedAt ?? Date.now();
  const header = params.header?.trim() || undefined;
  let ts: string | undefined;
  let posted = false;
  let current: ProgressStage | undefined;
  let finished = false;
  let disposed = false;
  let disabled = false;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Serialises posts, edits and ticks so an edit never overtakes the post it edits. */
  let chain: Promise<void> = Promise.resolve();

  function compose(line: string): string {
    return header ? `${header}\n${line}` : line;
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function startTimer(): void {
    if (timer || disposed || finished || disabled) return;
    timer = setInterval(() => {
      if (!current || finished || disposed || disabled) return;
      const stage = current;
      enqueue(() => compose(formatProgressLine(stage, Date.now() - startedAt)));
    }, TICK_MS);
    timer.unref?.();
  }

  function disable(reason: string, detail: string): void {
    if (disabled) return;
    disabled = true;
    stopTimer();
    logStep?.({
      level: 'WARN',
      stage: 'slack.progress.disabled',
      message: `Progress message turned off for this run (${reason}).`,
      data: { reason, detail },
    });
  }

  async function write(text: string): Promise<void> {
    if (disposed || disabled) return;
    try {
      if (!posted) {
        posted = true;
        const result = await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
        ts = result.ts ?? undefined;
        if (!ts) {
          // Slack took it but told us nothing we can edit: never post again.
          disable('no message id returned', 'chat.postMessage returned no ts');
        }
      } else if (ts) {
        await slack.chat.update({ channel: channelId, ts, text });
      }
      consecutiveFailures = 0;
    } catch (error) {
      const code = slackErrorCode(error);
      if (!posted || !ts || FATAL_SLACK_ERRORS.has(code) || code === 'message_not_found') {
        disable(code, String(error));
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        disable('repeated transport failures', String(error));
      }
    }
  }

  /** The text is built when its turn comes, so a tick never shows a stale clock. */
  function enqueue(text: () => string): Promise<void> {
    chain = chain.then(() => write(text()));
    return chain;
  }

  return {
    get ts() {
      return ts;
    },
    get finished() {
      return finished;
    },
    async set(stage) {
      if (finished || disposed || disabled) return;
      current = stage;
      startTimer();
      await enqueue(() => compose(formatProgressLine(stage, Date.now() - startedAt)));
    },
    async hold(text) {
      if (finished || disposed || disabled) return;
      current = undefined;
      stopTimer();
      await enqueue(() => compose(text));
    },
    async finish(text) {
      if (finished || disposed || disabled) return;
      finished = true;
      stopTimer();
      current = undefined;
      await enqueue(() => compose(text));
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
