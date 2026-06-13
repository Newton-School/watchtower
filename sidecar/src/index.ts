import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { WebClient } from '@slack/web-api';
import {
  getAdminUserIds,
  getConfiguredAccessControl,
  hydrateBundleUserIds,
  setResolvedGroupMembers,
} from './access/control.js';
import { shouldResumeFromReaction } from './router/investigationResumeGate.js';
import { loadConfigFromDb, readAgentBackend, readSettingsForAlert, MiniOgRepoRootViolationError } from './config.js';
import { setActiveBackend } from './codex/runCodex.js';
import { diagnoseFailure } from './learning/failureDoctor.js';
import { applyLearning } from './learning/selfLearning.js';
import {
  failLaunchpadWorkflow,
  finalizeLaunchpadWorkflowResult,
  markLaunchpadJobCreated,
} from './launchpad/launchpadLifecycle.js';
import { startLaunchpadRequestPoller } from './launchpad/launchpadIntake.js';
import { logger } from './logging/logger.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { assertMacOS } from './platform.js';
import { evaluatePolicy, loadPolicies } from './policies/evaluator.js';
import { agentCallContext } from './state/runContext.js';
import { normalizeTask } from './router/intentParser.js';
import { decidePausedResume } from './router/pausedResume.js';
import { classifyProduct } from './router/productClassifier.js';
import { routeTask } from './router/taskRouter.js';
import { startMentionCatchup } from './slack/mentionCatchup.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { cleanupStaleWorkspaces, cleanupThreadWorkspaces } from './workspaces/workspaceManager.js';
import { configureVaultWriter, shutdownVaultWriter } from './vault/vaultWriter.js';
import { configureVaultWatcher, shutdownVaultWatcher } from './vault/vaultWatcher.js';
import { startProfileSynthesizerScheduler, stopProfileSynthesizerScheduler } from './learning/profileSynthesizer.js';
import { loadWorkflowTemplates } from './workflows/registry.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { resolveUserGroup } from './slack/userGroupResolver.js';
import { registerActiveJob, unregisterActiveJob, cancelJob } from './state/activeJobs.js';
import { JobStore } from './state/jobStore.js';
import type { AccessGroupKey, SlackEventEnvelope, SlackReactionEvent, WorkflowStepLog } from './types/contracts.js';

assertMacOS();
loadPolicies();
loadWorkflowTemplates();

const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');

let config: ReturnType<typeof loadConfigFromDb>;
try {
  config = loadConfigFromDb(dbPath);
} catch (error) {
  if (error instanceof MiniOgRepoRootViolationError) {
    const alertSettings = readSettingsForAlert(dbPath);
    if (alertSettings) {
      const mentions = alertSettings.adminUserIds.map(id => `<@${id}>`).join(' ');
      const header = `${mentions ? mentions + ' ' : ''}miniOG refuses to start — repo paths must live under \`${error.miniOgRepoRoot}\`.`;
      const detail = error.offending.map(o => `• \`${o.label}\`: \`${o.path}\``).join('\n');
      const text = `${header}\n${detail}\n\nMove the clones (or update settings) so every repo path is a subdirectory of the mini-og root, then restart miniOG.`;
      const alertClient = new WebClient(alertSettings.slackBotToken);
      alertClient.chat
        .postMessage({ channel: alertSettings.channelId, text })
        .catch(postError =>
          logger.warn({ error: String(postError) }, 'failed to post mini-og-root violation alert to Slack'),
        );
    }
    logger.error({ err: String(error) }, 'mini-og repo-root validation failed — refusing to start');
  }
  throw error;
}
setActiveBackend(config.agentBackend);
const store = new JobStore(dbPath);

// D5a — bundle storage cutover. Once the bundles table has rows, it becomes
// the source of truth for capability checks; until then we seed from the
// D3-derived bundles (config.bundles, populated by mapSettingsToConfig from
// the legacy AccessControlConfig). After this block, config.bundles always
// reflects the table.
let bundlesLoadedAt = new Date().toISOString();
{
  const storedBundles = store.getBundles();
  if (storedBundles.length > 0) {
    config.bundles = hydrateBundleUserIds(storedBundles, config.ownerSlackUserIds);
    logger.info({ bundleCount: storedBundles.length }, 'loaded bundles from SQLite (table is source of truth)');
  } else if (config.bundles && config.bundles.length > 0) {
    for (const bundle of config.bundles) {
      store.setBundle(bundle);
    }
    logger.info(
      { bundleCount: config.bundles.length },
      'seeded bundles table from legacy AccessControlConfig (one-time)',
    );
  }
}

const queue: Array<{ event: SlackEventEnvelope; client: WebClient }> = [];
let running = 0;

const OPS_FEED_INTERVAL_MS = 30 * 60 * 1000;
const DAILY_DIGEST_TICK_MS = 60 * 1000;
const INCIDENT_TICK_MS = 5 * 60 * 1000;
const INCIDENT_CADENCE_MINUTES = 30;

// `message_deleted` is INTENTIONALLY not in this set: a deletion of the source
// mention needs to cancel any active job for that message (see
// processMessageDeleted below). `message_changed` and `bot_message` remain
// non-actionable — edits keep the same ts and the in-flight job is still
// valid; bot_message would loop on miniOG's own posts.
const nonActionableSubtypes = new Set(['message_changed', 'bot_message']);

/**
 * In-memory in-flight claim keyed by `${channelId}:${eventTs}` (i.e. the
 * underlying Slack message identity, not the eventId — live socket and
 * catch-up replay use different eventIds for the same message). Prevents
 * the live + catch-up race where both copies clear the pre-await dedup
 * gates and create two jobs for one user mention. Cleared in the finally
 * block of processEvent.
 */
const inFlightProcessClaims = new Set<string>();

function dedupeKey(event: SlackEventEnvelope, intent: string): string {
  return `${event.channelId}:${event.threadTs}:${event.eventTs}:${intent}`;
}

/**
 * Returns true when the workflow produces output worth saving as a per-user
 * memory entry. Chat / silent / unrouted / dossier-meta workflows produce no
 * "what miniOG did for you" narrative, so we skip them.
 */
function isMemoryWorthyWorkflow(intent: string): boolean {
  return intent !== 'CONVERSATIONAL' && intent !== 'NONE' && intent !== 'UNKNOWN' && intent !== 'MINIOG_DOSSIER';
}

async function addReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (error) {
    logger.warn({ channel, timestamp, name, error: String(error) }, 'failed to add reaction (non-fatal)');
  }
}

async function removeReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (error) {
    logger.warn({ channel, timestamp, name, error: String(error) }, 'failed to remove reaction (non-fatal)');
  }
}

function isTransientError(message: string): boolean {
  return /ETIMEDOUT|ECONNRESET|429|SlackApiError|timeout/i.test(message);
}

function extractSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const maybeData = (error as { data?: { error?: unknown } }).data;
  if (maybeData && typeof maybeData.error === 'string') {
    return maybeData.error;
  }
  return undefined;
}

async function postViaResponseUrl(params: { responseUrl: string; text: string; threadTs?: string }): Promise<void> {
  const { responseUrl, text, threadTs } = params;
  const payload: Record<string, unknown> = {
    response_type: 'in_channel',
    replace_original: false,
    text,
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`response_url post failed (${response.status}): ${body}`);
  }
}

function buildEventAwareClient(client: WebClient, event: SlackEventEnvelope): WebClient {
  const wrappedClient = Object.create(client) as WebClient;
  const originalPostMessage = client.chat.postMessage.bind(client.chat);
  const originalDelete = client.chat.delete.bind(client.chat);
  const wrappedChat = Object.create(client.chat) as typeof client.chat;

  wrappedChat.postMessage = async (...args: Parameters<typeof client.chat.postMessage>) => {
    const payload = (args[0] ?? {}) as {
      channel?: string;
      thread_ts?: string;
      text?: string;
    };
    let response: Awaited<ReturnType<typeof client.chat.postMessage>>;
    try {
      response = await originalPostMessage(...args);
    } catch (error) {
      const errorCode = extractSlackErrorCode(error);
      const sameChannel = payload.channel === event.channelId;
      const sameThread = !payload.thread_ts || payload.thread_ts === event.threadTs;

      if (errorCode === 'not_in_channel' && sameChannel && sameThread && event.responseUrl) {
        await postViaResponseUrl({
          responseUrl: event.responseUrl,
          text: String(payload.text ?? ''),
          threadTs: payload.thread_ts ?? event.threadTs,
        });
        return {
          ok: true,
          ts: payload.thread_ts ?? event.threadTs,
          channel: event.channelId,
        } as Awaited<ReturnType<typeof client.chat.postMessage>>;
      }
      throw error;
    }

    // Detect Slack's silent orphan-promotion. When we ask to post into a
    // thread whose parent was just deleted, Slack accepts the call but
    // strips `thread_ts` and lands the message at channel root — confusing
    // junk that no human asked for. Compare the requested thread_ts to the
    // one Slack actually stamped on the response and undo the post if they
    // diverged. RCA: Slack thread 1779174569.451259 (2026-05-19).
    const requestedThreadTs = payload.thread_ts;
    if (requestedThreadTs && response?.ok && response?.ts && payload.channel) {
      const responseMessage = (response as { message?: { thread_ts?: string } }).message;
      const actualThreadTs = responseMessage?.thread_ts;
      if (actualThreadTs !== requestedThreadTs) {
        const orphanTs = response.ts;
        // Best-effort delete of the orphan. If this itself fails (e.g. token
        // can't delete its own bot post), we still log+cancel so observers
        // can see what happened.
        try {
          await originalDelete({ channel: payload.channel, ts: orphanTs });
        } catch (deleteError) {
          logger.warn(
            { channel: payload.channel, orphanTs, error: String(deleteError) },
            'failed to delete orphan-promoted post (non-fatal)',
          );
        }
        logger.warn(
          {
            channel: payload.channel,
            requestedThreadTs,
            actualThreadTs: actualThreadTs ?? null,
            orphanTs,
            eventTs: event.eventTs,
          },
          'slack.post.orphan_promoted: parent deleted mid-flight; deleted the orphan and cancelling job',
        );
        // Find and cancel the active job tied to this Slack event. If no
        // active job is found (post was made outside a workflow), we just
        // delete the orphan and continue without cancellation.
        const active = store.activeJobForEventTs(event.channelId, event.eventTs);
        if (active) {
          cancelJob(active.id);
          store.markJob(active.id, 'CANCELLED', {
            errorMessage: 'Source message deleted during post (orphan-promoted reply).',
          });
          store.appendJobLog({
            jobId: active.id,
            stage: 'job.source_deleted',
            level: 'WARN',
            message: 'Slack promoted our thread reply to a channel-root orphan; cancelling.',
            data: {
              channelId: payload.channel,
              requestedThreadTs,
              actualThreadTs: actualThreadTs ?? null,
              orphanTs,
              eventTs: event.eventTs,
            },
          });
        }
        // Synthesize an "ok: false" return so callers see the post as a
        // no-op rather than a successful publish. Workflows already wrap
        // postMessage in .catch(() => {}); throwing here would surprise.
        return {
          ok: false,
          error: 'thread_parent_deleted',
        } as unknown as Awaited<ReturnType<typeof client.chat.postMessage>>;
      }
    }

    return response;
  };

  (wrappedClient as unknown as { chat: typeof client.chat }).chat = wrappedChat;
  return wrappedClient;
}

function reactionToSentiment(reaction: string): -1 | 0 | 1 {
  const value = reaction.toLowerCase();
  if (value === 'thumbsup' || value === '+1') {
    return 1;
  }
  if (value === 'thumbsdown' || value === '-1') {
    return -1;
  }
  if (value === 'brain') {
    return 1;
  }
  return 0;
}

/**
 * Handles `message_deleted` events: when a user deletes their @miniOG mention,
 * cancel any active job that was processing it. Without this, a job that
 * already started its planner (a 5+ minute call) keeps running and eventually
 * tries to post the plan into a thread whose parent no longer exists — Slack
 * silently strips `thread_ts` and the plan lands as an orphan in the channel
 * root, confusing readers and burning compute. RCA: Slack thread
 * 1779174569.451259 (2026-05-19).
 *
 * Only cancels jobs whose underlying message identity matches the deleted ts.
 * Catchup-replay siblings (different threadTs / different eventTs) are left
 * alone — they're independent jobs for independent (surviving) messages.
 */
async function processMessageDeleted(event: SlackEventEnvelope, client: WebClient): Promise<void> {
  const deletedTs = event.deletedTs ?? event.previousMessage?.ts;
  if (!event.channelId || !deletedTs) {
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, deletedTs: deletedTs ?? null },
      'message_deleted ignored: missing channel or deleted ts',
    );
    return;
  }

  if (store.hasEvent(event.eventId)) {
    return;
  }
  store.recordEvent(event.eventId, event.channelId, event.threadTs);

  const active = store.activeJobForEventTs(event.channelId, deletedTs);
  if (!active) {
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, deletedTs },
      'message_deleted: no active job to cancel',
    );
    return;
  }

  const cancelled = cancelJob(active.id);
  store.markJob(active.id, 'CANCELLED', {
    errorMessage: 'Source message deleted by author.',
  });
  store.appendJobLog({
    jobId: active.id,
    stage: 'job.source_deleted',
    level: 'WARN',
    message: 'Source mention was deleted in Slack — cancelled the job.',
    data: {
      channelId: event.channelId,
      deletedTs,
      deletedByUserId: event.previousMessage?.userId ?? null,
      workflow: active.workflow,
      previousStatus: active.status,
      abortSignalled: cancelled,
    },
  });

  // Clear the :eyes: reaction on the cancelled job's anchor. The anchor
  // message itself may be gone (the user just deleted it), so reactions.remove
  // will fail with `message_not_found` — that's expected; we swallow it.
  const anchor = store.eventAnchorFor(active.id);
  if (anchor) {
    await removeReaction(client, anchor.channelId, anchor.eventTs, 'eyes');
  }

  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      deletedTs,
      jobId: active.id,
      workflow: active.workflow,
      abortSignalled: cancelled,
    },
    'cancelled job after source message deletion',
  );
}

async function processReactionFeedback(event: SlackReactionEvent, client: WebClient): Promise<void> {
  if (!event.channelId || !event.threadTs || !event.userId) {
    return;
  }
  if (store.hasEvent(event.eventId)) {
    return;
  }

  const sentiment = reactionToSentiment(event.reaction);
  store.recordEvent(event.eventId, event.channelId, event.threadTs);
  store.recordReactionFeedback({
    eventId: event.eventId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    userId: event.userId,
    reaction: event.reaction,
    sentiment,
  });

  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      reaction: event.reaction,
      sentiment,
      itemUserId: event.itemUserId ?? null,
    },
    'reaction feedback ingested',
  );

  // Investigation resume gate — ✅ on miniOG's "Want me to fix this?" prompt
  // dispatches a synthetic event with the affirmation text so the router's
  // resume gate (PR #299) routes it straight to IMPLEMENTATION. Closes the
  // un-tagged-resume miss documented in RCA thread p1779086332488579
  // (2026-05-18) where Mihir replied "yes fix it" without @mentioning the
  // bot and the message was never ingested.
  //
  // The reaction target's ts is exposed as `threadTs` per
  // SocketSlackClient.normalizeReactionEnvelope (item.ts).
  const findings = store.investigationStore().getByPromptMessageTs(event.channelId, event.threadTs);
  const resume = shouldResumeFromReaction({
    reaction: event.reaction,
    reactorUserId: event.userId,
    findings,
    adminUserIds: getAdminUserIds(config),
  });
  if (!resume.ok) {
    if (findings && resume.reason === 'reactor_not_allowed') {
      logger.info(
        { reactorUserId: event.userId, requesterUserId: findings.requesterUserId, threadTs: findings.threadTs },
        'investigation resume reaction ignored — reactor is not the original requester or an admin',
      );
    }
    return;
  }
  // shouldResumeFromReaction only returns ok=true when findings exists;
  // narrow the type for the rest of the function.
  if (!findings) {
    return;
  }

  // Clear findings before enqueueing the synthetic event so a concurrent
  // tagged "yes" or a second reaction can't double-fire. The resume path
  // through implementationWorkflow re-reads findings from the saved JSON
  // in its own copy, so deletion here is safe.
  store.investigationStore().clear(findings.threadTs);

  const syntheticEventId = `reaction-resume:${event.eventId}`;
  const syntheticEvent: SlackEventEnvelope = {
    eventId: syntheticEventId,
    channelId: findings.channelId,
    threadTs: findings.threadTs,
    eventTs: event.eventTs,
    userId: event.userId,
    text: `<@${config.botUserId}> yes, fix it`,
    rawEvent: { source: 'investigation_reaction_resume', findingsJobId: findings.jobId },
  };

  logger.info(
    {
      reactorUserId: event.userId,
      threadTs: findings.threadTs,
      promptMessageTs: findings.promptMessageTs,
      findingsJobId: findings.jobId,
    },
    'investigation resume reaction confirmed — dispatching synthetic event',
  );

  await enqueueSlackEvent(syntheticEvent, client, 'socket');
}

function buildOpsFeedAlert(): string | undefined {
  const snapshot = store.getDevStatusSnapshot();
  const failures = store.listDevRuns(5, 'FAILED');
  const recentRuns = store.listDevRuns(50);
  const staleReviews = recentRuns.filter(run => run.workflow === 'PR_REVIEW' && run.status === 'PAUSED').length;

  const alerts: string[] = [];
  if (snapshot.failures24h >= 3) {
    alerts.push(`repeat failures detected (${snapshot.failures24h} failed runs in 24h)`);
  }
  if (snapshot.successRate24h < 85) {
    alerts.push(`risky deploy window: success rate is ${snapshot.successRate24h}%`);
  }
  if (staleReviews >= 2) {
    alerts.push(`stale review backlog detected (${staleReviews} paused PR review jobs)`);
  }

  if (alerts.length === 0) {
    return undefined;
  }

  const topFailure = failures[0];
  const topFailureLine = topFailure
    ? `Latest failure: ${topFailure.workflow} (${topFailure.errorMessage ?? 'no error text'})`
    : undefined;

  return [
    'Proactive Ops Feed:',
    ...alerts.map(item => `- ${item}`),
    topFailureLine ? `- ${topFailureLine}` : '',
    '- Use `wt failures 10` and `wt diagnose <jobId>` for quick triage.',
  ]
    .filter(Boolean)
    .join('\n');
}

function _startProactiveOpsFeed(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const channels = store.listOpsFeedChannels();
      if (channels.length === 0) {
        return;
      }

      const alertText = buildOpsFeedAlert();
      if (!alertText) {
        return;
      }

      for (const channelId of channels) {
        await client.chat.postMessage({
          channel: channelId,
          text: alertText,
        });
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'proactive ops feed tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, OPS_FEED_INTERVAL_MS);
}

function localHHMM(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function localDateKey(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildDailyDigestMessage(): string {
  const snapshot = store.getDevStatusSnapshot();
  const failures = store.listDevRuns(3, 'FAILED');
  const failureLine = failures[0]
    ? `- Latest failure: ${failures[0].workflow} (${failures[0].errorMessage ?? 'no error text'})`
    : '- Latest failure: none';

  return [
    'Daily Autopilot Digest:',
    `- Active jobs: ${snapshot.activeJobs}/${config.maxConcurrentJobs}`,
    `- Runs (24h): ${snapshot.runs24h}`,
    `- Failures (24h): ${snapshot.failures24h}`,
    `- Success rate (24h): ${snapshot.successRate24h}%`,
    failureLine,
  ].join('\n');
}

function _startDailyDigestTicker(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const schedules = store.listDailyDigestSchedules();
      if (schedules.length === 0) {
        return;
      }

      const now = new Date();
      const hhmm = localHHMM(now);
      const dateKey = localDateKey(now);
      const digest = buildDailyDigestMessage();

      for (const schedule of schedules) {
        if (schedule.digestTime !== hhmm) {
          continue;
        }
        if (store.wasDigestSentToday(schedule.channelId, dateKey)) {
          continue;
        }

        await client.chat.postMessage({
          channel: schedule.channelId,
          text: digest,
        });
        store.markDigestSentToday(schedule.channelId, dateKey);
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'daily digest tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, DAILY_DIGEST_TICK_MS);
}

function buildIncidentCadenceMessage(channelId: string): string | undefined {
  const snapshot = store.getIncidentSnapshot(channelId);
  if (snapshot.running === 0 && snapshot.failed60m === 0 && snapshot.paused60m === 0) {
    return undefined;
  }

  return [
    'Incident Commander Update:',
    `- Running jobs: ${snapshot.running}`,
    `- Failed jobs (last 60m): ${snapshot.failed60m}`,
    `- Paused jobs (last 60m): ${snapshot.paused60m}`,
    `- Dominant workflow impact: ${snapshot.topWorkflow}`,
    '- Use `wt failures 10` and `wt diagnose <jobId>` for next action.',
  ].join('\n');
}

function shouldPostIncidentCadence(channelId: string, nowMs: number): boolean {
  const key = `incident:last_post:${channelId}`;
  const previous = Number(store.getState(key) ?? '0');
  const minGapMs = INCIDENT_CADENCE_MINUTES * 60 * 1000;
  if (Number.isFinite(previous) && previous > 0 && nowMs - previous < minGapMs) {
    return false;
  }
  store.setState(key, String(nowMs));
  return true;
}

function _startIncidentCommanderFeed(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const channels = store.listIncidentChannels();
      if (channels.length === 0) {
        return;
      }

      const nowMs = Date.now();
      for (const channelId of channels) {
        if (!shouldPostIncidentCadence(channelId, nowMs)) {
          continue;
        }
        const text = buildIncidentCadenceMessage(channelId);
        if (!text) {
          continue;
        }
        await client.chat.postMessage({
          channel: channelId,
          text,
        });
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'incident commander tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, INCIDENT_TICK_MS);
}

async function enqueueSlackEvent(
  event: SlackEventEnvelope,
  client: WebClient,
  source: 'socket' | 'catchup' | 'launchpad',
): Promise<void> {
  queue.push({ event, client });
  logger.info({ queueDepth: queue.length, eventId: event.eventId, source }, 'event queued for processing');
  await processNext();
}

async function processNext(): Promise<void> {
  if (running >= config.maxConcurrentJobs) {
    return;
  }
  const item = queue.shift();
  if (!item) {
    return;
  }

  running += 1;
  try {
    await processEvent(item.event, item.client);
  } finally {
    running -= 1;
    await processNext();
  }
}

async function processEvent(event: SlackEventEnvelope, client: WebClient): Promise<void> {
  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      subtype: event.messageSubtype ?? null,
    },
    'slack event received',
  );

  if (event.messageSubtype && nonActionableSubtypes.has(event.messageSubtype)) {
    logger.info({ eventId: event.eventId, subtype: event.messageSubtype }, 'skip message subtype');
    return;
  }

  // `message_deleted` is routed before the user/bot/duplicate gates: it never
  // creates a job, only cancels existing ones, and the author of the wrapper
  // event is the deleter (often Slackbot or the original author themselves —
  // not relevant to the dedup gates).
  if (event.messageSubtype === 'message_deleted') {
    await processMessageDeleted(event, client);
    return;
  }

  if (!event.userId || event.userId === config.botUserId) {
    logger.info({ eventId: event.eventId }, 'skip empty or bot-originated event');
    return;
  }

  if (store.hasEvent(event.eventId)) {
    logger.info({ eventId: event.eventId }, 'duplicate event ignored');
    return;
  }

  // Claim this Slack message synchronously before any await: live socket
  // delivery and catch-up replay arrive with different eventIds but the same
  // (channelId, eventTs), and the durable dedup gates below all run after
  // async work, so without an in-process claim both copies can race past
  // them and create two jobs for one user action.
  const claimKey = `${event.channelId}:${event.eventTs}`;
  if (inFlightProcessClaims.has(claimKey)) {
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, eventTs: event.eventTs },
      'in-flight duplicate skipped (live socket / catch-up overlap)',
    );
    return;
  }
  inFlightProcessClaims.add(claimKey);
  try {
    await processEventClaimed(event, client);
  } finally {
    inFlightProcessClaims.delete(claimKey);
  }
}

async function processEventClaimed(event: SlackEventEnvelope, client: WebClient): Promise<void> {
  if (store.hasJobForEventTs(event.channelId, event.eventTs)) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, eventTs: event.eventTs },
      'duplicate channel/eventTs ignored',
    );
    return;
  }

  // Thread-level dedup: skip if this thread already has a running/paused job
  const activeThreadJob = store.activeJobForThread(event.channelId, event.threadTs);
  if (activeThreadJob) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      {
        eventId: event.eventId,
        channelId: event.channelId,
        threadTs: event.threadTs,
        activeJobId: activeThreadJob.id,
        activeJobStatus: activeThreadJob.status,
        activeJobWorkflow: activeThreadJob.workflow,
      },
      'skipped: thread already has an active job',
    );
    return;
  }

  // Paused-job follow-up: if a workflow paused asking the user to reply in
  // this thread (e.g. PR_REVIEW asking for a missing PR URL), the reply
  // arrives without an @miniOG mention and would otherwise be dropped by the
  // no-mention gate below. Decide here whether this event resumes a paused
  // job, so we can synthesize the mention after normalization.
  //
  // We can't trust jobs.workflow as the resume gate: owner mentions land in
  // that column as OWNER_AUTOPILOT even when the classifier later routed
  // them to PR_REVIEW. Read the actual pause cause from job_logs instead.
  const pausedJob = store.pausedJobForThread(event.channelId, event.threadTs);
  const pauseSignal = pausedJob
    ? store.isPausedAwaitingPrUrl(pausedJob.id)
      ? 'pr_review_awaiting_url'
      : store.isPausedAwaitingTargetChoice(pausedJob.id)
        ? 'pr_review_target_choice'
        : store.isPausedAwaitingUsageLimitRetry(pausedJob.id)
          ? 'usage_limit_retry'
          : undefined
    : undefined;
  const resumeDecision = decidePausedResume({
    pausedJob: pausedJob ? { id: pausedJob.id, workflow: pausedJob.workflow } : undefined,
    pauseSignal,
    eventText: event.text ?? '',
  });

  const eventClient = buildEventAwareClient(client, event);

  // Add :eyes: reaction to signal processing has started
  await addReaction(client, event.channelId, event.eventTs, 'eyes');

  logger.info({ eventId: event.eventId }, 'fetching thread context for intake');
  const threadMessages = await fetchThreadContext(eventClient, event.channelId, event.threadTs).catch(() => []);
  const threadTexts = threadMessages.map(message => message.text);
  logger.info({ eventId: event.eventId, messages: threadMessages.length }, 'thread context fetched for intake');
  let task = normalizeTask(event, config, threadTexts);

  // If this event resumes a paused workflow that asked the user to reply
  // in-thread, synthesize the bot mention so the no-mention gate below does
  // not drop the reply, and mark the old paused job as superseded.
  if (resumeDecision.resume && resumeDecision.paused) {
    // forceIntent: target-choice replies ("both", "web", "#123") carry no
    // review verb or URL, so normalizeTask would seed IMPLEMENTATION and the
    // classifier would have to guess — force PR_REVIEW deterministically.
    task = {
      ...task,
      mentionDetected: true,
      mentionType: 'bot',
      ...(resumeDecision.forceIntent ? { intent: resumeDecision.forceIntent } : {}),
    };
    store.markJob(resumeDecision.paused.id, 'SKIPPED', {
      result: {
        reason: 'resumed_by_followup',
        followupEventId: event.eventId,
        resumeReason: resumeDecision.reason,
      },
    });
    // Clear the :zzz: reaction from the original mention now that the job
    // is no longer parked. The new event will get its own :eyes: → outcome
    // reactions via the normal flow.
    const anchor = store.eventAnchorFor(resumeDecision.paused.id);
    if (anchor) {
      await removeReaction(client, anchor.channelId, anchor.eventTs, 'zzz');
    }
    logger.info(
      {
        eventId: event.eventId,
        pausedJobId: resumeDecision.paused.id,
        pausedWorkflow: resumeDecision.paused.workflow,
        reason: resumeDecision.reason,
        clearedZzzAt: anchor ? `${anchor.channelId}:${anchor.eventTs}` : null,
      },
      'paused-job follow-up: synthesized mention to resume in-thread',
    );
  }

  logger.info(
    {
      eventId: event.eventId,
      mentionDetected: task.mentionDetected,
      mentionType: task.mentionType,
      intent: task.intent,
    },
    'task normalized from slack event',
  );

  if (!task.mentionDetected) {
    logger.info({ eventId: event.eventId }, 'skip non-mention message');
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    return;
  }

  // Policy engine check — block requests that violate critical or non-master rules
  const policyDecision = evaluatePolicy(event.userId, event.text, getAdminUserIds(config));
  if (!policyDecision.allowed) {
    logger.warn(
      { eventId: event.eventId, userId: event.userId, tier: policyDecision.tier, ruleId: policyDecision.ruleId },
      'request blocked by policy engine',
    );
    await eventClient.chat
      .postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text: policyDecision.reason,
      })
      .catch(() => {});
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'no_entry_sign');
    return;
  }

  const learning = applyLearning({ task, config, store });
  const routedTask = learning.intent === task.intent ? task : { ...task, intent: learning.intent };

  logger.info(
    {
      eventId: event.eventId,
      originalIntent: task.intent,
      routedIntent: routedTask.intent,
      correctionApplied: learning.correctionApplied,
      learningNotes: learning.notes,
    },
    'learning engine evaluated task',
  );

  const key = dedupeKey(event, routedTask.intent);
  store.recordEvent(event.eventId, event.channelId, event.threadTs);

  const jobId = uuidv4();
  store.createJob({
    id: jobId,
    eventId: event.eventId,
    dedupeKey: key,
    workflow: routedTask.intent,
    channelId: event.channelId,
    threadTs: event.threadTs,
    payload: {
      text: event.text,
      requestUserId: event.userId,
      mentionType: task.mentionType,
      intent: routedTask.intent,
      originalIntent: task.intent,
      correctionApplied: learning.correctionApplied,
      learningNotes: learning.notes,
      eventTs: event.eventTs,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
    },
  });

  const abortController = new AbortController();
  registerActiveJob(jobId, abortController);

  const stepLogs: WorkflowStepLog[] = [];

  const logStep = (step: WorkflowStepLog): void => {
    stepLogs.push({
      level: step.level ?? 'INFO',
      stage: step.stage,
      message: step.message,
      data: step.data,
    });

    const level = step.level ?? 'INFO';
    const payload = {
      jobId,
      eventId: event.eventId,
      workflow: routedTask.intent,
      stage: step.stage,
      ...(step.data ? { data: step.data } : {}),
    };

    if (level === 'ERROR') {
      logger.error(payload, step.message);
    } else if (level === 'WARN') {
      logger.warn(payload, step.message);
    } else {
      logger.info(payload, step.message);
    }

    try {
      store.appendJobLog({
        jobId,
        stage: step.stage,
        message: step.message,
        level,
        data: step.data,
      });
    } catch (error) {
      logger.error(
        {
          jobId,
          eventId: event.eventId,
          stage: step.stage,
          error: String(error),
        },
        'failed to persist workflow step log',
      );
    }
  };

  logStep({
    stage: 'job.created',
    message: 'Created job record for tagged message.',
    data: {
      dedupeKey: key,
      mentionType: task.mentionType,
      intent: routedTask.intent,
      originalIntent: task.intent,
      correctionApplied: learning.correctionApplied,
      learningNotes: learning.notes,
      threadMessages: threadMessages.length,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
    },
  });

  markLaunchpadJobCreated({
    event,
    jobId,
    store,
    logStep,
  });

  try {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 3) {
      attempt += 1;
      store.bumpAttempt(jobId);
      logStep({
        stage: 'job.attempt.start',
        message: 'Starting workflow attempt.',
        data: {
          attempt,
          maxAttempts: 3,
        },
      });
      try {
        // Hot-reload agent backend setting from DB before each workflow run
        // so that settings changes take effect without restarting the sidecar.
        const currentBackend = readAgentBackend(dbPath);
        setActiveBackend(currentBackend);

        // D5a — hot-reload bundles if the Tauri UI (or direct SQL) edited
        // them since the last build. Mirrors the readAgentBackend pattern:
        // signal-driven (no polling cost when nothing changed).
        const signalAt = store.getAccessCacheSignalAt();
        if (signalAt && signalAt > bundlesLoadedAt) {
          const reloaded = store.getBundles();
          if (reloaded.length > 0) {
            config.bundles = hydrateBundleUserIds(reloaded, config.ownerSlackUserIds);
            bundlesLoadedAt = signalAt;
            logger.info({ bundleCount: reloaded.length, signalAt }, 'reloaded bundles after access cache signal');
          }
        }

        const result = await agentCallContext.run({ jobId, store }, () =>
          routeTask({
            task: routedTask,
            config,
            slack: eventClient,
            store,
            jobId,
            logStep,
            signal: abortController.signal,
          }),
        );
        const hasPrInResult =
          result.result?.prUrl && typeof result.result.prUrl === 'string' && result.result.prUrl !== '';
        const diagnosis =
          result.status === 'FAILED' && !hasPrInResult
            ? diagnoseFailure({
                workflow: routedTask.intent,
                message: result.message,
                logs: stepLogs,
              })
            : undefined;

        if (diagnosis) {
          logStep({
            stage: 'failure_doctor.diagnosed',
            message: 'Failure Doctor produced a diagnosis for workflow failure.',
            level: 'WARN',
            data: diagnosis,
          });
        }

        logStep({
          stage: 'job.attempt.result',
          message: 'Workflow attempt returned a result.',
          level: result.status === 'FAILED' ? 'ERROR' : 'INFO',
          data: {
            status: result.status,
            message: result.message,
            slackPosted: result.slackPosted,
            notifyDesktop: result.notifyDesktop,
          },
        });
        // Persist the workflow that actually ran (post-router reclassification)
        // so dashboard surfaces show the right label without disturbing
        // jobs.workflow (which pauseResume uses for resume detection).
        const executedWorkflow = result.workflow !== routedTask.intent ? result.workflow : undefined;
        if (result.status === 'SUCCESS') {
          store.markJob(jobId, 'SUCCESS', { result: result.result, executedWorkflow });
        } else if (result.status === 'PAUSED') {
          // For PAUSED jobs the workflow's resumeContext (if it set one) is the
          // payload that matters — it's what loadResumeContext + the sweeper
          // read. Fall back to result.result for legacy callers that PAUSE
          // without a resume context (e.g. desktop-routing on uncertain repo).
          store.markJob(jobId, 'PAUSED', {
            result: (result.resumeContext as Record<string, unknown> | undefined) ?? result.result,
            executedWorkflow,
          });
        } else if (result.status === 'SKIPPED') {
          store.markJob(jobId, 'SKIPPED', { result: result.result, executedWorkflow });
        } else if (result.status === 'CANCELLED') {
          store.markJob(jobId, 'CANCELLED', { result: result.result, executedWorkflow });
        } else {
          store.markJob(jobId, 'FAILED', {
            errorMessage: result.message,
            result: result.result,
            executedWorkflow,
          });
        }

        try {
          const personalityMode = store.getPersonalityMode({
            channelId: event.channelId,
            userId: event.userId,
          });
          const repoName = typeof result.result?.repoName === 'string' ? result.result.repoName : undefined;
          const productKey = isMemoryWorthyWorkflow(routedTask.intent)
            ? (classifyProduct([event.text ?? '', result.message ?? '', JSON.stringify(result.result ?? {})])
                .selected ?? undefined)
            : undefined;
          store.recordLearningSignal({
            jobId,
            eventId: event.eventId,
            channelId: event.channelId,
            userId: event.userId,
            workflow: routedTask.intent,
            intent: task.intent,
            status: result.status,
            correctionApplied: learning.correctionApplied,
            errorKind: diagnosis?.errorKind,
            personalityMode,
            repo: repoName,
            product: productKey,
          });
          if (isMemoryWorthyWorkflow(routedTask.intent) && result.message) {
            const prUrl =
              typeof result.result?.prUrl === 'string' && result.result.prUrl ? result.result.prUrl : undefined;
            store.dossierStore().recordMemory({
              userId: event.userId,
              jobId,
              workflow: routedTask.intent,
              status: result.status,
              repo: repoName,
              prUrl,
              product: productKey,
              summary: result.message,
            });
          }
          store.dossierStore().invalidate(event.userId);
        } catch (error) {
          logStep({
            stage: 'learning.signal.persist_failed',
            message: 'Failed to persist learning signal.',
            level: 'WARN',
            data: {
              error: String(error),
            },
          });
        }

        await finalizeLaunchpadWorkflowResult({
          event,
          result,
          slack: eventClient,
          store,
          logStep,
        });

        // Tear down the thread's git worktrees once the job is terminal, so the
        // next task in this thread creates a fresh worktree (fetched + branched
        // from current origin/<default-branch>) rather than reusing a stale
        // base. Done BEFORE unregisterActiveJob so the thread is still locked —
        // a queued same-thread event can't start a new job (and create a
        // worktree) that this cleanup would then delete. PAUSED jobs keep their
        // worktree (they may resume in-thread); resolveWorkspace also refreshes
        // any reused worktree as a backstop.
        if (result.status !== 'PAUSED') {
          await cleanupThreadWorkspaces(event.threadTs);
        }

        unregisterActiveJob(jobId);

        // Swap :eyes: for outcome reaction. PAUSED gets a distinct emoji so a
        // glance at the thread tells you "parked, mention me to resume" rather
        // than the misleading :x: it used to share with cancelled/failed jobs.
        await removeReaction(client, event.channelId, event.eventTs, 'eyes');
        const outcomeReaction =
          result.status === 'SUCCESS' || result.status === 'SKIPPED'
            ? 'white_check_mark'
            : result.status === 'PAUSED'
              ? 'zzz'
              : 'x';
        await addReaction(client, event.channelId, event.eventTs, outcomeReaction);

        return;
      } catch (error) {
        lastError = error;
        const msg = String(error);
        const transient = isTransientError(msg);
        logger.error({ error: msg, attempt, jobId }, 'job attempt failed');
        logStep({
          stage: 'job.attempt.exception',
          message: 'Workflow attempt threw an exception.',
          level: 'ERROR',
          data: {
            attempt,
            transient,
            error: msg,
          },
        });
        if (!transient || attempt >= 3) {
          break;
        }
        logStep({
          stage: 'job.attempt.retry_scheduled',
          message: 'Transient failure detected; retrying workflow.',
          level: 'WARN',
          data: {
            attempt,
            nextAttempt: attempt + 1,
          },
        });
      }
    }

    const errorMessage = `Workflow failed after retries: ${String(lastError)}`;
    const diagnosis = diagnoseFailure({
      workflow: routedTask.intent,
      message: errorMessage,
      logs: stepLogs,
    });

    if (diagnosis) {
      logStep({
        stage: 'failure_doctor.diagnosed',
        message: 'Failure Doctor produced a diagnosis after retries were exhausted.',
        level: 'WARN',
        data: diagnosis,
      });
    }

    logStep({
      stage: 'job.failed.after_retries',
      message: 'Workflow exhausted retry budget and will be marked failed.',
      level: 'ERROR',
      data: {
        errorMessage,
      },
    });

    await eventClient.chat
      .postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text: `${errorMessage}`,
      })
      .catch(() => {});

    logStep({
      stage: 'job.failed.slack_posted',
      message: 'Posted hard-failure message to Slack thread.',
      level: 'ERROR',
    });

    // Terminal failure — tear down the thread's worktrees (same rationale as
    // the success path); the next task starts fresh. Before unregister so the
    // thread stays locked during cleanup.
    await cleanupThreadWorkspaces(event.threadTs);

    unregisterActiveJob(jobId);
    notifyDesktop('Watchtower workflow failed', errorMessage);
    failLaunchpadWorkflow({
      event,
      errorMessage,
      store,
      logStep,
    });
    store.markJob(jobId, 'FAILED', { errorMessage });

    // Swap :eyes: for :x: on retry exhaustion
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'x');

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(routedTask.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(routedTask.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: routedTask.intent,
          status: 'FAILED',
          product: productKey,
          summary: `Failed: ${errorMessage.slice(0, 280)}`,
        });
      }
      store.dossierStore().invalidate(event.userId);
    } catch (error) {
      logStep({
        stage: 'learning.signal.persist_failed',
        message: 'Failed to persist learning signal after retries.',
        level: 'WARN',
        data: {
          error: String(error),
        },
      });
    }
  } catch (error) {
    const errorMessage = String(error);
    const diagnosis = diagnoseFailure({
      workflow: routedTask.intent,
      message: errorMessage,
      logs: stepLogs,
    });

    if (diagnosis) {
      logStep({
        stage: 'failure_doctor.diagnosed',
        message: 'Failure Doctor produced a diagnosis for unexpected process failure.',
        level: 'WARN',
        data: diagnosis,
      });
    }

    // Terminal (unexpected) failure — tear down the thread's worktrees before
    // releasing the lock, same as the other terminal paths, so the next task
    // starts fresh and no concurrent same-thread job's worktree is deleted.
    await cleanupThreadWorkspaces(event.threadTs);

    unregisterActiveJob(jobId);
    logger.error({ jobId, eventId: event.eventId, error: errorMessage }, 'unexpected processEvent failure');
    notifyDesktop('Watchtower job failure', errorMessage);
    failLaunchpadWorkflow({
      event,
      errorMessage,
      store,
      logStep,
    });
    store.markJob(jobId, 'FAILED', { errorMessage });

    // Swap :eyes: for :x: on unexpected failure
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'x');

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(routedTask.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(routedTask.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: routedTask.intent,
          status: 'FAILED',
          product: productKey,
          summary: `Failed: ${errorMessage.slice(0, 280)}`,
        });
      }
      store.dossierStore().invalidate(event.userId);
    } catch {
      // ignore persistence failures in terminal error path
    }
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs }, 'watchtower sidecar starting');
  await cleanupStaleWorkspaces();

  // Boot the optional Obsidian-compatible vault writer. When disabled (or no
  // path configured), scheduleVaultRender calls become no-ops; the dossier
  // store stays unaware of which mode the operator is in.
  const vaultSettings = store.readVaultSettings();
  configureVaultWriter({
    store,
    vaultPath: vaultSettings.vaultPath,
    enabled: vaultSettings.vaultEnabled,
  });
  // Two-way edits: chokidar watches users/*.md and lifts Role/Notes back into
  // user_dossiers. No-op when vault is disabled.
  await configureVaultWatcher({
    store,
    vaultPath: vaultSettings.vaultPath,
    enabled: vaultSettings.vaultEnabled,
  }).catch(err => logger.warn({ err: String(err) }, 'vault watcher start failed'));

  // Phase C: nightly profile synthesizer. Ticks every 60s and runs once per
  // IST day (~midnight) for users with activity since the last run.
  // Bounded cost: skips users with <3 memories or last synthesis <12h ago,
  // concurrency capped at 2 LLM calls in flight.
  startProfileSynthesizerScheduler(store);

  // Mark any leftover RUNNING jobs as FAILED — their processes are gone after restart
  const orphaned = store.cleanupOrphanedRunningJobs();
  if (orphaned > 0) {
    logger.warn({ orphaned }, 'cleaned up orphaned RUNNING jobs from previous session');
  }

  // Revert launchpad requests stranded in CLAIMED/QUEUED back to PENDING so
  // the intake poller picks them up again. Without this, a sidecar crash
  // between claim and job-link leaves the desktop-originated request
  // silently never executing and never recovering.
  const strandedLaunchpad = store.recoverStrandedLaunchpadRequests();
  if (strandedLaunchpad > 0) {
    logger.warn(
      { strandedLaunchpad },
      'reverted launchpad requests stranded in CLAIMED/QUEUED back to PENDING for retry',
    );
  }

  // Reconcile launchpad requests whose linked job was just orphan-failed above.
  // Must run AFTER cleanupOrphanedRunningJobs so the JOIN sees the FAILED rows.
  // Without this, a launchpad request that reached RUNNING (job_id assigned)
  // before the sidecar restart would stay stuck forever — the orphan cleanup
  // failed the job but never touched the launchpad row, so no terminal DM
  // is delivered to the requester.
  const reconciledLaunchpad = store.reconcileFailedOrphanedLaunchpadRequests();
  if (reconciledLaunchpad > 0) {
    logger.warn(
      { reconciledLaunchpad },
      'marked stranded RUNNING launchpad requests as FAILED after their jobs were orphan-cleaned',
    );
  }

  const client = new SocketSlackClient(
    config,
    async (event, webClient) => {
      await enqueueSlackEvent(event, webClient as WebClient, 'socket');
    },
    async (event, webClient) => {
      await processReactionFeedback(event, webClient as WebClient);
    },
  );

  process.on('SIGINT', () => {
    logger.info('received SIGINT');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    store.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('received SIGTERM');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    store.close();
    process.exit(0);
  });

  await client.start();
  logger.info('autonomous feed/digest/incident posting disabled; mention-triggered replies only');

  const refreshAccessGroups = async () => {
    const accessControl = getConfiguredAccessControl(config);
    // handle → subteam ID, shared across groups and the legacy core-dev
    // resolution below so each handle costs one Slack round-trip per tick.
    const resolvedHandleIds = new Map<string, string>();
    for (const groupKey of Object.keys(accessControl.groups) as AccessGroupKey[]) {
      const group = accessControl.groups[groupKey];
      const handles = group.slackUserGroupHandle
        .split(',')
        .map(h => h.trim())
        .filter(Boolean);
      if (handles.length === 0) {
        continue;
      }

      const allMembers: string[] = [];
      const subteamIds: string[] = [];
      let anyHandleFailed = false;
      for (const handle of handles) {
        try {
          const resolved = await resolveUserGroup(client.webClient, handle);
          if (resolved) {
            allMembers.push(...resolved.members);
            subteamIds.push(resolved.id);
            resolvedHandleIds.set(resolved.handle, resolved.id);
          }
        } catch (error) {
          logger.warn({ groupKey, handle, error: String(error) }, 'access group handle refresh failed');
          anyHandleFailed = true;
        }
      }

      // Don't overwrite the live allowlist with a partial / empty membership
      // when any configured handle failed to resolve — that would lock out
      // group-only users on a transient Slack outage. Retain the
      // last-known-good cache; the next refresh tick (30m) will retry.
      if (anyHandleFailed) {
        logger.warn(
          {
            groupKey,
            handles,
            memberCount: getConfiguredAccessControl(config).groups[groupKey].resolvedUserIds.length,
          },
          'access group refresh skipped: handle failure(s); retaining last-known-good membership',
        );
        continue;
      }

      setResolvedGroupMembers({ config, groupKey, members: allMembers, subteamIds });
      logger.info(
        {
          groupKey,
          handles,
          memberCount: getConfiguredAccessControl(config).groups[groupKey].resolvedUserIds.length,
          subteamIds,
        },
        'access group resolved',
      );
    }

    // Legacy installs configure only core_dev_slack_user_group (no admin
    // group row). Resolve its subteam ID too so formatAdminMention can emit
    // a working mention; same last-known-good discipline on failure.
    const legacyHandle = (config.coreDevSlackUserGroup ?? '').replace(/^@/, '').trim().toLowerCase();
    if (legacyHandle) {
      const cached = resolvedHandleIds.get(legacyHandle);
      if (cached) {
        config.resolvedCoreDevSubteamIds = [cached];
      } else {
        try {
          const resolved = await resolveUserGroup(client.webClient, legacyHandle);
          config.resolvedCoreDevSubteamIds = resolved ? [resolved.id] : [];
        } catch (error) {
          logger.warn(
            { handle: legacyHandle, error: String(error) },
            'core-dev subteam id refresh failed; retaining last-known-good',
          );
        }
      }
    }
  };

  await refreshAccessGroups();
  setInterval(refreshAccessGroups, 30 * 60 * 1000);

  // Poll for cancel requests from the Watchtower UI (written to SQLite by Tauri)
  setInterval(() => {
    const pendingIds = store.popPendingCancels();
    for (const jobId of pendingIds) {
      const cancelled = cancelJob(jobId);
      if (cancelled) {
        store.markJob(jobId, 'CANCELLED', { errorMessage: 'Cancelled from Watchtower UI.' });
        logger.info({ jobId }, 'job cancelled from UI');
      }
    }
  }, 2000);

  // Sweep stale PAUSED jobs every 5 minutes. A job that's been paused for >24h
  // without a resume mention is treated as abandoned: marked FAILED so it
  // stops counting in dashboards / occupying paused-job listings. The
  // workspace under workspaces/<thread_ts> is left alone (it's per-thread, not
  // per-job, and a future task in the same thread may want to reuse it).
  const PAUSED_MAX_AGE_MIN = 24 * 60;
  setInterval(
    () => {
      try {
        const stale = store.stalePausedJobs(PAUSED_MAX_AGE_MIN);
        for (const job of stale) {
          store.markJob(job.id, 'FAILED', {
            errorMessage: `Idle timeout — paused for >${PAUSED_MAX_AGE_MIN / 60}h without a resume mention.`,
          });
          logger.info(
            { jobId: job.id, channelId: job.channelId, threadTs: job.threadTs },
            'stale PAUSED job swept to FAILED',
          );
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'paused-job sweeper tick failed');
      }
    },
    5 * 60 * 1000,
  );

  // Retention sweep — nothing else prunes the high-growth tables (job_logs,
  // learning_signals, agent_calls, reaction_feedback, events, terminal jobs),
  // so over a multi-day lifetime they grow unbounded and slow every query.
  // Prune once at startup, then hourly. RUNNING/PAUSED jobs and per-user dossier
  // data are preserved. Window defaults to 30 days; override via
  // WATCHTOWER_RETENTION_DAYS (clamped to >= 1 inside pruneOldRows).
  const retentionDays = Number(process.env.WATCHTOWER_RETENTION_DAYS ?? 30) || 30;
  const runRetentionSweep = (): void => {
    try {
      const pruned = store.pruneOldRows(retentionDays);
      const total =
        pruned.jobLogs +
        pruned.learningSignals +
        pruned.agentCalls +
        pruned.reactionFeedback +
        pruned.events +
        pruned.jobs;
      if (total > 0) {
        logger.info({ retentionDays, total, ...pruned }, 'retention sweep pruned old rows');
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'retention sweep tick failed');
    }
  };
  runRetentionSweep();
  setInterval(runRetentionSweep, 60 * 60 * 1000);

  startMentionCatchup({
    webClient: client.webClient,
    config,
    store,
    enqueue: enqueueSlackEvent,
  });

  startLaunchpadRequestPoller({
    webClient: client.webClient,
    config,
    store,
    enqueue: async (event, webClient) => {
      await enqueueSlackEvent(event, webClient, 'launchpad');
    },
  });
}

main().catch(error => {
  logger.error({ error: String(error) }, 'watchtower sidecar crashed');
  notifyDesktop('Watchtower sidecar crash', String(error));
  process.exit(1);
});
