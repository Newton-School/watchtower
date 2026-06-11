/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGithubReviewSummary,
  formatSlackReviewSummary,
  normalizePrReviewAgentOutput,
  runPrReviewWorkflow,
} from '../src/workflows/prReviewWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { resolveGithubTokenForCodex } from '../src/github/githubAuth.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';
import type { SubmitPrReviewResult } from '../src/github/submitPrReview.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
}));

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

describe('prReviewWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(resolveGithubTokenForCodex).mockResolvedValue(undefined);
  });

  it('asks for PR URL and pauses when PR context is missing', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ text: 'please review this' }] }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev1',
        channelId: 'C1',
        threadTs: '123.45',
        eventTs: '123.45',
        userId: 'U123',
        text: '<@UBOT1> please review',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'PR_REVIEW',
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('PAUSED');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips with no-new-changes message when PR head SHA is unchanged', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'please review this https://github.com/Newton-School/newton-web/pull/123' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev2',
        channelId: 'C1',
        threadTs: '888.99',
        eventTs: '888.99',
        userId: 'U123',
        text: '<@UBOT1> review again https://github.com/Newton-School/newton-web/pull/123',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/newton-web/pull/123',
        owner: 'Newton-School',
        repo: 'newton-web',
        number: 123,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
      store: {
        findLatestReviewedPrHeadSha: () => ({
          jobId: 'previous-job',
          prHeadSha: 'deadbeef',
          updatedAt: '2026-03-03T08:00:00.000Z',
        }),
      } as any,
      resolvePrHeadSha: async () => 'deadbeef',
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('No new changes');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'No new commits since the last review. Same diff, same verdict. Push an update and I will rerun.',
      }),
    );
  });

  it('tags requester and skips when PR org is outside allowed scope', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'review https://github.com/facebook/react/pull/35961/files' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev3',
        channelId: 'C1',
        threadTs: '777.88',
        eventTs: '777.88',
        userId: 'U_SCOPE',
        text: '<@UBOT1> review this https://github.com/facebook/react/pull/35961/files',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/facebook/react/pull/35961',
        owner: 'facebook',
        repo: 'react',
        number: 35961,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<@U_SCOPE> this PR is outside supported review scope. I can review `Newton-School/newton-web` and `Newton-School/newton-api`.',
      }),
    );
  });

  it('tags requester and skips when PR repo is not newton-web/newton-api', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'review https://github.com/Newton-School/random-repo/pull/11' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev4',
        channelId: 'C1',
        threadTs: '666.77',
        eventTs: '666.77',
        userId: 'U_SCOPE2',
        text: '<@UBOT1> review this https://github.com/Newton-School/random-repo/pull/11',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/random-repo/pull/11',
        owner: 'Newton-School',
        repo: 'random-repo',
        number: 11,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<@U_SCOPE2> this PR is outside supported review scope. I can review `Newton-School/newton-web` and `Newton-School/newton-api`.',
      }),
    );
  });

  it('uses the high-reasoning profile for in-scope PR review execution', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Two findings posted on the PR.',
        prUrl: 'https://github.com/Newton-School/newton-web/pull/901',
      },
    });

    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'please review https://github.com/Newton-School/newton-web/pull/901' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev5',
        channelId: 'C1',
        threadTs: '555.66',
        eventTs: '555.66',
        userId: 'U_REVIEW',
        text: '<@UBOT1> review this https://github.com/Newton-School/newton-web/pull/901',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/newton-web/pull/901',
        owner: 'Newton-School',
        repo: 'newton-web',
        number: 901,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
      store: {
        findLatestReviewedPrHeadSha: () => undefined,
        getChannelPolicyPack: () => undefined,
      } as any,
      resolvePrHeadSha: async () => 'cafebabe',
    });

    expect(result.status).toBe('SUCCESS');
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/Users/dipesh/code/newton-web',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'PR review in progress. I will drop findings here shortly.',
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('PR review done. Two findings posted on the PR.'),
      }),
    );
  });

  it('fails the multi-agent review immediately when the PR diff fetch returns empty', async () => {
    // Regression for #285. Previously the workflow only logged a WARN and continued
    // with an empty diff, which let the multi-agent reviewers return zero findings
    // and silently approve the PR.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // fetchPrMetadata sends Accept: application/vnd.github+json (returns ok, empty metadata).
      // fetchPrDiff sends Accept: application/vnd.github.diff (we return 404 → diff = '').
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? '';
      if (accept.includes('application/vnd.github.diff')) {
        return new Response('', { status: 404 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const slack = {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ text: 'review https://github.com/Newton-School/newton-web/pull/777' }],
          }),
        },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
      };

      const task: NormalizedTask = {
        event: {
          eventId: 'EvEmpty',
          channelId: 'C1',
          threadTs: '444.55',
          eventTs: '444.55',
          userId: 'U_EMPTY',
          text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/777',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'PR_REVIEW',
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/777',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 777,
        },
      };

      const result = await runPrReviewWorkflow({
        task,
        config: { ...config, multiAgentEnabled: true },
        slack: slack as any,
        store: {
          findLatestReviewedPrHeadSha: () => undefined,
          getChannelPolicyPack: () => undefined,
        } as any,
        resolvePrHeadSha: async () => 'feedface',
      });

      expect(result.status).toBe('FAILED');
      // 404 on the diff endpoint → reason 'fetch_failed' → user-facing "Couldn't fetch" message.
      expect(result.message).toMatch(/Couldn't fetch the diff/);
      expect(result.message).toContain('HTTP 404');
      // runCodex must NEVER be called when the diff is empty — the agents should not
      // get a chance to "approve" a PR they never saw.
      expect(runCodex).not.toHaveBeenCalled();
      // The failure message must reach Slack so the requester knows what happened.
      expect(slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/Couldn't fetch the diff/),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the files endpoint when the diff endpoint refuses with 406 too_large', async () => {
    // GitHub returns 406 + {"errors":[{"code":"too_large"}]} on the .diff endpoint for
    // PRs above ~300 files. The multi-agent path must paginate /pulls/<n>/files and
    // reconstruct a unified diff so the review can proceed, and tell the user it's
    // a best-effort reconstruction.
    const originalFetch = globalThis.fetch;
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      parsedJson: { findings: [] },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    } as any);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? '';
      // Diff endpoint refuses with 406 + too_large
      if (accept.includes('application/vnd.github.diff')) {
        return new Response(JSON.stringify({ errors: [{ code: 'too_large' }] }), { status: 406 });
      }
      // Files endpoint pagination
      if (url.includes('/pulls/777/files')) {
        const pageMatch = url.match(/[?&]page=(\d+)/);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        if (page === 1) {
          return new Response(
            JSON.stringify([
              {
                filename: 'src/a.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                patch: '@@ -1,1 +1,2 @@\n line\n+added',
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Default for PR metadata, reviews submission etc.
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const slack = {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ text: 'review https://github.com/Newton-School/newton-web/pull/777' }],
          }),
        },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
      };

      const task: NormalizedTask = {
        event: {
          eventId: 'EvHuge',
          channelId: 'C1',
          threadTs: '555.66',
          eventTs: '555.66',
          userId: 'U_HUGE',
          text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/777',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'PR_REVIEW',
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/777',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 777,
        },
      };

      await runPrReviewWorkflow({
        task,
        config: { ...config, multiAgentEnabled: true },
        slack: slack as any,
        store: {
          findLatestReviewedPrHeadSha: () => undefined,
          getChannelPolicyPack: () => undefined,
        } as any,
        resolvePrHeadSha: async () => 'cafef00d',
      });

      // The "this PR is huge" heads-up must be posted to Slack so the requester knows
      // the review is best-effort against a reconstructed diff.
      expect(slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/Heads up.*huge/i),
        }),
      );
      // runCodex must be invoked — proves the workflow proceeded past the diff fetch
      // rather than failing with the empty-diff message.
      expect(runCodex).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns SUCCESS with hasBlockingFindings when the completed review found high-severity issues', async () => {
    // Status contract (issue #334 bug D): a COMPLETED review is SUCCESS regardless
    // of finding severity — FAILED is reserved for the workflow itself failing.
    // The verdict travels in `result` instead. Previously high/critical findings
    // flipped status to FAILED, which put the success summary in error_message,
    // added an :x: reaction, and broke the no-new-changes dedup guard.
    const originalFetch = globalThis.fetch;
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      parsedJson: {
        findings: [
          {
            severity: 'high',
            category: 'logic',
            message: 'Unvalidated payload reaches the ORM filter.',
            file: 'src/a.ts',
            line: 2,
          },
        ],
      },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    } as any);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? '';
      if (accept.includes('application/vnd.github.diff')) {
        return new Response('diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n line\n+added', { status: 200 });
      }
      if (url.includes('/reviews')) {
        return new Response('{"id": 1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const slack = {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ text: 'review https://github.com/Newton-School/newton-web/pull/777' }],
          }),
        },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
      };

      const task: NormalizedTask = {
        event: {
          eventId: 'EvBlocking',
          channelId: 'C1',
          threadTs: '666.77',
          eventTs: '666.77',
          userId: 'U_BLOCK',
          text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/777',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'PR_REVIEW',
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/777',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 777,
        },
      };

      const result = await runPrReviewWorkflow({
        task,
        config: { ...config, multiAgentEnabled: true },
        slack: slack as any,
        store: {
          findLatestReviewedPrHeadSha: () => undefined,
          getChannelPolicyPack: () => undefined,
        } as any,
        resolvePrHeadSha: async () => 'beadfeed',
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.result?.hasBlockingFindings).toBe(true);
      expect(result.result?.verdict).toBe('blocking_findings');
      expect(result.result?.prUrl).toBe('https://github.com/Newton-School/newton-web/pull/777');
      expect(result.result?.prHeadSha).toBe('beadfeed');
      // The Slack summary warns about blockers without failing the job.
      expect(slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/blocking-severity finding/),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('normalizes non-attachable findings into summary-only review notes', () => {
    const output = normalizePrReviewAgentOutput('reviewer', {
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        findings: [
          { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          { severity: 'low', category: 'style', message: 'Broken payload', file: 'src/a.ts', line: '12' },
        ],
        summaryNotes: ['Keep the copy aligned with the incident context.'],
      },
    });

    expect(output.findings).toHaveLength(2);
    expect(output.attachableFindings).toHaveLength(0);
    expect(output.unattachableFindings).toHaveLength(2);
    expect(output.invalidFindings).toBe(0);
    expect(output.summaryNotes).toEqual(['Keep the copy aligned with the incident context.']);
  });

  it('formats summary-only Slack completion when no inline comments were attached', () => {
    const outputs = [
      normalizePrReviewAgentOutput('reviewer', {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          findings: [
            { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          ],
          summaryNotes: [],
        },
      }),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'COMMENT',
      attemptedComments: 0,
      commentsPosted: 0,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'summary_only',
      fallbackReason: 'missing_location',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/7859',
      reviewResult,
    );

    expect(summary).toContain('1 findings identified; review summary posted, no inline comments attached');
    expect(summary).toContain('1 without an anchor');
    expect(summary).not.toContain('comments posted on PR');
  });

  it('formats partial Slack completion when only some findings are attachable', () => {
    const outputs = [
      normalizePrReviewAgentOutput('reviewer', {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          findings: [
            { severity: 'medium', category: 'logic', message: 'Attachable issue', file: 'src/a.ts', line: 10 },
            { severity: 'low', category: 'test', message: 'Needs broader follow-up' },
          ],
          summaryNotes: [],
        },
      }),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'COMMENT',
      attemptedComments: 1,
      commentsPosted: 1,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'inline',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/7859',
      reviewResult,
    );

    expect(summary).toContain('2 findings identified; 1 inline posted');
    expect(summary).toContain('1 without an anchor dropped');
  });

  it('formats Slack completion with inline + file-level + outside-diff counters', () => {
    const outputs = [
      normalizePrReviewAgentOutput('reviewer', {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          findings: [
            { severity: 'high', category: 'logic', message: 'Inline A', file: 'src/a.ts', line: 5 },
            { severity: 'medium', category: 'logic', message: 'Inline B', file: 'src/b.ts', line: 12 },
            { severity: 'medium', category: 'convention', message: 'File-level', file: 'src/c.ts' },
            { severity: 'low', category: 'perf', message: 'Off-diff', file: 'src/a.ts', line: 999 },
          ],
          summaryNotes: [],
        },
      }),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'REQUEST_CHANGES',
      attemptedComments: 2,
      commentsPosted: 2,
      droppedOutsideDiff: 1,
      fileLevelAttempted: 1,
      fileLevelPosted: 1,
      submissionMode: 'inline',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/8088',
      reviewResult,
    );

    expect(summary).toContain('4 findings identified');
    expect(summary).toContain('2 inline + 1 file-level posted');
    expect(summary).toContain('1 outside the PR diff dropped');
  });

  it('builds GitHub summary text for summary-only findings and notes', () => {
    const outputs = [
      normalizePrReviewAgentOutput('reviewer', {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          findings: [
            { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          ],
          summaryNotes: ['Mention the legacy avatar flow in the summary.'],
        },
      }),
    ];

    const summary = buildGithubReviewSummary(outputs);

    expect(summary).toContain('1 finding(s) could not be attached inline and are listed below.');
    expect(summary).toContain('[REVIEWER - MEDIUM] Needs a line reference before it can be attached.');
    expect(summary).toContain('[REVIEWER NOTE] Mention the legacy avatar flow in the summary.');
  });
});
