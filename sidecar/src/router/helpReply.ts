import { evaluateCapability, getConfiguredAccessControl } from '../access/control.js';
import { enabledRepoKeys } from '../repos/registry.js';
import type { AccessLevel, AppConfig, DossierRole } from '../types/contracts.js';
import { normalizeControlText } from './stopIntent.js';
import { TOOLS, type ToolId } from './toolRegistry.js';

/**
 * "@miniOG help", answered at once and for this person in this channel
 * (suggestion 13 of the 2026-10-18 UX exploration). A help reply used to be a
 * model run that described miniOG in general. A PM in the product channel
 * needs to read that they can change copy on www pages and ask product
 * questions; a developer in #development needs reviews and change runs; a
 * channel where a tool is not enabled for them should say so instead of
 * letting them find out by asking.
 */

/** A bare request for help, with miniOG's mention already stripped. */
export function isHelpRequest(message: string): boolean {
  const text = normalizeControlText(message);
  if (!text) return false;
  return [
    /^(please )?help( me)?( out)?( please)?$/,
    /^what can you do( for me| here)?$/,
    /^what (all )?(do|can) you (do|help with)( here)?$/,
    /^how (can|do) (you|i) (help|use you|work with you)( me)?( here)?$/,
    /^what are you (able to do|for)$/,
    /^(show|list) (me )?(your )?(commands|capabilities|options)$/,
    /^(hi|hello|hey) (what can you do|help)$/,
  ].some(pattern => pattern.test(text));
}

/** Slack reads `<…>` as a link or a mention, so a literal placeholder is escaped. */
function escapeForSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ToolLine {
  what: string;
  example: string;
}

/** One line per tool, written for the person reading it rather than for the registry. */
const TOOL_LINES: Partial<Record<ToolId, ToolLine>> = {
  answer: {
    what: 'Answer questions about the product, the code and the data',
    example: 'how does negative marking work for assessments?',
  },
  change_code: {
    what: 'Make a change and open a PR for it: copy, numbers, images, PDFs on www pages, or code',
    example: 'on https://www.newtonschool.co/…/placement change 93% to 98.3%',
  },
  investigate: {
    what: 'Look into a problem and report the cause',
    example: 'this student is marked eligible but cannot apply to roles',
  },
  review_pr: { what: 'Review a pull request and post the findings on it', example: 'review <PR link>' },
  qa_webapp: {
    what: 'Test a PR or a running page in a browser and report what I find',
    example: 'QA this PR in the browser <PR link>',
  },
  deploy: { what: 'Deploy to production, with a typed confirmation', example: 'deploy newton-web to prod' },
};

/** Without the marketing site configured, a change is a product-copy or code change. */
const CHANGE_WITHOUT_MARKETING: ToolLine = {
  what: 'Make a change and open a PR for it',
  example: 'rename the "Mentor evaluation" label to "Module evaluation"',
};

/** The default order, and the tool each kind of reader sees first. */
const DEFAULT_ORDER: ToolId[] = ['answer', 'change_code', 'investigate', 'review_pr', 'qa_webapp', 'deploy'];
const LEAD_BY_ROLE: Partial<Record<DossierRole, ToolId[]>> = {
  pm: ['change_code', 'answer', 'investigate'],
  designer: ['change_code', 'review_pr', 'answer'],
  dev: ['review_pr', 'change_code', 'investigate'],
};

function orderFor(role: DossierRole | undefined): ToolId[] {
  const lead = (role && LEAD_BY_ROLE[role]) ?? [];
  return [...lead, ...DEFAULT_ORDER.filter(id => !lead.includes(id))].filter(id => TOOL_LINES[id]);
}

const LEVEL_LABEL: Record<AccessLevel, string> = {
  viewer: 'Viewers',
  reviewer: 'Reviewers',
  builder: 'Builders',
  admin: 'Admins only',
  owner: 'The owner only',
};

export function buildHelpReply(params: {
  config: AppConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  role?: DossierRole;
}): string {
  const { config, userId, channelId, channelType, role } = params;
  const isDM = channelType === 'im' || channelType === 'mpim';
  // What the router does in audit mode: a channel request the check would
  // deny is still served, so the help must say the same (a DM is not).
  const auditServes = getConfiguredAccessControl(config).mode === 'audit' && !isDM;
  const marketing = enabledRepoKeys(config).includes('newton-marketing-web');

  const allowed: ToolId[] = [];
  const elsewhere: ToolId[] = [];
  const byLevel = new Map<AccessLevel, ToolId[]>();
  for (const id of orderFor(role)) {
    const tool = TOOLS.find(entry => entry.id === id);
    if (!tool) continue;
    const decision = evaluateCapability({ config, userId, channelId, channelType, capability: tool.capability });
    if (decision.allowed || auditServes) allowed.push(id);
    else if (decision.denyReason === 'CHANNEL_NOT_ENABLED') elsewhere.push(id);
    else byLevel.set(tool.requiredLevel, [...(byLevel.get(tool.requiredLevel) ?? []), id]);
  }

  const where = isDM ? 'here' : 'in this channel';
  if (allowed.length === 0) {
    return `I'm not set up for you ${where} yet. An admin can enable me; until then I can only answer this.`;
  }

  const lines: string[] = [];
  lines.push(
    `Here's what I can do for you ${where}. ${isDM ? 'Send me the ask in one message:' : 'Tag me with the ask in one message:'}`,
  );
  for (const id of allowed) {
    const line = id === 'change_code' && !marketing ? CHANGE_WITHOUT_MARKETING : (TOOL_LINES[id] as ToolLine);
    lines.push(`• *${line.what}.* _e.g. "${escapeForSlack(line.example)}"_`);
  }
  if (elsewhere.length > 0) {
    lines.push(`Not ${where}, but enabled for you elsewhere: ${elsewhere.map(shortName).join(', ')}.`);
  }
  for (const level of ['reviewer', 'builder', 'admin', 'owner'] as AccessLevel[]) {
    const ids = byLevel.get(level);
    if (ids?.length) lines.push(`${LEVEL_LABEL[level]}: ${ids.map(shortName).join(', ')}.`);
  }
  lines.push('');
  lines.push(
    'Tips: for a page change, give me the URL and a screenshot of what to change. Say "stop" to cancel a run. Ask me about any PR with its link.',
  );
  return lines.join('\n');
}

function shortName(id: ToolId): string {
  switch (id) {
    case 'answer':
      return 'questions';
    case 'change_code':
      return 'changes';
    case 'investigate':
      return 'investigations';
    case 'review_pr':
      return 'PR reviews';
    case 'qa_webapp':
      return 'browser QA';
    case 'deploy':
      return 'deploys';
    default:
      return id;
  }
}
