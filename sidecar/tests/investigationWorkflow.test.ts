/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __connectors } from '../src/backends/connectors.js';

const runCodex = vi.fn();
const getActiveBackendId = vi.fn(() => 'claude-code');
const classifyInvestigationScope = vi.fn();
const prepareWorkflowContext = vi.fn();
const prepareSiblingRepos = vi.fn();

vi.mock('../src/codex/runCodex.js', () => ({ runCodex, getActiveBackendId }));
vi.mock('../src/workspaces/siblingRepos.js', () => ({ prepareSiblingRepos }));
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

const { runInvestigationWorkflow, investigationNextStep, NOTHING_TO_FIX_REPLY, FIX_LOCATION_RULE } =
  await import('../src/workflows/investigationWorkflow.js');
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
  prepareSiblingRepos.mockReset().mockResolvedValue({ dirs: [], block: '' });
});

// Issue #610: a scoped investigation could not read the other repo at all and
// pointed its fix at the wrong endpoint.
describe('runInvestigationWorkflow other repos', () => {
  const block = 'OTHER REPOS — besides your working directory, you can read these clones.';

  it('refreshes the other repos for a scoped investigation, tells it about them and lets it read them', async () => {
    classifyInvestigationScope.mockResolvedValue({ scope: 'newton-api', confidence: 0.9, method: 'grep' });
    prepareWorkflowContext.mockResolvedValue({
      ...baseCtx,
      cwd: '/home/.watchtower/workspaces/newton-api/1.1',
      repoName: 'newton-api',
    });
    prepareSiblingRepos.mockResolvedValue({ dirs: ['/repos/newton-web'], block });

    await runInvestigationWorkflow({
      task: makeTask('XP is assigned on a failed test'),
      config,
      slack: slackStub() as any,
    });

    expect(prepareSiblingRepos).toHaveBeenCalledWith(
      expect.objectContaining({ currentRepoPath: '/repos/newton-api', mode: 'refresh' }),
    );
    const request = runCodex.mock.calls[0][0];
    expect(request.readOnly).toBe(true);
    expect(request.readDirs).toEqual(['/repos/newton-web']);
    expect(request.prompt).toContain(block);
    // Told it may read beyond its own repo, not that the current directory holds every repo.
    expect(request.prompt).toContain('the other repos listed under OTHER REPOS');
    expect(request.prompt).not.toContain('the root that holds the repos');
  });

  it('says what it is digging into before the refresh is done', async () => {
    classifyInvestigationScope.mockResolvedValue({ scope: 'newton-api', confidence: 0.9, method: 'grep' });
    prepareWorkflowContext.mockResolvedValue({ ...baseCtx, cwd: '/wt/newton-api', repoName: 'newton-api' });
    const slack = slackStub();
    let ackBeforeRefresh: boolean | undefined;
    prepareSiblingRepos.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      ackBeforeRefresh = slack.chat.postMessage.mock.calls.length > 0;
      return { dirs: [], block: '' };
    });

    await runInvestigationWorkflow({ task: makeTask('XP is assigned on a failed test'), config, slack: slack as any });

    expect(ackBeforeRefresh).toBe(true);
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('investigates anyway when refreshing the other repos throws', async () => {
    classifyInvestigationScope.mockResolvedValue({ scope: 'newton-api', confidence: 0.9, method: 'grep' });
    prepareWorkflowContext.mockResolvedValue({ ...baseCtx, cwd: '/wt/newton-api', repoName: 'newton-api' });
    prepareSiblingRepos.mockRejectedValue(new Error('git exploded'));
    const logStep = vi.fn();

    const result = await runInvestigationWorkflow({
      task: makeTask('XP is assigned on a failed test'),
      config,
      slack: slackStub() as any,
      logStep,
    });

    expect(result.status).not.toBe('FAILED');
    expect(runCodex.mock.calls[0][0].readDirs).toBeUndefined();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'investigation.repo_refresh', level: 'WARN' }),
    );
  });

  it('leaves a broad investigation to read every clone in place, as before', async () => {
    classifyInvestigationScope.mockResolvedValue({ scope: 'broad', confidence: 0.5, method: 'llm' });

    await runInvestigationWorkflow({ task: makeTask('the page is broken'), config, slack: slackStub() as any });

    expect(prepareSiblingRepos).not.toHaveBeenCalled();
    expect(runCodex.mock.calls[0][0].readDirs).toBeUndefined();
  });
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
    const investigationStore = { save: vi.fn(), clear: vi.fn() } as any;

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
    runCodex.mockReset().mockResolvedValue({
      ...investigatorOk(),
      parsedJson: { ...investigatorOk().parsedJson, fixLocation: 'repo' },
    });
    const slack = slackStub();
    const investigationStore = { save: vi.fn(), clear: vi.fn() } as any;

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

  async function investigateWith(parsedJson: Record<string, unknown>, investigationStore: any = undefined) {
    runCodex.mockReset().mockResolvedValue({ ok: true, exitCode: 0, parsedJson });
    const slack = slackStub();
    investigationStore ??= { save: vi.fn(), clear: vi.fn() };
    const logStep = vi.fn();
    await runInvestigationWorkflow({
      task: makeTask('the form submits on its own'),
      config,
      slack: slack as any,
      investigationStore,
      jobId: 'job-1',
      logStep,
    });
    const texts = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    return { texts, investigationStore, logStep };
  }

  it('does not offer a fix when it concluded nothing needs fixing, and keeps nothing to resume (issue #624)', async () => {
    const { texts, investigationStore, logStep } = await investigateWith({
      rootCauseHypothesis: 'The form auto-submits on purpose once the OTP is complete.',
      evidence: [],
      recommendedFix: 'No change needed.',
      fixLocation: 'none',
      confidence: 'high',
      summary: 'This is intended: the form submits itself when the OTP is filled in.',
    });

    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    expect(texts).toContain(NOTHING_TO_FIX_REPLY);
    expect(texts.some(text => text.includes('This is intended'))).toBe(true);
    expect(investigationStore.save).not.toHaveBeenCalled();
    expect(investigationStore.clear).toHaveBeenCalledWith('1.1');
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'investigation.nothing_to_fix' }));
  });

  it('attaches a table in the findings as a CSV (issue #731)', async () => {
    runCodex.mockReset().mockResolvedValue({
      ok: true,
      exitCode: 0,
      parsedJson: {
        // The table opens the field: it must not join the "Root cause:" label.
        rootCauseHypothesis: [
          '| Batch | Lost |',
          '|---|---|',
          ...Array.from({ length: 5 }, (_, i) => `| B${i} | ${i} |`),
        ].join('\n'),
        evidence: [],
        recommendedFix: 'none',
        fixLocation: 'none',
        summary: 'Leads were dropped by a filter.',
      },
    });
    const filesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
    const slack = { ...slackStub(), filesUploadV2 };
    await runInvestigationWorkflow({
      task: makeTask('why did leads drop?'),
      config,
      slack: slack as any,
      investigationStore: { save: vi.fn(), clear: vi.fn() } as any,
      jobId: 'job-1',
    });
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const upload = filesUploadV2.mock.calls[0][0];
    expect(upload.file_uploads[0].filename).toBe('root-cause.csv');
    expect(upload.file_uploads[0].file.toString('utf8')).toContain('Batch,Lost\r\nB0,0\r\n');
  });

  it('drops an earlier investigation in the thread when this one finds nothing to fix', async () => {
    const rows = new Map<string, any>([['1.1', { threadTs: '1.1', summary: 'an older diagnosis' }]]);
    const investigationStore = {
      save: vi.fn((row: any) => rows.set(row.threadTs, row)),
      getForThread: (threadTs: string) => rows.get(threadTs),
      clear: vi.fn((threadTs: string) => rows.delete(threadTs)),
    };

    await investigateWith(
      { rootCauseHypothesis: 'Intended.', evidence: [], recommendedFix: '', fixLocation: 'none', summary: 'Intended.' },
      investigationStore,
    );

    expect(investigationStore.getForThread('1.1')).toBeUndefined();
  });

  it('tells the investigator to use "none" when the fix only lists options (issue #624)', async () => {
    await investigateWith({
      rootCauseHypothesis: 'x',
      evidence: [],
      recommendedFix: 'y',
      fixLocation: 'repo',
      summary: 's',
    });

    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(FIX_LOCATION_RULE);
    expect(FIX_LOCATION_RULE).toContain('Use "none", not "repo", when nothing is broken');
    expect(FIX_LOCATION_RULE).toContain('use "repo" for that defect');
  });

  it('offers nothing when the investigator gives no verdict on where the fix is (issue #624)', async () => {
    const { texts, investigationStore, logStep } = await investigateWith({
      rootCauseHypothesis: 'x',
      evidence: [],
      recommendedFix: 'y',
      confidence: 'medium',
      summary: 's',
    });

    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    expect(texts).not.toContain(NOTHING_TO_FIX_REPLY);
    // The scope acknowledgement and the findings, nothing after them.
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('*s*');
    expect(investigationStore.save).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'investigation.no_fix_offer', level: 'WARN' }),
    );
  });

  it('warns about a verdict that is not one of the three', async () => {
    const { texts, logStep } = await investigateWith({
      rootCauseHypothesis: 'x',
      evidence: [],
      recommendedFix: 'y',
      fixLocation: 'maybe',
      summary: 's',
    });

    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'investigation.no_fix_offer', level: 'WARN' }),
    );
  });

  it('offers nothing for a fix in the code that it could not describe', async () => {
    const { texts, investigationStore } = await investigateWith({
      rootCauseHypothesis: '',
      evidence: [],
      recommendedFix: '  ',
      fixLocation: 'repo',
      confidence: 'low',
      summary: 'I could not pin this down.',
    });

    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    // The scope acknowledgement and the findings, nothing after them.
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('I could not pin this down.');
    expect(investigationStore.save).not.toHaveBeenCalled();
  });

  it('still asks for more context when it needs it, whatever the verdict', async () => {
    const { texts, investigationStore } = await investigateWith({
      rootCauseHypothesis: '',
      evidence: [],
      recommendedFix: '',
      fixLocation: 'none',
      confidence: 'low',
      requiresMoreInfo: 'Which page were you on?',
      summary: 'Not enough to go on.',
    });

    expect(texts.some(text => text.includes('Which page were you on?'))).toBe(true);
    expect(texts).not.toContain(NOTHING_TO_FIX_REPLY);
    expect(texts.some(text => text.includes('Want me to fix this?'))).toBe(false);
    expect(investigationStore.save).toHaveBeenCalledTimes(1);
    // A ✅ on the question is not a "yes, fix it": no prompt is kept for the reaction path.
    expect(investigationStore.save.mock.calls[0][0].promptMessageTs).toBeUndefined();
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

describe('the usage limit (issue #592)', () => {
  const saved = { ...__infraRetry };
  afterEach(() => {
    Object.assign(__infraRetry, saved);
  });

  beforeEach(() => {
    runCodex.mockReset();
    __infraRetry.sleep = vi.fn(async () => true);
    __infraRetry.delaysMs = [1, 1];
    classifyInvestigationScope.mockResolvedValue({
      scope: 'newton-web',
      confidence: 0.9,
      reasoning: 'ui',
      method: 'llm',
    });
  });

  it('says the usage limit was hit and when it resets, does not retry, and does not ask for more context (issue #592)', async () => {
    runCodex.mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: "You've hit your usage limit · resets 4:50pm (Asia/Calcutta)",
      errorKind: 'USAGE_LIMIT',
      limitResetsAtText: '4:50pm (Asia/Calcutta)',
    });
    const slack = slackStub();

    const result = await runInvestigationWorkflow({
      task: makeTask('button is misaligned'),
      config,
      slack: slack as any,
    });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ workflow: 'INVESTIGATION', status: 'FAILED' });
    const posted = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(posted).toContain(
      "I've hit my usage limit, so I can't investigate this right now. It resets 4:50pm (Asia/Calcutta); ask me again after that.",
    );
    expect(posted.some(t => t.includes('share more context'))).toBe(false);
  });
});

describe('investigationNextStep (issues #432, #624)', () => {
  it('offers a fix only for a described fix in the code', () => {
    expect(investigationNextStep({ fixLocation: 'repo', recommendedFix: 'Guard the null.' })).toBe('offer_fix');
    expect(investigationNextStep({ fixLocation: 'repo', recommendedFix: '' })).toBe('no_offer');
    expect(investigationNextStep({ fixLocation: 'repo' })).toBe('no_offer');
  });

  it('says there is nothing to fix for "none"', () => {
    expect(investigationNextStep({ fixLocation: 'none', recommendedFix: 'No change needed.' })).toBe('nothing_to_fix');
  });

  it('points elsewhere for "outside"', () => {
    expect(investigationNextStep({ fixLocation: 'outside', recommendedFix: 'Edit the Metabase card.' })).toBe(
      'fix_outside_repos',
    );
  });

  it('asks for more before anything else, except a fix that is outside the code', () => {
    expect(investigationNextStep({ fixLocation: 'none', requiresMoreInfo: 'Which page?' })).toBe('ask_for_more');
    expect(investigationNextStep({ fixLocation: 'repo', recommendedFix: 'x', requiresMoreInfo: 'Which page?' })).toBe(
      'ask_for_more',
    );
    expect(investigationNextStep({ requiresMoreInfo: 'Which page?' })).toBe('ask_for_more');
  });

  it('offers nothing for a missing or unknown verdict', () => {
    expect(investigationNextStep({ recommendedFix: 'x' })).toBe('no_offer');
    expect(investigationNextStep({ fixLocation: 'maybe', recommendedFix: 'x' })).toBe('no_offer');
  });
});

// A symptom fixed days earlier is found by reading the history (issue #621).
describe('runInvestigationWorkflow recent commits', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-inv-recent-'));
    const run = (args: string[], env: Record<string, string> = {}) =>
      execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env } });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(repo, 'src/features/agentic-ai-course'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/features/agentic-ai-course/content.ts'), 'fee 1.5L\n');
    run(['add', '.']);
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    run(['commit', '-q', '-m', 'admission fee total 1.3L -> 1.5L (#1483)'], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    classifyInvestigationScope.mockResolvedValue({ scope: 'newton-marketing-web', confidence: 0.9, source: 'llm' });
    prepareWorkflowContext.mockResolvedValue({ ...baseCtx, cwd: repo, repoName: 'newton-marketing-web' });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('tells the investigator to check the history before "cannot reproduce"', async () => {
    const logStep = vi.fn();
    await runInvestigationWorkflow({
      task: makeTask('the admission fee on the Agentic AI course page changed, is this a bug?'),
      config,
      slack: slackStub() as any,
      logStep,
    });
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('do not conclude "cannot reproduce"');
    // The commit near what was reported is handed over up front, as a hint.
    expect(prompt).toContain('unchecked hints');
    expect(prompt).toContain('src/features/agentic-ai-course ("agentic ai course")');
    expect(prompt).toContain('admission fee total 1.3L -> 1.5L (#1483)');
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'investigation.recent_changes',
        data: {
          matched: [{ repo: 'newton-marketing-web', pathspecs: ['src/features/agentic-ai-course'], commits: 1 }],
        },
      }),
    );
  });

  it('adds no block when the report names nothing in the repo', async () => {
    await runInvestigationWorkflow({
      task: makeTask('something on the site looks off'),
      config,
      slack: slackStub() as any,
    });
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('do not conclude "cannot reproduce"');
    expect(prompt).not.toContain('unchecked hints');
  });
});
