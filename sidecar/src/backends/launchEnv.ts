/**
 * What an agent must not inherit from whoever started the app (issue #572).
 *
 * Started with `open -a` from a terminal, the app takes on that terminal's
 * environment, and so does every agent it runs. Inside cmux that put a shim
 * first on PATH: `claude` resolved to it, and its wrapper rejects any argument
 * over 122,880 bytes ("cmux: argument too large"), so every review of a large
 * PR failed within milliseconds. Agents also got the terminal's hook and
 * computer-use variables, and the launching Claude Code session's identity,
 * messaging socket and token, and effort. Started from Finder or the Dock,
 * none of that is there; agents must not depend on which it was.
 */

/** A terminal's per-session command shims (cmux), never the real binaries. */
export function isTerminalShimDir(dir: string): boolean {
  return /[\\/]cmux-cli-shims(?:[\\/]|$)/.test(dir);
}

const PARENT_SESSION_KEYS = new Set(['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR', 'CLAUDE_PID']);
/** A parent Claude Code session's identity and channels. Tuning variables (`CLAUDE_CODE_MAX_RETRIES`) stay. */
const PARENT_SESSION_CODE_RE = /^CLAUDE_CODE_\w*(SESSION|SOCKET|TOKEN|CHILD|ENTRYPOINT|EXECPATH|BRIDGE|ATTENDED)/;
const TERMINAL_PREFIX_RE = /^(CMUX_|GHOSTTY_)/;

/** A variable set by the launching terminal or Claude Code session, not by this machine's setup. */
export function isInheritedLaunchVar(key: string): boolean {
  return PARENT_SESSION_KEYS.has(key) || PARENT_SESSION_CODE_RE.test(key) || TERMINAL_PREFIX_RE.test(key);
}

/** A PATH with the terminal's shim directories removed. */
export function withoutTerminalShims(pathValue: string, delimiter = ':'): string {
  return pathValue
    .split(delimiter)
    .filter(dir => dir.trim() && !isTerminalShimDir(dir))
    .join(delimiter);
}

/** The environment an agent starts from: this one, without what the launching terminal or session added. */
export function agentBaseEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isInheritedLaunchVar(key)) clean[key] = value;
  }
  if (typeof clean.PATH === 'string') clean.PATH = withoutTerminalShims(clean.PATH);
  return clean;
}
