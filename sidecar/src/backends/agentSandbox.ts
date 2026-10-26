import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claude Code's shell sandbox for agent runs (issue #445).
 *
 * Agents run as the owner's macOS user, so one agent's `pkill -f "next dev"`
 * killed sibling agents and the owner's own processes, and a lookup could
 * read any checkout in his home. With the sandbox on, every shell command an
 * agent runs is confined by macOS Seatbelt. What it does, measured on CLI
 * 2.1.299 with permissions bypassed:
 * - signalling a process outside the sandbox fails ("operation not permitted").
 *   Each shell command is a sandbox of its own, so a later command cannot stop
 *   a server an earlier one started; the sidecar stops what a run leaves
 *   running when it ends (`leftoverProcesses.ts`, issue #608);
 * - writes outside the working directory fail, except the paths below. A
 *   linked worktree may still commit to its main clone's `.git`, but never
 *   write its `config` or `hooks` (so `git push -u` pushes and then cannot
 *   record the upstream: the coder is told to push `HEAD:<branch>`);
 * - reads of the paths below fail;
 * - writes to Claude Code's own config in the working directory fail, whatever
 *   `allowWrite` says: `.claude/skills`, `.claude/hooks`, `.claude/commands`,
 *   `.claude/agents` and `.claude/settings*.json` (built in; measured on CLI
 *   2.1.310).
 * The file tools (Read, Write, Edit) are not sandboxed: the same secrets are
 * denied to Read by permission rule (`sandboxReadDenyRules`). So a change
 * run updates a file a repo keeps under `.claude/skills/` (a skill's ledger)
 * with the Write or Edit tool (issue #609). With permissions bypassed the file
 * tools also skip the CLI's own checks on `.git` and `.claude`; deny rules are
 * what they still obey. They are refused the files outside the worktree that
 * run code outside the sandbox or load into the owner's own sessions
 * (`fileWriteDenyRules`, issues #609 and #743), on every run with tools.
 * That list is best-effort: it names the places known to run code. The real
 * fix is an allow-list (the worktree, /tmp, the planner's plan files), which
 * bypassed permissions ignore: it needs a hook or change runs off bypass.
 *
 * Still open by design: the PR build gate installs and builds the PR's own code
 * outside the sandbox, so a change's package scripts run there.
 *
 * Not sandboxed: browser QA (headless Chromium does not start inside it) and
 * deploys. Kill switch: `WATCHTOWER_AGENT_SANDBOX=0` (the file-tool write
 * rules stay).
 */

const state: { readRoot?: string; repoPaths: string[]; appDataDir?: string; vaultPath?: string } = {
  repoPaths: [],
};

/** Called once at startup with where the repos and miniOG's own data live. */
export function configureAgentSandbox(params: {
  miniOgRepoRoot?: string;
  repoPaths: string[];
  appDataDir?: string;
  vaultPath?: string;
}): void {
  state.readRoot = params.miniOgRepoRoot;
  state.repoPaths = params.repoPaths;
  state.appDataDir = params.appDataDir;
  state.vaultPath = params.vaultPath || undefined;
}

export function isAgentSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WATCHTOWER_AGENT_SANDBOX !== '0';
}

/** Credentials, the owner's personal folders, and transcripts of his own sessions. */
const SECRET_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.docker',
  '~/.kube',
  '~/.netrc',
  '~/.git-credentials',
  '~/.claude.json',
  '~/.claude/projects',
  // The owner's own Claude Code sessions and settings (issue #622: a read-only
  // run printed history.jsonl through `git blame --contents`). Not
  // shell-snapshots, skills, plugins or commands: commands source the shell
  // snapshot, and runs that do work use skills' files. The CLI itself reads
  // its settings outside the sandbox.
  '~/.claude/history.jsonl',
  '~/.claude/file-history',
  '~/.claude/paste-cache',
  '~/.claude/sessions',
  '~/.claude/session-env',
  '~/.claude/jobs',
  '~/.claude/tasks',
  '~/.claude/todos',
  '~/.claude/plans',
  '~/.claude/memory-proposals',
  '~/.claude/backups',
  '~/.claude/scratch-backups',
  '~/.claude/debug',
  '~/.claude/daemon.log',
  '~/.claude/telemetry',
  '~/.claude/ssh',
  '~/.claude/chrome',
  '~/.claude/playwright-profiles',
  '~/.claude/settings.json',
  '~/.claude/settings.local.json',
  '~/.claude/remote-settings.json',
  '~/.claude/seed-admin',
  // Shell history and start-up files can hold commands with tokens; agents'
  // commands source the CLI's shell snapshot, not these.
  '~/.zsh_history',
  '~/.bash_history',
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.profile',
  '~/.bash_profile',
  '~/.bashrc',
  // gh's stored login: agents get GH_TOKEN instead.
  '~/.config/gh/hosts.yml',
  // miniOG's own records: transcripts, exports, logs, set-aside changes.
  '~/.watchtower/replay-snapshots',
  '~/.watchtower/vault',
  '~/.watchtower/egress',
  '~/.watchtower/logs',
  '~/.watchtower/autostash',
  '~/.watchtower/watchtower.db',
  '~/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Application Support/Google',
  '~/Library/Mail',
  '~/Library/Messages',
  // Not ~/Documents, ~/Desktop or ~/Downloads: macOS already guards them with
  // a permission prompt, and the sandbox touches every path listed here when
  // it starts. With the prompt pending (screen locked) ~/Documents blocked,
  // and every agent hung before its first step, all evening of 2026-10-14.
];

const toHomeForm = (absolute: string): string => {
  const home = os.homedir();
  return absolute.startsWith(`${home}/`) ? `~/${absolute.slice(home.length + 1)}` : absolute;
};

function deniedReadPaths(): string[] {
  const denied = [...SECRET_PATHS];
  // miniOG's own database: every Slack thread it has seen.
  if (state.appDataDir) denied.push(toHomeForm(state.appDataDir));
  return denied;
}

/**
 * The same paths as permission rules, so the Read tool is refused them too.
 * Each path gets two rules: `path/**` covers a folder's contents and `path`
 * the path itself, which is what a file such as `~/.netrc` needs.
 */
export function sandboxReadDenyRules(): string[] {
  return deniedReadPaths().flatMap(denied => [`Read(${denied})`, `Read(${denied}/**)`]);
}

/**
 * Claude Code's settings files and hook scripts, at any depth: the worktree's,
 * and the host user's own. A hook runs outside the sandbox. In a probe on CLI
 * 2.1.310, a hook in the worktree's `.claude/settings.local.json`, written with
 * the Write tool, wrote a file the sandbox had just refused the agent's own
 * command; every later agent in that worktree would run it too. Skills,
 * commands and agents stay writable by the file tools: they are instructions
 * a change may rightly edit, and the change still goes through review and a PR.
 */
export const SETTINGS_WRITE_DENY_RULES = [
  'Edit(//**/.claude/settings.json)',
  'Edit(//**/.claude/settings.local.json)',
  'Edit(//**/.claude/hooks/**)',
];

/**
 * Files outside the worktree that are read as config naming a command to run,
 * or are programs the sidecar runs outside the sandbox (issue #743). Home
 * paths are anchored at `~/`, so the same names inside a worktree (its
 * `.claude/skills`, #609) stay writable.
 */
export const HOST_CONFIG_WRITE_DENY_RULES = [
  // Every `.git`, a linked worktree's pointer file included: the CLI protects
  // it, but not with permissions bypassed, and the sidecar runs git on the
  // shared clones outside the sandbox. Agents' own git commands write there
  // through the shell, which these rules don't govern.
  'Edit(//**/.git)',
  'Edit(//**/.git/**)',
  'Edit(~/.gitconfig)',
  // Shell start-up: the PR build gate runs a login bash outside the sandbox and
  // sources nvm, which also holds the node the sidecar runs on; the owner's own
  // shells read the rest. npm's user config: that gate's install reads it.
  'Edit(~/.profile)',
  'Edit(~/.bash_profile)',
  'Edit(~/.bash_login)',
  'Edit(~/.bashrc)',
  'Edit(~/.bash_logout)',
  'Edit(~/.zshenv)',
  'Edit(~/.zprofile)',
  'Edit(~/.zshrc)',
  'Edit(~/.zlogin)',
  'Edit(~/.zlogout)',
  'Edit(~/.oh-my-zsh/**)',
  'Edit(~/.nvm/**)',
  'Edit(~/.npmrc)',
  // What launchd starts at login.
  'Edit(~/Library/LaunchAgents/**)',
  // Tools' config that can name a command: git's and gh's under ~/.config,
  // ssh's ProxyCommand, credential helpers, kubectl exec plugins.
  'Edit(~/.config/**)',
  'Edit(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Edit(~/.docker/**)',
  'Edit(~/.kube/**)',
  'Edit(~/.gnupg/**)',
  // Programs the sidecar runs outside the sandbox: Homebrew's (git among them,
  // with its system config in etc/), the claude CLI (~/.local), Codex's.
  'Edit(//opt/homebrew/**)',
  'Edit(//usr/local/**)',
  'Edit(~/.local/**)',
  'Edit(~/.codex/**)',
  // The owner's own Claude Code config, which loads into his sessions. Not
  // `~/.claude/plans`: a planner in plan mode writes its plan there.
  'Edit(~/.claude.json)',
  'Edit(~/.claude/CLAUDE.md)',
  'Edit(~/.claude/commands/**)',
  'Edit(~/.claude/agents/**)',
  'Edit(~/.claude/skills/**)',
  'Edit(~/.claude/plugins/**)',
];

/** miniOG's own folders under `~/.watchtower`. Not `workspaces`: change runs work there. */
const MINIOG_DATA_DIRS = [
  'app-backups',
  'autostash',
  'dep-cache',
  'egress',
  'logs',
  'lookup-workspaces',
  'replay-snapshots',
  'vault',
];

/** Folders macOS guards with a prompt; see the note at the end of `SECRET_PATHS`. */
const PROMPT_GUARDED_DIRS = ['Documents', 'Desktop', 'Downloads'].map(dir => path.join(os.homedir(), dir));

/** A path as a permission rule takes it: `~/…` inside home, `//…` from the root. */
const toRuleForm = (absolute: string): string => {
  const homeForm = toHomeForm(absolute);
  return homeForm.startsWith('~/') ? homeForm : `/${absolute}`;
};

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const realPathOf = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/** Where the sidecar's own code and the node running it are. Replaced in tests. */
export const __agentSandboxRuntime = {
  // src/backends/ or dist/backends/ → the sidecar package.
  sidecarRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  execPath: process.execPath,
};

/**
 * Folders of programs the sidecar runs outside the sandbox, found at run
 * time: its own code (and the app bundle around it), the node install running
 * it, and the agent CLI the backend resolved. Rules match the resolved path,
 * so each is followed through symlinks. A folder that holds home, the
 * worktrees or the run's own working directory would refuse the run its work:
 * such a folder is left out.
 */
function runtimeDirs(params: { cwd?: string; executables: string[] }): string[] {
  const { sidecarRoot, execPath } = __agentSandboxRuntime;
  const dirs = [realPathOf(sidecarRoot), path.dirname(path.dirname(realPathOf(execPath)))];
  const bundle = /^(.*?\.app)\/Contents\//.exec(dirs[0]);
  if (bundle) dirs.push(bundle[1]);
  for (const executable of params.executables) {
    if (path.isAbsolute(executable)) dirs.push(path.dirname(realPathOf(executable)));
  }
  const keep = [
    os.homedir(),
    path.join(os.homedir(), '.watchtower', 'workspaces'),
    ...(params.cwd ? [params.cwd] : []),
  ];
  return [...new Set(dirs)].filter(dir => !keep.some(kept => isInside(kept, dir)));
}

/**
 * miniOG's own records, caches and settings: its database, the dependency
 * cache later worktrees are cloned from, its exports and backups, and the
 * vault, whose edits flow back into people's dossiers. Files by name, not
 * `~/.watchtower/*`: a rule that matches the `workspaces` folder would refuse
 * every file under it.
 */
function miniOgDataWriteDenyRules(): string[] {
  const rules = [
    ...['watchtower.db', 'watchtower.db-wal', 'watchtower.db-shm', 'watchtower.db-journal'].map(
      file => `Edit(~/.watchtower/${file})`,
    ),
    ...MINIOG_DATA_DIRS.map(dir => `Edit(~/.watchtower/${dir}/**)`),
  ];
  const workspaces = path.join(os.homedir(), '.watchtower', 'workspaces');
  // The app's data folder, unless the worktrees are inside it.
  const appData = state.appDataDir ? path.resolve(state.appDataDir) : undefined;
  if (appData && !isInside(workspaces, appData)) rules.push(`Edit(${toRuleForm(appData)}/**)`);
  // A vault set somewhere else, unless it is in a folder macOS guards.
  const vault = state.vaultPath ? path.resolve(state.vaultPath) : undefined;
  if (vault && !isInside(workspaces, vault) && !PROMPT_GUARDED_DIRS.some(dir => isInside(vault, dir))) {
    rules.push(`Edit(${toRuleForm(vault)}/**)`);
  }
  return rules;
}

/**
 * Every write the file tools are refused, on any run with tools, sandboxed or
 * not: a run with the sandbox off (browser QA, deploys) runs the same tools.
 * `executables` are the programs the run's backend starts (its CLI).
 */
export function fileWriteDenyRules(params: { cwd?: string; executables?: string[] } = {}): string[] {
  return [
    ...SETTINGS_WRITE_DENY_RULES,
    ...HOST_CONFIG_WRITE_DENY_RULES,
    ...miniOgDataWriteDenyRules(),
    ...runtimeDirs({ cwd: params.cwd, executables: params.executables ?? [] }).map(
      dir => `Edit(${toRuleForm(dir)}/**)`,
    ),
  ];
}

/**
 * The checkouts beside the miniOG root (the owner's own clones in `~/code`)
 * are hidden from shell commands; the root itself stays readable. Only when
 * that folder is inside home and is not home itself.
 */
function neighbourDir(): string | undefined {
  if (!state.readRoot) return undefined;
  const parent = path.dirname(state.readRoot);
  const home = os.homedir();
  return parent.startsWith(`${home}/`) ? parent : undefined;
}

/**
 * The `--settings` value for a run with tools. A read-only run keeps its
 * allow-list: without `autoAllowBashIfSandboxed: false`, any sandboxed shell
 * command would run without asking, `rm` included.
 *
 * A read-only run writes only under /tmp, where the reply's attachments go
 * (issue #622). The sandbox otherwise allows writes in the working directory
 * and the package caches; its allow-list admits git commands that take a
 * write flag (`git log --output=<file>` wrote a file in a probe on CLI
 * 2.1.310), and the sandbox refuses that write whatever the flags.
 */
export function agentSandboxSettings(params: { readOnly: boolean; cwd?: string }): {
  sandbox: Record<string, unknown>;
} {
  const neighbours = neighbourDir();
  const denyWrite = params.readOnly && params.cwd ? [params.cwd] : [];
  const allowWrite = params.readOnly
    ? ['/tmp', '/private/tmp']
    : [
        '/tmp',
        '/private/tmp',
        '~/.npm',
        '~/.cache',
        '~/Library/Caches',
        ...state.repoPaths.map(repoPath => path.join(repoPath, 'node_modules', '.cache')),
      ];
  return {
    sandbox: {
      enabled: true,
      // No retry outside the sandbox: bypassed permissions would approve it.
      allowUnsandboxedCommands: false,
      ...(params.readOnly ? { autoAllowBashIfSandboxed: false } : {}),
      // `gh` verifies TLS through macOS's trust service; without this it
      // fails every call (OSStatus -26276).
      enableWeakerNetworkIsolation: true,
      network: {
        // Dev servers and tests listen on localhost.
        allowLocalBinding: true,
        // A read-only run reaches GitHub through `gh`; other hosts are refused
        // to it. A run with bypassed permissions may reach any host.
        allowedDomains: ['github.com', 'api.github.com'],
      },
      filesystem: {
        allowWrite,
        ...(denyWrite.length > 0 ? { denyWrite } : {}),
        denyRead: [...deniedReadPaths(), ...(neighbours ? [neighbours] : [])],
        ...(neighbours && state.readRoot ? { allowRead: [state.readRoot] } : {}),
      },
    },
  };
}
