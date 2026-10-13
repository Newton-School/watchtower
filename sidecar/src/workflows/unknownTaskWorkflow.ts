import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';

type UnknownReply = {
  reply: string;
  reaction: string;
  track: UnknownReplyTrack;
};

type UnknownReplyTrack = 'direct_reply' | 'task_clarifier';

const TECHNICAL_SIGNAL_PATTERNS = [
  /\b(pr|pull request|review|bug|fix|regression|issue|error|exception|stack|trace|log)\b/i,
  /\b(repo|repository|branch|commit|merge|deploy|release|prod|staging|hotfix|rollback)\b/i,
  /\b(ci|pipeline|test|build|ticket|jira)\b/i,
  /https?:\/\/github\.com\//i,
  /https?:\/\/[a-z0-9.-]*atlassian\.net\//i,
  /`[^`]+`/,
] as const;

const ACTION_CUE_PATTERN =
  /\b(help|handle|do|build|ship|check|investigate|explain|summarize|draft|write|solve|debug|fix|review|test|look at|prove|proof|show|derive|calculate|compute|answer|respond|create|generate|prepare)\b/i;
const HUMOR_MARKER_PATTERN =
  /\b(kpi|layoff|layoffs|budget|committee|boardroom|townhall|scope creep|surprise deliverable|trust issues|self-destruct|entropy|fun column|office-banter|workplace banter|corporate-jokes|natural force|smoke)\b/i;
const NEUTRAL_REACTIONS = ['eyes', 'memo', 'white_check_mark'] as const;

const FALLBACK_REPLIES: Record<UnknownReplyTrack, string[]> = {
  direct_reply: ['noted.', 'understood.', 'message received.', 'go ahead.'],
  task_clarifier: [
    'share the exact outcome you want me to handle.',
    'please specify the single deliverable.',
    'i need one concrete next step to act on this.',
    'tell me the exact result you want.',
  ],
};

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function classifyUnknownReplyTrack(texts: string[]): UnknownReplyTrack {
  const normalized = texts
    .join('\n')
    .replace(/<@[^>]+>/g, ' ')
    .toLowerCase();

  if (!normalized.trim()) {
    return 'direct_reply';
  }

  if (TECHNICAL_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return 'task_clarifier';
  }

  if (ACTION_CUE_PATTERN.test(normalized)) {
    return 'task_clarifier';
  }

  return 'direct_reply';
}

function buildFallbackUnknownReply(task: NormalizedTask, track: UnknownReplyTrack): UnknownReply {
  const seed = hashString(`${task.event.userId}:${task.event.text}:${task.event.eventTs}`);
  const replies = FALLBACK_REPLIES[track];
  const variant = seed % replies.length;
  const reaction = NEUTRAL_REACTIONS[seed % NEUTRAL_REACTIONS.length];

  return {
    reply: replies[variant],
    reaction,
    track,
  };
}

function sanitizeReaction(reaction: string | undefined): string {
  if (!reaction) {
    return 'eyes';
  }
  const value = reaction.trim().toLowerCase();
  if ((NEUTRAL_REACTIONS as readonly string[]).includes(value)) {
    return value;
  }
  return 'eyes';
}

function normalizeReply(reply: string): string {
  const collapsed = reply.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return '';
  }

  const wasQuestion = collapsed.includes('?');
  let candidate = collapsed
    .replace(
      /\s*(?:[;,.-]|\s+or\b|\s+but\b|\s+before\b)\s+[^.?!]*(?:kpi|layoff|layoffs|budget|committee|boardroom|townhall|scope creep|surprise deliverable|trust issues|self-destruct|entropy|fun column|office-banter|workplace banter|corporate-jokes|natural force|smoke)[^.?!]*[.?!]?$/i,
      '',
    )
    .trim();

  if (!candidate) {
    candidate = collapsed;
  }

  const plainSentences = candidate
    .split(/(?<=[.?!])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .filter(sentence => !HUMOR_MARKER_PATTERN.test(sentence));

  const text = plainSentences.length > 0 ? plainSentences.join(' ') : candidate;
  if (wasQuestion && !/[.?!]$/.test(text)) {
    return `${text}?`;
  }
  return text;
}

function sanitizeReply(reply: string | undefined, userId: string, track: UnknownReplyTrack): string {
  const trimmed = normalizeReply(reply ?? '');
  if (trimmed.length > 0) {
    return `<@${userId}> ${trimmed}`;
  }
  if (track === 'task_clarifier') {
    return `<@${userId}> share the exact outcome you want me to handle.`;
  }
  return `<@${userId}> noted.`;
}

async function generateUnknownReplyWithCodex(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<UnknownReply> {
  const { task, slack, logStep } = params;

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadTexts = [task.event.text, ...threadMessages.map(message => message.text)];
  const track = classifyUnknownReplyTrack(threadTexts);
  const threadContext = threadTexts.filter(Boolean).join('\n---\n');

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'UNKNOWN', toneMode: task.toneMode })}

Generate a Slack reply for an unknown/random bot mention.

Rules:
1. Tone: plain, natural, concise, and direct.
2. Context track: ${track}
3. No jokes, sarcasm, banter, or themed tone.
4. If track is direct_reply, answer naturally when the request is clear. Do not add filler.
5. If track is task_clarifier, ask for one missing detail naturally. Do not repeat boilerplate like "PR/bug/CI pipeline" triads.
6. Safe: no hate, no abuse, no threats.
7. Keep reply to max 24 words.
8. Reply text must NOT include user mention. Mention is added externally.
9. Pick one neutral Slack emoji reaction name (without colons): eyes, memo, or white_check_mark.

Context:
- Mention text: ${task.event.text}
- Thread context:
${threadContext || '(empty)'}

Return strict JSON with keys:
- reply (string)
- reaction (string)
`.trim();

  const request: CodexRunRequest = {
    cwd: process.cwd(),
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/unknown-task-result.schema.json'),
    ...lightweightProfile(getActiveBackendId()),
    onLog: logStep,
  };

  logStep?.({
    stage: 'unknown.codex.start',
    message: 'Generating unknown-task reply with Codex lightweight profile.',
    data: {
      timeoutMs: request.timeoutMs,
      threadMessages: threadMessages.length,
      track,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'unknown.codex.finish',
    message: 'Unknown-task Codex generation finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    return buildFallbackUnknownReply(task, track);
  }

  const reply = String(result.parsedJson.reply ?? '').trim();
  const reaction = sanitizeReaction(String(result.parsedJson.reaction ?? ''));
  if (!reply) {
    return buildFallbackUnknownReply(task, track);
  }

  return { reply, reaction, track };
}

export async function runUnknownTaskWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  generateUnknownReply?: (input: {
    task: NormalizedTask;
    config: AppConfig;
    slack: WebClient;
    logStep?: WorkflowStepLogger;
  }) => Promise<UnknownReply>;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, generateUnknownReply } = params;

  logStep?.({
    stage: 'unknown.notify.desktop',
    message: 'No configured workflow matched; generating a plain Slack reply with Codex and notifying desktop.',
    level: 'WARN',
    data: {
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
    },
  });

  const generator = generateUnknownReply ?? generateUnknownReplyWithCodex;
  const generated = await generator({ task, config, slack, logStep });
  const replyText = sanitizeReply(generated.reply, task.event.userId, generated.track);
  const reaction = sanitizeReaction(generated.reaction);

  let postedTs: string | undefined;
  try {
    const response = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: replyText,
    });
    postedTs = response.ts;

    logStep?.({
      stage: 'unknown.slack.reply_posted',
      message: 'Posted unknown-task reply in Slack thread.',
      data: {
        userId: task.event.userId,
      },
    });
  } catch (error) {
    logStep?.({
      stage: 'unknown.slack.reply_failed',
      message: 'Failed to post unknown-task reply in Slack thread.',
      level: 'ERROR',
      data: {
        error: String(error),
      },
    });
  }

  if (postedTs) {
    try {
      await slack.reactions.add({
        channel: task.event.channelId,
        timestamp: postedTs,
        name: reaction,
      });

      logStep?.({
        stage: 'unknown.slack.reaction_added',
        message: 'Added reaction to unknown-task reply.',
        data: {
          reaction,
        },
      });
    } catch (error) {
      logStep?.({
        stage: 'unknown.slack.reaction_failed',
        message: 'Failed to add reaction to unknown-task reply.',
        level: 'WARN',
        data: {
          error: String(error),
        },
      });
    }
  }

  notifyDesktop(
    'Watchtower unknown task',
    `No configured workflow matched channel=${task.event.channelId} thread=${task.event.threadTs}`,
  );

  return {
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: `Unknown task; Codex-generated ${generated.track} Slack reply sent.`,
    notifyDesktop: true,
    slackPosted: Boolean(postedTs),
  };
}
