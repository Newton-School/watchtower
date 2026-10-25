import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { WebClient } from '@slack/web-api';
import { getAdminUserIds, hydrateBundleUserIds } from './access/control.js';
import { copySlackGroupMembers } from './access/slackGroupMembers.js';
import { shouldResumeFromReaction } from './router/investigationResumeGate.js';
import { loadConfigFromDb, readAgentBackend, readSettingsForAlert, MiniOgRepoRootViolationError } from './config.js';
import { setActiveBackend } from './codex/runCodex.js';
import { diagnoseFailure } from './learning/failureDoctor.js';
import {
  failLaunchpadWorkflow,
  finalizeLaunchpadWorkflowResult,
  markLaunchpadJobCreated,
} from './launchpad/launchpadLifecycle.js';
import { startLaunchpadRequestPoller, takeBackPostedAsk } from './launchpad/launchpadIntake.js';
import { startAppAnswerPoller } from './launchpad/appAnswers.js';
import { logger } from './logging/logger.js';
import { configureButtons } from './slack/buttonReplies.js';
import { runPrFollowUp } from './workflows/prFollowUp.js';
import { resolveGithubTokenForCodex } from './github/githubAuth.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { botScopes, missingScopesNotice, NOTIFIED_MISSING_SCOPES_KEY } from './slack/botScopes.js';
import { buildEventAwareClient, type OrphanPromotion } from './slack/eventAwareClient.js';
import { assertMacOS } from './platform.js';
import { evaluatePolicy, loadPolicies } from './policies/evaluator.js';
import { agentCallContext } from './state/runContext.js';
import { detectMention, normalizeTask } from './router/intentParser.js';
import { isOwnerTagDelegationEnabled } from './access/ownerDelegation.js';
import { isRouteQuestionExpired } from './router/routeClarify.js';
import { jobSlots } from './runtime/jobSlots.js';
import { keepAwake } from './runtime/keepAwake.js';
import { decidePausedResume } from './router/pausedResume.js';
import { classifyProduct } from './router/productClassifier.js';
import { routeTask } from './router/taskRouter.js';
import { startMentionCatchup, type MentionCatchup } from './slack/mentionCatchup.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { SocketWatchdog, type SocketAlert } from './slack/socketWatchdog.js';
import { captureLiveMessage, captureThreadFromMessages, isSyntheticEnvelope } from './conversation/threadCapture.js';
import { startThreadSweeper, stopThreadSweeper } from './conversation/threadSweeper.js';
import { startThreadSynthesizerScheduler, stopThreadSynthesizerScheduler } from './conversation/threadSynthesizer.js';
import { configureGithubPublisher, shutdownGithubPublisher } from './egress/githubPublisher.js';
import { runConversationBackfill } from './conversation/threadBackfill.js';
import { cleanupStaleWorkspaces, cleanupThreadWorkspaces, WorkspaceSetupError } from './workspaces/workspaceManager.js';
import { sweepDepCache } from './workspaces/depCache.js';
import { sweepLookupWorkspaces } from './workspaces/lookupWorkspace.js';
import { configureAgentSandbox } from './backends/agentSandbox.js';
import { enabledRepoPaths } from './repos/registry.js';
import { configureVaultWriter, shutdownVaultWriter } from './vault/vaultWriter.js';
import { configureVaultWatcher, shutdownVaultWatcher } from './vault/vaultWatcher.js';
import { startProfileSynthesizerScheduler, stopProfileSynthesizerScheduler } from './learning/profileSynthesizer.js';
import { narrateStep } from './slack/statusNarrator.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { createThreadStatus, type ThreadStatus } from './slack/threadStatus.js';
import { isOlderVersion, readSidecarBuild } from './runtime/buildInfo.js';
import { recoveryFor } from './runtime/restartRecovery.js';
import { reloadBundlesIfChanged } from './runtime/bundleReload.js';
import { closeDeployOfferAfterRestart } from './workflows/marketingDeployOffer.js';
import { connectorAlertText, connectorsToAlert, onConnectorStatuses } from './runtime/connectorAlerts.js';
import { acquireInstanceLock, instanceLockPath, releaseInstanceLock } from './runtime/instanceLock.js';
import {
  registerActiveJob,
  unregisterActiveJob,
  cancelJob,
  takeCancelReason,
  activeJobIdForThread,
  activeJobForThread,
} from './state/activeJobs.js';
import { finishWork } from './state/workLedger.js';
import { decideStop } from './router/stopIntent.js';
import { JobStore } from './state/jobStore.js';
import { settleAbortedResult } from './workflows/shared/cancelState.js';
import type { SlackEventEnvelope, SlackReactionEvent, WorkflowStepLog } from './types/contracts.js';

assertMacOS();
loadPolicies();

/** How long after startup a review lost to a restart is run again (issue #589). */
const RESTART_RERUN_DELAY_MS = 15_000;

const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');

// Stamped on every job so a run can be traced to the bundle that handled it
// (issue #450).
const sidecarBuild = readSidecarBuild({ pid: process.pid, argv: process.argv, env: process.env });

// One sidecar per database. Take the instance lock before touching the DB or
// Slack; a second sidecar waits here until the first one exits.
const lockPath = instanceLockPath(dbPath);
let standbyPolls = 0;
const { replaced: staleLock } = await acquireInstanceLock({
  lockPath,
  self: {
    pid: sidecarBuild.sidecarPid,
    entry: sidecarBuild.sidecarEntry,
    version: sidecarBuild.appVersion,
    startedAt: new Date().toISOString(),
  },
  onStandby: holder => {
    // First poll, then every 5 minutes at the default 5s interval.
    if (standbyPolls++ % 60 === 0) {
      logger.warn(
        { lockPath, holder, ...sidecarBuild },
        'another watchtower sidecar holds the instance lock — standing by until it exits',
      );
    }
  },
});
process.on('exit', () => releaseInstanceLock(lockPath));
if (staleLock) {
  logger.info({ lockPath, staleLock }, 'took over a stale sidecar instance lock');
}

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
{
  const storedBundles = store.getBundles();
  if (storedBundles.length > 0) {
    config.bundles = hydrateBundleUserIds(storedBundles, config.ownerSlackUserIds);
    logger.info({ bundleCount: storedBundles.length }, 'loaded bundles from SQLite (table is source of truth)');
  } else if (config.bundles && config.bundles.length > 0) {
    for (const bundle of config.bundles) {
      store.setBundle(bundle);
    }
    store.carryLegacySlackGroups();
    logger.info(
      { bundleCount: config.bundles.length },
      'seeded bundles table from legacy AccessControlConfig (one-time)',
    );
  }
}

const queue: Array<{ event: SlackEventEnvelope; client: WebClient; processed?: () => void }> = [];
// How many jobs run at once, and what happens when one stops needing its slot.
jobSlots.configure({
  max: () => config.maxConcurrentJobs,
  onFree: () => void processNext(),
  // The Mac stays awake while any job holds a slot (issue #439).
  onActiveChange: active => keepAwake.set(active > 0),
});

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

/**
 * Find and cancel the active job tied to this Slack event after one of its
 * replies was orphan-promoted (see `buildEventAwareClient`). If no active job
 * is found (post was made outside a workflow), the orphan was just deleted.
 */
function cancelForOrphanedReply(event: SlackEventEnvelope, orphan: OrphanPromotion): void {
  const active = store.activeJobForEventTs(event.channelId, event.eventTs);
  if (!active) return;
  cancelJob(active.id, {
    source: 'source_deleted',
    message: 'Source message deleted during post (orphan-promoted reply).',
  });
  store.markJob(active.id, 'CANCELLED', {
    errorMessage: 'Source message deleted during post (orphan-promoted reply).',
  });
  store.appendJobLog({
    jobId: active.id,
    stage: 'job.source_deleted',
    level: 'WARN',
    message: 'Slack promoted our thread reply to a channel-root orphan; cancelling.',
    data: { ...orphan },
  });
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

  const cancelled = cancelJob(active.id, { source: 'source_deleted', message: 'Source message deleted by author.' });
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
  // With ignoreSelf:false (needed so the conversation tap sees miniOG's own
  // replies), the bot's own status reactions (:eyes:, :white_check_mark:, …)
  // now arrive here too — they are not user feedback; drop them.
  if (event.userId === config.botUserId) {
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

/**
 * Queue an event. Resolves once the queue has moved on, which may be before
 * this event's turn when every slot is taken; `untilProcessed` waits for this
 * event itself to be processed (catch-up runs a thread's events in order).
 */
async function enqueueSlackEvent(
  event: SlackEventEnvelope,
  client: WebClient,
  source: 'socket' | 'catchup' | 'launchpad',
  opts: { untilProcessed?: boolean } = {},
): Promise<void> {
  // A stop must not wait in the queue behind the job it is meant to stop.
  if (source !== 'launchpad' && (await tryHandleStopControl(event, client))) {
    return;
  }
  const item: (typeof queue)[number] = { event, client };
  const processed = opts.untilProcessed
    ? new Promise<void>(resolve => {
        item.processed = resolve;
      })
    : undefined;
  queue.push(item);
  logger.info({ queueDepth: queue.length, eventId: event.eventId, source }, 'event queued for processing');
  await processNext();
  await processed;
}

/** Stop messages already acted on. Slack delivers one message as both `app_mention` and `message`. */
const handledStopMessages = new Set<string>();

/**
 * "@miniOG stop" in a thread with a running job cancels that job at once
 * (issue #435). It used to be dropped by the same-thread lock, or queued
 * behind the job and answered "nothing's running" once it had finished.
 * Returns true when the event was a stop and must not be queued.
 */
async function tryHandleStopControl(event: SlackEventEnvelope, client: WebClient): Promise<boolean> {
  if (event.messageSubtype) return false;
  const active = activeJobForThread(event.channelId, event.threadTs);
  const decision = decideStop({
    isBotMention: detectMention(event.text, config, event.channelType).type === 'bot',
    text: event.text,
    senderId: event.userId,
    activeJob: active,
    adminUserIds: getAdminUserIds(config),
    ownerUserIds: config.ownerSlackUserIds,
  });
  if (!decision.stop || !active) return false;
  return stopJobFromSlack(
    { jobId: active.jobId, requestedBy: active.requestedBy, channelId: event.channelId, threadTs: event.threadTs },
    { eventId: event.eventId, eventTs: event.eventTs, userId: event.userId },
    client,
  );
}

/**
 * The stop itself, once a stop is known to be allowed: shared by the typed
 * "@miniOG stop" and the Stop button (suggestion 9). True when this call
 * stopped the job or a stop was already under way.
 */
async function stopJobFromSlack(
  active: { jobId: string; requestedBy?: string; channelId: string; threadTs: string },
  by: { eventId: string; eventTs: string; userId: string },
  client: WebClient,
): Promise<boolean> {
  const messageKey = `${active.channelId}:${by.eventTs}`;
  if (handledStopMessages.has(messageKey)) return true;
  handledStopMessages.add(messageKey);
  if (handledStopMessages.size > 500) {
    handledStopMessages.delete(handledStopMessages.values().next().value as string);
  }
  store.recordEvent(by.eventId, active.channelId, active.threadTs);

  const reason = { source: 'slack_stop' as const, message: `Stopped from Slack by <@${by.userId}>.` };
  if (!cancelJob(active.jobId, reason)) {
    // Already stopping: a second "stop" needs no second reply.
    return true;
  }
  store.markJob(active.jobId, 'CANCELLED', { errorMessage: reason.message });
  store.appendJobLog({
    jobId: active.jobId,
    stage: 'job.stopped_from_slack',
    level: 'WARN',
    message: `Stopped from Slack by <@${by.userId}>.`,
    data: { stoppedBy: by.userId, requestedBy: active.requestedBy ?? null, eventTs: by.eventTs },
  });
  logger.info({ jobId: active.jobId, stoppedBy: by.userId, eventId: by.eventId }, 'job stopped from Slack');
  await client.chat
    .postMessage({ channel: active.channelId, thread_ts: active.threadTs, text: 'Stopped.' })
    .catch(() => {});
  return true;
}

async function processNext(): Promise<void> {
  // Nothing queued, or no slot: a job waiting on a person does not hold one,
  // and one coming back from such a wait goes ahead of the queue (issue #434).
  if (queue.length === 0 || !jobSlots.tryAcquire()) {
    return;
  }
  const item = queue.shift()!;

  try {
    await jobSlots.run(() => processEvent(item.event, item.client));
  } finally {
    item.processed?.();
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

  // Conversation live tap: append messages in tracked threads to the
  // conversation store — including miniOG's own replies, edits and deletions,
  // which the job gates below intentionally skip. Runs BEFORE those gates
  // (they are about job creation, not capture) and is internally gated on a
  // single prepared isTracked SELECT, so untracked channels cost ~nothing per
  // message. Never throws.
  captureLiveMessage({ store, config, event });

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
  // A launchpad run is its request: two requests may start from one message.
  const claimKey = event.launchpadRequestId
    ? `launchpad:${event.launchpadRequestId}`
    : `${event.channelId}:${event.eventTs}`;
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

/** How long a launchpad run waits for its thread to free up before it is dropped. */
const LAUNCHPAD_BUSY_WAIT_MS = 2 * 60 * 1000;

/** A run asked for in a Slack thread that hasn't started in this long is dropped at startup. */
const ORIGIN_REQUEST_MAX_AGE_MIN = 30;

/**
 * Closes the launchpad request behind an event that will not start a run.
 * Left QUEUED, it would never finish, and the next sidecar start would run it.
 */
async function closeLaunchpadRequest(
  event: SlackEventEnvelope,
  client: WebClient,
  status: 'SKIPPED' | 'FAILED',
  reason: string,
): Promise<void> {
  if (!event.launchpadRequestId) return;
  const request = store.getLaunchpadRequest(event.launchpadRequestId);
  const takenBack = request ? await takeBackPostedAsk(client, request) : false;
  const posted = request?.answerForJobId ? 'answer' : 'ask';
  store.markLaunchpadRequestFinished({
    id: event.launchpadRequestId,
    status,
    errorMessage: takenBack ? `${reason} The posted ${posted} was taken back.` : reason,
  });
}

async function processEventClaimed(event: SlackEventEnvelope, client: WebClient): Promise<void> {
  // A launchpad run may start from a message an earlier run started from: a
  // re-run from the app does exactly that. Its request id already makes it
  // unique.
  if (event.ingestSource !== 'launchpad' && store.hasJobForEventTs(event.channelId, event.eventTs)) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, eventTs: event.eventTs },
      'duplicate channel/eventTs ignored',
    );
    return;
  }

  // Thread-level dedup: one in-flight job per thread. Asked of the in-process
  // registry, not the jobs table — a time window on jobs.updated_at let the
  // lock lapse under a long job (issue #261).
  const activeThreadJobId = activeJobIdForThread(event.channelId, event.threadTs);
  if (activeThreadJobId) {
    // A run started from the app just after a stop, or as a run finishes,
    // finds the thread still held while that run cleans up: it waits its
    // turn for a little while before giving up.
    const request = event.launchpadRequestId ? store.getLaunchpadRequest(event.launchpadRequestId) : undefined;
    if (request && Date.now() - Date.parse(request.createdAt) < LAUNCHPAD_BUSY_WAIT_MS) {
      store.requeueLaunchpadRequest(request.id);
      logger.info(
        { eventId: event.eventId, requestId: request.id, activeJobId: activeThreadJobId },
        'launchpad request waits for its thread',
      );
      return;
    }
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      {
        eventId: event.eventId,
        channelId: event.channelId,
        threadTs: event.threadTs,
        activeJobId: activeThreadJobId,
      },
      'skipped: thread already has an active job',
    );
    await closeLaunchpadRequest(event, client, 'SKIPPED', 'miniOG is already working in this thread.');
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
  // An answer from the app picks up the paused run it was written for, and
  // nothing else.
  if (event.answersJobId && pausedJob?.id !== event.answersJobId) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      { eventId: event.eventId, answersJobId: event.answersJobId, pausedJobId: pausedJob?.id ?? null },
      'answer from the app skipped: its run no longer waits',
    );
    await closeLaunchpadRequest(event, client, 'SKIPPED', "That run isn't waiting for an answer anymore.");
    return;
  }
  // Any other run started from the app is never the answer to a question
  // miniOG asked.
  if (pausedJob && event.launchpadRequestId && !event.answersJobId) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      { eventId: event.eventId, pausedJobId: pausedJob.id },
      'launchpad request skipped: thread awaits an answer',
    );
    await closeLaunchpadRequest(event, client, 'SKIPPED', 'miniOG is waiting for an answer in this thread.');
    return;
  }
  const routeQuestion = pausedJob ? store.pausedRouteQuestion(pausedJob.id) : undefined;
  const pauseSignal = pausedJob
    ? store.isPausedAwaitingPrUrl(pausedJob.id)
      ? 'pr_review_awaiting_url'
      : store.isPausedAwaitingTargetChoice(pausedJob.id)
        ? 'pr_review_target_choice'
        : store.isPausedAwaitingUsageLimitRetry(pausedJob.id)
          ? 'usage_limit_retry'
          : routeQuestion
            ? 'route_clarify'
            : undefined
    : undefined;
  const resumeDecision = decidePausedResume({
    pausedJob: pausedJob ? { id: pausedJob.id, workflow: pausedJob.workflow } : undefined,
    pauseSignal,
    eventText: event.text ?? '',
    routeQuestion,
    senderId: event.userId,
    answeredFromApp: Boolean(event.answersJobId),
  });

  const eventClient = buildEventAwareClient(client, event, {
    onOrphanPromoted: orphan => cancelForOrphanedReply(event, orphan),
  });

  // A message that only tags an owner is written to a person. Until the
  // router decides miniOG has something to say or do, it leaves no reaction
  // and no status line on it (issue #398). A reply that answers a question
  // miniOG asked is addressed to miniOG.
  const quietUntilEngaged =
    isOwnerTagDelegationEnabled() &&
    !resumeDecision.resume &&
    detectMention(event.text ?? '', config, event.channelType).type === 'owner';
  let engaged = !quietUntilEngaged;

  // Add :eyes: reaction to signal processing has started
  if (engaged) {
    await addReaction(client, event.channelId, event.eventTs, 'eyes');
  }

  logger.info({ eventId: event.eventId }, 'fetching thread context for intake');
  const threadMessages = await fetchThreadContext(eventClient, event.channelId, event.threadTs).catch(() => []);
  const threadTexts = threadMessages.map(message => message.text);
  logger.info({ eventId: event.eventId, messages: threadMessages.length }, 'thread context fetched for intake');
  let task = {
    ...normalizeTask(event, config, threadTexts),
    threadMessages,
  };

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
      // The reply to a question miniOG asked: the router reads the two together (issue #431).
      ...((resumeDecision.reason === 'route_clarify_answer' || resumeDecision.reason === 'watchtower_answer') &&
      routeQuestion
        ? { clarification: { question: routeQuestion.question, askedText: routeQuestion.askedText } }
        : {}),
      // A question asked on an owner's authority is answered on it too (issue #398).
      ...(resumeDecision.reason === 'route_clarify_answer' && routeQuestion?.delegatedByOwnerId
        ? { inheritedDelegationOwnerId: routeQuestion.delegatedByOwnerId }
        : {}),
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
    await closeLaunchpadRequest(event, client, 'SKIPPED', 'miniOG did not see a request in it.');
    return;
  }

  // Conversation capture (intake path): the mention makes this a miniOG
  // thread — persist the transcript we already fetched, registering the
  // thread as tracked so the live tap picks up everything that follows.
  // Placed AFTER the mention gate on purpose: capture-all means all miniOG
  // threads, not every thread in every channel. Synthetic envelopes (slash
  // commands, shortcuts, reaction-resume, launchpad) are skipped — their
  // threadTs/eventTs are not real Slack messages. Fire-and-forget — capture
  // must never delay or fail the job.
  if (!isSyntheticEnvelope(event)) {
    void captureThreadFromMessages({
      client: eventClient,
      store,
      config,
      channelId: event.channelId,
      threadTs: event.threadTs,
      channelType: event.channelType,
      messages: threadMessages,
    }).catch(error =>
      logger.warn({ eventId: event.eventId, error: String(error) }, 'intake conversation capture failed'),
    );
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
    await closeLaunchpadRequest(event, client, 'FAILED', policyDecision.reason);
    return;
  }

  const key = dedupeKey(event, task.intent);
  store.recordEvent(event.eventId, event.channelId, event.threadTs);

  const jobId = uuidv4();
  store.createJob({
    id: jobId,
    eventId: event.eventId,
    dedupeKey: key,
    workflow: task.intent,
    channelId: event.channelId,
    threadTs: event.threadTs,
    payload: {
      text: event.text,
      requestUserId: event.userId,
      // Who the run is for, when someone asked for it on their behalf (`requesterOf`).
      requestedForUserId: event.requestedForUserId ?? null,
      mentionType: task.mentionType,
      intent: task.intent,
      eventTs: event.eventTs,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
    },
  });

  const abortController = new AbortController();
  registerActiveJob(jobId, abortController, {
    channelId: event.channelId,
    threadTs: event.threadTs,
    requestedBy: event.userId,
  });

  const stepLogs: WorkflowStepLog[] = [];

  // `status` is declared below but referenced inside logStep: the two are
  // mutually dependent (logStep drives the status line; the status module
  // reports its own failures back through logStep). Safe because
  // createThreadStatus never invokes logStep synchronously, so `status` is
  // always initialized before any logStep call can read it.
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
      workflow: task.intent,
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

    // Drive the Slack status line. Wrapped because status is decoration: a
    // narration bug must never break logging or abort a job.
    try {
      const narrated = narrateStep(step);
      if (narrated && status && engaged) {
        status.set(narrated.text);
        // Human-wait gates idle for hours; stop refreshing so the status
        // expires on its own instead of being pinned.
        if (narrated.suspend) status.suspend();
      }
    } catch (error) {
      logger.warn({ jobId, stage: step.stage, error: String(error) }, 'status narration failed');
    }
  };

  // Live "miniOG is …" thread status. Every workflow lights up for free:
  // logStep is the one choke point all ~200 stages — and the CLI tool events
  // from the stream decoder — flow through.
  const status: ThreadStatus = createThreadStatus({
    slack: client,
    channelId: event.channelId,
    threadTs: event.threadTs,
    logStep,
  });
  if (engaged) status.set('is getting started…');
  // Called by the router right before miniOG says or runs anything.
  const onEngage = async (): Promise<void> => {
    if (engaged) return;
    engaged = true;
    await addReaction(client, event.channelId, event.eventTs, 'eyes');
    status.set('is getting started…');
  };

  logStep({
    stage: 'job.created',
    message: 'Created job record for tagged message.',
    data: {
      dedupeKey: key,
      mentionType: task.mentionType,
      intent: task.intent,
      threadMessages: threadMessages.length,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
      ...sidecarBuild,
    },
  });

  markLaunchpadJobCreated({
    event,
    jobId,
    store,
    logStep,
  });

  // A cancel from the desktop app is silent in Slack otherwise; whoever
  // deleted the source message needs no reply.
  const postCancelNote = async (source: string | undefined): Promise<void> => {
    if (source !== 'ui') return;
    await eventClient.chat
      .postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text: 'Stopped — this run was cancelled from the Watchtower app.',
      })
      .catch(() => {});
  };

  // An abort that surfaces as an exception is still a cancel (issue #438): no
  // failure copy, no diagnosis, no desktop failure alert, and the job stays
  // CANCELLED instead of being overwritten with FAILED.
  const finalizeCancelledJob = async (detail: string): Promise<void> => {
    const cancelReason = takeCancelReason(jobId);
    logStep({
      stage: 'job.cancelled',
      message: 'Run was cancelled — recording CANCELLED, not a failure.',
      level: 'WARN',
      data: { detail, cancelSource: cancelReason?.source },
    });
    await cleanupThreadWorkspaces(event.threadTs);
    unregisterActiveJob(jobId);
    failLaunchpadWorkflow({ event, errorMessage: 'Cancelled.', store, logStep });
    store.markJob(jobId, 'CANCELLED', { errorMessage: cancelReason?.message ?? 'Cancelled.' });
    await postCancelNote(cancelReason?.source);
    if (engaged) {
      await removeReaction(client, event.channelId, event.eventTs, 'eyes');
      await addReaction(client, event.channelId, event.eventTs, 'x');
    }
  };

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
        if (reloadBundlesIfChanged(config, store)) {
          logger.info({ bundleCount: config.bundles?.length ?? 0 }, 'reloaded bundles after access cache signal');
        }

        const workflowResult = await agentCallContext.run({ jobId, store }, () =>
          routeTask({
            task,
            config,
            slack: eventClient,
            store,
            jobId,
            logStep,
            signal: abortController.signal,
            onEngage,
          }),
        );
        // An aborted run is cancelled, whatever the workflow made of its dead
        // agent (issue #438). Settled before the diagnosis and the status write
        // below, which used to report it as a failed job with a "timeout".
        const result = settleAbortedResult(workflowResult, abortController.signal.aborted);
        const cancelReason = abortController.signal.aborted ? takeCancelReason(jobId) : undefined;
        if (result !== workflowResult) {
          logStep({
            stage: 'job.cancelled',
            message: 'Run was cancelled — recording CANCELLED, not the workflow failure.',
            level: 'WARN',
            data: {
              workflowStatus: workflowResult.status,
              workflowMessage: workflowResult.message,
              cancelSource: cancelReason?.source,
            },
          });
        }
        const hasPrInResult =
          result.result?.prUrl && typeof result.result.prUrl === 'string' && result.result.prUrl !== '';
        const diagnosis =
          result.status === 'FAILED' && !hasPrInResult
            ? diagnoseFailure({
                workflow: task.intent,
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
        const executedWorkflow = result.workflow !== task.intent ? result.workflow : undefined;
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
          store.markJob(jobId, 'CANCELLED', {
            // Keep who cancelled it; markJob would otherwise blank the reason.
            errorMessage: cancelReason?.message,
            result: result.result,
            executedWorkflow,
          });
          await postCancelNote(cancelReason?.source);
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
          const productKey = isMemoryWorthyWorkflow(task.intent)
            ? (classifyProduct([event.text ?? '', result.message ?? '', JSON.stringify(result.result ?? {})])
                .selected ?? undefined)
            : undefined;
          store.recordLearningSignal({
            jobId,
            eventId: event.eventId,
            channelId: event.channelId,
            userId: event.userId,
            workflow: task.intent,
            intent: task.intent,
            status: result.status,
            errorKind: diagnosis?.errorKind,
            personalityMode,
            repo: repoName,
            product: productKey,
          });
          if (isMemoryWorthyWorkflow(task.intent) && result.message) {
            const prUrl =
              typeof result.result?.prUrl === 'string' && result.result.prUrl ? result.result.prUrl : undefined;
            store.dossierStore().recordMemory({
              userId: event.userId,
              jobId,
              workflow: task.intent,
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

        // A run that succeeded with an open PR is still matched against the
        // same ask sent again for a few minutes (issue #602); anything else is forgotten.
        finishWork(jobId, {
          status: result.status,
          prUrl: hasPrInResult ? String(result.result?.prUrl) : undefined,
          prState: typeof result.result?.prState === 'string' ? result.result.prState : undefined,
        });
        unregisterActiveJob(jobId);

        // Swap :eyes: for outcome reaction. PAUSED gets a distinct emoji so a
        // glance at the thread tells you "parked, mention me to resume" rather
        // than the misleading :x: it used to share with cancelled/failed jobs.
        // A conversation between people miniOG stayed out of gets nothing.
        if (engaged) {
          await removeReaction(client, event.channelId, event.eventTs, 'eyes');
          const outcomeReaction =
            result.status === 'SUCCESS' || result.status === 'SKIPPED'
              ? 'white_check_mark'
              : result.status === 'PAUSED'
                ? 'zzz'
                : 'x';
          await addReaction(client, event.channelId, event.eventTs, outcomeReaction);
        }

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
        if (abortController.signal.aborted || !transient || attempt >= 3) {
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

    if (abortController.signal.aborted) {
      await finalizeCancelledJob(String(lastError));
      return;
    }

    // No worktree (issue #611) says so in its own words: retries don't explain it.
    const errorMessage =
      lastError instanceof WorkspaceSetupError
        ? lastError.message
        : `Workflow failed after retries: ${String(lastError)}`;
    const diagnosis = diagnoseFailure({
      workflow: task.intent,
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

    // Not into a conversation between people miniOG never spoke in.
    if (engaged) {
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
    }

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
    if (engaged) {
      await removeReaction(client, event.channelId, event.eventTs, 'eyes');
      await addReaction(client, event.channelId, event.eventTs, 'x');
    }

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(task.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: task.intent,
        intent: task.intent,
        status: 'FAILED',
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(task.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: task.intent,
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
    if (abortController.signal.aborted) {
      await finalizeCancelledJob(errorMessage);
      return;
    }
    const diagnosis = diagnoseFailure({
      workflow: task.intent,
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
    if (engaged) {
      await removeReaction(client, event.channelId, event.eventTs, 'eyes');
      await addReaction(client, event.channelId, event.eventTs, 'x');
    }

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(task.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: task.intent,
        intent: task.intent,
        status: 'FAILED',
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(task.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: task.intent,
          status: 'FAILED',
          product: productKey,
          summary: `Failed: ${errorMessage.slice(0, 280)}`,
        });
      }
      store.dossierStore().invalidate(event.userId);
    } catch {
      // ignore persistence failures in terminal error path
    }
  } finally {
    // The same-thread lock lives in this process (issue #261), so it must be
    // released on every way out, including a throw inside the handlers above.
    // Idempotent: the normal paths have already unregistered.
    unregisterActiveJob(jobId);

    // Slack clears the status automatically whenever miniOG posts a message,
    // but SKIPPED jobs can end without ever posting — clear explicitly so the
    // thread does not keep showing "miniOG is …" after the job is done.
    // dispose() then releases the keepalive timer, which would otherwise hold a
    // reference to the client and the job for the life of the sidecar.
    await status.clear();
    status.dispose();
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs, ...sidecarBuild }, 'watchtower sidecar starting');
  // Where agents' shell commands may read and write (issue #445).
  configureAgentSandbox({
    miniOgRepoRoot: config.miniOgRepoRoot,
    repoPaths: enabledRepoPaths(config).map(repo => repo.path),
    appDataDir: path.dirname(path.resolve(dbPath)),
  });
  await cleanupStaleWorkspaces();
  // Dependency installs a restart left half-deleted (issue #611): gigabytes, so not waited on.
  void sweepDepCache();
  // A lookup's copy of the repos left by a sidecar that stopped mid-lookup (issue #446).
  const sweptLookups = await sweepLookupWorkspaces(config);
  if (sweptLookups > 0) logger.info({ sweptLookups }, 'removed lookup workspaces left by an earlier run');

  // An older bundle starting after a newer one is how two builds ended up
  // serving the same Slack app (issue #450). The lock stops them overlapping;
  // this makes a rollback-by-accident visible.
  const lastAppVersion = store.getState('last_app_version');
  if (lastAppVersion && isOlderVersion(sidecarBuild.appVersion, lastAppVersion)) {
    logger.warn({ lastAppVersion, ...sidecarBuild }, 'this build is older than the one that last used this database');
    notifyDesktop(
      'Older Watchtower build started',
      `Running ${sidecarBuild.appVersion}, but ${lastAppVersion} last used this database. Quit this copy unless that is intended.`,
    );
  } else if (sidecarBuild.appVersion !== 'dev') {
    store.setState('last_app_version', sidecarBuild.appVersion);
  }

  // A connector that needs signing in again left requesters blocked until the
  // owner happened to notice (issue #593). The first run to find one tells the
  // owner, on the desktop and by DM, once until it is connected again.
  const connectorAlertClient = config.slackBotToken ? new WebClient(config.slackBotToken) : undefined;
  onConnectorStatuses((statuses, jobId) => {
    for (const connector of connectorsToAlert(statuses, store)) {
      const text = connectorAlertText(connector, jobId);
      logger.warn({ connector, jobId }, 'a connector runs need is not usable; telling the owner');
      notifyDesktop('A connector needs attention', text);
      for (const ownerId of config.ownerSlackUserIds) {
        void connectorAlertClient?.chat
          .postMessage({ channel: ownerId, text })
          .catch(err => logger.warn({ connector, err: String(err) }, 'could not DM the owner about a connector'));
      }
    }
  });

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

  // Conversation-thread synthesizer: turns quiet captured threads into a
  // durable title/TL;DR/decisions. Same cost discipline as the profile
  // synthesizer (idle + delta + interval gates, light tier, concurrency 2).
  startThreadSynthesizerScheduler(store);

  // Jobs the previous process was running or holding for a person. Read
  // before the cleanup below fails them; every thread is told after, and a PR
  // review is run again (issues #436, #589).
  const lostAtRestart = store.listRunningJobsWithLastStage().map(job => ({ ...job, recovery: recoveryFor(job) }));

  // Mark any leftover RUNNING jobs as FAILED — their processes are gone after restart
  const orphaned = store.cleanupOrphanedRunningJobs();
  if (orphaned > 0) {
    logger.warn({ orphaned }, 'cleaned up orphaned RUNNING jobs from previous session');
  }

  // A plan awaiting approval (#436) and a review mid-run (#589) used to
  // vanish on a restart without a word. Best effort, never blocks startup.
  if (lostAtRestart.length > 0 && config.slackBotToken) {
    const noticeClient = new WebClient(config.slackBotToken);
    for (const job of lostAtRestart) {
      const { notice, kind, requeue, closeDeployOffer } = job.recovery;
      // The offer's message would still read as open: it is closed now (issue #703).
      if (closeDeployOffer) {
        void closeDeployOfferAfterRestart(noticeClient, {
          channelId: job.channelId,
          threadTs: job.threadTs,
          promptTs: closeDeployOffer.promptTs,
        });
      }
      void noticeClient.chat
        .postMessage({ channel: job.channelId, thread_ts: job.threadTs, text: notice })
        .then(() =>
          store.appendJobLog({
            jobId: job.id,
            stage: 'job.restart_notice',
            level: 'WARN',
            message: `Told the thread the job was lost to a restart (${kind}).`,
            data: { kind, lastStage: job.lastStage, workflow: job.workflow },
          }),
        )
        .catch(err => logger.warn({ jobId: job.id, err: String(err) }, 'restart notice failed'));
      if (requeue) {
        // After startup settles: the queue, slots and connectors are set up below.
        setTimeout(() => {
          void enqueueSlackEvent(requeue, noticeClient, 'catchup').catch(err =>
            logger.warn({ jobId: job.id, err: String(err) }, 'could not re-run the review lost to a restart'),
          );
        }, RESTART_RERUN_DELAY_MS);
      }
    }
  }

  // No gate waits on a person yet: the jobs that did ended with the last sidecar.
  store.clearHumanWaits();

  // Revert launchpad requests stranded in CLAIMED/QUEUED back to PENDING so
  // the intake poller picks them up again. Without this, a sidecar crash
  // between claim and job-link leaves the desktop-originated request
  // silently never executing and never recovering.
  // Their posted asks are taken back once the Slack client is up.
  const expiredLaunchpad = store.expireStaleOriginLaunchpadRequests(ORIGIN_REQUEST_MAX_AGE_MIN);
  if (expiredLaunchpad.length > 0) {
    logger.warn({ expiredLaunchpad: expiredLaunchpad.length }, 'dropped thread launchpad requests that never started');
  }
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

  // The Slack socket stays dead for hours after a sleep unless something
  // restarts it (issue #587); after a gap, catch-up sweeps thread replies too.
  const catchup: { current?: MentionCatchup } = {};
  const socketAlertText = (alert: SocketAlert): string =>
    alert.reason === 'missed_event'
      ? `My Slack connection had gone quiet: a mention in <#${alert.channelId}> only reached me through catch-up. I've reconnected and I'm looking through recent threads for anything else I missed.`
      : "I've lost my Slack connection and can't get it back yet. I'll keep trying; anything sent to me meanwhile waits until then.";
  const socketWatchdog = new SocketWatchdog({
    reconnect: () => client.restart(),
    onGap: since => catchup.current?.sweepThreadsSince(since),
    alert: async alert => {
      const text = socketAlertText(alert);
      notifyDesktop('Slack connection', text);
      for (const ownerId of config.ownerSlackUserIds) {
        await client.webClient.chat
          .postMessage({ channel: ownerId, text })
          .catch(err => logger.warn({ err: String(err) }, 'could not DM the owner about the Slack connection'));
      }
    },
  });

  const client = new SocketSlackClient(
    config,
    async (event, webClient) => {
      socketWatchdog.noteDelivered(event.channelId, event.eventTs);
      await enqueueSlackEvent(event, webClient as WebClient, 'socket');
    },
    async (event, webClient) => {
      await processReactionFeedback(event, webClient as WebClient);
    },
    state => (state === 'connected' ? socketWatchdog.markConnected() : socketWatchdog.markDisconnected()),
  );
  for (const request of expiredLaunchpad) void takeBackPostedAsk(client.webClient, request);

  process.on('SIGINT', () => {
    logger.info('received SIGINT');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    stopThreadSynthesizerScheduler();
    stopThreadSweeper();
    shutdownGithubPublisher();
    store.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('received SIGTERM');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    stopThreadSynthesizerScheduler();
    stopThreadSweeper();
    shutdownGithubPublisher();
    store.close();
    process.exit(0);
  });

  // Buttons on the gates (suggestion 9) stay off until the Slack app has
  // Interactivity enabled; the operator flips `slack_buttons` to `on` then.
  // A Stop click takes the stop lane, like "@miniOG stop", so it works at any
  // point in a job; when no job is running it is kept for a polling gate.
  configureButtons({
    isEnabled: () => store.getState('slack_buttons') === 'on',
    onStopClick: async click => {
      const active = activeJobForThread(click.channelId, click.threadTs);
      const decision = decideStop({
        isBotMention: true,
        text: 'stop',
        senderId: click.userId,
        activeJob: active,
        adminUserIds: getAdminUserIds(config),
        ownerUserIds: config.ownerSlackUserIds,
      });
      if (!decision.stop || !active) return false;
      return stopJobFromSlack(
        { jobId: active.jobId, requestedBy: active.requestedBy, channelId: click.channelId, threadTs: click.threadTs },
        { eventId: `button:${click.channelId}:${click.actionTs}`, eventTs: click.actionTs, userId: click.userId },
        client.webClient,
      );
    },
    hasListener: click => Boolean(activeJobForThread(click.channelId, click.threadTs)),
    onOrphanClick: async click => {
      await client.webClient.chat.postEphemeral({
        channel: click.channelId,
        user: click.userId,
        thread_ts: click.threadTs,
        text: 'That prompt has ended; nothing is waiting on it any more.',
      });
    },
  });
  await client.start();
  socketWatchdog.start();
  logger.info('autonomous feed/digest/incident posting disabled; mention-triggered replies only');

  // Bundles list people directly now; copy in the people of the Slack user
  // groups they used to read, once, trying again while Slack cannot be read.
  const copyAccessGroupMembers = async (): Promise<void> => {
    let pending = true;
    try {
      const result = await copySlackGroupMembers({ store, slack: client.webClient });
      if (result.copied.length > 0) {
        config.bundles = hydrateBundleUserIds(store.getBundles(), config.ownerSlackUserIds);
      }
      pending = result.pending.length > 0;
    } catch (error) {
      logger.warn({ error: String(error) }, 'access: copying Slack user group members failed; trying again later');
    }
    if (pending) {
      setTimeout(() => void copyAccessGroupMembers(), 30 * 60 * 1000);
    }
  };
  await copyAccessGroupMembers();

  // Say which features the installed token cannot serve, once per change
  // rather than one failed request at a time (issue #433). Rechecked so a
  // reinstall is picked up without a restart.
  const checkBotScopes = async () => {
    const status = await botScopes.refresh(client.webClient);
    if (!status) {
      return;
    }
    const missing = status.missing.map(feature => feature.scope);
    if (missing.length === 0) {
      if (store.getState(NOTIFIED_MISSING_SCOPES_KEY)) {
        logger.info('slack bot token now carries every scope the sidecar checks for');
        store.setState(NOTIFIED_MISSING_SCOPES_KEY, '');
      }
      return;
    }
    logger.warn(
      { missing, granted: status.granted },
      'slack bot token is missing scopes; reinstall the app to grant them',
    );
    const notice = missingScopesNotice(status, store.getState(NOTIFIED_MISSING_SCOPES_KEY));
    if (notice) {
      notifyDesktop(notice.title, notice.body);
      store.setState(NOTIFIED_MISSING_SCOPES_KEY, notice.fingerprint);
    }
  };
  void checkBotScopes();
  setInterval(() => void checkBotScopes(), 10 * 60 * 1000);

  // Once a day, in the 10 o'clock hour, each PR miniOG opened and nobody has
  // closed gets one line in its thread: age, review state, conflicts, who it
  // waits on (issue #603). Kill switch: WATCHTOWER_PR_FOLLOWUP=0.
  const PR_FOLLOWUP_LAST_RUN_KEY = 'pr_followup:last_run';
  const prFollowUpTick = async (): Promise<void> => {
    if (process.env.WATCHTOWER_PR_FOLLOWUP === '0') return;
    const now = new Date();
    // From 10 until the evening: a host asleep at 10 catches up on the next tick.
    if (now.getHours() < 10 || now.getHours() >= 19) return;
    const dateKey = localDateKey(now);
    if (store.getState(PR_FOLLOWUP_LAST_RUN_KEY) === dateKey) return;
    try {
      const summary = await runPrFollowUp({
        store,
        slack: client.webClient,
        githubToken: await resolveGithubTokenForCodex(),
        botMention: `<@${config.botUserId}>`,
        dateKey,
      });
      // Marked done only after a pass ran; a pass that threw is retried next tick.
      store.setState(PR_FOLLOWUP_LAST_RUN_KEY, dateKey);
      logger.info(summary, 'pr follow-up: daily pass done');
    } catch (error) {
      logger.warn({ error: String(error) }, 'pr follow-up: daily pass failed');
    }
  };
  void prFollowUpTick();
  setInterval(() => void prFollowUpTick(), 10 * 60 * 1000);

  // Poll for cancel requests from the Watchtower UI (written to SQLite by Tauri)
  setInterval(() => {
    const pendingIds = store.popPendingCancels();
    for (const jobId of pendingIds) {
      const cancelled = cancelJob(jobId, { source: 'ui', message: 'Cancelled from Watchtower UI.' });
      if (cancelled) {
        store.markJob(jobId, 'CANCELLED', { errorMessage: 'Cancelled from Watchtower UI.' });
        logger.info({ jobId }, 'job cancelled from UI');
      } else if (store.getJobSummary(jobId)?.status === 'PAUSED') {
        // A run waiting on a person has no process to abort: closing it is
        // the stop. Its :zzz: goes, and the thread is told, so nobody answers
        // a question that no longer resumes anything.
        store.markJob(jobId, 'CANCELLED', { errorMessage: 'Cancelled from Watchtower UI.' });
        const anchor = store.eventAnchorFor(jobId);
        if (anchor) void removeReaction(client.webClient, anchor.channelId, anchor.eventTs, 'zzz');
        const origin = store.jobOrigin(jobId);
        if (origin?.launchpadRequestId) {
          store.markLaunchpadRequestFinished({
            id: origin.launchpadRequestId,
            status: 'FAILED',
            errorMessage: 'Cancelled.',
          });
        }
        if (origin) {
          void client.webClient.chat
            .postMessage({
              channel: origin.channelId,
              thread_ts: origin.threadTs,
              text: 'Stopped — this run was cancelled from the Watchtower app.',
            })
            .catch(() => {});
        }
        logger.info({ jobId }, 'paused job cancelled from UI');
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
      // A question nobody answered is not a failure, and it is not worth a
      // day: after 30 minutes the next reply is no longer "the answer" (#431).
      try {
        for (const parked of store.pausedRouteQuestions()) {
          if (!isRouteQuestionExpired(parked.pending, Date.now())) continue;
          store.markJob(parked.id, 'SKIPPED', { result: { reason: 'clarify_unanswered' } });
          const anchor = store.eventAnchorFor(parked.id);
          if (anchor) void removeReaction(client.webClient, anchor.channelId, anchor.eventTs, 'zzz');
          logger.info({ jobId: parked.id }, 'unanswered clarify question expired');
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'clarify-question sweeper tick failed');
      }
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
  // Conversation memory is exempt from the sweep above (it IS the durable
  // org memory). Optional knob: when set (> 0), messages older than the
  // window are pruned from IDLE threads only — thread rows + synthesis
  // always survive. Default 0 = keep forever.
  const conversationRetentionDays = Number(process.env.WATCHTOWER_CONVERSATION_RETENTION_DAYS ?? 0) || 0;
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
      if (conversationRetentionDays > 0) {
        const prunedMessages = store.conversationStore().pruneIdleMessages(conversationRetentionDays);
        if (prunedMessages > 0) {
          logger.info(
            { conversationRetentionDays, prunedMessages },
            'retention sweep pruned idle conversation messages',
          );
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'retention sweep tick failed');
    }
  };
  runRetentionSweep();
  setInterval(runRetentionSweep, 60 * 60 * 1000);

  catchup.current = startMentionCatchup({
    webClient: client.webClient,
    config,
    store,
    deliveredLive: (channelId, ts) => socketWatchdog.wasDelivered(channelId, ts),
    threadActive: (channelId, threadTs) => Boolean(activeJobForThread(channelId, threadTs)),
    // Who may stop a request, as for a live stop (decideStop).
    mayStop: (senderId, requesterId) =>
      senderId === requesterId ||
      getAdminUserIds(config).includes(senderId) ||
      config.ownerSlackUserIds.includes(senderId),
    enqueue: async (event, webClient, source) => {
      // A bot mention only catch-up found is evidence the socket is dead.
      socketWatchdog.noteCatchupRecovery({
        channelId: event.channelId,
        eventTs: event.eventTs,
        mentionType: detectMention(event.text, config).type,
        edited: Boolean((event.rawEvent as { edited?: unknown } | undefined)?.edited),
      });
      await enqueueSlackEvent(event, webClient, source, { untilProcessed: true });
    },
  });

  // Conversation reconciliation sweeper: re-fetches recently-active tracked
  // threads so socket downtime can't leave holes in captured transcripts.
  startThreadSweeper({
    webClient: client.webClient,
    config,
    store,
  });

  // GitHub conversation publisher (M4): mirrors org-visible captured threads
  // into the configured markdown knowledge repo. No-op until enabled via
  // app_settings or WATCHTOWER_GITHUB_EGRESS_* env vars.
  configureGithubPublisher({ store, slack: client.webClient });

  // Historical conversation backfill (M5): operator-triggered, cursor-
  // resumable — set WATCHTOWER_CONVERSATION_BACKFILL=1 and restart until it
  // logs 'complete'. Runs in the background; never blocks event processing.
  if (process.env.WATCHTOWER_CONVERSATION_BACKFILL === '1') {
    void runConversationBackfill({ webClient: client.webClient, config, store }).catch(err =>
      logger.warn({ err: String(err) }, 'conversation backfill failed'),
    );
  }

  const launchpadIntake = {
    webClient: client.webClient,
    config,
    store,
    enqueue: async (event: SlackEventEnvelope, webClient: WebClient) => {
      await enqueueSlackEvent(event, webClient, 'launchpad');
    },
  };
  startLaunchpadRequestPoller(launchpadIntake);
  // Answers from the app's thread view to a run waiting on a person.
  startAppAnswerPoller(launchpadIntake);
}

main().catch(error => {
  logger.error({ error: String(error) }, 'watchtower sidecar crashed');
  notifyDesktop('Watchtower sidecar crash', String(error));
  process.exit(1);
});
