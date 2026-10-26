import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __personalSkills, personalSkillDenyRules } from '../src/backends/personalSkills.js';
import { claudeCodeBackend, PROCESS_KILL_DENY_RULES } from '../src/backends/claudeCodeBackend.js';

// Issue #443: every agent could invoke the host user's personal skills and
// commands, including the production deploy command and a skill that drives
// the owner's logged-in browser.
describe('personal skills are denied to working agents', () => {
  const realHome = __personalSkills.home;
  let home: string;
  let repo: string;

  const mkSkill = (root: string, name: string) => {
    fs.mkdirSync(path.join(root, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  };
  const mkCommand = (root: string, name: string) => {
    fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'commands', `${name}.md`), `# ${name}\n`);
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
    __personalSkills.home = () => home;
  });

  afterEach(() => {
    __personalSkills.home = realHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe('personalSkillDenyRules', () => {
    it('denies each personal skill and each personal command by name', () => {
      mkSkill(home, 'personal-browser');
      mkSkill(home, 'standup');
      mkCommand(home, 'deploy-prod');
      mkCommand(home, 'test-miniog');

      expect(personalSkillDenyRules(repo)).toEqual([
        'Skill(deploy-prod)',
        'Skill(personal-browser)',
        'Skill(standup)',
        'Skill(test-miniog)',
      ]);
    });

    it("leaves a name alone when the agent's own repo defines it", () => {
      mkCommand(home, 'pr-review'); // personal command
      mkCommand(home, 'deploy-prod');
      mkSkill(repo, 'pr-review'); // the repo's review playbook, invoked by name

      expect(personalSkillDenyRules(repo)).toEqual(['Skill(deploy-prod)']);
    });

    it('ignores stray files that are not skills or commands', () => {
      fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'skills', 'dev-rects.json'), '{}');
      mkCommand(home, 'deploy-prod');
      fs.writeFileSync(path.join(home, '.claude', 'commands', 'notes.txt'), 'x');

      expect(personalSkillDenyRules(repo)).toEqual(['Skill(deploy-prod)']);
    });

    it('returns nothing when the host has no personal skills, or no Claude config at all', () => {
      expect(personalSkillDenyRules(repo)).toEqual([]);
      __personalSkills.home = () => path.join(home, 'does-not-exist');
      expect(personalSkillDenyRules(undefined)).toEqual([]);
    });
  });

  describe('claudeCodeBackend.buildArgs', () => {
    const request = { cwd: '', prompt: 'hello' };

    it('passes the deny rules for a working agent, ahead of the flags that follow', () => {
      mkSkill(home, 'personal-browser');
      mkCommand(home, 'deploy-prod');

      const args = claudeCodeBackend.buildArgs({ ...request, cwd: repo, model: 'claude-opus-5-5' }, '/tmp/out.json');

      const at = args.indexOf('--disallowedTools');
      // The kill-by-name rules (issue #445) lead; the personal skills follow.
      expect(args.slice(at, at + 5)).toEqual([
        '--disallowedTools',
        ...PROCESS_KILL_DENY_RULES,
        'Skill(deploy-prod)',
        'Skill(personal-browser)',
      ]);
      // Variadic: after the sandbox's Read rules (issue #445) and settings rules (issue #609) the next argument
      // must be a flag, and the prompt is still first.
      expect(
        args
          .slice(at + 5)
          .find(arg => !arg.startsWith('Read(') && !arg.startsWith('Edit('))
          ?.startsWith('--'),
      ).toBe(true);
      expect(args.slice(0, 2)).toEqual(['-p', 'hello']);
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('applies to the planner too', () => {
      mkCommand(home, 'deploy-prod');
      const args = claudeCodeBackend.buildArgs({ ...request, cwd: repo, planMode: true }, '/tmp/out.json');
      expect(args).toContain('--disallowedTools');
      expect(args).toContain('Skill(deploy-prod)');
    });

    it('keeps a skill the repo ships, so a workflow can still invoke it by name', () => {
      mkCommand(home, 'pr-review');
      mkSkill(repo, 'pr-review');
      const args = claudeCodeBackend.buildArgs({ ...request, cwd: repo }, '/tmp/out.json');
      expect(args).not.toContain('Skill(pr-review)');
      expect(args.filter(arg => arg.startsWith('Skill('))).toEqual([]);
    });

    it('adds nothing to a text-only call, which has no tools at all', () => {
      mkCommand(home, 'deploy-prod');
      const args = claudeCodeBackend.buildArgs({ ...request, cwd: repo, noTools: true }, '/tmp/out.json');
      expect(args).not.toContain('--disallowedTools');
    });

    it('adds no skill rule when there is no personal skill to deny', () => {
      const args = claudeCodeBackend.buildArgs({ ...request, cwd: repo }, '/tmp/out.json');
      expect(args.filter(arg => arg.startsWith('Skill('))).toEqual([]);
    });
  });
});
