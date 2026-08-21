import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowStepLogger } from '../../types/contracts.js';
import { fetchThreadContext } from '../../slack/threadContext.js';
import { downloadSlackFiles } from '../../slack/imageDownloader.js';
import type { SlackFileAttachment } from '../../slack/imageDownloader.js';
import { getBackend } from '../../backends/registry.js';
import { getActiveBackendId } from '../../codex/runCodex.js';
import { resolveGithubTokenForCodex } from '../../github/githubAuth.js';
import { resolveWorkspace } from '../../workspaces/workspaceManager.js';
import { readRepoAffinity, repoPathFor, resolveRepoOrAsk, type RepoName } from './repoResolver.js';
import type { RepoAffinity } from '../../router/repoClassifier.js';
import type { DossierStore } from '../../state/dossierStore.js';

/** Minimal slice of JobStore needed for first-seen capture; keeps PipelineStore callers compatible. */
type DossierAware = { dossierStore?: () => DossierStore };

export interface ThreadMessage {
  text: string;
  user: string;
  ts: string;
  files?: Array<Record<string, unknown>>;
}

export interface WorkflowContext {
  threadMessages: ThreadMessage[];
  threadContext: string;
  userInput: string;
  cwd: string;
  repoName?: string;
  isOwnerAuthor: boolean;
  requestedBy?: string;
  imagePaths: string[];
  imageContext: string;
  githubToken?: string;
  /**
   * Set when repo resolution could not produce a concrete repo and the
   * caller should route the task to the desktop queue (or fail closed)
   * instead of silently picking a default. Populated by
   * `prepareWorkflowContext` when the repo-resolution helper returns
   * `desktop_only` or `cancelled`.
   */
  desktopOnly?: { reason: string; cancelled: boolean };
}

export function formatThreadContext(
  task: NormalizedTask,
  messages: Array<{ text: string; user: string; ts: string }>,
): string {
  const lines: string[] = [];
  lines.push(`[root] user=${task.event.userId} ts=${task.event.eventTs}`);
  lines.push(task.event.text);

  for (const message of messages) {
    lines.push(`---`);
    lines.push(`[thread] user=${message.user} ts=${message.ts}`);
    lines.push(message.text);
  }

  return lines.join('\n');
}

/**
 * Compact thread render for the intent classifier: the last few prior
 * messages from the intake-fetched task.threadMessages, clipped hard —
 * enough for "the banner pls check the complete thread" to classify
 * correctly, cheap enough for the light-tier classifier call.
 */
export function formatThreadContextForClassifier(task: NormalizedTask): string | undefined {
  const messages = task.threadMessages ?? [];
  const prior = messages.filter(m => m.ts && m.ts !== task.event.eventTs && m.text.trim());
  if (prior.length === 0) return undefined;
  return prior
    .slice(-6)
    .map(m => {
      const text = m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text;
      return `[${m.user}] ${text}`;
    })
    .join('\n');
}

export function stripMentions(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPresencePing(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return true;
  }

  return [
    /^you there$/,
    /^are you there$/,
    /^can you hear me$/,
    /^ping$/,
    /^hi$/,
    /^hello$/,
    /^hey$/,
    /^yo$/,
    /^online$/,
    /^awake$/,
    /^alive$/,
  ].some(pattern => pattern.test(normalized));
}

export function buildPresenceReply(eventTs: string): string {
  const variants = [
    "Yeah, I'm here. Drop the agenda item.",
    'Online and listening. Tell me what should move first.',
    'Present. Send the ask and I will handle the paperwork and the work.',
  ];

  let hash = 0;
  for (let i = 0; i < eventTs.length; i += 1) {
    hash = (hash * 31 + eventTs.charCodeAt(i)) >>> 0;
  }
  return variants[hash % variants.length];
}

export function sanitizeOwnerSummary(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  let cleaned = normalized
    .replace(/on\s+master'?s?\s+command[,:\-\s]*overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/^master your task is completed\.?\s*/i, '')
    .replace(/^owner request success\.?\s*/i, '')
    .replace(/^request success\.?\s*/i, '');

  cleaned = cleaned.replace(/\bactions?:[\s\S]*$/i, '');
  cleaned = cleaned
    .replace(/\b(posted|replied|verified|confirmed)\b[^.\n]*(slack|thread|channel|timestamp)[^.\n]*\.?/gi, '')
    .replace(/\bowner.?s?\s+slack\s+thread\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const lines = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^actions?:/i.test(line))
    .filter(line => !/^-\s*/.test(line))
    .filter(
      line =>
        !/(channel\s+[A-Z0-9]+|thread\s+\d+\.\d+|timestamp|slack thread|replied in slack|posted in slack|confirmed slack)/i.test(
          line,
        ),
    )
    .filter(line => !/^on master's command/i.test(line));

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract clean reply text from a codex result.
 * Handles Claude Code JSON wrapper (both success and error), parsedJson, and raw lastMessage.
 */
export function extractReplyFromCodexResult(result: {
  ok: boolean;
  lastMessage: string;
  stdout: string;
  parsedJson?: Record<string, unknown>;
}): string {
  // 1. Use parsedJson if available (already unwrapped by backend.parseOutput)
  if (result.parsedJson) {
    const summary = result.parsedJson.summary;
    if (typeof summary === 'string' && summary.trim()) return summary.trim();
    const resultField = result.parsedJson.result;
    if (typeof resultField === 'string' && resultField.trim()) return resultField.trim();
  }

  // 2. Try to unwrap Claude Code JSON wrapper from lastMessage
  const raw = result.lastMessage || result.stdout || '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.type === 'result') {
      if (parsed.is_error) {
        // Error wrapper — extract a clean error message
        const errorResult = typeof parsed.result === 'string' ? parsed.result : '';
        if (/overloaded/i.test(errorResult)) {
          return 'The AI backend is temporarily overloaded. Try again in a moment.';
        }
        return 'I hit an execution issue. Try again in a moment.';
      }
      // Success wrapper — extract the result field
      if (typeof parsed.result === 'string' && parsed.result.trim()) {
        return parsed.result.trim();
      }
    }
  } catch {
    // Not JSON — use raw text
  }

  // 3. Fall back to raw text
  return raw.trim();
}

const SLACK_WORKSPACE_DOMAIN = 'newton-school';

/** Sanitize a display name for use in git branch names (lowercase, alphanumeric + hyphens). */
export function sanitizeForBranch(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

/** Build a Slack deep link to a specific thread message. */
export function buildSlackThreadLink(channelId: string, threadTs: string): string {
  const messageId = `p${threadTs.replace('.', '')}`;
  return `https://${SLACK_WORKSPACE_DOMAIN}.slack.com/archives/${channelId}/${messageId}`;
}

/**
 * Working directory that spans BOTH newton-web and newton-api so a single
 * agent can Grep/Read across them. When the two repos are siblings (the
 * normal layout) this is their common parent; otherwise we fall back to the
 * newton-web parent (callers that need the api repo too should pass both
 * absolute paths in the prompt). Generalizes the former owner-only helper.
 */
export function resolveCombinedWorkspaceRoot(config: AppConfig): string {
  // miniOgRepoRoot is validated at config load to contain every configured
  // repo path, so it is the correct N-repo spanning directory when set.
  if (config.miniOgRepoRoot) {
    return config.miniOgRepoRoot;
  }
  const webParent = path.dirname(config.repoPaths.newtonWeb);
  const apiParent = path.dirname(config.repoPaths.newtonApi);
  if (webParent === apiParent) {
    return webParent;
  }
  return webParent;
}

/** @deprecated use resolveCombinedWorkspaceRoot — kept as a thin alias. */
export function resolveOwnerWorkspaceRoot(config: AppConfig): string {
  const webParent = path.dirname(config.repoPaths.newtonWeb);
  const apiParent = path.dirname(config.repoPaths.newtonApi);
  if (webParent === apiParent) {
    return webParent;
  }
  return process.env.HOME ?? os.homedir();
}

export async function prepareWorkflowContext(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  resolveRepo?: boolean;
  store?: DossierAware;
  /**
   * Bypass repo classification and pin the workspace directly (issue: scoped
   * investigation). A repo key → that repo's worktree; 'broad' → the combined
   * parent dir so the agent spans the configured repos. When set,
   * resolveRepoOrAsk is skipped entirely (no admin "which repo?" round-trip).
   */
  repoOverride?: RepoName | 'broad';
}): Promise<WorkflowContext> {
  const { task, config, slack, logStep, resolveRepo = true, store, repoOverride } = params;
  const isOwnerAuthor = config.ownerSlackUserIds.includes(task.event.userId);

  // Attribution user: launchpad retriggers carry the real requester in
  // requestedForUserId (issue #343) — PR titles/bodies and the dossier
  // capture should credit them, not the owner who queued the retrigger.
  // Permissions are unaffected (they evaluate task.event.userId upstream).
  const attributionUserId = task.event.requestedForUserId ?? task.event.userId;

  // Resolve Slack display name
  let requestedBy: string | undefined;
  try {
    const userInfo = await slack.users.info({ user: attributionUserId });
    requestedBy =
      userInfo.user?.profile?.display_name ||
      userInfo.user?.profile?.real_name ||
      userInfo.user?.real_name ||
      userInfo.user?.name ||
      undefined;
    if (!requestedBy) {
      logStep?.({
        stage: 'workflow.user.resolve',
        message: `Could not resolve display name for Slack user ${attributionUserId}`,
      });
    }
    // Piggyback on the users.info we already paid for: capture the user into the dossier.
    if (store?.dossierStore && attributionUserId) {
      try {
        store.dossierStore().firstSeen({
          userId: attributionUserId,
          displayName: userInfo.user?.profile?.display_name || undefined,
          realName: userInfo.user?.real_name || userInfo.user?.profile?.real_name || undefined,
          tz: userInfo.user?.tz || undefined,
          email: userInfo.user?.profile?.email || undefined,
        });
      } catch (err) {
        logStep?.({
          stage: 'workflow.dossier.first_seen_failed',
          level: 'WARN',
          message: 'Failed to record first-seen dossier entry.',
          data: { error: (err as Error).message },
        });
      }
    }
  } catch (err) {
    logStep?.({
      stage: 'workflow.user.resolve',
      message: `Failed to fetch Slack user info for ${attributionUserId}: ${String(err)}`,
    });
  }

  // Fetch thread context
  const threadMessages = (await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(
    () => [],
  )) as ThreadMessage[];
  const threadContext = formatThreadContext(task, threadMessages);
  const userInput = stripMentions(task.event.text);

  // Resolve working directory
  let cwd: string;
  let repoName: string | undefined;
  let desktopOnly: { reason: string; cancelled: boolean } | undefined;

  if (!resolveRepo) {
    cwd = os.tmpdir();
  } else if (repoOverride) {
    // Scope decided by the caller (e.g. investigation scope) — pin the
    // workspace directly, no classification or admin clarify.
    if (repoOverride === 'broad') {
      cwd = resolveCombinedWorkspaceRoot(config);
    } else {
      try {
        const repoPath = repoPathFor(repoOverride, config);
        repoName = repoOverride;
        cwd = await resolveWorkspace(repoPath, task.event.threadTs);
      } catch {
        // The override names a repo that isn't configured on this host —
        // don't crash the workflow; surface it like an unresolvable repo.
        cwd = os.tmpdir();
        desktopOnly = { reason: `${repoOverride} is not configured on this host`, cancelled: false };
      }
    }
  } else if (isOwnerAuthor) {
    cwd = resolveOwnerWorkspaceRoot(config);
  } else {
    let repoAffinity: RepoAffinity | undefined;
    if (store?.dossierStore && task.event.userId) {
      try {
        repoAffinity = readRepoAffinity(store.dossierStore().getDossier(task.event.userId));
      } catch {
        // dossier read shouldn't block repo resolution
      }
    }
    const resolution = await resolveRepoOrAsk({
      task,
      config,
      slack,
      logStep,
      threadMessages,
      repoAffinity,
    });
    if (resolution.outcome === 'resolved') {
      repoName = resolution.name;
      cwd = await resolveWorkspace(resolution.path, task.event.threadTs);
    } else {
      // Either no admin reply within the idle window, or the admin cancelled.
      // Don't silently default — honor AppConfig.uncertainRepoPolicy by
      // flagging the context so the calling workflow can route to desktop.
      cwd = os.tmpdir();
      desktopOnly = {
        reason: resolution.outcome === 'cancelled' ? 'admin cancelled' : resolution.reason,
        cancelled: resolution.outcome === 'cancelled',
      };
    }
  }

  // Download files (images + documents)
  const allFiles = threadMessages.flatMap((m: ThreadMessage) => m.files ?? []) as unknown as SlackFileAttachment[];
  let imagePaths: string[] = [];
  let documentContext = '';
  if (allFiles.length > 0) {
    try {
      const fileResult = await downloadSlackFiles({
        files: allFiles,
        botToken: config.slackBotToken,
        logStep,
      });
      imagePaths = fileResult.imagePaths;

      // Read text-based documents and include their content as context
      if (fileResult.documentPaths.length > 0) {
        const { readFile } = await import('node:fs/promises');
        const docParts: string[] = [];
        for (const docPath of fileResult.documentPaths) {
          try {
            const content = await readFile(docPath, 'utf8');
            const fileName = docPath.split('/').pop() ?? docPath;
            docParts.push(`--- ${fileName} ---\n${content.slice(0, 8000)}`);
          } catch {
            // Non-fatal: skip unreadable docs
          }
        }
        if (docParts.length > 0) {
          documentContext = `\n\nAttached documents from thread:\n${docParts.join('\n\n')}`;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const backend = getBackend(getActiveBackendId());
  const imageContext =
    (imagePaths.length > 0 && !backend.supportsImages()
      ? `\n\n[${imagePaths.length} image(s) attached in thread — this backend does not support image input]`
      : '') + documentContext;

  // Resolve GitHub token
  const githubToken = await resolveGithubTokenForCodex();

  return {
    threadMessages,
    threadContext,
    userInput,
    cwd,
    repoName,
    isOwnerAuthor,
    requestedBy,
    imagePaths,
    imageContext,
    githubToken,
    desktopOnly,
  };
}
