/**
 * Shared fakes for the marketing-loop journey tests (issues #701, #702, #703).
 *
 * The journeys drive the real router and workflows the way the intake does
 * (`normalizeTask`, then `routeTask`) as people other than the owner, which
 * the live Slack checks cannot: those can only post as the owner, who skips
 * access checks and the content-only merge path. Only the edges are fake:
 *
 * - Slack: a thread store that records what miniOG posts and serves people's
 *   replies over time, each one revealed on a later poll once what it answers
 *   has been posted.
 * - GitHub: one model of the marketing repo behind the REST API the content
 *   check reads, the `gh` commands the staging tool, the merge and the deploy
 *   offer run, and the Actions runs they dispatch and follow.
 * - The router model: a scripted reading of each message.
 *
 * This module imports nothing from `src/`: the journey files mock modules this
 * one's fakes stand in for, and import those modules themselves.
 */
import { vi } from 'vitest';
import type { AppConfig, SlackEventEnvelope } from '../../src/types/contracts.js';

export const BOT = 'UBOT1';
export const OWNER = 'UOWNER1';
export const BUILDER = 'UBUILDER';
export const BUILDER2 = 'UBUILDER2';
export const VIEWER = 'UVIEWER';
export const ADMIN = 'UADMIN';
export const CHANNEL = 'C0MKTG';

export const SLUG = 'Newton-School/newton-marketing-web';
export const CLONE = '/clones/newton-marketing-web';
export const STAGING = 'https://staging-marketing-web.newtonschool.co';
export const prUrl = (n: number) => `https://github.com/${SLUG}/pull/${n}`;

/** "Now" for every clock the workflows read. Slack timestamps start here too. */
export const NOW_MS = 1_800_000_000_000;

/** The edges the journey files mock, so each file's `vi.mock` factories can hand them over. */
export const edge = {
  decideTool: vi.fn(),
  runCodex: vi.fn(),
  fetchMergeState: vi.fn(),
  fetchUnresolvedReviewThreadCount: vi.fn(),
  fetchChecksState: vi.fn(),
};

const bundle = (name: string, userIds: string[], capabilities: string[]) => ({
  name,
  manualUserIds: userIds.join(','),
  resolvedUserIds: userIds,
  capabilities,
  allowedChannelIds: [CHANNEL],
  allowIm: false,
  allowMpim: false,
});

/** The live setup in miniature: viewers, builders and core-dev (admin) in one marketing channel. */
export function journeyConfig(): AppConfig {
  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds: [OWNER],
    coreDevSlackUserIds: [OWNER],
    botUserId: BOT,
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    bugsAndUpdatesChannelId: CHANNEL,
    allowedChannelsForBugFix: [CHANNEL],
    repoPaths: { newtonWeb: '/clones/newton-web', newtonApi: '/clones/newton-api', newtonMarketingWeb: CLONE },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: 3,
    repoClassifierThreshold: 0.75,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: true,
    agentBackend: 'claude-code',
    prReviewTimeoutMs: 120_000,
    bugFixTimeoutMs: 2_700_000,
    pmTaskTimeoutMs: 120_000,
    accessControl: { mode: 'enforce' },
    bundles: [
      bundle('viewer', [VIEWER], ['query_codebase', 'chat']),
      bundle('builder', [BUILDER, BUILDER2], ['query_codebase', 'chat', 'start_implementation']),
      bundle('admin', [ADMIN], ['query_codebase', 'chat', 'start_implementation', 'deploy_prod']),
    ],
  } as unknown as AppConfig;
}

/**
 * The router model's reading of each message: the first rule whose phrase
 * the message contains decides. A message no rule names reads as chat.
 */
export function routerReads(rules: Array<[phrase: string, tool: string, confidence?: number]>): void {
  edge.decideTool.mockImplementation(async (params: { facts: { message: string } }) => {
    const message = params.facts.message.toLowerCase();
    const rule = rules.find(([phrase]) => message.includes(phrase.toLowerCase()));
    return {
      ok: true,
      decision: { tool: rule?.[1] ?? 'chat', confidence: rule?.[2] ?? 0.92, reason: 'scripted' },
      durationMs: 1,
    };
  });
}

// --- GitHub -----------------------------------------------------------------

export interface WorldPr {
  number: number;
  head: string;
  headSha: string;
  /** The merge base the content check reads the old file at. */
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt?: string;
  /** Path → the file at the merge base and at the head. */
  files: Record<string, { before: string; after: string }>;
  reviewDecision: string;
  mergeStateStatus: string;
}

export interface WorldRun {
  id: number;
  workflow: 'deploy-staging.yml' | 'deploy-prod.yml';
  branch: string;
  headSha: string;
  status: string;
  conclusion?: string;
  createdAt: string;
  url: string;
  /** Who started it: `miniog`, or `github` for a run someone started by hand. */
  by: 'miniog' | 'github';
}

/**
 * newton-marketing-web as far as these journeys see it. Every call is
 * recorded, so a journey can say what was dispatched or merged, and nothing else.
 */
export class GitHubWorld {
  readonly prs = new Map<number, WorldPr>();
  readonly runs: WorldRun[] = [];
  readonly branches = new Set<string>(['main']);
  readonly ghCalls: string[][] = [];
  readonly mergeCalls: string[][] = [];
  private nextRunId = 5000;
  /** Minutes past NOW_MS: each thing that happens on GitHub happens a minute later than the last. */
  private minute = 0;

  addPr(pr: Partial<WorldPr> & Pick<WorldPr, 'number' | 'head' | 'files'>): WorldPr {
    const full: WorldPr = {
      headSha: `sha-${pr.number}`,
      baseSha: `base-${pr.number}`,
      state: 'open',
      merged: false,
      reviewDecision: 'REVIEW_REQUIRED',
      // The repo's ruleset needs one approving review, so an unreviewed PR is BLOCKED.
      mergeStateStatus: 'BLOCKED',
      ...pr,
    };
    this.prs.set(pr.number, full);
    this.branches.add(pr.head);
    return full;
  }

  /** A run someone started from GitHub, not through miniOG. */
  addRun(run: Omit<WorldRun, 'id' | 'url' | 'createdAt' | 'headSha' | 'by'> & Partial<WorldRun>): WorldRun {
    const id = this.nextRunId++;
    const full: WorldRun = {
      id,
      url: `https://github.com/${SLUG}/actions/runs/${id}`,
      createdAt: this.tick(),
      headSha: `sha-${run.branch}`,
      by: 'github',
      ...run,
    };
    this.runs.push(full);
    return full;
  }

  dispatches(workflow?: WorldRun['workflow']): WorldRun[] {
    return this.runs.filter(run => run.by === 'miniog' && (!workflow || run.workflow === workflow));
  }

  private tick(): string {
    this.minute += 1;
    return new Date(NOW_MS + this.minute * 60_000).toISOString();
  }

  private prJson(pr: WorldPr) {
    return {
      html_url: prUrl(pr.number),
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      head: { ref: pr.head, sha: pr.headSha, repo: { full_name: SLUG } },
      base: { ref: 'main', repo: { full_name: SLUG, default_branch: 'main' } },
    };
  }

  /** `__ghCli.exec`: the staging tool's `gh api` reads, and every Actions dispatch and read. */
  readonly gh = async (args: string[]): Promise<string> => {
    this.ghCalls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'api') {
      const route = args[1];
      const compare = /^repos\/[^/]+\/[^/]+\/compare\/main\.\.\.(.+)$/.exec(route);
      if (compare) {
        const pr = [...this.prs.values()].find(p => p.headSha === compare[1] || p.head === compare[1]);
        return pr ? Object.keys(pr.files).join('\n') : '';
      }
      const pull = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(route);
      if (pull) {
        const pr = this.prs.get(Number(pull[1]));
        if (!pr) throw new Error('gh: Not Found (HTTP 404)');
        return JSON.stringify(this.prJson(pr));
      }
      const branch = /^repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(route);
      if (branch) {
        if (!this.branches.has(branch[1])) throw new Error('gh: Branch not found (HTTP 404)');
        return JSON.stringify({ name: branch[1], commit: { sha: `sha-${branch[1]}` } });
      }
      throw new Error(`unexpected gh api ${route}`);
    }
    if (cmd === 'workflow' && sub === 'run') {
      const workflow = args[2] as WorldRun['workflow'];
      const ref = args[args.indexOf('--ref') + 1];
      const pr = [...this.prs.values()].find(p => p.head === ref);
      const id = this.nextRunId++;
      this.runs.push({
        id,
        workflow,
        branch: ref,
        headSha: pr?.headSha ?? `sha-${ref}`,
        status: 'queued',
        createdAt: this.tick(),
        url: `https://github.com/${SLUG}/actions/runs/${id}`,
        by: 'miniog',
      });
      return '';
    }
    if (cmd === 'run' && sub === 'list') {
      const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      const workflow = (args.find(arg => arg.startsWith('--workflow=')) ?? '').slice('--workflow='.length);
      const branch = flag('--branch');
      const status = flag('--status');
      const limit = Number(flag('--limit') ?? 20);
      const rows = this.runs
        .filter(run => run.workflow === workflow)
        .filter(run => !branch || run.branch === branch)
        .filter(run => !status || run.conclusion === status)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(run => ({
          databaseId: run.id,
          headBranch: run.branch,
          headSha: run.headSha,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.createdAt,
          url: run.url,
        }));
      return JSON.stringify(rows);
    }
    if (cmd === 'run' && sub === 'view') {
      const run = this.runs.find(r => r.id === Number(args[2]));
      if (!run) throw new Error('gh: run not found');
      // Every run finishes by the time anyone looks.
      run.status = 'completed';
      run.conclusion = run.conclusion ?? 'success';
      return JSON.stringify({ status: run.status, conclusion: run.conclusion, url: run.url });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };

  /** `__contentMergeGh.exec`: `gh pr merge` for a content-only merge. */
  readonly mergeGh = async (args: string[]): Promise<string> => {
    this.mergeCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'merge') {
      const pr = this.prs.get(Number(args[2]));
      if (!pr || pr.state !== 'open') throw new Error('GraphQL: Pull request is not open');
      const pinned = args.includes('--match-head-commit') ? args[args.indexOf('--match-head-commit') + 1] : undefined;
      if (pinned && pinned !== pr.headSha) {
        throw new Error('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
      }
      if (pr.mergeStateStatus === 'BLOCKED' && !args.includes('--admin')) {
        throw new Error('GraphQL: Repository rule violations found: changes must be reviewed');
      }
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = this.tick();
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = this.prs.get(Number(args[2]));
      return pr ? (pr.merged ? 'MERGED' : pr.state.toUpperCase()) : '';
    }
    throw new Error(`unexpected merge gh ${args.join(' ')}`);
  };

  /** `__deployOfferGh.exec`: the offer's `gh pr view` of what was merged. */
  readonly prViewGh = async (args: string[]): Promise<string> => {
    if (args[0] !== 'pr' || args[1] !== 'view') throw new Error(`unexpected offer gh ${args.join(' ')}`);
    const pr = this.prs.get(Number(args[2]));
    if (!pr) throw new Error('gh: no pull requests found');
    return JSON.stringify({
      state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
      mergedAt: pr.mergedAt ?? null,
      headRefName: pr.head,
      baseRefName: 'main',
    });
  };

  /** `fetch`: the REST reads of the content-only check (`checkContentOnlyPr`). */
  readonly fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
    if (pull) {
      const pr = this.prs.get(Number(pull[1]));
      return pr ? json(this.prJson(pr)) : new Response('{}', { status: 404 });
    }
    const compare = /^\/repos\/[^/]+\/[^/]+\/compare\/main\.\.\.(.+)$/.exec(path);
    if (compare) {
      const pr = [...this.prs.values()].find(p => p.headSha === compare[1]);
      if (!pr) return new Response('{}', { status: 404 });
      return json({
        merge_base_commit: { sha: pr.baseSha },
        files: Object.keys(pr.files).map(filename => ({ filename, status: 'modified' })),
      });
    }
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
    if (contents) {
      const ref = url.searchParams.get('ref');
      const pr = [...this.prs.values()].find(p => p.headSha === ref || p.baseSha === ref);
      const file = pr?.files[contents[1]];
      if (!pr || !file) return new Response('', { status: 404 });
      return new Response(ref === pr.baseSha ? file.before : file.after, { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  /** What `fetchMergeState` reads (GraphQL in real life). */
  mergeState(number: number) {
    const pr = this.prs.get(number);
    if (!pr) return undefined;
    return {
      reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.merged ? 'UNKNOWN' : pr.mergeStateStatus,
      isDraft: false,
      headSha: pr.headSha,
      baseRef: 'main',
    };
  }
}

// --- Slack ------------------------------------------------------------------

export interface Post {
  channel: string;
  thread_ts: string;
  text: string;
}

interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  bot_id?: string;
}

interface ScriptedReply {
  user: string;
  text: string;
  /** Revealed on the first poll after miniOG posts something this matches in the thread. */
  after: RegExp;
}

/**
 * Slack as the workflows see it. People's replies are scripted per thread:
 * each one shows up on a poll of the thread (a read with `oldest`) once
 * miniOG has posted what it answers, and gets a timestamp when it shows up,
 * so it is always after the prompt it answers. Replies waiting on the same
 * post show up on the same poll, in the order they were scripted.
 */
export class FakeSlack {
  readonly posts: Post[] = [];
  readonly updates: Array<{ channel: string; ts: string; text?: string }> = [];
  /** Called after miniOG posts anything: lets a journey change GitHub at that moment. */
  onPost: (post: Post) => void = () => {};
  private readonly threads = new Map<string, SlackMessage[]>();
  private readonly scripted = new Map<string, ScriptedReply[]>();
  private seq = 0;

  private nextTs(): string {
    this.seq += 1;
    return `${NOW_MS / 1000 + this.seq}.000100`;
  }

  private thread(ts: string): SlackMessage[] {
    let messages = this.threads.get(ts);
    if (!messages) {
      messages = [];
      this.threads.set(ts, messages);
    }
    return messages;
  }

  /** A person starts a thread. Returns its ts. */
  startThread(user: string, text: string): string {
    const ts = this.nextTs();
    this.thread(ts).push({ user, text, ts });
    return ts;
  }

  /** A message miniOG posted earlier in the thread (before the journey starts). */
  botSaidEarlier(threadTs: string, text: string): void {
    this.thread(threadTs).push({ user: BOT, text, ts: this.nextTs(), bot_id: 'BMINIOG' });
  }

  /** A person replies now (the message that becomes a job). Returns the event the intake would build. */
  reply(threadTs: string, user: string, text: string): SlackEventEnvelope {
    const ts = this.nextTs();
    this.thread(threadTs).push({ user, text, ts });
    return {
      eventId: `Ev${ts}`,
      channelId: CHANNEL,
      channelType: 'channel',
      threadTs,
      eventTs: ts,
      userId: user,
      text,
      rawEvent: {},
    } as SlackEventEnvelope;
  }

  /** A person will reply in the thread once miniOG has posted something matching `after`. */
  willReply(threadTs: string, user: string, text: string, after: RegExp): void {
    const list = this.scripted.get(threadTs) ?? [];
    list.push({ user, text, after });
    this.scripted.set(threadTs, list);
  }

  /** Scripted replies that never showed up (their prompt was never posted). */
  unrevealed(threadTs: string): string[] {
    return (this.scripted.get(threadTs) ?? []).map(reply => reply.text);
  }

  /** The texts of every message in a thread so far, everyone's. */
  threadTexts(threadTs: string): string[] {
    return this.thread(threadTs).map(message => message.text);
  }

  /** What miniOG posted in a thread, in order. */
  said(threadTs: string): string[] {
    return this.posts.filter(post => post.thread_ts === threadTs).map(post => post.text);
  }

  private reveal(threadTs: string): void {
    const pending = this.scripted.get(threadTs);
    if (!pending?.length) return;
    const said = this.said(threadTs);
    const due = pending.filter(reply => said.some(text => reply.after.test(text)));
    for (const reply of due) {
      pending.splice(pending.indexOf(reply), 1);
      this.thread(threadTs).push({ user: reply.user, text: reply.text, ts: this.nextTs() });
    }
  }

  readonly client = {
    chat: {
      postMessage: vi.fn(async (args: Post) => {
        const ts = this.nextTs();
        const post = { channel: args.channel, thread_ts: args.thread_ts, text: args.text };
        this.posts.push(post);
        this.thread(args.thread_ts).push({ user: BOT, text: args.text, ts, bot_id: 'BMINIOG' });
        this.onPost(post);
        return { ok: true, ts, channel: args.channel };
      }),
      update: vi.fn(async (args: { channel: string; ts: string; text?: string }) => {
        this.updates.push({ channel: args.channel, ts: args.ts, text: args.text });
        return { ok: true };
      }),
    },
    conversations: {
      replies: vi.fn(async (args: { ts: string; oldest?: string }) => {
        // A poll (a read since the prompt) is when a person's next reply shows up.
        if (args.oldest) this.reveal(args.ts);
        const floor = args.oldest ? Number(args.oldest) : 0;
        return {
          ok: true,
          messages: this.thread(args.ts).filter(message => Number(message.ts) > floor || message.ts === args.ts),
          response_metadata: {},
        };
      }),
    },
    users: {
      info: vi.fn(async (args: { user: string }) => ({
        ok: true,
        user: { name: args.user.toLowerCase(), profile: { display_name: args.user.toLowerCase() } },
      })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) },
    assistant: { threads: { setStatus: vi.fn(async () => ({ ok: true })) } },
  };
}

// --- The job store ------------------------------------------------------------

/** The two things these workflows keep: the staging record and the dry-run switch. */
export class FakeStore {
  readonly state = new Map<string, string>();
  getState = (key: string) => this.state.get(key);
  setState = (key: string, value: string) => void this.state.set(key, value);
}

// --- Files ----------------------------------------------------------------------

/** The Agentic AI course content file, before and after a one-word copy edit (as in marketing PR #1488). */
export const COPY_EDIT = {
  path: 'src/features/agentic-ai-course/content.ts',
  before: `export const OFFERINGS = {
  heading: 'What you get',
  cards: [
    { key: 'mentorship', tag: 'Mentorship', title: 'CTO Mentorship Sessions', desc: 'Learn directly from CTOs and engineering leaders from top companies' },
    { key: 'community', tag: 'Community', title: 'Newton Builders Community', desc: 'Join an exclusive community to collaborate on projects.' },
  ],
};
`,
  after: `export const OFFERINGS = {
  heading: 'What you get',
  cards: [
    { key: 'mentorship', tag: 'Mentorship', title: 'CTO Mentorship Sessions', desc: 'Learn directly from CTOs and engineering leaders at top companies' },
    { key: 'community', tag: 'Community', title: 'Newton Builders Community', desc: 'Join an exclusive community to collaborate on projects.' },
  ],
};
`,
};

/** A section where only a class list changed: a style change, not copy. */
export const STYLE_EDIT = {
  path: 'src/features/agentic-ai-course/sections/hero.tsx',
  before: `export function Hero() {
  return (
    <section className="bg-white py-16">
      <h1 className="text-4xl font-semibold">Become an AI engineer</h1>
    </section>
  );
}
`,
  after: `export function Hero() {
  return (
    <section className="bg-white py-16">
      <h1 className="text-5xl font-bold">Become an AI engineer</h1>
    </section>
  );
}
`,
};

/** The app page that renders the Agentic AI course feature, for the staging links. */
export const APP_PAGES = [
  {
    file: 'src/app/(landing)/agentic-ai-course/page.tsx',
    source: "import { AgenticAiCoursePage } from '@/features/agentic-ai-course';",
  },
  { file: 'src/app/(landing)/nst/page.tsx', source: "import Nav from '@/features/nst-shell/sections/nav';" },
];
