import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, PrContext, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { runClaudeAgentic } from './runClaude.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { refreshSharedRepoToDefaultBranch } from '../workspaces/workspaceManager.js';
import { getBackend } from '../backends/registry.js';
import { extractQaTargetUrl } from '../router/intentParser.js';
import { parseScreenshotManifest, uploadScreenshots } from '../slack/imageUploader.js';
import { preparePrWorktree, bootPrDevServer, runPrBuildGate } from '../devServer/devServerManager.js';
import type { PrDevServer, PreparedPrWorktree, PrBuildGateResult } from '../devServer/devServerManager.js';
import { mapRepoPath, SUPPORTED_PR_REPOS } from '../github/prReviewSupport.js';
import { repoKeyFromGithubRepoName } from '../repos/registry.js';

export type AgenticMode = 'informational' | 'conversational' | 'qa';

/** Hard ceiling for a browser-QA run — driving a real browser is slow. */
const QA_TIMEOUT_MS = 20 * 60 * 1000;

export interface RunAgenticEntryParams {
  mode: AgenticMode;
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

const INFORMATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user has asked an informational question — code lookup, "where is X", "how does Y work", documentation, table schemas, data sources.

Your job:
1. Use your native tools (Read, Grep, Bash, Glob) to find the answer in the repos under the current working directory. The repos you have access to typically include newton-web (frontend), newton-api (backend), and watchtower (the bot itself).
2. Be efficient — don't grep for tangential things. Find the answer and stop.
3. Compose a concise Slack reply citing file:line refs. Use Slack markdown: \`code\`, *bold*, _italic_, bullets.
4. Output ONLY the final Slack reply text as your last message — no JSON, no code fences around the reply, no preamble like "Here's what I found:" or "Based on my search:".

Constraints:
- If you can't find what they asked about, say so directly — don't speculate.
- Stay terse. The user reads on Slack; long answers get skipped.
- Never fabricate file paths or line numbers — only cite things you actually opened.`;

const CONVERSATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user is making a conversational request — greeting, status check, casual chat, or a question about miniOG itself.

Your job:
1. Produce a short, human reply.
2. Output ONLY the final Slack reply text as your last message — no JSON, no code fences, no preamble.

FORBIDDEN: You are NOT permitted to claim that code work was performed, that a PR was opened, that a deploy ran, or that a fix shipped. If the user is asking about an in-flight task, your only allowed response is to acknowledge ("on it", "checking", "will share when ready") or to defer. NEVER assert completion of work you did not do.

Keep replies short — one or two sentences usually. Slack markdown is fine but optional.`;

/**
 * Builds the webapp-QA system prompt with the resolved target URL injected.
 * Ports the methodology of the `webapp-qa` Codex skill (intake → coverage
 * matrix → drive a real browser → evidence-backed report) onto the Claude
 * Code backend, which shells out to Playwright directly instead of relying on
 * the Codex-only `js_repl` + `playwright-interactive` runtime.
 */
function qaSystemPrompt(targetUrl: string, opts?: { changedPaths?: string[]; depsChanged?: boolean }): string {
  const changed = opts?.changedPaths ?? [];
  const prFocus =
    changed.length > 0
      ? `

PR SCOPE — this is a QA pass for a specific pull request running locally at the TARGET URL. Focus on the pages/components affected by the changed files below; navigate to the routes that render them and exercise them hard. Spot-check unrelated areas only briefly.
Changed files:
${changed
  .slice(0, 40)
  .map(p => `- ${p}`)
  .join('\n')}${changed.length > 40 ? `\n- …and ${changed.length - 40} more` : ''}${
          opts?.depsChanged
            ? `\nNOTE: this PR also changed dependencies (package.json/lockfile), but the server runs against the base clone's installed deps. Treat anything that looks dependency-related as a caveat in *Risk / not covered*, not a confirmed bug.`
            : ''
        }`
      : '';
  return `You are miniOG's web-QA agent. You drive a REAL browser to test a running web app and return an evidence-backed QA report to Slack.

TARGET URL: ${targetUrl}
The user's message (below) describes the feature/flow to test and the expected behavior. If the scope is vague, pick the most important happy path plus its obvious failure modes.${prFocus}

EXECUTION (use your Bash tool):
1. Ensure Playwright is available in the current working directory. Try \`node -e "require('playwright')"\`; if it fails, run \`npm i -D playwright\` then \`npx playwright install chromium\`. Do this quietly — do not put install logs in the report.
2. Write a short Node script that launches Chromium with Playwright (headless is fine), navigates to the TARGET URL, and exercises the flow with real user interactions (click, fill, press). Capture a screenshot to an absolute path under a fresh temp dir (e.g. /tmp/miniog-qa-<timestamp>/<scenario>.png) for each key state. Collect console errors and failed network requests.
3. Build a small coverage matrix relevant to the feature: happy path, input/validation, empty/error states, auth/permission if relevant, and one responsive/mobile check if relevant. Only mark a scenario *Passed* if you actually executed and observed it — otherwise *Failed*, *Blocked*, or *Not Run*.
4. If the app never loads or auth/data is missing, produce a *Blocked* report describing the blocker and the lost coverage. Do not claim execution that did not happen.

REPORT (your final message, Slack mrkdwn — single *bold*, \`code\`, bullets; NO JSON, NO code fences around the report, no preamble):
- *Feature* — one line on what was tested.
- *Environment* — the target URL.
- *Coverage* — one bullet per scenario: \`:white_check_mark:\` Passed / \`:x:\` Failed / \`:warning:\` Blocked / \`:white_circle:\` Not Run + the scenario name.
- *Findings* — for each confirmed issue: \`BUG-1 [P0|P1|P2|P3]\` title, then Steps, Expected, Actual, and the screenshot caption that shows it. P0 = core flow broken; P1 = visible incorrect behavior; P2 = degraded; P3 = polish. If none, say so.
- *Risk / not covered* — what you did not test and the remaining risk.

Keep it concise — it's read on Slack.

SCREENSHOTS MANIFEST (required, the very last thing in your message): output a line containing exactly \`===SCREENSHOTS===\` followed by a JSON array of {"path": "<absolute screenshot path>", "caption": "<short caption>"} for every screenshot you captured. If you captured none, output \`===SCREENSHOTS===\` then \`[]\`. Do not wrap the report itself in this marker — only the trailing manifest.`;
}

/**
 * Unified agentic entry point that replaces the legacy informationalWorkflow
 * and conversationalWorkflow. Spawns Claude Code via runCodex (OAuth, no API
 * key needed) with a per-mode system prompt; the agent uses its native tools
 * to explore the repos; the final stdout is parsed and posted to Slack.
 */
export async function runAgenticEntry(params: RunAgenticEntryParams): Promise<WorkflowResult> {
  const { mode, task, config, slack, store, logStep, signal } = params;

  logStep?.({
    stage: 'agentic.start',
    message: `Agentic entry starting in ${mode} mode.`,
    data: { mode, userId: task.event.userId, channelId: task.event.channelId },
  });

  if (mode === 'qa') {
    return runWebappQa(params);
  }

  const systemPromptBase = mode === 'informational' ? INFORMATIONAL_SYSTEM_PROMPT : CONVERSATIONAL_SYSTEM_PROMPT;

  // Conversational guardrail: when investigation findings are pending for
  // this thread, prepend a steer so the agent does NOT claim work is done.
  let systemPrompt = systemPromptBase;
  if (mode === 'conversational') {
    try {
      const pending = store.investigationStore?.()?.getForThread(task.event.threadTs);
      if (pending) {
        systemPrompt = `${systemPromptBase}\n\nIMPORTANT: This thread has pending investigation findings from a prior turn. The user may be following up on a fix. Do NOT claim the fix is done. Steer ("on it", "starting now", "will share the PR shortly") and defer to the implementation pipeline.`;
        logStep?.({
          stage: 'agentic.conversational_steer',
          message: 'Pending investigation findings detected; injected fake-completion guardrail.',
        });
      }
    } catch {
      // investigationStore may not be wired in some contexts; non-fatal.
    }
  }

  const githubToken = await resolveGithubTokenForCodex();

  // Informational answers read the shared newton-web / newton-api clones
  // directly (the cwd below is their parent, NOT an isolated worktree), so the
  // clones must be fast-forwarded to origin first — otherwise a clone that has
  // drifted behind origin yields answers that contradict freshly-merged code
  // (e.g. "feature X isn't implemented" the day after the PR adding it merged).
  // Conversational replies don't read code, so we skip the fetch cost there.
  if (mode === 'informational') {
    for (const repoPath of [config.repoPaths.newtonWeb, config.repoPaths.newtonApi]) {
      const state = await refreshSharedRepoToDefaultBranch(repoPath);
      logStep?.({
        stage: 'agentic.repo_refresh',
        message: `Refreshed ${path.basename(repoPath)} to ${state?.branch ?? 'unknown'} @ ${state?.head ?? 'unknown'}.`,
        data: { repoPath, branch: state?.branch, head: state?.head },
      });
    }
  }

  const cwd = config.miniOgRepoRoot ?? config.repoPaths.newtonWeb;

  const result = await runClaudeAgentic({
    systemPrompt,
    userMessage: task.event.text || '(empty message)',
    cwd,
    githubToken,
    logStep,
    signal,
  });

  logStep?.({
    stage: 'agentic.done',
    message: `Agentic run finished: ${result.reason}.`,
    level: result.ok ? 'INFO' : 'WARN',
    data: { reason: result.reason, error: result.error, replyLength: result.reply.length },
  });

  // Post the reply (or the error message) to Slack from TS.
  let slackPosted = false;
  try {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: result.reply,
    });
    slackPosted = true;
  } catch (err) {
    logStep?.({
      stage: 'agentic.slack_post_failed',
      level: 'ERROR',
      message: `Could not post agentic reply to Slack: ${String(err)}`,
    });
  }

  return {
    workflow: mode === 'informational' ? 'INFORMATIONAL' : 'CONVERSATIONAL',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: result.ok ? result.reply : (result.error ?? `Agentic ${mode} run failed.`),
    notifyDesktop: !result.ok,
    slackPosted,
  };
}

/** Render the install+build-gate verdict for a deps/runtime-only PR as Slack mrkdwn. */
function formatBuildGateReport(pr: PrContext, changedPaths: string[], gate: PrBuildGateResult): string {
  const changed = changedPaths.map(p => `\`${p}\``).join(', ');
  const nodeLine = gate.usedNvmrc
    ? `*Node* — ${gate.nodeVersion} (from the PR's \`.nvmrc\`)`
    : `*Node* — ${gate.nodeVersion} (host default — nvm unavailable, so the PR's \`.nvmrc\` could not be applied)`;
  const cmd = gate.buildScript ? `\`npm ci\` + \`npm run ${gate.buildScript}\`` : '`npm ci` (no build script found)';
  if (gate.ok) {
    return [
      `*Build gate* — PR #${pr.number} (\`${pr.repo}\`): deps/runtime-only, no app code.`,
      nodeLine,
      `*Result* — :white_check_mark: ${cmd} succeeded on the PR's own lockfile + Node version.`,
      `*Changed* — ${changed}`,
      `_This is the right check for a runtime/deps PR — a dev-server browser QA would only have exercised the base clone's installed deps, not this PR._`,
    ].join('\n');
  }
  return [
    `*Build gate* — PR #${pr.number} (\`${pr.repo}\`): deps/runtime-only, no app code.`,
    nodeLine,
    `*Result* — :x: FAILED at the *${gate.failedStage}* stage — ${cmd}.`,
    `*Changed* — ${changed}`,
    '*Last output*',
    '```',
    gate.outputTail || '(no output captured)',
    '```',
    `_A real, PR-attributable failure: a clean install + build on the PR's lockfile and Node version — not the stale base-clone artifact a dev server would surface._`,
  ].join('\n');
}

/**
 * Webapp-QA flow: drive a real browser against a user-supplied URL via the
 * Claude Code backend (forced — it shells out to Playwright and the deployed
 * default is often `codex`, which can't), then post a structured QA report
 * and upload the captured screenshots into the thread.
 */
async function runWebappQa(params: RunAgenticEntryParams): Promise<WorkflowResult> {
  const { task, config, slack, logStep, signal } = params;

  const postReply = async (text: string): Promise<boolean> => {
    try {
      await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text });
      return true;
    } catch (err) {
      logStep?.({
        stage: 'qa.slack_post_failed',
        level: 'ERROR',
        message: `Could not post QA reply to Slack: ${String(err)}`,
      });
      return false;
    }
  };

  // QA needs the claude-code backend (native Bash → Playwright). The deployed
  // default is often `codex`, so guard before spawning a doomed run.
  if (!getBackend('claude-code').isAvailable()) {
    const text = "I can't run browser QA right now — the Claude Code backend isn't available on this host.";
    const slackPosted = await postReply(text);
    return { workflow: 'WEBAPP_QA', status: 'FAILED', message: text, notifyDesktop: true, slackPosted };
  }

  // Drive the QA agent against a reachable URL, then post the report + upload
  // screenshots. Shared by the literal-URL and PR paths.
  const runQaAgainstUrl = async (
    targetUrl: string,
    resultMeta: Record<string, unknown>,
    promptOpts?: { changedPaths?: string[]; depsChanged?: boolean },
  ): Promise<WorkflowResult> => {
    const result = await runClaudeAgentic({
      systemPrompt: qaSystemPrompt(targetUrl, promptOpts),
      userMessage: task.event.text || `QA the web app at ${targetUrl}`,
      cwd: config.repoPaths.newtonWeb,
      forceBackend: 'claude-code',
      timeoutMs: QA_TIMEOUT_MS,
      logStep,
      signal,
    });

    logStep?.({
      stage: 'qa.done',
      message: `Webapp-QA run finished: ${result.reason}.`,
      level: result.ok ? 'INFO' : 'WARN',
      data: { reason: result.reason, error: result.error, targetUrl, ...resultMeta },
    });

    if (!result.ok) {
      const text = result.reply || result.error || 'Browser QA run failed.';
      const slackPosted = await postReply(text);
      return { workflow: 'WEBAPP_QA', status: 'FAILED', message: text, notifyDesktop: true, slackPosted };
    }

    const { visibleText, screenshots } = parseScreenshotManifest(result.reply);
    const reportText = visibleText || 'QA run completed but produced no report text.';
    const slackPosted = await postReply(reportText);

    const uploaded = await uploadScreenshots({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      screenshots,
      logStep,
    });

    return {
      workflow: 'WEBAPP_QA',
      status: 'SUCCESS',
      message: reportText,
      notifyDesktop: false,
      slackPosted,
      result: { targetUrl, ...resultMeta, screenshotsCaptured: screenshots.length, screenshotsUploaded: uploaded },
    };
  };

  // Build gate for a deps/runtime-only PR: validate `npm ci` + build on the
  // PR's OWN lockfile and Node version (what a dev server against base-clone
  // deps cannot check), and report the verdict.
  const runQaBuildGate = async (pr: PrContext, prepared: PreparedPrWorktree): Promise<WorkflowResult> => {
    const changedList = prepared.changedPaths.map(p => `\`${p}\``).join(', ');
    await postReply(
      `:test_tube: PR #${pr.number} (\`${pr.repo}\`) changes only build/runtime/deps (${changedList}) — no app code, ` +
        `so a dev server would only test the base clone's installed deps. Running the real gate instead — ` +
        `\`npm ci\` + build on the PR's own Node version. This can take a few minutes.`,
    );
    const gate = await runPrBuildGate({ worktreePath: prepared.worktreePath, prNumber: pr.number, signal, logStep });
    const report = formatBuildGateReport(pr, prepared.changedPaths, gate);
    const slackPosted = await postReply(report);
    return {
      workflow: 'WEBAPP_QA',
      status: 'SUCCESS',
      message: report,
      notifyDesktop: !gate.ok,
      slackPosted,
      result: {
        prNumber: pr.number,
        repo: pr.repo,
        mode: 'build-gate',
        buildOk: gate.ok,
        nodeVersion: gate.nodeVersion,
        usedNvmrc: gate.usedNvmrc,
        buildScript: gate.buildScript,
        failedStage: gate.failedStage ?? null,
      },
    };
  };

  // Path 1 — a literal URL in the message: QA it directly.
  const literalUrl = extractQaTargetUrl(task.event.text);
  if (literalUrl) {
    await postReply(`:test_tube: Running browser QA on \`${literalUrl}\` — this can take a few minutes.`);
    return runQaAgainstUrl(literalUrl, {});
  }

  // Path 2 — a PR link ("test this PR <url>"): check out the PR head into an
  // isolated worktree, then either browser-QA a booted dev server (app-code
  // PRs) or run an install+build gate (deps/runtime-only PRs — a dev server
  // can't validate those: it runs against the base clone's symlinked
  // node_modules under the harness Node). Always tear the worktree down.
  if (task.prContext) {
    const pr = task.prContext;

    // Resolve the PR's OWN base clone. Fetching pull/<N>/head against the
    // wrong clone's origin silently checks out that repo's PR #<N> — a
    // plausible-looking QA report about entirely unrelated code. Never fall
    // back to newton-web.
    const baseRepoPath = mapRepoPath(config, pr);
    if (!baseRepoPath) {
      const key = repoKeyFromGithubRepoName(pr.repo);
      const text = key
        ? `I can't QA \`${pr.repo}\` PRs on this host — the ${pr.repo} clone isn't configured in Watchtower settings.`
        : `I can only QA PRs on ${SUPPORTED_PR_REPOS.join(', ')} — \`${pr.repo}\` isn't one of them.`;
      const slackPosted = await postReply(text);
      return { workflow: 'WEBAPP_QA', status: 'SKIPPED', message: text, notifyDesktop: false, slackPosted };
    }

    await postReply(
      `:test_tube: Checking out PR #${pr.number} (\`${pr.repo}\`) to QA it — this can take a few minutes.`,
    );

    const githubToken = await resolveGithubTokenForCodex();
    let prepared: PreparedPrWorktree;
    try {
      prepared = await preparePrWorktree({
        baseRepoPath,
        prContext: pr,
        threadTs: task.event.threadTs,
        githubToken,
        signal,
        logStep,
      });
    } catch (err) {
      const text =
        err instanceof Error && err.message === 'aborted'
          ? 'QA cancelled before the PR was ready.'
          : `Couldn't set up PR #${pr.number} for QA: ${err instanceof Error ? err.message : String(err)}`;
      const slackPosted = await postReply(text);
      return { workflow: 'WEBAPP_QA', status: 'FAILED', message: text, notifyDesktop: true, slackPosted };
    }

    try {
      // Deps/runtime-only PR (e.g. a Node-version bump) → a dev server can't
      // validate it; run the real install+build gate on the PR's own Node.
      if (prepared.classification.depsOrInfraOnly) {
        return await runQaBuildGate(pr, prepared);
      }

      // App-code / mixed PR → boot a dev server and browser-QA it.
      let devServer: PrDevServer;
      try {
        await postReply(`Booting a dev server for PR #${pr.number} to test the pages it touches…`);
        devServer = await bootPrDevServer({
          worktreePath: prepared.worktreePath,
          prNumber: pr.number,
          signal,
          logStep,
        });
      } catch (err) {
        const text =
          err instanceof Error && err.message === 'aborted'
            ? 'QA cancelled before the dev server was ready.'
            : `Couldn't boot a dev server for PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`;
        const slackPosted = await postReply(text);
        return { workflow: 'WEBAPP_QA', status: 'FAILED', message: text, notifyDesktop: true, slackPosted };
      }

      try {
        await postReply(`Dev server up at \`${devServer.url}\` — testing the pages this PR touches…`);
        return await runQaAgainstUrl(
          devServer.url,
          { prNumber: pr.number, repo: pr.repo, changedPaths: prepared.changedPaths.length },
          { changedPaths: prepared.changedPaths, depsChanged: prepared.classification.depsChanged },
        );
      } finally {
        await devServer.stop();
      }
    } finally {
      await prepared.cleanup();
    }
  }

  // Neither a literal URL nor a PR link.
  const text =
    'I can QA a running web app, but I need a URL or a PR link. Try *@miniOG QA the login flow on* `https://staging.example.com/login` or *@miniOG test this PR* `<github PR url>`.';
  const slackPosted = await postReply(text);
  return { workflow: 'WEBAPP_QA', status: 'SKIPPED', message: text, notifyDesktop: false, slackPosted };
}
