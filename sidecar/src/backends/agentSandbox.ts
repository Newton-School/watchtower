import os from 'node:os';
import path from 'node:path';

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
 * - reads of the paths below fail.
 * The file tools (Read, Write, Edit) are not sandboxed: the same secrets are
 * denied to Read by permission rule (`SANDBOX_READ_DENY_RULES`).
 *
 * Not sandboxed: browser QA (headless Chromium does not start inside it) and
 * deploys. Kill switch: `WATCHTOWER_AGENT_SANDBOX=0`.
 */

const state: { readRoot?: string; repoPaths: string[]; appDataDir?: string } = { repoPaths: [] };

/** Called once at startup with where the repos and miniOG's own data live. */
export function configureAgentSandbox(params: {
  miniOgRepoRoot?: string;
  repoPaths: string[];
  appDataDir?: string;
}): void {
  state.readRoot = params.miniOgRepoRoot;
  state.repoPaths = params.repoPaths;
  state.appDataDir = params.appDataDir;
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
