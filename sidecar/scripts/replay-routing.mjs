#!/usr/bin/env node
// Replays past mentions through the tool-router and compares each with the
// route it actually took (issue #456). It is the evidence for letting the
// router decide: every difference is read by a person before that happens.
//
//   npm --prefix sidecar run build
//   node sidecar/scripts/replay-routing.mjs --db <snapshot.db> [--limit N] [--all] [--concurrency 4]
//
// Reads a copy of watchtower.db, never the live one. The rows are real Slack
// messages: output goes to the terminal only. Do not commit or paste it
// anywhere public.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const { decideTool, outcomeToLegacyIntent } = await import(`${dist}/router/toolRouter.js`);
const { routerWouldRun } = await import(`${dist}/router/routerShadow.js`);
const { setActiveBackend } = await import(`${dist}/codex/runCodex.js`);

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const dbPath = option('db');
if (!dbPath) {
  console.error('usage: replay-routing.mjs --db <snapshot.db> [--limit N] [--all] [--concurrency 4]');
  process.exit(2);
}
const limit = Number(option('limit', '0'));
const concurrency = Math.max(1, Number(option('concurrency', '4')));
const showAll = flag('all');

const PR_URL = /github\.com\/[^/\s>|]+\/[^/\s>|]+\/pull\/\d+/;
const EXACT_SYNTAX = new Set(['DEV_ASSIST', 'MINIOG_DOSSIER']);
const MUTATING = new Set(['PR_REVIEW', 'IMPLEMENTATION', 'DEPLOY']);
const GATE_HINTS = { DEPLOY: 'deploy keywords matched', PR_REVIEW: 'review gate matched', WEBAPP_QA: 'QA gate matched' };

const clean = text =>
  String(text ?? '')
    .replace(/\*sent using\*.*$/is, '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const legacyName = intent => (intent === 'OWNER_AUTOPILOT' ? 'IMPLEMENTATION' : intent);

const db = new Database(dbPath, { readonly: true });
const jobs = db
  .prepare(
    `SELECT id, workflow, executed_workflow, status, channel_id, thread_ts, payload_json
     FROM jobs ORDER BY created_at ${limit > 0 ? `LIMIT ${limit}` : ''}`,
  )
  .all();
const threadBefore = db.prepare(
  `SELECT display_name, user_id, text FROM conversation_messages
   WHERE channel_id = ? AND thread_ts = ? AND deleted = 0 AND CAST(message_ts AS REAL) < CAST(? AS REAL)
   ORDER BY CAST(message_ts AS REAL) DESC LIMIT 6`,
);
const ranClassifier = db.prepare(
  `SELECT 1 FROM job_logs WHERE job_id = ? AND stage = 'router.classify.start' LIMIT 1`,
);

const cases = [];
for (const job of jobs) {
  let payload = {};
  try {
    payload = JSON.parse(job.payload_json ?? '{}');
  } catch {
    // unreadable payload: skipped below
  }
  const message = clean(payload.text);
  const seed = payload.originalIntent ?? job.workflow;
  if (!message || EXACT_SYNTAX.has(seed) || EXACT_SYNTAX.has(job.workflow)) continue;
  const prior = payload.eventTs ? threadBefore.all(job.channel_id, job.thread_ts, payload.eventTs).reverse() : [];
  const threadContext = prior
    .filter(row => row.text?.trim())
    .map(row => `[${row.display_name || row.user_id}] ${row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}`)
    .join('\n');
  cases.push({
    id: job.id.slice(0, 8),
    legacy: legacyName(job.executed_workflow ?? job.workflow),
    status: job.status,
    // The router stands in for the classifier only. A keyword gate decided the
    // rest, except where a learned phrase seeded the job: those are skipped
    // once the router is on, so the router decides them too.
    routerDecides: Boolean(ranClassifier.get(job.id)) || payload.correctionApplied === true,
    facts: {
      message,
      addressing: payload.mentionType === 'owner' ? 'owner_mention' : 'direct',
      threadContext: threadContext || undefined,
      prUrlInTrigger: PR_URL.test(String(payload.text ?? '')),
      prUrlInThread: PR_URL.test(threadContext),
      hints: GATE_HINTS[seed] ? [GATE_HINTS[seed]] : [],
    },
  });
}
db.close();

setActiveBackend('claude-code');
console.error(`replaying ${cases.length} of ${jobs.length} jobs through the router (${concurrency} at a time)…`);

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < cases.length) {
      const item = cases[next++];
      const outcome = await decideTool({ facts: item.facts, role: 'router_replay' });
      results.push({ ...item, outcome, router: routerWouldRun(outcome) });
      if (results.length % 20 === 0) console.error(`  ${results.length}/${cases.length}`);
    }
  }),
);

const short = text => (text.length > 90 ? `${text.slice(0, 90)}…` : text);
const differ = results.filter(r => r.router !== r.legacy);
const newlyMutating = differ.filter(r => MUTATING.has(r.router) && !MUTATING.has(r.legacy));

for (const r of showAll ? results : differ) {
  const mark = r.router === r.legacy ? '  ' : MUTATING.has(r.router) && !MUTATING.has(r.legacy) ? '!!' : '≠ ';
  const confidence = r.outcome.ok ? r.outcome.decision.confidence.toFixed(2) : 'fail';
  console.log(`${mark} ${r.id}  ${r.legacy.padEnd(15)} → ${r.router.padEnd(15)} ${confidence}  ${r.facts.addressing === 'direct' ? 'bot  ' : 'owner'}  ${short(r.facts.message)}`);
  if (r.router !== r.legacy) console.log(`      ${r.outcome.ok ? r.outcome.decision.reason : r.outcome.error}`);
}

const matrix = {};
for (const r of results) {
  const key = `${r.legacy} → ${r.router}`;
  matrix[key] = (matrix[key] ?? 0) + 1;
}
console.log('\nroute taken → router:');
for (const [key, count] of Object.entries(matrix).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${key}`);
console.log(
  `\n${results.length} replayed: ${results.length - differ.length} agree, ${differ.length} differ, ` +
    `${results.filter(r => !r.outcome.ok).length} router failures.`,
);
console.log(`Newly mutating (router would act where the legacy path only answered or stayed silent): ${newlyMutating.length}`);

// What switching the router on changes today: only jobs the classifier decided,
// and only to what the classifier could have returned. The confidence floor
// that may still hold a seed is not modelled here.
const decided = results.filter(r => r.routerDecides);
const changed = decided
  .map(r => ({ ...r, effective: legacyName(outcomeToLegacyIntent(r.outcome, r.facts.addressing)) }))
  .filter(r => r.effective !== r.legacy);
const changedMatrix = {};
for (const r of changed) {
  const key = `${r.legacy} → ${r.effective}`;
  (changedMatrix[key] ??= []).push(r.id);
}
console.log(`\nWith the router on (${decided.length} of these jobs were decided by the classifier):`);
for (const [key, ids] of Object.entries(changedMatrix).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(ids.length).padStart(4)}  ${key}  [${ids.join(' ')}]`);
}
console.log(
  `${changed.length} would run something different; ` +
    `${changed.filter(r => MUTATING.has(r.effective) && !MUTATING.has(r.legacy)).length} newly reach a mutating tool, ` +
    `${changed.filter(r => !MUTATING.has(r.effective) && MUTATING.has(r.legacy)).length} no longer do.`,
);
console.log('The route taken is not always the right one: read each difference before drawing a conclusion.');
