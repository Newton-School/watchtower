import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../types/contracts.js';
import { highReasoningProfile } from '../../codex/modelProfiles.js';
import { enabledRepoKeys } from '../../repos/registry.js';

const SIDECAR_PACKAGE_NAME = 'watchtower-sidecar';
const MAX_WALK_DEPTH = 8;

export async function resolveWatchtowerPath(config: AppConfig): Promise<string | undefined> {
  const configured = config.repoPaths.watchtower?.trim();
  if (configured) {
    if (await isDirectory(configured)) {
      return fs.realpath(configured);
    }
    return undefined;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  let cursor = here;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const sidecarPkg = path.join(cursor, 'sidecar', 'package.json');
    if (await pkgIsSidecar(sidecarPkg)) {
      return fs.realpath(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

export async function buildLiveStateSnapshot(config: AppConfig): Promise<string> {
  const profile = highReasoningProfile(config.agentBackend);
  const lines: string[] = [];

  lines.push('## Live state snapshot');
  lines.push(`- Active agent backend: \`${config.agentBackend}\``);
  lines.push(`- High-reasoning model: \`${profile.model}\` (effort: ${profile.reasoningEffort})`);
  lines.push(`- Multi-agent pipeline enabled: ${config.multiAgentEnabled ? 'yes' : 'no'}`);

  const configuredRepos: string[] = [...enabledRepoKeys(config)];
  if (config.repoPaths.watchtower) configuredRepos.push('watchtower (self)');
  lines.push(`- Configured product repos: ${configuredRepos.join(', ')}`);

  lines.push(`- Sidecar version: \`${await readSidecarVersion()}\``);

  lines.push('- MCP servers (Claude Code):');
  const claudeMcp = await readClaudeMcpServers();
  if (claudeMcp.length === 0) {
    lines.push('    - none detected (no `~/.claude.json` mcpServers entries readable)');
  } else {
    for (const name of claudeMcp) lines.push(`    - ${name}`);
  }

  lines.push('- MCP servers (Codex CLI):');
  const codexMcp = await readCodexMcpServers();
  if (codexMcp.length === 0) {
    lines.push('    - none detected (no `~/.codex/config.toml` mcp_servers entries readable)');
  } else {
    for (const name of codexMcp) lines.push(`    - ${name}`);
  }

  return lines.join('\n');
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function pkgIsSidecar(pkgPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed.name === SIDECAR_PACKAGE_NAME;
  } catch {
    return false;
  }
}

async function readSidecarVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let cursor = here;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const candidate = path.join(cursor, 'package.json');
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (parsed.name === SIDECAR_PACKAGE_NAME && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        /* keep walking */
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

async function readClaudeMcpServers(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ? Object.keys(parsed.mcpServers).sort() : [];
  } catch {
    return [];
  }
}

async function readCodexMcpServers(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const names = new Set<string>();
    const re = /^\[mcp_servers\.([^\]\s]+)\]/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      names.add(match[1]);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}
