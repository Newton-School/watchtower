import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * gh and git inside an agent run, on the run's token and with no workarounds
 * (issue #746).
 *
 * The sandbox denies agents gh's stored login (`~/.config/gh/hosts.yml`,
 * #735) and `~/.ssh`. gh, and git's HTTPS credential helper when it is
 * `gh auth git-credential`, failed on the unreadable login file although the
 * run has GH_TOKEN, and a clone with an SSH remote could neither fetch nor
 * push: every coder set a GH_CONFIG_DIR and switched to HTTPS by hand, then
 * explained it in the requester's summary. A run with a token now gets:
 * - its own empty GH_CONFIG_DIR, so gh reads no login file and uses GH_TOKEN
 *   (gh only reads that folder: an empty, read-only one is enough);
 * - github.com SSH URLs rewritten to HTTPS, and a credential helper for
 *   github.com that answers with GH_TOKEN (helpers set before it, such as the
 *   owner's, are reset for github.com, so the result doesn't depend on them).
 * Every run also gets settings that keep common commands from writing the
 * main clone's `.git/config`, which a linked worktree's shell may not write:
 * `git checkout -b x origin/master` created the branch, then failed to record
 * its upstream and stopped before switching, so the coder lost a turn and
 * explained it to the requester.
 * The git settings go through `GIT_CONFIG_COUNT` (no config file written)
 * and are merged with the caller's own entries, such as a follow-up's push
 * block (#730): git matches `pushInsteadOf` against the remote's own URL
 * before `insteadOf`, so a follow-up's coder still cannot push, over either
 * form of URL.
 */

export type EnvLayer = Readonly<Record<string, string | undefined>>;
export type GitConfigEntry = readonly [key: string, value: string];

const GIT_CONFIG_VAR_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/**
 * Answers git's `get` with the token in the run's environment. `printf` is a
 * shell builtin, so the token is never on a command line, and unlike `echo`
 * it prints the value as it is.
 */
const TOKEN_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && echo username=x-access-token && printf \'password=%s\\n\' "$GH_TOKEN"; }; f';

/**
 * No upstream recorded by `git checkout -b <branch> origin/<base>`, nor by a
 * plain `git push` (the owner's own config turns `push.autoSetupRemote` on):
 * both write `.git/config`. The coder pushes with `git push origin
 * HEAD:<branch>`, which needs neither.
 */
export const NO_UPSTREAM_WRITES_GIT_CONFIG: readonly GitConfigEntry[] = [
  ['branch.autoSetupMerge', 'false'],
  ['push.autoSetupRemote', 'false'],
];

export const GITHUB_OVER_HTTPS_GIT_CONFIG: readonly GitConfigEntry[] = [
  ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  // An empty value clears the helpers configured before it, for github.com only.
  ['credential.https://github.com.helper', ''],
  ['credential.https://github.com.helper', TOKEN_CREDENTIAL_HELPER],
];

/**
 * The `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs an environment sets. A
 * pair missing either half is left out: git refuses to run at all when one is
 * missing.
 */
export function gitConfigEntries(env: EnvLayer | undefined): GitConfigEntry[] {
  const count = Number.parseInt(env?.GIT_CONFIG_COUNT ?? '', 10);
  if (!env || !Number.isInteger(count) || count <= 0) return [];
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    const value = env[`GIT_CONFIG_VALUE_${i}`];
    if (key && value !== undefined) entries.push([key, value]);
  }
  return entries;
}

/** One `GIT_CONFIG_*` layer from a list of entries. */
export function gitConfigEnv(entries: readonly GitConfigEntry[]): Record<string, string> {
  if (entries.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Layers merged as a spread would (a later layer wins), except the
 * `GIT_CONFIG_*` entries: every layer's are kept, in layer order, and
 * renumbered as one list. A plain spread would let one layer's
 * `GIT_CONFIG_KEY_0` replace another's.
 */
export function mergeAgentEnv(layers: ReadonlyArray<EnvLayer | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const entries: GitConfigEntry[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    entries.push(...gitConfigEntries(layer));
    for (const [key, value] of Object.entries(layer)) {
      if (!GIT_CONFIG_VAR_RE.test(key)) merged[key] = value;
    }
  }
  return { ...merged, ...gitConfigEnv(entries) };
}

/** The git settings every agent run gets, token or not. */
export function agentGitDefaultsEnv(): Record<string, string> {
  return gitConfigEnv(NO_UPSTREAM_WRITES_GIT_CONFIG);
}

/** The git settings a run with a GitHub token gets; none without one. */
export function githubAccessGitEnv(githubToken: string | undefined): Record<string, string> {
  if (!githubToken) return {};
  return { GIT_TERMINAL_PROMPT: '0', ...gitConfigEnv(GITHUB_OVER_HTTPS_GIT_CONFIG) };
}

/**
 * The run's own empty gh config folder, inside its private temp folder (so it
 * goes when that does), or undefined without a token: gh then keeps reading
 * its usual config, as before. When the folder can't be made, `onError` gets
 * the error code: the run goes on, but its gh calls fail as in #746.
 */
export async function makeGhConfigDir(
  runTempDir: string,
  githubToken: string | undefined,
  onError?: (code: string) => void,
): Promise<string | undefined> {
  if (!githubToken) return undefined;
  const dir = path.join(runTempDir, 'gh');
  try {
    await fs.mkdir(dir, { mode: 0o700 });
    return dir;
  } catch (error) {
    onError?.((error as NodeJS.ErrnoException).code ?? 'unknown');
    return undefined;
  }
}
