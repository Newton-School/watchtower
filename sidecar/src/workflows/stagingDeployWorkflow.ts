import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability, getConfiguredAccessControl } from '../access/control.js';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { REPO_REGISTRY, repoPathOrNull } from '../repos/registry.js';
import { LOW_CONFIDENCE_STAGING_QUESTION, STAGING_TARGET_QUESTION, askRequester } from '../router/routeClarify.js';
import {
  MARKETING_REPO,
  asksForTestingLink,
  isMainBranch,
  isMarketingPr,
  isSafeRef,
  mentionsProd,
  namesOtherApp,
  readStagingAsk,
  type StagingAsk,
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
const NEWER_PUSH_NOTE = (branch: string) =>
  ` \`${branch}\` got a newer push after I checked it, so staging runs a commit I didn't check.`;
const emptyStagingAsk = (): StagingAsk => ({ main: false, looseBranches: [], prNumbers: [] });
export const MAIN_LATER_REPLY =
  "I haven't changed staging. When it's time, mention me with \"put main back on staging\" and I'll do it then.";
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
  headSha?: string;
  headRepo?: string;
  baseRepo?: string;
  state?: string;
  merged?: boolean;
}

/** A GitHub read: found, a real 404, or GitHub could not be asked. */
type Lookup<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'unreachable'; error: string };

type Target =
  /** `sha`: the commit checked before dispatch, when GitHub said which. */
  | { kind: 'branch'; branch: string; pr?: PrInfo; sha?: string }
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
      head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
      base?: { repo?: { full_name?: string } | null };
    }>(['api', `repos/${slug}/pulls/${number}`], repoPath);
    if (!pr || typeof pr.number !== 'number') return { kind: 'missing' };
    return {
      kind: 'found',
      value: {
        url: pr.html_url ?? `https://github.com/${slug}/pull/${number}`,
        number: pr.number,
        headRef: pr.head?.ref,
        headSha: pr.head?.sha,
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

/** A branch and the commit it points at now. Only exactly `main` is taken on trust. */
async function readBranch(
  slug: string,
  branch: string,
  repoPath: string,
): Promise<Lookup<{ name: string; sha?: string }>> {
  if (isMainBranch(branch)) return { kind: 'found', value: { name: branch } };
  try {
    const found = await ghJson<{ name?: string; commit?: { sha?: string } }>(
      ['api', `repos/${slug}/branches/${branch}`],
      repoPath,
    );
    return found?.name === branch
      ? { kind: 'found', value: { name: branch, sha: found.commit?.sha } }
      : { kind: 'missing' };
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'unreachable', error: String(error) };
  }
}

/** What a commit (or branch) changes against main. Throws when GitHub can't be asked. */
async function compareToMain(slug: string, ref: string, repoPath: string): Promise<string[]> {
  const stdout = await __ghCli.exec(
    ['api', `repos/${slug}/compare/main...${ref}`, '--jq', '.files[].filename'],
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
  return { kind: 'branch', branch: pr.headRef, pr, sha: pr.headSha };
}

/** Not a refusal: GitHub could not be asked, so the run failed. */
const UNREACHABLE_TARGET: Target = { kind: 'refuse', message: GITHUB_UNREACHABLE, status: 'FAILED' };

/**
 * What one message names, resolved on GitHub: a ref-like branch after
 * "branch", then a PR (named, or linked in it), then main, then loose names.
 * Undefined when it names nothing that exists.
 */
async function resolveNamed(
  ask: StagingAsk,
  linkedPrs: number[],
  ctx: { slug: string; repoPath: string },
): Promise<Target | undefined> {
  const { slug, repoPath } = ctx;
  if (ask.explicitBranch) {
    const branch = await readBranch(slug, ask.explicitBranch, repoPath);
    if (branch.kind === 'unreachable') return UNREACHABLE_TARGET;
    if (branch.kind === 'missing') {
      return { kind: 'refuse', message: `I can't find a branch named \`${ask.explicitBranch}\` in ${REPO_KEY}.` };
    }
    return { kind: 'branch', branch: branch.value.name, sha: branch.value.sha };
  }

  // A PR named in the message beats main mentioned in it.
  const numbers = [...new Set([...ask.prNumbers, ...linkedPrs])];
  if (numbers.length > 1) return { kind: 'ask' };
  if (numbers.length === 1) {
    const pr = await readPr(slug, numbers[0], repoPath);
    if (pr.kind === 'unreachable') return UNREACHABLE_TARGET;
    if (pr.kind === 'missing') return { kind: 'refuse', message: `I couldn't find PR #${numbers[0]} in ${REPO_KEY}.` };
    return prTarget(pr.value, slug);
  }

  if (ask.main) return { kind: 'branch', branch: 'main' };

  // Names that may be words ("UI/UX", "the branch is ready"): the first that exists wins.
  for (const candidate of ask.looseBranches) {
    const branch = await readBranch(slug, candidate, repoPath);
    if (branch.kind === 'unreachable') return UNREACHABLE_TARGET;
    if (branch.kind === 'found') return { kind: 'branch', branch: branch.value.name, sha: branch.value.sha };
  }
  return undefined;
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

  // The message on its own first. A reply to a question outranks the message
  // it answers ("no, put main on staging instead"); that one is read only
  // when the reply names nothing.
  const ctx = { slug, repoPath };
  const linked = triggerPrs.filter(pr => isMarketingPr(pr, org)).map(pr => pr.number);
  const ask = readStagingAsk(text, { answeringWhich });
  const fromMessage = await resolveNamed(ask, linked, ctx);
  if (fromMessage) return fromMessage;
  // main for later ("…back to main tomorrow") and nothing for now: not the thread's
  // PR. A testing-link ask beside it is for now, and goes on to the thread's PR.
  if (ask.mainLater && !asksForTestingLink(text)) return { kind: 'refuse', message: MAIN_LATER_REPLY };
  if (task.clarification?.askedText) {
    const fromAsked = await resolveNamed(readStagingAsk(task.clarification.askedText), [], ctx);
    if (fromAsked) return fromAsked;
  }

  const inThread = [
    ...new Set(prs.filter(pr => pr.source === 'thread' && isMarketingPr(pr, org)).map(pr => pr.number)),
  ];
  const fromThread = await resolveNamed(emptyStagingAsk(), inThread, ctx);
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

  const { branch, pr, sha: checkedSha } = target;
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
      // The commit GitHub named, so what is checked is what was named.
      files = await compareToMain(slug, checkedSha ?? branch, repoPath);
    } catch (error) {
      logStep?.({
        stage: 'staging.compare_failed',
        level: 'WARN',
        message: `Couldn't compare ${branch}: ${String(error)}`,
      });
      // Like GitHub being unreachable: it couldn't be checked, so the run failed.
      return refuse(
        `I couldn't check what \`${branch}\` changes, so I haven't put it on staging. Try again in a bit.`,
        'FAILED',
      );
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

  // Stopped while it checked: nothing started, and the stop said so itself.
  if (signal?.aborted) return result('CANCELLED', 'Stopped before the staging deploy started.', false);
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

  // Stopped before the dispatch went out. The stop already said "Stopped."; this
  // corrects the "Putting … on staging" line above it.
  if (outcome.kind === 'stopped') {
    const msg = 'Nothing was put on staging: it stopped before the deploy started.';
    logStep?.({ stage: 'staging.stopped', message: msg, data: { branch, dispatched: false } });
    return result('CANCELLED', msg, await say(msg));
  }
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
    // The stop already said "Stopped."
    const msg = `The staging deploy of \`${branch}\` had already started, so it carries on in GitHub Actions and will replace what's on staging.${runLink(url)}`;
    logStep?.({
      stage: 'staging.stopped',
      message: msg,
      level: 'WARN',
      data: { branch, dispatched: true, runId: runId ?? null },
    });
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

  // The run took the branch as it was at dispatch: a push after the check
  // means staging runs a commit nobody checked. It can't be undone; say so.
  const ranSha = 'headSha' in outcome ? outcome.headSha : undefined;
  if (checkedSha && ranSha && ranSha !== checkedSha) {
    if (wentUp || outcome.kind === 'waiting' || outcome.kind === 'running') msg += NEWER_PUSH_NOTE(branch);
    logStep?.({
      stage: 'staging.sha_mismatch',
      level: 'WARN',
      message: `Checked ${branch} at ${checkedSha}, but the staging run took ${ranSha}.`,
      data: { branch, checkedSha, ranSha, runId: runId ?? null },
    });
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

/** Said when main went back on staging after a merge (issue #703). */
export const STAGING_BACK_ON_MAIN = 'Staging is back on main.';

/**
 * After miniOG merged a marketing PR (issue #703): when the last staging
 * deploy put that PR's branch there and nothing has been dispatched since,
 * puts main back, so the next person to test doesn't see a merged branch.
 * Staging is left alone in every other case. Says one line when it is done
 * or could not be done; never throws.
 */
export async function putMainBackOnStagingAfterMerge(params: {
  config: AppConfig;
  slack: WebClient;
  store?: StagingDeployStore;
  channelId: string;
  channelType?: string;
  threadTs: string;
  /** Head branches of the PRs that were merged. */
  mergedBranches: string[];
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, slack, store, channelId, channelType, threadTs, logStep, signal } = params;
  const say = (text: string) =>
    slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).then(
      () => true,
      () => false,
    );
  try {
    const repoPath = repoPathOrNull(config, REPO_KEY);
    const merged = new Set(params.mergedBranches.filter(branch => branch && branch !== 'main'));
    if (!repoPath || merged.size === 0) return;

    // The newest run of any kind: one still going, or a later one of another
    // branch, means staging is someone else's now.
    let latest: Awaited<ReturnType<typeof listWorkflowRuns>>[number] | undefined;
    try {
      [latest] = await listWorkflowRuns({ repoPath, workflowFile: STAGING_WORKFLOW, limit: 1 });
    } catch (error) {
      logStep?.({
        stage: 'staging.restore.skipped',
        level: 'WARN',
        message: `Couldn't read the staging runs, so staging was left as it is: ${String(error)}`,
      });
      return;
    }
    const replaced = latest?.headBranch;
    const showsMerged =
      latest?.status === 'completed' &&
      latest.conclusion === 'success' &&
      replaced !== undefined &&
      merged.has(replaced);
    if (!showsMerged || replaced === undefined) {
      logStep?.({
        stage: 'staging.restore.skipped',
        message: `Staging doesn't show a merged branch (last run: ${replaced ?? 'none'}, ${latest?.status ?? '-'}/${latest?.conclusion ?? '-'}): left as it is.`,
      });
      return;
    }
    if (signal?.aborted) return;
    if (isDeployDryRun(store)) {
      const msg = 'Dry run: this is where I would put main back on staging. Nothing was deployed.';
      logStep?.({ stage: 'staging.restore.dry_run', message: msg, level: 'WARN' });
      await say(msg);
      return;
    }

    logStep?.({
      stage: 'staging.restore.start',
      message: `Staging shows ${replaced}, which was just merged: putting main back.`,
      data: { replacedBranch: replaced },
    });
    const outcome = await dispatchWorkflowRun({
      repoPath,
      workflowFile: STAGING_WORKFLOW,
      ref: 'main',
      filterByRef: true,
      signal,
      logStep,
      stagePrefix: 'staging.restore',
    });
    const record: StagingRecord = { branch: 'main', channelId, channelType, threadTs, atMs: __stagingDeps.now() };
    // Stopped: the stop says so itself. Once dispatched, main will most likely
    // land, so the record says so.
    if (outcome.kind === 'stopped') {
      logStep?.({ stage: 'staging.restore.stopped', message: 'Stopped before main went back on staging.' });
      return;
    }
    if (signal?.aborted && outcome.kind !== 'dispatch_failed') {
      logStep?.({ stage: 'staging.restore.stopped', message: `Stopped after main was dispatched (${outcome.kind}).` });
      await noteStagingDeploy({ store, slack, repoPath, next: record, headsUp: false, logStep });
      return;
    }
    if (outcome.kind === 'dispatch_failed') {
      logStep?.({
        stage: 'staging.restore.dispatch_failed',
        level: 'ERROR',
        message: `Couldn't dispatch ${STAGING_WORKFLOW} on main: ${outcome.error}`,
      });
      await say("I couldn't put main back on staging. Check the Deploy → staging workflow in GitHub Actions.");
      return;
    }
    const wentUp = outcome.kind === 'completed' && outcome.conclusion === 'success';
    const runId = 'id' in outcome ? outcome.id : undefined;
    const url = 'url' in outcome ? outcome.url : undefined;
    // A deploy that failed or was cancelled left staging as it was; one still going will most likely land.
    // What it replaced is the merged branch: its thread needs no heads-up (it is told here, or it is done).
    if (outcome.kind !== 'completed' || wentUp) {
      await noteStagingDeploy({ store, slack, repoPath, next: record, headsUp: false, logStep });
    }
    const runLink = url ? ` Run: ${url}` : '';
    const msg = wentUp
      ? STAGING_BACK_ON_MAIN
      : outcome.kind === 'completed'
        ? `Putting main back on staging didn't finish (${outcome.conclusion ?? 'unknown'}).${runLink}`
        : `Putting main back on staging is still going in GitHub Actions.${runLink}`;
    logStep?.({
      stage: 'staging.restore.done',
      message: msg,
      level: wentUp ? 'INFO' : 'WARN',
      data: { outcome: outcome.kind, runId: runId ?? null, replacedBranch: replaced },
    });
    await say(msg);
  } catch (error) {
    logStep?.({
      stage: 'staging.restore.failed',
      level: 'WARN',
      message: `Putting main back on staging failed: ${String(error)}`,
    });
  }
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
  /** False: record it, tell nobody (main going back after a merge, issue #703). */
  headsUp?: boolean;
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
  if (runId === undefined || params.headsUp === false) return;
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
