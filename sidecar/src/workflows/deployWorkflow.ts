import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability } from '../access/control.js';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { extractReplyFromCodexResult } from './shared/workflowUtils.js';
import { waitForExactConfirmation } from './shared/confirmationGate.js';
import { confirmationBlocks, postGatePrompt } from '../slack/buttonReplies.js';
import { classifyDeployTarget, mentionsStagingNotProd, namesStagingAsTarget } from '../router/intentParser.js';
import { isRepoEnabled, repoPathOrNull } from '../repos/registry.js';
import { dispatchWorkflowRun, isDeployDryRun, type ActionsRunOutcome } from './shared/githubActionsRun.js';
import { runStagingDeployWorkflow, type StagingDeployStore } from './stagingDeployWorkflow.js';

export { __ghCli, __deployTiming, DEPLOY_DRY_RUN_STATE_KEY } from './shared/githubActionsRun.js';

/** Internal seam — tests stub the wait instead of scripting Slack replies. */
export const __deployConfirm = { wait: waitForExactConfirmation };

export const DEPLOY_CONFIRM_PHRASE = 'confirm deploy';

/**
 * Last gate before anything irreversible (issue #428). Returns undefined once
 * the requester has confirmed; otherwise the result to return, with nothing
 * deployed. The DEPLOY intent is seeded by keywords, so the requester — not
 * the match — decides whether production changes.
 */
async function confirmDeploy(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  targetLabel: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult | undefined> {
  const { task, config, slack, targetLabel, logStep, signal } = params;
  const { channelId, threadTs, userId } = task.event;
  const stop = (status: WorkflowResult['status'], message: string, slackPosted: boolean): WorkflowResult => ({
    workflow: 'DEPLOY',
    status,
    message,
    notifyDesktop: status === 'FAILED',
    slackPosted,
  });

  let promptTs: string | undefined;
  try {
    const confirmText = `Deploy *${targetLabel}* to production? <@${userId}>, reply \`${DEPLOY_CONFIRM_PHRASE}\` within 10 minutes and I'll start. Without that, nothing is deployed.`;
    promptTs = await postGatePrompt(slack, {
      channel: channelId,
      thread_ts: threadTs,
      text: confirmText,
      blocks: () => confirmationBlocks(confirmText, DEPLOY_CONFIRM_PHRASE, 'Confirm deploy'),
    });
  } catch {
    // Handled below: without an anchored prompt there is nothing safe to wait on.
  }
  if (!promptTs) {
    const msg = "Couldn't post the deploy confirmation, so nothing was deployed.";
    logStep?.({ stage: 'deploy.confirm.prompt_failed', message: msg, level: 'ERROR' });
    return stop('FAILED', msg, false);
  }
  logStep?.({
    stage: 'deploy.confirm.asked',
    message: `Asked <@${userId}> to confirm the ${targetLabel} production deploy.`,
    data: { targetLabel, promptTs },
  });

  const confirmation = await __deployConfirm.wait({
    slack,
    channelId,
    threadTs,
    promptTs,
    phrase: DEPLOY_CONFIRM_PHRASE,
    allowedUserIds: [userId],
    botUserId: config.botUserId,
    stagePrefix: 'deploy.confirm',
    logStep,
    signal,
  });
  if (confirmation.outcome === 'confirmed') return undefined;
  if (confirmation.outcome === 'cancelled') return stop('CANCELLED', 'Deploy cancelled before confirmation.', false);

  const msg =
    confirmation.outcome === 'declined'
      ? 'Okay, not deploying.'
      : `No \`${DEPLOY_CONFIRM_PHRASE}\` in 10 minutes, so nothing was deployed. Ask again when you're ready.`;
  const slackPosted = await slack.chat
    .postMessage({ channel: channelId, thread_ts: threadTs, text: msg })
    .then(() => true)
    .catch(() => false);
  return stop('SKIPPED', msg, slackPosted);
}

async function reportDryRun(params: {
  task: NormalizedTask;
  slack: WebClient;
  targetLabel: string;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, slack, targetLabel, logStep } = params;
  const msg = `Dry run: this is where I would deploy *${targetLabel}* to production. Nothing was deployed.`;
  logStep?.({ stage: 'deploy.dry_run', message: msg, level: 'WARN', data: { targetLabel } });
  const slackPosted = await slack.chat
    .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg })
    .then(() => true)
    .catch(() => false);
  return { workflow: 'DEPLOY', status: 'SUCCESS', message: msg, notifyDesktop: false, slackPosted };
}

/**
 * Resolves the deploy-prod skill instructions.
 * Reads from ~/.claude/commands/deploy-prod.md (the Claude Code skill definition).
 */
function loadDeploySkillInstructions(): string | undefined {
  const home = process.env.HOME?.trim() || os.homedir();
  const skillPath = path.join(home, '.claude', 'commands', 'deploy-prod.md');
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    return undefined;
  }
}

function buildDeployPrompt(params: { task: NormalizedTask; skillInstructions: string }): string {
  const { task, skillInstructions } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'DEPLOY', toneMode: task.toneMode })}

You are running a production deployment for newton-web.

Follow the deployment instructions below EXACTLY. Do not deviate or add extra steps.

${skillInstructions}

Output rules:
Your response will be posted to a Slack thread. Write a clean, concise Slack message describing the outcome.
- On success: report the old hash, new hash, commit name, and commit URL.
- On fallback: report what happened and which commit was selected.
- On no-op: say prod is already on the latest.
- On freeze: say "deployment is freezed for now."
- On failure: report the error clearly.

Do NOT include JSON, code fences, or telemetry in your response. Just a clean Slack message.
`.trim();
}

export async function runDeployWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: StagingDeployStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep, signal } = params;

  // Same deterministic classification the intent gate used: a deploy ask
  // naming the marketing site routes to the GitHub Actions flow; everything
  // else is the classic newton-web prod deploy. Never let one mechanism run
  // the other, and never GUESS between them on conflicting signals.
  const target = classifyDeployTarget(task.event.text ?? '');
  if (target === null) {
    // Reached without a deploy target in the message. Assuming newton-web here
    // is how a confirmed marketing deploy could ship the wrong site (#428).
    const msg =
      'I couldn\'t tell what to deploy. Re-ask with the target in the message — e.g. "deploy newton-web to prod" or "deploy marketing to prod".';
    await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg })
      .catch(() => {});
    logStep?.({ stage: 'deploy.no_target', message: msg, level: 'WARN' });
    return { workflow: 'DEPLOY', status: 'SKIPPED', message: msg, notifyDesktop: false, slackPosted: true };
  }
  if (target === 'newton-marketing-web') {
    return runMarketingDeploy(params);
  }
  if (target === 'ambiguous' && isRepoEnabled(config, 'newton-marketing-web')) {
    // Two deployable frontends and the ask doesn't pin one — ask instead of
    // firing a production deploy on a guess. (Without the marketing clone
    // there is only one deployable frontend, so we fall through to the
    // newton-web deploy exactly as before the marketing repo existed.)
    const msg =
      'That deploy ask could mean the *newton-web* app or the *newton-marketing-web* site. Re-ask with the target in the message — e.g. "deploy newton-web to prod" or "deploy marketing to prod".';
    await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg })
      .catch(() => {});
    logStep?.({ stage: 'deploy.ambiguous_target', message: msg, level: 'WARN' });
    return { workflow: 'DEPLOY', status: 'SKIPPED', message: msg, notifyDesktop: false, slackPosted: true };
  }

  logStep?.({
    stage: 'deploy.start',
    message: 'Running deploy workflow for newton-web production.',
  });

  // Belt-and-suspenders capability check. The router (`taskRouter.ts:221`)
  // has already enforced this for the DEPLOY intent before dispatch — this
  // second check guards against any future caller that reaches the workflow
  // without passing through the router (e.g. internal triggers, retries).
  const accessDecision = evaluateCapability({
    config,
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    capability: 'deploy_prod',
  });

  if (!accessDecision.allowed) {
    const msg = accessDecision.reason ?? 'Deploy to production is restricted to admins.';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: msg,
    });
    logStep?.({
      stage: 'deploy.denied',
      message: msg,
      level: 'WARN',
      data: { userId: task.event.userId, denyReason: accessDecision.denyReason },
    });
    return {
      workflow: 'DEPLOY',
      status: 'SKIPPED',
      message: msg,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // Load skill instructions
  const skillInstructions = loadDeploySkillInstructions();
  if (!skillInstructions) {
    const msg = 'Deploy skill not found — missing `~/.claude/commands/deploy-prod.md`.';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: msg,
    });
    logStep?.({
      stage: 'deploy.skill_missing',
      message: msg,
      level: 'ERROR',
    });
    return {
      workflow: 'DEPLOY',
      status: 'FAILED',
      message: msg,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const notConfirmed = await confirmDeploy({ task, config, slack, targetLabel: 'newton-web', logStep, signal });
  if (notConfirmed) return notConfirmed;
  if (isDeployDryRun(store)) return reportDryRun({ task, slack, targetLabel: 'newton-web', logStep });

  // Post a progress message
  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: 'Deploying newton-web to production...',
    })
    .catch(() => {});

  const prompt = buildDeployPrompt({ task, skillInstructions });
  const githubToken = await resolveGithubTokenForCodex();
  const cwd = config.repoPaths.newtonWeb;

  const result = await runCodex({
    cwd,
    prompt,
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    // A production deploy is not where to find out what the shell sandbox
    // breaks (issue #445): it stays outside, as before.
    sandbox: false,
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'deploy.codex.done',
    message: 'Deploy codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

  if (signal?.aborted && !result.ok) {
    // Cancelled while the deploy agent was running. It is not a failed deploy,
    // but it may be a half-finished one, so say that rather than nothing (#438).
    const msg = 'Stopped while the newton-web deploy was running. Check what production is on before deploying again.';
    logStep?.({ stage: 'deploy.cancelled', message: msg, level: 'WARN' });
    const slackPosted = await postDeployReplyBestEffort({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      text: msg,
      logStep,
    });
    return { workflow: 'DEPLOY', status: 'CANCELLED', message: msg, notifyDesktop: true, slackPosted };
  }

  const reply = extractReplyFromCodexResult(result) || 'Deploy finished but produced no output. Check logs.';

  // The deploy side-effect (runCodex above) has already executed. Any failure to
  // post the final Slack reply must NOT escape this function: the shared retry
  // loop in index.ts treats transient errors (ETIMEDOUT, ECONNRESET, 429, SlackApiError)
  // as retryable and would re-enter the workflow, which would call runCodex again
  // and re-run the production deploy. A swallowed-and-logged Slack failure is
  // strictly safer than a duplicated deploy.
  const slackPosted = await postDeployReplyBestEffort({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    text: reply,
    logStep,
  });

  logStep?.({
    stage: 'deploy.done',
    message: 'Deploy workflow completed.',
    data: { ok: result.ok, slackPosted },
  });

  return {
    workflow: 'DEPLOY',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: true,
    slackPosted,
  };
}

/**
 * Marketing (newton-marketing-web) production deploy: a GitHub Actions
 * dispatch, not the newton-web prod skill. A staging ask is the staging
 * tool's (issue #702). The workflow's `production` GitHub Environment
 * approval gate still applies — dispatching starts the run; GitHub may hold
 * it for a human approval.
 */
async function runMarketingDeploy(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: StagingDeployStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep, signal } = params;

  const skipped = (message: string): WorkflowResult => ({
    workflow: 'DEPLOY',
    status: 'SKIPPED',
    message,
    notifyDesktop: false,
    slackPosted: true,
  });

  // Staging named as where it goes: that is the staging tool's to run, with
  // its own access check (issue #702). The router sends such asks there
  // first; this covers one that still lands here.
  const text = task.event.text ?? '';
  if (namesStagingAsTarget(text)) return runStagingDeployWorkflow(params);
  // Staging only as context ("deploy marketing, it looks good on staging"):
  // asked before the start log (which shows "dispatching the deploy" in
  // Slack), since it is only words.
  if (mentionsStagingNotProd(text)) {
    // Only an admin gets this far, so offering production is offering something they can do.
    const msg = STAGING_OR_PROD_REPLY;
    const posted = await postDeployReplyBestEffort({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      text: msg,
      logStep,
    });
    logStep?.({ stage: 'deploy.staging_declined', message: msg });
    return { ...skipped(msg), slackPosted: posted };
  }

  logStep?.({
    stage: 'deploy.marketing.start',
    message: 'Running marketing deploy workflow (GitHub Actions dispatch).',
  });

  // Same capability as the newton-web prod deploy — it goes live on
  // newtonschool.co.
  const accessDecision = evaluateCapability({
    config,
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    capability: 'deploy_prod',
  });
  if (!accessDecision.allowed) {
    const msg = accessDecision.reason ?? 'Deploy to production is restricted to admins.';
    await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg });
    logStep?.({
      stage: 'deploy.marketing.denied',
      message: msg,
      level: 'WARN',
      data: { userId: task.event.userId, denyReason: accessDecision.denyReason },
    });
    return skipped(msg);
  }

  const repoPath = repoPathOrNull(config, 'newton-marketing-web');
  if (!repoPath) {
    const msg =
      "The newton-marketing-web clone isn't configured on this host, so I can't trigger its deploy. Set newton_marketing_web_path in Watchtower settings.";
    await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg });
    return skipped(msg);
  }

  const notConfirmed = await confirmDeploy({
    task,
    config,
    slack,
    targetLabel: 'newton-marketing-web',
    logStep,
    signal,
  });
  if (notConfirmed) return notConfirmed;
  if (isDeployDryRun(store)) return reportDryRun({ task, slack, targetLabel: 'newton-marketing-web', logStep });

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
    })
    .catch(() => {});

  const outcome = await dispatchWorkflowRun({
    repoPath,
    workflowFile: 'deploy-prod.yml',
    ref: 'main',
    inputs: { confirm: 'deploy' },
    signal,
    logStep,
    stagePrefix: 'deploy.marketing',
  });
  if (outcome.kind === 'dispatch_failed') {
    const msg = `Couldn't dispatch the marketing prod deploy: ${outcome.error}`;
    logStep?.({ stage: 'deploy.marketing.dispatch_failed', message: msg, level: 'ERROR' });
    const slackPosted = await postDeployReplyBestEffort({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      text: msg,
      logStep,
    });
    return { workflow: 'DEPLOY', status: 'FAILED', message: msg, notifyDesktop: true, slackPosted };
  }

  // Like the newton-web path, the side-effect has already executed — every
  // failure after this point is a report, never a retry.
  const run = describeProdRun(outcome);

  logStep?.({
    stage: 'deploy.marketing.done',
    message: `Marketing deploy dispatch finished: ${run.summary}`,
    data: { conclusion: run.conclusion, url: run.url },
  });

  const slackPosted = await postDeployReplyBestEffort({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    text: run.summary,
    logStep,
  });

  return {
    workflow: 'DEPLOY',
    status: run.conclusion === 'failure' ? 'FAILED' : 'SUCCESS',
    message: run.summary,
    notifyDesktop: true,
    slackPosted,
  };
}

/** Said to a deploy ask that mentions staging only as context. Plain text. */
export const STAGING_OR_PROD_REPLY =
  'Staging or production? To put a branch on staging, ask me for a testing link. If you meant production, ask again and say prod.';

/** What a dispatched marketing prod deploy came to, in the words posted to Slack. */
function describeProdRun(outcome: Exclude<ActionsRunOutcome, { kind: 'dispatch_failed' }>): {
  conclusion: 'success' | 'failure' | 'pending';
  url?: string;
  summary: string;
} {
  switch (outcome.kind) {
    case 'unanchored':
      return {
        conclusion: 'pending',
        summary:
          ":hourglass: The marketing prod deploy was dispatched, but I couldn't establish a pre-dispatch baseline to identify its run — check the repo's Actions tab for the latest deploy-prod run.",
      };
    case 'unidentified':
      return {
        conclusion: 'pending',
        summary:
          ":hourglass: The marketing prod deploy was dispatched, but I couldn't identify its run yet — check the repo's Actions tab for the latest deploy-prod run.",
      };
    case 'completed': {
      const { url } = outcome;
      if (outcome.conclusion === 'success') {
        return {
          conclusion: 'success',
          url,
          summary: `:white_check_mark: newton-marketing-web production deploy succeeded — live on www.newtonschool.co.${url ? ` Run: ${url}` : ''}`,
        };
      }
      return {
        conclusion: 'failure',
        url,
        summary: `:x: newton-marketing-web production deploy finished with *${outcome.conclusion ?? 'unknown'}*.${url ? ` Run: ${url}` : ''}`,
      };
    }
    case 'waiting':
      return {
        conclusion: 'pending',
        url: outcome.url,
        summary: `:hourglass: The marketing prod deploy is dispatched and *waiting for the production-environment approval* in GitHub.${outcome.url ? ` Approve/watch it here: ${outcome.url}` : ''}`,
      };
    case 'running':
      return {
        conclusion: 'pending',
        url: outcome.url,
        summary: `:hourglass: The marketing prod deploy is dispatched and still running.${outcome.url ? ` Watch it here: ${outcome.url}` : ''}`,
      };
  }
}

/**
 * Post the deploy outcome to Slack with a bounded internal retry. Never throws —
 * a final post failure is logged and returned as `false` so the workflow can still
 * return SUCCESS/FAILED for the deploy itself without triggering the index.ts
 * transient retry loop that would re-execute runCodex().
 */
async function postDeployReplyBestEffort(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  text: string;
  logStep?: WorkflowStepLogger;
}): Promise<boolean> {
  const { slack, channelId, threadTs, text, logStep } = params;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      return true;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      logStep?.({
        stage: 'deploy.slack.post_failed',
        level: isLast ? 'ERROR' : 'WARN',
        message: `Deploy reply post failed (attempt ${attempt}/${maxAttempts}): ${String(error)}`,
        data: { attempt, lastAttempt: isLast },
      });
      if (isLast) return false;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}
