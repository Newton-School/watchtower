import fsSync from 'node:fs';
import os from 'node:os';
import path, { delimiter as pathDelimiter } from 'node:path';
import type { AgentBackend, AgentRunRequest, ParsedBackendOutput } from './types.js';

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(binary: string, customPath?: string): string | undefined {
  const sourcePath = customPath ?? process.env.PATH ?? '';
  for (const dir of sourcePath.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, binary);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findNvmCodexBinaries(nvmRoot: string): string[] {
  if (!nvmRoot || !fsSync.existsSync(nvmRoot)) {
    return [];
  }

  const versions = fsSync
    .readdirSync(nvmRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('v'))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const candidates: string[] = [];
  for (const version of versions) {
    candidates.push(path.join(nvmRoot, version, 'bin', 'codex'));
  }
  return candidates;
}

export function buildCodexPath(existingPath?: string): string {
  const parts = new Set<string>();
  const add = (value?: string): void => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    parts.add(trimmed);
  };

  const currentNodeDir = path.dirname(process.execPath);
  add(currentNodeDir);
  add('/opt/homebrew/bin');
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');

  const home = process.env.HOME?.trim() || os.homedir();
  if (home) {
    add(path.join(home, '.npm-global', 'bin'));
    add(path.join(home, '.local', 'bin'));
    add(path.join(home, '.bun', 'bin'));
    add(path.join(home, '.nvm', 'versions', 'node', 'current', 'bin'));
  }

  for (const value of (existingPath ?? '').split(pathDelimiter)) {
    add(value);
  }

  return Array.from(parts).join(pathDelimiter);
}

function resolveCodexBinary(): string {
  const envOverride = process.env.CODEX_BIN?.trim();
  if (envOverride) {
    if (path.isAbsolute(envOverride)) {
      if (isExecutable(envOverride)) {
        return envOverride;
      }
    } else {
      const fromPath = findInPath(envOverride, buildCodexPath(process.env.PATH));
      if (fromPath) {
        return fromPath;
      }
    }
  }

  const fromPath = findInPath('codex', buildCodexPath(process.env.PATH));
  if (fromPath) {
    return fromPath;
  }

  const home = process.env.HOME?.trim() || os.homedir();
  const nvmRoot = home ? path.join(home, '.nvm', 'versions', 'node') : '';
  const absoluteCandidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    home ? path.join(home, '.npm-global', 'bin', 'codex') : '',
    home ? path.join(home, '.local', 'bin', 'codex') : '',
    home ? path.join(home, '.bun', 'bin', 'codex') : '',
    ...findNvmCodexBinaries(nvmRoot),
  ].filter(Boolean);
  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

export const codexBackend: AgentBackend = {
  id: 'codex',
  displayName: 'Codex (OpenAI)',

  resolveBinary(): string {
    return resolveCodexBinary();
  },

  isAvailable(): boolean {
    try {
      const binary = resolveCodexBinary();
      return binary !== 'codex' || isExecutable(findInPath('codex', buildCodexPath(process.env.PATH)) ?? '');
    } catch {
      return false;
    }
  },

  supportsImages(): boolean {
    return false;
  },

  buildArgs(request: AgentRunRequest, outputPath: string): string[] {
    // `--json` streams JSONL events to stdout so runCodex can narrate progress
    // live. It coexists with --output-last-message (verified): the final
    // message file is still written, so parseOutput is unaffected.
    const args = ['exec', '--json', '--cd', request.cwd, '--full-auto', '--skip-git-repo-check'];
    if (request.model) {
      args.push('-m', request.model);
    }
    if (request.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${request.reasoningEffort}"`);
    }
    if (request.outputSchemaPath) {
      args.push('--output-schema', request.outputSchemaPath);
    }
    args.push('--output-last-message', outputPath, request.prompt);
    return args;
  },

  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    env.PATH = buildCodexPath(basePath);
    if (request.githubToken) {
      env.GITHUB_TOKEN = request.githubToken;
      env.GH_TOKEN = request.githubToken;
    }
    return env;
  },

  parseOutput(raw: string): ParsedBackendOutput {
    // Codex `--output-last-message` writes only the final assistant message, so
    // there is no usage/cost envelope to extract here. Cost is computed from
    // the price table at storage time when token counts are available.
    return parseStructuredOutput(raw);
  },

  availableModels(): string[] {
    return ['gpt-5.2-codex', 'gpt-5.4'];
  },

  defaultModel(): string {
    return 'gpt-5.2-codex';
  },
};

// Shared JSON extraction logic — reused across all backends
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function extractFencedJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function extractFirstTopLevelJsonObject(raw: string): string | undefined {
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(start, index + 1).trim();
        }
      }
    }
  }

  return undefined;
}

export function parseStructuredOutput(raw: string): ParsedBackendOutput {
  try {
    const parsedJson = parseJsonObject(raw.trim());
    if (parsedJson) {
      return { parsedJson, strategy: 'direct' };
    }
  } catch {
    // fall through
  }

  for (const candidate of extractFencedJsonCandidates(raw)) {
    try {
      const parsedJson = parseJsonObject(candidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'fenced_block' };
      }
    } catch {
      // continue
    }
  }

  const firstObjectCandidate = extractFirstTopLevelJsonObject(raw);
  if (firstObjectCandidate) {
    try {
      const parsedJson = parseJsonObject(firstObjectCandidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'first_object' };
      }
    } catch {
      // final strategy failed
    }
  }

  return {};
}
