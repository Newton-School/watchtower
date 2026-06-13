/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn(() => 'claude-code'),
}));
vi.mock('../src/codex/modelProfiles.js', () => ({
  lightweightProfile: vi.fn(() => ({ model: 'haiku-test', reasoningEffort: 'low' })),
}));

const { runCodex } = await import('../src/codex/runCodex.js');
const { classifyInvestigationScope } = await import('../src/router/investigationScope.js');
const { __gitGrepHasHit } = await import('../src/router/repoClassifier.js');

function aiReply(parsedJson: Record<string, unknown>): any {
  return { ok: true, exitCode: 0, parsedJson };
}

describe('classifyInvestigationScope', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    // default grep seam: no hits (forces the LLM path unless a test overrides)
    __gitGrepHasHit.fn = () => false;
  });

  it('short-circuits to a single repo when a distinctive entity hits only there (no LLM call)', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      repoPath === '/web' && entity === 'TrackManagementCreateTaskModal';

    const out = await classifyInvestigationScope({
      bugReport: 'The TrackManagementCreateTaskModal renders the due date in the wrong timezone',
      webPath: '/web',
      apiPath: '/api',
    });

    expect(out.scope).toBe('newton-web');
    expect(out.method).toBe('grep');
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('short-circuits to newton-api for a distinctive backend identifier', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      repoPath === '/api' && entity === 'recompute_course_progress';

    const out = await classifyInvestigationScope({
      bugReport: 'recompute_course_progress returns stale totals after a submission',
      webPath: '/web',
      apiPath: '/api',
    });

    expect(out.scope).toBe('newton-api');
    expect(out.method).toBe('grep');
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('uses the LLM verdict when grep is inconclusive', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ scope: 'newton-web', confidence: 0.8, reasoning: 'layout/rendering symptom' }),
    );

    const out = await classifyInvestigationScope({
      bugReport: 'the sidebar overlaps the header on small screens',
      webPath: '/web',
      apiPath: '/api',
    });

    expect(out.scope).toBe('newton-web');
    expect(out.method).toBe('llm');
    expect(runCodex).toHaveBeenCalledOnce();
  });

  it('classifies a data symptom as newton-api via the LLM', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ scope: 'newton-api', confidence: 0.77, reasoning: 'wrong data returned' }),
    );
    const out = await classifyInvestigationScope({ bugReport: 'my completed lessons count is wrong' });
    expect(out.scope).toBe('newton-api');
  });

  it('returns broad when the LLM says so', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ scope: 'broad', confidence: 0.4, reasoning: 'just a screenshot, could be either' }),
    );
    const out = await classifyInvestigationScope({ bugReport: 'this page looks broken [screenshot]' });
    expect(out.scope).toBe('broad');
  });

  it('coerces an unknown scope value to broad', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ scope: 'database', confidence: 0.9, reasoning: 'x' }));
    const out = await classifyInvestigationScope({ bugReport: 'something' });
    expect(out.scope).toBe('broad');
  });

  it('falls back to broad when the classifier call fails', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({ ok: false, exitCode: 1 } as any);
    const out = await classifyInvestigationScope({ bugReport: 'X is broken' });
    expect(out.scope).toBe('broad');
    expect(out.method).toBe('fallback');
  });

  it('falls back to broad when the classifier throws', async () => {
    vi.mocked(runCodex).mockRejectedValueOnce(new Error('CLI exploded'));
    const out = await classifyInvestigationScope({ bugReport: 'X is broken' });
    expect(out.scope).toBe('broad');
    expect(out.method).toBe('fallback');
  });
});
