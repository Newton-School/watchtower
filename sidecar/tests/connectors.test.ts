import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __connectors,
  connectorPromptBlock,
  connectorsFor,
  currentConnectors,
  describeConnectorPolicy,
  NO_CONNECTORS,
  withConnectors,
} from '../src/backends/connectors.js';
import { withWorkflowConnectors } from '../src/codex/runCodex.js';
import type { AppConfig, CodexRunRequest } from '../src/types/contracts.js';

const config = { metabaseMcpUrl: 'https://metabase.example/api/mcp' } as unknown as AppConfig;
const noMetabase = { metabaseMcpUrl: '' } as unknown as AppConfig;

const ADMIN = 'plugin_newton-admin-mcp_newton-admin';

// Issue #443: every agent had every connector the host user has. A lookup for
// a non-owner searched the owner's private Slack and read Drive files; another
// run rewrote seven Metabase questions.
describe('connectorsFor', () => {
  let home: string;
  const realHome = __connectors.home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-connectors-'));
    __connectors.home = () => home;
    // What a host user has: far more than any agent should get.
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          figma: { type: 'http', url: 'https://figma.example/mcp' },
          openpanel: { type: 'http', url: 'https://openpanel.example/mcp' },
          'newton-grafana-prod': { type: 'stdio', command: 'uvx', args: ['mcp-grafana'], env: { TOKEN: 'secret' } },
        },
      }),
    );
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'newton-plugins', 'newton-admin-mcp', 'abc123');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'newton-admin': {
            command: 'uvx',
            args: ['--from', 'pkg', 'serve'],
            env: { BASE_URL: 'https://admin.example' },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'newton-admin-mcp@newton-plugins': [{ scope: 'user', installPath }],
          'slack@claude-plugins-official': [{ scope: 'user', installPath: path.join(home, 'nowhere') }],
        },
      }),
    );
  });

  afterEach(() => {
    __connectors.home = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('gives a run nothing unless its workflow names something', () => {
    expect(connectorsFor('none', config)).toEqual({ mcpServers: {}, disallowedTools: [], unavailable: [] });
  });

  it('gives a lookup the database and product analytics, with everything that changes them denied', () => {
    expect(connectorsFor('lookup', config)).toEqual({
      mcpServers: {
        metabase: { type: 'http', url: 'https://metabase.example/api/mcp' },
        openpanel: { type: 'http', url: 'https://openpanel.example/mcp' },
      },
      disallowedTools: [
        'mcp__metabase__create_*',
        'mcp__metabase__update_*',
        'mcp__metabase__delete_*',
        'mcp__metabase__archive_*',
        'mcp__openpanel__create_*',
        'mcp__openpanel__update_*',
        'mcp__openpanel__delete_*',
      ],
      unavailable: [],
    });
  });

  it('gives a code change Figma and nothing else the host has', () => {
    const connectors = connectorsFor('code_change', config);

    expect(connectors.mcpServers).toEqual({ figma: { type: 'http', url: 'https://figma.example/mcp' } });
    expect(connectors.disallowedTools).toEqual([]);
  });

  it('adds the admin upload tools for an admin, and only those', () => {
    const connectors = connectorsFor('code_change_admin', config);

    expect(Object.keys(connectors.mcpServers)).toEqual(['figma', ADMIN]);
    // Loaded under the plugin's own name, so tool names stay what agents and repo skills know.
    expect(connectors.mcpServers[ADMIN]).toEqual({
      type: 'stdio',
      command: 'uvx',
      args: ['--from', 'pkg', 'serve'],
      env: { BASE_URL: 'https://admin.example' },
    });
    // Everything on that server except login and upload_*: the real tool list, as of CLI 2.1.296.
    const denied = (tool: string): boolean =>
      connectors.disallowedTools.some(rule => {
        const pattern = rule.replace(`mcp__${ADMIN}__`, '');
        return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
      });
    const kept = ['login', 'upload_developer_image', 'upload_gpu_fabric_objects'];
    const removed = [
      'admin_lookup',
      'create_newton_box_solution_playground',
      'describe_model',
      'get_record',
      'list_models',
      'register_assignment_question',
      'search_users',
      'search_user_profiles',
      'start_newton_box_playground_pod',
      'stop_newton_box_playground_pod',
      'update_newton_box_question_db',
    ];
    expect(kept.filter(denied)).toEqual([]);
    expect(removed.filter(tool => !denied(tool))).toEqual([]);
  });

  it('never hands out a server the policy does not name for that kind of run', () => {
    for (const profile of ['none', 'lookup', 'code_change', 'code_change_admin'] as const) {
      const names = Object.keys(connectorsFor(profile, config).mcpServers);
      // The host has Grafana; no agent gets it.
      expect(names).not.toContain('newton-grafana-prod');
      // Analytics is for lookups, not for a run that changes code.
      if (profile !== 'lookup') expect(names).not.toContain('openpanel');
    }
  });

  it('says which connector this host cannot provide instead of failing', () => {
    fs.rmSync(path.join(home, '.claude.json'));
    fs.rmSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));

    expect(connectorsFor('lookup', noMetabase)).toEqual({
      mcpServers: {},
      disallowedTools: [],
      unavailable: ['metabase', 'openpanel'],
    });
    expect(connectorsFor('code_change_admin', config)).toEqual({
      mcpServers: {},
      disallowedTools: [],
      unavailable: ['figma', 'newton-admin'],
    });
  });

  it('describes the policy for an agent asked what it can reach', () => {
    expect(describeConnectorPolicy(noMetabase)).toEqual([
      'lookups and investigations: metabase (read-only) [not set up on this host], openpanel (read-only)',
      'code changes: figma',
      'code changes for an admin: figma, newton-admin (upload only)',
      'every other run: none',
    ]);
  });
});

describe('connectorPromptBlock', () => {
  it('says nothing to a run without connectors', () => {
    expect(connectorPromptBlock(NO_CONNECTORS)).toBeUndefined();
  });

  it('names what the run has, what to do when it is out of reach, and that there is nothing else', () => {
    const block = connectorPromptBlock({
      mcpServers: {
        metabase: { type: 'http', url: 'https://metabase.example/api/mcp' },
        openpanel: { type: 'http', url: 'https://openpanel.example/mcp' },
      },
      disallowedTools: [],
      unavailable: [],
    });

    expect(block).toContain('- `mcp__metabase__*` (read-only): the database');
    expect(block).toContain('- `mcp__openpanel__*` (read-only): product analytics');
    expect(block).toContain('say plainly that you could not reach it');
    expect(block).toContain('You have no other connectors');
  });

  it('lists only the connectors this run was given', () => {
    const block = connectorPromptBlock({
      mcpServers: { openpanel: { type: 'http', url: 'https://openpanel.example/mcp' } },
      disallowedTools: [],
      unavailable: ['metabase'],
    });

    expect(block).toContain('mcp__openpanel__*');
    expect(block).not.toContain('mcp__metabase__*');
  });
});

describe('withConnectors', () => {
  const lookup = {
    mcpServers: { metabase: { type: 'http' as const, url: 'https://metabase.example/api/mcp' } },
    disallowedTools: ['mcp__metabase__update_*'],
    unavailable: [],
  };
  const request = { cwd: '/repo', prompt: 'p' } as CodexRunRequest;

  it('is empty outside a workflow that set a list', () => {
    expect(currentConnectors()).toBe(NO_CONNECTORS);
    expect(withWorkflowConnectors(request)).toMatchObject({ mcpServers: {}, disallowedTools: [] });
  });

  it("gives every run started inside the workflow that workflow's list", async () => {
    await withConnectors(lookup, async () => {
      await Promise.resolve();
      expect(withWorkflowConnectors(request)).toMatchObject({
        mcpServers: lookup.mcpServers,
        disallowedTools: ['mcp__metabase__update_*'],
      });
    });
    expect(currentConnectors()).toBe(NO_CONNECTORS);
  });

  it('lets a nested scope take the list away again', async () => {
    await withConnectors(lookup, () =>
      withConnectors(NO_CONNECTORS, async () => {
        expect(withWorkflowConnectors(request).mcpServers).toEqual({});
      }),
    );
  });

  it('leaves a run that named its own servers alone, and adds to its own deny rules', async () => {
    const own = { ...request, mcpServers: {}, disallowedTools: ['Bash(rm:*)'] };
    await withConnectors(lookup, async () => {
      expect(withWorkflowConnectors(own)).toBe(own);
      expect(withWorkflowConnectors({ ...request, disallowedTools: ['Bash(rm:*)'] }).disallowedTools).toEqual([
        'Bash(rm:*)',
        'mcp__metabase__update_*',
      ]);
    });
  });

  it('does not touch a text-only call', async () => {
    const textOnly = { ...request, noTools: true };
    await withConnectors(lookup, async () => {
      expect(withWorkflowConnectors(textOnly)).toBe(textOnly);
    });
  });
});
