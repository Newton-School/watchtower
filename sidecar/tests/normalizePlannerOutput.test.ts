import { describe, expect, it } from 'vitest';
import {
  normalizePlannerOutput,
  extractFilesToChange,
  isNone,
  parseApproverSummary,
  planWithoutApproverParts,
} from '../src/agents/normalizePlannerOutput.js';

describe('normalizePlannerOutput', () => {
  describe('codex backend (structured JSON)', () => {
    it('maps the planner JSON fields onto the normalized shape and renders markdown from plan + affectedFiles', () => {
      const raw = {
        plan: ['Step one', 'Step two'],
        affectedFiles: ['src/foo.ts', 'src/bar.ts'],
        scope: 'medium',
        requiresCodeChanges: true,
        clarificationNeeded: null,
      };
      const result = normalizePlannerOutput(raw, 'codex');
      expect(result.scope).toBe('medium');
      expect(result.requiresCodeChanges).toBe(true);
      expect(result.clarificationNeeded).toBeNull();
      expect(result.affectedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(result.planMarkdown).toContain('1. Step one');
      expect(result.planMarkdown).toContain('2. Step two');
      expect(result.planMarkdown).toContain('**Affected files:**');
      expect(result.planMarkdown).toContain('`src/foo.ts`');
    });

    it('passes through a non-empty clarificationNeeded string', () => {
      const result = normalizePlannerOutput(
        {
          plan: [],
          affectedFiles: [],
          scope: 'small',
          requiresCodeChanges: false,
          clarificationNeeded: 'Which repo do you mean?',
        },
        'codex',
      );
      expect(result.clarificationNeeded).toBe('Which repo do you mean?');
      expect(result.requiresCodeChanges).toBe(false);
    });

    it('coerces invalid scope to medium and missing requiresCodeChanges to true', () => {
      const result = normalizePlannerOutput({ plan: ['x'], affectedFiles: [] }, 'codex');
      expect(result.scope).toBe('medium');
      expect(result.requiresCodeChanges).toBe(true);
    });

    it('treats empty/whitespace clarificationNeeded as null', () => {
      const result = normalizePlannerOutput(
        { plan: ['x'], affectedFiles: [], scope: 'small', requiresCodeChanges: true, clarificationNeeded: '   ' },
        'codex',
      );
      expect(result.clarificationNeeded).toBeNull();
    });
  });

  describe('claude-code backend (free-form plan-mode markdown)', () => {
    it('reads planMarkdown from the parsedJson summary fallback (plain-text path)', () => {
      const raw = {
        status: 'success',
        summary: '# Plan\n\n1. Read foo.ts\n2. Edit bar.ts\n\nScope: small',
        actions: [],
        prUrl: '',
      };
      const result = normalizePlannerOutput(raw, 'claude-code');
      expect(result.planMarkdown).toContain('1. Read foo.ts');
      expect(result.scope).toBe('small');
      expect(result.requiresCodeChanges).toBe(true);
      expect(result.clarificationNeeded).toBeNull();
    });

    it('extracts backtick-wrapped file paths from the plan markdown', () => {
      const summary = [
        '# Plan',
        '',
        '- Update `apps/web/components/Banner.tsx` to remove the blue banner',
        '- Adjust `apps/web/styles/banner.css`',
        '- Leave `someUtility()` and `MyComponent` alone (not paths)',
        '- External: `https://example.com/foo` should be ignored',
        '',
        'Scope: medium',
      ].join('\n');
      const result = normalizePlannerOutput({ summary }, 'claude-code');
      expect(result.affectedFiles).toEqual(['apps/web/components/Banner.tsx', 'apps/web/styles/banner.css']);
    });

    it('extracts files identified by extension alone (no directory separator)', () => {
      const result = normalizePlannerOutput(
        { summary: 'Touch `README.md` and `package.json`. Skip `foo`.' },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['README.md', 'package.json']);
    });

    it('prefers an already-carried affectedFiles array over re-extracting from markdown', () => {
      const result = normalizePlannerOutput(
        {
          planMarkdown: 'Touch `src/foo.ts` and `src/bar.ts`.',
          affectedFiles: ['src/explicit.ts'],
        },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['src/explicit.ts']);
    });

    it('keeps Next.js route-group paths even though they contain parens', () => {
      const result = normalizePlannerOutput(
        { summary: 'Edit `src/app/(marketing)/page.tsx` and call `useRouter()`.' },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['src/app/(marketing)/page.tsx']);
    });

    it('rejects schemeless URLs whose first segment looks like a host', () => {
      const result = normalizePlannerOutput(
        {
          summary:
            'See `github.com/org/repo` and `docs.foo.com/page`, but do edit `src/foo.ts` and the relative `./util/bar.ts`.',
        },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['src/foo.ts', './util/bar.ts']);
    });

    it('never harvests harness bookkeeping paths under .claude/ (issue #408)', () => {
      const result = normalizePlannerOutput(
        {
          summary:
            "I've written the plan to `/Users/dipesh/.claude/plans/user-context-auto-generated-melodic-fox.md` and " +
            'also referenced `~/.claude/plans/other.md`. Edit `src/features/nst-entrance/sections/hero.tsx`.',
        },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['src/features/nst-entrance/sections/hero.tsx']);
    });

    it('keeps repo-relative .claude files (skills/settings) as affected files', () => {
      const result = normalizePlannerOutput(
        { summary: 'Add `.claude/skills/new-skill/SKILL.md` and update `.claude/settings.json`.' },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual(['.claude/skills/new-skill/SKILL.md', '.claude/settings.json']);
    });

    it('recognises known extensionless filenames and dotfiles', () => {
      const result = normalizePlannerOutput(
        {
          summary: 'Update `Dockerfile`, `Makefile`, `.gitignore`, `infra/main.tf`, and `api/users.proto`.',
        },
        'claude-code',
      );
      expect(result.affectedFiles).toEqual([
        'Dockerfile',
        'Makefile',
        '.gitignore',
        'infra/main.tf',
        'api/users.proto',
      ]);
    });

    it('is idempotent: re-normalizing an already-normalized output preserves planMarkdown', () => {
      const first = normalizePlannerOutput({ summary: '# Plan\n1. Do thing\nScope: large' }, 'claude-code');
      const augmented = {
        planMarkdown: first.planMarkdown,
        scope: first.scope,
        affectedFiles: first.affectedFiles,
        requiresCodeChanges: first.requiresCodeChanges,
        clarificationNeeded: first.clarificationNeeded,
      };
      const second = normalizePlannerOutput(augmented, 'claude-code');
      expect(second.planMarkdown).toBe(first.planMarkdown);
      expect(second.scope).toBe('large');
    });

    it('reads "Requires code changes: no" from the plan markdown as false (#348 RC2)', () => {
      const summary = '# Plan\n1. Explain the tracking rules\nScope: small\nRequires code changes: no';
      const result = normalizePlannerOutput({ summary }, 'claude-code');
      expect(result.requiresCodeChanges).toBe(false);
    });

    it('reads "Requires code changes: yes" from the plan markdown as true', () => {
      const summary = '# Plan\n1. Add a field\nScope: small\nRequires code changes: yes';
      const result = normalizePlannerOutput({ summary }, 'claude-code');
      expect(result.requiresCodeChanges).toBe(true);
    });

    it('defaults requiresCodeChanges to true when the marker is absent (backward-safe)', () => {
      const result = normalizePlannerOutput({ summary: '# Plan\n1. Do thing\nScope: small' }, 'claude-code');
      expect(result.requiresCodeChanges).toBe(true);
    });

    it('prefers an already-carried requiresCodeChanges boolean over the markdown marker (idempotency)', () => {
      const augmented = { planMarkdown: 'Requires code changes: yes', requiresCodeChanges: false };
      const result = normalizePlannerOutput(augmented, 'claude-code');
      expect(result.requiresCodeChanges).toBe(false);
    });

    it('defaults scope to medium when the markdown has no Scope: tag', () => {
      const result = normalizePlannerOutput({ summary: 'do some things' }, 'claude-code');
      expect(result.scope).toBe('medium');
    });

    it('handles a bare string input (unwrapped markdown)', () => {
      const result = normalizePlannerOutput('# Just markdown\n- bullet', 'claude-code');
      expect(result.planMarkdown).toContain('Just markdown');
    });
  });
});

describe('a plan written for its approver (issue #437)', () => {
  const PLAN = [
    '# Remove "Final admissions cycle for 2026" from the NST home page',
    '',
    '## For the approver',
    '- What changes: The yellow "Final admissions cycle for 2026" line under the hero heading disappears.',
    '- Where: /newton-school-of-technology-nst/home',
    '- Behaviour change: none',
    '- Assumptions to confirm: none',
    '- Risk: low',
    '',
    '## Context',
    'The line lives in `content.ts` and is rendered by `sections/hero.tsx`. `../nsat/page` reuses the hero.',
    'Do not touch `worker/**`. Branch from `origin/main`.',
    '',
    '## Files to change',
    '- `src/features/nst-home/content.ts` — drop the string',
    '- `src/features/nst-home/sections/hero.tsx` — stop rendering the empty line',
    '- `src/features/nst-home/CLAUDE.md` — changelog entry',
    '',
    '## Steps',
    '1. Remove `finalCycleNote` from `content.ts`.',
    '',
    'Scope: small',
    'Requires code changes: yes',
  ].join('\n');

  it('reads the five approver lines', () => {
    expect(parseApproverSummary(PLAN)).toEqual({
      whatChanges: 'The yellow "Final admissions cycle for 2026" line under the hero heading disappears.',
      where: '/newton-school-of-technology-nst/home',
      behaviourChange: 'none',
      assumptions: 'none',
      risk: 'low',
    });
  });

  it('reads them in the forms a model writes them: bold labels, American spelling, no heading', () => {
    const summary = parseApproverSummary(
      [
        '**What changes:** Proctor breach defaults go from 3 to 0.',
        '**Where:** TMS exam form',
        '**Behavior change:** An exam now ends on the very first flagged breach.',
        '**Risk:** High — changes exam outcomes',
      ].join('\n'),
    );

    expect(summary).toMatchObject({
      whatChanges: 'Proctor breach defaults go from 3 to 0.',
      behaviourChange: 'An exam now ends on the very first flagged breach.',
      assumptions: 'none',
      risk: 'high',
    });
  });

  it('finds no summary in a plan that has none, or whose block is not at the top', () => {
    expect(parseApproverSummary('# Plan\n\n1. Edit `a.ts`\n\nScope: small')).toBeNull();
    expect(parseApproverSummary('- What changes: only this line')).toBeNull();
    const buried = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n- What changes: x\n- Behaviour change: y`;
    expect(parseApproverSummary(buried)).toBeNull();
  });

  it('counts only the files under "Files to change"', () => {
    expect(extractFilesToChange(PLAN)).toEqual([
      'src/features/nst-home/content.ts',
      'src/features/nst-home/sections/hero.tsx',
      'src/features/nst-home/CLAUDE.md',
    ]);
    const normalized = normalizePlannerOutput({ summary: PLAN }, 'claude-code');
    expect(normalized.affectedFiles).toHaveLength(3);
    expect(normalized.approverSummary?.risk).toBe('low');
  });

  it('accepts the other headings planners use for that section, and stops at the next heading', () => {
    const plan = '## Files to touch\n- `a.ts` why\n- `b/c.tsx` (see `d.ts` for the pattern)\n### Steps\n- edit `e.ts`';
    expect(extractFilesToChange(plan)).toEqual(['a.ts', 'b/c.tsx']);
    expect(extractFilesToChange('## Steps\n- edit `e.ts`')).toBeUndefined();
  });

  it('without that section, no longer counts refs, globs, URL paths, extensionless paths or build output', () => {
    // The tokens listed under one real plan as "affected files" (thread 1789976700.997519).
    const noisy = [
      'Edit `src/features/nst-entrance/sections/hero.tsx` and `page.tsx`.',
      'See `../nsat/page` and `../coding-nsat/page`. Leave `content/*.ts` and `worker/**` alone.',
      'Branch off `origin/main` as `fix/nst-entrance-copy`. Check `/newton-school-of-technology-nst/home` and `out/index.html`.',
    ].join('\n');

    expect(normalizePlannerOutput({ summary: noisy }, 'claude-code').affectedFiles).toEqual([
      'src/features/nst-entrance/sections/hero.tsx',
      'page.tsx',
    ]);
  });

  it('removes the approver block and the files section from the detail, and nothing else', () => {
    const detail = planWithoutApproverParts(PLAN);

    expect(detail).not.toContain('For the approver');
    expect(detail).not.toContain('What changes:');
    expect(detail).not.toContain('## Files to change');
    expect(detail).not.toContain('changelog entry');
    expect(detail).toContain('# Remove "Final admissions cycle for 2026" from the NST home page');
    expect(detail).toContain('## Context');
    expect(detail).toContain('1. Remove `finalCycleNote` from `content.ts`.');
    expect(detail).toContain('Scope: small');
  });

  it('knows the ways of saying there is nothing to report', () => {
    for (const value of ['none', 'None.', 'no', 'N/A', '-', '']) expect(isNone(value)).toBe(true);
    for (const value of ['none of the pages change, but the default does', 'An exam ends on the first flag']) {
      expect(isNone(value)).toBe(false);
    }
  });

  it('reads "none" followed by an explanation as none, which is how a planner really writes it', () => {
    // Verbatim from the first live plan with the approver block.
    expect(
      isNone(
        'none. The line is an HTML comment, so it does not render on GitHub or anywhere in the product, and no application code is touched.',
      ),
    ).toBe(true);
    for (const value of [
      'None — documentation only.',
      'none (copy change only)',
      'Nothing. Same behaviour as before.',
    ]) {
      expect(isNone(value)).toBe(true);
    }
  });

  it('does not let a leading "none" hide a change that follows it', () => {
    for (const value of [
      'none, but the default becomes 0, so an exam ends on the first breach',
      'None; however existing drafts will show the new value.',
      'none except for exams created after this ships',
      'nothing changes for students unless the flag is on',
      'no longer sends the reminder email',
    ]) {
      expect(isNone(value)).toBe(false);
    }
  });

  it('has no approver summary on the JSON planner path', () => {
    expect(
      normalizePlannerOutput({ plan: ['x'], affectedFiles: ['a.ts'], scope: 'small' }, 'codex').approverSummary,
    ).toBeNull();
  });
});
