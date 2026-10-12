/**
 * Which build a sidecar process is (issue #450). Stamped on every job and held
 * in the instance lock, so a run can be traced to the bundle that handled it.
 * The app passes its version and commit in; a sidecar started by hand reports
 * 'dev' / 'unknown'.
 */
export interface SidecarBuild {
  sidecarPid: number;
  sidecarEntry: string;
  appVersion: string;
  gitSha: string;
}

export function readSidecarBuild(source: {
  pid: number;
  argv: string[];
  env: Record<string, string | undefined>;
}): SidecarBuild {
  return {
    sidecarPid: source.pid,
    sidecarEntry: source.argv[1] ?? '',
    appVersion: source.env.WATCHTOWER_APP_VERSION || 'dev',
    gitSha: source.env.WATCHTOWER_GIT_SHA || 'unknown',
  };
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True only when both are X.Y.Z and `version` sorts before `other`. */
export function isOlderVersion(version: string, other: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(other);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}
