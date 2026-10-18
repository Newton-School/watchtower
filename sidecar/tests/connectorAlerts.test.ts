import { describe, expect, it, vi } from 'vitest';
import {
  connectorAlertText,
  connectorsToAlert,
  onConnectorStatuses,
  reportConnectorStatuses,
} from '../src/runtime/connectorAlerts.js';

function memoryStore(): { getState(key: string): string | undefined; setState(key: string, value: string): void } {
  const state = new Map<string, string>();
  return { getState: key => state.get(key), setState: (key, value) => void state.set(key, value) };
}

describe('connectorsToAlert (issue #593)', () => {
  it('tells the owner once per lapse, and again only after the connector came back', () => {
    const store = memoryStore();
    const lapsed = [{ name: 'metabase', status: 'needs-auth' }];

    expect(connectorsToAlert(lapsed, store)).toEqual(lapsed);
    expect(connectorsToAlert(lapsed, store)).toEqual([]);
    expect(connectorsToAlert([{ name: 'metabase', status: 'connected' }], store)).toEqual([]);
    expect(connectorsToAlert(lapsed, store)).toEqual(lapsed);
  });

  it('tells about a connector that failed, and nothing about one still connecting', () => {
    const store = memoryStore();
    const statuses = [
      { name: 'metabase', status: 'connected' },
      { name: 'figma', status: 'failed' },
      { name: 'openpanel', status: 'pending' },
    ];

    expect(connectorsToAlert(statuses, store)).toEqual([{ name: 'figma', status: 'failed' }]);
  });

  it('keeps each connector apart', () => {
    const store = memoryStore();
    connectorsToAlert([{ name: 'metabase', status: 'needs-auth' }], store);

    expect(connectorsToAlert([{ name: 'figma', status: 'needs-auth' }], store)).toEqual([
      { name: 'figma', status: 'needs-auth' },
    ]);
  });
});

describe('connectorAlertText', () => {
  it('says what is wrong, what it costs and where to fix it', () => {
    expect(connectorAlertText({ name: 'metabase', status: 'needs-auth' }, 'a7cb2e4e-1111-2222-3333-444444444444')).toBe(
      '`metabase` needs signing in again: runs given it cannot reach it, so questions that need it go unanswered. ' +
        'Sign in from Claude Code on this machine: `/mcp`, then `metabase`. First seen in job `a7cb2e4e`.',
    );
    expect(connectorAlertText({ name: 'figma', status: 'failed' })).toBe(
      '`figma` failed to connect: runs given it cannot reach it, so questions that need it go unanswered. ' +
        'Check it from Claude Code on this machine: `/mcp`, then `figma`.',
    );
  });
});

describe('reportConnectorStatuses', () => {
  it('passes the statuses and job on, and never throws into the run', () => {
    const seen = vi.fn();
    onConnectorStatuses(seen);
    reportConnectorStatuses([{ name: 'metabase', status: 'connected' }], 'job-1');
    expect(seen).toHaveBeenCalledWith([{ name: 'metabase', status: 'connected' }], 'job-1');

    onConnectorStatuses(() => {
      throw new Error('slack is down');
    });
    expect(() => reportConnectorStatuses([{ name: 'metabase', status: 'needs-auth' }])).not.toThrow();
    onConnectorStatuses(undefined);
  });
});
