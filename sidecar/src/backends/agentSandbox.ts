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
 * - signalling a process outside the sandbox fails ("operation not permitted");
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
  '~/.watchtower/replay-snapshots',
  '~/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Application Support/Google',
  '~/Library/Mail',
  '~/Library/Messages',
  '~/Documents',
  '~/Desktop',
  '~/Downloads',
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

/** The same paths as permission rules, so the Read tool is refused them too. */
export function sandboxReadDenyRules(): string[] {
  return deniedReadPaths().map(denied => `Read(${denied}/**)`);
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
 */
export function agentSandboxSettings(params: { readOnly: boolean }): { sandbox: Record<string, unknown> } {
  const neighbours = neighbourDir();
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
        allowWrite: [
          '/tmp',
          '/private/tmp',
          '~/.npm',
          '~/.cache',
          '~/Library/Caches',
          ...state.repoPaths.map(repoPath => path.join(repoPath, 'node_modules', '.cache')),
        ],
        denyRead: [...deniedReadPaths(), ...(neighbours ? [neighbours] : [])],
        ...(neighbours && state.readRoot ? { allowRead: [state.readRoot] } : {}),
      },
    },
  };
}
