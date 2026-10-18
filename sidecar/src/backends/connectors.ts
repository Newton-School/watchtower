import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, McpServerConfig } from '../types/contracts.js';

/**
 * Which connectors (MCP servers) an agent run gets.
 *
 * Agents used to inherit every connector the host user has: personal Slack and
 * Google Drive, Metabase with write access, analytics, Grafana, a
 * computer-control server. A lookup for a non-owner searched the owner's
 * private Slack and read Drive files; another run rewrote seven Metabase
 * questions (issue #443).
 *
 * Now a run that uses tools starts with none (`--strict-mcp-config` with an
 * explicit list), and a workflow names what it keeps:
 *
 *   lookup             Metabase and OpenPanel, read-only
 *   code_change        Figma
 *   code_change_admin  Figma + the Newton admin server, upload tools only
 *
 * Anything not listed here is off for every agent, whatever the host user has
 * linked. Adding a connector to a kind of run is one name in CONNECTOR_POLICY
 * plus, if it is new, a spec in CONNECTORS.
 */

export type ConnectorProfile = 'none' | 'lookup' | 'code_change' | 'code_change_admin';

export interface RunConnectors {
  /** Servers the run may load, by the name its tools are published under. */
  mcpServers: Record<string, McpServerConfig>;
  /** Tool patterns removed from those servers. Deny rules hold when permissions are bypassed. */
  disallowedTools: string[];
  /** Connectors the profile names that this host cannot provide. */
  unavailable: string[];
}

export const NO_CONNECTORS: RunConnectors = { mcpServers: {}, disallowedTools: [], unavailable: [] };

interface ConnectorSpec {
  /** Name the server is loaded under: its tools are `mcp__<serverName>__*`. */
  serverName: string;
  /** Tool-name patterns (after `mcp__<serverName>__`) no run may use. */
  denyTools: string[];
  /** How the limit reads in a sentence: "read-only", "upload only". */
  limit?: string;
  /** What it is for, said to an agent that has it. */
  about: string;
  resolve(config: AppConfig): McpServerConfig | undefined;
}

/** Test seam: where the host user's Claude config lives. */
export const __connectors = {
  home: (): string => process.env.HOME?.trim() || os.homedir(),
};

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asServerConfig(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.url === 'string' && entry.url) {
    return { type: 'http', url: entry.url };
  }
  if (typeof entry.command === 'string' && entry.command) {
    return {
      type: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env:
        entry.env && typeof entry.env === 'object'
          ? Object.fromEntries(
              Object.entries(entry.env as Record<string, unknown>).filter(
                (pair): pair is [string, string] => typeof pair[1] === 'string',
              ),
            )
          : undefined,
    };
  }
  return undefined;
}

/** A server the host user added for themselves (`claude mcp add -s user`). */
function userServer(name: string): McpServerConfig | undefined {
  const config = readJson(path.join(__connectors.home(), '.claude.json'));
  const servers = config?.mcpServers as Record<string, unknown> | undefined;
  return asServerConfig(servers?.[name]);
}

/** A server an installed plugin ships. */
function pluginServer(plugin: string, name: string): McpServerConfig | undefined {
  const installed = readJson(path.join(__connectors.home(), '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = installed?.plugins as Record<string, unknown> | undefined;
  for (const [key, installs] of Object.entries(plugins ?? {})) {
    if (!key.startsWith(`${plugin}@`) || !Array.isArray(installs)) {
      continue;
    }
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath !== 'string') {
        continue;
      }
      const manifest = readJson(path.join(installPath, '.mcp.json'));
      const server = asServerConfig((manifest?.mcpServers as Record<string, unknown> | undefined)?.[name]);
      if (server) {
        return server;
      }
    }
  }
  return undefined;
}

const CONNECTORS: Record<string, ConnectorSpec> = {
  // The database, for questions the code cannot answer. Reading only: these
  // patterns remove everything that changes a question, a dashboard or a
  // collection. What SQL may do is decided by the Metabase account.
  metabase: {
    serverName: 'metabase',
    denyTools: ['create_*', 'update_*', 'delete_*', 'archive_*'],
    limit: 'read-only',
    about:
      'the database, for questions the code cannot answer: counts, a specific record, whether data is what the code expects',
    resolve: config => (config.metabaseMcpUrl ? { type: 'http', url: config.metabaseMcpUrl } : undefined),
  },
  // Product analytics, for "how many", "which events fire", "is this page
  // getting traffic". Every tool it has today reads; the patterns keep it so.
  openpanel: {
    serverName: 'openpanel',
    denyTools: ['create_*', 'update_*', 'delete_*'],
    limit: 'read-only',
    about: 'product analytics: events and their properties, funnels, page and traffic numbers',
    resolve: () => userServer('openpanel'),
  },
  // Designs, for a change that implements one.
  figma: {
    serverName: 'figma',
    denyTools: [],
    about: 'designs, for a change that implements one',
    resolve: () => userServer('figma'),
  },
  // Uploading an asset a change needs (a developer image). Only `login` and
  // the `upload_*` tools are left: the server also searches and edits user
  // and course records, which no agent run needs. Loaded under the name the
  // plugin gives it, so the tool names agents and repo skills know stay the same.
  'newton-admin': {
    serverName: 'plugin_newton-admin-mcp_newton-admin',
    limit: 'upload only',
    about: 'uploading an asset a change needs',
    denyTools: [
      'admin_lookup',
      'create_*',
      'describe_*',
      'get_*',
      'list_*',
      'register_*',
      'search_*',
      'start_*',
      'stop_*',
      'update_*',
    ],
    resolve: () => pluginServer('newton-admin-mcp', 'newton-admin'),
  },
};

export const CONNECTOR_POLICY: Record<ConnectorProfile, string[]> = {
  none: [],
  lookup: ['metabase', 'openpanel'],
  code_change: ['figma'],
  code_change_admin: ['figma', 'newton-admin'],
};

/** Resolve a profile against what this host can actually provide. */
export function connectorsFor(profile: ConnectorProfile, config: AppConfig): RunConnectors {
  const connectors: RunConnectors = { mcpServers: {}, disallowedTools: [], unavailable: [] };
  for (const name of CONNECTOR_POLICY[profile]) {
    const spec = CONNECTORS[name];
    const server = spec.resolve(config);
    if (!server) {
      connectors.unavailable.push(name);
      continue;
    }
    connectors.mcpServers[spec.serverName] = server;
    connectors.disallowedTools.push(...spec.denyTools.map(tool => `mcp__${spec.serverName}__${tool}`));
  }
  return connectors;
}

const PROFILE_LABELS: Array<[ConnectorProfile, string]> = [
  ['lookup', 'lookups and investigations'],
  ['code_change', 'code changes'],
  ['code_change_admin', 'code changes for an admin'],
];

/** The policy in words, for an agent asked what it can reach. */
export function describeConnectorPolicy(config: AppConfig): string[] {
  const lines = PROFILE_LABELS.map(([profile, label]) => {
    const { unavailable } = connectorsFor(profile, config);
    const names = CONNECTOR_POLICY[profile].map(name => {
      const limit = CONNECTORS[name].limit;
      return `${name}${limit ? ` (${limit})` : ''}${unavailable.includes(name) ? ' [not set up on this host]' : ''}`;
    });
    return `${label}: ${names.join(', ') || 'none'}`;
  });
  return [...lines, 'every other run: none'];
}

/**
 * What a run is told about the connectors it was given, or undefined when it
 * has none. Said out loud because an agent used to find a database by
 * rummaging through every connector the host user had, and because a server
 * can be configured and still not signed in to.
 */
export function connectorPromptBlock(connectors: RunConnectors): string | undefined {
  const given = Object.values(CONNECTORS).filter(spec => spec.serverName in connectors.mcpServers);
  if (given.length === 0) return undefined;
  const lines = given.map(
    spec => `- \`mcp__${spec.serverName}__*\`${spec.limit ? ` (${spec.limit})` : ''}: ${spec.about}.`,
  );
  return [
    'Connectors you have in this run:',
    ...lines,
    "- If a connector's tools are not available in this session, open your reply by saying so, in these words: \"I can't reach <connector> right now; I've let the owner know.\" Then answer only what you can without it. Never estimate a number you could not query.",
    "- Never tell the requester how to sign in to a connector or mention `/mcp`: reconnecting one is the owner's job, and the owner is told automatically.",
    '- You have no other connectors: no Slack search, no Drive, no mail. If the answer needs one, say so instead of looking for a way around it.',
  ].join('\n');
}

const storage = new AsyncLocalStorage<RunConnectors>();

/**
 * Give every agent started inside `fn` these connectors. Set once where a
 * workflow starts, so a run added later inherits the workflow's list instead
 * of the host user's; a nested call replaces the list for its own scope.
 */
export function withConnectors<T>(connectors: RunConnectors, fn: () => Promise<T>): Promise<T> {
  return storage.run(connectors, fn);
}

/** The connectors in force here: none unless a workflow said otherwise. */
export function currentConnectors(): RunConnectors {
  return storage.getStore() ?? NO_CONNECTORS;
}
