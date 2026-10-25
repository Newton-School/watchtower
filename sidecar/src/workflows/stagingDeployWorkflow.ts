import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability, getConfiguredAccessControl } from '../access/control.js';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { REPO_REGISTRY, repoPathOrNull } from '../repos/registry.js';
import { LOW_CONFIDENCE_STAGING_QUESTION, STAGING_TARGET_QUESTION, askRequester } from '../router/routeClarify.js';
import {
  MARKETING_REPO,
  isMainBranch,
  isMarketingPr,
  isSafeRef,
  mentionsProd,
  namesOtherApp,
  readStagingAsk,
} from '../router/stagingTarget.js';
import { buildSlackThreadLink } from './shared/workflowUtils.js';
import {
  __ghCli,
  dispatchWorkflowRun,
  isDeployDryRun,
  listWorkflowRuns,
  type DeployStateReader,
} from './shared/githubActionsRun.js';

/**
 * A marketing branch on the shared staging site, when someone asks for a
 * testing link or a staging deploy (issue #702, the owner's decision of
 * 2026-10-25). `deploy-staging.yml` takes any branch and staging keeps
 * whatever was dispatched last, so it runs only on request, never per PR.
 */

export { STAGING_TARGET_QUESTION };

const REPO_KEY = MARKETING_REPO;
const STAGING_WORKFLOW = 'deploy-staging.yml';

/** sidecar_state key: the last staging deploy miniOG ran, for the shared-staging heads-up. */
export const STAGING_STATE_KEY = 'staging_deploy:newton-marketing-web';
/** A branch miniOG put on staging longer ago than this is nobody's test any more. */
export const STAGING_HEADS_UP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** The compare API lists at most 300 files: a longer list may hide a workflow change. */
const COMPARE_FILE_LIMIT = 300;

export const STAGING_TARGET_GIVE_UP =
  "I still can't tell which PR or branch to put on staging. Mention me again with the PR link or the branch name.";
export const STAGING_PROD_WORD_REPLY =
  "Staging or production? Your message mentions production, so I haven't put anything on staging. For a testing link, ask again without mentioning prod. For production, ask me to deploy marketing to prod.";
const GITHUB_UNREACHABLE =
  "I couldn't reach GitHub to check that, so I haven't put anything on staging. Try again in a bit.";

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

/** A GitHub read: found, a real 404, or GitHub could not be asked. */
type Lookup<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'unreachable'; error: string };

type Target =
  | { kind: 'branch'; branch: string; pr?: PrInfo }
  | { kind: 'ask' }
  | { kind: 'refuse'; message: string; status?: 'FAILED' };

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
  if (!previous || isMainBranch(previous.branch) || previous.branch === next.branch) return undefined;
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

const isNotFound = (error: unknown) => /\b404\b|not found/i.test(String(error));

async function ghJson<T>(args: string[], repoPath: string): Promise<T> {
  return JSON.parse((await __ghCli.exec(args, repoPath, 30_000)) || 'null') as T;
}

async function readPr(slug: string, number: number, repoPath: string): Promise<Lookup<PrInfo>> {
  try {
    const pr = await ghJson<{
      html_url?: string;
      number?: number;
      state?: string;
      merged?: boolean;
      head?: { ref?: string; repo?: { full_name?: string } | null };
      base?: { repo?: { full_name?: string } | null };
    }>(['api', `repos/${slug}/pulls/${number}`], repoPath);
    if (!pr || typeof pr.number !== 'number') return { kind: 'missing' };
    return {
      kind: 'found',
      value: {
        url: pr.html_url ?? `https://github.com/${slug}/pull/${number}`,
        number: pr.number,
        headRef: pr.head?.ref,
        headRepo: pr.head?.repo?.full_name ?? undefined,
        baseRepo: pr.base?.repo?.full_name ?? undefined,
        state: pr.state,
        merged: pr.merged,
      },
    };
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'unreachable', error: String(error) };
  }
}

async function readBranch(slug: string, branch: string, repoPath: string): Promise<Lookup<string>> {
  if (isMainBranch(branch)) return { kind: 'found', value: branch };
  try {
    const found = await ghJson<{ name?: string }>(['api', `repos/${slug}/branches/${branch}`], repoPath);
    return found?.name === branch ? { kind: 'found', value: branch } : { kind: 'missing' };
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'unreachable', error: String(error) };
  }
}

/** What a branch changes against main. Throws when GitHub can't be asked. */
async function compareToMain(slug: string, branch: string, repoPath: string): Promise<string[]> {
  const stdout = await __ghCli.exec(
    ['api', `repos/${slug}/compare/main...${branch}`, '--jq', '.files[].filename'],
    repoPath,
    30_000,
  );
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
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
  const text = task.event.text ?? '';
  const answeringWhich = task.clarification?.question === STAGING_TARGET_QUESTION;
  // The message first; a reply to a question is read with the message it answers.
  const asks = [readStagingAsk(text, { answeringWhich })];
  if (task.clarification?.askedText) asks.push(readStagingAsk(task.clarification.askedText));
  const org = config.allowedPrOrg;
  const prs = task.prContexts ?? [];
  const triggerPrs = prs.filter(pr => pr.source === 'trigger');

  // Another app's ask never falls back to a marketing PR from earlier in the thread.
  const otherInMessage = triggerPrs.find(pr => !isMarketingPr(pr, org));
  if (!triggerPrs.some(pr => isMarketingPr(pr, org))) {
    if (otherInMessage) {
      return {
        kind: 'refuse',
        message: `I only put ${REPO_KEY} changes on staging, and <${otherInMessage.url}|that PR> is in ${otherInMessage.repo}.`,
      };
    }
    if (namesOtherApp(text)) return { kind: 'refuse', message: `I only put ${REPO_KEY} changes on staging.` };
  }

  // Not a refusal: GitHub could not be asked, so the run failed.
  const unreachable = (): Target => ({ kind: 'refuse', message: GITHUB_UNREACHABLE, status: 'FAILED' });
  const fromPr = async (numbers: number[]): Promise<Target | undefined> => {
    if (numbers.length === 0) return undefined;
    if (numbers.length > 1) return { kind: 'ask' };
    const pr = await readPr(slug, numbers[0], repoPath);
    if (pr.kind === 'unreachable') return unreachable();
    if (pr.kind === 'missing') return { kind: 'refuse', message: `I couldn't find PR #${numbers[0]} in ${REPO_KEY}.` };
    return prTarget(pr.value, slug);
  };

  for (const ask of asks) {
    if (!ask.explicitBranch) continue;
    const branch = await readBranch(slug, ask.explicitBranch, repoPath);
    if (branch.kind === 'unreachable') return unreachable();
    if (branch.kind === 'missing') {
      return { kind: 'refuse', message: `I can't find a branch named \`${ask.explicitBranch}\` in ${REPO_KEY}.` };
    }
    return { kind: 'branch', branch: branch.value };
  }

  // A PR named in the message beats main mentioned in it.
  const inMessage = [
    ...new Set([
      ...asks.flatMap(ask => ask.prNumbers),
      ...triggerPrs.filter(pr => isMarketingPr(pr, org)).map(pr => pr.number),
    ]),
  ];
  const named = await fromPr(inMessage);
  if (named) return named;

  if (asks.some(ask => ask.main)) return { kind: 'branch', branch: 'main' };

  // Bare `team/topic` words may be words ("UI/UX"): the first that exists wins.
  for (const candidate of asks.flatMap(ask => ask.looseBranches)) {
    const branch = await readBranch(slug, candidate, repoPath);
    if (branch.kind === 'unreachable') return unreachable();
    if (branch.kind === 'found') return { kind: 'branch', branch: branch.value };
  }

  const inThread = [
    ...new Set(prs.filter(pr => pr.source === 'thread' && isMarketingPr(pr, org)).map(pr => pr.number)),
  ];
  const fromThread = await fromPr(inThread);
  if (fromThread) return fromThread;

  const other = prs.find(pr => !isMarketingPr(pr, org));
  if (other) {
    return {
      kind: 'refuse',
      message: `I only put ${REPO_KEY} changes on staging, and <${other.url}|that PR> is in ${other.repo}.`,
    };
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
  const refuse = async (message: string, status: WorkflowResult['status'] = 'SKIPPED') => {
    logStep?.({ stage: 'staging.refused', message });
    return result(status, message, await say(message));
  };

  // The router checked this already; this covers a caller that did not go
  // through it (the production deploy handing a staging ask over). Same
  // rule as the router: audit mode lets a channel ask through, a DM never,
  // and a run on an owner's lent authority is the router's call (issue #398).
  const access = evaluateCapability({ config, userId, channelId, channelType, capability: 'start_implementation' });
  if (
    !task.delegatedByOwnerId &&
    !access.allowed &&
    (getConfiguredAccessControl(config).mode === 'enforce' || isDirect(channelType))
  ) {
    const msg = access.reason ?? 'Putting a branch on staging is for builders and admins.';
    logStep?.({ stage: 'staging.denied', message: msg, level: 'WARN', data: { denyReason: access.denyReason } });
    return result('SKIPPED', msg, await say(msg));
  }

  // A message that says production is never turned into a staging deploy,
  // whatever picked this tool.
  if (mentionsProd(task.event.text ?? '')) return refuse(STAGING_PROD_WORD_REPLY);

  const repoPath = repoPathOrNull(config, REPO_KEY);
  if (!repoPath) {
    return refuse(
      `The ${REPO_KEY} clone isn't configured on this host, so I can't put it on staging. Set newton_marketing_web_path in Watchtower settings.`,
    );
  }
  const repo = REPO_REGISTRY[REPO_KEY];
  const slug = repo.githubSlug;
  const host = repo.deploy.method === 'github-actions' ? repo.deploy.stagingHost : undefined;

  const target = await resolveTarget({ task, config, slug, repoPath });
  if (signal?.aborted) return result('CANCELLED', 'Cancelled.', false);
  if (target.kind === 'ask') {
    // One question per chain: a second unclear reply to it gets this, not the question again.
    const asked = task.clarification?.question;
    if (asked === STAGING_TARGET_QUESTION || asked === LOW_CONFIDENCE_STAGING_QUESTION) {
      logStep?.({ stage: 'staging.gave_up', message: STAGING_TARGET_GIVE_UP });
      return result('SKIPPED', STAGING_TARGET_GIVE_UP, await say(STAGING_TARGET_GIVE_UP));
    }
    const parked = await askRequester({
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
    return { ...parked, workflow: 'STAGING_DEPLOY' };
  }
  if (target.kind === 'refuse') return refuse(target.message, target.status);

  const { branch, pr } = target;
  // Named branches are parsed to this shape already; a PR's head ref may be
  // anything git allows, and it goes to `gh` and into other threads' text.
  if (!isSafeRef(branch)) {
    return refuse("That PR's branch name has characters I can't pass on safely, so I haven't put it on staging.");
  }

  // `--ref` runs the branch's own copy of the workflow, with the staging
  // secrets: a branch that changes anything under .github/ is not run.
  let files: string[] = [];
  if (!isMainBranch(branch)) {
    try {
      files = await compareToMain(slug, branch, repoPath);
    } catch (error) {
      logStep?.({
        stage: 'staging.compare_failed',
        level: 'WARN',
        message: `Couldn't compare ${branch}: ${String(error)}`,
      });
      return refuse(`I couldn't check what \`${branch}\` changes, so I haven't put it on staging. Try again in a bit.`);
    }
    if (files.length >= COMPARE_FILE_LIMIT) {
      return refuse(`\`${branch}\` changes too many files for me to check, so I haven't put it on staging.`);
    }
    if (files.some(file => file.startsWith('.github/'))) {
      return refuse(
        `\`${branch}\` changes files under .github/, and its own copy of the deploy workflow would run with the staging secrets, so I haven't put it on staging. A developer can deploy it from GitHub Actions after checking that change.`,
      );
    }
  }

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

  if (outcome.kind === 'stopped') return result('CANCELLED', 'Stopped before the staging deploy started.', false);
  if (outcome.kind === 'dispatch_failed') {
    logStep?.({
      stage: 'staging.dispatch_failed',
      level: 'ERROR',
      message: `Couldn't dispatch ${STAGING_WORKFLOW} on ${branch}: ${outcome.error}`,
    });
    return refuse(
      `Couldn't start the staging deploy of \`${branch}\`. Check the Deploy → staging workflow in GitHub Actions.`,
      'FAILED',
    );
  }

  const record: StagingRecord = { branch, prUrl: pr?.url, channelId, channelType, threadTs, atMs: __stagingDeps.now() };
  const runId = 'id' in outcome ? outcome.id : undefined;
  const runLink = (url?: string) =>
    url ? ` Run: ${url}` : ' Check the latest Deploy → staging run in GitHub Actions.';

  // Stopped after the dispatch went out: the deploy carries on in GitHub
  // and will replace staging, so say that, and keep the record true.
  if (signal?.aborted && outcome.kind !== 'completed') {
    const url = 'url' in outcome ? outcome.url : undefined;
    const msg = `Stopped. The staging deploy of \`${branch}\` had already started, so it carries on in GitHub Actions and will replace what's on staging.${runLink(url)}`;
    logStep?.({ stage: 'staging.stopped', message: msg, level: 'WARN', data: { branch, runId: runId ?? null } });
    await noteStagingDeploy({ store, slack, repoPath, next: record, logStep });
    return result('CANCELLED', msg, await say(msg));
  }

  let msg: string;
  let status: WorkflowResult['status'] = 'SUCCESS';
  let wentUp = false;
  if (outcome.kind === 'completed' && outcome.conclusion === 'success') {
    wentUp = true;
    const routes =
      files.length > 0 ? routesForChangedFiles(files, await __stagingDeps.listAppPages(repoPath).catch(() => [])) : [];
    const links = host ? (routes.length > 0 ? routes : ['/']).map(route => `<https://${host}${route}>`) : [];
    msg = `\`${branch}\` is on staging${links.length > 0 ? `: ${links.join(' and ')}` : ''}. Staging is shared, so the next staging deploy replaces it.`;
  } else if (outcome.kind === 'completed' && outcome.conclusion === 'cancelled') {
    // Not a failure of this ask, and the cause is GitHub's to tell.
    status = 'SKIPPED';
    const newer = await newerStagingRun(repoPath, outcome.id);
    msg = newer
      ? `The staging deploy of \`${branch}\` was cancelled: a newer staging deploy${newer.headBranch && isSafeRef(newer.headBranch) ? ` of \`${newer.headBranch}\`` : ''} replaced it.${runLink(outcome.url)}`
      : `The staging deploy of \`${branch}\` was cancelled in GitHub.${runLink(outcome.url)}`;
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
      runId: runId ?? null,
      conclusion: outcome.kind === 'completed' ? (outcome.conclusion ?? null) : null,
    },
  });
  const posted = await say(msg);

  // A deploy that failed or was cancelled left staging as it was. One still
  // going will most likely land: recorded, but nobody is told yet.
  if (outcome.kind !== 'completed' || wentUp) {
    await noteStagingDeploy({ store, slack, repoPath, next: record, runId: wentUp ? runId : undefined, logStep });
  }
  return result(status, msg, posted);
}

/** The newest staging run, when it is newer than `runId`. Best effort. */
async function newerStagingRun(repoPath: string, runId: number) {
  try {
    const [newest] = await listWorkflowRuns({ repoPath, workflowFile: STAGING_WORKFLOW, limit: 1 });
    return newest && newest.id > runId ? newest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records the deploy, and when `runId` says it went live, tells the thread
 * whose branch it replaced. People also deploy staging from GitHub, which
 * the record can't see: the heads-up is posted only when the last successful
 * staging run before this one was the recorded branch. Never throws.
 */
async function noteStagingDeploy(params: {
  store?: StagingDeployStore;
  slack: WebClient;
  repoPath: string;
  next: StagingRecord;
  /** The run that put `next` on staging; without it nobody is told. */
  runId?: number;
  logStep?: WorkflowStepLogger;
}): Promise<void> {
  const { store, slack, repoPath, next, runId, logStep } = params;
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
  if (runId === undefined) return;
  const headsUp = stagingHeadsUp({ previous, next, nowMs: next.atMs });
  if (!headsUp || !previous) return;

  let before: string | undefined;
  try {
    const runs = await listWorkflowRuns({ repoPath, workflowFile: STAGING_WORKFLOW, status: 'success', limit: 10 });
    before = runs.find(run => run.id < runId)?.headBranch;
  } catch {
    before = undefined;
  }
  if (before !== previous.branch) {
    logStep?.({
      stage: 'staging.heads_up_skipped',
      message: `Staging last showed ${before ?? 'an unknown branch'}, not the recorded ${previous.branch}: no heads-up.`,
    });
    return;
  }
  try {
    await slack.chat.postMessage({ channel: headsUp.channelId, thread_ts: headsUp.threadTs, text: headsUp.text });
    logStep?.({
      stage: 'staging.heads_up',
      message: `Told the thread that had ${previous.branch} on staging that it was replaced.`,
      data: { channelId: headsUp.channelId, threadTs: headsUp.threadTs, replacedBranch: previous.branch },
    });
  } catch (error) {
    logStep?.({
      stage: 'staging.heads_up_failed',
      level: 'WARN',
      message: `Couldn't post the heads-up: ${String(error)}`,
    });
  }
}
