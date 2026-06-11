import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  NormalizedTask,
  PrContext,
  PrTarget,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { RecallCapableStore } from '../state/dossierStore.js';
import { assertThreadParentExists, fetchThreadContext } from '../slack/threadContext.js';
import { resolvePrReviewTargets } from '../router/prTargetResolver.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildOutOfScopePrReply, mapRepoPath, SUPPORTED_PR_REPOS, fetchPrHeadSha } from '../github/prReviewSupport.js';
import { reviewSinglePr, type PrReviewDeps, type PrReviewOutcome } from './prReviewAgent.js';

export type AgenticPrReviewStore = Pick<JobStore, 'findLatestReviewedPrHeadSha' | 'getChannelPolicyPack'> &
  Partial<PipelineStore> &
  RecallCapableStore;

/**
 * Agentic PR review entry point — replaces the legacy prReviewWorkflow
 * (issue #334). Target selection is fully deterministic
 * (prTargetResolver.ts); each resolved PR is reviewed sequentially by one
 * Claude Code run in its own worktree, with per-PR Slack summaries as each
 * finishes and per-PR failure isolation.
 *
 * Pinned invariants carried over from the legacy workflow:
 * - log stage `pr_review.context.missing` is the pause-resume key
 *   (jobStore.isPausedAwaitingPrUrl) — the no-PR path must log it verbatim;
 * - recall stages `workflow.recall.injected` / `workflow.recall.failed`;
 * - submitPrReview (hunk-validating) is the only GitHub write path.
 */
export async function runAgenticPrReview(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: AgenticPrReviewStore;
  resolvePrHeadSha?: typeof fetchPrHeadSha;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  deps?: Partial<PrReviewDeps>;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, resolvePrHeadSha, jobId: _jobId, logStep, signal } = params;
  const deps: Partial<PrReviewDeps> = {
    ...(resolvePrHeadSha ? { resolveHeadSha: resolvePrHeadSha } : {}),
    ...params.deps,
  };

  const postToThread = async (text: string) => {
    await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text })
      .catch(() => {});
  };

  logStep?.({
    stage: 'agentic.pr_review.start',
    message: 'Agentic PR review starting.',
    data: { userId: task.event.userId, channelId: task.event.channelId },
  });

  // Pre-flight: if the source mention is gone, fetchThreadContext below would
  // throw thread_not_found and the dispatcher would mark this FAILED. The
  // actual cause is benign (user deleted), so short-circuit to CANCELLED.
  const parentAlive = await assertThreadParentExists(slack, task.event.channelId, task.event.threadTs);
  if (!parentAlive) {
    logStep?.({
      stage: 'agentic.pr_review.source_deleted',
      level: 'WARN',
      message: 'Source mention no longer exists — aborting PR review.',
      data: { channelId: task.event.channelId, threadTs: task.event.threadTs },
    });
    return {
      workflow: 'PR_REVIEW',
      status: 'CANCELLED',
      message: 'Source message deleted before PR review ran.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const threadTexts = threadMessages.map(message => message.text);
  const threadContext = threadTexts.join('\n---\n');

  const resolution = resolvePrReviewTargets({
    triggerText: task.event.text ?? '',
    threadTexts,
  });

  logStep?.({
    stage: 'agentic.pr_review.targets.resolved',
    message: `Resolved ${resolution.targets.length} review target(s) via ${resolution.mode}.`,
    data: {
      mode: resolution.mode,
      selector: resolution.selector,
      targets: resolution.targets.map(t => t.url),
      truncated: resolution.truncated?.map(t => t.url),
      candidates: resolution.candidates?.map(t => t.url),
    },
  });

  // No PR anywhere: keep the legacy ask-for-URL pause flow VERBATIM —
  // `pr_review.context.missing` is the stage string isPausedAwaitingPrUrl
  // keys on; the user's bare-URL reply resumes via decidePausedResume.
  if (resolution.mode === 'none') {
    logStep?.({
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `<@${task.event.userId}> drop the GitHub PR URL in this thread and i will pick it up. Format: \`https://github.com/Newton-School/<repo>/pull/<number>\``,
    });

    return {
      workflow: 'PR_REVIEW',
      status: 'PAUSED',
      message: 'Missing PR context; asked for PR URL in thread.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // Several thread PRs and nothing to pick by: never guess (the issue #334
  // incident reviewed the wrong PR twice because first-URL-won). Ask, pause,
  // and resume on a URL or selector reply (pause signal:
  // pr_review_target_choice, keyed on the stage below).
  if (resolution.mode === 'ambiguous') {
    logStep?.({
      stage: 'agentic.pr_review.targets.ambiguous',
      message: 'Multiple PRs in thread and no selector — asking which to review and pausing.',
      level: 'WARN',
      data: { candidates: resolution.candidates?.map(t => t.url), selector: resolution.selector },
    });

    const candidateList = (resolution.candidates ?? []).map(t => `• ${t.repo}#${t.number} — ${t.url}`).join('\n');
    const selectorNote = resolution.selector
      ? `I couldn't match "${resolution.selector}" to any PR in this thread. `
      : '';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${selectorNote}I found ${resolution.candidates?.length ?? 0} PRs in this thread:\n${candidateList}\nReply with the link (or "web"/"api"/"#number") to review, or "both" for all of them.`,
    });

    return {
      workflow: 'PR_REVIEW',
      status: 'PAUSED',
      message: 'Multiple PRs in thread; asked which to review.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // Per-target guards: org allowlist, supported repos, local path mapping.
  // Out-of-scope targets are skipped with a per-PR notice instead of
  // aborting the whole batch.
  const reviewable: Array<{ target: PrTarget; baseRepoPath: string }> = [];
  let outOfScopeNotified = false;
  for (const target of resolution.targets) {
    if (target.owner !== config.allowedPrOrg) {
      logStep?.({
        stage: 'agentic.pr_review.guard.org_rejected',
        message: `PR org ${target.owner} is not allowed by policy.`,
        level: 'WARN',
        data: { prUrl: target.url, allowedOrg: config.allowedPrOrg },
      });
      if (!outOfScopeNotified) {
        await postToThread(buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg));
        outOfScopeNotified = true;
      }
      continue;
    }
    if (!SUPPORTED_PR_REPOS.includes(target.repo as (typeof SUPPORTED_PR_REPOS)[number])) {
      logStep?.({
        stage: 'agentic.pr_review.guard.repo_out_of_scope',
        message: `PR repo ${target.repo} is outside supported review scope.`,
        level: 'WARN',
        data: { prUrl: target.url, supportedRepos: [...SUPPORTED_PR_REPOS] },
      });
      if (!outOfScopeNotified) {
        await postToThread(buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg));
        outOfScopeNotified = true;
      }
      continue;
    }
    const baseRepoPath = mapRepoPath(config, target as PrContext);
    if (!baseRepoPath) {
      logStep?.({
        stage: 'agentic.pr_review.guard.repo_unmapped',
        message: `PR repo ${target.repo} is not mapped to a configured local path.`,
        level: 'WARN',
        data: { prUrl: target.url },
      });
      notifyDesktop(
        'Watchtower unmapped PR repo',
        `No local repo mapping for ${target.owner}/${target.repo}; skipping auto execution.`,
      );
      continue;
    }
    reviewable.push({ target, baseRepoPath });
  }

  if (reviewable.length === 0) {
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'No reviewable PR targets after scope guards; informed requester in thread.',
      notifyDesktop: false,
      slackPosted: outOfScopeNotified,
    };
  }

  const githubToken = await resolveGithubTokenForCodex();

  // Recall assembled once per job and prepended to every per-PR prompt —
  // same stage names as every other workflow (dossier invariant).
  let recallBlock = '';
  if (store?.dossierStore && store.recentSignalsForUser && task.event.userId) {
    try {
      const recall = await assembleRecall({
        userId: task.event.userId,
        workflow: 'PR_REVIEW',
        store: store as unknown as JobStore,
        vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
      });
      if (recall.promptBlock) {
        recallBlock = `${recall.promptBlock}\n\n`;
        logStep?.({
          stage: 'workflow.recall.injected',
          message: `Injected recall (${recall.estimatedTokens} tokens, ${recall.sources.join(',')}).`,
          data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens, workflow: 'PR_REVIEW' },
        });
      }
    } catch (err) {
      logStep?.({
        stage: 'workflow.recall.failed',
        level: 'WARN',
        message: 'recall assembly failed; running without it',
        data: { error: (err as Error).message, workflow: 'PR_REVIEW' },
      });
    }
  }

  const policyPack = store?.getChannelPolicyPack?.(task.event.channelId);
  const policyBlock = policyPack
    ? [`Active policy pack: ${policyPack.packName}`, ...policyPack.rules.map(rule => `- ${rule}`)].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  // Single ack. Single-PR keeps the message users know; multi-PR lists the
  // batch (and names anything dropped by the target cap — never silent).
  const truncationNote =
    resolution.truncated && resolution.truncated.length > 0
      ? ` (capped at ${resolution.targets.length} — skipping ${resolution.truncated.map(t => `${t.repo}#${t.number}`).join(', ')}; re-trigger for those separately)`
      : '';
  await postToThread(
    reviewable.length === 1
      ? 'PR review in progress. I will drop findings here shortly.'
      : `Reviewing ${reviewable.length} PRs: ${reviewable.map(r => `${r.target.repo}#${r.target.number}`).join(', ')}${truncationNote} — posting each verdict here as it finishes.`,
  );
  logStep?.({
    stage: 'agentic.pr_review.ack_posted',
    message: `Posted review acknowledgement for ${reviewable.length} PR(s).`,
    data: { prUrls: reviewable.map(r => r.target.url) },
  });

  // Sequential per-PR reviews with failure isolation.
  const outcomes: PrReviewOutcome[] = [];
  for (const [index, { target, baseRepoPath }] of reviewable.entries()) {
    if (signal?.aborted) break;

    logStep?.({
      stage: 'agentic.pr_review.pr.start',
      message: `Reviewing ${target.repo}#${target.number} (${index + 1}/${reviewable.length}).`,
      data: { prUrl: target.url, index: index + 1, total: reviewable.length },
    });

    const previousReview = store?.findLatestReviewedPrHeadSha?.({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      prUrl: target.url,
    });

    const outcome = await reviewSinglePr({
      task,
      config,
      slack,
      prContext: target as PrContext,
      baseRepoPath,
      recallBlock,
      policyBlock,
      threadContext,
      githubToken,
      previousReview,
      deps,
      logStep,
      signal,
    });
    outcomes.push(outcome);
  }

  const failed = outcomes.filter(o => o.status === 'FAILED');
  const aborted = Boolean(signal?.aborted) && outcomes.length < reviewable.length;
  const firstWithSha = outcomes.find(o => o.prHeadSha);

  logStep?.({
    stage: 'agentic.pr_review.done',
    message: `Agentic PR review finished: ${outcomes.length}/${reviewable.length} reviewed, ${failed.length} failed${aborted ? ', aborted mid-batch' : ''}.`,
    data: {
      outcomes: outcomes.map(o => ({ prUrl: o.prUrl, status: o.status, findings: o.totalFindings })),
    },
  });

  // result carries per-PR outcomes (the dedup guard reads them) plus
  // top-level prUrl/prHeadSha for single-PR back-compat consumers.
  const result = {
    outcomes,
    prUrl: outcomes[0]?.prUrl ?? reviewable[0].target.url,
    ...(firstWithSha?.prHeadSha ? { prHeadSha: firstWithSha.prHeadSha } : {}),
  };

  if (aborted) {
    return {
      workflow: 'PR_REVIEW',
      status: 'CANCELLED',
      message: `Review batch aborted after ${outcomes.length}/${reviewable.length} PR(s); completed reviews are recorded.`,
      notifyDesktop: false,
      slackPosted: true,
      result,
    };
  }

  if (failed.length > 0) {
    return {
      workflow: 'PR_REVIEW',
      status: 'FAILED',
      message: `${failed.length}/${outcomes.length} PR review(s) failed: ${failed
        .map(o => `${o.prUrl} — ${o.error ?? 'unknown error'}`)
        .join('; ')}`,
      notifyDesktop: true,
      slackPosted: true,
      result,
    };
  }

  const completed = outcomes.filter(o => o.status === 'SUCCESS');
  const skipped = outcomes.filter(o => o.status === 'SKIPPED');
  // All targets dedup-skipped → SKIPPED, matching the legacy single-PR
  // no-new-changes behavior (reaction + learning semantics unchanged).
  return {
    workflow: 'PR_REVIEW',
    status: completed.length > 0 ? 'SUCCESS' : 'SKIPPED',
    message:
      completed.length > 0
        ? `Reviewed ${completed.length} PR(s)${skipped.length > 0 ? `, ${skipped.length} skipped (no new commits)` : ''}.`
        : 'No new changes since last review.',
    notifyDesktop: false,
    slackPosted: true,
    result,
  };
}
