import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeBackend, stripPlanHarnessMeta } from '../src/backends/claudeCodeBackend.js';

describe('claudeCodeBackend.parseOutput', () => {
  it('unwraps Claude Code wrapper and extracts inner structured JSON', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        status: 'success',
        summary: 'Merged PR #7638 into master.',
        actions: ['Merged PR'],
        prUrl: 'https://github.com/org/repo/pull/7638',
      }),
      session_id: 'abc-123',
      cost_usd: 0.05,
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Merged PR #7638 into master.');
    expect(parsed.parsedJson?.prUrl).toBe('https://github.com/org/repo/pull/7638');
    expect(parsed.strategy).toContain('claude_unwrap');
  });

  it('unwraps Claude Code wrapper with plain text result into synthetic summary', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: "Yes, I'm here! How can I help you?",
      session_id: 'abc-456',
      cost_usd: 0.01,
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe("Yes, I'm here! How can I help you?");
    expect(parsed.strategy).toBe('claude_unwrap+plain_text');
  });

  it('handles inner JSON wrapped in markdown fences', () => {
    const innerJson = '```json\n{"status":"success","summary":"Done fixing.","actions":["fixed"],"prUrl":""}\n```';
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: innerJson,
      session_id: 'abc-789',
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Done fixing.');
    expect(parsed.strategy).toBe('claude_unwrap+fenced_block');
  });

  it('falls back to direct parsing when output is not a Claude Code wrapper', () => {
    const raw = JSON.stringify({
      status: 'success',
      summary: 'Direct JSON output.',
      actions: [],
      prUrl: '',
    });

    const parsed = claudeCodeBackend.parseOutput(raw);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Direct JSON output.');
    expect(parsed.strategy).toBe('direct');
  });

  it('extracts cost_usd and usage tokens from the outer envelope', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Plain reply.',
      session_id: 'sess-1',
      cost_usd: 0.0123,
      usage: {
        input_tokens: 1500,
        output_tokens: 320,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      },
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.costUsd).toBe(0.0123);
    expect(parsed.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 320,
      cacheCreationTokens: 200,
      cacheReadTokens: 800,
    });
  });

  // The installed CLI emits `total_cost_usd`; reading only the legacy
  // `cost_usd` key meant real runs recorded no cost in agent_calls at all,
  // while these fixtures kept passing.
  it('extracts cost from total_cost_usd as emitted by the current CLI', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Plain reply.',
      session_id: 'sess-cost',
      total_cost_usd: 0.142377,
    });

    expect(claudeCodeBackend.parseOutput(wrapper).costUsd).toBe(0.142377);
  });

  it('prefers total_cost_usd when both keys are present', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Plain reply.',
      total_cost_usd: 0.5,
      cost_usd: 0.1,
    });

    expect(claudeCodeBackend.parseOutput(wrapper).costUsd).toBe(0.5);
  });

  it('returns undefined usage when envelope has no usage block', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'no usage info here',
      session_id: 'sess-2',
    });
    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.usage).toBeUndefined();
    expect(parsed.costUsd).toBeUndefined();
  });

  describe('plan mode (--permission-mode plan)', () => {
    // Captured envelope from a real run of
    //   claude -p "..." --output-format json --permission-mode plan
    // (Claude Code 2.1.142). The plan markdown lives in
    // `permission_denials[].tool_input.plan`, NOT in `result`. Pre-fix, the
    // parser only looked at `result` and the planner workflow failed with
    // "Planner returned no plan content" whenever the model went straight to
    // ExitPlanMode without writing a textual preamble.
    const planMarkdown =
      '# Plan: Add `subtract` function to `foo.ts`\n\n' +
      '## Change\n' +
      'Append a `subtract(a, b)` function below `add`, matching the existing signature.\n';

    it('extracts the plan from ExitPlanMode in permission_denials', () => {
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Plan written to `/Users/x/.claude/plans/foo.md` — awaiting approval.',
        session_id: 'plan-session-1',
        cost_usd: 0.27,
        permission_denials: [
          {
            tool_name: 'ExitPlanMode',
            tool_use_id: 'toolu_01TZe5A8tTxA9DFpFNh1QixX',
            tool_input: {
              plan: planMarkdown,
              planFilePath: '/Users/x/.claude/plans/foo.md',
            },
          },
        ],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper);
      expect(parsed.strategy).toBe('claude_unwrap+exit_plan_mode');
      expect(parsed.parsedJson?.planMarkdown).toBe(planMarkdown.trim());
      // Also mirrored into `summary` so downstream consumers that only look at
      // `summary` (existing normalizePlannerOutput fallback chain) still work.
      expect(parsed.parsedJson?.summary).toBe(planMarkdown.trim());
      expect(parsed.sessionId).toBe('plan-session-1');
      expect(parsed.costUsd).toBe(0.27);
    });

    it('recovers the plan when result is empty (the production failure mode)', () => {
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '', // Model went straight to ExitPlanMode without a text preamble
        session_id: 'plan-session-2',
        permission_denials: [
          {
            tool_name: 'ExitPlanMode',
            tool_use_id: 'toolu_xyz',
            tool_input: { plan: planMarkdown },
          },
        ],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper);
      expect(parsed.strategy).toBe('claude_unwrap+exit_plan_mode');
      expect(parsed.parsedJson?.planMarkdown).toBe(planMarkdown.trim());
    });

    it('prefers the most recent ExitPlanMode call when several are denied', () => {
      const firstPlan = '# Old plan';
      const finalPlan = '# Revised plan after admin feedback';
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '',
        permission_denials: [
          { tool_name: 'ExitPlanMode', tool_input: { plan: firstPlan } },
          { tool_name: 'ExitPlanMode', tool_input: { plan: finalPlan } },
        ],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper);
      expect(parsed.parsedJson?.planMarkdown).toBe(finalPlan);
    });

    it('ignores denials that are not ExitPlanMode or have an empty plan', () => {
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'fell back to result text',
        permission_denials: [
          { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'x' } },
          { tool_name: 'ExitPlanMode', tool_input: { plan: '   ' } }, // whitespace-only
        ],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper);
      // No usable ExitPlanMode plan, so it falls through to the existing
      // plain-text path that surfaces `result` as `summary`.
      expect(parsed.strategy).toBe('claude_unwrap+plain_text');
      expect(parsed.parsedJson?.summary).toBe('fell back to result text');
    });
  });

  describe('plan-file CLIs (no headless ExitPlanMode — issue #408)', () => {
    // On Claude Code ≥~2.1.2xx (observed 2.1.209), `-p --permission-mode plan`
    // does NOT register ExitPlanMode: permission_denials stays empty, the
    // model writes the plan to ~/.claude/plans/<slug>.md and mentions that
    // path in its final text. These fixtures mirror the live 2026-07-14
    // incident (job a1079d24).
    const planMarkdown = '# Plan: add floating WhatsApp pill\n\n## Files to touch\n- `src/features/x.tsx`\n';

    function writeTempPlanFile(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plan-'));
      const planPath = path.join(dir, '.claude', 'plans', 'user-context-auto-generated-test.md');
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, planMarkdown);
      return planPath;
    }

    it('recovers the plan from the plan file named in the final text (plan mode)', () => {
      const planPath = writeTempPlanFile();
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result:
          `I've written the plan to \`${planPath}\`. \`ExitPlanMode\` isn't available as a callable tool in this session ` +
          `(it isn't registered as a deferred tool either), so I'll stop here and hand off — the coder agent reads the plan file verbatim.`,
        session_id: 'plan-session-3',
        permission_denials: [],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper, { planMode: true });
      expect(parsed.strategy).toBe('claude_unwrap+plan_file');
      expect(parsed.parsedJson?.planMarkdown).toBe(planMarkdown.trim());
      expect(parsed.parsedJson?.summary).toBe(planMarkdown.trim());
    });

    it('sanitizes harness meta-text from the summary when the plan file is unreadable', () => {
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result:
          "I've written the plan to `/nonexistent/.claude/plans/gone.md`. `ExitPlanMode` isn't available as a callable tool in this session, so I'll stop here.\n\n" +
          '**Summary:** Add the floating WhatsApp pill to the NSAT route.',
        permission_denials: [],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper, { planMode: true });
      expect(parsed.strategy).toBe('claude_unwrap+plain_text');
      const summary = String(parsed.parsedJson?.summary ?? '');
      expect(summary).not.toContain('ExitPlanMode');
      expect(summary).not.toContain('written the plan to');
      expect(summary).toContain('floating WhatsApp pill');
    });

    it('keeps the original text when stripping would leave nothing (fail-open)', () => {
      expect(stripPlanHarnessMeta('`ExitPlanMode` is not available.')).toBe('`ExitPlanMode` is not available.');
    });

    it('does not mutilate text that merely DISCUSSES plan-mode internals', () => {
      const answer =
        'The backend passes `--permission-mode plan` so the planner is read-only.\n' +
        'ExitPlanMode used to be the harvest channel; see claudeCodeBackend.ts.';
      expect(stripPlanHarnessMeta(answer)).toBe(answer);
    });

    it('recovers from tool_input.planFilePath when the denial carries no inline plan', () => {
      const planPath = writeTempPlanFile();
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '',
        permission_denials: [{ tool_name: 'ExitPlanMode', tool_input: { plan: '', planFilePath: planPath } }],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper);
      expect(parsed.strategy).toBe('claude_unwrap+exit_plan_mode');
      expect(parsed.parsedJson?.planMarkdown).toBe(planMarkdown.trim());
    });

    it('does not misreport errors: envelope error status survives the sanitizer', () => {
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'You have hit your usage limit.',
        permission_denials: [],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper, { planMode: true });
      expect(parsed.strategy).toBe('claude_unwrap+plain_text');
      expect(parsed.parsedJson?.status).toBe('error');
      expect(parsed.parsedJson?.summary).toBe('You have hit your usage limit.');
    });

    it('NEVER hijacks non-plan runs that mention a plans path (review defect)', () => {
      const planPath = writeTempPlanFile();
      // (a) a valid JSON result naming the plans file keeps its JSON.
      const jsonWrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          status: 'success',
          summary: `the stale plan at ${planPath} was the culprit`,
          actions: [],
          prUrl: '',
        }),
        permission_denials: [],
      });
      const parsedJsonRun = claudeCodeBackend.parseOutput(jsonWrapper);
      expect(parsedJsonRun.strategy).not.toBe('claude_unwrap+plan_file');
      expect(String(parsedJsonRun.parsedJson?.summary)).toContain('was the culprit');

      // (b) a plain-text non-plan answer naming the plans file is untouched.
      const textWrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: `RCA: the planner wrote ${planPath} but the harvest failed. ExitPlanMode was not available on this CLI.`,
        permission_denials: [],
      });
      const parsedTextRun = claudeCodeBackend.parseOutput(textWrapper);
      expect(parsedTextRun.strategy).toBe('claude_unwrap+plain_text');
      expect(String(parsedTextRun.parsedJson?.summary)).toContain('the harvest failed');
    });

    it('a long final-message plan that cites an old plan file is NOT displaced by the file (review defect)', () => {
      const planPath = writeTempPlanFile();
      const realPlan =
        '# Plan: rework harvest\n\n' +
        `## Context\nThe prior incident artifact lives at ${planPath} and shows the failure shape.\n\n` +
        '## Steps\n' +
        Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${i + 1} does a concrete thing to a concrete file.`).join(
          '\n',
        ) +
        '\n\nScope: medium\nRequires code changes: yes';
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: realPlan,
        permission_denials: [],
      });

      const parsed = claudeCodeBackend.parseOutput(wrapper, { planMode: true });
      expect(parsed.strategy).toBe('claude_unwrap+plain_text');
      expect(String(parsed.parsedJson?.summary)).toContain('rework harvest');
      expect(String(parsed.parsedJson?.summary)).not.toBe(planMarkdown.trim());
    });

    it('plan-file regex returns quickly on slash-dense tokens (ReDoS regression)', () => {
      const slashBomb = `https://bucket.s3.amazonaws.com/${'a/'.repeat(200)}object?sig=${'b/'.repeat(120)}end`;
      const wrapper = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: `Uploaded to ${slashBomb} — done.`,
        permission_denials: [],
      });
      const startedAt = Date.now();
      const parsed = claudeCodeBackend.parseOutput(wrapper, { planMode: true });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(parsed.strategy).toBe('claude_unwrap+plain_text');
    });
  });
});

describe('claudeCodeBackend.buildArgs', () => {
  const baseRequest = {
    cwd: '/tmp/repo',
    prompt: 'hello',
  } as Parameters<typeof claudeCodeBackend.buildArgs>[0];

  it('uses --dangerously-skip-permissions when planMode is not set', () => {
    const args = claudeCodeBackend.buildArgs(baseRequest, '/tmp/out.json');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('requests stream-json so tool activity can be narrated live', () => {
    const args = claudeCodeBackend.buildArgs(baseRequest, '/tmp/out.json');
    const idx = args.indexOf('--output-format');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('stream-json');
    // The CLI rejects stream-json under --print without --verbose.
    expect(args).toContain('--verbose');
  });

  it('still streams in plan mode', () => {
    const args = claudeCodeBackend.buildArgs({ ...baseRequest, planMode: true }, '/tmp/out.json');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('uses --permission-mode plan and omits skip-permissions when planMode is true', () => {
    const args = claudeCodeBackend.buildArgs({ ...baseRequest, planMode: true }, '/tmp/out.json');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('plan');
  });

  it('marks plain-text output from an error envelope as status error, not success (issue #342)', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your session limit · resets 9:40pm (Asia/Calcutta)",
      session_id: 'sess-limit',
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);

    expect(parsed.parsedJson?.status).toBe('error');
    expect(parsed.parsedJson?.summary).toContain('session limit');
  });

  it('keeps plain-text output from a success envelope as status success', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done, nothing structured to report.',
      session_id: 'sess-ok',
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);

    expect(parsed.parsedJson?.status).toBe('success');
  });
});

describe('claudeCodeBackend MCP + env wiring (scoped investigation)', () => {
  const baseRequest = {
    cwd: '/tmp/repo',
    prompt: 'investigate',
  } as Parameters<typeof claudeCodeBackend.buildArgs>[0];

  it('emits --mcp-config + --strict-mcp-config when mcpServers is set', () => {
    const args = claudeCodeBackend.buildArgs(
      { ...baseRequest, mcpServers: { metabase: { type: 'http', url: 'https://mb/api/mcp' } } },
      '/tmp/out.json',
    );
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[idx + 1])).toEqual({
      mcpServers: { metabase: { type: 'http', url: 'https://mb/api/mcp' } },
    });
    expect(args).toContain('--strict-mcp-config');
  });

  it('omits MCP flags when no mcpServers are provided', () => {
    const args = claudeCodeBackend.buildArgs(baseRequest, '/tmp/out.json');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('omits MCP flags for an empty mcpServers object', () => {
    const args = claudeCodeBackend.buildArgs({ ...baseRequest, mcpServers: {} }, '/tmp/out.json');
    expect(args).not.toContain('--mcp-config');
  });

  it('passes HOME (and USER) in buildEnv so the MCP OAuth keychain resolves', () => {
    const prevHome = process.env.HOME;
    const prevUser = process.env.USER;
    process.env.HOME = '/Users/tester';
    process.env.USER = 'tester';
    try {
      const env = claudeCodeBackend.buildEnv(baseRequest, '/usr/bin');
      expect(env.HOME).toBe('/Users/tester');
      expect(env.USER).toBe('tester');
      expect(env.PATH).toBe('/usr/bin');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUser === undefined) delete process.env.USER;
      else process.env.USER = prevUser;
    }
  });
});
