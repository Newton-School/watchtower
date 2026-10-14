/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __connectors } from '../src/backends/connectors.js';

const runCodex = vi.fn();
const getActiveBackendId = vi.fn(() => 'claude-code');
const classifyInvestigationScope = vi.fn();
const prepareWorkflowContext = vi.fn();

vi.mock('../src/codex/runCodex.js', () => ({ runCodex, getActiveBackendId }));
vi.mock('../src/codex/modelProfiles.js', () => ({
  highReasoningProfile: vi.fn(() => ({ model: 'opus-test', reasoningEffort: 'high' })),
}));
vi.mock('../src/codex/mentionSystemPrompt.js', () => ({ buildMentionSystemPrompt: vi.fn(() => '') }));
vi.mock('../src/codex/recallAssembler.js', () => ({ assembleRecall: vi.fn().mockResolvedValue({ promptBlock: '' }) }));
vi.mock('../src/router/investigationScope.js', () => ({ classifyInvestigationScope }));
vi.mock('../src/workflows/shared/workflowUtils.js', () => ({ prepareWorkflowContext }));
vi.mock('../src/slack/threadContext.js', () => ({
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
  fetchThreadContext: vi.fn().mockResolvedValue([]),
}));

const { runInvestigationWorkflow } = await import('../src/workflows/investigationWorkflow.js');
const { __infraRetry, connectionLostReply } = await import('../src/codex/infraRetry.js');

const config: any = {
  ownerSlackUserIds: ['UOWNER'],
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
  metabaseMcpUrl: 'https://metabase.example/api/mcp',
};

function makeTask(text: string): any {
  return {
    event: { eventId: 'Ev1', channelId: 'C1', threadTs: '1.1', eventTs: '1.1', userId: 'U_REQ', text, rawEvent: {} },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'INVESTIGATION',
  };
}

function slackStub() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '2.2' }) } };
}

function investigatorOk() {
  return {
    ok: true,
    exitCode: 0,
    parsedJson: { rootCauseHypothesis: 'x', evidence: [], recommendedFix: 'y', confidence: 'medium', summary: 's' },
  };
}

const baseCtx = {
  cwd: '/repos',
  repoName: undefined,
  threadContext: 'thread',
  imagePaths: [],
  imageContext: '',
  githubToken: undefined,
  desktopOnly: undefined,
};

beforeEach(() => {
  runCodex.mockReset().mockResolvedValue(investigatorOk());
  getActiveBackendId.mockReset().mockReturnValue('claude-code');
  classifyInvestigationScope.mockReset();
  prepareWorkflowContext.mockReset().mockResolvedValue(baseCtx);
});

describe('runInvestigationWorkflow thread images', () => {
  beforeEach(() => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
  });

  it('hands downloaded thread screenshots to the investigator', async () => {
    prepareWorkflowContext.mockResolvedValue({ ...baseCtx, imagePaths: ['/tmp/slack-files/F1-image.png'] });

    await runInvestigationWorkflow({ task: makeTask('pls remove this section'), config, slack: slackStub() as any });

    expect(runCodex.mock.calls[0][0].imagePaths).toEqual(['/tmp/slack-files/F1-image.png']);
  });

  it('does not offer to fix what is not in the code, and keeps nothing a "yes, fix it" could resume (issue #432)', async () => {
    runCodex.mockReset().mockResolvedValue({
      ok: true,
      exitCode: 0,
      parsedJson: {
        rootCauseHypothesis: 'The dashboard 674 cards count every class.',
        evidence: [],
        recommendedFix:
          'Restrict the seven cards on Metabase dashboard 674 to topic classes; a Metabase editor can do it.',
        fixLocation: 'outside',
        confidence: 'high',
        summary: 'The count is wrong in the Metabase cards, not in the code.',
      },
    });
    const slack = slackStub();
    const investigationStore = { save: vi.fn() } as any;

    await runInvestigationWorkflow({
      task: makeTask('the recording coverage dashboard counts the wrong classes'),
      config,
      slack: slack as any,
      investigationStore,
      jobId: 'job-1',
    });

    const texts = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    expect(texts).toContain(
      'This fix is not a code change, so I can’t make it from here: see *Recommended fix* for where it lives and who can change it.',
    );
    expect(investigationStore.save).not.toHaveBeenCalled();
  });

  it('still offers a fix in the code', async () => {
    const slack = slackStub();
    const investigationStore = { save: vi.fn() } as any;

    await runInvestigationWorkflow({
      task: makeTask('button is misaligned'),
      config,
      slack: slack as any,
      investigationStore,
      jobId: 'job-1',
    });

    const texts = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    expect(texts.some(text => text.startsWith('Want me to fix this?'))).toBe(true);
    expect(investigationStore.save).toHaveBeenCalledTimes(1);
  });

  it('investigates read-only, and tells the investigator so (issue #443)', async () => {
    await runInvestigationWorkflow({ task: makeTask('button is misaligned'), config, slack: slackStub() as any });

    expect(runCodex.mock.calls[0][0].readOnly).toBe(true);
    expect(runCodex.mock.calls[0][0].prompt).toContain('This run is read-only.');
  });

  it('passes no imagePaths when the thread has none', async () => {
    await runInvestigationWorkflow({ task: makeTask('button is misaligned'), config, slack: slackStub() as any });

    expect(runCodex.mock.calls[0][0].imagePaths).toBeUndefined();
  });
});

// Issue #439: an investigation that lost its connection used to tell the
// requester it "couldn't complete" and to share more context.
describe('runInvestigationWorkflow and a lost connection', () => {
  const saved = { ...__infraRetry };

  beforeEach(() => {
    __infraRetry.sleep = vi.fn(async () => true);
    __infraRetry.delaysMs = [1, 1];
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
  });

  afterEach(() => Object.assign(__infraRetry, saved));

  it('retries, and investigates once the connection is back', async () => {
    runCodex.mockReset();
    runCodex
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        errorKind: 'API_ERROR',
      })
      .mockResolvedValueOnce(investigatorOk());

    const result = await runInvestigationWorkflow({
      task: makeTask('button is misaligned'),
      config,
      slack: slackStub() as any,
    });

    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('SUCCESS');
  });

  it('says it lost the connection, and does not ask for more context, when retrying does not help', async () => {
    runCodex.mockReset();
    runCodex.mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      errorKind: 'API_ERROR',
    });
    const slack = slackStub();

    const result = await runInvestigationWorkflow({
      task: makeTask('button is misaligned'),
      config,
      slack: slack as any,
    });

    expect(runCodex).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ workflow: 'INVESTIGATION', status: 'FAILED' });
    const posted = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(posted).toContain(connectionLostReply('investigating this', { changesCode: false }));
    expect(posted.some(t => t.includes('share more context'))).toBe(false);
  });
});

describe('runInvestigationWorkflow scope wiring', () => {
  // A scoped investigation used to pass no list, which on the backend meant
  // "everything the host user has" (issue #443). It now names the one it keeps.
  it('single-repo scope passes repoOverride and keeps only read-only Metabase', async () => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
    const slack = slackStub();

    await runInvestigationWorkflow({ task: makeTask('button is misaligned'), config, slack: slack as any });

    expect(prepareWorkflowContext).toHaveBeenCalledWith(expect.objectContaining({ repoOverride: 'newton-web' }));
    expect(runCodex).toHaveBeenCalledOnce();
    expect(runCodex.mock.calls[0][0].mcpServers).toEqual({
      metabase: { type: 'http', url: 'https://metabase.example/api/mcp' },
    });
    expect(runCodex.mock.calls[0][0].disallowedTools).toEqual([
      'mcp__metabase__create_*',
      'mcp__metabase__update_*',
      'mcp__metabase__delete_*',
      'mcp__metabase__archive_*',
    ]);
    expect(runCodex.mock.calls[0][0].prompt as string).toMatch(/mcp__metabase__/);
    // Ack mentions the scoped repo.
    const acks = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(acks.some(t => t.includes('newton-web'))).toBe(true);
  });

  it('broad scope on claude-code with a configured URL enables the Metabase MCP', async () => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'broad',
      confidence: 0.3,
      reasoning: 'vague',
      method: 'llm',
    });
    const slack = slackStub();

    await runInvestigationWorkflow({ task: makeTask('something is broken'), config, slack: slack as any });

    expect(prepareWorkflowContext).toHaveBeenCalledWith(expect.objectContaining({ repoOverride: 'broad' }));
    expect(runCodex.mock.calls[0][0].mcpServers).toEqual({
      metabase: { type: 'http', url: 'https://metabase.example/api/mcp' },
    });
    expect(runCodex.mock.calls[0][0].disallowedTools).toContain('mcp__metabase__update_*');
    // The broad prompt references both repos + read-only Metabase.
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toMatch(/newton-web/);
    expect(prompt).toMatch(/newton-api/);
    expect(prompt).toMatch(/mcp__metabase__/);
  });

  it('gives an investigation OpenPanel too when the host has it, and says what it is for', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-investigation-home-'));
    const realHome = __connectors.home;
    __connectors.home = () => home;
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { openpanel: { type: 'http', url: 'https://openpanel.example/mcp' } } }),
    );
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
    try {
      await runInvestigationWorkflow({
        task: makeTask('the signup event stopped firing'),
        config,
        slack: slackStub() as any,
      });

      expect(Object.keys(runCodex.mock.calls[0][0].mcpServers)).toEqual(['metabase', 'openpanel']);
      expect(runCodex.mock.calls[0][0].prompt as string).toContain('tools named `mcp__openpanel__*`');
    } finally {
      __connectors.home = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('marketing scope pins the marketing worktree and warns about Webflow path routing', async () => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-marketing-web',
      confidence: 0.9,
      reasoning: 'landing page symptom',
      method: 'llm',
    });
    const slack = slackStub();
    const marketingConfig = {
      ...config,
      repoPaths: { ...config.repoPaths, newtonMarketingWeb: '/repos/newton-marketing-web' },
    };

    await runInvestigationWorkflow({
      task: makeTask('images 404 on the AI course landing page'),
      config: marketingConfig,
      slack: slack as any,
    });

    expect(prepareWorkflowContext).toHaveBeenCalledWith(
      expect.objectContaining({ repoOverride: 'newton-marketing-web' }),
    );
    // The scope classifier greps all enabled clones, marketing included.
    expect(classifyInvestigationScope).toHaveBeenCalledWith(
      expect.objectContaining({
        repoGrepPaths: [
          { key: 'newton-web', path: '/repos/newton-web' },
          { key: 'newton-api', path: '/repos/newton-api' },
          { key: 'newton-marketing-web', path: '/repos/newton-marketing-web' },
        ],
      }),
    );
    const acks = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(acks.some(t => t.includes('newton-marketing-web'))).toBe(true);
    // The investigator is told to check worker/paths.js before blaming code.
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('worker/paths.js');
  });

  it('broad scope excludes the marketing clone when it is configured', async () => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'broad',
      confidence: 0.3,
      reasoning: 'vague',
      method: 'llm',
    });
    const marketingConfig = {
      ...config,
      repoPaths: { ...config.repoPaths, newtonMarketingWeb: '/repos/newton-marketing-web' },
    };

    await runInvestigationWorkflow({ task: makeTask('broken'), config: marketingConfig, slack: slackStub() as any });
    expect(runCodex.mock.calls[0][0].prompt as string).toContain('OUT OF SCOPE');

    runCodex.mockClear();
    await runInvestigationWorkflow({ task: makeTask('broken'), config, slack: slackStub() as any });
    expect(runCodex.mock.calls[0][0].prompt as string).not.toContain('OUT OF SCOPE');
  });

  it('broad scope degrades to repos-only on the codex backend', async () => {
    getActiveBackendId.mockReturnValue('codex');
    classifyInvestigationScope.mockResolvedValue({
      scope: 'broad',
      confidence: 0.3,
      reasoning: 'vague',
      method: 'llm',
    });

    await runInvestigationWorkflow({ task: makeTask('broken'), config, slack: slackStub() as any });

    expect(runCodex.mock.calls[0][0].mcpServers).toEqual({});
  });

  it('broad scope degrades to repos-only when no Metabase URL is configured', async () => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'broad',
      confidence: 0.3,
      reasoning: 'vague',
      method: 'llm',
    });

    await runInvestigationWorkflow({
      task: makeTask('broken'),
      config: { ...config, metabaseMcpUrl: '' },
      slack: slackStub() as any,
    });

    expect(runCodex.mock.calls[0][0].mcpServers).toEqual({});
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toMatch(/No database access is available/);
  });
});

describe('runInvestigationWorkflow cancelled mid-run (issue #438)', () => {
  beforeEach(() => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
  });

  it('returns CANCELLED and posts no failure copy when the run was aborted', async () => {
    const controller = new AbortController();
    // The agent dies with the abort: no output, not ok.
    runCodex.mockImplementation(async () => {
      controller.abort();
      return { ok: false, exitCode: 143, cancelled: true, parsedJson: undefined };
    });
    const slack = slackStub();

    const result = await runInvestigationWorkflow({
      task: makeTask('checkout page is broken'),
      config,
      slack: slack as any,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(result.slackPosted).toBe(false);
    const posted = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    expect(posted.some(text => text.includes("couldn't complete the investigation"))).toBe(false);
  });

  it('still reports a genuine failure when nothing was cancelled', async () => {
    runCodex.mockResolvedValue({ ok: false, exitCode: 1, parsedJson: undefined });
    const slack = slackStub();

    const result = await runInvestigationWorkflow({
      task: makeTask('checkout page is broken'),
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('FAILED');
    const posted = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    expect(posted.some(text => text.includes("couldn't complete the investigation"))).toBe(true);
  });
});

describe('runInvestigationWorkflow cancelled while asking which repo (issue #264)', () => {
  beforeEach(() => {
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
  });

  it("hands the job's signal to the context step that asks which repo", async () => {
    const controller = new AbortController();

    await runInvestigationWorkflow({
      task: makeTask('checkout page is broken'),
      config,
      slack: slackStub() as any,
      signal: controller.signal,
    });

    expect(prepareWorkflowContext.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('returns CANCELLED, with no "desktop queue" copy and no agent run, when cancelled during that step', async () => {
    const controller = new AbortController();
    // What the repo-choice wait leaves behind once the abort ends it.
    prepareWorkflowContext.mockImplementation(async () => {
      controller.abort();
      return { ...baseCtx, desktopOnly: { reason: 'admin cancelled', cancelled: true } };
    });
    const slack = slackStub();

    const result = await runInvestigationWorkflow({
      task: makeTask('checkout page is broken'),
      config,
      slack: slack as any,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });
});
