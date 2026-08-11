import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { prepareWorkflowContext } from './shared/workflowUtils.js';
import { assertThreadParentExists, fetchThreadContext } from '../slack/threadContext.js';
import { classifyInvestigationScope, type InvestigationScope } from '../router/investigationScope.js';
import { enabledRepoPaths } from '../repos/registry.js';
import type { McpServerConfig } from '../types/contracts.js';
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

  const ctx = await prepareWorkflowContext({ task, config, slack, logStep, repoOverride: scope.scope });

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

  // Broad scope sweeps both repos and (on the claude-code backend, when an
  // endpoint is configured) the read-only Metabase MCP for the data layer.
  const useMetabase =
    scope.scope === 'broad' && getActiveBackendId() === 'claude-code' && (config.metabaseMcpUrl ?? '').length > 0;
  const mcpServers: Record<string, McpServerConfig> | undefined = useMetabase
    ? { metabase: { type: 'http', url: config.metabaseMcpUrl } }
    : undefined;
  logStep?.({
    stage: useMetabase ? 'investigation.metabase.enabled' : 'investigation.metabase.skipped',
    message: useMetabase
      ? 'Broad investigation — Metabase read-only DB inspection enabled.'
      : `Metabase not used (scope=${scope.scope}, backend=${getActiveBackendId()}, url=${(config.metabaseMcpUrl ?? '').length > 0 ? 'set' : 'unset'}).`,
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
        }
- Read-only mode: Read, Grep, Glob, read-only git/bash (git log, git show, git blame, git diff)${useMetabase ? ', and read-only Metabase queries' : ''}. Do NOT invoke Edit, Write, any worktree-mutating bash, or any mutating MCP tool.`
      : `- Working directory: ${repoPath}${repoName ? ` (${repoName})` : ''}${marketingScopeNote}
- Read-only mode: you may use Read, Grep, Glob, and read-only git/bash (git log, git show, git blame, git diff). Do NOT invoke Edit, Write, or any bash command that mutates the worktree.`;

  const investigatorPrompt = `${recallBlock}${`
${buildMentionSystemPrompt({ task, workflow: 'INVESTIGATION', toneMode: task.toneMode, dossierRole: task.dossierRole })}

You are the INVESTIGATOR agent.

Your job is to DIAGNOSE — not to fix. Read code, run read-only queries (git log / git show / grep / ls), and form a concrete hypothesis about what is wrong. Do NOT modify any files. Do NOT create branches. Do NOT run destructive commands. If you cannot form a hypothesis because the user's report is too vague, say so in \`requiresMoreInfo\` and list what you'd need.

Environment:
${environmentBlock}

Slack thread context (includes the bug report and any evidence the user has shared):
${ctx.threadContext}${ctx.imageContext}

Return strict JSON:
{
  "rootCauseHypothesis": string,            // one-paragraph diagnosis, or "" if genuinely unclear
  "evidence": [                             // concrete citations supporting the hypothesis
    { "file": string, "line": number, "snippet": string, "why": string }
  ],
  "recommendedFix": string,                 // conceptual fix sketch (not code) — what should change
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

  const profile = highReasoningProfile(getActiveBackendId());
  const investigatorResult = await runCodex({
    cwd: repoPath,
    prompt: investigatorPrompt,
    githubToken: ctx.githubToken,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    mcpServers,
    // No per-agent timeoutMs. Substantive investigations on the high-reasoning
    // tier (Opus at xhigh) routinely exceed a fractional sub-budget (e.g. 40%
    // of bugFixTimeoutMs = 18 min) on real feature scoping, and a forced
    // SIGKILL produces no plan content and no actionable error. The outer
    // workflow's abort signal (passed below) is the safety net.
    onLog: logStep,
    signal,
  });

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
    confidence?: 'low' | 'medium' | 'high';
    requiresMoreInfo?: string | null;
    summary?: string;
  };

  const message = formatInvestigationMessage(findings);

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: message,
    })
    .catch(() => {});

  let promptMessageTs: string | undefined;
  if (findings.requiresMoreInfo) {
    const ack = await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `_${findings.requiresMoreInfo}_\n\nReply here with more context and tag me again to continue.`,
      })
      .catch(() => undefined);
    promptMessageTs = typeof ack?.ts === 'string' ? ack.ts : undefined;
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

  if (investigationStore && jobId) {
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

function formatInvestigationMessage(findings: {
  rootCauseHypothesis?: string;
  evidence?: Array<{ file?: string; line?: number; snippet?: string; why?: string }>;
  recommendedFix?: string;
  confidence?: 'low' | 'medium' | 'high';
  summary?: string;
}): string {
  const parts: string[] = [];
  if (findings.summary) parts.push(`*${findings.summary}*`);
  if (findings.rootCauseHypothesis) parts.push(`*Root cause:* ${findings.rootCauseHypothesis}`);

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

  if (findings.recommendedFix) parts.push(`*Recommended fix:* ${findings.recommendedFix}`);
  if (findings.confidence) parts.push(`_Confidence: ${findings.confidence}_`);

  return parts.join('\n\n');
}
