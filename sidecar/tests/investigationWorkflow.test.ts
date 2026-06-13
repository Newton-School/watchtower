/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  runCodex.mockReset().mockResolvedValue(investigatorOk());
  getActiveBackendId.mockReset().mockReturnValue('claude-code');
  classifyInvestigationScope.mockReset();
  prepareWorkflowContext.mockReset().mockResolvedValue({
    cwd: '/repos',
    repoName: undefined,
    threadContext: 'thread',
    imageContext: '',
    githubToken: undefined,
    desktopOnly: undefined,
  });
});

describe('runInvestigationWorkflow scope wiring', () => {
  it('single-repo scope passes repoOverride and uses NO mcp servers', async () => {
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
    expect(runCodex.mock.calls[0][0].mcpServers).toBeUndefined();
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
    // The broad prompt references both repos + read-only Metabase.
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toMatch(/newton-web/);
    expect(prompt).toMatch(/newton-api/);
    expect(prompt).toMatch(/mcp__metabase__/);
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

    expect(runCodex.mock.calls[0][0].mcpServers).toBeUndefined();
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

    expect(runCodex.mock.calls[0][0].mcpServers).toBeUndefined();
    const prompt = runCodex.mock.calls[0][0].prompt as string;
    expect(prompt).toMatch(/No database access is available/);
  });
});
