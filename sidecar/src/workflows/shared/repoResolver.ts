import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowStepLogger } from '../../types/contracts.js';
import { classifyRepo, type RepoAffinity } from '../../router/repoClassifier.js';
import {
  REPO_KEYS,
  enabledRepoKeys,
  enabledRepoPaths,
  isRepoEnabled,
  resolveRepoPath,
  type RepoKey,
} from '../../repos/registry.js';
import { formatAdminMention, getAdminUserIds } from '../../access/control.js';
import { waitForRepoChoice } from '../../agents/pipeline.js';

/** Canonical repo union — re-exported so the ~6 importers keep compiling. */
export type RepoName = RepoKey;
export type RepoResolution =
  | { outcome: 'resolved'; name: RepoName; path: string; source: ResolutionSource }
  | { outcome: 'desktop_only'; reason: string }
  | { outcome: 'cancelled' };

export type ResolutionSource = 'plan-affected-files' | 'classifier' | 'admin-choice';

/** The one-word reply we suggest for each repo in the admin clarify prompt. */
const REPO_SHORT_REPLY: Record<RepoKey, string> = {
  'newton-web': 'web',
  'newton-api': 'api',
  'newton-marketing-web': 'marketing',
};

/**
 * Deterministic fast-path: returns a repo name only when the planner's
 * affected-files list is overwhelmingly unambiguous. This is the cheap
 * pre-check that saves an LLM round-trip when the planner wrote fully-
 * qualified paths in exactly one repo; in every other case we hand the
 * decision to the AI classifier, which is intent-aware and reads the full
 * plan markdown.
 *
 * Rule: ≥2 hits in the chosen repo, ZERO hits in the other. This is a
 * stricter cousin of the pre-#307 logic — it deliberately misses borderline
 * cases on purpose, so they fall through to the LLM. The cost of a false
 * deterministic decision is high (wrong worktree → coder bails), so we
 * favor an extra ~3-5 s of LLM time over silent mis-routing.
 *
 * Failure mode this protects against: Slack thread p1779196094091969
 * (2026-05-19) — a planner output 24 newton-web-relative paths plus a
 * single `newton-api/courses/enums.py` context citation. The any-hit-wins
 * predecessor mis-routed the coder to newton-api with no React files to
 * touch.
 */
export function inferRepoFromAffectedFiles(files: string[]): RepoName | null {
  if (files.length === 0) return null;
  // NOTE: 'newton-marketing-web' does not contain the substring 'newton-web',
  // so these per-key counters cannot cross-contaminate.
  const hits = REPO_KEYS.map(key => ({ key, count: files.filter(f => f.includes(key)).length }));
  const winners = hits.filter(h => h.count >= 2);
  if (winners.length === 1 && hits.every(h => h.key === winners[0].key || h.count === 0)) {
    return winners[0].key;
  }
  return null;
}

export function repoPathFor(name: RepoName, config: AppConfig): string {
  return resolveRepoPath(config, name);
}

/**
 * Read the user's per-repo affinity out of a dossier, covering every known
 * repo. Shared by the two call sites that previously hardcoded the
 * newton-web/newton-api lookups (and silently dropped anything else).
 */
export function readRepoAffinity(dossier: {
  affinity: Array<{ repo: string; hits: number }>;
}): RepoAffinity | undefined {
  const result: RepoAffinity = {};
  let any = false;
  for (const key of REPO_KEYS) {
    const row = dossier.affinity.find(a => a.repo === key);
    if (row && row.hits > 0) {
      result[key] = row.hits;
      any = true;
    }
  }
  return any ? result : undefined;
}

export async function resolveRepoOrAsk(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  threadMessages: Array<{ text: string }>;
  planAffectedFiles?: string[];
  /**
   * Optional. When available (i.e. the planner has already produced its plan
   * for this run), pass the full plan markdown — it carries far more signal
   * than just the affected-files list (the planner explains its reasoning
   * per file, the imports it's referencing, the framework conventions it's
   * following). Lifts the LLM classifier from "guess from filenames" to
   * "weigh the plan author's own reasoning."
   */
  planMarkdown?: string;
  signal?: AbortSignal;
  askAdminsOnUncertain?: boolean;
  /**
   * Optional per-user repo affinity. Passed to the agent as advisory context;
   * the current task always dominates.
   */
  repoAffinity?: RepoAffinity;
}): Promise<RepoResolution> {
  const {
    task,
    config,
    slack,
    logStep,
    threadMessages,
    planAffectedFiles = [],
    planMarkdown,
    signal,
    askAdminsOnUncertain = true,
    repoAffinity,
  } = params;

  // Fast path: the planner already named a path that lives in a known repo.
  // Deterministic substring check on file paths, not classification — calling
  // the agent here would just burn a round-trip.
  const fromFiles = inferRepoFromAffectedFiles(planAffectedFiles);
  if (fromFiles && isRepoEnabled(config, fromFiles)) {
    return resolved(fromFiles, config, 'plan-affected-files');
  }

  const classification = await classifyRepo({
    task: task.event.text,
    threadMessages: threadMessages.map(m => m.text),
    threshold: config.repoClassifierThreshold,
    affinity: repoAffinity,
    planAffectedFiles,
    planMarkdown,
    repoGrepPaths: enabledRepoPaths(config),
    logStep,
  });
  if (!classification.uncertain && classification.selectedRepo && isRepoEnabled(config, classification.selectedRepo)) {
    return resolved(classification.selectedRepo, config, 'classifier');
  }

  // 5. Still uncertain. Either ask admins (if enabled and any configured) or
  //    fall through to desktop-only per AppConfig.uncertainRepoPolicy.
  const adminUserIds = getAdminUserIds(config);
  if (!askAdminsOnUncertain || adminUserIds.length === 0) {
    logStep?.({
      stage: 'workflow.repo.desktop_only',
      message: 'Repo classifier uncertain and no admin gate available — routing to desktop.',
      level: 'WARN',
    });
    return {
      outcome: 'desktop_only',
      reason: adminUserIds.length === 0 ? 'no admins configured' : 'admin gate disabled by caller',
    };
  }

  logStep?.({
    stage: 'workflow.repo.clarify',
    message: 'Target repo is ambiguous — asking admins to clarify.',
    level: 'WARN',
  });

  // Use the core-dev subteam handle when available so we ping the group once
  // instead of unrolling every admin into a wall of individual `<@U…>` tags.
  const mentionStr = formatAdminMention(config);
  const enabled = enabledRepoKeys(config);
  const repoListInline = enabled.map(key => `*${key}*`).join(' / ');
  const replyOptions = enabled.map(key => `"${REPO_SHORT_REPLY[key]}"`).join(' or ');
  const promptText = `I can't tell which repo this task targets — ${repoListInline}.${mentionStr ? ` ${mentionStr}` : ''} Reply with ${replyOptions} (or "cancel" to abandon).`;

  let promptTs: string | undefined;
  try {
    const posted = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: promptText,
    });
    promptTs = posted.ts ?? undefined;
  } catch {
    return {
      outcome: 'desktop_only',
      reason: 'could not post admin clarification prompt to Slack',
    };
  }
  if (!promptTs) {
    return {
      outcome: 'desktop_only',
      reason: 'slack did not return a timestamp for the clarification prompt',
    };
  }

  const choice = await waitForRepoChoice({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    approverUserIds: adminUserIds,
    promptTs,
    logStep: logStep ?? (() => {}),
    botUserId: config.botUserId,
    signal,
    allowedRepos: enabled,
    nudgeText: `Still waiting on an admin to pick ${repoListInline} for this task. Reply here or say 'cancel' to stop.`,
  });

  if (choice.outcome === 'cancelled') {
    return { outcome: 'cancelled' };
  }
  if (choice.outcome === 'timeout') {
    return {
      outcome: 'desktop_only',
      reason: 'no admin reply within idle window',
    };
  }
  if (choice.outcome === 'paused') {
    // Someone said "wait" mid-clarification. Treat as cancellation here — no
    // plan state has been built yet, so resume on the next mention is just a
    // fresh task with full thread context.
    return { outcome: 'cancelled' };
  }

  return resolved(choice.outcome, config, 'admin-choice');
}

function resolved(
  name: RepoName,
  config: AppConfig,
  source: ResolutionSource,
): Extract<RepoResolution, { outcome: 'resolved' }> {
  return {
    outcome: 'resolved',
    name,
    path: repoPathFor(name, config),
    source,
  };
}
