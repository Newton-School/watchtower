import type { WebClient } from '@slack/web-api';
import { fetchThreadContext } from '../../slack/threadContext.js';
import type { WorkflowStepLogger } from '../../types/contracts.js';

export type ClarificationOutcome =
  | { outcome: 'answered'; answer: string; answererId: string }
  | { outcome: 'timeout' }
  | { outcome: 'cancelled' }
  | { outcome: 'paused'; userReply: string; pauserId: string };

export const DEFAULT_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_NUDGE_AFTER_MS = 30 * 60 * 1000;

const CANCEL_WORDS = new Set(['cancel', 'stop', 'abort', 'nevermind', 'never mind', 'skip']);

// Mirrors PAUSE_PATTERNS in pipeline.ts. Anyone in the thread can park miniOG
// during a clarification wait by saying "wait", "hold on", "pause", etc.
const PAUSE_PATTERNS =
  /^(wait|hold on|hold up|pause|brb|one sec|one moment|stand by|i'?ll get back to you|(give me|gimme) (a )?(sec|second|minute|moment|min)|pause for (now|a bit|a sec)|stop for now)[.! ]*$/i;

export function isPauseReply(text: string): boolean {
  const cleaned = stripSlackNoise(text);
  if (!cleaned) return false;
  return PAUSE_PATTERNS.test(cleaned);
}

function stripSlackNoise(text: string): string {
  // Slack apps can append footers like "*Sent using* <@U...>" when a message
  // is forwarded through another agent. Trim that before intent matching.
  return text
    .replace(/\*sent using\*.*$/is, '')
    .replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCancelReply(text: string): boolean {
  const cleaned = stripSlackNoise(text).toLowerCase();
  if (!cleaned) return false;
  const firstToken = cleaned.split(/\s+/)[0].replace(/[^a-z ]+$/g, '');
  return CANCEL_WORDS.has(firstToken) || CANCEL_WORDS.has(cleaned);
}

export async function waitForClarificationWithIdle(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  allowedUserIds: string[];
  promptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
  idleTimeoutMs?: number;
  nudgeAfterMs?: number;
  nudgeText?: string;
  signal?: AbortSignal;
}): Promise<ClarificationOutcome> {
  const {
    slack,
    channelId,
    threadTs,
    allowedUserIds,
    promptTs,
    logStep,
    botUserId,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    nudgeAfterMs = DEFAULT_NUDGE_AFTER_MS,
    nudgeText,
    signal,
  } = params;

  // The caller posts the question before calling, and posting clears Slack's
  // thread status — this is what puts "is waiting for your answer" back up.
  logStep({
    stage: 'pipeline.clarification.waiting',
    message: 'Waiting for an answer to the clarification.',
  });

  const pollIntervalMs = 5_000;
  const startedAt = Date.now();
  let nudged = false;

  while (true) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= idleTimeoutMs) {
      logStep({
        stage: 'pipeline.clarification.timeout',
        message: `No answer within ${Math.round(idleTimeoutMs / 60_000)} min — pausing.`,
        level: 'WARN',
      });
      return { outcome: 'timeout' };
    }

    if (!nudged && elapsed >= nudgeAfterMs && nudgeText) {
      try {
        await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: nudgeText });
      } catch {
        // best-effort nudge
      }
      nudged = true;
    }

    await sleep(pollIntervalMs, signal);

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      continue;
    }

    const candidates = messages.filter(m => m.ts > promptTs && m.user !== botUserId);
    for (const reply of candidates) {
      const answer = reply.text.trim();
      if (!answer) continue;

      // Pause is allowed from anyone in the thread, not just allowedUserIds.
      // The clarification gate is "waiting on a human"; any human can say wait.
      if (isPauseReply(answer)) {
        logStep({
          stage: 'pipeline.clarification.paused',
          message: `<@${reply.user}> asked miniOG to wait: "${answer}"`,
        });
        return { outcome: 'paused', userReply: answer, pauserId: reply.user };
      }

      if (!allowedUserIds.includes(reply.user)) continue;

      if (isCancelReply(answer)) {
        logStep({
          stage: 'pipeline.clarification.cancelled',
          message: `<@${reply.user}> cancelled: "${answer}"`,
        });
        return { outcome: 'cancelled' };
      }

      logStep({
        stage: 'pipeline.clarification.answered',
        message: `<@${reply.user}> answered: "${answer}"`,
      });
      return { outcome: 'answered', answer, answererId: reply.user };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

export type ClarificationRound = { question: string; answer: string };

export type LoopDetection = { looping: false } | { looping: true; reason: string };

const UNHELPFUL_ANSWER_RE =
  /^(idk|no idea|i don'?t know|just do it|whatever|you decide|anything|dunno|up to you|nothing specific|figure it out|you figure it out)$/i;

function normalizeForComparison(text: string): string {
  return stripSlackNoise(text).toLowerCase();
}

function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function detectClarificationLoop(history: ClarificationRound[], currentQuestion: string): LoopDetection {
  if (history.length === 0) return { looping: false };

  const normalizedCurrent = normalizeForComparison(currentQuestion);

  for (const prior of history) {
    const sim = jaccardSimilarity(normalizedCurrent, normalizeForComparison(prior.question));
    if (sim >= 0.85) {
      return {
        looping: true,
        reason: `Same question asked before (trigram similarity ${sim.toFixed(2)}).`,
      };
    }
  }

  const recentAnswers = history.slice(-2).map(r => stripSlackNoise(r.answer).trim());
  if (recentAnswers.length >= 2 && recentAnswers.every(ans => ans.length < 10 || UNHELPFUL_ANSWER_RE.test(ans))) {
    return {
      looping: true,
      reason: 'Last two answers were too short or deflective to drive planning.',
    };
  }

  return { looping: false };
}
