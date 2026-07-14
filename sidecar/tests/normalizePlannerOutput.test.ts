import { describe, expect, it } from 'vitest';
import { normalizePlannerOutput } from '../src/agents/normalizePlannerOutput.js';

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
