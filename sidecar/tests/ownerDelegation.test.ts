import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideOwnerDelegation,
  isDelegableChannel,
  isOwnerTagDelegationEnabled,
  isPureOwnerTag,
  ownerInThread,
  taggedOwnerId,
} from '../src/access/ownerDelegation.js';
import { __resetWorkspaceMembershipForTests, resolveWorkspaceMembership } from '../src/slack/workspaceMembership.js';
import type { NormalizedTask } from '../src/types/contracts.js';

const OWNERS = ['UOWNER1', 'UOWNER2'];

function tagTask(overrides: Partial<NormalizedTask> = {}, eventOverrides: Partial<NormalizedTask['event']> = {}) {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C123',
      channelType: 'channel',
      threadTs: '100.1',
      eventTs: '100.2',
      userId: 'UBUILDER',
      text: '<@UOWNER1> what is the name of this page?',
      rawEvent: {},
      ...eventOverrides,
    },
    mentionDetected: true,
    mentionType: 'owner',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'UNKNOWN',
    ...overrides,
  } as NormalizedTask;
}

const member = vi.fn(async () => ({ eligible: true as const, reason: 'member' as const }));

describe('owner-tag helpers (issue #398)', () => {
  it('is on unless switched off', () => {
    expect(isOwnerTagDelegationEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'off', ' OFF ']) {
      expect(isOwnerTagDelegationEnabled({ WATCHTOWER_OWNER_TAG_DELEGATION: off })).toBe(false);
    }
  });

  it('knows a message that tags an owner and not miniOG', () => {
    expect(isPureOwnerTag({ mentionType: 'owner' })).toBe(true);
    expect(isPureOwnerTag({ mentionType: 'bot' })).toBe(false);
  });

  it('finds the tagged owner, plain or labelled, and not an id that only starts the same', () => {
    expect(taggedOwnerId('hey <@UOWNER2|og> look', OWNERS)).toBe('UOWNER2');
    expect(taggedOwnerId('<@UOWNER1> and <@UOWNER2>', OWNERS)).toBe('UOWNER1');
    expect(taggedOwnerId('<@UOWNER10> hi', OWNERS)).toBeUndefined();
    expect(taggedOwnerId(undefined, OWNERS)).toBeUndefined();
  });

  it('sees an owner who posted in the thread, before or after the tag, but not the tag itself', () => {
    const thread = [
      { user: 'UBUILDER', ts: '100.1' },
      { user: 'UOWNER1', ts: '100.2' },
    ];
    expect(ownerInThread(thread, '100.2', OWNERS)).toEqual({ present: false });
    expect(ownerInThread([...thread, { user: 'UOWNER2', ts: '100.3' }], '100.2', OWNERS)).toEqual({
      present: true,
      ownerId: 'UOWNER2',
      ts: '100.3',
    });
    expect(ownerInThread([{ user: 'UOWNER1', ts: '99.9' }], '100.2', OWNERS).present).toBe(true);
  });

  it('delegates only in channels, and fails closed on an ambiguous id', () => {
    expect(isDelegableChannel('channel', 'C1')).toBe(true);
    expect(isDelegableChannel('group', 'G1')).toBe(true);
    expect(isDelegableChannel('im', 'D1')).toBe(false);
    expect(isDelegableChannel('mpim', 'G2')).toBe(false);
    expect(isDelegableChannel(undefined, 'C1')).toBe(true);
    expect(isDelegableChannel(undefined, 'G1')).toBe(false);
  });
});

describe('decideOwnerDelegation (issue #398)', () => {
  it('lends the tagged owner’s authority to a full member', async () => {
    await expect(
      decideOwnerDelegation({ task: tagTask(), ownerIds: OWNERS, resolveMembership: member, env: {} }),
    ).resolves.toEqual({ kind: 'delegate', ownerId: 'UOWNER1', inherited: false });
  });

  it('carries a delegation over to the answer of a question asked on it', async () => {
    const answer = tagTask({ mentionType: 'bot', inheritedDelegationOwnerId: 'UOWNER2' }, { text: 'yes' });
    await expect(
      decideOwnerDelegation({ task: answer, ownerIds: OWNERS, resolveMembership: member, env: {} }),
    ).resolves.toEqual({ kind: 'delegate', ownerId: 'UOWNER2', inherited: true });
  });

  it('is silent for someone the authority cannot be lent to, with the reason', async () => {
    const guest = vi.fn(async () => ({ eligible: false as const, reason: 'guest' as const }));
    await expect(
      decideOwnerDelegation({ task: tagTask(), ownerIds: OWNERS, resolveMembership: guest, env: {} }),
    ).resolves.toEqual({ kind: 'silent', ownerId: 'UOWNER1', reason: 'guest' });
  });

  it('is silent outside a channel without looking anyone up', async () => {
    const lookup = vi.fn(member);
    await expect(
      decideOwnerDelegation({
        task: tagTask({}, { channelId: 'D1', channelType: 'im' }),
        ownerIds: OWNERS,
        resolveMembership: lookup,
        env: {},
      }),
    ).resolves.toEqual({ kind: 'silent', ownerId: 'UOWNER1', reason: 'channel_not_delegable' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not apply to a direct mention, to the owner, or with the switch off', async () => {
    const run = (task: NormalizedTask, env: NodeJS.ProcessEnv = {}) =>
      decideOwnerDelegation({ task, ownerIds: OWNERS, resolveMembership: member, env });
    await expect(run(tagTask({ mentionType: 'bot' }))).resolves.toEqual({ kind: 'n/a' });
    await expect(run(tagTask({ isOwnerAuthor: true }))).resolves.toEqual({ kind: 'n/a' });
    await expect(run(tagTask(), { WATCHTOWER_OWNER_TAG_DELEGATION: '0' })).resolves.toEqual({ kind: 'n/a' });
  });
});

describe('resolveWorkspaceMembership', () => {
  beforeEach(() => __resetWorkspaceMembershipForTests());
  afterEach(() => __resetWorkspaceMembershipForTests());

  function slackWith(user: Record<string, unknown> | Error, auth: Record<string, unknown> = { team_id: 'T1' }) {
    return {
      auth: { test: vi.fn().mockResolvedValue(auth) },
      users: {
        info: user instanceof Error ? vi.fn().mockRejectedValue(user) : vi.fn().mockResolvedValue({ user }),
      },
    };
  }

  it.each([
    [{ team_id: 'T1' }, { eligible: true, reason: 'member' }],
    [
      { team_id: 'T1', is_restricted: true },
      { eligible: false, reason: 'guest' },
    ],
    [
      { team_id: 'T1', is_ultra_restricted: true },
      { eligible: false, reason: 'guest' },
    ],
    [
      { team_id: 'T1', is_bot: true },
      { eligible: false, reason: 'bot' },
    ],
    [
      { team_id: 'T1', is_app_user: true },
      { eligible: false, reason: 'bot' },
    ],
    [
      { team_id: 'T1', deleted: true },
      { eligible: false, reason: 'deleted' },
    ],
    [{ team_id: 'T2' }, { eligible: false, reason: 'external' }],
    [
      { team_id: 'T1', is_stranger: true },
      { eligible: false, reason: 'external' },
    ],
  ])('classifies %j', async (user, expected) => {
    const slack = slackWith(user);
    await expect(resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' })).resolves.toEqual(expected);
  });

  it('uses the enterprise id as the boundary on Enterprise Grid', async () => {
    const slack = slackWith(
      { team_id: 'T-SIBLING', enterprise_user: { enterprise_id: 'E1' } },
      { team_id: 'T1', enterprise_id: 'E1' },
    );
    await expect(resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' })).resolves.toEqual({
      eligible: true,
      reason: 'member',
    });
  });

  it('caches results and calls auth.test once', async () => {
    const slack = slackWith({ team_id: 'T1' });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U2' });
    expect(slack.users.info).toHaveBeenCalledTimes(2);
    expect(slack.auth.test).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a lookup error and does not cache it', async () => {
    const slack = slackWith(new Error('ratelimited'));
    await expect(resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' })).resolves.toEqual({
      eligible: false,
      reason: 'lookup_failed',
    });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U1' });
    expect(slack.users.info).toHaveBeenCalledTimes(2);
  });

  it('expires the cache after 6 hours', async () => {
    const slack = slackWith({ team_id: 'T1' });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U1', now: 0 });
    await resolveWorkspaceMembership({ slack: slack as never, userId: 'U1', now: 6 * 60 * 60 * 1000 + 1 });
    expect(slack.users.info).toHaveBeenCalledTimes(2);
  });
});
