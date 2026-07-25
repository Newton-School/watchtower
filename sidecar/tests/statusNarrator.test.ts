import { describe, expect, it } from 'vitest';
import { narrateStep, sanitizeStatusFragment, summarizeCommand } from '../src/slack/statusNarrator.js';

/** Build an `agent.tool.use` step the way the stream decoder emits it. */
function toolStep(tool: string, detail?: string): Parameters<typeof narrateStep>[0] {
  return {
    stage: 'agent.tool.use',
    message: `Agent used ${tool}.`,
    data: detail === undefined ? { tool } : { tool, detail },
  };
}

describe('sanitizeStatusFragment', () => {
  it('redacts secret-shaped tokens', () => {
    expect(sanitizeStatusFragment('token is xoxb-123456-abcdefgh')).toContain('[redacted]');
    expect(sanitizeStatusFragment('xoxb-123456-abcdefgh')).not.toContain('xoxb-');
    expect(sanitizeStatusFragment('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('[redacted]');
    expect(sanitizeStatusFragment('Bearer abcdefghijklmnop')).toBe('[redacted]');
    expect(sanitizeStatusFragment('api_key=supersecretvalue')).toBe('[redacted]');
  });

  it('shortens absolute paths so no home directory leaks', () => {
    expect(sanitizeStatusFragment('/Users/dipesh/code/newton-web/src/nsat/config.ts')).toBe('src/nsat/config.ts');
    // No `src/` segment — fall back to the last two segments.
    expect(sanitizeStatusFragment('/Users/dipesh/code/newton-web/docs/architecture.md')).toBe('docs/architecture.md');
    expect(sanitizeStatusFragment('/Users/dipesh/code/newton-web/src/nsat/config.ts')).not.toContain('dipesh');
  });

  it('leaves relative paths alone', () => {
    expect(sanitizeStatusFragment('src/index.ts')).toBe('src/index.ts');
  });

  it('shortens short absolute paths too — length is not what makes them leak', () => {
    // Short enough to slip past a length threshold, but still exposes a username.
    expect(sanitizeStatusFragment('/Users/bob/x.ts')).toBe('bob/x.ts');
    expect(sanitizeStatusFragment('is reading /Users/bob/x.ts')).toBe('is reading bob/x.ts');
  });

  it('does not mangle URLs while shortening paths', () => {
    expect(sanitizeStatusFragment('https://docs.slack.dev/reference/methods')).toBe(
      'https://docs.slack.dev/reference/methods',
    );
  });

  it('collapses whitespace and truncates to the cap', () => {
    expect(sanitizeStatusFragment('a\n\n  b   c')).toBe('a b c');
    const long = 'x'.repeat(200);
    const out = sanitizeStatusFragment(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('summarizeCommand', () => {
  it('unwraps the shell wrapper Codex adds', () => {
    expect(summarizeCommand(`/bin/zsh -lc "sed -n '1,200p' a.txt"`)).toBe('sed -n');
    expect(summarizeCommand(`bash -c 'npm test'`)).toBe('npm test');
  });

  it('keeps only the binary and one argument', () => {
    expect(summarizeCommand('npm run build --workspace sidecar')).toBe('npm run');
    expect(summarizeCommand('git status')).toBe('git status');
  });

  it('stops at the first command separator', () => {
    expect(summarizeCommand('npm test && rm -rf dist')).toBe('npm test');
    expect(summarizeCommand('cat a.txt | grep foo')).toBe('cat a.txt');
  });

  it('never echoes a credential embedded in a command', () => {
    expect(summarizeCommand('curl -H "Authorization: Bearer abcdefghijklmnop" https://x')).not.toContain('abcdefgh');
  });
});

describe('narrateStep — tool events', () => {
  it('names the skill being used', () => {
    expect(narrateStep(toolStep('Skill', 'rca-job'))?.text).toBe('is using the rca-job skill');
  });

  it('names a plugin-namespaced skill', () => {
    expect(narrateStep(toolStep('Skill', 'figma:figma-use'))?.text).toBe('is using the figma:figma-use skill');
  });

  it('reports MCP calls by server, not by raw tool name', () => {
    expect(narrateStep(toolStep('mcp__metabase__execute_query'))?.text).toBe('is querying metabase');
    expect(narrateStep(toolStep('mcp__newton-grafana-prod__query_loki_logs'))?.text).toBe(
      'is querying newton grafana prod',
    );
  });

  it('handles subagents under both the Agent and Task names', () => {
    expect(narrateStep(toolStep('Agent', 'Find .txt files'))?.text).toBe('is spawning a subagent — Find .txt files');
    expect(narrateStep(toolStep('Task', 'review'))?.text).toBe('is spawning a subagent — review');
    expect(narrateStep(toolStep('Agent'))?.text).toBe('is spawning a subagent');
  });

  it('maps the common file and shell tools', () => {
    expect(narrateStep(toolStep('Read', 'src/nsat/config.ts'))?.text).toBe('is reading src/nsat/config.ts');
    expect(narrateStep(toolStep('Grep', '"NSAT frequency"'))?.text).toBe('is searching for "NSAT frequency"');
    expect(narrateStep(toolStep('Bash', 'npm test'))?.text).toBe('is running `npm test`');
    expect(narrateStep(toolStep('Edit', 'src/app.ts'))?.text).toBe('is editing src/app.ts');
    expect(narrateStep(toolStep('WebFetch', 'docs.slack.dev'))?.text).toBe('is fetching docs.slack.dev');
  });

  it('suppresses bookkeeping tools that say nothing about progress', () => {
    expect(narrateStep(toolStep('TodoWrite', 'x'))).toBeUndefined();
    expect(narrateStep(toolStep('ToolSearch', 'x'))).toBeUndefined();
  });

  it('falls back to a generic phrase for an unknown tool', () => {
    expect(narrateStep(toolStep('SomeNewTool'))?.text).toBe('is using SomeNewTool');
  });

  it('re-sanitizes detail even if the decoder passed something unsafe', () => {
    const narrated = narrateStep(toolStep('Read', '/Users/dipesh/code/newton-web/src/a.ts'));
    expect(narrated?.text).toBe('is reading src/a.ts');
    expect(narrated?.text).not.toContain('dipesh');
  });

  it('ignores a tool event with no tool name', () => {
    expect(narrateStep({ stage: 'agent.tool.use', message: 'x', data: {} })).toBeUndefined();
  });
});

describe('narrateStep — workflow stages', () => {
  it('maps exact stages across workflows', () => {
    expect(narrateStep({ stage: 'pipeline.agent.coder.start', message: '' })?.text).toBe('is writing the code…');
    expect(narrateStep({ stage: 'agentic.pr_review.fanout.start', message: '' })?.text).toBe(
      'is running the review lenses…',
    );
    expect(narrateStep({ stage: 'qa.pr.dev_server_ready', message: '' })?.text).toBe('is booting a dev server…');
    expect(narrateStep({ stage: 'pr.creating', message: '' })?.text).toBe('is opening a PR…');
  });

  it('marks human-wait gates as suspend so the status is not pinned for hours', () => {
    const approval = narrateStep({ stage: 'pipeline.approval.waiting', message: '' });
    expect(approval).toEqual({ text: 'is waiting for your approval', suspend: true });

    const clarify = narrateStep({ stage: 'pipeline.clarification.asking', message: '' });
    expect(clarify?.suspend).toBe(true);
  });

  it('returns undefined for unmapped bookkeeping stages rather than echoing the stage name', () => {
    expect(narrateStep({ stage: 'agent.stdout.start', message: '' })).toBeUndefined();
    expect(narrateStep({ stage: 'learning.signal.persist_failed', message: '' })).toBeUndefined();
    expect(narrateStep({ stage: 'job.created', message: '' })).toBeUndefined();
    expect(narrateStep({ stage: 'some.brand.new.stage', message: '' })).toBeUndefined();
  });

  it('prefers the longest matching prefix', () => {
    // Both `deploy.marketing.poll` and nothing shorter should match; the deploy
    // poll copy must win over any generic deploy rule.
    expect(narrateStep({ stage: 'deploy.marketing.poll_failed', message: '' })?.text).toBe(
      'is waiting for the deploy to finish…',
    );
  });
});
