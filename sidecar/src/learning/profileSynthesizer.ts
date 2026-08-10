import os from 'node:os';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { getActiveBackendId, runCodex } from '../codex/runCodex.js';
import { logger } from '../logging/logger.js';
import { extractReplyFromCodexResult } from '../workflows/shared/workflowUtils.js';
import { productDisplayName } from '../router/productClassifier.js';
import type { JobStore } from '../state/jobStore.js';
import type { PinnedFactRow, UserDossier, UserMemoryRow } from '../state/dossierStore.js';

/** Minimum total memories required to bother generating a profile. */
export const MIN_MEMORIES_FOR_SYNTHESIS = 3;
/** Skip synthesis if last run was within this many ms (idempotency). */
export const SYNTHESIS_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Hard cap on the synthesized prose to keep prompts tight. */
export const SYNTHESIS_MAX_CHARS = 800;

export interface InferredProfileMetric {
  text: string;
  samplesCovered: number;
  generatedAt: string;
}

export type SynthesisOutcome =
  | { ok: true; text: string; samplesCovered: number; generatedAt: string }
  | { ok: false; reason: 'too-few-memories' | 'too-recent' | 'llm-failed' | 'empty-output' | 'no-user-id' };

interface ResolveStoreArg {
  store: JobStore;
}

/**
 * Read the cached inferred profile blob from user_metrics, if present.
 * Returns null when the user has never been synthesized.
 */
export function readInferredProfile(opts: ResolveStoreArg & { userId: string }): InferredProfileMetric | null {
  const dossier = opts.store.dossierStore().getDossier(opts.userId);
  const raw = dossier.metrics['inferred_profile'];
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<InferredProfileMetric>;
  if (typeof v.text !== 'string' || !v.text || typeof v.generatedAt !== 'string') return null;
  return {
    text: v.text,
    samplesCovered: typeof v.samplesCovered === 'number' ? v.samplesCovered : 0,
    generatedAt: v.generatedAt,
  };
}

/**
 * Build the LLM prompt. Strictly constrained: ≤120 words of prose, no
 * bullets, no headings — the renderer wraps it in a `## About` section.
 * Inputs are dossier metrics + recent gists + pinned facts; we deliberately
 * do NOT pass raw `event.text` (privacy invariant from Phase A).
 */
function buildSynthesizerPrompt(input: {
  dossier: UserDossier;
  memories: ReadonlyArray<UserMemoryRow>;
  pinnedFacts: ReadonlyArray<PinnedFactRow>;
}): string {
  const { dossier, memories, pinnedFacts } = input;
  const profile = dossier.profile;
  const name = profile?.displayName ?? profile?.realName ?? profile?.userId ?? 'this user';
  const role = profile?.role ?? 'unspecified';

  const lines: string[] = [];
  lines.push(
    'You are summarizing what a developer assistant called miniOG knows about one Slack user. Output prose only — no bullets, no headings, no Markdown formatting. Keep it under 120 words. Weave numbers in naturally; do not list them. Reference repos, products, and recurring patterns from the inputs. Never address the user as "you" — write in third person about them.',
  );
  lines.push('');
  lines.push(`User: ${name}`);
  lines.push(`Self-declared role: ${role}`);

  if (dossier.affinity.length > 0) {
    const top = dossier.affinity.slice(0, 3).map(r => {
      const rate = r.hits > 0 ? Math.round((100 * r.successes) / r.hits) : 0;
      return `${r.repo} (${r.hits} jobs, ${rate}% success)`;
    });
    lines.push(`Repo activity: ${top.join('; ')}`);
  }

  if (dossier.productAffinity.length > 0) {
    const top = dossier.productAffinity.slice(0, 3).map(p => {
      const rate = p.hits > 0 ? Math.round((100 * p.successes) / p.hits) : 0;
      return `${productDisplayName(p.product)} (${p.hits} jobs, ${rate}% success)`;
    });
    lines.push(`Product activity within newton-web: ${top.join('; ')}`);
  }

  const intentMix = dossier.metrics['intent_mix'] as Record<string, number> | undefined;
  if (intentMix) {
    const top = Object.entries(intentMix)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v})`);
    if (top.length > 0) lines.push(`Typical workflows: ${top.join(', ')}`);
  }

  const fp = dossier.metrics['failure_fingerprint'] as
    | { failureRate7d?: number; samples?: number; topErrorKinds?: Array<{ kind: string; count: number }> }
    | undefined;
  if (fp && (fp.samples ?? 0) > 0) {
    const pct = Math.round((fp.failureRate7d ?? 0) * 100);
    const kinds = (fp.topErrorKinds ?? [])
      .slice(0, 2)
      .map(e => e.kind)
      .join(', ');
    lines.push(`Recent failure rate: ${pct}% over ${fp.samples} jobs${kinds ? `; common kinds: ${kinds}` : ''}`);
  }

  if (pinnedFacts.length > 0) {
    lines.push('Things the user explicitly asked to remember:');
    for (const fact of pinnedFacts.slice(0, 10)) {
      lines.push(`- ${fact.text}`);
    }
  }

  if (memories.length > 0) {
    lines.push('');
    lines.push('Recent interactions (latest first):');
    for (const m of memories.slice(0, 12)) {
      const date = (m.createdAt ?? '').slice(0, 10);
      const wf = m.workflow ?? 'WORK';
      const status = m.status ?? '?';
      const repoBit = m.repo ? ` ${m.repo}` : '';
      const productBit = m.product ? ` (${productDisplayName(m.product)})` : '';
      lines.push(`- [${date}] ${wf} ${status}${repoBit}${productBit} — ${m.summary}`);
    }
  }

  lines.push('');
  lines.push('Write the summary now. Prose only, under 120 words.');
  return lines.join('\n');
}

/**
 * Synthesize an inferred-profile prose summary for a single user. Returns
 * an outcome describing whether the synthesis ran. Cost guardrails:
 *   - Skipped when fewer than MIN_MEMORIES_FOR_SYNTHESIS memories.
 *   - Skipped when last synthesis was within SYNTHESIS_MIN_INTERVAL_MS.
 *   - One LLM call per invocation. Token usage is logged via runCodex.
 */
export async function synthesizeUserProfile(opts: {
  userId: string;
  store: JobStore;
  /** Override `Date.now()` for tests. */
  now?: Date;
  /** Force-run, bypassing the recency guard. Used by manual regenerate. */
  force?: boolean;
}): Promise<SynthesisOutcome> {
  const { userId, store, force = false } = opts;
  if (!userId) return { ok: false, reason: 'no-user-id' };
  const now = opts.now ?? new Date();

  const dossier = store.dossierStore().getDossier(userId);
  const memories = store.dossierStore().recentMemoriesForUser(userId, 30);
  const pinnedFacts = store.dossierStore().listPinnedFacts(userId);

  if (memories.length < MIN_MEMORIES_FOR_SYNTHESIS) {
    return { ok: false, reason: 'too-few-memories' };
  }

  const existing = readInferredProfile({ store, userId });
  if (!force && existing) {
    const lastMs = new Date(existing.generatedAt).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < SYNTHESIS_MIN_INTERVAL_MS) {
      return { ok: false, reason: 'too-recent' };
    }
  }

  const prompt = buildSynthesizerPrompt({ dossier, memories, pinnedFacts });
  const profile = lightweightProfile(getActiveBackendId());

  const result = await runCodex({
    cwd: os.tmpdir(),
    prompt,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs: 90_000,
  }).catch(err => {
    logger.warn({ err: String(err), userId }, 'profile synthesizer: runCodex threw');
    return null;
  });

  if (!result || !result.ok) {
    return { ok: false, reason: 'llm-failed' };
  }
  // On claude-code, result.lastMessage is the raw {"type":"result",...} JSONL
  // envelope (retained for parseOutput) — persisting it verbatim injected
  // truncated JSON into every dossier-carrying prompt's About line. Unwrap via
  // the shared helper (parsedJson.summary -> parsedJson.result -> envelope).
  if (result.parsedJson?.status === 'error') {
    return { ok: false, reason: 'llm-failed' };
  }
  const text = extractReplyFromCodexResult(result).trim().slice(0, SYNTHESIS_MAX_CHARS);
  if (!text) return { ok: false, reason: 'empty-output' };

  const generatedAt = now.toISOString();
  const blob: InferredProfileMetric = { text, samplesCovered: memories.length, generatedAt };
  // Persist via direct SQL — user_metrics is an internal store table, but
  // the dossierStore's rollup machinery already writes there with the same
  // shape. We use a small upsert helper exposed for this purpose.
  upsertInferredProfile({ store, userId, blob });
  store.dossierStore().invalidate(userId);

  logger.info(
    { userId, samplesCovered: memories.length, chars: text.length },
    'profile synthesizer: wrote inferred_profile',
  );

  return { ok: true, text, samplesCovered: memories.length, generatedAt };
}

/**
 * Internal helper to upsert the inferred_profile metric row. Bypasses the
 * dossierStore rollup, which would otherwise wait for new learning_signals
 * to fire. This is the synthesizer's only direct DB write.
 */
function upsertInferredProfile(opts: { store: JobStore; userId: string; blob: InferredProfileMetric }): void {
  // user_metrics primary key is (user_id, metric_key); upsert via raw SQL.
  // Read-only access on JobStore is fine; we use the .db handle for the
  // single-statement INSERT OR REPLACE here. Importing the table writer
  // through dossierStore would force a public API for one caller.
  const db = (opts.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
    .db;
  db.prepare(
    `INSERT INTO user_metrics(user_id, metric_key, metric_value, computed_at)
     VALUES(?, 'inferred_profile', ?, ?)
     ON CONFLICT(user_id, metric_key) DO UPDATE SET
       metric_value = excluded.metric_value,
       computed_at = excluded.computed_at`,
  ).run(opts.userId, JSON.stringify(opts.blob), opts.blob.generatedAt);
}

// ─────────────────────────────────────────────────────────────────────────
// Nightly scheduler
// ─────────────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 60_000;
const SCHEDULER_CONCURRENCY = 2;
/** IST = UTC+5:30 — fixed because the org is single-tz today. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface SchedulerRuntime {
  store: JobStore;
  timer: NodeJS.Timeout;
  lastRunDayKeyIST: string | null;
  running: boolean;
}

let scheduler: SchedulerRuntime | null = null;

/** UTC ISO string of IST midnight on the given UTC date's IST day. */
function istDayKey(now: Date): string {
  // Convert UTC instant to IST clock by adding IST_OFFSET_MS, then take YYYY-MM-DD.
  const istTime = new Date(now.getTime() + IST_OFFSET_MS);
  return istTime.toISOString().slice(0, 10);
}

async function runSchedulerTick(rt: SchedulerRuntime, now: Date): Promise<void> {
  const todayKey = istDayKey(now);
  if (rt.lastRunDayKeyIST === todayKey) return;
  if (rt.running) return;

  // Only fire after midnight IST has crossed: we require the previous
  // day's key to differ from today's. First tick after sidecar boot will
  // run synthesis for any user with activity since "yesterday IST".
  rt.running = true;
  try {
    const since = rt.lastRunDayKeyIST
      ? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); // first run: catch up over last week
    const db = (rt.store as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } })
      .db;
    const rows = db
      .prepare(
        `SELECT DISTINCT user_id AS userId
         FROM user_memories
         WHERE created_at >= ?
           AND user_id IS NOT NULL AND user_id != ''`,
      )
      .all(since) as Array<{ userId: string }>;

    if (rows.length === 0) {
      logger.debug({ todayKey, since }, 'profile synthesizer scheduler: no active users this period');
      rt.lastRunDayKeyIST = todayKey;
      return;
    }

    logger.info(
      { todayKey, since, userCount: rows.length },
      'profile synthesizer scheduler: starting nightly synthesis batch',
    );

    // Concurrency-2 worker pool.
    const queue = [...rows];
    const workers = Array.from({ length: SCHEDULER_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        try {
          const out = await synthesizeUserProfile({ userId: next.userId, store: rt.store, now });
          logger.info({ userId: next.userId, outcome: out.ok ? 'ok' : out.reason }, 'profile synthesizer: outcome');
        } catch (err) {
          logger.warn({ err: String(err), userId: next.userId }, 'profile synthesizer: synth threw');
        }
      }
    });
    await Promise.all(workers);

    rt.lastRunDayKeyIST = todayKey;
  } finally {
    rt.running = false;
  }
}

export function startProfileSynthesizerScheduler(store: JobStore): void {
  if (scheduler) return;
  const rt: SchedulerRuntime = {
    store,
    timer: setInterval(() => {
      const now = new Date();
      void runSchedulerTick(rt, now).catch(err =>
        logger.warn({ err: String(err) }, 'profile synthesizer scheduler tick failed'),
      );
    }, TICK_INTERVAL_MS),
    lastRunDayKeyIST: null,
    running: false,
  };
  if (typeof rt.timer.unref === 'function') rt.timer.unref();
  scheduler = rt;
  logger.info('profile synthesizer scheduler started');
}

export function stopProfileSynthesizerScheduler(): void {
  if (!scheduler) return;
  clearInterval(scheduler.timer);
  scheduler = null;
}

/** Test-only helper. */
export function __resetSynthesizerSchedulerForTests(): void {
  scheduler = null;
}
