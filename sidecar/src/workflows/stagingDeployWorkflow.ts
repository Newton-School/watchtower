import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability, getConfiguredAccessControl } from '../access/control.js';
import type { AppConfig, NormalizedTask, PrTarget, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { REPO_REGISTRY, repoPathOrNull } from '../repos/registry.js';
import { askRequester } from '../router/routeClarify.js';
import { buildSlackThreadLink } from './shared/workflowUtils.js';
import { __ghCli, dispatchWorkflowRun, isDeployDryRun, type DeployStateReader } from './shared/githubActionsRun.js';

/**
 * A marketing branch on the shared staging site, when someone asks for a
 * testing link or a staging deploy (issue #702, the owner's decision of
 * 2026-10-25). `deploy-staging.yml` takes any branch and staging keeps
 * whatever was dispatched last, so it runs only on request, never per PR.
 */

const REPO_KEY = 'newton-marketing-web';
const STAGING_WORKFLOW = 'deploy-staging.yml';

/** sidecar_state key: the last staging deploy miniOG ran, for the shared-staging heads-up. */
export const STAGING_STATE_KEY = 'staging_deploy:newton-marketing-web';
/** A branch miniOG put on staging longer ago than this is nobody's test any more. */
export const STAGING_HEADS_UP_WINDOW_MS = 2 * 60 * 60 * 1000;

export const STAGING_TARGET_QUESTION = 'Which PR or branch should I put on staging?';
export const STAGING_TARGET_GIVE_UP =
  "I still can't tell which PR or branch to put on staging. Mention me again with the PR link or the branch name.";

export type StagingDeployStore = DeployStateReader & {
  setState?(key: string, value: string): void;
  pausedJobForThread?: (channelId: string, threadTs: string) => unknown;
};

/** What miniOG records about a staging deploy it ran. */
export interface StagingRecord {
  branch: string;
  prUrl?: string;
  channelId: string;
  channelType?: string;
  threadTs: string;
  atMs: number;
}

/** Test seams: the clock and the clone's app pages. */
export const __stagingDeps = {
  now: (): number => Date.now(),
  listAppPages: listAppPagesInClone,
};

interface PrInfo {
  url: string;
  number: number;
  headRef?: string;
  headRepo?: string;
  baseRepo?: string;
  state?: string;
  merged?: boolean;
}

type Target = { kind: 'branch'; branch: string; pr?: PrInfo } | { kind: 'ask' } | { kind: 'refuse'; message: string };

const MAIN_BRANCHES = new Set(['main', 'master']);
const NOT_BRANCHES = new Set([
  ...['to', 'on', 'onto', 'in', 'of', 'the', 'that', 'this', 'it', 'for', 'is', 'name', 'please'],
  ...['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'no', 'nope', 'go', 'thanks'],
]);
const SLASH_WORDS = new Set(['and/or', 'either/or', 'w/o', 'n/a', 'i/o', 'on/off', 'yes/no', 'he/she', 'his/her']);
/** Another app named, with no PR or branch of the marketing site to go on. */
const OTHER_APP_RE = /\b(?:newton[- ]web|newton[- ]api|backend|my\.newtonschool)\b/;
const BRANCH_TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]|[A-Za-z0-9]`;

/** The message as words: no mentions, links, channel references or "Sent using" footer. */
function plainText(text: string): string {
  return text
    .replace(/\*sent using\*.*$/is, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The branch a message names, if it names one: "branch fix/hero", a
 * backticked name, a bare `team/topic` name, or main ("put main back on
 * staging"). `explicit` is false for a bare slash name, which could be words.
 * A reply that is only a name, to the question asking for one, is explicit.
 */
export function namedStagingBranch(
  text: string,
  options: { answering?: boolean } = {},
): { branch: string; explicit: boolean } | undefined {
  const plain = plainText(text);
  const lower = plain.toLowerCase();
  const clean = (name: string) => name.replace(/[.,;:!?)]+$/, '');

  if (options.answering) {
    const only = /^[`'"]?([A-Za-z0-9][A-Za-z0-9._/-]*)[`'"]?[.!]?$/.exec(plain);
    if (only && !NOT_BRANCHES.has(only[1].toLowerCase()) && !/^\d+$/.test(only[1])) {
      return { branch: clean(only[1]), explicit: true };
    }
  }

  const named = new RegExp(String.raw`\bbranch\s+[\`'"]?(${BRANCH_TOKEN})`, 'i').exec(plain);
  if (named && !NOT_BRANCHES.has(named[1].toLowerCase())) return { branch: clean(named[1]), explicit: true };

  const ticked = /`([A-Za-z0-9][A-Za-z0-9._/-]*)`/.exec(plain);
  if (ticked && ticked[1].includes('/')) return { branch: clean(ticked[1]), explicit: true };

  const mainAsSubject =
    /\b(?:deploy|put|push|ship|restore|move|switch|reset|bring)\s+(?:(?:the|marketing|newton-marketing-web|staging)\s+)*(?:back\s+)?(?:to\s+)?(main|master)(?=\s+(?:branch|back|to|on|onto|in|please|now)\b|\s*$|[.,!?])/.exec(
      lower,
    ) ??
    /\b(main|master)\s+(?:branch\s+)?(?:back\s+)?(?:to|on|onto)\s+(?:the\s+)?(?:marketing\s+)?(?:staging|stg)\b/.exec(
      lower,
    ) ??
    /\b(?:staging|stg)\s+back\s+to\s+(main|master)\b/.exec(lower);
  if (mainAsSubject) return { branch: mainAsSubject[1], explicit: true };

  for (const match of plain.matchAll(new RegExp(String.raw`(?:^|\s)(${BRANCH_TOKEN})(?=$|[\s,.!?;:)])`, 'g'))) {
    const token = clean(match[1]);
    if (!token.includes('/') || SLASH_WORDS.has(token.toLowerCase()) || !/[A-Za-z]/.test(token)) continue;
    return { branch: token, explicit: false };
  }
  return undefined;
}

/** PR numbers a message names without a link: "PR #1484", "pull request 12", "#1484". */
export function namedPrNumbers(text: string): number[] {
  const plain = plainText(text);
  const numbers = new Set<number>();
  for (const match of plain.matchAll(/\b(?:pr|pull request)\s*#?\s*(\d{2,6})\b|(?:^|\s)#(\d{2,6})\b/gi)) {
    numbers.add(Number(match[1] ?? match[2]));
  }
  return [...numbers];
}

/**
 * The route a Next.js App Router page file serves: route groups `(x)` are
 * dropped. Undefined for a file that is not a page, or a dynamic route that
 * has no single URL.
 */
export function routeForAppPage(file: string): string | undefined {
  const match = /^src\/app\/(?:(.*)\/)?page\.(?:tsx|ts|jsx|js)$/.exec(file);
  if (!match) return undefined;
  const segments = (match[1] ?? '').split('/').filter(segment => segment && !/^\(.*\)$/.test(segment));
  if (segments.some(segment => /^[[@_]/.test(segment))) return undefined;
  return `/${segments.join('/')}`;
}

/**
 * Pages a change shows up on, at most two: the pages it edits, or else the
 * pages that import a feature it edits (`src/features/<name>/…`).
 */
export function routesForChangedFiles(
  files: string[],
  appPages: Array<{ file: string; source: string }>,
  limit = 2,
): string[] {
  const pick = (routes: string[]) =>
    [...new Set(routes)].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);

  const direct = files.map(routeForAppPage).filter((route): route is string => Boolean(route));
  if (direct.length > 0) return pick(direct);

  const features = [
    ...new Set(
      files.map(file => /^src\/features\/([^/]+)\//.exec(file)?.[1]).filter((name): name is string => Boolean(name)),
    ),
  ];
  const routes: string[] = [];
  for (const feature of features) {
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importsIt = new RegExp(String.raw`(?:@|/)features/${escaped}(?:['"/])`);
    for (const page of appPages) {
      const route = routeForAppPage(page.file);
      if (route && importsIt.test(page.source)) routes.push(route);
    }
  }
  return pick(routes);
}

/** The app router's page files in the clone, relative to it, with their source. Best effort. */
async function listAppPagesInClone(repoPath: string): Promise<Array<{ file: string; source: string }>> {
  const pages: Array<{ file: string; source: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || pages.length >= 500) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') await walk(full, depth + 1);
      } else if (/^page\.(?:tsx|ts|jsx|js)$/.test(entry.name)) {
        try {
          const source = await fs.readFile(full, 'utf8');
          pages.push({
            file: path.relative(repoPath, full).split(path.sep).join('/'),
            source: source.slice(0, 200_000),
          });
        } catch {
          // an unreadable page is not one we can link to
        }
      }
    }
  };
  await walk(path.join(repoPath, 'src', 'app'), 0);
  return pages;
}

function parseRecord(raw: string | undefined): StagingRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StagingRecord>;
    if (
      typeof value.branch !== 'string' ||
      typeof value.channelId !== 'string' ||
      typeof value.threadTs !== 'string' ||
      typeof value.atMs !== 'number'
    ) {
      return undefined;
    }
    return value as StagingRecord;
  } catch {
    return undefined;
  }
}

const isDirect = (channelType?: string) => channelType === 'im' || channelType === 'mpim';

/**
 * The line posted in an earlier thread whose branch this deploy replaced, or
 * undefined when none is owed: main was there, the same branch, the same
 * thread, or it was put there more than two hours ago.
 */
export function stagingHeadsUp(params: {
  previous: StagingRecord | undefined;
  next: { branch: string; channelId: string; channelType?: string; threadTs: string };
  nowMs: number;
}): { channelId: string; threadTs: string; text: string } | undefined {
  const { previous, next, nowMs } = params;
  if (!previous || MAIN_BRANCHES.has(previous.branch) || previous.branch === next.branch) return undefined;
  if (previous.channelId === next.channelId && previous.threadTs === next.threadTs) return undefined;
  if (nowMs - previous.atMs >= STAGING_HEADS_UP_WINDOW_MS) return undefined;
  const linkable =
    previous.channelId === next.channelId && !isDirect(previous.channelType) && !isDirect(next.channelType);
  const where = linkable
    ? ` (asked in <${buildSlackThreadLink(next.channelId, next.threadTs)}|another thread>)`
    : ' for another request';
  return {
    channelId: previous.channelId,
    threadTs: previous.threadTs,
    text: `Heads-up: staging now shows \`${next.branch}\`${where}. Ask me again when you need your link.`,
  };
}

async function ghJson<T>(args: string[], repoPath: string): Promise<T> {
  return JSON.parse((await __ghCli.exec(args, repoPath, 30_000)) || 'null') as T;
}

async function readPr(slug: string, number: number, repoPath: string): Promise<PrInfo | undefined> {
  try {
    const pr = await ghJson<{
      html_url?: string;
      number?: number;
      state?: string;
      merged?: boolean;
      head?: { ref?: string; repo?: { full_name?: string } | null };
      base?: { repo?: { full_name?: string } | null };
    }>(['api', `repos/${slug}/pulls/${number}`], repoPath);
    if (!pr || typeof pr.number !== 'number') return undefined;
    return {
      url: pr.html_url ?? `https://github.com/${slug}/pull/${number}`,
      number: pr.number,
      headRef: pr.head?.ref,
      headRepo: pr.head?.repo?.full_name ?? undefined,
      baseRepo: pr.base?.repo?.full_name ?? undefined,
      state: pr.state,
      merged: pr.merged,
    };
  } catch {
    return undefined;
  }
}

async function branchExists(slug: string, branch: string, repoPath: string): Promise<boolean> {
  if (MAIN_BRANCHES.has(branch)) return true;
  try {
    const found = await ghJson<{ name?: string }>(['api', `repos/${slug}/branches/${branch}`], repoPath);
    return found?.name === branch;
  } catch {
    return false;
  }
}

async function changedFiles(slug: string, target: { branch: string; pr?: PrInfo }, repoPath: string) {
  if (MAIN_BRANCHES.has(target.branch)) return [];
  const args = target.pr
    ? ['api', `repos/${slug}/pulls/${target.pr.number}/files?per_page=100`, '--jq', '.[].filename']
    : ['api', `repos/${slug}/compare/main...${target.branch}`, '--jq', '.files[].filename'];
  try {
    const stdout = await __ghCli.exec(args, repoPath, 30_000);
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The PR's branch, or why it can't go on staging. */
function prTarget(pr: PrInfo, slug: string): Target {
  const label = `<${pr.url}|PR #${pr.number}>`;
  if (pr.merged) {
    return { kind: 'refuse', message: `${label} is already merged. Ask me to put main on staging to see it there.` };
  }
  if (pr.state && pr.state !== 'open') {
    return { kind: 'refuse', message: `${label} is closed, so I'm not putting it on staging.` };
  }
  if (!pr.headRef || !pr.headRepo || pr.headRepo.toLowerCase() !== (pr.baseRepo ?? slug).toLowerCase()) {
    return {
      kind: 'refuse',
      message: `${label} comes from a fork, and I can only put branches of ${REPO_KEY} itself on staging.`,
    };
  }
  return { kind: 'branch', branch: pr.headRef, pr };
}

async function resolveTarget(params: {
  task: NormalizedTask;
  config: AppConfig;
  slug: string;
  repoPath: string;
}): Promise<Target> {
  const { task, config, slug, repoPath } = params;
  // Only a reply to "which PR or branch?" may be a bare name; a "yes" to the
  // router's "do you want it on staging?" is not a branch called yes.
  const answeringWhich = task.clarification?.question === STAGING_TARGET_QUESTION;
  const texts = [task.event.text ?? '', task.clarification?.askedText ?? ''].filter(Boolean);

  for (const text of texts) {
    const named = namedStagingBranch(text, { answering: answeringWhich && text === task.event.text });
    if (!named) continue;
    if (await branchExists(slug, named.branch, repoPath)) return { kind: 'branch', branch: named.branch };
    if (named.explicit) {
      return { kind: 'refuse', message: `I can't find a branch named \`${named.branch}\` in ${REPO_KEY}.` };
    }
  }

  const org = config.allowedPrOrg.toLowerCase();
  const isMarketing = (pr: PrTarget) => pr.repo.toLowerCase() === REPO_KEY && pr.owner.toLowerCase() === org;
  const prs = task.prContexts ?? [];
  const pick = async (numbers: number[]): Promise<Target | undefined> => {
    if (numbers.length === 0) return undefined;
    if (numbers.length > 1) return { kind: 'ask' };
    const pr = await readPr(slug, numbers[0], repoPath);
    if (!pr) return { kind: 'refuse', message: `I couldn't find PR #${numbers[0]} in ${REPO_KEY}.` };
    return prTarget(pr, slug);
  };

  const inMessage = [
    ...new Set([
      ...texts.flatMap(namedPrNumbers),
      ...prs.filter(pr => pr.source === 'trigger' && isMarketing(pr)).map(pr => pr.number),
    ]),
  ];
  const fromMessage = await pick(inMessage);
  if (fromMessage) return fromMessage;

  const inThread = [...new Set(prs.filter(pr => pr.source === 'thread' && isMarketing(pr)).map(pr => pr.number))];
  const fromThread = await pick(inThread);
  if (fromThread) return fromThread;

  const other = prs.find(pr => !isMarketing(pr));
  if (other) {
    return {
      kind: 'refuse',
      message: `I only put ${REPO_KEY} changes on staging, and <${other.url}|that PR> is in ${other.repo}.`,
    };
  }
  if (texts.some(text => OTHER_APP_RE.test(plainText(text).toLowerCase()))) {
    return { kind: 'refuse', message: `I only put ${REPO_KEY} changes on staging.` };
  }
  return { kind: 'ask' };
}

export async function runStagingDeployWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: StagingDeployStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep, signal } = params;
  const { channelId, threadTs, channelType, userId } = task.event;
  const say = (text: string) =>
    slack.chat
      .postMessage({ channel: channelId, thread_ts: threadTs, text })
      .then(() => true)
      .catch(() => false);
  const result = (status: WorkflowResult['status'], message: string, slackPosted: boolean): WorkflowResult => ({
    workflow: 'STAGING_DEPLOY',
    status,
    message,
    notifyDesktop: status === 'FAILED',
    slackPosted,
  });

  // The router checked this already; this covers a caller that did not go
  // through it (the production deploy handing a staging ask over). Same
  // rule as the router: audit mode lets a channel ask through, a DM never.
  const access = evaluateCapability({ config, userId, channelId, channelType, capability: 'start_implementation' });
  if (!access.allowed && (getConfiguredAccessControl(config).mode === 'enforce' || isDirect(channelType))) {
    const msg = access.reason ?? 'Putting a branch on staging is for builders and admins.';
    logStep?.({ stage: 'staging.denied', message: msg, level: 'WARN', data: { denyReason: access.denyReason } });
    return result('SKIPPED', msg, await say(msg));
  }

  const repoPath = repoPathOrNull(config, REPO_KEY);
  if (!repoPath) {
    const msg = `The ${REPO_KEY} clone isn't configured on this host, so I can't put it on staging. Set newton_marketing_web_path in Watchtower settings.`;
    return result('SKIPPED', msg, await say(msg));
  }
  const repo = REPO_REGISTRY[REPO_KEY];
  const slug = repo.githubSlug;
  const host = repo.deploy.method === 'github-actions' ? repo.deploy.stagingHost : undefined;

  const target = await resolveTarget({ task, config, slug, repoPath });
  if (signal?.aborted) return result('CANCELLED', 'Cancelled.', false);
  if (target.kind === 'ask') {
    if (task.clarification) {
      logStep?.({ stage: 'staging.gave_up', message: STAGING_TARGET_GIVE_UP });
      return result('SKIPPED', STAGING_TARGET_GIVE_UP, await say(STAGING_TARGET_GIVE_UP));
    }
    const asked = await askRequester({
      slack,
      store: store ?? {},
      task,
      userMessage: (task.event.text ?? '')
        .replace(/<@[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      question: STAGING_TARGET_QUESTION,
      reason: 'staging_target',
      logStep,
    });
    return { ...asked, workflow: 'STAGING_DEPLOY' };
  }
  if (target.kind === 'refuse') {
    logStep?.({ stage: 'staging.refused', message: target.message });
    return result('SKIPPED', target.message, await say(target.message));
  }

  const { branch, pr } = target;
  logStep?.({
    stage: 'staging.target',
    message: `Putting ${branch} on staging${pr ? ` (${pr.url})` : ''}.`,
    data: { branch, prUrl: pr?.url ?? null },
  });

  if (isDeployDryRun(store)) {
    const msg = `Dry run: this is where I would put \`${branch}\` on staging. Nothing was deployed.`;
    logStep?.({ stage: 'staging.dry_run', message: msg, level: 'WARN', data: { branch } });
    return result('SUCCESS', msg, await say(msg));
  }

  await say(`Putting \`${branch}\` on staging, about 3 minutes.`);
  const outcome = await dispatchWorkflowRun({
    repoPath,
    workflowFile: STAGING_WORKFLOW,
    ref: branch,
    filterByRef: true,
    signal,
    logStep,
    stagePrefix: 'staging',
  });

  if (outcome.kind === 'dispatch_failed') {
    const msg = `Couldn't start the staging deploy of \`${branch}\`: ${outcome.error}`;
    logStep?.({ stage: 'staging.dispatch_failed', message: msg, level: 'ERROR' });
    return result('FAILED', msg, await say(msg));
  }
  // Dispatched: the deploy carries on in GitHub Actions whatever happens here.
  if (signal?.aborted) {
    logStep?.({ stage: 'staging.stopped', message: 'Stopped while the staging deploy ran; it carries on in GitHub.' });
    return result('CANCELLED', 'Stopped while the staging deploy was running; it carries on in GitHub Actions.', false);
  }

  const runLink = (url?: string) =>
    url ? ` Run: ${url}` : ' Check the latest Deploy → staging run in GitHub Actions.';
  let msg: string;
  let status: WorkflowResult['status'] = 'SUCCESS';
  if (outcome.kind === 'completed' && outcome.conclusion === 'success') {
    const files = await changedFiles(slug, target, repoPath);
    const routes =
      files.length > 0 ? routesForChangedFiles(files, await __stagingDeps.listAppPages(repoPath).catch(() => [])) : [];
    const links = host ? (routes.length > 0 ? routes : ['/']).map(route => `<https://${host}${route}>`) : [];
    msg = `\`${branch}\` is on staging${links.length > 0 ? `: ${links.join(' and ')}` : ''}. Staging is shared, so the next staging deploy replaces it.`;
  } else if (outcome.kind === 'completed' && outcome.conclusion === 'cancelled') {
    status = 'FAILED';
    msg = `The staging deploy of \`${branch}\` was cancelled: a newer staging deploy started before it finished.${runLink(outcome.url)}`;
  } else if (outcome.kind === 'completed') {
    status = 'FAILED';
    msg = `The staging deploy of \`${branch}\` failed.${runLink(outcome.url)}`;
  } else if (outcome.kind === 'waiting') {
    msg = `The staging deploy of \`${branch}\` is waiting for an approval in GitHub.${runLink(outcome.url)}`;
  } else if (outcome.kind === 'running') {
    msg = `The staging deploy of \`${branch}\` is still running.${runLink(outcome.url)}`;
  } else {
    msg = `I started the staging deploy of \`${branch}\`, but couldn't find its run to follow. Check the latest Deploy → staging run in GitHub Actions.`;
  }

  logStep?.({
    stage: 'staging.done',
    message: msg,
    level: status === 'FAILED' ? 'WARN' : 'INFO',
    data: {
      branch,
      outcome: outcome.kind,
      conclusion: outcome.kind === 'completed' ? (outcome.conclusion ?? null) : null,
    },
  });
  const posted = await say(msg);

  if (outcome.kind === 'completed' && outcome.conclusion === 'success') {
    await noteStagingDeploy({
      store,
      slack,
      next: { branch, prUrl: pr?.url, channelId, channelType, threadTs, atMs: __stagingDeps.now() },
      logStep,
    });
  }
  return result(status, msg, posted);
}

/** Records the deploy, and tells the thread whose branch it replaced. Never throws. */
async function noteStagingDeploy(params: {
  store?: StagingDeployStore;
  slack: WebClient;
  next: StagingRecord;
  logStep?: WorkflowStepLogger;
}): Promise<void> {
  const { store, slack, next, logStep } = params;
  let previous: StagingRecord | undefined;
  try {
    previous = parseRecord(store?.getState(STAGING_STATE_KEY));
    store?.setState?.(STAGING_STATE_KEY, JSON.stringify(next));
  } catch (error) {
    logStep?.({
      stage: 'staging.record_failed',
      level: 'WARN',
      message: `Couldn't record the deploy: ${String(error)}`,
    });
  }
  const headsUp = stagingHeadsUp({ previous, next, nowMs: next.atMs });
  if (!headsUp) return;
  try {
    await slack.chat.postMessage({ channel: headsUp.channelId, thread_ts: headsUp.threadTs, text: headsUp.text });
    logStep?.({
      stage: 'staging.heads_up',
      message: `Told the thread that had ${previous?.branch} on staging that it was replaced.`,
      data: { channelId: headsUp.channelId, threadTs: headsUp.threadTs, replacedBranch: previous?.branch ?? null },
    });
  } catch (error) {
    logStep?.({
      stage: 'staging.heads_up_failed',
      level: 'WARN',
      message: `Couldn't post the heads-up: ${String(error)}`,
    });
  }
}
