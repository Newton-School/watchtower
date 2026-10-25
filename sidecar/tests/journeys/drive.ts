/**
 * Runs a person's message through miniOG the way the intake does: the thread
 * read into `normalizeTask`, then `routeTask`, with the fakes from
 * `harness.ts` wired into the real workflows' seams.
 *
 * Import this only from a journey file that mocks the edges first (see any
 * `*.journey.test.ts` here): the mocks have to be in place before `src/` loads.
 */
import { vi } from 'vitest';
import type { AppConfig, WorkflowResult } from '../../src/types/contracts.js';
import { normalizeTask } from '../../src/router/intentParser.js';
import { routeTask } from '../../src/router/taskRouter.js';
import { __ghCli, __deployTiming } from '../../src/workflows/shared/githubActionsRun.js';
import { __contentMergeGh } from '../../src/workflows/implementationWorkflow.js';
import { __confirmationTiming } from '../../src/workflows/shared/confirmationGate.js';
import { __deployOfferClock, __deployOfferGh, __deployOfferTiming } from '../../src/workflows/marketingDeployOffer.js';
import { __stagingDeps } from '../../src/workflows/stagingDeployWorkflow.js';
import { __resetButtonRepliesForTests } from '../../src/slack/buttonReplies.js';
import { APP_PAGES, edge, FakeSlack, FakeStore, GitHubWorld, journeyConfig, NOW_MS } from './harness.js';

export interface Journey {
  world: GitHubWorld;
  slack: FakeSlack;
  store: FakeStore;
  config: AppConfig;
}

export interface Step {
  result: WorkflowResult;
  logs: Array<{ stage: string; message?: string; data?: Record<string, unknown> }>;
  /** What miniOG posted in the thread during this step, in order. */
  said: string[];
}

/** A fresh world, with every seam pointed at it and every wait shortened. */
export function startJourney(opts: { offerDeadlineMs?: number; confirmDeadlineMs?: number } = {}): Journey {
  const world = new GitHubWorld();
  const slack = new FakeSlack();
  const store = new FakeStore();
  const config = journeyConfig();

  __ghCli.exec = world.gh as typeof __ghCli.exec;
  __contentMergeGh.exec = world.mergeGh as typeof __contentMergeGh.exec;
  __deployOfferGh.exec = world.prViewGh as typeof __deployOfferGh.exec;
  vi.stubGlobal('fetch', world.fetch);

  edge.fetchMergeState
    .mockReset()
    .mockImplementation(async ({ pullNumber }: { pullNumber: number }) => world.mergeState(pullNumber));
  edge.fetchUnresolvedReviewThreadCount.mockReset().mockResolvedValue({ unresolvedCount: 0, totalThreads: 0 });
  // The marketing repo has no CI: no checks on any commit.
  edge.fetchChecksState.mockReset().mockResolvedValue(null);
  edge.runCodex.mockReset().mockRejectedValue(new Error('No agent was expected to run in this journey.'));

  __stagingDeps.now = () => NOW_MS;
  __stagingDeps.listAppPages = async () => APP_PAGES;
  __deployOfferClock.now = () => NOW_MS + 5 * 60_000;
  __deployTiming.resolvePollMs = 1;
  __deployTiming.resolveTimeoutMs = 2_000;
  __deployTiming.watchPollMs = 1;
  __deployTiming.watchTimeoutMs = 2_000;
  __deployOfferTiming.pollMs = 1;
  __deployOfferTiming.slowPollMs = 1;
  __deployOfferTiming.fastWindowMs = 60_000;
  __deployOfferTiming.deadlineMs = opts.offerDeadlineMs ?? 3_000;
  __confirmationTiming.pollMs = 1;
  __confirmationTiming.deadlineMs = opts.confirmDeadlineMs ?? 300;
  __resetButtonRepliesForTests();

  return { world, slack, store, config };
}

let jobCounter = 0;

/** A person posts `text` in the thread; miniOG handles it as one job, start to finish. */
export async function ask(journey: Journey, threadTs: string, user: string, text: string): Promise<Step> {
  const before = journey.slack.said(threadTs).length;
  const earlier = journey.slack.threadTexts(threadTs);
  const event = journey.slack.reply(threadTs, user, text);
  const task = normalizeTask(event, journey.config, earlier);
  const logs: Step['logs'] = [];
  jobCounter += 1;
  const result = await routeTask({
    task,
    config: journey.config,
    slack: journey.slack.client as never,
    store: journey.store as never,
    jobId: `job-${jobCounter}`,
    logStep: entry => logs.push(entry),
    deps: {
      resolveMembership: async () => ({ eligible: true, reason: 'member' }),
      prOpen: async () => true,
    },
  });
  // The opening line is posted without waiting on it: let it land.
  await new Promise(resolve => setTimeout(resolve, 5));
  return { result, logs, said: journey.slack.said(threadTs).slice(before) };
}

/** A thread a change run of miniOG's ended in: the ask, and miniOG's reply with the PR it opened. */
export function threadWithPr(journey: Journey, requester: string, ask: string, prLink: string): string {
  const threadTs = journey.slack.startThread(requester, ask);
  journey.slack.botSaidEarlier(threadTs, `Changed the copy as asked and opened a PR.\n<${prLink}>`);
  return threadTs;
}

export const stages = (step: Step) => step.logs.map(entry => entry.stage);
