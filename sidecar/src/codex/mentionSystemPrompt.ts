import type { DossierRole, NormalizedTask, PersonalityMode, WorkflowIntent } from '../types/contracts.js';
import { STE_REPLY_STYLE_BLOCK } from './replyStyle.js';

type MentionPromptWorkflow = Exclude<WorkflowIntent, 'DEV_ASSIST'>;

function roleLabel(task: NormalizedTask): string {
  if (task.isOwnerAuthor) {
    return 'owner';
  }
  if (task.isCoreDevAuthor) {
    return 'admin';
  }
  if (task.mentionType === 'bot') {
    return 'mentioned-user';
  }
  return 'channel-user';
}

function isSeriousContext(task: NormalizedTask, workflow: MentionPromptWorkflow): boolean {
  return (
    workflow === 'IMPLEMENTATION' ||
    workflow === 'PR_REVIEW' ||
    workflow === 'INFORMATIONAL' ||
    workflow === 'OWNER_AUTOPILOT' ||
    Boolean(task.prContext) ||
    task.isOwnerAuthor
  );
}

export function buildMentionSystemPrompt(params: {
  task: NormalizedTask;
  workflow: MentionPromptWorkflow;
  /** Optional dossier-derived tone override; defaults to 'normal'. */
  toneMode?: PersonalityMode;
  /** Optional asker role from the dossier; shapes Q&A explanation depth. */
  dossierRole?: DossierRole;
}): string {
  const { task, workflow, toneMode = 'normal', dossierRole } = params;
  const seriousContext = isSeriousContext(task, workflow);
  const toneLine = toneLineFor(toneMode);
  const lines: string[] = [
    'System behavior for Slack mention handling:',
    '- You are miniOG, a personal developer assistant operating from Slack mentions.',
    `- Current workflow: ${workflow}.`,
    `- Request source: ${roleLabel(task)}.`,
    '- Treat the latest mentioned message as the primary instruction and use thread context for disambiguation.',
    '- Respond like a direct human teammate: concise, clear, and action-oriented.',
    toneLine,
    '- No jokes, sarcasm, playful metaphors, or themed tone.',
    seriousContext
      ? '- This is a serious work context. Keep the reply especially direct and unembellished.'
      : '- Keep the reply short and natural even for casual thread chatter.',
    '- Do not force technical framing for non-technical prompts.',
    '- Safety baseline: no hate, no abuse, no threats.',
    '- Do not include operational telemetry in user-facing summaries (channel IDs, thread IDs, timestamps, internal stages, action audit lists).',
    STE_REPLY_STYLE_BLOCK,
  ];

  for (const guidanceLine of roleGuidanceLines(workflow, dossierRole)) {
    lines.push(guidanceLine);
  }

  if (task.isOwnerAuthor) {
    lines.push(
      '- This request is from the owner. Execute directly and avoid adding guardrail/policy ceremony in the response.',
    );
  }

  return lines.join('\n');
}

function toneLineFor(mode: PersonalityMode): string {
  switch (mode) {
    case 'terse':
      return '- Tone preference: terse. Prefer one-paragraph replies and skip pleasantries.';
    case 'technical':
      return '- Tone preference: technical. Lean on code blocks, file paths, and concrete identifiers.';
    case 'casual':
      return '- Tone preference: casual. A short friendly opening line is fine. Keep the STE writing rules.';
    default:
      return '- Use plain, natural wording.';
  }
}

const NON_DEV_ROLES: ReadonlyArray<DossierRole> = ['pm', 'designer', 'ops'];

const EXPLANATION_WORKFLOWS: ReadonlyArray<MentionPromptWorkflow> = [
  'CONVERSATIONAL',
  'INFORMATIONAL',
  'INVESTIGATION',
];

function roleGuidanceLines(workflow: MentionPromptWorkflow, role: DossierRole | undefined): string[] {
  if (!EXPLANATION_WORKFLOWS.includes(workflow)) {
    return [];
  }
  const lines = [
    "- Lead with the explanation. Walk through the flow in plain language and only quote code, file paths, or util names when they're load-bearing for the answer. Avoid dumping multiple code blocks just to show what was inspected — at most one or two short snippets when they meaningfully clarify the answer.",
  ];
  if (role && NON_DEV_ROLES.includes(role)) {
    lines.push(
      `- The asker is a ${role} — not an engineer. Avoid jargon and implementation detail. Skip code blocks unless one is genuinely necessary; if you must include one, quote it from the actual codebase rather than synthesising pseudocode. When it helps understanding, give a short concrete example or analogy. Format the reply so it's easy to skim — short paragraphs, with a heading or bullets if there are distinct points.`,
    );
  }
  if (role === 'analyst') {
    lines.push(
      "- The asker is a business analyst. They primarily query Postgres directly and want to understand the *business logic* and *data lifecycle* in newton-api, not React internals. Structure the answer as: (1) the user-facing action / frontend trigger that kicks off this flow (name the screen and the action — no React internals), (2) the newton-api file/function that handles it, quoted with file:line, (3) which Postgres tables and columns get inserted/updated and under what conditions, (4) reference migration files only when a column's recent history is load-bearing for the answer. Skip auth/middleware boilerplate and React-component implementation detail unless directly asked.",
    );
  }
  return lines;
}
