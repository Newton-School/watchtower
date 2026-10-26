import type { WebClient } from '@slack/web-api';
import { cancelledResult } from './shared/cancelState.js';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { getActiveBackendId } from '../codex/runCodex.js';
import {
  connectionLostReply,
  killedFromOutsideReply,
  runWithInfraRetry,
  usageLimitReply,
  cleanResetText,
} from '../codex/infraRetry.js';
import { readOnlyRunNote } from '../agentic/runClaude.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { prepareWorkflowContext } from './shared/workflowUtils.js';
import { assertThreadParentExists, fetchThreadContext } from '../slack/threadContext.js';
import { classifyInvestigationScope, type InvestigationScope } from '../router/investigationScope.js';
import { enabledRepoPaths } from '../repos/registry.js';
import { connectorsFor, NO_CONNECTORS } from '../backends/connectors.js';
import { refreshSharedClones } from '../workspaces/staleCheckout.js';
import { prepareSiblingRepos, type SiblingRepos } from '../workspaces/siblingRepos.js';
import { attachReplyTablesAsCsv } from '../slack/tableCsv.js';
import { recentChangesNear, RECENT_COMMITS_RULE } from './shared/recentChanges.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { InvestigationStore } from '../state/investigationStore.js';
import type { RecallCapableStore } from '../state/dossierStore.js';
import type { JobStore } from '../state/jobStore.js';

export async function runInvestigationWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: PipelineStore & RecallCapableStore;
  investigationStore?: InvestigationStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, investigationStore, jobId, logStep, signal } = params;

  logStep?.({ stage: 'investigation.start', message: 'Running investigation workflow.' });

  // Decide WHERE to look before resolving the workspace: a frontend symptom →
  // newton-web only, a backend/data symptom → newton-api only, ambiguous →
  // broad sweep of both repos + Metabase. This replaces the old
  // resolveRepoOrAsk path for investigations (no admin "web or api?" gate).
  const scopeThread = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const scope = await classifyInvestigationScope({
    bugReport: task.event.text ?? '',
    threadMessages: scopeThread.map(m => m.text),
    repoGrepPaths: enabledRepoPaths(config),
    logStep,
    signal,
  });

  const ctx = await prepareWorkflowContext({ task, config, slack, logStep, repoOverride: scope.scope, signal });
  // Cancelled while asking which repo: no "routing to the desktop queue" copy (issue #264).
  if (signal?.aborted) {
    return cancelledResult('INVESTIGATION');
  }

  if (ctx.desktopOnly) {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `I couldn't pin down which repo to investigate (${ctx.desktopOnly.reason}) — routing this to the desktop queue.`,
      })
      .catch(() => {});
    return {
      workflow: 'INVESTIGATION',
      status: ctx.desktopOnly.cancelled ? 'CANCELLED' : 'PAUSED',
      message: `Routed to desktop (${ctx.desktopOnly.reason}).`,
      notifyDesktop: !ctx.desktopOnly.cancelled,
      slackPosted: true,
    };
  }

  const repoPath = ctx.cwd;
  const repoName = ctx.repoName;

  // Phase G: assemble the recall block once and prepend to the investigator
  // prompt. Empty when the user has no dossier; safe to thread always.
  let recallBlock = '';
  if (store?.dossierStore && store.recentSignalsForUser && task.event.userId) {
    try {
      const recall = await assembleRecall({
        userId: task.event.userId,
        workflow: 'INVESTIGATION',
        store: store as unknown as JobStore,
        vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
        query: task.event.text ?? '',
        excludeThread: { channelId: task.event.channelId, threadTs: task.event.threadTs },
        channelId: task.event.channelId,
      });
      if (recall.promptBlock) {
        recallBlock = `${recall.promptBlock}\n\n`;
        logStep?.({
          stage: 'workflow.recall.injected',
          message: `Injected recall (${recall.estimatedTokens} tokens, ${recall.sources.join(',')}).`,
          data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens, workflow: 'INVESTIGATION' },
        });
      }
    } catch (err) {
      logStep?.({
        stage: 'workflow.recall.failed',
        level: 'WARN',
        message: 'recall assembly failed; running without it',
        data: { error: (err as Error).message, workflow: 'INVESTIGATION' },
      });
    }
  }

  // An investigation keeps one connector: Metabase, read-only, for the data
  // layer (on the claude-code backend, when an endpoint is configured). It
  // used to be the broad scope only by design, and every other scope got all
  // of the host user's connectors by omission (issue #443).
  const connectors = getActiveBackendId() === 'claude-code' ? connectorsFor('lookup', config) : NO_CONNECTORS;
  const useMetabase = 'metabase' in connectors.mcpServers;
  const analyticsNote =
    'openpanel' in connectors.mcpServers
      ? `
- An OpenPanel MCP server is connected (tools named \`mcp__openpanel__*\`) for read-only product analytics: events and their properties, funnels, page and traffic numbers. Use it when the symptom is about tracking or traffic; if its tools are unavailable, say so in \`summary\`.`
      : '';
  logStep?.({
    stage: useMetabase ? 'investigation.metabase.enabled' : 'investigation.metabase.skipped',
    message: useMetabase
      ? 'Metabase read-only DB inspection enabled.'
      : `Metabase not used (backend=${getActiveBackendId()}, url=${(config.metabaseMcpUrl ?? '').length > 0 ? 'set' : 'unset'}).`,
    data: { scope: scope.scope },
  });

  const marketingConfigured = Boolean(config.repoPaths.newtonMarketingWeb);
  const marketingScopeNote =
    scope.scope === 'newton-marketing-web'
      ? `
- This is the PUBLIC MARKETING site (static export served behind a Cloudflare Worker). Some newtonschool.co paths are still served by Webflow — \`worker/paths.js\` decides which. A "broken marketing page" may not be in this code at all: check the path routing there FIRST before attributing the symptom to code.`
      : '';
  const environmentBlock =
    scope.scope === 'broad'
      ? `- Working directory: ${repoPath} — this directory contains the newton-web (product frontend) and newton-api (backend) repos. Grep/Read across BOTH to trace the bug end-to-end.${
          marketingConfigured
            ? `
- The newton-marketing-web clone is also present here but is OUT OF SCOPE for this broad sweep — it is a static marketing site with no product/backend coupling. Ignore it unless the evidence explicitly points at a public newtonschool.co landing page.`
            : ''
        }
- The bug could not be localized to one layer, so investigate the full stack: correlate the UI symptom → the API contract/response → the underlying data.${
          useMetabase
            ? `
- A Metabase MCP server is connected (tools named \`mcp__metabase__*\`). Use it to inspect the read-only database — check whether the suspect data is correct at the source vs. what the API returns vs. what the UI renders. Use ONLY read/query tools; never invoke any mutating Metabase tool.
- If the Metabase tools are unavailable (not connected), proceed with the two repos and explicitly note in \`requiresMoreInfo\`/\`summary\` that the data layer was not inspected.`
            : `
- No database access is available this run; investigate the repos only and note in \`summary\` if a data-layer check would help confirm the diagnosis.`
        }${analyticsNote}
- Read-only mode: Read, Grep, Glob, read-only git/bash (git log, git show, git blame, git diff)${useMetabase ? ', and read-only Metabase queries' : ''}. Do NOT invoke Edit, Write, any worktree-mutating bash, or any mutating MCP tool.`
      : `- Working directory: ${repoPath}${repoName ? ` (${repoName})` : ''}${marketingScopeNote}${
          useMetabase
            ? `
- A Metabase MCP server is connected (tools named \`mcp__metabase__*\`) for read-only database checks, when the code alone cannot settle whether the data is wrong. If its tools are unavailable, say in \`summary\` that the data layer was not inspected.`
            : ''
        }${analyticsNote}
- Read-only mode: you may use Read, Grep, Glob, and read-only git/bash (git log, git show, git blame, git diff)${useMetabase ? ', and read-only Metabase queries' : ''}. Do NOT invoke Edit, Write, any bash command that mutates the worktree, or any mutating MCP tool.`;

  // A broad investigation reads the shared clones in place (issue #446). A
  // scoped one reads its repo in a fresh worktree, and the other repos'
  // clones beside it, refreshed the same way (issue #610). The refresh starts
  // now and is awaited after the requester hears what we're digging into: a
  // hanging GitHub can hold it for a minute. It never fails the job.
  const scopedClonePath =
    scope.scope === 'broad' ? undefined : enabledRepoPaths(config).find(repo => repo.key === scope.scope)?.path;
  const refreshing: Promise<{ staleBlock?: string; siblings?: SiblingRepos }> = (async () => {
    try {
      if (scope.scope === 'broad') {
        return { staleBlock: await refreshSharedClones({ config, stage: 'investigation.repo_refresh', logStep }) };
      }
      if (scopedClonePath) {
        const siblings = await prepareSiblingRepos({
          config,
          currentRepoPath: scopedClonePath,
          mode: 'refresh',
          stage: 'investigation.repo_refresh',
          logStep,
        });
        return { siblings };
      }
    } catch (error) {
      logStep?.({
        stage: 'investigation.repo_refresh',
        level: 'WARN',
        message: `Could not refresh the repos; the investigation reads them as they are. ${String(error).slice(0, 300)}`,
      });
    }
    return {};
  })();

  // Recent commits near what the report names, so a symptom fixed days ago is
  // found by reading the history, not by rounds of "cannot reproduce" (issue #621).
  const findRecentChanges = async (): Promise<string | undefined> => {
    const recentChangesRepos =
      scope.scope === 'broad'
        ? enabledRepoPaths(config).filter(repo => repo.key === 'newton-web' || repo.key === 'newton-api')
        : [{ key: scope.scope, path: repoPath }];
    const recentChanges = await recentChangesNear({
      repos: recentChangesRepos,
      reportText: [task.event.text ?? '', ...scopeThread.map(m => m.text ?? '')].join('\n').slice(0, 4_000),
    });
    if (recentChanges.matched.length > 0) {
      const commits = recentChanges.matched.reduce((sum, repo) => sum + repo.commits, 0);
      logStep?.({
        stage: 'investigation.recent_changes',
        message:
          commits > 0
            ? `Found ${commits} recent commit(s) near what was reported; they go to the investigator as hints.`
            : 'The report names files or folders in the repo, but none changed recently.',
        data: { matched: recentChanges.matched },
      });
    }
    return recentChanges.block;
  };

  const buildInvestigatorPrompt = (
    { staleBlock, siblings }: { staleBlock?: string; siblings?: SiblingRepos },
    recentChangesBlock: string | undefined,
  ): string =>
    `${recallBlock}${`
${buildMentionSystemPrompt({ task, workflow: 'INVESTIGATION', toneMode: task.toneMode, dossierRole: task.dossierRole })}

You are the INVESTIGATOR agent.

Your job is to DIAGNOSE — not to fix. Read code, run read-only queries (git log / git show / grep / ls), and form a concrete hypothesis about what is wrong. Do NOT modify any files. Do NOT create branches. Do NOT run destructive commands. If you cannot form a hypothesis because the user's report is too vague, say so in \`requiresMoreInfo\` and list what you'd need.

${RECENT_COMMITS_RULE}

Environment:
${environmentBlock}${staleBlock ? `\n\n${staleBlock}` : ''}${siblings?.block ? `\n\n${siblings.block}` : ''}${recentChangesBlock ? `\n\n${recentChangesBlock}` : ''}

${readOnlyRunNote({ otherRepos: Boolean(siblings?.block) })}

Slack thread context (includes the bug report and any evidence the user has shared):
${ctx.threadContext}${ctx.imageContext}

Return strict JSON:
{
  "rootCauseHypothesis": string,            // one-paragraph diagnosis, or "" if genuinely unclear
  "evidence": [                             // concrete citations supporting the hypothesis
    { "file": string, "line": number, "snippet": string, "why": string }
  ],
  "recommendedFix": string,                 // conceptual fix sketch (not code) — what should change
  "fixLocation": "repo" | "outside" | "none", // "repo": a code change in one of these repositories, sketched in recommendedFix. "outside": the fix is somewhere else (a Metabase question or dashboard, an admin setting, data, another service) — say where in recommendedFix, and who can make it. "none": nothing needs fixing — it works as intended, it is already fixed on the default branch, or whether to change it is a product call for a person, not a bug; say which in summary. ${FIX_LOCATION_RULE}
  "confidence": "low" | "medium" | "high",
  "requiresMoreInfo": string | null,        // null if the hypothesis stands on its own; otherwise a specific ask
  "summary": string                         // one-line Slack summary of what you found
}
`.trim()}`;

  // Bail before spawning the investigator if the source mention is gone.
  // See processMessageDeleted in index.ts for the orphan-promotion RCA.
  const parentAlive = await assertThreadParentExists(slack, task.event.channelId, task.event.threadTs);
  if (!parentAlive) {
    logStep?.({
      stage: 'investigation.source_deleted',
      level: 'WARN',
      message: 'Source mention no longer exists — aborting investigation.',
      data: { channelId: task.event.channelId, threadTs: task.event.threadTs },
    });
    return {
      workflow: 'INVESTIGATION',
      status: 'CANCELLED',
      message: 'Source message deleted before investigator ran.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  // Tell the user what we're digging into — investigations can run a while.
  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: scopeAckText(scope.scope, useMetabase),
    })
    .catch(() => {});

  // A broad investigation's history hints read the clones being refreshed, so
  // they wait for it; a scoped one reads its own fresh worktree meanwhile.
  const [refreshed, recentChangesBlock] =
    scope.scope === 'broad'
      ? [await refreshing, await findRecentChanges()]
      : await Promise.all([refreshing, findRecentChanges()]);
  const siblings = refreshed.siblings;
  const investigatorPrompt = buildInvestigatorPrompt(refreshed, recentChangesBlock);

  const profile = highReasoningProfile(getActiveBackendId());
  const investigatorResult = await runWithInfraRetry(
    {
      cwd: repoPath,
      prompt: investigatorPrompt,
      githubToken: ctx.githubToken,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      mcpServers: connectors.mcpServers,
      disallowedTools: connectors.disallowedTools,
      // An investigation reads and reports; the change, if any, is a later job (issue #443).
      readOnly: true,
      readDirs: siblings?.dirs,
      // No per-agent timeoutMs. Substantive investigations on the high-reasoning
      // tier (Opus at xhigh) routinely exceed a fractional sub-budget (e.g. 40%
      // of bugFixTimeoutMs = 18 min) on real feature scoping, and a forced
      // SIGKILL produces no plan content and no actionable error. The outer
      // workflow's abort signal (passed below) is the safety net.
      onLog: logStep,
      signal,
    },
    // A dropped connection is waited out and retried (issue #439).
    { label: 'the investigation', logStep },
  );

  // Cancelled mid-run: the dead agent is not a failed investigation, and the
  // "couldn't complete" copy below would be wrong (issue #438).
  if (signal?.aborted) {
    return cancelledResult('INVESTIGATION');
  }

  // The Claude usage limit: asking for more context, as the generic failure
  // below does, sends the requester off to explain a problem that was ours (issue #592).
  if (!investigatorResult.ok && investigatorResult.errorKind === 'USAGE_LIMIT') {
    const text = usageLimitReply('investigate this', investigatorResult.limitResetsAtText);
    logStep?.({
      stage: 'investigation.usage_limit',
      message: 'Investigation stopped by the usage limit.',
      level: 'ERROR',
      data: { resetsAt: cleanResetText(investigatorResult.limitResetsAtText) ?? null },
    });
    const slackPosted = await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text })
      .then(() => true)
      .catch(() => false);
    return { workflow: 'INVESTIGATION', status: 'FAILED', message: text, notifyDesktop: true, slackPosted };
  }

  // The network or a kill from outside, not the report: say so instead of
  // asking the requester for more context (issue #439).
  if (
    !investigatorResult.ok &&
    (investigatorResult.errorKind === 'API_ERROR' || investigatorResult.errorKind === 'EXTERNAL_KILL')
  ) {
    const text =
      investigatorResult.errorKind === 'API_ERROR'
        ? connectionLostReply('investigating this', { changesCode: false })
        : killedFromOutsideReply('The investigation', { changesCode: false });
    logStep?.({
      stage: 'investigation.interrupted',
      message: `Investigation interrupted (${investigatorResult.errorKind}) after ${investigatorResult.infraRetries} retries.`,
      level: 'ERROR',
      data: { errorKind: investigatorResult.errorKind, retries: investigatorResult.infraRetries },
    });
    await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text })
      .catch(() => {});
    return {
      workflow: 'INVESTIGATION',
      status: 'FAILED',
      message: text,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  if (!investigatorResult.ok || !investigatorResult.parsedJson) {
    logStep?.({
      stage: 'investigation.failed',
      message: 'Investigator did not return valid JSON output.',
      level: 'ERROR',
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: "I couldn't complete the investigation (the investigator agent failed to produce a readable diagnosis). Could you share more context about what's failing?",
      })
      .catch(() => {});
    return {
      workflow: 'INVESTIGATION',
      status: 'FAILED',
      message: 'Investigator produced no usable output.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  const findings = investigatorResult.parsedJson as {
    rootCauseHypothesis?: string;
    evidence?: Array<{ file?: string; line?: number; snippet?: string; why?: string }>;
    recommendedFix?: string;
    fixLocation?: string;
    confidence?: 'low' | 'medium' | 'high';
    requiresMoreInfo?: string | null;
    summary?: string;
  };

  const message = formatInvestigationMessage(findings);
  const nextStep = investigationNextStep(findings);

  const findingsPosted = await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: message,
    })
    // Slack can turn a post down without throwing (the thread is gone): no CSV then.
    .then(response => (response as { ok?: boolean } | undefined)?.ok !== false)
    .catch(() => false);
  // A table in the findings also goes in the thread as a CSV (issue #731).
  if (findingsPosted) {
    await attachReplyTablesAsCsv({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      replyText: message,
      askText: task.event.text ?? '',
      logStep,
    });
  }

  let promptMessageTs: string | undefined;
  if (nextStep === 'fix_outside_repos') {
    logStep?.({
      stage: 'investigation.fix_outside_repos',
      message: 'The recommended fix is outside the repositories; not offering to make it.',
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: 'This fix is not a code change, so I can’t make it from here: see *Recommended fix* for where it lives and who can change it.',
      })
      .catch(() => undefined);
  } else if (nextStep === 'nothing_to_fix') {
    logStep?.({
      stage: 'investigation.nothing_to_fix',
      message: 'The investigation found nothing that needs fixing; not offering a fix.',
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: NOTHING_TO_FIX_REPLY,
      })
      .catch(() => undefined);
  } else if (nextStep === 'no_offer') {
    // A diagnosis that names no fix in the code, or no verdict at all: the
    // findings stand on their own and nothing is offered (issue #624).
    logStep?.({
      stage: 'investigation.no_fix_offer',
      message: `No code fix identified (fixLocation: ${findings.fixLocation ?? 'missing'}); not offering a fix.`,
      level: FIX_LOCATIONS.has(findings.fixLocation ?? '') ? 'INFO' : 'WARN',
    });
  } else if (nextStep === 'ask_for_more') {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `_${findings.requiresMoreInfo}_\n\nReply here with more context and tag me again to continue.`,
      })
      .catch(() => undefined);
    // Not kept as the prompt: a ✅ on this question is not a "yes, fix it".
  } else {
    // Two confirmation paths. The ✅ reaction is the primary, frictionless
    // path — the reaction_added handler matches the reacted message ts back
    // to the saved findings (`prompt_message_ts`) and dispatches a synthetic
    // resume event. The tag fallback is still here for users who prefer to
    // reply with text and remembers to mention the bot.
    const ack = await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text:
          'Want me to fix this? React ✅ on this message to confirm, ' +
          'or tag me again in this thread with "yes, fix it" (or feedback).',
      })
      .catch(() => undefined);
    promptMessageTs = typeof ack?.ts === 'string' ? ack.ts : undefined;
  }

  // Saved only when a reply can continue it: a saved investigation is what
  // turns "yes, fix it" (or ✅ on the prompt) into the change pipeline, so
  // findings with no fix in the code are not kept (issues #432, #624).
  const resumable = nextStep === 'offer_fix' || (nextStep === 'ask_for_more' && findings.fixLocation !== 'outside');
  if (investigationStore && !resumable) {
    // An earlier investigation in this thread is superseded by this one: a
    // later "ok" or change ask must not continue the old findings.
    try {
      investigationStore.clear(task.event.threadTs);
    } catch (err) {
      logStep?.({
        stage: 'investigation.clear_failed',
        message: `Failed to clear earlier investigation findings: ${err instanceof Error ? err.message : String(err)}`,
        level: 'WARN',
      });
    }
  }
  if (investigationStore && jobId && resumable) {
    try {
      investigationStore.save({
        threadTs: task.event.threadTs,
        channelId: task.event.channelId,
        jobId,
        repoName,
        repoPath,
        summary: findings.summary ?? findings.rootCauseHypothesis ?? '',
        findingsJson: JSON.stringify(findings),
        promptMessageTs,
        requesterUserId: task.event.userId,
      });
      logStep?.({
        stage: 'investigation.saved',
        message: 'Investigation findings persisted for future planner re-entry.',
      });
    } catch (err) {
      logStep?.({
        stage: 'investigation.save_failed',
        message: `Failed to persist investigation findings: ${err instanceof Error ? err.message : String(err)}`,
        level: 'WARN',
      });
    }
  }

  return {
    workflow: 'INVESTIGATION',
    status: 'SUCCESS',
    message: findings.summary ?? 'Investigation complete.',
    notifyDesktop: false,
    slackPosted: true,
  };
}

export const NOTHING_TO_FIX_REPLY =
  'Nothing here is broken, so I’m not offering a fix. If you want it changed anyway, tag me with what to change.';

/**
 * How to pick between "repo" and "none" when the fix section lists options:
 * both runs in issue #624 came back "repo" because the fix sketched choices
 * someone could make, though nothing was broken.
 */
export const FIX_LOCATION_RULE =
  'Use "none", not "repo", when nothing is broken and recommendedFix only lists options someone could choose (a product call). If the reported symptom is already fixed but you found another real defect, use "repo" for that defect.';

const FIX_LOCATIONS = new Set(['repo', 'outside', 'none']);

export type InvestigationNextStep = 'ask_for_more' | 'fix_outside_repos' | 'nothing_to_fix' | 'offer_fix' | 'no_offer';

/**
 * What follows the findings, from the investigator's own verdict. Only a fix
 * in the code is offered: a fix elsewhere, if accepted, went into the change
 * pipeline with no repo to change (issue #432), and "Want me to fix this?"
 * after concluding the behaviour is intended reads as a contradiction (issue
 * #624). A missing or unknown verdict offers nothing.
 */
export function investigationNextStep(findings: {
  fixLocation?: string;
  recommendedFix?: string;
  requiresMoreInfo?: string | null;
}): InvestigationNextStep {
  if (findings.fixLocation === 'outside' && !findings.requiresMoreInfo) return 'fix_outside_repos';
  if (findings.requiresMoreInfo) return 'ask_for_more';
  if (findings.fixLocation === 'none') return 'nothing_to_fix';
  if (findings.fixLocation === 'repo' && findings.recommendedFix?.trim()) return 'offer_fix';
  return 'no_offer';
}

function scopeAckText(scope: InvestigationScope, useMetabase: boolean): string {
  if (scope === 'newton-web') {
    return 'Looks like a frontend issue — digging into *newton-web*. I’ll share what I find.';
  }
  if (scope === 'newton-api') {
    return 'Looks data/backend-related — digging into *newton-api*. I’ll share what I find.';
  }
  if (scope === 'newton-marketing-web') {
    return 'Looks like a marketing-site issue — digging into *newton-marketing-web*. I’ll share what I find.';
  }
  return useMetabase
    ? 'Tracing this end-to-end through *newton-web*, *newton-api*, and database. I’ll share what I find.'
    : 'Tracing this end-to-end through *newton-web* and *newton-api*. I’ll share what I find.';
}

/**
 * A label and its text. Text that opens with a table or a code block goes on
 * the next line, so the label doesn't join the table's header (issue #731).
 */
function labelled(label: string, text: string): string {
  return /^\s*(\||```)/.test(text) ? `${label}\n${text.trimStart()}` : `${label} ${text}`;
}

function formatInvestigationMessage(findings: {
  rootCauseHypothesis?: string;
  evidence?: Array<{ file?: string; line?: number; snippet?: string; why?: string }>;
  recommendedFix?: string;
  confidence?: 'low' | 'medium' | 'high';
  summary?: string;
}): string {
  const parts: string[] = [];
  if (findings.summary) parts.push(`*${findings.summary}*`);
  if (findings.rootCauseHypothesis) parts.push(labelled('*Root cause:*', findings.rootCauseHypothesis));

  if (findings.evidence && findings.evidence.length > 0) {
    const items = findings.evidence
      .slice(0, 5)
      .map(e => {
        const loc = e.file ? (e.line ? `\`${e.file}:${e.line}\`` : `\`${e.file}\``) : '';
        const why = e.why ? ` — ${e.why}` : '';
        return `• ${loc}${why}`;
      })
      .join('\n');
    parts.push(`*Evidence:*\n${items}`);
  }

  if (findings.recommendedFix) parts.push(labelled('*Recommended fix:*', findings.recommendedFix));
  if (findings.confidence) parts.push(`_Confidence: ${findings.confidence}_`);

  return parts.join('\n\n');
}
