import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability } from '../access/control.js';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { extractReplyFromCodexResult } from './shared/workflowUtils.js';
import { isMarketingDeployRequest } from '../router/intentParser.js';
import { getRepo, repoPathOrNull } from '../repos/registry.js';

const execFileAsync = promisify(execFile);

/** Internal seam — overridden by tests to avoid spawning the real `gh` CLI. */
export const __ghCli = {
  async exec(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    const { stdout } = await execFileAsync('gh', args, { cwd, timeout: timeoutMs });
    return stdout;
  },
};

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
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, signal } = params;

  // Same deterministic check the intent gate used: a deploy ask naming the
  // marketing site routes to the GitHub Actions flow; everything else is the
  // classic newton-web prod deploy. Never let one mechanism run the other.
  if (isMarketingDeployRequest(task.event.text ?? '')) {
    return runMarketingDeploy(params);
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
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'deploy.codex.done',
    message: 'Deploy codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

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
 * dispatch, not the newton-web prod skill. Staging needs no trigger at all
 * (it auto-deploys on every push to main). The workflow's `production`
 * GitHub Environment approval gate still applies — dispatching starts the
 * run; GitHub may hold it for a human approval.
 */
async function runMarketingDeploy(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, signal } = params;

  logStep?.({
    stage: 'deploy.marketing.start',
    message: 'Running marketing deploy workflow (GitHub Actions dispatch).',
  });

  const skipped = (message: string): WorkflowResult => ({
    workflow: 'DEPLOY',
    status: 'SKIPPED',
    message,
    notifyDesktop: false,
    slackPosted: true,
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

  const normalized = (task.event.text ?? '').toLowerCase();
  const deployMeta = getRepo('newton-marketing-web').deploy;
  const stagingNote =
    deployMeta.method === 'github-actions' ? deployMeta.stagingNote : 'staging auto-deploys on push to main';
  if (/\bstaging\b/.test(normalized) && !/\b(prod|production)\b/.test(normalized)) {
    const msg = `Nothing to trigger — ${stagingNote}. Merge to \`main\` and it ships itself.`;
    await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: msg });
    return skipped(msg);
  }

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
    })
    .catch(() => {});

  // Dispatch. `gh` resolves the target repo from the clone's origin remote.
  try {
    await __ghCli.exec(
      ['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy'],
      repoPath,
      60_000,
    );
  } catch (error) {
    const msg = `Couldn't dispatch the marketing prod deploy: ${error instanceof Error ? error.message : String(error)}`;
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

  // Resolve the run we just dispatched, then poll it to completion. Like the
  // newton-web path, the side-effect has already executed — every failure
  // after this point must degrade to a report, never a retry.
  const run = await watchMarketingDeployRun({ repoPath, signal, logStep });

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

async function watchMarketingDeployRun(params: {
  repoPath: string;
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
}): Promise<{ conclusion: 'success' | 'failure' | 'pending'; url?: string; summary: string }> {
  const { repoPath, signal, logStep } = params;

  const readLatestRun = async (): Promise<{ id?: number; url?: string; status?: string; conclusion?: string }> => {
    const stdout = await __ghCli.exec(
      ['run', 'list', '--workflow=deploy-prod.yml', '--limit', '1', '--json', 'databaseId,url,status,conclusion'],
      repoPath,
      30_000,
    );
    const rows = JSON.parse(stdout || '[]') as Array<{
      databaseId?: number;
      url?: string;
      status?: string;
      conclusion?: string;
    }>;
    const row = rows[0] ?? {};
    return { id: row.databaseId, url: row.url, status: row.status, conclusion: row.conclusion };
  };

  const startedAt = Date.now();
  const maxWaitMs = 15 * 60 * 1000;
  const pollMs = 15_000;
  let lastUrl: string | undefined;

  while (Date.now() - startedAt < maxWaitMs) {
    if (signal?.aborted) break;
    let run: Awaited<ReturnType<typeof readLatestRun>>;
    try {
      run = await readLatestRun();
    } catch (error) {
      logStep?.({
        stage: 'deploy.marketing.poll_failed',
        level: 'WARN',
        message: `Couldn't read the deploy run status: ${String(error)}`,
      });
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    lastUrl = run.url ?? lastUrl;

    if (run.status === 'completed') {
      if (run.conclusion === 'success') {
        return {
          conclusion: 'success',
          url: run.url,
          summary: `:white_check_mark: newton-marketing-web production deploy succeeded — live on www.newtonschool.co.${run.url ? ` Run: ${run.url}` : ''}`,
        };
      }
      return {
        conclusion: 'failure',
        url: run.url,
        summary: `:x: newton-marketing-web production deploy finished with *${run.conclusion ?? 'unknown'}*.${run.url ? ` Run: ${run.url}` : ''}`,
      };
    }
    if (run.status === 'waiting') {
      // The `production` GitHub Environment is holding the run for approval —
      // that can take arbitrarily long, so report and hand off to the human.
      return {
        conclusion: 'pending',
        url: run.url,
        summary: `:hourglass: The marketing prod deploy is dispatched and *waiting for the production-environment approval* in GitHub.${run.url ? ` Approve/watch it here: ${run.url}` : ''}`,
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return {
    conclusion: 'pending',
    url: lastUrl,
    summary: `:hourglass: The marketing prod deploy is dispatched and still running.${lastUrl ? ` Watch it here: ${lastUrl}` : ''}`,
  };
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
