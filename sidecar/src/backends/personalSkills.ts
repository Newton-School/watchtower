import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Deny rules that keep a working agent from invoking the host user's personal
 * skills and commands (issue #443).
 *
 * Agents run as the host user, so everything under `~/.claude/skills` and
 * `~/.claude/commands` was theirs to call: the production deploy command, a
 * skill that drives the owner's logged-in browser, commands that post to
 * Slack as the owner. Deny rules are enforced even when permissions are
 * bypassed, so each of those names becomes `Skill(<name>)` on
 * `--disallowedTools`.
 *
 * A name the agent's own repo defines is left alone: repos ship skills the
 * workflows invoke by name (a PR-review playbook, for one), and a personal
 * command may share that name.
 *
 * This removes the tool path, not the files: an agent can still read them
 * from disk. Real isolation needs a separate config directory or OS user.
 */

/** Test seam: where the host user's Claude config lives. */
export const __personalSkills = {
  home: (): string => process.env.HOME?.trim() || os.homedir(),
};

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function skillNames(claudeDir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of entries(path.join(claudeDir, 'skills'))) {
    // A skill is a directory; a symlinked one counts.
    if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name);
  }
  for (const entry of entries(path.join(claudeDir, 'commands'))) {
    if (entry.name.endsWith('.md')) names.add(entry.name.slice(0, -'.md'.length));
  }
  return names;
}

export function personalSkillDenyRules(cwd: string | undefined): string[] {
  const personal = skillNames(path.join(__personalSkills.home(), '.claude'));
  if (personal.size === 0) return [];
  const ownedByRepo = cwd ? skillNames(path.join(cwd, '.claude')) : new Set<string>();
  return [...personal]
    .filter(name => !ownedByRepo.has(name))
    .sort()
    .map(name => `Skill(${name})`);
}
