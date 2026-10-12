import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { botScopes, missingScopesNotice } from '../src/slack/botScopes.js';

function slackGranting(scopes: string[] | undefined): WebClient {
  return {
    auth: { test: vi.fn(async () => ({ ok: true, response_metadata: scopes ? { scopes } : {} })) },
  } as unknown as WebClient;
}

// What the installed token carried for the whole audit window (issue #433).
const WITHOUT_FILES = ['channels:history', 'chat:write', 'app_mentions:read', 'reactions:write'];

afterEach(() => {
  botScopes.setForTest(undefined);
});

describe('botScopes', () => {
  it('reports the file scopes the installed token was never granted', async () => {
    const status = await botScopes.refresh(slackGranting(WITHOUT_FILES));

    expect(status?.missing.map(feature => feature.scope)).toEqual(['files:read', 'files:write']);
    expect(botScopes.knownMissing('files:write')).toBe(true);
    expect(botScopes.knownMissing('files:read')).toBe(true);
    expect(botScopes.knownMissing('chat:write')).toBe(false);
  });

  it('reports nothing missing once the app is reinstalled', async () => {
    await botScopes.refresh(slackGranting(WITHOUT_FILES));
    const status = await botScopes.refresh(slackGranting([...WITHOUT_FILES, 'files:read', 'files:write']));

    expect(status?.missing).toEqual([]);
    expect(botScopes.knownMissing('files:write')).toBe(false);
  });

  it('treats an unknown as unknown, not as missing', async () => {
    expect(botScopes.knownMissing('files:write')).toBe(false);

    expect(await botScopes.refresh(slackGranting(undefined))).toBeUndefined();
    expect(botScopes.knownMissing('files:write')).toBe(false);

    const failing = {
      auth: {
        test: vi.fn(async () => {
          throw new Error('ratelimited');
        }),
      },
    } as unknown as WebClient;
    expect(await botScopes.refresh(failing)).toBeUndefined();
    expect(botScopes.knownMissing('files:write')).toBe(false);
  });

  it('keeps the last good answer when a later check fails', async () => {
    await botScopes.refresh(slackGranting(WITHOUT_FILES));
    await botScopes.refresh(slackGranting(undefined));

    expect(botScopes.knownMissing('files:write')).toBe(true);
  });
});

describe('missingScopesNotice', () => {
  const bothMissing = {
    granted: WITHOUT_FILES,
    missing: [
      { scope: 'files:read', breaks: 'screenshots and files people attach cannot be opened' },
      { scope: 'files:write', breaks: 'files cannot be attached to replies' },
    ],
  };

  it('tells the owner what is broken and how to fix it', () => {
    expect(missingScopesNotice(bothMissing, undefined)).toEqual({
      title: 'miniOG Slack app is missing permissions',
      body:
        'files:read: screenshots and files people attach cannot be opened. ' +
        'files:write: files cannot be attached to replies. Reinstall the app to the workspace to grant them.',
      fingerprint: 'files:read,files:write',
    });
  });

  it('stays quiet on a restart when nothing changed', () => {
    expect(missingScopesNotice(bothMissing, 'files:read,files:write')).toBeUndefined();
  });

  it('speaks again when the missing set changes', () => {
    const oneLeft = { granted: [...WITHOUT_FILES, 'files:read'], missing: [bothMissing.missing[1]] };
    expect(missingScopesNotice(oneLeft, 'files:read,files:write')?.fingerprint).toBe('files:write');
  });

  it('has nothing to say when nothing is missing', () => {
    expect(missingScopesNotice({ granted: ['files:read', 'files:write'], missing: [] }, undefined)).toBeUndefined();
    expect(missingScopesNotice({ granted: ['files:read', 'files:write'], missing: [] }, 'files:write')).toBeUndefined();
  });
});
