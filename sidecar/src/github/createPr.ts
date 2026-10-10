import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolchainEnv } from '../backends/codexBackend.js';

const execFileAsync = promisify(execFile);

export async function createPullRequest(params: {
  repoPath: string;
  title: string;
  body: string;
  branch: string;
  baseBranch?: string;
  labels?: string[];
}): Promise<{ prUrl: string }> {
  const { repoPath, title, body, branch, baseBranch, labels } = params;

  const args = ['pr', 'create', '--title', title, '--body', body, '--head', branch];

  if (baseBranch) {
    args.push('--base', baseBranch);
  }

  if (labels && labels.length > 0) {
    for (const label of labels) {
      args.push('--label', label);
    }
  }

  const { stdout } = await execFileAsync('gh', args, {
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: toolchainEnv(),
  });

  const prUrl = stdout.trim();
  return { prUrl };
}
