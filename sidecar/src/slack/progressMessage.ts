import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * One Slack message per run that says where the run is, edited in place
 * (issue #600). Change runs used to post a new line for every stage: seven to
 * eleven messages, some contradicting each other, in channels people read.
 * Now the first stage posts the message and every later stage edits it. New
 * messages are left to what a person must act on and to the result.
 *
 * The line reads: `<what is happening> · step 2/3 · 7 min`. Elapsed time is
 * refreshed once a minute while a stage is running so a long silent agent run
 * does not look stuck.
 */

/** How often the elapsed time on the message is refreshed. */
const TICK_MS = 60_000;

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
  /** Final text; stops the elapsed-time refresh. Never throws. */
  finish(text: string): Promise<void>;
  /** Release the timer. Safe to call twice. */
  dispose(): void;
  /** The message's ts once posted, for tests and for threading a reply to it. */
  readonly ts: string | undefined;
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
  /** Posted first, on its own, before any stage edits it: "Plan approved — …". */
  intro?: string;
  logStep?: WorkflowStepLogger;
}): ProgressMessage {
  const { slack, channelId, threadTs, logStep } = params;
  const startedAt = params.startedAt ?? Date.now();
  let ts: string | undefined;
  let current: ProgressStage | undefined;
  let finished = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Serialises posts and edits so an edit never overtakes the post it edits. */
  let chain: Promise<void> = Promise.resolve();
  let pendingIntro = params.intro;

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function startTimer(): void {
    if (timer || disposed || finished) return;
    timer = setInterval(() => {
      if (!current || finished || disposed) return;
      void write(formatProgressLine(current, Date.now() - startedAt));
    }, TICK_MS);
    timer.unref?.();
  }

  async function write(text: string): Promise<void> {
    if (disposed) return;
    try {
      if (!ts) {
        const result = await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
        ts = result.ts ?? undefined;
      } else {
        await slack.chat.update({ channel: channelId, ts, text });
      }
    } catch (error) {
      // Progress is decoration: it never fails the run.
      logStep?.({
        level: 'WARN',
        stage: 'slack.progress.failed',
        message: 'Could not update the progress message.',
        data: { error: String(error) },
      });
    }
  }

  function enqueue(text: string): Promise<void> {
    chain = chain.then(() => write(text));
    return chain;
  }

  return {
    get ts() {
      return ts;
    },
    async set(stage) {
      if (finished || disposed) return;
      current = stage;
      if (pendingIntro) {
        const intro = pendingIntro;
        pendingIntro = undefined;
        await enqueue(intro);
      }
      startTimer();
      await enqueue(formatProgressLine(stage, Date.now() - startedAt));
    },
    async finish(text) {
      if (finished || disposed) return;
      finished = true;
      stopTimer();
      current = undefined;
      await enqueue(text);
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
