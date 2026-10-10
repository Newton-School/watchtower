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
const { classifyRepo, extractEntities, gatherRepoSignals, buildClassifyPrompt, __gitGrepHasHit } =
  await import('../src/router/repoClassifier.js');

function aiReply(parsedJson: Record<string, unknown>): any {
  return { ok: true, exitCode: 0, parsedJson };
}

describe('classifyRepo (agent-based)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('returns the agent-selected repo when confidence clears the threshold', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.9, reasoning: 'nav bar removal on my.newtonschool.co URL' }),
    );
    const out = await classifyRepo({
      task: 'remove the whatsapp section in the right nav bar on my.newtonschool.co/tech-openings/all-jobs',
      threshold: 0.75,
    });
    expect(out.selectedRepo).toBe('newton-web');
    expect(out.uncertain).toBe(false);
    expect(out.confidence).toBe(0.9);
  });

  it('returns newton-api when the agent says so', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-api', confidence: 0.88, reasoning: 'django endpoint 500' }),
    );
    const out = await classifyRepo({
      task: 'the /api/v1/users endpoint returns 500 with a Django traceback',
      threshold: 0.75,
    });
    expect(out.selectedRepo).toBe('newton-api');
    expect(out.uncertain).toBe(false);
  });

  it('marks uncertain when confidence is below threshold', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.4, reasoning: 'thin signal' }),
    );
    const out = await classifyRepo({ task: 'something might be broken', threshold: 0.75 });
    expect(out.uncertain).toBe(true);
  });

  it('marks uncertain when the agent returns null', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ selectedRepo: null, confidence: 0.2, reasoning: 'no signal' }));
    const out = await classifyRepo({ task: 'hey', threshold: 0.75 });
    expect(out.selectedRepo).toBeNull();
    expect(out.uncertain).toBe(true);
  });

  it('falls back to uncertain when the agent call fails', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({ ok: false, exitCode: 1 } as any);
    const out = await classifyRepo({ task: 'anything', threshold: 0.75 });
    expect(out.uncertain).toBe(true);
    expect(out.selectedRepo).toBeNull();
  });

  it('does not call the agent when there is no task text', async () => {
    const out = await classifyRepo({ task: '   ', threadMessages: ['some thread chatter'], threshold: 0.75 });
    expect(out.uncertain).toBe(true);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('labels task and thread separately in the prompt so the agent weights them correctly', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.9, reasoning: 'frontend' }),
    );
    await classifyRepo({
      task: 'remove the blue banner',
      threadMessages: ['earlier we discussed an api 500'],
      threshold: 0.75,
    });
    const args = vi.mocked(runCodex).mock.calls[0][0];
    expect(args.prompt).toContain('Current task (the message to classify)');
    expect(args.prompt).toContain('Earlier thread messages (advisory background');
    expect(args.prompt).toContain('remove the blue banner');
    expect(args.prompt).toContain('earlier we discussed an api 500');
    // The task block must precede the thread block so the agent reads it first.
    expect(args.prompt.indexOf('remove the blue banner')).toBeLessThan(
      args.prompt.indexOf('earlier we discussed an api 500'),
    );
  });

  it('passes affinity and plan hints to the agent prompt as advisory context', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-api', confidence: 0.9, reasoning: 'planner hints + affinity' }),
    );
    await classifyRepo({
      task: 'fix the thing',
      threshold: 0.75,
      affinity: { 'newton-web': 1, 'newton-api': 20, 'newton-marketing-web': 3 },
      planAffectedFiles: ['handlers/create.py'],
    });
    const args = vi.mocked(runCodex).mock.calls[0][0];
    expect(args.prompt).toContain('newton-api=20 hits');
    expect(args.prompt).toContain('newton-marketing-web=3 hits');
    expect(args.prompt).toContain('handlers/create.py');
  });

  it('accepts newton-marketing-web from the agent', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-marketing-web', confidence: 0.9, reasoning: 'webflow page = marketing' }),
    );
    const out = await classifyRepo({
      // Strong marketing signal ("webflow") — a bare shared noun like "the
      // NSAT landing page" must NOT be presented as a decisive marketing ask.
      task: 'the CTA on the webflow about-us page is broken',
      threshold: 0.75,
    });
    expect(out.selectedRepo).toBe('newton-marketing-web');
    expect(out.uncertain).toBe(false);
  });

  it('nulls out unknown repo names from the agent', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-mobile', confidence: 0.9, reasoning: 'hallucinated repo' }),
    );
    const out = await classifyRepo({ task: 'fix the thing', threshold: 0.75 });
    expect(out.selectedRepo).toBeNull();
    expect(out.uncertain).toBe(true);
  });
});

describe('buildClassifyPrompt', () => {
  it('with marketing enabled: three repo blocks, host rule, opt-in default, and no URL⇒newton-web shortcut', () => {
    const prompt = buildClassifyPrompt(['newton-web', 'newton-api', 'newton-marketing-web']);
    expect(prompt).toContain('"newton-web"');
    expect(prompt).toContain('"newton-api"');
    expect(prompt).toContain('"newton-marketing-web"');
    // URL host is a first-class disambiguator between the two frontends.
    expect(prompt).toContain('my.newtonschool.co');
    expect(prompt).toContain('TELLING THE TWO FRONTENDS APART');
    // Marketing is opt-in; only STRONG signals are decisive.
    expect(prompt).toContain('NO STRONG marketing signal is "newton-web"');
    expect(prompt).toContain('Never guess between the two frontends');
    // The old binary rule must be gone — it is the #1 misroute source vs a second frontend.
    expect(prompt).not.toContain('almost always "newton-web"');
  });

  it('treats shared page nouns (NSAT/NST, landing page, homepage) as non-decisive between the frontends', () => {
    const prompt = buildClassifyPrompt(['newton-web', 'newton-api', 'newton-marketing-web']);
    // The shared-nouns tier exists and names the NSAT overlap explicitly.
    expect(prompt).toContain('SHARED PAGE NOUNS');
    expect(prompt).toContain('NSAT/NST pages');
    expect(prompt).toContain('newton-web owns the logged-in NSAT timeline');
    // NSAT must NOT appear as a decisive marketing signal — the strong list
    // carries no NSAT/NST or bare "landing page" tokens.
    const strongMarketingLine = prompt.split('\n').find(l => l.includes('STRONG marketing signals')) ?? '';
    expect(strongMarketingLine).not.toMatch(/NSAT|NST\b|landing page/i);
    // Shared nouns alone must route to the admin gate, not a guess.
    expect(prompt).toContain('Shared nouns ALONE');
  });

  it('without marketing: keeps the classic two-repo rule and omits marketing copy', () => {
    const prompt = buildClassifyPrompt(['newton-web', 'newton-api']);
    expect(prompt).not.toContain('newton-marketing-web');
    expect(prompt).not.toContain('TELLING THE TWO FRONTENDS APART');
    expect(prompt).toContain('almost always "newton-web"');
  });
});

describe('extractEntities', () => {
  it('extracts long kebab-case experiment / flag names', () => {
    const out = extractEntities(
      'stop the experiment share-payment-link-nsat-timeline-v2-experiment and set distribution to 0:100',
    );
    expect(out).toContain('share-payment-link-nsat-timeline-v2-experiment');
  });

  it('extracts snake_case Django identifiers', () => {
    const out = extractEntities(
      'what is the difference between content_management_contentcreationcoursestructuretask and users_userprofile',
    );
    expect(out).toContain('content_management_contentcreationcoursestructuretask');
    expect(out).toContain('users_userprofile');
  });

  it('extracts PascalCase class names', () => {
    const out = extractEntities('the ContentCreationCourseStructureTask model is broken');
    expect(out).toContain('ContentCreationCourseStructureTask');
  });

  it('extracts quoted strings', () => {
    const out = extractEntities('the flag is named "feature-flag-xyz-quoted" and it is broken');
    expect(out).toContain('feature-flag-xyz-quoted');
  });

  it('filters out short noise and de-dupes', () => {
    const out = extractEntities('fix the the the api api api now');
    // "the", "fix", "api", "now" are all < 6 chars → filtered.
    expect(out).toEqual([]);
  });

  it('caps the result so a long message does not produce an unbounded grep', () => {
    const noisy = Array.from({ length: 50 }, (_, i) => `entity-name-num-${i}`).join(' ');
    const out = extractEntities(noisy);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it('returns empty for empty / non-string input', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities(undefined as unknown as string)).toEqual([]);
  });
});

describe('gatherRepoSignals', () => {
  beforeEach(() => {
    __gitGrepHasHit.fn = () => false;
  });

  const WEB_API_PATHS: Array<{ key: 'newton-web' | 'newton-api'; path: string }> = [
    { key: 'newton-web', path: '/web' },
    { key: 'newton-api', path: '/api' },
  ];

  it('returns empty signals when no entities or paths', () => {
    const out = gatherRepoSignals({ entities: [], repoGrepPaths: WEB_API_PATHS });
    expect(out.hitsByRepo['newton-web']).toEqual([]);
    expect(out.hitsByRepo['newton-api']).toEqual([]);
    expect(out.hitsByRepo['newton-marketing-web']).toEqual([]);
    expect(out.hasDistinctiveHit).toBe(false);
  });

  it('records which repo matched each entity and flags distinctive (≥12-char) hits', () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) => {
      if (repoPath === '/web' && entity === 'share-payment-link-experiment') return true;
      if (repoPath === '/api' && entity === 'ViewSet') return true;
      return false;
    };
    const out = gatherRepoSignals({
      entities: ['share-payment-link-experiment', 'ViewSet'],
      repoGrepPaths: WEB_API_PATHS,
    });
    expect(out.hitsByRepo['newton-web']).toEqual(['share-payment-link-experiment']);
    expect(out.hitsByRepo['newton-api']).toEqual(['ViewSet']);
    // Marketing path not configured → never grepped, always empty.
    expect(out.hitsByRepo['newton-marketing-web']).toEqual([]);
    // share-payment-link-experiment is 29 chars → distinctive.
    expect(out.hasDistinctiveHit).toBe(true);
  });

  it('does NOT flag distinctive when only short entities hit', () => {
    __gitGrepHasHit.fn = (_: string, entity: string) => entity === 'short1';
    const out = gatherRepoSignals({
      entities: ['short1'],
      repoGrepPaths: WEB_API_PATHS,
    });
    expect(out.hasDistinctiveHit).toBe(false);
  });
});

describe('classifyRepo grep short-circuit', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    __gitGrepHasHit.fn = () => false;
  });

  const THREE_REPO_PATHS: Array<{ key: 'newton-web' | 'newton-api' | 'newton-marketing-web'; path: string }> = [
    { key: 'newton-web', path: '/web' },
    { key: 'newton-api', path: '/api' },
    { key: 'newton-marketing-web', path: '/marketing' },
  ];

  it('short-circuits to newton-web when a distinctive entity hits only in newton-web', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      repoPath === '/web' && entity === 'share-payment-link-nsat-timeline-v2-experiment';

    const out = await classifyRepo({
      task: 'stop the experiment share-payment-link-nsat-timeline-v2-experiment, set distribution to 0:100',
      threshold: 0.75,
      repoGrepPaths: THREE_REPO_PATHS,
    });

    expect(out.selectedRepo).toBe('newton-web');
    expect(out.uncertain).toBe(false);
    expect(out.confidence).toBe(0.95);
    expect(out.reasoning).toMatch(/Deterministic grep/);
    // LLM must NOT be called when grep short-circuits.
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('short-circuits to newton-api when a distinctive entity hits only in newton-api', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      repoPath === '/api' && entity === 'content_management_contentcreationcoursestructuretask';

    const out = await classifyRepo({
      task: 'describe the table content_management_contentcreationcoursestructuretask please',
      threshold: 0.75,
      repoGrepPaths: THREE_REPO_PATHS,
    });

    expect(out.selectedRepo).toBe('newton-api');
    expect(out.uncertain).toBe(false);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('short-circuits to newton-marketing-web when a distinctive entity hits only there', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      repoPath === '/marketing' && entity === 'data-science-ai-temp';

    const out = await classifyRepo({
      task: 'migrate the data-science-ai-temp page from Webflow',
      threshold: 0.75,
      repoGrepPaths: THREE_REPO_PATHS,
    });

    expect(out.selectedRepo).toBe('newton-marketing-web');
    expect(out.uncertain).toBe(false);
    expect(out.confidence).toBe(0.95);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when both frontends have hits — falls through to the LLM with the hint injected', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) =>
      (repoPath === '/web' || repoPath === '/marketing') && entity === 'shared-identifier-foo';
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ selectedRepo: 'newton-web', confidence: 0.8, reasoning: 'x' }));

    await classifyRepo({
      task: 'investigate shared-identifier-foo it appears in both repos',
      threshold: 0.75,
      repoGrepPaths: THREE_REPO_PATHS,
    });

    expect(runCodex).toHaveBeenCalledTimes(1);
    const args = vi.mocked(runCodex).mock.calls[0][0];
    expect(args.prompt).toContain('Deterministic grep evidence');
    expect(args.prompt).toContain('shared-identifier-foo');
  });

  it('does NOT short-circuit when only a short (non-distinctive) entity matches', async () => {
    __gitGrepHasHit.fn = (repoPath: string, entity: string) => repoPath === '/web' && entity === 'short1';
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ selectedRepo: 'newton-web', confidence: 0.8, reasoning: 'x' }));

    await classifyRepo({
      task: 'do short1 thing',
      threshold: 0.75,
      repoGrepPaths: THREE_REPO_PATHS,
    });

    // Falls through to LLM — non-distinctive short identifier shouldn't be enough to skip the agent.
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('skips grep entirely when no repo paths are configured', async () => {
    let grepCalls = 0;
    __gitGrepHasHit.fn = () => {
      grepCalls += 1;
      return false;
    };
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ selectedRepo: 'newton-web', confidence: 0.8, reasoning: 'x' }));

    await classifyRepo({
      task: 'something with share-payment-link-nsat-timeline-v2-experiment in it',
      threshold: 0.75,
    });

    expect(grepCalls).toBe(0);
    expect(runCodex).toHaveBeenCalledTimes(1);
  });
});
